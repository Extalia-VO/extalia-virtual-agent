import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AnyTool, ModelProvider, ModelRequest, ModelResult, ToolResultEntry, TurnResult } from '@extalia/runtime';
import type { EventBody } from '@extalia/protocol';
import { automaticLearningTools, LEARNING_EVIDENCE_CHUNK_UNITS, runAutomaticLearning, runObservedAutomaticLearning, type AutomaticLearningOptions } from '../src/automaticLearning.js';
import { RustLearningBackend, type RustLearningAction, type RustLearningInputs, type RustLearningJob, type RustLearningPort, type RustLearningResults } from '../src/rustLearning.js';
import { DaemonSidecar } from '../src/daemon/index.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();
const sidecars: DaemonSidecar[] = [];
afterEach(async () => { await Promise.all(sidecars.splice(0).map(sidecar => sidecar.stop())); });
const evidence: ToolResultEntry[] = [{ toolCallId: 'current-read', name: 'read_file', content: 'The parser validates input before saving.', isError: false }];
const source: TurnResult = { outcome: 'completed', history: [{ role: 'tool', results: [{ ...evidence[0]!, toolCallId: 'old-read', content: 'Older unrelated content.' }] }], usage: {} };
const skill = { name: 'validate-before-saving', description: 'Validate before saving', instructions: 'Validate input before saving and report failures.' };
const submission = { title: 'Validate first', lesson: 'Validate inputs before saving.', evidenceIds: ['current-read'], skill };
const receipt = { packageId: skill.name, revisionId: 'revision-one', state: 'quarantined' as const, created: true, inspection: 'recorded' as const, activationPerformed: false as const, cancellationObserved: false };
const completed: ModelResult = { text: 'Finished.', toolCalls: [], stop: 'end', usage: { inputTokens: 7, outputTokens: 2 } };
const provenance = { profileId: 'profile-one', sessionId: 'session_one', workspaceId: 'workspace_one', runId: 'run-one', promptSha256: 'a'.repeat(64) };
const effect = { effectId: 'model-one', kind: 'model' as const, system: 'Rust-authored curator instructions.', messages: [{ role: 'user' as const, text: 'Rust-bounded current-turn evidence.' }], tools: [] };
function state(status: RustLearningJob['status'] = 'running'): RustLearningJob {
  return { jobId: 'job-one', status, evidence: [{ id: 'current-read', name: 'read_file', content: evidence[0]!.content }], provenance, ...(status === 'running' ? { effect, pendingEffectId: effect.effectId } : {}) };
}
function ready(): RustLearningJob { return { ...state('ready'), submission, contentSha256: 'b'.repeat(64), skillSha256: 'c'.repeat(64), usage: { inputTokens: 7, outputTokens: 2 } }; }
function fakeBackend(afterModel: RustLearningJob | RustLearningJob[] = ready()) {
  let job = state();
  const next = Array.isArray(afterModel) ? [...afterModel] : [afterModel];
  const calls: { action: RustLearningAction; input: unknown }[] = [];
  const port: RustLearningPort = { async process<A extends RustLearningAction>(action: A, input: RustLearningInputs[A]): Promise<RustLearningResults[A]> {
    calls.push({ action, input });
    let value: Record<string, unknown>;
    switch (action) {
      case 'evidence.begin': value = { intakeId: 'intake-one' }; break;
      case 'evidence.append': value = { complete: false }; break;
      case 'evidence.release': value = { released: true }; break;
      case 'job.begin': case 'observed.jobBegin': value = { job }; break;
      case 'job.advance': job = next.shift() ?? ready(); value = { job }; break;
      case 'job.cancel': job = { ...job, status: 'cancelled', effect: undefined }; value = { job }; break;
      case 'job.settle': job = { ...job, pendingEffectId: undefined }; value = { job }; break;
      case 'job.finish': job = { ...job, status: 'completed' }; value = { job }; break;
      case 'receipt.claim': value = { claimed: true }; break;
      case 'job.release': value = { released: true }; break;
      default: throw new Error(`Unexpected test operation: ${action}`);
    }
    return { action, ...value } as RustLearningResults[A];
  } };
  return { port, calls };
}
function provider(responses: ModelResult[] = [completed]): ModelProvider {
  let index = 0;
  return { api: 'openai-chat', listModels: async () => [], complete: vi.fn(async () => responses[index++] ?? completed) };
}
function options(overrides: Partial<AutomaticLearningOptions> = {}): AutomaticLearningOptions {
  return { result: source, currentTurnEvidence: evidence, ...provenance, revision: 'revision-one',
    policy: { enabled: true, skills: true, notes: true }, provider: provider(), tools: [], signal: new AbortController().signal,
    backend: fakeBackend().port, emit: vi.fn(), assertCurrent: vi.fn(), proposeSkill: vi.fn(async () => receipt),
    writeNote: vi.fn(async () => 'Learning/workspace_one/run-one.md'), onWorkerStarted: vi.fn(), onWorkerSettled: vi.fn(), ...overrides };
}
function tool(name: string, access: AnyTool['access'] = 'read', kind: AnyTool['kind'] = 'read'): AnyTool {
  return { name, access, kind, description: name, parameters: { type: 'object', properties: {} }, describe: () => ({ label: name }), run: vi.fn(async () => ({ ok: true, output: 'Read result.' })) };
}

