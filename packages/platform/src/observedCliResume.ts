/** An explicit permission to continue an existing CLI conversation. */
export type ObservedCliFamily = 'codex' | 'gemini' | 'claude';
export type ObservedCliResumeState = 'unavailable' | 'disconnected' | 'ready' | 'running' | 'uncertain';
export interface ObservedCliResumeStatus {
  sessionId: string;
  state: ObservedCliResumeState;
  family?: ObservedCliFamily;
  pairingId?: string;
  nativeSessionId?: string;
  executable?: string;
  version?: string;
  projectPath?: string;
  profilePath?: string;
  operationId?: string;
  lastOutcome?: 'completed' | 'failed' | 'unknown';
  problem?: string;
}
export interface ObservedCliResumePreview {
  sessionId: string;
  reviewId: string;
  expiresAt: string;
  family: ObservedCliFamily;
  nativeSessionId: string;
  executable: string;
  version: string;
  projectPath: string;
  profilePath: string;
  /** Model reported by the previous native turn; informational, not a provider route. */
  model?: string;
  /** Exact explicit request model read from reviewed native configuration. */
  resumeModel?: string;
  resumeModelSource?: 'profile' | 'project' | 'environment';
  /** Fixed host-selected arguments. Prompt bodies and credentials are excluded. */
  arguments: string[];
}
export interface ObservedCliResumePairInput {
  reviewId: string;
  exclusiveOwnerConfirmed: boolean;
}
export interface ObservedCliResumeReconcileInput {
  operationId: string;
  inspected: boolean;
}
