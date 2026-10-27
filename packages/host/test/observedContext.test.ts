import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { NativeImportService } from '../src/nativeImport.js';
import { Observations } from '../src/observations.js';
import { useTempDirs } from './helpers.js';

// Synthesized Codex rollout rows; the usage shape follows Codex's `token_count` events.
const temp = useTempDirs();
const at = '2026-10-09T00:00:00.000Z';
const later = '2026-10-09T00:00:01.000Z';
const line = (value: unknown) => `${JSON.stringify(value)}\n`;
const tokens = (input: number, at: string) => line({ timestamp: at, type: 'event_msg', payload: { type: 'token_count', info: {
  last_token_usage: { input_tokens: input, cached_input_tokens: 0, output_tokens: 4, total_tokens: input + 4 },
  total_token_usage: { input_tokens: input * 3 }, model_context_window: 400_000 } } });

async function fixture() {
  const root = await temp();
  const home = path.join(root, 'home'), directory = path.join(root, 'state');
  const folder = path.join(home, '.codex', 'sessions');
  await mkdir(folder, { recursive: true });
  const file = path.join(folder, 'rollout.jsonl');
  await writeFile(file, line({ type: 'session_meta', payload: { id: 'native-context', cwd: '/projects/example', timestamp: at } })
    + line({ type: 'turn_context', payload: { model: 'gpt-5-codex' } })
    + line({ timestamp: at, type: 'event_msg', payload: { type: 'user_message', message: 'Plan the change' } })
    + tokens(12_000, at)
    + line({ timestamp: at, type: 'event_msg', payload: { type: 'agent_message', message: 'Planned.' } }));
  const source = await NativeImportService.create({ homeDirectory: home, env: {} });
  const observer = await Observations.create(directory, source, () => undefined, 60_000);
  const scan = source.scan(['codex']);
  await observer.observe(scan.scanId, [scan.sessions[0]!.id]);
  return { file, observer };
}

describe('observed session context', () => {
  it('reads the context of a Codex transcript and keeps it current as the transcript grows', async () => {
    const f = await fixture();
    expect(f.observer.summaries()[0]!.context).toMatchObject({ usedTokens: 12_000, windowTokens: 400_000, estimated: false, compactions: 0 });

    await appendFile(f.file, tokens(15_000, later) + line({ type: 'compacted', timestamp: later, payload: { message: 'summary' } }));
    await f.observer.refresh();
    expect(f.observer.summaries()[0]!.context).toMatchObject({ usedTokens: 15_000, windowTokens: 400_000, compactions: 1 });
    expect(Number.isNaN(Date.parse(f.observer.summaries()[0]!.context!.updatedAt))).toBe(false);
  });
});