describe('Rust-owned automatic learning host effects', () => {
  it('loads observed evidence by its stored scope and revision without manufacturing Native tool results', async () => {
    const backend = fakeBackend();
    const { result: _sourceResult, currentTurnEvidence: _toolResults, ...setup } = options({ backend: backend.port });
    const observed = { scope: { profileId: provenance.profileId, workspaceId: provenance.workspaceId, sessionId: provenance.sessionId,
      sourceId: 'codex', nativeSessionId: 'native-one', boundary: 'd'.repeat(64) }, episodeId: 'e'.repeat(64), revision: 'f'.repeat(64) };
    expect(await runObservedAutomaticLearning({ ...setup, observed })).toMatchObject({ outcome: 'completed', note: { status: 'saved' } });
    expect(backend.calls.find(call => call.action === 'observed.jobBegin')?.input).toMatchObject(observed);
    expect(backend.calls.some(call => call.action.startsWith('evidence.') || call.action === 'job.begin')).toBe(false);
    expect(setup.onWorkerSettled).toHaveBeenCalledTimes(1);
  });

  it('keeps profile-only observed consent fields out of the finite Rust curator policy', async () => {
    const backend = fakeBackend(), policy = { enabled: true, skills: true, notes: true, observed: true };
    await runAutomaticLearning(options({ backend: backend.port, policy }));
    expect(backend.calls.find(call => call.action === 'job.begin')?.input).toMatchObject({ policy: { enabled: true, skills: true, notes: true } });
    expect((backend.calls.find(call => call.action === 'job.begin')?.input as { policy: unknown }).policy).toEqual({ enabled: true, skills: true, notes: true });
  });

  it('executes only the Rust model request and persists only its normalized finding and hashes', async () => {
    const backend = fakeBackend(), events: EventBody[] = [];
    const setup = options({ backend: backend.port, emit: body => { events.push(body); } });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'completed', usage: ready().usage, skill: { status: 'recorded', receipt }, note: { status: 'saved' } });
    expect(setup.provider.complete).toHaveBeenCalledWith({ system: effect.system, messages: effect.messages, tools: effect.tools, signal: expect.any(AbortSignal) });
    expect(backend.calls.find(call => call.action === 'job.begin')).toEqual({ action: 'job.begin', input: expect.objectContaining({ intakeId: 'intake-one', tools: [] }) });
    expect(backend.calls.find(call => call.action === 'evidence.append')).toEqual({ action: 'evidence.append', input: expect.objectContaining({ chunk: evidence[0]!.content, final: true }) });
    expect(JSON.stringify(backend.calls)).not.toContain('Older unrelated');
    expect(backend.calls.filter(call => call.action === 'receipt.claim').map(call => call.input)).toEqual([
      { profileId: provenance.profileId, contentSha256: 'b'.repeat(64), runId: provenance.runId },
      { profileId: provenance.profileId, contentSha256: 'c'.repeat(64), runId: provenance.runId },
    ]);
    expect(setup.proposeSkill).toHaveBeenCalledWith(skill, provenance, expect.any(AbortSignal));
    expect(setup.writeNote).toHaveBeenCalledWith(expect.objectContaining({ title: submission.title, lesson: submission.lesson, evidence: ready().evidence, skill: receipt }), expect.any(AbortSignal));
    expect(events.some(body => body.type === 'turn.completed')).toBe(true);
    expect(backend.calls.at(-1)?.action).toBe('job.release');
    expect(setup.onWorkerSettled).toHaveBeenCalledTimes(1);
  });

  it.each([
    { policy: { enabled: false, skills: true, notes: true } },
    { policy: { enabled: true, skills: false, notes: false } },
    { result: { ...source, outcome: 'failed' as const } },
    { currentTurnEvidence: [{ ...evidence[0]!, isError: true }] },
    { currentTurnEvidence: [] },
  ])('skips ineligible source work before entering the backend or provider', async change => {
    const backend = fakeBackend(), setup = options({ backend: backend.port, ...change });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'skipped' });
    expect(backend.calls).toEqual([]); expect(setup.provider.complete).not.toHaveBeenCalled();
  });

  it('fails closed before inference when the Rust backend is missing or refuses preflight', async () => {
    for (const backend of [undefined, { process: vi.fn(async () => { throw new Error('missing capability'); }) } as RustLearningPort]) {
      const setup = options({ backend });
      expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'failed' });
      expect(setup.provider.complete).not.toHaveBeenCalled(); expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.writeNote).not.toHaveBeenCalled();
    }
  });

  it('honors a normal Rust skip without claiming admissions or writing artifacts', async () => {
    const backend = fakeBackend({ ...state('skipped'), reason: 'No reusable finding.' }), setup = options({ backend: backend.port });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'skipped', reason: 'No reusable finding.' });
    expect(backend.calls.some(call => call.action === 'receipt.claim')).toBe(false);
    expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.writeNote).not.toHaveBeenCalled();
  });

  it('excludes generic Node file, web, search, memory and mutation adapters', () => {
    const allowed = tool('knowledge_read', 'read', 'knowledge');
    const tools = [tool('read_file'), tool('web_search', 'read', 'web'), tool('search_files', 'read', 'search'), tool('memory_read', 'memory', 'knowledge'), tool('skill_propose', 'write', 'knowledge'), tool('knowledge_write', 'read', 'knowledge'), tool('knowledge_sync', 'read', 'knowledge'), tool('skill_read', 'meta', 'read'), allowed];
    expect(automaticLearningTools(tools)).toEqual([allowed]);
  });

  it('retains ownership until an abort-ignoring model settles, then acknowledges drain before release', async () => {
    let finish!: (value: ModelResult) => void;
    let request: ModelRequest | undefined;
    const backend = fakeBackend(), setup = options({ backend: backend.port, timeoutMs: 5, provider: { api: 'openai-chat', listModels: async () => [], complete: vi.fn(input => { request = input; return new Promise<ModelResult>(resolve => { finish = resolve; }); }) } });
    let settled = false;
    const pending = runAutomaticLearning(setup).then(value => { settled = true; return value; });
    await vi.waitFor(() => expect(request?.signal?.aborted).toBe(true));
    expect(settled).toBe(false); expect(setup.onWorkerSettled).not.toHaveBeenCalled();
    expect(backend.calls.map(call => call.action)).toContain('job.cancel');
    expect(backend.calls.map(call => call.action)).not.toContain('job.settle');
    finish(completed);
    expect(await pending).toMatchObject({ outcome: 'cancelled' });
    expect(backend.calls.slice(-2).map(call => call.action)).toEqual(['job.settle', 'job.release']);
    expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.onWorkerSettled).toHaveBeenCalledTimes(1);
  });

  it('retains an admitted Rust read effect until its adapter actually settles after abort', async () => {
    const readEffect = { kind: 'read' as const, effectId: 'read-one', callId: 'knowledge-call', name: 'knowledge_read', input: { path: 'Learning/example.md' } };
    const backend = fakeBackend([{ ...state(), effect: readEffect, pendingEffectId: readEffect.effectId }, ready()]);
    const read = tool('knowledge_read', 'read', 'knowledge');
    let finish!: () => void;
    let signal: AbortSignal | undefined;
    read.run = vi.fn(async (_input, context) => { signal = context.signal; await new Promise<void>(resolve => { finish = resolve; }); return { ok: true, output: 'Read completed after abort.' }; });
    const setup = options({ backend: backend.port, tools: [read], timeoutMs: 5 });
    const pending = runAutomaticLearning(setup);
    await vi.waitFor(() => expect(signal?.aborted).toBe(true));
    expect(setup.onWorkerSettled).not.toHaveBeenCalled(); expect(backend.calls.some(call => call.action === 'job.settle')).toBe(false);
    finish();
    expect(await pending).toMatchObject({ outcome: 'cancelled' });
    expect(backend.calls.slice(-2).map(call => call.action)).toEqual(['job.settle', 'job.release']);
    expect(setup.proposeSkill).not.toHaveBeenCalled();
  });

  it('waits for candidate inspection settlement after cancellation and preserves the actual receipt', async () => {
    const controller = new AbortController(), events: EventBody[] = [];
    let finish!: () => void;
    const setup = options({ signal: controller.signal, emit: body => { events.push(body); }, proposeSkill: vi.fn(async () => { controller.abort(); await new Promise<void>(resolve => { finish = resolve; }); return { ...receipt, cancellationObserved: true }; }) });
    const pending = runAutomaticLearning(setup);
    await vi.waitFor(() => expect(setup.proposeSkill).toHaveBeenCalled());
    expect(events.some(body => body.type === 'turn.completed' || body.type === 'turn.failed')).toBe(false);
    expect(setup.onWorkerSettled).not.toHaveBeenCalled();
    finish();
    expect(await pending).toMatchObject({ outcome: 'cancelled', skill: { status: 'recorded', receipt: { cancellationObserved: true } }, note: { status: 'failed' } });
    expect(setup.writeNote).not.toHaveBeenCalled(); expect(setup.onWorkerSettled).toHaveBeenCalledOnce();
  });

  it('rechecks host policy before persistence and leaves source success unchanged', async () => {
    let checks = 0;
    const setup = options({ assertCurrent: () => { if (++checks >= 4) throw new Error('Policy changed.'); } });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'failed' });
    expect(setup.provider.complete).toHaveBeenCalledOnce();
    expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.writeNote).not.toHaveBeenCalled(); expect(source.outcome).toBe('completed');
  });

  it('reports independent note failures without discarding an acknowledged candidate', async () => {
    const setup = options({ writeNote: vi.fn(async () => { throw new Error('Vault changed.'); }) });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'failed', skill: { status: 'recorded', receipt }, note: { status: 'failed' } });
    expect(source.outcome).toBe('completed');
  });

  it('cancels and releases an admitted job when cancellation arrived before begin acknowledged', async () => {
    const base = fakeBackend(), controller = new AbortController();
    let acknowledge!: () => void;
    let beginEntered = false;
    const wait = new Promise<void>(resolve => { acknowledge = resolve; });
    const backend: RustLearningPort = { async process(action, input) {
      if (action === 'job.begin') { beginEntered = true; await wait; }
      return base.port.process(action, input);
    } };
    const setup = options({ backend, signal: controller.signal });
    const pending = runAutomaticLearning(setup);
    await vi.waitFor(() => expect(beginEntered).toBe(true)); controller.abort();
    expect(setup.provider.complete).not.toHaveBeenCalled();
    acknowledge();
    expect(await pending).toMatchObject({ outcome: 'cancelled' });
    expect(setup.provider.complete).not.toHaveBeenCalled();
    expect(base.calls.map(call => call.action)).toEqual(['evidence.begin', 'evidence.append', 'job.begin', 'job.cancel', 'job.settle', 'job.release']);
  });

  it('does not replay a model effect or persist findings after an advance acknowledgement was lost', async () => {
    const base = fakeBackend();
    const backend: RustLearningPort = { async process(action, input) {
      const response = await base.port.process(action, input);
      if (action === 'job.advance') throw new Error('Lost acknowledgement.');
      return response;
    } };
    const setup = options({ backend });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'failed' });
    expect(setup.provider.complete).toHaveBeenCalledOnce();
    expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.writeNote).not.toHaveBeenCalled();
    expect(base.calls.map(call => call.action)).toEqual(['evidence.begin', 'evidence.append', 'job.begin', 'job.advance', 'job.cancel', 'job.release']);
  });

  it('frames evidence below 128 KiB without splitting surrogate pairs or normalizing contents', async () => {
    const base = fakeBackend(), content = '\u0000'.repeat(LEARNING_EVIDENCE_CHUNK_UNITS - 1) + '🙂' + 'x'.repeat(LEARNING_EVIDENCE_CHUNK_UNITS);
    const setup = options({ backend: base.port, currentTurnEvidence: [{ ...evidence[0]!, content }] });
    await runAutomaticLearning(setup);
    const chunks = base.calls.filter(call => call.action === 'evidence.append').map(call => call.input as RustLearningInputs['evidence.append']);
    expect(chunks.map(chunk => chunk.chunk).join('')).toBe(content);
    expect(chunks).toHaveLength(3);
    for (const chunk of chunks) {
      expect(chunk.chunk).not.toMatch(/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/);
      expect(Buffer.byteLength(JSON.stringify({ action: 'evidence.append', input: chunk }))).toBeLessThan(128 * 1024);
    }
    expect(chunks.at(-1)?.final).toBe(true);
  });

  it('stops transporting evidence only when Rust reports enough and releases cancelled intake', async () => {
    const base = fakeBackend(), controller = new AbortController();
    const backend: RustLearningPort = { async process(action, input) {
      const response = await base.port.process(action, input);
      if (action === 'evidence.append') { controller.abort(); return { ...response, complete: true }; }
      return response;
    } };
    const setup = options({ backend, signal: controller.signal, currentTurnEvidence: Array.from({ length: 300 }, (_, index) => ({ ...evidence[0]!, toolCallId: `evidence-${index}` })) });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'cancelled' });
    expect(base.calls.map(call => call.action)).toEqual(['evidence.begin', 'evidence.append', 'evidence.release']);
    expect(setup.provider.complete).not.toHaveBeenCalled();
  });
});

