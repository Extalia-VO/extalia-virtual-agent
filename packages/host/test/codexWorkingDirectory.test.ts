import { appendFile, mkdir, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs(), nativeId = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-01T00:01:00.000Z', T2 = '2026-01-01T00:02:00.000Z';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const context = (cwd: string, timestamp = T1) => line({ type: 'turn_context', timestamp, payload: { cwd } });
const reply = line({ type: 'response_item', timestamp: T2, payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Progress retained.' }] } });
async function fixture() {
  const root = await realpath(await temp()), home = path.join(root, 'home'), origin = path.join(root, 'origin'), current = path.join(root, 'current');
  const folder = path.join(home, '.codex', 'sessions'); await mkdir(folder, { recursive: true }); await mkdir(origin); await mkdir(current);
  const file = path.join(folder, 'rollout-test.jsonl');
  const header = line({ type: 'session_meta', payload: { id: nativeId, cwd: origin, timestamp: T0 } });
  const prompt = line({ type: 'response_item', timestamp: T0, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the existing task.' }] } });
  await writeFile(file, header + prompt + reply);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const reference = source.hookReference('codex', nativeId, file)!;
  return { root, home, origin, current, file, header, prompt, source, reference };
}

describe('selected Codex current-folder metadata', () => {
  it('keeps cold discovery cheap, then aligns selected reads, memoized candidates and reviewed CLI cwd', async () => {
    const f = await fixture(); await appendFile(f.file, context(f.current) + reply);
    expect(f.source.scan(['codex']).sessions[0]?.projectPath).toBe(f.origin); // An unopened candidate is an origin hint.
    expect(f.source.readObservation(f.reference).session.workspace?.projectLocation).toBe(f.current);
    expect(f.source.scan(['codex']).sessions[0]?.projectPath).toBe(f.current);
    expect(f.source.cliResumeSource(f.reference)?.cwd).toBe(f.current);
  });

  it('updates a watched session after native folder metadata changes and ignores tool or prompt cwd claims', async () => {
    const f = await fixture(), observer = await Observations.create(path.join(f.root, 'state'), f.source, () => undefined, 60_000);
    try {
      const scan = f.source.scan(['codex']); await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
      const id = observer.summaries()[0]!.id;
      expect(observer.summaries()[0]?.observation?.projectPath).toBe(f.origin);
      const initial = f.source.cliResumeSource(f.reference)!;
      await appendFile(f.file, context(f.current, T2) + context(f.origin, T1) + line({ type: 'response_item', timestamp: T2, payload: { type: 'function_call', name: 'exec_command', arguments: JSON.stringify({ cwd: f.origin, cmd: 'pwd' }) } }) + reply);
      await observer.refresh();
      expect(observer.summaries()[0]).toMatchObject({ id, observation: { nativeSessionId: nativeId, projectPath: f.current } });
      const latest = f.source.cliResumeSource(f.reference)!;
      expect(latest.cwd).toBe(f.current); expect(latest.fingerprint).not.toBe(initial.fingerprint); expect(latest.revision).not.toBe(initial.revision);
    } finally { await observer.close(); }
  });

  it('reads a current context in the bounded tail of a large rollout without scanning its omitted middle for status', async () => {
    const f = await fixture();
    const largeToolOutput = line({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(5 * 1024 * 1024) } });
    await writeFile(f.file, f.header + f.prompt + largeToolOutput + context(f.current, T2) + reply);
    expect(f.source.cliResumeSource(f.reference)?.cwd).toBe(f.current);
    expect(f.source.readObservation(f.reference).session.workspace?.projectLocation).toBe(f.current);
    expect(f.source.scan(['codex']).sessions[0]?.projectPath).toBe(f.current);
  });

  it('preserves the origin display hint but refuses a large CLI resume without current tail metadata', async () => {
    const f = await fixture();
    const largeToolOutput = line({ type: 'response_item', payload: { type: 'function_call_output', output: 'x'.repeat(5 * 1024 * 1024) } });
    await writeFile(f.file, f.header + f.prompt + context(f.origin, T0) + largeToolOutput + reply);
    expect(f.source.readObservation(f.reference).session.workspace?.projectLocation).toBe(f.origin);
    expect(f.source.cliResumeSource(f.reference)).toBeUndefined();
  });
});
