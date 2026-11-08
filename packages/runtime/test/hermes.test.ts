import { describe, expect, it } from 'vitest';
import { HermesAdapter, hermesTeamBrief, matchTeamMember, parseHermesToolOutput } from '../src/hermes.js';

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

  it('passes the reasoning effort only when asked and only known levels', () => {
    expect(adapter.plan({ cwd: '/p', prompt: 'hi', model: 'example/model-2', reasoning: 'high' }).args.slice(-2)).toEqual(['--model=example/model-2', '--reasoning=high']);
    expect(adapter.plan({ cwd: '/p', prompt: 'hi' }).args.some(arg => arg.startsWith('--reasoning'))).toBe(false);
    expect(() => adapter.plan({ cwd: '/p', prompt: 'hi', reasoning: '--yolo' as never })).toThrow(/effort/);
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
    expect(completed[0]).toMatchObject({ type: 'file.written', path: 'README.md', toolCallId: 'call_1' });
    expect(completed[1]).toMatchObject({ toolCallId: 'call_1', ok: true, output: 'clean' });

    // Calls without an id are matched by name and get a generated id.
    expect(parse(line({ type: 'tool_use', name: 'read_file', input: { path: 'a.ts' } }))!.events[1]).toMatchObject({ toolCallId: 'generated', kind: 'read', target: 'a.ts' });
    expect(parse(line({ type: 'tool_result', name: 'read_file', output: 'text', is_error: true }))!.events[0]).toMatchObject({ toolCallId: 'generated', ok: false });

    const result = parse(line({ type: 'result', session_id: 'sess_2', exit_code: 0, text: 'Finished.', tokens: { input: 1500, output: 200, total: 1700, cache_read: 0, cache_write: 0 }, duration_ms: 9 }))!;
    expect(result.events).toEqual([{ type: 'model.completed', text: 'Finished.', model: 'example/model-1' }]);
    expect(result.sessionId).toBe('sess_2');
    expect(result.result).toEqual({ exitCode: 0, usage: { inputTokens: 1500, outputTokens: 200, cachedInputTokens: 0 } });
    expect(JSON.stringify([init, result])).not.toContain('session.started');
  });

  it('audits only actual Hermes file outcomes, retaining partial writes on failure', () => {
    const parse = adapter.createStreamParser({ newId: () => 'generated' });
    parse(line({ type: 'tool_use', name: 'write_file', tool_call_id: 'write_1' }));
    const partial = parse(line({ type: 'tool_result', name: 'write_file', tool_call_id: 'write_1', is_error: true,
      output: JSON.stringify({ success: false, files_created: ['partial.txt'], error: 'later step failed' }) }))!.events;
    expect(partial[0]).toMatchObject({ type: 'file.written', path: 'partial.txt', toolCallId: 'write_1' });
    expect(partial[1]).toMatchObject({ type: 'tool.completed', ok: false });

    parse(line({ type: 'tool_use', name: 'read_file', tool_call_id: 'read_1' }));
    const read = parse(line({ type: 'tool_result', name: 'read_file', tool_call_id: 'read_1', output: 'contents', is_error: false }))!.events;
    expect(read.some(event => event.type === 'file.written')).toBe(false);
    parse(line({ type: 'tool_use', name: 'write_file', tool_call_id: 'failed_1' }));
    const failed = parse(line({ type: 'tool_result', name: 'write_file', tool_call_id: 'failed_1', output: JSON.stringify({ success: false, error: 'denied' }), is_error: true }))!.events;
    expect(failed.some(event => event.type === 'file.written')).toBe(false);
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

  it('preserves zero token reports and omits malformed counts and contradictory cached subsets', () => {
    const parse = adapter.createStreamParser();
    expect(parse(line({ type: 'result', exit_code: 0, tokens: { input: 0, output: 0, cache_read: 0 } }))?.result?.usage).toEqual({ inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 });
    expect(parse(line({ type: 'result', exit_code: 0, tokens: { input: 2, output: 1.5, cache_read: 9 } }))?.result?.usage).toEqual({ inputTokens: 2 });
  });
});

