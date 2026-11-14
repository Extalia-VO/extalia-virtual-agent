import { randomUUID } from 'node:crypto';
import type { AnyTool, ModelProvider, ToolOutcome, ToolResultEntry, TurnResult } from '@extalia/runtime';
import type { EventBody, Usage } from '@extalia/protocol';
import type { SkillProposalInput, SkillProposalProvenance, SkillProposalResult } from './skillLearning.js';
import type { LearningNoteRecord } from './learningNotes.js';
import type { ObservedMemoryScope, RustLearningInputs, RustLearningJob, RustLearningPort } from './rustLearning.js';

export interface AutomaticLearningPolicy { enabled: boolean; skills: boolean; notes: boolean }
/** Kept as an injection contract; production admissions are always sent to Rust. */
export interface AutomaticLearningReceiptStore {
  claim(profileId: string, contentSha256: string, runId: string): Promise<boolean>;
}
export interface AutomaticLearningResult {
  outcome: 'skipped' | 'completed' | 'failed' | 'cancelled';
  reason?: string;
  agentId?: string;
  usage?: Usage;
  skill: { status: 'skipped' | 'recorded' | 'unknown'; receipt?: SkillProposalResult };
  note: { status: 'skipped' | 'saved' | 'failed'; path?: string };
}
export interface AutomaticLearningOptions {
  result: TurnResult;
  /** Successful tool results from this root invocation, never historical conversation results. */
  currentTurnEvidence: readonly ToolResultEntry[];
  profileId: string; revision: string; sessionId: string; workspaceId: string; runId: string; promptSha256: string;
  policy: AutomaticLearningPolicy;
  provider: ModelProvider;
  /** Only Rust-backed knowledge/skill read adapters may be offered to this flow. */
  tools: readonly AnyTool[];
  backend?: RustLearningPort;
  signal: AbortSignal;
  emit(body: EventBody, agentId: string): void | Promise<void>;
  assertCurrent(): void | Promise<void>;
  proposeSkill?(input: SkillProposalInput, provenance: SkillProposalProvenance, signal: AbortSignal): Promise<SkillProposalResult>;
  writeNote?(record: LearningNoteRecord, signal: AbortSignal): Promise<string>;
  receipts?: AutomaticLearningReceiptStore;
  onWorkerStarted?(agentId: string): void;
  onWorkerSettled?(agentId: string): void;
  timeoutMs?: number;
}
export type ObservedAutomaticLearningOptions = Omit<AutomaticLearningOptions, 'result' | 'currentTurnEvidence'> & {
  /** A Rust-stored, attributed episode; observed reports never masquerade as successful Native tools. */
  observed: { scope: ObservedMemoryScope; episodeId: string; revision: string };
};

/** General workspace file/search/web/memory tools never enter the curator. Rust enforces its own allowlist and read count. */
export function automaticLearningTools(tools: readonly AnyTool[]): AnyTool[] {
  return tools.filter(tool => ((tool.access === 'read' && (tool.kind === 'knowledge' || tool.kind === 'read' || tool.kind === 'search') && /^knowledge_[a-z_]+$/.test(tool.name))
      || ((tool.access === 'read' || tool.access === 'meta') && tool.kind === 'knowledge' && ['skill_read', 'skill_search', 'skill_list'].includes(tool.name)))
    && !/write|edit|command|execute|shell|terminal|propose|delegat|manage|meeting|submit|delete|remove|rollback|import|sync/.test(tool.name));
}
export function hasAutomaticLearningEvidence(result: TurnResult, evidence: readonly ToolResultEntry[]): boolean {
  return result.outcome === 'completed' && evidence.some(item => !item.isError && item.content.trim().length > 0);
}

/** At most 96 KiB after worst-case JSON escaping, plus the small wire envelope. */
export const LEARNING_EVIDENCE_CHUNK_UNITS = 16_384;

