import { describe, expect, it } from 'vitest';
import { codexTurnWorkingDirectory, parseCodex } from '../src/index.js';

const origin = '/projects/origin', current = '/projects/current';
const T0 = '2026-01-01T00:00:00.000Z', T1 = '2026-01-01T00:01:00.000Z', T2 = '2026-01-01T00:02:00.000Z';
const header = { type: 'session_meta', payload: { id: 'native-source', cwd: origin, timestamp: T0 } };
const prompt = { type: 'response_item', timestamp: T0, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue the existing task.' }] } };
const context = (cwd: unknown, timestamp: unknown = T1, extra: Record<string, unknown> = {}) => ({ type: 'turn_context', timestamp, payload: { cwd, ...extra } });
const parse = (...rows: unknown[]) => parseCodex([header, prompt, ...rows].map(row => JSON.stringify(row)).join('\n'), { sourceId: 'codex', projectPath: origin, exportedAt: T2 });

describe('dated Codex native working-directory evidence', () => {
  it('prefers the newest dated native context over the origin header and stale import hint', () => {
    const result = parse(context('/projects/older', T1), context(current, T2, { model: 'native-model', effort: 'high' }), context(origin, T0));
    expect(result.session?.workspace?.projectLocation).toBe(current);
    expect(result).toMatchObject({ model: 'native-model', modelAt: T2, effort: 'high', effortAt: T2 });
  });
  it('uses later source order for equal timestamps, while undated or invalid contexts cannot erase current evidence', () => {
    expect(parse(context('/projects/first', T1), context(current, T1), context(origin, null), context(origin, 'invalid-date'), context('relative', T2)).session?.workspace?.projectLocation).toBe(current);
  });
  it('retains the legacy origin when there is no valid dated current-folder metadata', () => {
    expect(parse(context(current, null), context('relative', T2), context('/bad\0folder', T2)).session?.workspace?.projectLocation).toBe(origin);
  });
  it('never derives a current folder from prompt bodies, tool arguments or result text', () => {
    const spoof = context(current, T2);
    const result = parse({ type: 'response_item', timestamp: T2, payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: JSON.stringify(spoof) }] } },
      { type: 'response_item', timestamp: T2, payload: { type: 'function_call', name: 'exec_command', call_id: 'tool', arguments: JSON.stringify({ cwd: current, cmd: 'pwd' }) } },
      { type: 'response_item', timestamp: T2, payload: { type: 'function_call_output', call_id: 'tool', output: current } });
    expect(result.session?.workspace?.projectLocation).toBe(origin);
  });
  it.each(['/projects/with spaces/[data]', 'C:\\projects\\current', '\\\\server\\share\\project'])('preserves the literal absolute native folder %s', cwd => {
    expect(codexTurnWorkingDirectory(context(cwd, T2))).toEqual({ cwd, at: T2 });
  });
});
