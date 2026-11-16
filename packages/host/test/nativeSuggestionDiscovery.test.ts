import { appendFile, mkdir, readFile, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const at = '2026-11-12T00:00:00.000Z';
const header = 'This is an app-generated request for a suggested next user message. The user did not write this message.';
const helper = `${header}\nReturn one next-message suggestion.`;
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const meta = (id: string, title?: string) => line({ type: 'session_meta', payload: { id, cwd: '/projects/example', timestamp: at, ...(title ? { title } : {}) } });
const prompt = (text: string) => line({ type: 'response_item', timestamp: at, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
const eventPrompt = (message: string) => line({ type: 'event_msg', timestamp: at, payload: { type: 'user_message', message } });
const output = (text: string) => line({ type: 'response_item', payload: { type: 'function_call_output', output: text } });

async function fixture() {
  const root = await temp(), home = path.join(root, 'home'), codex = path.join(home, '.codex'), folder = path.join(codex, 'sessions');
  await mkdir(folder, { recursive: true });
  const create = () => NativeImportService.create({ homeDirectory: home, env: { CODEX_HOME: codex } });
  const source = await create(), location = source.locations().find(item => item.label === 'Codex')!;
  const save = async (id: string, records: string, title?: string) => {
    const file = path.join(folder, `rollout-${id}.jsonl`);
    await writeFile(file, meta(id, title) + records);
    return file;
  };
  const discovered = (service = source) => service.discover([location.id], 0).map(item => item.reference.nativeSessionId);
  return { home, folder, source, location, create, save, discovered };
}

describe('bounded Codex helper discovery', () => {
  it('filters only structural helper-only user prompts from discovery and scan', async () => {
    const f = await fixture();
    await f.save('response-helper', prompt(helper));
    await f.save('event-helper', eventPrompt(helper));
    await f.save('injected-helper', prompt('<environment_context>example</environment_context>') + prompt(helper));
    await f.save('title-helper', '', header);
    await f.save('real-after-helper', prompt(helper) + prompt('Please implement the change'));
    await f.save('quoted', prompt(`> ${helper}`));
    await f.save('mentioned', prompt(`Explain this: ${helper}`));
    await f.save('near-match', prompt(header.replace('The user did not', 'The user did')));
    await f.save('tool-only', output(helper));
    await f.save('assistant-only', line({ type: 'response_item', payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: helper }] } }));
    await f.save('normal-title', prompt('Work on the project'), header);
    const expected = ['real-after-helper', 'quoted', 'mentioned', 'near-match', 'tool-only', 'assistant-only', 'normal-title'].sort();
    expect(f.discovered().sort()).toEqual(expected);
    expect(f.source.scan([f.location.id]).sessions.map(item => item.nativeSessionId).sort()).toEqual(expected);
  });

  it('lets ordinary sessions through when more than 24 newer helper sessions exist', async () => {
    const f = await fixture();
    const ordinary = await f.save('ordinary', prompt('Fix the user-visible behavior'));
    await utimes(ordinary, new Date(1_700_000_000_000), new Date(1_700_000_000_000));
    for (let index = 0; index < 40; index++) await f.save(`helper-${index}`, prompt(helper));
    expect(f.discovered()).toEqual(['ordinary']);
  });

  it('invalidates helper classification after a genuine prompt is appended and after restart', async () => {
    const f = await fixture(), file = await f.save('changed', eventPrompt(helper));
    expect(f.discovered()).toEqual([]);
    const before = await readFile(file, 'utf8');
    await appendFile(file, prompt('Now run the test suite'));
    expect(f.discovered()).toEqual(['changed']);
    expect(f.discovered(await f.create())).toEqual(['changed']);
    expect(await readFile(file, 'utf8')).toBe(before + prompt('Now run the test suite'));
  });

  it('keeps truncated, malformed and ambiguous user records visible', async () => {
    const f = await fixture();
    await f.save('malformed', prompt(helper) + '{"type":"event_msg","payload":{"type":"user_message"');
    await f.save('ambiguous', prompt(helper) + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'example' }] } }));
    await f.save('missing-text', prompt(helper) + line({ type: 'event_msg', payload: { type: 'user_message' } }));
    await f.save('late-user', prompt(helper) + output('status').repeat(100) + prompt('A real later prompt'));
    await f.save('large', prompt(helper) + output('x'.repeat(128 * 1024)) + prompt('A real later prompt'));
    const expected = ['malformed', 'ambiguous', 'missing-text', 'late-user', 'large'].sort();
    expect(f.discovered().sort()).toEqual(expected);
    expect(f.source.scan([f.location.id]).sessions.map(item => item.nativeSessionId).sort()).toEqual(expected);
  });

  it('refuses an internal helper selected from a stale scan while preserving import preview', async () => {
    const f = await fixture(), file = await f.save('stale', output('Preparing'));
    const scan = f.source.scan([f.location.id]), candidate = scan.sessions[0]!;
    await appendFile(file, prompt(helper));
    expect(() => f.source.observation(scan.scanId, candidate.id)).toThrow('app-generated suggestion');
    const current = await f.create();
    // A manual preview selected before the helper became recognizable remains an ordinary import read.
    await writeFile(file, meta('stale') + prompt('Original user prompt'));
    const manualScan = current.scan([f.location.id]), manual = manualScan.sessions[0]!;
    expect(current.preview(manualScan.scanId, [manual.id]).sessions[0]?.session.messages[0]?.content).toBe('Original user prompt');
  });

  it('reports explicit bounded source evidence for observed reads, including inconclusive heads', async () => {
    const f = await fixture();
    const file = await f.save('observed', prompt(helper));
    const reference = { locationId: f.location.id, sourceId: 'codex', nativeSessionId: 'observed', path: file };
    expect(f.source.readObservation(reference).internalSuggestion).toBe(true);
    await appendFile(file, prompt('Please inspect the results'));
    expect(f.source.readObservation(reference).internalSuggestion).toBe(false);
    await writeFile(file, meta('observed') + prompt(helper) + output('status').repeat(100));
    expect(f.source.readObservation(reference).internalSuggestion).toBe(false);
    await writeFile(file, meta('observed') + prompt(helper) + output('x'.repeat(128 * 1024)));
    expect(f.source.readObservation(reference).internalSuggestion).toBe(false);
  });

  it('does not apply the Codex-specific header to other harnesses', async () => {
    const f = await fixture(), project = path.join(f.home, '.claude', 'projects', 'example');
    await mkdir(project, { recursive: true });
    await writeFile(path.join(project, 'ordinary.jsonl'), line({ type: 'user', sessionId: 'claude-helper-text', cwd: '/projects/example', timestamp: at, message: { role: 'user', content: helper } }));
    const source = await f.create(), location = source.locations().find(item => item.sourceId === 'claude-code')!;
    expect(source.discover([location.id], 0).map(item => item.reference.nativeSessionId)).toEqual(['claude-helper-text']);
    expect(source.scan([location.id]).sessions.map(item => item.nativeSessionId)).toEqual(['claude-helper-text']);
  });
});
