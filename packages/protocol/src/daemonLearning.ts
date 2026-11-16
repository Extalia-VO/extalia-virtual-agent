/** Rust-owned bounded local learning, over the existing profile sidecar. */
import type { WorkMemoryActions } from './daemonWorkMemory.js';
export const DAEMON_LEARNING_OPS = ['learning.process'] as const;
export interface LearningProposal {
  name: string; description: string; instructions: string; sourceUrls?: string[];
  baseRevisionId?: string; baseSkillSha256?: string; baseReadReceipt?: string; refinementReason?: string;
  references?: { path: string; content: string }[];
}
export interface LearningProvenance { sessionId: string; workspaceId: string; promptSha256: string; profileId?: string; runId?: string }
export interface LearningEvidence { id: string; name: string; content: string }
export interface LearningToolCall { id: string; name: string; input: Record<string, unknown>; inputError?: string }
export interface LearningToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface LearningUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
export interface LearningSourceContext { user: string; assistant: string }
export interface LearningFailure { stage: 'provider' | 'read' | 'authority' | 'activity'; code: 'unavailable' | 'timeout' | 'rate-limited' | 'invalid-request' | 'cancelled' | 'unknown' }
export type LearningMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; toolCalls: LearningToolCall[]; native?: { api: 'openai-chat' | 'openai-responses' | 'anthropic-messages'; content: unknown } } | { role: 'tool'; results: { toolCallId: string; name: string; content: string; isError: boolean }[] };
export interface LearningModelResult { text: string; toolCalls: LearningToolCall[]; stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'; model?: string; usage?: LearningUsage; promptTokens?: number; native?: { api: 'openai-chat' | 'openai-responses' | 'anthropic-messages'; content: unknown }; refusal?: string }
export type LearningEffect = { effectId: string; kind: 'model'; system: string; messages: LearningMessage[]; tools: LearningToolSpec[] } | { effectId: string; kind: 'read'; callId: string; name: string; input: Record<string, unknown> };
/** A normalized relationship grounded in a successful read in this job; not a truth attestation. */
export interface LearningRelatedNote { path: string; relation: 'related' | 'updates' | 'contradicts'; reason: string; evidenceIds: string[]; sourceSha256: string }
export interface LearningKnowledgeRead { path: string; sha256: string }
export interface LearningSubmission { title: string; lesson: string; evidenceIds: string[]; relatedNotes?: LearningRelatedNote[]; skill?: LearningProposal }
export interface LearningRecoverySource { scope: ObservedMemoryScope; episodeId: string; revision: string }
export interface LearningRecoveryBinding {
  profileId: string; workspaceId: string; sessionId: string; runId: string; promptSha256: string;
  destinationRevision: string; routeFingerprint: string;
  policy: { enabled: boolean; skills: boolean; notes: boolean };
  observedSource?: LearningRecoverySource;
}
/** Local checkpoint metadata is provenance, never renewed permission to execute. */
export interface LearningRecoveryRecord extends LearningRecoveryBinding {
  jobId: string; state: 'queued' | 'resumable' | 'publication' | 'uncertain' | 'terminal' | 'expired';
  active: boolean; updatedAt: number; expiresAt: number; modelRequests: number; reads: number;
  skillReviewRequired: boolean; reason?: string; noteSha256?: string; skillSha256?: string;
  /** A full quiet interval is restored after restart; no overdue wall-clock execution. */
  queue?: { revision: string; delaySeconds: 60 | 600 };
}
/** Exact source and queue generation, freshly authorized by the host for each mutation. */
export interface LearningQueueBinding extends LearningRecoveryBinding { jobId: string; queueRevision: string }
export interface LearningQueueCaptureInput {
  profileId: string; revision: string; workspaceId: string; sessionId: string; runId: string; promptSha256: string;
  policy: { enabled: boolean; skills: boolean; notes: boolean }; routeFingerprint: string;
  sourceContext?: LearningSourceContext;
}
export interface LearningJobState { jobId: string; status: 'queued' | 'running' | 'ready' | 'skipped' | 'failed' | 'cancelled' | 'completed'; effect?: LearningEffect; pendingEffectId?: string; submission?: LearningSubmission; knowledgeReads?: LearningKnowledgeRead[]; evidence: LearningEvidence[]; provenance: LearningProvenance; contentSha256?: string; noteSha256?: string; skillSha256?: string; reason?: string; usage?: LearningUsage; failure?: LearningFailure; recovery?: { resumed: true; skillReviewRequired: boolean } }
export interface LearningNoteRecord { workspaceId: string; sessionId: string; profileId: string; revision: string; runId: string; promptSha256: string; title: string; lesson: string; evidence: LearningEvidence[]; relatedNotes?: LearningRelatedNote[]; knowledgeReads?: LearningKnowledgeRead[]; skill?: { packageId: string; revisionId: string; state: string; stateReason?: string; created: boolean; inspection: 'recorded' | 'unavailable'; inspectionOutcome?: string; activationPerformed: false; cancellationObserved: boolean } }
export interface LearningMeetingRecord { meetingId: string; topic: string; roomId?: string; startedAt: string; completedAt: string; outcome: 'completed' | 'failed' | 'cancelled'; participants: { agentId: string; name: string; role: string }[]; contributions: { agentId: string; round: number; text: string }[] }
export interface ObservedMemoryScope { profileId: string; workspaceId: string; sessionId: string; sourceId: string; nativeSessionId: string; boundary: string }
export interface ObservedMemoryEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'file' | 'status'; text: string; at?: string }
export interface ObservedMemoryCoverage { mode: 'partial' | 'unknown'; omittedEntries: number; truncated: boolean; limits: string[] }
export interface ObservedMemoryEpisode { id: string; episodeId: string; scope: ObservedMemoryScope; revision: string; sourceRevision: string; capturedAt: string; entries: number; trust: 'untrusted-observed'; coverage: ObservedMemoryCoverage }
export interface ObservedMemoryPage { episode: ObservedMemoryEpisode; entries: ObservedMemoryEntry[]; offset: number; total: number; nextOffset?: number }
export interface LearningActions extends WorkMemoryActions {
  'observed.capture': { input: { scope: ObservedMemoryScope; episodeId: string; sourceRevision: string; entries: ObservedMemoryEntry[]; coverage: ObservedMemoryCoverage }; result: { episode: ObservedMemoryEpisode; created: boolean } };
  'observed.search': { input: { scope: ObservedMemoryScope; query: string; limit?: number }; result: { hits: { episode: ObservedMemoryEpisode; excerpt: string }[]; omitted: number } };
  'observed.read': { input: { scope: ObservedMemoryScope; episodeId: string; revision: string; offset?: number; limit?: number }; result: ObservedMemoryPage };
  'observed.revoke': { input: { scope: ObservedMemoryScope }; result: { removed: number } };
  'observed.jobBegin': { input: { scope: ObservedMemoryScope; episodeId: string; revision: string; destinationRevision?: string; runId: string; promptSha256: string; policy: { enabled: boolean; skills: boolean; notes: boolean }; tools: LearningToolSpec[]; timeoutMs?: number; routeFingerprint?: string; memoryContext?: string }; result: { job: LearningJobState } };
  /** Save the exact opted-in observed episode before idle admission, without model work or a live job handle. */
  'observed.queueCapture': { input: { scope: ObservedMemoryScope; episodeId: string; revision: string; destinationRevision: string; runId: string; promptSha256: string; policy: { enabled: boolean; skills: boolean; notes: boolean }; routeFingerprint: string }; result: { record: LearningRecoveryRecord; created: boolean } };
  'evidence.begin': { input: Record<string, never>; result: { intakeId: string } };
  'evidence.append': { input: { intakeId: string; toolCallId: string; name: string; isError: boolean; chunk: string; final: boolean }; result: { complete: boolean } };
  'evidence.release': { input: { intakeId: string }; result: { released: true } };
  'vault.ensure': { input: { profileId: string }; result: { root: string } };
  'note.pin': { input: { root: string; profileId: string; revision: string; workspaceId: string; sessionId: string; purpose: 'learning' | 'meeting' }; result: { pinId: string } };
  'note.prepare': { input: { pinId: string; record: LearningNoteRecord | LearningMeetingRecord }; result: { draftId: string; path: string } };
  'note.commit': { input: { draftId: string }; result: { path: string } };
  'note.discard': { input: { draftId: string }; result: { released: true } };
  'note.release': { input: { pinId: string }; result: { released: true } };
  'skill.normalize': { input: { proposal: LearningProposal; provenance?: LearningProvenance }; result: { proposal: LearningProposal; provenance?: LearningProvenance } };
  'skill.stage': { input: { proposal: LearningProposal; provenance: LearningProvenance }; result: { stageId: string; path: string } };
  /** User-selected manual import only; never a model tool. */
  'skill.stageFolder': { input: { root: string }; result: { stageId: string; path: string } };
  'skill.cleanup': { input: { stageId: string }; result: { released: true } };
  'receipt.claim': { input: { profileId: string; contentSha256: string; runId: string }; result: { claimed: boolean } };
  'receipt.get': { input: { profileId: string; contentSha256: string }; result: { status: 'missing' | 'attempted' | 'recorded'; receipt?: { kind: 'note' | 'skill'; data: string } } };
  'receipt.record': { input: { profileId: string; contentSha256: string; runId: string; receipt: { kind: 'note' | 'skill'; data: string } }; result: { recorded: true; replayed: boolean } };
  'job.begin': { input: { profileId: string; revision: string; workspaceId: string; sessionId: string; runId: string; promptSha256: string; policy: { enabled: boolean; skills: boolean; notes: boolean }; tools: LearningToolSpec[]; timeoutMs?: number; routeFingerprint?: string; sourceContext?: LearningSourceContext; memoryContext?: string } & ({ evidence: { toolCallId: string; name: string; content: string; isError: boolean }[]; intakeId?: never } | { intakeId: string; evidence?: never }); result: { job: LearningJobState } };
  /** Rust selects and sanitizes evidence before durable, idempotent pre-admission capture. */
  'queue.capture': { input: LearningQueueCaptureInput & ({ evidence: { toolCallId: string; name: string; content: string; isError: boolean }[]; intakeId?: never } | { intakeId: string; evidence?: never }); result: { record: LearningRecoveryRecord; created: boolean } };
  'queue.delay': { input: LearningQueueBinding & { delaySeconds: 60 | 600 }; result: { record: LearningRecoveryRecord } };
  'queue.cancel': { input: LearningQueueBinding; result: { record: LearningRecoveryRecord } };
  /** The queued identity becomes the live job in one durable transition; no separate child job. */
  'queue.admit': { input: LearningQueueBinding & { tools: LearningToolSpec[]; memoryContext?: string; timeoutMs?: number }; result: { job: LearningJobState } };
  /** Durable admission must be acknowledged before the host starts a provider or read effect. */
  'job.enter': { input: { jobId: string; effectId: string }; result: { job: LearningJobState } };
  'job.list': { input: { profileId: string; workspaceId?: string; sessionId?: string; limit?: number }; result: { jobs: LearningRecoveryRecord[]; omitted: number } };
  /** The host must freshly authorize the exact saved source, destination, policy and route. */
  'job.recover': { input: LearningRecoveryBinding & { jobId: string; tools: LearningToolSpec[] }; result: { job: LearningJobState } };
  'job.advance': { input: { jobId: string; effectId: string; completion: { kind: 'model'; result: LearningModelResult } | { kind: 'read'; ok: boolean; output: string } | ({ kind: 'failed' } & Partial<LearningFailure>) }; result: { job: LearningJobState } };
  /** Recheck pinned source identities before publication; these are host read results, never model claims. */
  'job.revalidate': { input: { jobId: string; reads: { path: string; ok: boolean; output: string }[] }; result: { job: LearningJobState } };
  'job.cancel': { input: { jobId: string }; result: { job: LearningJobState } };
  /** Only acknowledges that the host actually drained a cancelled effect; never infers physical settlement. */
  'job.settle': { input: { jobId: string; effectId: string }; result: { job: LearningJobState } };
  'job.finish': { input: { jobId: string }; result: { job: LearningJobState } };
  /** Drops a durable live handle, preserving pending/entered checkpoints; never infers effect settlement. */
  'job.release': { input: { jobId: string }; result: { released: true } };
}
export type LearningAction = keyof LearningActions;
export type DaemonLearningParams = { [A in LearningAction]: { action: A; input: LearningActions[A]['input'] } }[LearningAction];
export type DaemonLearningResult = { [A in LearningAction]: { action: A } & LearningActions[A]['result'] }[LearningAction];
export interface DaemonLearningOperations { 'learning.process': { params: DaemonLearningParams; result: DaemonLearningResult } }
