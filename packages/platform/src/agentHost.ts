import { EFFORTS, MAX_TEAM_GOAL, MAX_TEAM_MEMBERS, MEMBER_GENDERS, decodeAgentTeam } from '@extalia/core';
import type {
  AgentTeam, MemberAccess, MemberGender, TeamMember, TeamPlan, TeamPlanRequest, TeamSpec,
  CharacterAppearance, CharacterAppearances, Connection, CredentialSource, Effort, FeatureOwner, ImportMode, ImportPreview, LibrarySession, LocalState, Orchestration,
  PortableSession, ProviderApi, ProviderPresetId, RuntimeId, Workspace, WorkspacePermissions,
} from '@extalia/core';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { HostMissionRequest, HostMissionRun } from './missions.js';

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

/**
 * A per-session override of the model and reasoning effort. Absent fields use
 * the workspace's defaults (the connection's model and effort for Extalia
 * Native, the workspace's or profile's model for Hermes Agent).
 */
export interface SessionOptions {
  model?: string;
  effort?: Effort;
  /**
   * Subagent team of a new Extalia Native session (`createSession` only;
   * afterwards use `saveSessionTeam`). Never part of the stored model override.
   */
  team?: AgentTeam;
}

export type { AgentTeam, MemberAccess, MemberGender, TeamMember, TeamPlan, TeamPlanRequest, TeamSpec };

export function isMemberGender(value: unknown): value is MemberGender {
  return (MEMBER_GENDERS as readonly unknown[]).includes(value);
}

/** A stored or received agent identity: a single-line full name (up to 60 characters) and its gender, or nothing. */
export function normalizeAgentIdentity(name: unknown, gender: unknown): { agentName?: string; agentGender?: MemberGender } {
  if (typeof name !== 'string') return {};
  const clean = name.replace(/\s+/g, ' ').trim();
  if (!clean || clean.length > 60) return {};
  return { agentName: clean, ...(isMemberGender(gender) ? { agentGender: gender } : {}) };
}

/** Models and efforts a workspace's runtime can use, for the prompt's model and effort pickers. */
export interface ModelChoices {
  runtime: RuntimeId;
  /** The model a session uses without an override: the connection's model (Native) or the workspace's or profile's model (Hermes). */
  defaultModel?: string;
  /** Model ids the endpoint or Hermes profile lists; may be empty (any id can still be entered). */
  models: string[];
  /** Efforts the runtime honours; empty when it cannot change the reasoning effort. */
  efforts: Effort[];
  /** The connection's effort (Native). */
  defaultEffort?: Effort;
}

/** Model ids: up to 200 characters, starting with a letter or digit (never an option such as `--x`). */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,199}$/;

export function isModelId(value: unknown): value is string {
  return typeof value === 'string' && MODEL_ID_PATTERN.test(value);
}

/**
 * Validate session options from a client. Empty strings and `null` clear a
 * field; anything else invalid throws an error whose message is safe to show.
 */
export function normalizeSessionOptions(raw: unknown): SessionOptions {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid session options.');
  const value = raw as Record<string, unknown>;
  const options: SessionOptions = {};
  const model = typeof value.model === 'string' ? value.model.trim() : value.model;
  if (model !== undefined && model !== null && model !== '') {
    if (!isModelId(model)) throw new Error('Use a model id of up to 200 letters, digits and . _ : / @ + - characters.');
    options.model = model;
  }
  if (value.effort !== undefined && value.effort !== null && value.effort !== '') {
    if (!(EFFORTS as readonly unknown[]).includes(value.effort)) throw new Error(`Choose an effort: ${EFFORTS.join(', ')}.`);
    options.effort = value.effort as Effort;
  }
  if (value.team !== undefined && value.team !== null) options.team = normalizeAgentTeam(value.team)!;
  return options;
}

