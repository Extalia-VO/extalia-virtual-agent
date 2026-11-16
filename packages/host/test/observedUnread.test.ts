import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { normalizeCodexHook } from '../src/hooks/normalize.js';
import { createAgentHost } from '../src/service.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const at = '2026-11-12T00:00:00.000Z';
const line = (row: unknown) => `${JSON.stringify(row)}\n`;
const message = (role: 'user' | 'assistant', text: string) => line({ type: 'response_item', timestamp: at,
  payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });
async function sourceFixture() {
  const root = await temp(); const home = path.join(root, 'home'); const directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions'); await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'rollout-unread.jsonl');
  const initial = line({ type: 'session_meta', payload: { id: 'unread-fixture', cwd: '/projects/example', timestamp: at } })
    + message('user', 'Initial task') + message('assistant', 'Existing history');
  await writeFile(file, initial);
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  return { root, home, directory, folder, file, initial, source };
}
async function fixture() {
  const f = await sourceFixture();
  const observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
  const scan = f.source.scan(['codex']); await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { ...f, observer, id: observer.summaries()[0]!.id };
}
const report = (event: string, extra: Record<string, unknown> = {}) => normalizeCodexHook({ session_id: 'unread-fixture', hook_event_name: event, ...extra })!;

describe('Observe assistant-output read watermarks', () => {
  it('baselines history, ignores non-output changes, guards exact acknowledgements and persists unread/read state over restart', async () => {
    const f = await fixture(); let observer = f.observer;
    const output = () => observer.summaries()[0]!.observation!;
    try {
      expect(output().unreadOutput).toBe(false); const baseline = output().outputRevision!;
      await appendFile(f.file, message('user', 'Another task') + line({ type: 'response_item', timestamp: at,
        payload: { type: 'function_call', name: 'exec_command', call_id: 'work', arguments: '{"cmd":"pwd"}' } }));
      await observer.refresh(); expect(output().outputRevision).toBe(baseline); expect(output().unreadOutput).toBe(false);
      await appendFile(f.file, message('assistant', 'New partial result')); await observer.refresh();
      const partial = output().outputRevision!; expect(partial).not.toBe(baseline); expect(output().unreadOutput).toBe(true);
      await appendFile(f.file, message('assistant', 'Additional result')); await observer.refresh();
      const latest = output().outputRevision!; expect(latest).not.toBe(partial);
      await observer.markRead(f.id, partial); expect(output().unreadOutput).toBe(true);
      await observer.close(); observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(output()).toMatchObject({ outputRevision: latest, unreadOutput: true });
      await observer.markRead(f.id, latest); expect(output().unreadOutput).toBe(false);
      await observer.close(); observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
      expect(output()).toMatchObject({ outputRevision: latest, unreadOutput: false });
      await observer.close(); await appendFile(f.file, message('assistant', 'Output while the host was stopped'));
      observer = await Observations.create(f.directory, f.source, () => undefined, 60_000); expect(output().unreadOutput).toBe(true);
      await observer.markRead(f.id, output().outputRevision!); expect(output().unreadOutput).toBe(false);
      // Repeating a reply later is still a new output occurrence.
      await appendFile(f.file, message('assistant', 'Existing history')); await observer.refresh(); expect(output().unreadOutput).toBe(true);
      await expect(observer.markRead(f.id, 'invalid')).rejects.toThrow('Invalid observed output revision');
      const index = JSON.parse(await readFile(path.join(f.directory, 'observations.json'), 'utf8'));
      expect(JSON.stringify(index[0].output)).not.toContain('Additional result');
    } finally { await observer.close(); }
  });

  it('treats first hook discovery as read history and later assistant replies as unread', async () => {
    const f = await sourceFixture(); const observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
    try {
      await observer.receiveHook(report('Stop', { last_assistant_message: 'Discovered existing result' }));
      let output = observer.summaries()[0]!.observation!;
      expect(output.unreadOutput).toBe(false); const discovered = output.outputRevision!;
      await observer.receiveHook(report('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'pwd' } }));
      expect(observer.summaries()[0]?.observation?.outputRevision).toBe(discovered);
      await observer.receiveHook(report('Stop', { last_assistant_message: 'A newly received result' }));
      output = observer.summaries()[0]!.observation!; expect(output.outputRevision).not.toBe(discovered); expect(output.unreadOutput).toBe(true);
    } finally { await observer.close(); }
  });

  it('marks new output after a hook starts watching even when its transcript attaches for the first time', async () => {
    const f = await sourceFixture(); const observer = await Observations.create(f.directory, f.source, () => undefined, 60_000);
    try {
      await observer.receiveHook(report('UserPromptSubmit', { prompt: 'New watched task', transcript_path: f.file }));
      await appendFile(f.file, line({ type: 'response_item', timestamp: new Date(Date.now() + 1).toISOString(),
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A reply after watching began' }] } }));
      await observer.refresh(); expect(observer.summaries()[0]?.observation?.unreadOutput).toBe(true);
    } finally { await observer.close(); }
  });

  it('does not re-notify hook/transcript duplicates in either arrival order, while allowing output during working', async () => {
    const f = await fixture(); const output = () => f.observer.summaries()[0]!.observation!;
    try {
      await f.observer.receiveHook(report('UserPromptSubmit', { prompt: 'Another task' }));
      await f.observer.receiveHook({ ...report('PreToolUse'), steps: [{ agentId: 'primary', body: { type: 'model.completed', text: 'Hook result' } }] });
      expect(f.observer.summaries()[0]?.running).toBe(true); expect(output().unreadOutput).toBe(true);
      const revision = output().outputRevision!; await f.observer.markRead(f.id, revision);
      await appendFile(f.file, message('assistant', 'Hook result')); await f.observer.refresh();
      expect(output()).toMatchObject({ outputRevision: revision, unreadOutput: false });
      await f.observer.receiveHook(report('Stop', { last_assistant_message: 'Hook result' }));
      expect(output()).toMatchObject({ outputRevision: revision, unreadOutput: false });
      await f.observer.receiveHook(report('UserPromptSubmit', { prompt: 'One more task' }));
      await appendFile(f.file, message('assistant', 'Transcript result')); await f.observer.refresh();
      expect(output().unreadOutput).toBe(true); const second = output().outputRevision!; await f.observer.markRead(f.id, second);
      await f.observer.receiveHook(report('Stop', { last_assistant_message: 'Transcript result' }));
      expect(output()).toMatchObject({ outputRevision: second, unreadOutput: false });
    } finally { await f.observer.close(); }
  });

  it('tracks partial reply edits and leaves unread output intact when only historical output is removed', async () => {
    const f = await fixture(); const output = () => f.observer.summaries()[0]!.observation!;
    try {
      await appendFile(f.file, message('assistant', 'Partial')); await f.observer.refresh();
      const partial = output().outputRevision!;
      await writeFile(f.file, f.initial + message('assistant', 'Partial completed')); await f.observer.refresh();
      expect(output().outputRevision).not.toBe(partial); const completed = output().outputRevision!;
      await writeFile(f.file, line({ type: 'session_meta', payload: { id: 'unread-fixture', cwd: '/projects/example', timestamp: at } })
        + message('user', 'Initial task') + message('assistant', 'Partial completed'));
      await f.observer.refresh(); expect(output()).toMatchObject({ outputRevision: completed, unreadOutput: true });
    } finally { await f.observer.close(); }
  });

  it('keeps labels-only mode free of output content and hidden unread markers', async () => {
    const f = await fixture();
    try {
      await f.observer.setPrivacy({ labelsOnly: true });
      await f.observer.receiveHook(report('Stop', { last_assistant_message: 'PRIVATE_ASSISTANT_RESULT' }));
      expect(f.observer.summaries()[0]?.observation?.outputRevision).toBeUndefined();
      expect(f.observer.summaries()[0]?.observation?.unreadOutput).toBeUndefined();
      const index = await readFile(path.join(f.directory, 'observations.json'), 'utf8'); expect(index).not.toContain('PRIVATE_ASSISTANT_RESULT');
    } finally { await f.observer.close(); }
  });

  it('forwards the exact-revision read API through a real temporary host without exposing transcript bodies in summaries', async () => {
    const f = await sourceFixture();
    const runtime = await createAgentHost({ kind: 'bridge', version: 'test', dataDirectory: path.join(f.root, 'data'), homeDirectory: f.home, importHome: f.home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: '' }, observationIntervalMs: 60_000 });
    try {
      const { host } = runtime; const scan = await host.scanImports(['codex']); await host.observeImports(scan.scanId, [scan.sessions[0]!.id]);
      const id = (await host.getStateSummary!()).sessions[0]!.id;
      await appendFile(f.file, message('assistant', 'New host result')); await host.setObservation(id, true);
      let summary = (await host.getStateSummary!()).sessions[0]!; expect(summary.observation?.unreadOutput).toBe(true);
      const shown = summary.observation!.outputRevision!;
      await appendFile(f.file, message('assistant', 'A newer unseen result')); await host.setObservation(id, true);
      await host.markObservedRead!(id, shown); summary = (await host.getStateSummary!()).sessions[0]!; expect(summary.observation?.unreadOutput).toBe(true);
      await host.markObservedRead!(id, summary.observation!.outputRevision!);
      expect((await host.getStateSummary!()).sessions[0]?.observation?.unreadOutput).toBe(false);
      expect('messages' in summary).toBe(false);
    } finally { await runtime.close(); }
  });
});
