/** Explicit same-server Codex attachment; ordinary transcript observation stays read-only. */
export interface ObservedCodexQuestion {
  id: string;
  header: string;
  question: string;
  isOther: boolean;
  isSecret: boolean;
  options: { label: string; description: string }[];
}

export interface ObservedCodexInputRequest {
  id: string;
  turnId: string;
  itemId: string;
  state: 'pending' | 'submitted';
  questions: ObservedCodexQuestion[];
}

/** Narrow native decisions only; persistent/session policies are never offered. */
export type ObservedCodexApprovalDecision = 'accept' | 'decline' | 'cancel';
export type ObservedCodexFileSystemPath =
  | { type: 'path'; path: string }
  | { type: 'glob_pattern'; pattern: string }
  | { type: 'special'; value: { kind: 'root' | 'minimal' | 'tmpdir' | 'slash_tmp' } | { kind: 'project_roots'; subpath?: string | null } | { kind: 'unknown'; path: string; subpath?: string | null } };
export interface ObservedCodexPermissions {
  network?: { enabled?: boolean | null } | null;
  fileSystem?: {
    entries?: { access: 'read' | 'write' | 'deny'; path: ObservedCodexFileSystemPath }[] | null;
    globScanMaxDepth?: number | null;
    read?: string[] | null;
    write?: string[] | null;
  } | null;
}
export type ObservedCodexCommandAction =
  | { type: 'read'; command: string; name: string; path: string }
  | { type: 'listFiles'; command: string; path?: string | null }
  | { type: 'search'; command: string; path?: string | null; query?: string | null }
  | { type: 'unknown'; command: string };
export interface ObservedCodexFileChange {
  path: string;
  diff: string;
  kind: { type: 'add' | 'delete' } | { type: 'update'; move_path?: string | null };
}
interface ObservedCodexApprovalBase {
  id: string;
  turnId: string;
  itemId: string;
  state: 'pending' | 'submitted';
  reason?: string;
  cwd?: string;
  environmentId?: string;
  availableDecisions: ObservedCodexApprovalDecision[];
}
export type ObservedCodexApprovalRequest = ObservedCodexApprovalBase & (
  | { kind: 'commandExecution'; command?: string; commandKind: 'command' | 'writeStdin' | 'humanCommand'; commandActions?: ObservedCodexCommandAction[]; networkApprovalContext?: { host: string; protocol: 'http' | 'https' | 'socks5Tcp' | 'socks5Udp' }; additionalPermissions?: ObservedCodexPermissions }
  | { kind: 'fileChange'; changes: ObservedCodexFileChange[]; grantRoot?: string }
  | { kind: 'permissions'; permissions: ObservedCodexPermissions; scope: 'turn' }
);

export interface ObservedCodexStatus {
  sessionId: string;
  state: 'disconnected' | 'connected' | 'unavailable';
  connectionId?: string;
  threadId?: string;
  activeTurnId?: string;
  canSend: boolean;
  canAnswer: boolean;
  requests: ObservedCodexInputRequest[];
  /** Absent on older hosts. Only newly received, fully described native requests. */
  approvals?: ObservedCodexApprovalRequest[];
  canApprove?: boolean;
  /** Diagnostic for the user; never a credential or raw RPC payload. */
  problem?: string;
  delivery?: 'submitted' | 'resolved' | 'unknown';
}

export interface ObservedCodexMessageInput {
  connectionId: string;
  text: string;
  /** Required for steering the exact current turn; absent only for an idle thread. */
  activeTurnId?: string;
}

export interface ObservedCodexAnswerInput {
  connectionId: string;
  requestId: string;
  answers: Record<string, string>;
}

export interface ObservedCodexApprovalAnswerInput {
  connectionId: string;
  requestId: string;
  decision: ObservedCodexApprovalDecision;
}
