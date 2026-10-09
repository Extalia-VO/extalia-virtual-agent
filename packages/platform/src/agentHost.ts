import type {
  CharacterAppearance, CharacterAppearances, Connection, CredentialSource, Effort, FeatureOwner, ImportMode, ImportPreview, LibrarySession, LocalState, Orchestration,
  PortableSession, ProviderApi, ProviderPresetId, RuntimeId, Workspace, WorkspacePermissions,
} from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';

/**
 * The agent host runs the Extalia Native runtime where files and commands are
 * reachable: the Desktop main process, or the local Bridge started by the
 * `extalia` CLI for the Web client. The UI talks to it only through this
 * contract; Desktop carries it over IPC, the Bridge over HTTP and SSE.
 *
 * Secrets cross this boundary only inbound (`saveConnection`, `testConnection`)
 * and are never returned.
 */

export type SecretStoreKind = 'os-keychain' | 'secret-service' | 'file' | 'memory';

export interface ConnectionView extends Connection {
  /** Whether the credential the connection needs is available right now. */
  credentialStatus: 'ok' | 'missing' | 'not-needed';
}

export interface SessionSummary {
  id: string;
  workspaceId: string;
  connectionId: string;
  title: string;
  control: 'managed' | 'observed';
  createdAt: string;
  lastActiveAt: string;
  /** A turn is in progress. */
  running: boolean;
  /** Approval the session is waiting for, if any. */
  pendingApprovalId?: string;
  /** Kept in memory only (the connection does not save history); gone when the host stops. */
  transient?: boolean;
  /** The conversation this session continues (another agent's session or a library entry). */
  continuedFrom?: { sourceId: string; title: string };
  /** External managed runtime of the session; absent for Extalia Native (then `connectionId` names the connection). */
  runtime?: { id: 'hermes'; profile: string; sessionId?: string };
  observation?: { sourceId: string; nativeSessionId: string; projectPath?: string; watching: boolean; status: 'watching' | 'paused' | 'unavailable'; lastCheckedAt?: string; error?: string };
}

/** A known native history location (Codex, Claude Code, Hermes profile, Gemini CLI, …). */
export interface ImportLocation {
  id: string;
  sourceId: string;
  label: string;
  path: string;
  format: string;
  profile?: string;
  available: boolean;
  /** False for formats Extalia detects but cannot read yet. */
  supported: boolean;
  note?: string;
}

export interface ImportCandidate {
  id: string;
  sourceId: string;
  locationId: string;
  sourceName: string;
  nativeSessionId: string;
  profile?: string;
  title: string;
  projectPath?: string;
  updatedAt: string;
  format: string;
  supported: boolean;
  note?: string;
}

export interface ImportDiagnostic {
  locationId?: string;
  candidateId?: string;
  message: string;
}

export interface ImportScan {
  /** Opaque id; previews and imports refer to candidates of this scan. Expires after 15 minutes. */
  scanId: string;
  sessions: ImportCandidate[];
  diagnostics: ImportDiagnostic[];
  truncated: boolean;
}

export interface ImportPreviewResult {
  sessions: { candidateId: string; session: PortableSession }[];
  /** What importing would do to the library. */
  plan: ImportPreview;
  diagnostics: ImportDiagnostic[];
}

/** An imported or linked conversation in the local library (content is loaded separately). */
export interface LibrarySessionSummary {
  id: string;
  title: string;
  sourceId: string;
  importMode: ImportMode;
  state: LocalState;
  workspaceName?: string;
  projectLocation?: string;
  messageCount: number;
  startedAt: string;
  lastMessageAt: string;
}

export type LibraryAction = 'rename' | 'archive' | 'restore' | 'trash' | 'delete';

export interface HostState {
  workflow?: 'managed' | 'observe';
  /** False until the user finished first-run setup. */
  setupComplete: boolean;
  profile: { id: string; name: string };
  connections: ConnectionView[];
  workspaces: Workspace[];
  sessions: SessionSummary[];
  /** Imported and linked conversations from other agents. */
  library: LibrarySessionSummary[];
  storage: { dataDirectory: string; secretStore: SecretStoreKind };
  host: { kind: 'desktop' | 'bridge'; version: string };
}

