/** Connection-bound ports for Rust-owned learning jobs and artifact persistence. */
import type { DaemonLearningParams, LearningActions, Usage } from '@extalia/protocol';
import type { ModelMessage, ModelResult, ToolResultEntry, ToolSpec } from '@extalia/runtime';
import type { SkillProposalInput, SkillProposalProvenance } from './skillLearning.js';
import { DaemonUnavailableError, type DaemonClient } from './daemon/index.js';

export interface RustLearningJob {
  jobId: string;
  status: 'running' | 'ready' | 'skipped' | 'failed' | 'cancelled' | 'completed';
  effect?: { effectId: string; kind: 'model'; system: string; messages: ModelMessage[]; tools: ToolSpec[] }
    | { effectId: string; kind: 'read'; callId: string; name: string; input: Record<string, unknown> };
  pendingEffectId?: string;
  submission?: { title: string; lesson: string; evidenceIds: string[]; skill?: SkillProposalInput };
  evidence: { id: string; name: string; content: string }[];
  provenance: SkillProposalProvenance;
  contentSha256?: string;
  skillSha256?: string;
  reason?: string;
  usage?: Usage;
}

export type { ObservedMemoryScope, ObservedMemoryEntry, ObservedMemoryCoverage, ObservedMemoryEpisode, ObservedMemoryPage } from '@extalia/protocol';
export interface RustLearningInputs {
  'observed.capture': LearningActions['observed.capture']['input'];
  'observed.search': LearningActions['observed.search']['input'];
  'observed.read': LearningActions['observed.read']['input'];
  'observed.revoke': LearningActions['observed.revoke']['input'];
  'observed.jobBegin': Omit<LearningActions['observed.jobBegin']['input'], 'tools'> & { tools: readonly ToolSpec[] };
  'evidence.begin': Record<string, never>;
  'evidence.append': { intakeId: string; toolCallId: string; name: string; isError: boolean; chunk: string; final: boolean };
  'evidence.release': { intakeId: string };
  'job.begin': {
    profileId: string; revision: string; workspaceId: string; sessionId: string; runId: string; promptSha256: string;
    policy: { enabled: boolean; skills: boolean; notes: boolean }; tools: readonly ToolSpec[]; timeoutMs?: number;
  } & ({ intakeId: string; evidence?: never } | { evidence: readonly ToolResultEntry[]; intakeId?: never });
  'job.advance': { jobId: string; effectId: string; completion: { kind: 'model'; result: ModelResult } | { kind: 'read'; ok: boolean; output: string } | { kind: 'failed' } };
  'job.cancel': { jobId: string };
  'job.settle': { jobId: string; effectId: string };
  'job.finish': { jobId: string };
  'job.release': { jobId: string };
  'receipt.claim': { profileId: string; contentSha256: string; runId: string };
  'note.pin': { root: string; profileId: string; revision: string; workspaceId: string; sessionId: string; purpose: 'learning' | 'meeting' };
  'note.prepare': { pinId: string; record: unknown };
  'note.commit': { draftId: string };
  'note.discard': { draftId: string };
  'note.release': { pinId: string };
  'vault.ensure': { profileId: string };
  'skill.normalize': { proposal: unknown; provenance?: SkillProposalProvenance };
  'skill.stage': { proposal: unknown; provenance: SkillProposalProvenance };
  'skill.stageFolder': { root: string };
  'skill.cleanup': { stageId: string };
}
type Released = { released: true };
interface ResultValues {
  'observed.capture': LearningActions['observed.capture']['result'];
  'observed.search': LearningActions['observed.search']['result'];
  'observed.read': LearningActions['observed.read']['result'];
  'observed.revoke': LearningActions['observed.revoke']['result'];
  'observed.jobBegin': { job: RustLearningJob };
  'evidence.begin': { intakeId: string };
  'evidence.append': { complete: boolean };
  'evidence.release': Released;
  'job.begin': { job: RustLearningJob };
  'job.advance': { job: RustLearningJob };
  'job.cancel': { job: RustLearningJob };
  'job.settle': { job: RustLearningJob };
  'job.finish': { job: RustLearningJob };
  'job.release': Released;
  'receipt.claim': { claimed: boolean };
  'note.pin': { pinId: string };
  'note.prepare': { draftId: string; path: string };
  'note.commit': { path: string };
  'note.discard': Released;
  'note.release': Released;
  'vault.ensure': { root: string };
  'skill.normalize': { proposal: SkillProposalInput; provenance?: SkillProposalProvenance };
  'skill.stage': { stageId: string; path: string };
  'skill.stageFolder': { stageId: string; path: string };
  'skill.cleanup': Released;
}
export type RustLearningAction = keyof RustLearningInputs;
export type RustLearningResults = { [A in RustLearningAction]: ResultValues[A] & { action: A } };
export interface RustLearningPort {
  process<A extends RustLearningAction>(action: A, input: RustLearningInputs[A]): Promise<RustLearningResults[A]>;
}

/** Opaque handles never reconnect to a replacement daemon or acquire a new destination. */
export class RustLearningBackend implements RustLearningPort {
  private readonly handles = new Map<string, DaemonClient>();
  private readonly runs = new Map<string, DaemonClient>();
  private readonly jobRuns = new Map<string, string>();
  constructor(private readonly connect: () => Promise<DaemonClient>) {}

  async process<A extends RustLearningAction>(action: A, input: RustLearningInputs[A]): Promise<RustLearningResults[A]> {
    const fields = input as unknown as Record<string, unknown>;
    const handle = ['jobId', 'pinId', 'draftId', 'stageId', 'intakeId'].map(key => fields[key]).find(value => typeof value === 'string') as string | undefined;
    const provenance = fields.provenance as SkillProposalProvenance | undefined;
    const runId = typeof fields.runId === 'string' ? fields.runId : provenance?.runId;
    const client = handle ? this.handles.get(handle) : runId ? this.runs.get(runId) ?? await this.connect() : await this.connect();
    if (!client || !client.usable || !(client.capabilities as readonly string[]).includes('learning.process'))
      throw new DaemonUnavailableError('missing_capability');
    const result = await client.request('learning.process', { action, input } as DaemonLearningParams, 30_000) as unknown as RustLearningResults[A];
    if (result.action !== action) throw new DaemonUnavailableError('malformed_reply');
    const values = result as unknown as Record<string, unknown>;
    const job = values.job as RustLearningJob | undefined;
    for (const id of [values.pinId, values.draftId, values.stageId, values.intakeId, job?.jobId]) if (typeof id === 'string') this.handles.set(id, client);
    if ((action === 'job.begin' || action === 'observed.jobBegin') && runId && job) { this.runs.set(runId, client); this.jobRuns.set(job.jobId, runId); }
    if (handle && ['job.begin', 'job.release', 'evidence.release', 'note.release', 'note.discard', 'note.commit', 'skill.cleanup'].includes(action)) this.handles.delete(handle);
    if (action === 'job.release' && handle) {
      const run = this.jobRuns.get(handle);
      if (run) this.runs.delete(run);
      this.jobRuns.delete(handle);
    }
    return result;
  }
}
