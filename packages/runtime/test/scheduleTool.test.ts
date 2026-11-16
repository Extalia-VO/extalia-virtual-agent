import { describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt, createScheduleJobsTool, runTurn, validateArguments, type ModelProvider, type ScheduleJobToolInput } from '../src/index.js';

const clock = { now: '2027-01-04T01:00:00.000Z', timeZone: 'Asia/Jakarta', jobs: [] };
const draft = { action: 'create' as const, name: 'Weekly review', prompt: 'Review progress and blockers.', triggerKind: 'cron' as const, cron: '0 9 * * 1' };
const context = (toolCallId = 'call-1', signal = new AbortController().signal) => ({ toolCallId, signal, emit: () => undefined });

function harness(allowCreate = true) {
  const saved = { status: 'saved', job: { id: 'schedule-1', revision: 1, nextRunAt: '2027-01-04T02:00:00.000Z' }, timeZone: clock.timeZone };
  const list = vi.fn(async () => clock), create = vi.fn(async () => saved);
  const tool = createScheduleJobsTool({ list, create, allowCreate });
  return { tool, list, create, saved };
}

describe('Native schedule jobs tool', () => {
  it('reads the real clock first, binds defaults and returns only the acknowledged host receipt', async () => {
    const h = harness(), source = context('create-call');
    expect(await h.tool.run(draft, source)).toMatchObject({ ok: false, output: expect.stringContaining('list first') });
    expect(h.create).not.toHaveBeenCalled();
    expect(await h.tool.run({ action: 'list' }, context('list-call'))).toEqual({ ok: true, output: JSON.stringify(clock) });
    expect(h.list).toHaveBeenCalledWith(expect.objectContaining({ toolCallId: 'list-call', signal: expect.any(AbortSignal) }));
    expect(await h.tool.run(draft, source)).toEqual({ ok: true, output: JSON.stringify(h.saved) });
    expect(h.create).toHaveBeenCalledExactlyOnceWith({ name: draft.name, prompt: draft.prompt, triggerKind: 'cron', cron: draft.cron, sessionMode: 'current', enabled: true, missedPolicy: 'run-once' }, { signal: source.signal, toolCallId: 'create-call' });
    expect(h.tool.parallel).not.toBe(true);
  });

  it('does not admit creation after a failed, unacknowledged or cancelled list', async () => {
    for (const response of [undefined, null, 'made up']) {
      const create = vi.fn(async () => ({ job: { id: 'never' } }));
      const tool = createScheduleJobsTool({ list: async () => response, create });
      expect((await tool.run({ action: 'list' }, context())).ok).toBe(false);
      expect((await tool.run(draft, context())).ok).toBe(false);
      expect(create).not.toHaveBeenCalled();
    }
    const h = harness(), controller = new AbortController();
    controller.abort();
    expect((await h.tool.run({ action: 'list' }, context('cancelled', controller.signal))).ok).toBe(false);
    expect(h.list).not.toHaveBeenCalled();
    expect(h.tool.precheck?.(draft)).toContain('list first');
  });

  it.each([
    { action: 'create', name: '', prompt: 'Review', triggerKind: 'cron', cron: '* * * * *' },
    { action: 'create', name: 'Review', prompt: ' ', triggerKind: 'cron', cron: '* * * * *' },
    { ...draft, cron: undefined },
    { ...draft, intervalMinutes: 5 },
    { action: 'create', name: 'Review', prompt: 'Review', triggerKind: 'interval', intervalMinutes: 0 },
    { action: 'create', name: 'Review', prompt: 'Review', triggerKind: 'interval', intervalMinutes: 2.5 },
    { action: 'create', name: 'Review', prompt: 'Review', triggerKind: 'once', runAt: '2027-01-04T09:00:00' },
    { action: 'create', name: 'Review', prompt: 'Review', triggerKind: 'once', runAt: 'tomorrow morning' },
    { action: 'create', name: 'Review', prompt: 'Review', triggerKind: 'once', runAt: '2027-02-30T09:00:00Z' },
    { ...draft, workspaceId: 'foreign' },
    { ...draft, sessionId: 'foreign' },
    { ...draft, sessionMode: 'invented' },
  ])('rejects malformed or scope-changing arguments before the host callback: %j', async input => {
    const h = harness(); await h.tool.run({ action: 'list' }, context());
    expect((await h.tool.run(input as ScheduleJobToolInput, context())).ok).toBe(false);
    expect(h.create).not.toHaveBeenCalled();
  });

  it('preserves explicit new-session, paused and timestamp choices without rewriting the task', async () => {
    const h = harness(); await h.tool.run({ action: 'list' }, context());
    const input = { action: 'create' as const, name: 'One review', prompt: '  Keep the exact\nfuture task.  ', triggerKind: 'once' as const, runAt: '2027-01-04T09:00:00+07:00', sessionMode: 'create-and-reuse' as const, enabled: false };
    expect((await h.tool.run(input, context())).ok).toBe(true);
    expect(h.create).toHaveBeenLastCalledWith({ name: input.name, prompt: input.prompt, triggerKind: input.triggerKind, runAt: input.runAt, sessionMode: input.sessionMode, enabled: false, missedPolicy: 'run-once' }, expect.anything());
  });

  it('preserves an explicit request to skip missed occurrences', async () => {
    const h = harness(); await h.tool.run({ action: 'list' }, context());
    expect((await h.tool.run({ ...draft, missedPolicy: 'skip' }, context())).ok).toBe(true);
    expect(h.create).toHaveBeenCalledWith(expect.objectContaining({ missedPolicy: 'skip' }), expect.anything());
    expect((await h.tool.run({ ...draft, missedPolicy: 'invented' } as unknown as ScheduleJobToolInput, context())).ok).toBe(false);
  });

  it('keeps plan/read-only turns list-only and refuses before approval or mutation', async () => {
    const h = harness(false); await h.tool.run({ action: 'list' }, context());
    expect(h.tool.precheck?.(draft)).toContain('read-only');
    expect(await h.tool.run(draft, context())).toMatchObject({ ok: false, output: expect.stringContaining('read-only') });
    expect(h.create).not.toHaveBeenCalled();
    expect(h.tool.description).toContain('only list is allowed');
  });

  it('returns a host storage refusal and does not manufacture a saved-job id', async () => {
    const tool = createScheduleJobsTool({ list: async () => clock, create: async () => { throw new Error('Schedule storage is unavailable.'); } });
    await tool.run({ action: 'list' }, context());
    expect(await tool.run(draft, context())).toEqual({ ok: false, output: 'Schedule storage is unavailable.' });
    expect(validateArguments(tool.parameters, { action: 'remove' })).not.toEqual([]);
  });

  it('refuses malformed create acknowledgements and preserves a real receipt after late cancellation', async () => {
    for (const receipt of [{}, { status: 'saved', job: {} }, { status: 'failed', job: { id: 'not-saved' } }]) {
      const tool = createScheduleJobsTool({ list: async () => clock, create: async () => receipt });
      await tool.run({ action: 'list' }, context());
      expect(await tool.run(draft, context())).toMatchObject({ ok: false, output: expect.stringContaining('did not acknowledge') });
    }
    const controller = new AbortController(), saved = { status: 'saved', job: { id: 'acknowledged' } };
    const tool = createScheduleJobsTool({ list: async () => clock, create: async () => { controller.abort(); return saved; } });
    await tool.run({ action: 'list' }, context());
    expect(await tool.run(draft, context('ack', controller.signal))).toEqual({ ok: true, output: JSON.stringify(saved) });
  });

  it('executes a normal prompt through the provider tool loop and records the acknowledged job in tool history', async () => {
    const h = harness(); let step = 0;
    const provider: ModelProvider = { api: 'openai-chat', listModels: async () => [], complete: async () => {
      const call = step++ === 0 ? { id: 'clock-call', name: 'schedule_jobs', input: { action: 'list' } }
        : step === 2 ? { id: 'create-call', name: 'schedule_jobs', input: draft } : undefined;
      return call ? { text: '', toolCalls: [call], stop: 'tool_use' } : { text: 'Saved schedule-1 for Monday at 09:00 Asia/Jakarta.', toolCalls: [], stop: 'end' };
    } };
    const result = await runTurn({ provider, system: buildSystemPrompt({ workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' }, scheduleJobs: true }),
      history: [], prompt: 'Setiap Senin jam 9, tinjau project ini di sesi yang sama.', tools: [h.tool], permissions: { fileWrite: 'ask', commands: 'ask' },
      sessionGrants: new Set(), requestApproval: async () => 'reject', emit: () => undefined, signal: new AbortController().signal });
    expect(result.outcome).toBe('completed');
    expect(h.create).toHaveBeenCalledOnce();
    expect(result.history.some(message => message.role === 'tool' && message.results.some(entry => entry.content === JSON.stringify(h.saved) && !entry.isError))).toBe(true);
  });

  it('offers scheduling instructions only when the host supplies that capability', () => {
    const plain = { workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' } };
    expect(buildSystemPrompt(plain)).not.toContain('schedule_jobs');
    const system = buildSystemPrompt({ ...plain, scheduleJobs: true });
    expect(system).toContain('Call action list first');
    expect(system).toContain('Only the current user request authorizes creating a job');
    expect(system).toContain('A saved job is not completed work');
    expect(system).toContain('host is closed');
  });
});
