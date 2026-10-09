import type {
  Connection, CredentialSource, Effort, FeatureOwner, ImportMode, ImportPreview, LibrarySession, LocalState, Orchestration,
  PortableSession, ProviderApi, ProviderPresetId, Workspace, WorkspacePermissions,
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
  features: { memory: FeatureOwner; skills: FeatureOwner };
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
  connectionId: string;
  permissions: WorkspacePermissions;
}

export interface FolderCheck {
  ok: boolean;
  /** Absolute, normalized path. */
  path?: string;
  name?: string;
  error?: string;
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
  /** Live protocol events for every session. Returns an unsubscribe function. */
  subscribe(listener: (event: ExtaliaEvent) => void): () => void;
}

/** Methods a transport may forward. `subscribe` is carried separately (IPC push or SSE). */
export const AGENT_HOST_METHODS = [
  'getState', 'saveConnection', 'deleteConnection', 'testConnection', 'checkFolder', 'saveWorkspace', 'deleteWorkspace',
  'completeSetup', 'createSession', 'renameSession', 'deleteSession', 'sessionEvents', 'sendPrompt', 'resolveApproval', 'cancel',
  'setWorkflow', 'observeImports', 'observationSession', 'setObservation',
  'importLocations', 'scanImports', 'previewImports', 'commitImports', 'importPortable', 'librarySession', 'organizeLibrarySession',
] as const satisfies readonly Exclude<keyof AgentHostApi, 'subscribe'>[];

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

export function isAgentHostMethod(value: unknown): value is AgentHostMethod {
  return typeof value === 'string' && (AGENT_HOST_METHODS as readonly string[]).includes(value);
}

/** Error shape returned by transports; messages are safe to show to the user. */
export interface HostErrorPayload {
  error: string;
}
