import { describe, expect, it } from 'vitest';
import { HermesAdapter, parseHermesToolOutput } from '../src/hermes.js';

const line = (value: unknown) => JSON.stringify({ ...(value as object), timestamp: 1 });

describe('HermesAdapter', () => {
  const adapter = new HermesAdapter();

  it('builds a one-shot stream-json command with the prompt on stdin', () => {
    const plan = adapter.plan({
      cwd: '/workspace/project',
      prompt: 'Check git status; echo "$(whoami)"',
      profile: 'devops',
      model: 'example/model-1',
      resumeSessionId: '20260101_120000_abc123',
      yolo: true,
    });
    expect(plan.args).toEqual([
      '-p', 'devops', 'chat',
      '--query-file', '-', '--oneshot', '--format', 'stream-json',
      '--source', 'extalia', '--in', '/workspace/project',
      '--resume', '20260101_120000_abc123',
      '--model=example/model-1',
      '--yolo',
    ]);
    expect(plan.stdin).toBe('Check git status; echo "$(whoami)"');
  });

  it('names the default profile explicitly and never bypasses approvals unless asked', () => {
    const plan = adapter.plan({ cwd: '/p', prompt: 'hi' });
    expect(plan.args.slice(0, 3)).toEqual(['-p', 'default', 'chat']);
    expect(plan.args).not.toContain('--yolo');
    expect(plan.args).not.toContain('--resume');
    expect(() => adapter.plan({ cwd: '/p', prompt: 'hi', profile: '--yolo' })).toThrow(/profile/);
    expect(() => adapter.plan({ cwd: '/p', prompt: 'hi', resumeSessionId: '-x' })).toThrow(/session/);
  });

  it('parses tool output JSON: exit code, output and changed files', () => {
    const parsed = parseHermesToolOutput(JSON.stringify({ exit_code: 0, output: 'All tests passed', files_modified: ['src/index.ts'], files_created: ['new.ts'] }), false);
    expect(parsed).toEqual({ ok: true, exitCode: 0, output: 'All tests passed', files: [{ path: 'new.ts', change: 'add' }, { path: 'src/index.ts', change: 'update' }] });
    expect(parseHermesToolOutput(JSON.stringify({ exit_code: 2, output: 'boom' }), false).ok).toBe(false);
    expect(parseHermesToolOutput('plain text…', true)).toEqual({ ok: false, files: [], output: 'plain text…' });
  });

  it('maps stream-json records to protocol bodies without envelopes or a second session.started', () => {
    const parse = adapter.createStreamParser({ newId: () => 'generated' });
    const init = parse(line({ type: 'system', subtype: 'init', model: 'example/model-1', session_id: 'sess_1' }));
    expect(init).toEqual({ events: [], sessionId: 'sess_1', model: 'example/model-1' });

    expect(parse(line({ type: 'text', text: 'Looking…' }))?.events).toEqual([{ type: 'model.delta', text: 'Looking…' }]);

    const started = parse(line({ type: 'tool_use', name: 'terminal', tool_call_id: 'call_1', input: { command: 'git status' } }))!.events;
    expect(started).toEqual([
      { type: 'agent.state', state: 'working', activity: 'command', summary: 'Running git status' },
      { type: 'tool.started', toolCallId: 'call_1', tool: 'terminal', kind: 'command', label: 'Running git status' },
    ]);

    const completed = parse(line({ type: 'tool_result', name: 'terminal', tool_call_id: 'call_1', output: JSON.stringify({ exit_code: 0, output: 'clean', files_modified: ['README.md'] }), duration_ms: 5, is_error: false }))!.events;
    expect(completed.map(body => body.type)).toEqual(['file.written', 'tool.completed', 'agent.state']);
    expect(completed[1]).toMatchObject({ toolCallId: 'call_1', ok: true, output: 'clean' });

    // Calls without an id are matched by name and get a generated id.
    expect(parse(line({ type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }))!.events[1]).toMatchObject({ toolCallId: 'generated', kind: 'read', target: 'a.ts' });
    expect(parse(line({ type: 'tool_result', name: 'read_file', output: 'text', is_error: true }))!.events[0]).toMatchObject({ toolCallId: 'generated', ok: false });

    const result = parse(line({ type: 'result', session_id: 'sess_2', exit_code: 0, text: 'Finished.', tokens: { input: 1500, output: 200, total: 1700, cache_read: 0, cache_write: 0 }, duration_ms: 9 }))!;
    expect(result.events).toEqual([{ type: 'model.completed', text: 'Finished.', model: 'example/model-1' }]);
    expect(result.sessionId).toBe('sess_2');
    expect(result.result).toEqual({ exitCode: 0, usage: { inputTokens: 1500, outputTokens: 200 } });
    expect(JSON.stringify([init, result])).not.toContain('session.started');
  });

  it('ignores lines that are not stream records and reports failures', () => {
    const parse = adapter.createStreamParser();
    expect(parse('Warning: something on stdout')).toBeUndefined();
    expect(parse('{not json')).toBeUndefined();
    expect(parse(line({ type: 'unknown' }))).toBeUndefined();
    expect(parse(line({ type: 'result', session_id: '../bad id', exit_code: 1, text: '', error: 'credentials or agent init failed', tokens: {} }))).toEqual({
      events: [], result: { exitCode: 1, error: 'credentials or agent init failed' },
    });
  });
});
