/** A one-request decision for a trusted, synchronous native Codex hook. */
export type CodexPermissionHookDecision = 'allow' | 'deny' | 'pass';

export interface CodexPermissionHookRequest {
  /** Opaque host handle, distinct from the calling hook's nonce. */
  requestId: string;
  payloadDigest: string;
  nativeSessionId: string;
  turnId: string;
  toolName: string;
  /** Complete native payload; never clipped or rewritten into a question. */
  sourceJson: string;
  expiresAt: string;
  availableDecisions: CodexPermissionHookDecision[];
}

export interface CodexPermissionHookStatus {
  sessionId: string;
  state: 'ready' | 'unavailable';
  requests: CodexPermissionHookRequest[];
  problem?: string;
  /** Local installation only; native trust and Desktop activation require user review. */
  installed?: boolean;
}

export interface CodexPermissionSetupPlan {
  revision: string;
  changed: boolean;
  nativeSessionId: string;
  configPath: string;
  forwarderPath: string;
  tokenPath: string;
  createsPermissionToken: boolean;
  diff: string;
  needsTrust: true;
  undoCommand: string;
  backupDirectory: string;
  files: Array<{ path: string; beforeSha256?: string; afterSha256: string; removed?: boolean }>;
}

export interface CodexPermissionHookAnswer {
  requestId: string;
  payloadDigest: string;
  decision: CodexPermissionHookDecision;
}