/** Frame only; eligibility, selection, redaction and limits belong to Rust. */
function evidenceChunkEnd(content: string, offset: number): number {
  let end = Math.min(content.length, offset + LEARNING_EVIDENCE_CHUNK_UNITS);
  const last = content.charCodeAt(end - 1), next = content.charCodeAt(end);
  if (end < content.length && last >= 0xd800 && last <= 0xdbff && next >= 0xdc00 && next <= 0xdfff) end--;
  return end;
}

/** Rust owns analysis state and all deterministic processing. The host only admits/drains effects and projects activity. */
export function runAutomaticLearning(options: AutomaticLearningOptions): Promise<AutomaticLearningResult> {
  return runLearning(options);
}
export function runObservedAutomaticLearning(options: ObservedAutomaticLearningOptions): Promise<AutomaticLearningResult> {
  return runLearning(options);
}
async function runLearning(options: AutomaticLearningOptions | ObservedAutomaticLearningOptions): Promise<AutomaticLearningResult> {
  let result: AutomaticLearningResult = { outcome: 'skipped', skill: { status: 'skipped' }, note: { status: 'skipped' } };
  const observed = 'observed' in options;
  if (!options.policy.enabled || (!options.policy.skills && !options.policy.notes)
    || !observed && !hasAutomaticLearningEvidence(options.result, options.currentTurnEvidence)) return result;
  if (options.signal.aborted) return { ...result, outcome: 'cancelled', reason: 'The source invocation was cancelled.' };
  const backend = options.backend;
  if (!backend) return { ...result, outcome: 'failed', reason: 'The Rust learning backend is unavailable.' };
  const controller = new AbortController();
  let job: RustLearningJob | undefined;
  let intakeId: string | undefined;
  let cancellation: Promise<RustLearningJob> | undefined;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const requestCancellation = () => {
    controller.abort();
    if (job && !cancellation) {
      const jobId = job.jobId;
      cancellation = backend.process('job.cancel', { jobId }).then(reply => reply.job);
      // An unavailable sidecar must not create an unhandled rejection while an effect drains.
      void cancellation.catch(() => undefined);
    }
  };
  const assertActive = async () => {
    if (controller.signal.aborted) throw new Error('Learning cancelled.');
    await options.assertCurrent();
    if (controller.signal.aborted) throw new Error('Learning cancelled.');
  };
  const emit = async (body: EventBody) => {
    try { await options.emit(body, result.agentId!); }
    catch { requestCancellation(); throw new Error('Learning activity could not be recorded.'); }
  };
  options.signal.addEventListener('abort', requestCancellation, { once: true });
  if (options.signal.aborted) requestCancellation();
  try {
    await assertActive();
    const tools = automaticLearningTools(options.tools);
    const policy = { enabled: options.policy.enabled, skills: options.policy.skills && Boolean(options.proposeSkill), notes: options.policy.notes && Boolean(options.writeNote) };
    // Abort propagation starts with admission, including time waiting for begin's acknowledgement.
    // Rust independently owns and checks the authoritative job deadline.
    timer = setTimeout(requestCancellation, Math.min(45_000, options.timeoutMs ?? 35_000));
    if (observed) {
      await assertActive();
      job = (await backend.process('observed.jobBegin', {
        ...options.observed, runId: options.runId, promptSha256: options.promptSha256, policy,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters: { ...parameters } })),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })).job;
    } else {
      intakeId = (await backend.process('evidence.begin', {})).intakeId;
      evidence: for (const entry of options.currentTurnEvidence) {
        let offset = 0;
        do {
          if (controller.signal.aborted) throw new Error('Learning evidence intake cancelled.');
          const end = evidenceChunkEnd(entry.content, offset);
          const reply = await backend.process('evidence.append', { intakeId, toolCallId: entry.toolCallId, name: entry.name,
            isError: entry.isError, chunk: entry.content.slice(offset, end), final: end === entry.content.length });
          if (reply.complete) break evidence;
          offset = end;
        } while (offset < entry.content.length);
      }
      await assertActive();
      job = (await backend.process('job.begin', {
        profileId: options.profileId, revision: options.revision, workspaceId: options.workspaceId, sessionId: options.sessionId,
        runId: options.runId, promptSha256: options.promptSha256, policy, intakeId,
        tools: tools.map(({ name, description, parameters }) => ({ name, description, parameters })),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      })).job;
      intakeId = undefined; // The admitted job consumed this connection-bound intake.
    }
    if (controller.signal.aborted) requestCancellation();
    result.agentId = `learning-${randomUUID()}`;
    options.onWorkerStarted?.(result.agentId);
    started = true;
    await emit({ type: 'subagent.spawned', subagentId: result.agentId, role: 'Skills curator', label: observed ? 'Observed work review' : 'Post-task learning' });
    await emit({ type: 'subagent.state', subagentId: result.agentId, state: 'working', summary: 'Reviewing completed task evidence' });
    await emit({ type: 'agent.state', state: 'working', activity: 'knowledge', summary: 'Reviewing completed task evidence' });
    while (job.status === 'running' && job.effect) {
      const effect: NonNullable<RustLearningJob['effect']> = job.effect;
      let completion: RustLearningInputs['job.advance']['completion'];
      try {
        await assertActive();
        if (effect.kind === 'model') {
          await emit({ type: 'agent.state', state: 'thinking', activity: 'knowledge', summary: 'Reviewing completed task evidence' });
          // No TS turn loop, model-result parsing, evidence transformation or artifact generation.
          const response = await options.provider.complete({ system: effect.system, messages: effect.messages, tools: effect.tools, signal: controller.signal });
          completion = { kind: 'model', result: response };
        } else {
          const tool: AnyTool | undefined = tools.find(item => item.name === effect.name);
          if (!tool) throw new Error('The Rust-requested read adapter is unavailable.');
          await emit({ type: 'tool.started', toolCallId: effect.callId, tool: effect.name, kind: 'knowledge', label: 'Reading registered knowledge' });
          const refusal: string | undefined = tool.precheck?.(effect.input);
          const read: ToolOutcome = refusal ? { ok: false, output: refusal } : await tool.run(effect.input, { signal: controller.signal, toolCallId: effect.callId, emit: () => undefined });
          completion = { kind: 'read', ok: read.ok, output: read.output };
          await emit({ type: 'tool.completed', toolCallId: effect.callId, tool: effect.name, kind: 'knowledge', label: 'Registered knowledge read settled', ok: read.ok, output: 'Read result returned to the Rust curator.' });
        }
      } catch {
        completion = { kind: 'failed' };
      }
      // Await the actual effect promise above even when cancellation/deadline was requested.
      if (controller.signal.aborted) {
        requestCancellation();
        if (cancellation) job = await cancellation;
        job = (await backend.process('job.settle', { jobId: job.jobId, effectId: effect.effectId })).job;
        break;
      }
      job = (await backend.process('job.advance', { jobId: job.jobId, effectId: effect.effectId, completion })).job;
      result.usage = job.usage;
      if (completion.kind === 'model') await emit({ type: 'model.completed', text: 'Post-task model response processed by the Rust curator.', ...(completion.result.usage ? { usage: completion.result.usage } : {}) });
    }
    result.usage = job.usage;
    if (controller.signal.aborted || job.status === 'cancelled') return result = { ...result, outcome: 'cancelled', reason: job.reason ?? 'Learning cancelled after its effect settled.' };
    if (job.status === 'skipped') return result = { ...result, reason: job.reason };
    if (job.status !== 'ready' || !job.submission || !job.contentSha256) return result = { ...result, outcome: 'failed', reason: job.reason ?? 'The Rust curator did not produce eligible findings.' };
    await assertActive();
    const claim = async (contentSha256: string) => (await backend.process('receipt.claim', { profileId: options.profileId, contentSha256, runId: options.runId })).claimed;
    if (!await claim(job.contentSha256)) return result = { ...result, reason: 'This profile already attempted these findings; inspect recorded receipts before retrying.' };
    result.outcome = 'completed';
    const submission = job.submission;
    if (policy.skills && submission.skill && options.proposeSkill) {
      try {
        await assertActive();
        if (!job.skillSha256) throw new Error('The Rust candidate digest is unavailable.');
        if (await claim(job.skillSha256)) {
          await assertActive();
          result.skill = { status: 'recorded', receipt: await options.proposeSkill(submission.skill, job.provenance, controller.signal) };
        }
      } catch { result.skill = { status: 'unknown' }; }
    }
    if (policy.notes && options.writeNote) {
      try {
        await assertActive();
        const path = await options.writeNote({ workspaceId: options.workspaceId, sessionId: options.sessionId, profileId: options.profileId, revision: options.revision,
          runId: options.runId, promptSha256: options.promptSha256, title: submission.title, lesson: submission.lesson,
          evidence: job.evidence, ...(result.skill.receipt ? { skill: result.skill.receipt } : {}) }, controller.signal);
        result.note = { status: 'saved', path };
      } catch { result.note = { status: 'failed' }; }
    }
    if (result.skill.status === 'unknown' || result.note.status === 'failed') result.outcome = 'failed';
    if (controller.signal.aborted) result.outcome = 'cancelled';
    if (!controller.signal.aborted) {
      job = (await backend.process('job.finish', { jobId: job.jobId })).job;
      if (job.status !== 'completed') {
        result.outcome = job.status === 'cancelled' ? 'cancelled' : 'failed';
        result.reason = job.reason ?? 'The Rust learning job did not acknowledge completion.';
      }
    }
    return result;
  } catch {
    return result = { ...result, outcome: controller.signal.aborted ? 'cancelled' : 'failed', reason: 'Learning stopped before confirmed completion; inspect recorded receipts.' };
  } finally {
    if (timer) clearTimeout(timer);
    options.signal.removeEventListener('abort', requestCancellation);
    if (job) {
      try {
        // All host effects have settled before reaching this block. Cancel/settle drains
        // a pending Rust effect if a host-side policy/event/transport check refused admission.
        if (job.pendingEffectId || job.status === 'running' || job.status === 'ready') {
          requestCancellation(); if (cancellation) job = await cancellation;
          const effectId = job.pendingEffectId ?? job.effect?.effectId;
          if (effectId) job = (await backend.process('job.settle', { jobId: job.jobId, effectId })).job;
        }
        await backend.process('job.release', { jobId: job.jobId });
      } catch {
        // No reconnect or replay: a lost sidecar acknowledgement remains uncertain.
        if (result.outcome === 'completed') { result.outcome = 'failed'; result.reason = 'The Rust learning lifetime could not be released.'; }
      }
    }
    if (intakeId) {
      try { await backend.process('evidence.release', { intakeId }); }
      catch { /* Lost acknowledgements never cause intake replay or reconnection. */ }
    }
    if (started) {
      try {
        const summary = `Learning ${result.outcome}; skill ${result.skill.status}; note ${result.note.status}.`;
        await options.emit(result.outcome === 'failed' || result.outcome === 'cancelled'
          ? { type: 'turn.failed', error: summary }
          : { type: 'turn.completed', summary, ...(result.usage ? { usage: result.usage } : {}) }, result.agentId!);
        await options.emit({ type: 'agent.state', state: 'idle' }, result.agentId!);
        await options.emit({ type: 'subagent.state', subagentId: result.agentId!, state: 'idle', summary: 'Post-task learning settled' }, result.agentId!);
      } catch { /* Actual settlement still releases the host worker after an event-sink failure. */ }
      options.onWorkerSettled?.(result.agentId!);
    }
  }
}