/** Input to create or update a connection. The host assigns credential references. */
export interface ConnectionInput {
  id?: string;
  name: string;
  preset: ProviderPresetId;
  api: ProviderApi;
  baseUrl: string;
  model: string;
  /** `stored` keeps the existing stored secret unless `secret` is provided. */
  credential: { kind: 'none' } | { kind: 'stored' } | Extract<CredentialSource, { kind: 'env' }>;
  features: { memory: FeatureOwner; skills: FeatureOwner; history?: boolean };
  effort?: Effort;
  /** Defaults to orchestration on with the preset's tier models. */
  orchestration?: Orchestration;
}

export interface ConnectionTestResult {
  ok: boolean;
  /** Models the endpoint reports, when it supports listing them. */
  models?: string[];
  error?: string;
  latencyMs?: number;
}

export interface WorkspaceInput {
  id?: string;
  name: string;
  projectLocation: string;
  /** Required for Extalia Native; ignored for Hermes Agent. */
  connectionId?: string;
  permissions: WorkspacePermissions;
  /** Defaults to Extalia Native. */
  runtimeId?: RuntimeId;
  /** Hermes profile; `default` when empty. */
  runtimeProfileId?: string;
  /** Optional model override for Hermes. */
  runtimeModel?: string;
}

/** A managed runtime and whether this host can run it. */
export interface RuntimeInfo {
  id: RuntimeId;
  available: boolean;
  /** Hermes profile names (`default` first); names only, nothing inside a profile is read. */
  profiles: string[];
}

export interface FolderCheck {
  ok: boolean;
  /** Absolute, normalized path. */
  path?: string;
  name?: string;
  error?: string;
}

/** One entry of a project-folder listing (Files view). Paths are relative to the project folder, `/`-separated. */
export interface FileEntry {
  name: string;
  path: string;
  kind: 'file' | 'dir' | 'symlink';
  /** Bytes; regular files only. */
  size?: number;
  /** What a symbolic link points to, only when the target stays inside the project folder. */
  target?: 'file' | 'dir';
  /** A conventional credential file or folder: listed, never readable. */
  credential?: boolean;
  /** A generated or vendored folder such as node_modules or dist. */
  generated?: boolean;
}

export interface FileListing {
  /** The listed folder; `.` for the project folder itself. */
  path: string;
  /** Folders first, then by name; `.git` is never listed. */
  entries: FileEntry[];
  /** The folder has more entries than the listing limit (1000). */
  truncated: boolean;
}

export interface FileContent {
  path: string;
  size: number;
  /** The file contains NUL bytes; no content is returned. */
  binary: boolean;
  /** UTF-8 text, at most 512 KB. */
  content?: string;
  /** Lines in `content`. */
  lines: number;
  truncated: boolean;
}

export type GitChangeKind = 'unmodified' | 'modified' | 'type-changed' | 'added' | 'deleted' | 'renamed' | 'copied' | 'unmerged';

export interface GitChange {
  /** Relative to the project folder; untracked folders end with `/`. */
  path: string;
  /** The previous path of a rename or copy, when inside the project folder. */
  originalPath?: string;
  /** Staged state. */
  index: GitChangeKind;
  /** Working-tree state. */
  worktree: GitChangeKind;
  untracked?: boolean;
  conflicted?: boolean;
  /** A credential file: listed, its diff is never shown. */
  credential?: boolean;
}

export type GitStatus =
  | { repository: false }
  | {
    repository: true;
    /** Undefined when HEAD is detached. */
    branch?: string;
    /** Abbreviated HEAD commit; undefined before the first commit. */
    commit?: string;
    upstream?: string;
    ahead: number;
    behind: number;
    changes: GitChange[];
    truncated: boolean;
  };

export interface GitDiff {
  /** The requested path; undefined for all changes. */
  path?: string;
  /** Unified diff of the working tree against HEAD (staged and unstaged); untracked files appear as additions. */
  diff: string;
  /** The diff was longer than 1 MB. */
  truncated: boolean;
}

/** A conversation to continue in a new managed session. */
export interface ContinueSource {
  kind: 'library' | 'observed';
  id: string;
}

/** `once` allows this call; `session` also allows the same kind of action for the rest of the session. */
export type ApprovalDecisionInput = 'once' | 'session' | 'reject';