/** Validate a team from a client; `null` (remove) stays `null`. Errors are safe to show. */
export function normalizeAgentTeam(raw: unknown): AgentTeam | null {
  if (raw === null) return null;
  const decoded = decodeAgentTeam(raw);
  if (!decoded.ok) throw new Error(`This team cannot be saved: ${decoded.errors.join(' ')}`);
  return decoded.value;
}

/**
 * Validate a `planTeam` request from a client. The goal and the allowed models are optional
 * (the host then plans a general team and lets the plan choose models); `candidateModels`
 * and `context` are the host's to fill and are dropped. Errors are safe to show.
 */
export function normalizeTeamPlanRequest(raw: unknown): TeamPlanRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid team request.');
  const value = raw as Record<string, unknown>;
  if (value.goal !== undefined && value.goal !== null && typeof value.goal !== 'string') throw new Error('The goal must be text.');
  const goal = typeof value.goal === 'string' ? value.goal.trim() : '';
  if (goal.length > MAX_TEAM_GOAL) throw new Error(`The goal is longer than ${MAX_TEAM_GOAL} characters.`);
  const count = value.count;
  if (typeof count !== 'number' || !Number.isInteger(count) || count < 1 || count > MAX_TEAM_MEMBERS) throw new Error(`Choose from 1 to ${MAX_TEAM_MEMBERS} members.`);
  // The team decoder checks the models and the current members' ids and names. A re-plan reassigns
  // models, so current members may still name models that are no longer allowed: those are dropped.
  const members = Array.isArray(value.members)
    ? value.members.map(member => (member && typeof member === 'object' && !Array.isArray(member) ? { ...member as Record<string, unknown>, models: [] } : member))
    : value.members ?? [];
  const team = normalizeAgentTeam({ enabled: true, allowedModels: value.allowedModels ?? [], members })!;
  return { goal, count, allowedModels: team.allowedModels, ...(team.members.length ? { members: team.members } : {}) };
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
  /** The session's model and effort override, used by its next turns; absent fields use the defaults. */
  options?: SessionOptions;
  /** The session's subagent team, when it has one (`getSessionTeam` returns the full team). */
  team?: { enabled: boolean; size: number };
  /**
   * The lead agent's full name, unique across the Office; assigned once when a managed session
   * is created (older sessions get one on first load) and kept. Avatars are generated from it.
   */
  agentName?: string;
  /** The lead's gender (explicit metadata for the avatar, never inferred from the name). */
  agentGender?: MemberGender;
  /** Observed sessions: the lead agent's latest model, as its source states it. */
  model?: string;
  observation?: {
    sourceId: string; nativeSessionId: string; projectPath?: string; watching: boolean; status: 'watching' | 'paused' | 'unavailable'; lastCheckedAt?: string; error?: string;
    /** Time of the latest event read from the transcript. */
    lastEventAt?: string;
    /** Added by automatic discovery ("watch new sessions automatically"); retired to history when it falls out of the live LRU. */
    auto?: boolean;
    /** The agent app reports this session live through its hooks (`extalia connect`); otherwise only its transcript is read. */
    hook?: boolean;
    /** How the session's newest events arrive: agent-app hooks, its transcript file, or the Hermes dashboard. */
    channel?: 'hook' | 'transcript' | 'dashboard';
  };
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
  /** New sessions in this location are observed automatically (opt-in). */
  autoWatch?: boolean;
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
  /** Its project folder is in the ignored folders (`HookIngestStatus.ignoreFolders`); the Observe list leaves it out. */
  ignored?: boolean;
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

/** The welcome setup a host config must have completed; older configs run it once more (data kept). */
export const SETUP_VERSION = 2;

/** Theme values; the Web client's preference list (`apps/web/src/preferences.ts`) is the source of these. */
export type ProfileTheme = 'system' | 'solar' | 'light' | 'dark';

/**
 * Interface preferences shared by every client of this computer's Extalia profile.
 * Values other than `language` are short identifiers (`[a-z0-9-]`, up to 40
 * characters); each client ignores values it does not know.
 */