describe.skipIf(!HAS_DAEMON || process.platform === 'win32')('automatic learning through the actual Rust sidecar', () => {
  it('runs correlated model steps, validates current evidence and durably refuses repeated findings', async () => {
    const sidecar = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: await temp(), profile: 'default', clientVersion: 'test' });
    sidecars.push(sidecar);
    const backend = new RustLearningBackend(() => sidecar.connect());
    const submit: ModelResult = { text: '', toolCalls: [{ id: 'submit-one', name: 'submit_learning', input: submission }], stop: 'tool_use', usage: { inputTokens: 10, outputTokens: 3 } };
    const setup = options({ backend, provider: provider([submit, completed]) });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'completed', usage: { inputTokens: 17, outputTokens: 5 }, skill: { status: 'recorded' }, note: { status: 'saved' } });
    const modelRequest = vi.mocked(setup.provider.complete).mock.calls[0]![0];
    expect(modelRequest.system).toContain('bounded post-task Skills curator');
    expect(JSON.stringify(modelRequest.messages)).toContain('current-read');
    expect(JSON.stringify(modelRequest.messages)).not.toContain('Older unrelated');
    const repeated = options({ backend, runId: 'run-two', provider: provider([submit, completed]) });
    expect(await runAutomaticLearning(repeated)).toMatchObject({ outcome: 'skipped' });
    expect(repeated.proposeSkill).not.toHaveBeenCalled(); expect(repeated.writeNote).not.toHaveBeenCalled();
  });

  it.each(['refusal', 'truncated', 'refusal-after-submission', 'step-limit'] as const)('never publishes captured or truncated findings after %s', async mode => {
    const sidecar = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: await temp(), profile: 'default', clientVersion: 'test' });
    sidecars.push(sidecar);
    const submit: ModelResult = { text: '', toolCalls: [{ id: 'submit-one', name: 'submit_learning', input: submission }], stop: 'tool_use' };
    const responses: ModelResult[] = mode === 'refusal' ? [{ ...submit, stop: 'refusal' }]
      : mode === 'truncated' ? [{ ...submit, stop: 'max_tokens' }]
      : mode === 'refusal-after-submission' ? [submit, { ...completed, stop: 'refusal' }]
      : Array.from({ length: 6 }, (_, index) => ({ ...submit, toolCalls: [{ ...submit.toolCalls[0]!, id: `submit-${index}` }] }));
    const setup = options({ backend: new RustLearningBackend(() => sidecar.connect()), provider: provider(responses) });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'failed' });
    expect(setup.proposeSkill).not.toHaveBeenCalled(); expect(setup.writeNote).not.toHaveBeenCalled();
    expect(source.outcome).toBe('completed');
  });

  it('streams a multi-megabyte first result and a high-volume invocation into Rust-selected bounded evidence', async () => {
    const sidecar = new DaemonSidecar({ binary: () => DAEMON_BINARY, dataDirectory: await temp(), profile: 'default', clientVersion: 'test' });
    sidecars.push(sidecar);
    const backend = new RustLearningBackend(() => sidecar.connect()), process = vi.spyOn(backend, 'process');
    const large = 'password=synthetic-secret ' + 'x'.repeat(2 * 1024 * 1024) + '🙂';
    const currentTurnEvidence = [{ ...evidence[0]!, content: large }, ...Array.from({ length: 299 }, (_, index) => ({ ...evidence[0]!, toolCallId: `evidence-${index}` }))];
    const submit: ModelResult = { text: '', toolCalls: [{ id: 'submit-large', name: 'submit_learning', input: submission }], stop: 'tool_use' };
    const setup = options({ backend, currentTurnEvidence, provider: provider([submit, completed]), timeoutMs: 45_000 });
    expect(await runAutomaticLearning(setup)).toMatchObject({ outcome: 'completed', note: { status: 'saved' } });
    const request = vi.mocked(setup.provider.complete).mock.calls[0]![0], serialized = JSON.stringify(request.messages);
    expect(serialized).toContain('[redacted]'); expect(serialized).not.toContain('synthetic-secret'); expect(serialized.length).toBeLessThan(24_000);
    const chunks = process.mock.calls.filter(([action]) => action === 'evidence.append').map(([, input]) => input as RustLearningInputs['evidence.append']);
    expect(chunks.filter(chunk => chunk.toolCallId === 'current-read').length).toBeGreaterThan(100);
    expect(chunks.filter(chunk => chunk.final)).toHaveLength(10);
    expect(chunks.at(-1)?.toolCallId).toBe('evidence-8');
    for (const chunk of chunks) expect(Buffer.byteLength(JSON.stringify({ action: 'evidence.append', input: chunk }))).toBeLessThan(128 * 1024);
    expect(setup.writeNote).toHaveBeenCalledWith(expect.objectContaining({ evidence: [expect.objectContaining({ id: 'current-read', content: expect.stringContaining('[redacted]') })] }), expect.any(AbortSignal));
  }, 30_000);
});
