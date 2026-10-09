import {
  DEFAULT_PERMISSIONS, applyImport, decodeConnection, decodeLibrary, decodeWorkspace, defaultOrchestration, deleteSession as deleteLibrarySession,
  displayTitle, emptyLibrary, presetById, previewImport, renameSession as renameLibrarySession, resolveFeatures, setSessionState, tierModel,
  type Connection, type SessionLibrary, type TaskTier, type Workspace,
} from '@extalia/core';
import {
  resolveDataDirectory,
  type AgentHostApi, type ApprovalDecisionInput, type ConnectionInput, type ConnectionTestResult, type ConnectionView,
  type FolderCheck, type HostState, type LibrarySessionSummary, type SessionSummary, type WorkspaceInput,
} from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import {
  ProviderError, buildSystemPrompt, createDelegationTool, createProvider, runTurn,
  type AnyTool, type ApprovalOutcome, type ModelMessage, type ModelProvider, type ToolAccess,
} from '@extalia/runtime';
import { randomBytes } from 'node:crypto';
import { readFile, realpath, rename, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { readJson, writeJsonAtomic } from './jsonStore.js';
import { acquireHostLock } from './lock.js';
import { MemoryStore, createMemoryTools } from './memory.js';
import { NativeImportService } from './nativeImport.js';
import { Observations } from './observations.js';
import { dataLayout, ensureLayout } from './paths.js';
import { createSecretStore, resolveCredential, type SecretStore } from './secrets.js';
import { SessionStore, newSessionId } from './sessions.js';
import { createSkillTools, loadSkills } from './skills.js';
import { createCommandTool } from './tools/command.js';
import { createFileTools } from './tools/files.js';

export interface AgentHostOptions {
  /** Test harness only; normal hosts poll selected transcripts every four seconds. */
  observationIntervalMs?: number;
  kind: 'desktop' | 'bridge';
  version: string;
  /** Defaults to the platform data directory (EXTALIA_HOME overrides). */
  dataDirectory?: string;
  env?: Readonly<Record<string, string | undefined>>;
  /** Home directory whose agent histories can be imported; defaults to the user's home. */
  importHome?: string;
  /** Injected for tests; defaults to global fetch. */
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface AgentHostRuntime {
  host: AgentHostApi;
  /** True while any session has a turn in progress (updates wait for this). */
  isBusy(): boolean;
  /** Called whenever the last running turn ends. Returns an unsubscribe function. */
  onIdle(listener: () => void): () => void;
  close(): Promise<void>;
}

interface HostConfig {
  workflow?: 'managed' | 'observe';
  schema: 'extalia.host-config.v1';
  setupComplete: boolean;
  profile: { id: string; name: string };
  connections: Connection[];
  workspaces: Workspace[];
}

interface Run {
  controller: AbortController;
  pending?: { approvalId: string; resolve(outcome: ApprovalOutcome): void };
  done: Promise<void>;
}

const INSTRUCTION_FILES = ['AGENTS.md', 'CLAUDE.md'];
const NEW_SESSION_TITLE = 'New session';
const ADAPTER = { runtime: 'extalia-native', channel: 'stream' as const, adapter: 'extalia-native' };

const newId = (prefix: string) => `${prefix}_${Date.now().toString(36)}${randomBytes(4).toString('hex')}`;
const now = () => new Date().toISOString();

function userError(message: string): Error {
  const error = new Error(message);
  error.name = 'UserError';
  return error;
}

function emptyConfig(): HostConfig {
  return { schema: 'extalia.host-config.v1', setupComplete: false, profile: { id: 'default', name: 'Personal' }, connections: [], workspaces: [] };
}

/** Load the stored configuration, keeping every valid entry and dropping invalid ones. */
function decodeConfig(raw: Partial<HostConfig> | undefined): HostConfig {
  const config = emptyConfig();
  if (!raw || typeof raw !== 'object') return config;
  config.setupComplete = raw.setupComplete === true;
  config.workflow = raw.workflow === 'observe' ? 'observe' : 'managed';
  if (raw.profile && typeof raw.profile.name === 'string') config.profile = { id: String(raw.profile.id || 'default'), name: raw.profile.name };
  for (const item of raw.connections ?? []) { const result = decodeConnection(item); if (result.ok) config.connections.push(result.value); }
  for (const item of raw.workspaces ?? []) { const result = decodeWorkspace(item); if (result.ok) config.workspaces.push(result.value); }
  return config;
}

/** Load the imported-session library; a damaged file is kept aside, never overwritten. */
async function loadLibrary(file: string): Promise<SessionLibrary> {
  let raw: unknown;
  try { raw = await readJson<unknown>(file, undefined); } catch { raw = null; }
  if (raw === undefined) return emptyLibrary();
  const decoded = decodeLibrary(raw);
  if (decoded.ok) return decoded.value;
  await rename(file, file.replace(/\.json$/, `.damaged-${Date.now()}.json`)).catch(() => undefined);
  return emptyLibrary();
}

function toModelHistory(raw: unknown[]): ModelMessage[] {
  return raw.filter((item): item is ModelMessage => Boolean(item) && typeof item === 'object' && ['user', 'assistant', 'tool'].includes((item as { role?: string }).role ?? ''));
}

export async function createAgentHost(options: AgentHostOptions): Promise<AgentHostRuntime> {
  const env = options.env ?? process.env;
  const dataDirectory = options.dataDirectory ?? resolveDataDirectory({ platform: process.platform, env, homeDirectory: homedir() });
  const layout = dataLayout(dataDirectory);
  await ensureLayout(layout);
  const lock = await acquireHostLock(layout.state, options.kind);
  const configFile = path.join(layout.config, 'extalia.json');
  let config = decodeConfig(await readJson<Partial<HostConfig> | undefined>(configFile, undefined));
  const secrets: SecretStore = await createSecretStore({ stateDirectory: layout.state, platform: process.platform, env });
  const sessions = new SessionStore(layout.sessions);
  const nativeImport = await NativeImportService.create({ homeDirectory: options.importHome ?? homedir(), env });
  const libraryFile = path.join(layout.state, 'library.json');
  let library = await loadLibrary(libraryFile);
  const saveLibrary = async () => writeJsonAtomic(libraryFile, library, { mode: 0o600 });
  const listeners = new Set<(event: ExtaliaEvent) => void>();
  const idleListeners = new Set<() => void>();
  const runs = new Map<string, Run>();
  const grants = new Map<string, Set<ToolAccess>>();
  const sequence = new Map<string, number>();
  const credentialStatus = new Map<string, ConnectionView['credentialStatus']>();
  const observations = await Observations.create(layout.state, nativeImport, event => {
    for (const listener of listeners) { try { listener(event); } catch { /* disconnected UI */ } }
  }, options.observationIntervalMs);

  const save = async () => writeJsonAtomic(configFile, config, { mode: 0o600 });

  async function secretFor(connection: Connection): Promise<string | undefined> {
    return resolveCredential(connection.credential, secrets, env);
  }

  async function refreshCredentialStatus(connection: Connection): Promise<void> {
    if (connection.credential.kind === 'none') { credentialStatus.set(connection.id, 'not-needed'); return; }
    let secret: string | undefined;
    try { secret = await secretFor(connection); } catch { secret = undefined; }
    credentialStatus.set(connection.id, secret ? 'ok' : 'missing');
  }
  await Promise.all(config.connections.map(refreshCredentialStatus));

  async function nextSeq(sessionId: string): Promise<number> {
    if (!sequence.has(sessionId)) sequence.set(sessionId, (await sessions.readEvents(sessionId)).length);
    const value = sequence.get(sessionId)!;
    sequence.set(sessionId, value + 1);
    return value;
  }

  /** Persist and broadcast one event. Writes are chained per session to keep order. */
  const writeChains = new Map<string, Promise<void>>();
  function publish(sessionId: string, body: EventBody, agentId = 'primary'): void {
    const previous = writeChains.get(sessionId) ?? Promise.resolve();
    const next = previous.then(async () => {
      const seq = await nextSeq(sessionId);
      const event = createEvent({ sessionId, seq, agentId, source: { ...ADAPTER, adapterVersion: options.version }, body });
      await sessions.appendEvent(sessionId, event);
      for (const listener of listeners) { try { listener(event); } catch { /* a failing listener must not stop the run */ } }
    }).catch(() => undefined);
    writeChains.set(sessionId, next);
  }

  function summary(record: { id: string; workspaceId: string; connectionId: string; title: string; createdAt: string; lastActiveAt: string }): SessionSummary {
    const run = runs.get(record.id);
    return { ...record, control: 'managed', running: Boolean(run), ...(run?.pending ? { pendingApprovalId: run.pending.approvalId } : {}) };
  }

  function librarySummaries(): LibrarySessionSummary[] {
    return library.sessions.map(session => ({
      id: session.id, title: displayTitle(session), sourceId: session.provenance.sourceId, importMode: session.importMode, state: session.local.state,
      messageCount: session.messages.length, startedAt: session.startedAt, lastMessageAt: session.lastMessageAt,
      ...(session.workspace?.name ? { workspaceName: session.workspace.name } : {}),
      ...(session.workspace?.projectLocation ? { projectLocation: session.workspace.projectLocation } : {}),
    })).sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
  }

  async function state(): Promise<HostState> {
    return {
      workflow: config.workflow ?? 'managed',
      setupComplete: config.setupComplete,
      profile: config.profile,
      connections: config.connections.map(connection => ({ ...connection, credentialStatus: credentialStatus.get(connection.id) ?? 'missing' })),
      workspaces: config.workspaces,
      sessions: [...(await sessions.list()).map(summary), ...observations.summaries()].sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt)),
      library: librarySummaries(),
      storage: { dataDirectory, secretStore: secrets.kind },
      host: { kind: options.kind, version: options.version },
    };
  }

  function findConnection(id: string): Connection {
    const connection = config.connections.find(item => item.id === id);
    if (!connection) throw userError('That connection no longer exists.');
    return connection;
  }

  function findWorkspace(id: string): Workspace {
    const workspace = config.workspaces.find(item => item.id === id);
    if (!workspace) throw userError('That workspace no longer exists.');
    return workspace;
  }

  /** Build a connection from user input without touching stored secrets. */
  function draftConnection(input: ConnectionInput, existing?: Connection): Connection {
    const id = existing?.id ?? input.id ?? newId('c');
    const credential = input.credential.kind === 'stored'
      ? { kind: 'stored' as const, ref: existing?.credential.kind === 'stored' ? existing.credential.ref : `connection-${id}` }
      : input.credential;
    const stamp = now();
    const result = decodeConnection({
      id, name: input.name, preset: input.preset, api: input.api, baseUrl: input.baseUrl, model: input.model,
      credential, features: input.features, ...(input.effort ? { effort: input.effort } : {}),
      orchestration: input.orchestration ?? existing?.orchestration ?? defaultOrchestration(input.preset),
      createdAt: existing?.createdAt ?? stamp, updatedAt: stamp,
    });
    if (!result.ok) throw userError(result.errors.join(' '));
    return result.value;
  }

  async function providerFor(connection: Connection, secretOverride?: string): Promise<{ provider: ModelProvider; secret: string | undefined }> {
    const secret = secretOverride?.trim() || await secretFor(connection);
    if (!secret && presetById(connection.preset).apiKey === 'required') throw userError(`Add the API key for "${connection.name}" in Settings.`);
    return { provider: createProvider(connection, secret, options.fetch), secret };
  }

  async function checkFolder(requested: string): Promise<FolderCheck> {
    const raw = requested.trim();
    if (!raw) return { ok: false, error: 'Enter the project folder.' };
    const expanded = raw === '~' ? homedir() : raw.startsWith('~/') || raw.startsWith('~\\') ? path.join(homedir(), raw.slice(2)) : raw;
    if (!path.isAbsolute(expanded)) return { ok: false, error: 'Use a full path, for example /Users/<name>/projects/site.' };
    try {
      const resolved = await realpath(expanded);
      if (!(await stat(resolved)).isDirectory()) return { ok: false, error: 'That path is not a folder.' };
      if (path.parse(resolved).root === resolved) return { ok: false, error: 'Choose a project folder, not the whole disk.' };
      return { ok: true, path: resolved, name: path.basename(resolved) };
    } catch {
      return { ok: false, error: 'That folder does not exist or cannot be read.' };
    }
  }

  async function projectInstructions(root: string): Promise<{ file: string; text: string }[]> {
    const found: { file: string; text: string }[] = [];
    for (const file of INSTRUCTION_FILES) {
      try { found.push({ file, text: await readFile(path.join(root, file), 'utf8') }); } catch { /* optional */ }
    }
    return found;
  }

  function finishRun(sessionId: string): void {
    runs.delete(sessionId);
    if (!runs.size) for (const listener of idleListeners) { try { listener(); } catch { /* ignore */ } }
  }

  const host: AgentHostApi = {
    getState: state,

    async saveConnection(input, secret) {
      const existing = input.id ? config.connections.find(item => item.id === input.id) : undefined;
      const connection = draftConnection(input, existing);
      const trimmed = secret?.trim();
      if (connection.credential.kind === 'stored') {
        if (trimmed) await secrets.set(connection.credential.ref, trimmed);
        else if (!(await secrets.get(connection.credential.ref)) && presetById(connection.preset).apiKey === 'required') throw userError('Enter the API key for this connection.');
      }
      if (existing?.credential.kind === 'stored' && connection.credential.kind !== 'stored') await secrets.delete(existing.credential.ref).catch(() => undefined);
      config = { ...config, connections: existing ? config.connections.map(item => item.id === connection.id ? connection : item) : [...config.connections, connection] };
      await save();
      await refreshCredentialStatus(connection);
      return state();
    },

    async deleteConnection(id) {
      const connection = findConnection(id);
      const user = config.workspaces.find(workspace => workspace.providerProfileId === id);
      if (user) throw userError(`The workspace "${user.name}" uses this connection. Choose another connection for it first.`);
      if (connection.credential.kind === 'stored') await secrets.delete(connection.credential.ref).catch(() => undefined);
      config = { ...config, connections: config.connections.filter(item => item.id !== id) };
      credentialStatus.delete(id);
      await save();
      return state();
    },

    async testConnection(input, secret): Promise<ConnectionTestResult> {
      const existing = input.id ? config.connections.find(item => item.id === input.id) : undefined;
      const started = Date.now();
      try {
        const connection = draftConnection(input, existing);
        const { provider } = await providerFor(connection, secret);
        try {
          const models = await provider.listModels(AbortSignal.timeout(15_000));
          return { ok: true, models, latencyMs: Date.now() - started };
        } catch (error) {
          // Some endpoints cannot list models; a one-word request proves the connection instead.
          if (!(error instanceof ProviderError) || ![404, 405, 501].includes(error.status ?? 0)) throw error;
          await provider.complete({ system: 'Reply with OK.', messages: [{ role: 'user', text: 'OK?' }], tools: [], signal: AbortSignal.timeout(30_000) });
          return { ok: true, latencyMs: Date.now() - started };
        }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : 'The connection test failed.', latencyMs: Date.now() - started };
      }
    },

    checkFolder,

    async saveWorkspace(input: WorkspaceInput) {
      const folder = await checkFolder(input.projectLocation);
      if (!folder.ok || !folder.path) throw userError(folder.error ?? 'Choose a project folder.');
      findConnection(input.connectionId);
      const existing = input.id ? config.workspaces.find(item => item.id === input.id) : undefined;
      const stamp = now();
      const result = decodeWorkspace({
        id: existing?.id ?? newId('w'), profileId: config.profile.id, name: input.name, projectLocation: folder.path,
        providerProfileId: input.connectionId, permissions: input.permissions ?? DEFAULT_PERMISSIONS,
        createdAt: existing?.createdAt ?? stamp, updatedAt: stamp,
      });
      if (!result.ok) throw userError(result.errors.join(' '));
      config = { ...config, workspaces: existing ? config.workspaces.map(item => item.id === result.value.id ? result.value : item) : [...config.workspaces, result.value] };
      await save();
      return state();
    },

    async deleteWorkspace(id) {
      findWorkspace(id);
      const owned = (await sessions.list()).filter(record => record.workspaceId === id);
      if (owned.some(record => runs.has(record.id))) throw userError('Stop the running session in this workspace first.');
      for (const record of owned) await sessions.remove(record.id);
      await rm(path.join(layout.workspaces, id), { recursive: true, force: true });
      config = { ...config, workspaces: config.workspaces.filter(item => item.id !== id) };
      await save();
      return state();
    },

    async completeSetup(mode = 'managed') {
      if (mode !== 'managed' && mode !== 'observe') throw userError('Invalid workflow mode.');
      if (mode === 'managed' && !config.connections.length) throw userError('Add a model connection first.');
      if (mode === 'managed' && !config.workspaces.length) throw userError('Add a workspace first.');
      config = { ...config, setupComplete: true, workflow: mode };
      await save();
      return state();
    },

    async setWorkflow(mode) {
      if (mode !== 'managed' && mode !== 'observe') throw userError('Invalid workflow mode.');
      if (runs.size) throw userError('Stop the running managed sessions before switching workflows.');
      config = { ...config, workflow: mode, setupComplete: mode === 'observe' || Boolean(config.connections.length && config.workspaces.length) };
      await save(); return state();
    },
    async observeImports(scanId, candidateIds) { await observations.observe(scanId, candidateIds); return state(); },
    async observationSession(id) { return observations.snapshot(id); },
    async setObservation(id, watching) { await observations.setWatching(id, watching); return state(); },

    async createSession(workspaceId) {
      const workspace = findWorkspace(workspaceId);
      if (!workspace.providerProfileId) throw userError('Choose a model connection for this workspace in Settings.');
      const stamp = now();
      const record = { id: newSessionId(), workspaceId, connectionId: workspace.providerProfileId, title: NEW_SESSION_TITLE, createdAt: stamp, lastActiveAt: stamp };
      await sessions.create(record);
      publish(record.id, { type: 'session.started', control: 'managed', title: record.title, cwd: workspace.projectLocation ?? '' });
      return summary(record);
    },

    async renameSession(sessionId, title) {
      if (observations.has(sessionId)) { await observations.rename(sessionId, title); return state(); }
      const clean = title.replace(/\s+/g, ' ').trim().slice(0, 200);
      if (!clean) throw userError('Enter a title.');
      await sessions.update(sessionId, { title: clean });
      return state();
    },

    async deleteSession(sessionId) {
      if (observations.has(sessionId)) { await observations.remove(sessionId); return state(); }
      const run = runs.get(sessionId);
      if (run) { run.controller.abort(); run.pending?.resolve('reject'); await run.done; }
      await writeChains.get(sessionId);
      await sessions.remove(sessionId);
      grants.delete(sessionId);
      sequence.delete(sessionId);
      return state();
    },

    async sessionEvents(sessionId) {
      if (observations.has(sessionId)) return observations.events(sessionId);
      await writeChains.get(sessionId);
      return sessions.readEvents(sessionId);
    },

    async sendPrompt(sessionId, text) {
      if (observations.has(sessionId)) throw userError('Observed sessions are read-only. Prompt in the agent’s own app.');
      const prompt = text.trim();
      if (!prompt) throw userError('Write a prompt first.');
      if (prompt.length > 100_000) throw userError('The prompt is too long.');
      if (runs.has(sessionId)) throw userError('This session is still working. Wait for it or stop it first.');
      const record = await sessions.get(sessionId);
      if (!record) throw userError('That session no longer exists.');
      const workspace = findWorkspace(record.workspaceId);
      const connection = findConnection(record.connectionId);
      const root = workspace.projectLocation;
      if (!root) throw userError('This workspace has no project folder.');
      const { provider, secret } = await providerFor(connection);
      const features = resolveFeatures(connection);

      const fileTools = createFileTools(root);
      const readOnly = fileTools.filter(tool => tool.access === 'read');
      const tools: AnyTool[] = [...fileTools, createCommandTool(root)];
      let memoryNotes: { name: string; summary: string }[] | undefined;
      if (features.extaliaMemory) {
        const memory = new MemoryStore(path.join(layout.workspaces, workspace.id, 'memory'));
        memoryNotes = (await memory.list()).map(note => ({ name: note.name, summary: note.summary }));
        const memoryTools = createMemoryTools(memory);
        tools.push(...memoryTools);
        readOnly.push(...memoryTools.filter(tool => tool.name !== 'memory_write'));
      }
      let skills: { name: string; description: string }[] | undefined;
      if (features.extaliaSkills) {
        const loaded = await loadSkills({ userDirectory: layout.skills, workspaceRoot: root });
        skills = loaded.skills.map(skill => ({ name: skill.name, description: skill.description }));
        const skillTools = createSkillTools(loaded.skills);
        tools.push(...skillTools);
        readOnly.push(...skillTools);
      }
      const orchestration = connection.orchestration.enabled && connection.orchestration.maxDelegations > 0 ? connection.orchestration : undefined;
      if (orchestration) {
        const providers = new Map<TaskTier, ModelProvider>();
        tools.push(createDelegationTool({
          providerFor: tier => {
            if (!providers.has(tier)) providers.set(tier, createProvider({ ...connection, model: tierModel(connection, tier) }, secret, options.fetch));
            return providers.get(tier)!;
          },
          workerTools: readOnly,
          maxDelegations: orchestration.maxDelegations,
          workspace: { name: workspace.name, root },
          emit: (body, agentId) => publish(sessionId, body, agentId),
        }));
      }
      const system = buildSystemPrompt({
        workspace: { name: workspace.name, root },
        platform: { os: process.platform === 'darwin' ? 'macOS' : process.platform === 'win32' ? 'Windows' : 'Linux', shell: process.platform === 'win32' ? 'cmd.exe' : path.basename(env.SHELL || '/bin/sh') },
        projectInstructions: await projectInstructions(root),
        ...(memoryNotes ? { memory: memoryNotes } : {}),
        ...(skills ? { skills } : {}),
        ...(orchestration ? { orchestration: { maxDelegations: orchestration.maxDelegations } } : {}),
      });
      const history = toModelHistory(await sessions.readMessages(sessionId));
      if (record.title === NEW_SESSION_TITLE) await sessions.update(sessionId, { title: prompt.replace(/\s+/g, ' ').slice(0, 60) });

      const controller = new AbortController();
      const run: Run = { controller, done: Promise.resolve() };
      runs.set(sessionId, run);
      const sessionGrants = grants.get(sessionId) ?? new Set<ToolAccess>();
      grants.set(sessionId, sessionGrants);
      publish(sessionId, { type: 'prompt.submitted', text: prompt, via: 'extalia' });

      run.done = (async () => {
        try {
          const result = await runTurn({
            provider, system, history, prompt, tools, permissions: workspace.permissions ?? DEFAULT_PERMISSIONS, sessionGrants,
            emit: body => publish(sessionId, body),
            requestApproval: request => new Promise<ApprovalOutcome>(resolve => {
              run.pending = { approvalId: request.approvalId, resolve: outcome => { delete run.pending; resolve(outcome); } };
            }),
            signal: controller.signal,
          });
          await sessions.writeMessages(sessionId, result.history);
        } catch (error) {
          publish(sessionId, { type: 'turn.failed', error: error instanceof Error ? error.message : 'The turn failed.' });
          publish(sessionId, { type: 'agent.state', state: 'idle' });
        } finally {
          await sessions.update(sessionId, { lastActiveAt: now() }).catch(() => undefined);
          finishRun(sessionId);
        }
      })();
    },

    async resolveApproval(sessionId, approvalId, decision: ApprovalDecisionInput) {
      if (observations.has(sessionId)) throw userError('Observed sessions cannot approve native agent actions.');
      const pending = runs.get(sessionId)?.pending;
      if (!pending || pending.approvalId !== approvalId) throw userError('This request is no longer waiting for approval.');
      pending.resolve(decision);
    },

    async cancel(sessionId) {
      if (observations.has(sessionId)) throw userError('Extalia cannot cancel an observed agent. Pause observation instead.');
      const run = runs.get(sessionId);
      if (!run) return;
      publish(sessionId, { type: 'user.intervention', action: 'cancel' });
      run.controller.abort();
      run.pending?.resolve('reject');
    },

    async importLocations() {
      return nativeImport.locations();
    },

    async scanImports(locationIds) {
      return nativeImport.scan(locationIds);
    },

    async previewImports(scanId, candidateIds, mode = 'imported') {
      const preview = nativeImport.preview(scanId, candidateIds, mode);
      const plan = preview.sessions.length
        ? previewImport(JSON.stringify(preview.sessions.map(entry => entry.session)), library)
        : { results: [], addCount: 0, updateCount: 0, skipCount: 0 };
      return { sessions: preview.sessions, plan, diagnostics: preview.diagnostics };
    },

    async commitImports(scanId, candidateIds, mode = 'imported') {
      const preview = nativeImport.preview(scanId, candidateIds, mode);
      if (!preview.sessions.length) throw userError(preview.diagnostics[0]?.message ?? 'Nothing could be imported from the selection.');
      const applied = applyImport(JSON.stringify(preview.sessions.map(entry => entry.session)), library);
      if (applied.preview.rejectionReason) throw userError(applied.preview.rejectionReason);
      library = applied.library;
      await saveLibrary();
      return state();
    },

    async importPortable(json) {
      const applied = applyImport(json, library);
      if (!applied.preview.rejectionReason) {
        library = applied.library;
        await saveLibrary();
      }
      return { plan: applied.preview, state: await state() };
    },

    async librarySession(id) {
      const session = library.sessions.find(item => item.id === id);
      if (!session) throw userError('That conversation is no longer in the library.');
      return session;
    },

    async organizeLibrarySession(id, action, title) {
      if (!library.sessions.some(item => item.id === id)) throw userError('That conversation is no longer in the library.');
      if (action === 'rename') {
        const clean = (title ?? '').replace(/\s+/g, ' ').trim();
        if (!clean) throw userError('Enter a title.');
        library = renameLibrarySession(library, id, clean.slice(0, 300));
      } else if (action === 'delete') library = deleteLibrarySession(library, id);
      else library = setSessionState(library, id, action === 'archive' ? 'archived' : action === 'trash' ? 'trashed' : 'active');
      await saveLibrary();
      return state();
    },

    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };

  return {
    host,
    isBusy: () => runs.size > 0,
    onIdle(listener) {
      idleListeners.add(listener);
      return () => { idleListeners.delete(listener); };
    },
    async close() {
      await observations.close();
      for (const run of runs.values()) { run.controller.abort(); run.pending?.resolve('reject'); }
      await Promise.race([Promise.all([...runs.values()].map(run => run.done)), new Promise(resolve => setTimeout(resolve, 5_000))]);
      await Promise.all(writeChains.values());
      listeners.clear();
      await lock.release();
    },
  };
}