export interface ProfilePreferences {
  language?: 'en' | 'id';
  theme?: string;
  material?: string;
  font?: string;
  sidebar?: string;
}

/** `<dataDirectory>/config/profile.json`: who uses Extalia here and how the interface looks. */
export interface UserProfile {
  schema: 'extalia.profile.v1';
  displayName?: string;
  preferences: ProfilePreferences;
  /** ISO time of the last save; the Unix epoch when the profile was never saved. */
  updatedAt: string;
}

/** A partial update: given fields replace stored ones, `null` (or an empty name) removes them. */
export interface UserProfilePatch {
  displayName?: string | null;
  preferences?: { [K in keyof ProfilePreferences]?: ProfilePreferences[K] | null };
}

export interface HostState {
  workflow?: 'managed' | 'observe';
  /** False until the user finished the current welcome setup (`SETUP_VERSION`). */
  setupComplete: boolean;
  /** The Extalia profile folder (`~/.extalia-vo` unless EXTALIA_HOME overrides it). */
  dataDirectory: string;
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
  /** Additional saved connections permitted for native missions. Omission preserves an existing policy. */
  missionConnectionIds?: string[];
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

/** What a Hermes profile is set to use, read from its `config.yaml` (secrets are never returned). */
export interface HermesModelCatalog {
  profile: string;
  /** `model.default` of the profile, used when a workspace leaves the model empty. */
  defaultModel?: string;
  /** `model.provider`, e.g. `custom`, `openrouter`, `anthropic`. */
  provider?: string;
  /** `host:port` of a local OpenAI-compatible endpoint the catalog was read from (e.g. 9Router). */
  endpoint?: string;
  /** Model ids the profile's local endpoint offers (`GET <base_url>/models`); empty when it was not asked. */
  models: string[];
  /** `endpoint`: listed by the local endpoint; `config`: only the configured default (remote providers are never queried). */
  source: 'endpoint' | 'config' | 'none';
  /** Why the list could not be read, for a hint next to the field. */
  error?: string;
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

/** An agent application Extalia can connect to through hooks. */
export type AgentAppId = 'codex' | 'claude' | 'gemini' | 'hermes';

export const AGENT_APP_IDS: readonly AgentAppId[] = ['codex', 'claude', 'gemini', 'hermes'];

/** Where agent-app hooks reach this host. The ingest token itself is never returned. */
export interface HookIngestStatus {
  /** Loopback port serving `POST /api/hooks/<app>`; undefined while no listener is up. */
  port?: number;
  /** File holding the ingest token (`EXTALIA_HOME/hooks/token`). */
  tokenPath: string;
  /** Time of the latest accepted hook event per app since this host started. */
  lastEvents: Record<AgentAppId, string | undefined>;
  /** When true, prompt text, assistant replies and tool output from outside apps are dropped. */
  labelsOnly?: boolean;
  /** Optional local Hermes dashboard URL (`http://127.0.0.1:9119`) used as a read-only session source. */
  hermesDashboardUrl?: string;
  /**
   * Folders whose sessions are never observed automatically (auto-watch, hooks) and are marked
   * `ignored` in history scans; `~` is the home folder. Defaults to `defaultIgnoreFolders`.
   */
  ignoreFolders?: string[];
  /** The built-in default list (`~/.claude-mem`, helper sessions of the claude-mem plugin). */
  defaultIgnoreFolders?: string[];
}

export interface HookPrivacyOptions {
  /** Drop prompt text, assistant reply text and tool output from outside apps, keeping only activity labels. */
  labelsOnly?: boolean;
  /** Local Hermes dashboard URL (`http://127.0.0.1:9119`), or `null`/`""` to clear it. */
  hermesDashboardUrl?: string | null;
  /**
   * Replace the ignored folders (absolute, or starting with `~`; at most 50); `null` restores the
   * default. Automatic observations inside them are retired.
   */
  ignoreFolders?: string[] | null;
}

/** Codex hook trust: hooks stay inert until reviewed (Codex `/hooks`) or trusted with explicit consent. */
export type AgentAppTrustStatus = 'trusted' | 'untrusted' | 'modified' | 'unknown' | 'not-applicable';

/** What `connections` knows about one agent app. Nothing here contains a secret. */
export interface AgentAppConnection {
  app: AgentAppId;
  label: string;
  /** False for apps whose hooks arrive in a later phase (Gemini CLI, Hermes). */
  supported: boolean;
  /** A binary on PATH or an existing configuration directory was found. */
  installed: boolean;
  /** `codex --version` / `claude --version`, when the binary is available. */
  version?: string;
  /** The version is one Extalia verified the hooks against. */
  versionVerified?: boolean;
  /** The user-level file Extalia would edit. */
  configPath?: string;
  /** All Extalia entries are present and match the current endpoint and token. */
  connected: boolean;
  /** Some Extalia entries exist but are incomplete or outdated (port, token, Node path); connect again to repair. */
  state: 'not-connected' | 'connected' | 'partial' | 'stale';
  trust: { status: AgentAppTrustStatus; trusted: number; total: number };
  /** Plain-English cautions: unverified version, hooks disabled by policy, missing forwarder, stale token. */
  warnings: string[];
  /** Hook event names Extalia entries cover. */
  events: string[];
  /** ISO time of the latest hook event received from this app, when a host reports it. */
  lastEventAt?: string;
  /** A host is listening for hook events on this computer. */
  hostRunning: boolean;
  /** Port hooks will use (from the running host, or the default). */
  port: number;
}

export interface AgentAppConnectPlan {
  app: AgentAppId;
  supported: boolean;
  installed: boolean;
  version?: string;
  versionVerified?: boolean;
  configPath?: string;
  /** False when connecting would not change anything (already connected). */
  changes: boolean;
  /** Readable unified diff of the user-level config file (tokens are masked); empty when nothing changes. */
  diff: string;
  /** Hook events that will be added or updated. */
  events: string[];
  /** New Codex hooks need approval before they run. */
  needsTrust: boolean;
  /** What to tell the user about approving hooks. */
  trustHint?: string;
  warnings: string[];
  /** Where the original file will be backed up. */
  backupRoot: string;
  forwarderPath: string;
  port: number;
  /** Shown to the user after applying. */
  restartHint: string;
}

export interface AgentAppConnectOptions {
  /** Port of the host's hook endpoint (default: the running host, else 4317). */
  port?: number;
  /** Replace the ingest token. Claude Code hooks must be connected again afterwards. */
  rotate?: boolean;
  /** Codex only: also mark the new hooks as trusted (separate explicit consent in the UI). */
  trust?: boolean;
}

export interface AgentAppConnectResult {
  app: AgentAppId;
  /** False when everything was already in place. */
  changed: boolean;
  configPath: string;
  /** Directory holding the backup of the previous file; absent when nothing was written or no file existed. */
  backupPath?: string;
  /** Run this to remove exactly what was added. */
  undoCommand: string;
  trust: { status: AgentAppTrustStatus; trusted: number; total: number };
  test: AgentAppTestResult;
  restartHint: string;
  warnings: string[];
}

export interface AgentAppDisconnectResult {
  app: AgentAppId;
  /** False when there was nothing to remove. */
  changed: boolean;
  configPath?: string;
  /** The file was restored byte for byte from the backup (no other edits since connecting). */
  restoredExactly: boolean;
  /** Entries and trust records removed. */
  removed: number;
  warnings: string[];
}

export interface AgentAppTestResult {
  ok: boolean;
  /** `host-down` means no host is listening; `rejected` means the token or endpoint refused the event. */
  status: 'delivered' | 'host-down' | 'rejected' | 'skipped';
  message: string;
}

/** `once` allows this call; `session` also allows the same kind of action for the rest of the session. */
export type ApprovalDecisionInput = 'once' | 'session' | 'reject';

export interface AgentHostApi {
  getState(): Promise<HostState>;
  /** The shared user profile (display name and interface preferences). */
  getProfile(): Promise<UserProfile>;
  /** Merge, validate and save profile changes (written atomically, mode 0600). Returns the saved profile. */
  saveProfile(patch: UserProfilePatch): Promise<UserProfile>;
  saveConnection(input: ConnectionInput, secret?: string): Promise<HostState>;
  deleteConnection(id: string): Promise<HostState>;
  testConnection(input: ConnectionInput, secret?: string): Promise<ConnectionTestResult>;
  checkFolder(path: string): Promise<FolderCheck>;
  saveWorkspace(input: WorkspaceInput): Promise<HostState>;
  /** Explicitly permit additional saved model connections for this workspace's native missions. */
  setWorkspaceMissionConnections(workspaceId: string, connectionIds: string[]): Promise<HostState>;
  deleteWorkspace(id: string): Promise<HostState>;
  completeSetup(mode?: 'managed' | 'observe'): Promise<HostState>;
  setWorkflow(mode: 'managed' | 'observe'): Promise<HostState>;
  /** Selected native transcripts only; no credentials or agent configuration are read. */
  observeImports(scanId: string, candidateIds: string[]): Promise<HostState>;
  observationSession(id: string): Promise<PortableSession>;
  setObservation(id: string, watching: boolean): Promise<HostState>;
  /**
   * Opt a history location in or out of "watch new sessions automatically": the host
   * then adds recently active sessions of that location as observations (metadata
   * polling, read-only). Returns the locations with their updated `autoWatch`.
   */
  setAutoWatch(locationId: string, enabled: boolean): Promise<ImportLocation[]>;
  /** Start a managed session, optionally with its own model and effort (see `modelChoices`). */
  createSession(workspaceId: string, options?: SessionOptions): Promise<SessionSummary>;
  /** Replace a managed session's model and effort override for its next turns; empty fields go back to the defaults. */
  setSessionOptions(sessionId: string, options: SessionOptions): Promise<SessionSummary>;
  /** Models and efforts a workspace's runtime can use. Credentials are never returned. */
  modelChoices(workspaceId: string): Promise<ModelChoices>;
  /** A managed session's subagent team, if it has one. */
  getSessionTeam(sessionId: string): Promise<AgentTeam | undefined>;
  /**
   * Save (validated) or remove (`null`) a managed session's team; it applies from the next turn.
   * Hermes Agent sessions keep it too: Hermes delegates with its own tool, all members on one model.
   */
  saveSessionTeam(sessionId: string, team: AgentTeam | null): Promise<AgentTeam | undefined>;
  /**
   * Propose members for a goal (or, without one, a general team for the workspace): the
   * workspace's model splits the work (`source: 'model'`; Hermes: the profile's endpoint when it
   * runs on this computer), or a deterministic plan is used (`'heuristic'`, with a `note`).
   * Without allowed models the plan picks from the workspace's models and returns them as `allowedModels`.
   */
  planTeam(workspaceId: string, request: TeamPlanRequest): Promise<TeamPlan>;
  /**
   * Start a managed session that continues another conversation (for example a
   * Codex session that ran out of quota). The recent conversation is carried
   * over as context; the source itself is not changed.
   */
  continueSession(source: ContinueSource, workspaceId: string): Promise<SessionSummary>;
  renameSession(sessionId: string, title: string): Promise<HostState>;
  deleteSession(sessionId: string): Promise<HostState>;
  sessionEvents(sessionId: string): Promise<ExtaliaEvent[]>;
  /** Start a fixed, read-only native task graph; returns before model execution finishes. */
  startNativeMission(sessionId: string, request: HostMissionRequest): Promise<HostMissionRun>;
  /** Read mission status and bounded, unverified answers. Cancel through the session's `cancel` method. */
  nativeMissionRun(sessionId: string, missionId: string): Promise<HostMissionRun>;
  /** Retained mission summaries for this session, respecting its history policy. */
  listNativeMissions(sessionId: string): Promise<HostMissionRun[]>;
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
  /** The default model of a Hermes profile and, when it uses a local endpoint such as 9Router, the models that endpoint lists. */
  hermesModels(profile: string): Promise<HermesModelCatalog>;
  /** Saved Office character looks by presence id (`<sessionId>:<agentId>`); entries of deleted sessions are pruned. */
  characterAppearances(): Promise<CharacterAppearances>;
  /** Save one character's look, or reset it to the generated default with `null`. Returns every saved look. */
  saveCharacterAppearance(characterId: string, appearance: CharacterAppearance | null): Promise<CharacterAppearances>;
  /** Agent apps (Codex, Claude Code, …): installed, version, hook state, trust. Reads configuration only. */
  agentAppConnections(): Promise<AgentAppConnection[]>;
  /** What connecting an app would change (diff, events, trust). Writes nothing. */
  planAgentAppConnect(app: AgentAppId, options?: AgentAppConnectOptions): Promise<AgentAppConnectPlan>;
  /** Back up, then add marked hooks to the app's user-level configuration. The caller has shown the plan and got approval. */
  applyAgentAppConnect(app: AgentAppId, options?: AgentAppConnectOptions): Promise<AgentAppConnectResult>;
  /** Remove only the entries Extalia added (and the Codex trust records it wrote). */
  disconnectAgentApp(app: AgentAppId): Promise<AgentAppDisconnectResult>;
  /** Send a synthetic hook event to the host's endpoint to check the token and port. */
  testAgentAppConnection(app: AgentAppId): Promise<AgentAppTestResult>;
  /** Hook ingest endpoint status for "Connect agent apps" (port, token file, last event per app). */
  hookIngest(): Promise<HookIngestStatus>;
  /** Update outside-agent privacy ("labels only") and the optional local Hermes dashboard read URL. */
  setHookPrivacy(options: HookPrivacyOptions): Promise<HookIngestStatus>;
  /** Live protocol events for every session. Returns an unsubscribe function. */
  subscribe(listener: (event: ExtaliaEvent) => void): () => void;
}

/** Methods a transport may forward. `subscribe` is carried separately (IPC push or SSE). */
export const AGENT_HOST_METHODS = [
  'getState', 'getProfile', 'saveProfile', 'saveConnection', 'deleteConnection', 'testConnection', 'checkFolder', 'saveWorkspace', 'deleteWorkspace',
  'setWorkspaceMissionConnections', 'startNativeMission', 'nativeMissionRun', 'listNativeMissions',
  'completeSetup', 'createSession', 'setSessionOptions', 'modelChoices', 'getSessionTeam', 'saveSessionTeam', 'planTeam', 'continueSession', 'renameSession', 'deleteSession', 'sessionEvents', 'sendPrompt', 'resolveApproval', 'cancel',
  'setWorkflow', 'observeImports', 'observationSession', 'setObservation', 'setAutoWatch',
  'importLocations', 'scanImports', 'previewImports', 'commitImports', 'importPortable', 'librarySession', 'organizeLibrarySession',
  'listFiles', 'readFile', 'gitStatus', 'gitDiff',
  'runtimes', 'hermesModels', 'characterAppearances', 'saveCharacterAppearance', 'hookIngest', 'setHookPrivacy',
  'agentAppConnections', 'planAgentAppConnect', 'applyAgentAppConnect', 'disconnectAgentApp', 'testAgentAppConnection',
] as const satisfies readonly Exclude<keyof AgentHostApi, 'subscribe'>[];

export type AgentHostMethod = (typeof AGENT_HOST_METHODS)[number];

export function isAgentHostMethod(value: unknown): value is AgentHostMethod {
  return typeof value === 'string' && (AGENT_HOST_METHODS as readonly string[]).includes(value);
}

/** Error shape returned by transports; messages are safe to show to the user. */
export interface HostErrorPayload {
  error: string;
}