describe('Hermes subagent teams', () => {
  const members = [
    { id: 'm-1', name: 'Elena Mark', role: 'Backend Engineer', models: ['a/x'] },
    { id: 'm-2', name: 'Kaelen Vael', role: 'Security Reviewer', models: ['a/y'], access: 'write' as const },
  ];

  it('uses profile totals and lower concurrent batches without changing worker model routing', () => {
    const brief = hermesTeamBrief({ members }, { limits: { maxTeamMembers: 6, oneshotMaxChildren: 6, maxConcurrentChildren: 1 } });
    expect(brief).toContain('active profile\'s total child budget is 6');
    expect(brief).toContain('Never delegate more than 6 children in total');
    expect(brief).toContain('at most 1 tasks in a concurrent batch');
    expect(brief).toContain('Per-member model and fallback chains are not routed');
    expect(brief).not.toContain('a/x');
    const unlimited = hermesTeamBrief({ members }, { limits: { maxTeamMembers: 32, oneshotMaxChildren: 0, maxConcurrentChildren: 10 } });
    expect(unlimited).toContain('total child budget is unlimited');
    expect(unlimited).toContain('Never delegate more than 32 children in total');
    expect(unlimited).toContain('at most 10 tasks in a concurrent batch');
  });

  it('matches a delegated task to a member by name, then by a unique role', () => {
    expect(matchTeamMember(members, '[Kaelen Vael · Security Reviewer] audit')?.id).toBe('m-2');
    expect(matchTeamMember(members, 'As the security reviewer, audit the flow')?.id).toBe('m-2');
    expect(matchTeamMember(members, 'Summarise the README')).toBeUndefined();
  });

  it('writes a brief without models and maps a failed delegation to a blocked member', () => {
    const brief = hermesTeamBrief({ members, rules: ['Run tests'] });
    expect(brief).toContain('2. Kaelen Vael — Security Reviewer (may edit within the workspace)');
    expect(brief).not.toContain('a/x');
    expect(brief).not.toContain('a/y');
    expect(brief).toContain('--oneshot');
    expect(brief).toContain('default total child budget is 2');
    expect(brief).toContain('Never delegate more than 2 children in total');
    expect(brief).toContain('shared across all delegate_task calls and batches');
    expect(brief).toContain('obey any lower child, batch or other delegation limits');
    expect(brief).toContain('share the profile\'s delegation.model');
    expect(brief).toContain('Per-member model and fallback chains are not routed by this adapter');
    const parse = new HermesAdapter().createStreamParser({ team: members, newId: () => 'id' });
    const started = parse(JSON.stringify({ type: 'tool_use', name: 'delegate_task', tool_call_id: 'c1', input: { goal: '[Elena Mark · Backend Engineer] build it' } }))!;
    expect(started.events).toContainEqual({ type: 'subagent.spawned', subagentId: 'm-1', role: 'Backend Engineer', label: 'Elena Mark' });
    const failed = parse(JSON.stringify({ type: 'tool_result', name: 'delegate_task', tool_call_id: 'c1', output: '{"error":"delegation disabled"}', is_error: true }))!;
    expect(failed.events).toContainEqual({ type: 'subagent.state', subagentId: 'm-1', state: 'blocked', summary: 'Could not start' });
    const done = parse(JSON.stringify({ type: 'result', exit_code: 0, text: 'ok' }))!;
    expect(done.events.some(event => event.type === 'subagent.state')).toBe(false);
  });

  it('includes the retained complete goal document in the Hermes lead brief', () => {
    const full = 'Complete team goal details. '.repeat(1_000);
    expect(hermesTeamBrief({ members, goal: 'Full goal attached: goal.txt', goalDocument: { name: 'goal.txt', text: full } })).toContain(full);
  });
});
