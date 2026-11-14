/** Rust-owned bounded local learning, over the existing profile sidecar. */
export const DAEMON_LEARNING_OPS = ['learning.process'] as const;
export interface LearningProposal { name: string; description: string; instructions: string; sourceUrls?: string[] }
export interface LearningProvenance { sessionId: string; workspaceId: string; promptSha256: string; profileId?: string; runId?: string }
export interface LearningEvidence { id: string; name: string; content: string }
export interface LearningToolCall { id: string; name: string; input: Record<string, unknown>; inputError?: string }
export interface LearningToolSpec { name: string; description: string; parameters: Record<string, unknown> }
export interface LearningUsage { inputTokens?: number; outputTokens?: number; cachedInputTokens?: number }
export type LearningMessage = { role: 'user'; text: string } | { role: 'assistant'; text: string; toolCalls: LearningToolCall[]; native?: { api: 'openai-chat' | 'openai-responses' | 'anthropic-messages'; content: unknown } } | { role: 'tool'; results: { toolCallId: string; name: string; content: string; isError: boolean }[] };
export interface LearningModelResult { text: string; toolCalls: LearningToolCall[]; stop: 'end' | 'tool_use' | 'max_tokens' | 'refusal' | 'other'; model?: string; usage?: LearningUsage; promptTokens?: number; native?: { api: 'openai-chat' | 'openai-responses' | 'anthropic-messages'; content: unknown }; refusal?: string }
export type LearningEffect = { effectId: string; kind: 'model'; system: string; messages: LearningMessage[]; tools: LearningToolSpec[] } | { effectId: string; kind: 'read'; callId: string; name: string; input: Record<string, unknown> };
export interface LearningSubmission { title: string; lesson: string; evidenceIds: string[]; skill?: LearningProposal }
export interface LearningJobState { jobId: string; status: 'running' | 'ready' | 'skipped' | 'failed' | 'cancelled' | 'completed'; effect?: LearningEffect; pendingEffectId?: string; submission?: LearningSubmission; evidence: LearningEvidence[]; provenance: LearningProvenance; contentSha256?: string; skillSha256?: string; reason?: string; usage?: LearningUsage }
export interface LearningNoteRecord { workspaceId: string; sessionId: string; profileId: string; revision: string; runId: string; promptSha256: string; title: string; lesson: string; evidence: LearningEvidence[]; skill?: { packageId: string; revisionId: string; state: string; stateReason?: string; created: boolean; inspection: 'recorded' | 'unavailable'; inspectionOutcome?: string; activationPerformed: false; cancellationObserved: boolean } }
export interface LearningMeetingRecord { meetingId: string; topic: string; roomId?: string; startedAt: string; completedAt: string; outcome: 'completed' | 'failed' | 'cancelled'; participants: { agentId: string; name: string; role: string }[]; contributions: { agentId: string; round: number; text: string }[] }
export interface ObservedMemoryScope { profileId: string; workspaceId: string; sessionId: string; sourceId: string; nativeSessionId: string; boundary: string }
export interface ObservedMemoryEntry { id: string; kind: 'user' | 'assistant' | 'tool' | 'file' | 'status'; text: string; at?: string }
export interface ObservedMemoryCoverage { mode: 'partial' | 'unknown'; omittedEntries: number; truncated: boolean; limits: string[] }
export interface ObservedMemoryEpisode { id: string; episodeId: string; scope: ObservedMemoryScope; revision: string; sourceRevision: string; capturedAt: string; entries: number; trust: 'untrusted-observed'; coverage: ObservedMemoryCoverage }
export interface ObservedMemoryPage { episode: ObservedMemoryEpisode; entries: ObservedMemoryEntry[]; offset: number; total: number; nextOffset?: number }
export interface LearningActions {
  'observed.capture': { input: { scope: ObservedMemoryScope; episodeId: string; sourceRevision: string; entries: ObservedMemoryEntry[]; coverage: ObservedMemoryCoverage }; result: { episode: ObservedMemoryEpisode; created: boolean } };
  'observed.search': { input: { scope: ObservedMemoryScope; query: string; limit?: number }; result: { hits: { episode: ObservedMemoryEpisode; excerpt: string }[]; omitted: number } };
  'observed.read': { input: { scope: ObservedMemoryScope; episodeId: string; revision: string; offset?: number; limit?: number }; result: ObservedMemoryPage };
  'observed.revoke': { input: { scope: ObservedMemoryScope }; result: { removed: number } };
  'observed.jobBegin': { input: { scope: ObservedMemoryScope; episodeId: string; revision: string; runId: string; promptSha256: string; policy: { enabled: boolean; skills: boolean; notes: boolean }; tools: LearningToolSpec[]; timeoutMs?: number }; result: { job: LearningJobState } };
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
  'job.begin': { input: { profileId: string; revision: string; workspaceId: string; sessionId: string; runId: string; promptSha256: string; policy: { enabled: boolean; skills: boolean; notes: boolean }; tools: LearningToolSpec[]; timeoutMs?: number } & ({ evidence: { toolCallId: string; name: string; content: string; isError: boolean }[]; intakeId?: never } | { intakeId: string; evidence?: never }); result: { job: LearningJobState } };
  'job.advance': { input: { jobId: string; effectId: string; completion: { kind: 'model'; result: LearningModelResult } | { kind: 'read'; ok: boolean; output: string } | { kind: 'failed' } }; result: { job: LearningJobState } };
  'job.cancel': { input: { jobId: string }; result: { job: LearningJobState } };
  /** Only acknowledges that the host actually drained a cancelled effect; never infers physical settlement. */
  'job.settle': { input: { jobId: string; effectId: string }; result: { job: LearningJobState } };
  'job.finish': { input: { jobId: string }; result: { job: LearningJobState } };
  'job.release': { input: { jobId: string }; result: { released: true } };
}
export type LearningAction = keyof LearningActions;
export type DaemonLearningParams = { [A in LearningAction]: { action: A; input: LearningActions[A]['input'] } }[LearningAction];
export type DaemonLearningResult = { [A in LearningAction]: { action: A } & LearningActions[A]['result'] }[LearningAction];
export interface DaemonLearningOperations { 'learning.process': { params: DaemonLearningParams; result: DaemonLearningResult } }