export interface AgentHostApi {
  getState(): Promise<HostState>;
  saveConnection(input: ConnectionInput, secret?: string): Promise<HostState>;
  deleteConnection(id: string): Promise<HostState>;
  testConnection(input: ConnectionInput, secret?: string): Promise<ConnectionTestResult>;
  checkFolder(path: string): Promise<FolderCheck>;
  saveWorkspace(input: WorkspaceInput): Promise<HostState>;
  deleteWorkspace(id: string): Promise<HostState>;
  completeSetup(mode?: 'managed' | 'observe'): Promise<HostState>;
  setWorkflow(mode: 'managed' | 'observe'): Promise<HostState>;
  /** Selected native transcripts only; no credentials or agent configuration are read. */
  observeImports(scanId: string, candidateIds: string[]): Promise<HostState>;
  observationSession(id: string): Promise<PortableSession>;
  setObservation(id: string, watching: boolean): Promise<HostState>;
  createSession(workspaceId: string): Promise<SessionSummary>;
  /**
   * Start a managed session that continues another conversation (for example a
   * Codex session that ran out of quota). The recent conversation is carried
   * over as context; the source itself is not changed.
   */
  continueSession(source: ContinueSource, workspaceId: string): Promise<SessionSummary>;
  renameSession(sessionId: string, title: string): Promise<HostState>;
  deleteSession(sessionId: string): Promise<HostState>;
  sessionEvents(sessionId: string): Promise<ExtaliaEvent[]>;
  sendPrompt(sessionId: string, text: string): Promise<void>;
  resolveApproval(sessionId: string, approvalId: string, decision: ApprovalDecisionInput): Promise<void>;
  cancel(sessionId: string): Promise<void>;
  /** Native history locations Extalia knows how to look in. Nothing is read until a scan. */
  importLocations(): Promise<ImportLocation[]>;
  scanImports(locationIds?: string[]): Promise<ImportScan>;
  previewImports(scanId: string, candidateIds: string[], mode?: ImportMode): Promise<ImportPreviewResult>;
  commitImports(scanId: string, candidateIds: string[], mode?: ImportMode): Promise<HostState>;
  /** Import an Extalia portable session export (JSON text). */
  importPortable(json: string): Promise<{ plan: ImportPreview; state: HostState }>;
  librarySession(id: string): Promise<LibrarySession>;
  organizeLibrarySession(id: string, action: LibraryAction, title?: string): Promise<HostState>;
  /** One folder level of a workspace's project folder (read-only; `.git` hidden, credential files marked). */
  listFiles(workspaceId: string, dir?: string): Promise<FileListing>;
  /** A text file of a workspace's project folder, up to 512 KB. Credential files are refused. */
  readFile(workspaceId: string, path: string): Promise<FileContent>;
  /** Branch, upstream and changed files of the workspace's Git repository. Never runs repository hooks or filters. */
  gitStatus(workspaceId: string): Promise<GitStatus>;
  /** Unified diff against HEAD for one path or, without `path`, every change (credential files excluded). */
  gitDiff(workspaceId: string, path?: string): Promise<GitDiff>;
  /** Managed runtimes this host can drive (Hermes Agent when it is installed). */
  runtimes(): Promise<RuntimeInfo[]>;
  /** Saved Office character looks by presence id (`<sessionId>:<agentId>`); entries of deleted sessions are pruned. */
  characterAppearances(): Promise<CharacterAppearances>;
  /** Save one character's look, or reset it to the generated default with `null`. Returns every saved look. */
  saveCharacterAppearance(characterId: string, appearance: CharacterAppearance | null): Promise<CharacterAppearances>;
  /** Live protocol events for every session. Returns an unsubscribe function. */
  subscribe(listener: (event: ExtaliaEvent) => void): () => void;
}

/** Methods a transport may forward. `subscribe` is carried separately (IPC push or SSE). */
export const AGENT_HOST_METHODS = [
  'getState', 'saveConnection', 'deleteConnection', 'testConnection', 'checkFolder', 'saveWorkspace', 'deleteWorkspace',
  'completeSetup', 'createSession', 'continueSession', 'renameSession', 'deleteSession', 'sessionEvents', 'sendPrompt', 'resolveApproval', 'cancel',
  'setWorkflow', 'observeImports', 'observationSession', 'setObservation',
  'importLocations', 'scanImports', 'previewImports', 'commitImports', 'importPortable', 'librarySession', 'organizeLibrarySession',
  'listFiles', 'readFile', 'gitStatus', 'gitDiff',
  'runtimes', 'characterAppearances', 'saveCharacterAppearance',
] as const satisfies readonly Exclude<keyof AgentHostApi, 'subscribe'>[];

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

export function isAgentHostMethod(value: unknown): value is AgentHostMethod {
  return typeof value === 'string' && (AGENT_HOST_METHODS as readonly string[]).includes(value);
}

/** Error shape returned by transports; messages are safe to show to the user. */
export interface HostErrorPayload {
  error: string;
}
