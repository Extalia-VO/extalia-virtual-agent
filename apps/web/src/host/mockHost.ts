import { defaultOrchestration, presetById, type Workspace } from '@extalia/core';
import type {
  AgentHostApi, ApprovalDecisionInput, ConnectionInput, ConnectionView, HostState, Platform, SessionSummary, UpdateCapability, UpdateStatus,
} from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent, type RiskLevel, type Usage } from '@extalia/protocol';
import { createMockLibrary } from './mockLibrary';

/**
 * Development-only, in-memory agent host so the UI can be built and
 * screenshotted without a runtime. Loaded only by `vite dev`/development
 * builds with `?mock` in the URL; production builds never contain it.
 *
 * URL options: `mock=ready` starts after setup with sample sessions,
 * `host=desktop` behaves like the Desktop app (folder picker), and
 * `update=available|ready|downloading` shows the update banner.
 */

export interface MockOptions {
  seed: 'setup' | 'ready';
  host: 'desktop' | 'bridge';
  update?: UpdateStatus['state'];
}

export function mockOptionsFromSearch(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const update = params.get('update');
  const states: UpdateStatus['state'][] = ['available', 'downloading', 'ready', 'installing', 'up-to-date', 'error', 'unsupported'];
  return {
    seed: params.get('mock') === 'ready' ? 'ready' : 'setup',
    host: params.get('host') === 'desktop' ? 'desktop' : 'bridge',
    ...(update && (states as string[]).includes(update) ? { update: update as UpdateStatus['state'] } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const HOME = '/Users/you/Projects';
const MODEL_LISTS: Record<string, string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'],
  ollama: ['qwen3-coder:30b', 'llama3.3:70b', 'gpt-oss:20b'],
  omniroute: ['auto', 'fast', 'reasoning'],
};
const FAKE_ENV = new Set(['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY']);

interface Scenario {
  intro: string;
  read: { path: string; output: string };
  plan: string;
  edit: { path: string; action: string; detail: string };
  command: { line: string; output: string[]; exitCode: number };
  final: string;
  usage: Usage;
}

const COVERAGE: Scenario = {
  intro: 'I’ll check how the tests are set up first.',
  read: { path: 'package.json', output: '{\n  "name": "demo-app",\n  "scripts": {\n    "build": "vite build",\n    "test": "vitest run"\n  }\n}' },
  plan: 'There is no coverage script yet. I’ll add `test:coverage` to `package.json` and run it once.',
  edit: { path: 'package.json', action: 'Edit package.json', detail: 'Add the script "test:coverage": "vitest run --coverage".' },
  command: {
    line: 'npm run test:coverage',
    output: ['> demo-app@1.0.0 test:coverage', '> vitest run --coverage', '', ' ✓ src/math.test.ts (3 tests) 4ms', ' ✓ src/format.test.ts (5 tests) 6ms', '', ' Test Files  2 passed (2)', '      Tests  8 passed (8)', ' % Coverage report from v8', ' All files |   92.4 |    88.1 |'],
    exitCode: 0,
  },
  final: 'Done. I added a coverage script to `package.json`:\n\n```json\n"test:coverage": "vitest run --coverage"\n```\n\n- **Tests:** 8 passed in 2 files\n- **Coverage:** 92.4 % of statements\n\nRun it any time with `npm run test:coverage`. The full report is written to `coverage/`; see the [Vitest coverage guide](https://vitest.dev/guide/coverage) to set thresholds.',
  usage: { inputTokens: 5120, outputTokens: 642, cachedInputTokens: 3840 },
};

const FLAKY: Scenario = {
  intro: 'Let me look at the login test to see why it is flaky.',
  read: { path: 'src/login.test.ts', output: "it('logs in', async () => {\n  render(<Login />);\n  click(screen.getByText('Sign in'));\n  expect(await screen.findByText('Welcome')).toBeVisible();\n});" },
  plan: 'The test clicks *before* the form finished loading. I’ll wait for the button to be enabled first.',
  edit: { path: 'src/login.test.ts', action: 'Edit src/login.test.ts', detail: 'Wait for the "Sign in" button to be enabled before clicking it.' },
  command: {
    line: 'npm test -- login',
    output: ['> demo-app@1.0.0 test', '> vitest run login', '', ' ✓ src/login.test.ts (1 test) 41ms', '', ' Test Files  1 passed (1)'],
    exitCode: 0,
  },
  final: 'Fixed. The test now waits for the **Sign in** button:\n\n```ts\nconst button = await screen.findByRole(\'button\', { name: \'Sign in\' });\nawait waitFor(() => expect(button).toBeEnabled());\n```\n\nI ran it 20 times in a row without a failure.',
  usage: { inputTokens: 4210, outputTokens: 388 },
};

const EXPLAIN = '## Build setup\n\nThe project uses **Vite** for development and production builds:\n\n1. `npm run dev` starts the dev server on port 5173.\n2. `npm run build` type-checks with `tsc` and bundles into `dist/`.\n3. `npm test` runs *Vitest* once.\n\n> Environment variables prefixed with `VITE_` are exposed to the browser, so never put secrets in them.\n\nThe configuration lives in `vite.config.ts`:\n\n```ts\nexport default defineConfig({\n  plugins: [react()],\n  build: { sourcemap: true },\n});\n```';

const CANCELLED = Symbol('cancelled');

interface Run {
  cancelled: boolean;
  pace: number;
  clock: () => Date;
  /** Seeded history answers its own approvals. */
  decide?: ApprovalDecisionInput;
}

interface PendingApproval {
  sessionId: string;
  access: 'write' | 'execute';
  resolve: (decision: ApprovalDecisionInput | typeof CANCELLED) => void;
}

function createMockAgents(options: MockOptions): AgentHostApi {
  const now = () => new Date();
  let counter = 0;
  const nextId = (prefix: string) => `${prefix}-${(++counter).toString(36)}`;
  const iso = () => now().toISOString();

  const state: HostState = {
    setupComplete: false,
    profile: { id: 'profile-default', name: 'Personal' },
    connections: [],
    workspaces: [],
    sessions: [],
    library: [],
    storage: { dataDirectory: options.host === 'desktop' ? '/Users/you/Library/Application Support/Extalia' : '/Users/you/.extalia', secretStore: 'os-keychain' },
    host: { kind: options.host, version: __APP_VERSION__ },
  };
  const events = new Map<string, ExtaliaEvent[]>();
  const listeners = new Set<(event: ExtaliaEvent) => void>();
  const runs = new Map<string, Run>();
  const pending = new Map<string, PendingApproval>();
  const grants = new Map<string, Set<'write' | 'execute'>>();
  const storedSecrets = new Set<string>();

  const snapshot = (): HostState => structuredClone(state);
  const imports = createMockLibrary(async library => { state.library = library; return snapshot(); }, options.seed === 'ready');
  state.library = imports.summaries();
  const session = (id: string) => {
    const found = state.sessions.find(item => item.id === id);
    if (!found) throw new Error('This session no longer exists.');
    return found;
  };

  function emit(sessionId: string, body: EventBody, at: () => Date = now, agentId = 'primary'): ExtaliaEvent {
    const list = events.get(sessionId) ?? [];
    const event = createEvent({ sessionId, source: { runtime: 'mock', channel: 'stream' }, agentId, body }, at);
    event.seq = list.length + 1;
    list.push(event);
    events.set(sessionId, list);
    const summary = state.sessions.find(item => item.id === sessionId);
    if (summary) summary.lastActiveAt = event.at;
    for (const listener of listeners) listener(event);
    return event;
  }

  function permissionsFor(sessionId: string) {
    const workspace = state.workspaces.find(item => item.id === session(sessionId).workspaceId);
    return workspace?.permissions ?? { fileWrite: 'ask', commands: 'ask' };
  }

  async function runTurn(summary: SessionSummary, text: string, run: Run): Promise<void> {
    const id = summary.id;
    const scenario = /flaky|login/i.test(text) ? FLAKY : COVERAGE;
    const model = state.connections.find(item => item.id === summary.connectionId)?.model || 'mock-model';
    const at = () => run.clock();
    const send = (body: EventBody, agentId?: string) => emit(id, body, at, agentId);
    const connection = state.connections.find(item => item.id === summary.connectionId);
    const step = async (ms: number) => {
      if (run.pace > 0) await sleep(ms * run.pace);
      else await Promise.resolve();
      if (run.cancelled) throw CANCELLED;
    };
    const say = async (message: string, usage?: Usage) => {
      const chunks = message.match(/\S+\s*/g) ?? [];
      for (let index = 0; index < chunks.length; index += 3) {
        send({ type: 'model.delta', text: chunks.slice(index, index + 3).join('') });
        await step(45);
      }
      send({ type: 'model.completed', text: message, model, ...(usage ? { usage } : {}) });
    };
    const approve = async (access: 'write' | 'execute', request: { action: string; detail: string; risk: RiskLevel }): Promise<boolean> => {
      const mode = access === 'write' ? permissionsFor(id).fileWrite : permissionsFor(id).commands;
      if (mode === 'allow' || grants.get(id)?.has(access)) return true;
      const approvalId = nextId('approval');
      send({ type: 'agent.state', state: 'waiting', summary: request.action });
      send({ type: 'approval.requested', approvalId, ...request });
      summary.pendingApprovalId = approvalId;
      const decision = run.decide ?? await new Promise<ApprovalDecisionInput | typeof CANCELLED>(resolve => pending.set(approvalId, { sessionId: id, access, resolve }));
      pending.delete(approvalId);
      delete summary.pendingApprovalId;
      if (decision === CANCELLED) throw CANCELLED;
      if (!run.decide) {
        // Seeded sessions replay instantly; everything after a real decision runs at normal speed.
        run.pace = 1;
        run.clock = now;
      }
      if (decision === 'session') grants.set(id, new Set([...(grants.get(id) ?? []), access]));
      send({ type: 'approval.resolved', approvalId, decision: decision === 'reject' ? 'rejected' : 'granted', by: 'user' });
      return decision !== 'reject';
    };

    try {
      summary.running = true;
      send({ type: 'prompt.submitted', text, via: 'extalia' });
      send({ type: 'agent.state', state: 'thinking' });
      await step(700);
      if (/fail|error/i.test(text)) throw new Error('The model endpoint answered 429 Too Many Requests. Try again in a minute.');
      if (/^explain/i.test(text)) {
        await say(EXPLAIN, { inputTokens: 2310, outputTokens: 214 });
        send({ type: 'turn.completed', usage: { inputTokens: 2310, outputTokens: 214 }, model });
        return;
      }
      await say(scenario.intro);

      const readId = nextId('call');
      send({ type: 'agent.state', state: 'working', activity: 'read', target: scenario.read.path, summary: `Reading ${scenario.read.path}` });
      send({ type: 'tool.started', toolCallId: readId, tool: 'read_file', kind: 'read', label: `Read ${scenario.read.path}`, target: scenario.read.path });
      await step(500);
      send({ type: 'tool.completed', toolCallId: readId, tool: 'read_file', kind: 'read', label: `Read ${scenario.read.path}`, ok: true, output: scenario.read.output });
      send({ type: 'agent.state', state: 'thinking' });
      await step(600);
      if (connection?.orchestration?.enabled !== false && scenario === COVERAGE) {
        // Hand a read-only review to a quick worker, as the runtime's orchestration does.
        const delegateId = nextId('call');
        const worker = nextId('worker');
        send({ type: 'tool.started', toolCallId: delegateId, tool: 'delegate_task', kind: 'delegate', label: 'Delegate: review the test setup' });
        send({ type: 'subagent.spawned', subagentId: worker, role: 'quick', label: 'Review the test setup for coverage settings' });
        send({ type: 'subagent.state', subagentId: worker, state: 'working', summary: 'Reading the test configuration' });
        for (const [label, target] of [['Read vitest.config.ts', 'vitest.config.ts'], ['Search "coverage"', 'src']] as const) {
          const call = nextId('call');
          send({ type: 'tool.started', toolCallId: call, tool: label.startsWith('Read') ? 'read_file' : 'search_files', kind: label.startsWith('Read') ? 'read' : 'search', label, target }, worker);
          await step(700);
          send({ type: 'tool.completed', toolCallId: call, tool: label.startsWith('Read') ? 'read_file' : 'search_files', kind: label.startsWith('Read') ? 'read' : 'search', label, ok: true }, worker);
        }
        send({ type: 'subagent.state', subagentId: worker, state: 'idle', summary: 'No coverage provider is configured; vitest.config.ts has no coverage block.' });
        send({ type: 'tool.completed', toolCallId: delegateId, tool: 'delegate_task', kind: 'delegate', label: 'Delegate: review the test setup', ok: true, output: 'No coverage provider is configured; vitest.config.ts has no coverage block.' });
      }
      await say(scenario.plan);

      if (!(await approve('write', { action: scenario.edit.action, detail: scenario.edit.detail, risk: 'medium' }))) {
        await say(`Okay, I left \`${scenario.edit.path}\` unchanged. Tell me if you want a different approach.`, scenario.usage);
        send({ type: 'turn.completed', usage: scenario.usage, model });
        return;
      }
      const editId = nextId('call');
      send({ type: 'agent.state', state: 'working', activity: 'edit', target: scenario.edit.path, summary: `Editing ${scenario.edit.path}` });
      send({ type: 'tool.started', toolCallId: editId, tool: 'edit_file', kind: 'edit', label: `Edit ${scenario.edit.path}`, target: scenario.edit.path });
      await step(700);
      send({ type: 'file.written', path: scenario.edit.path, change: 'update' });
      send({ type: 'tool.completed', toolCallId: editId, tool: 'edit_file', kind: 'edit', label: `Edit ${scenario.edit.path}`, ok: true, output: `Updated ${scenario.edit.path}.` });

      if (!(await approve('execute', { action: `Run ${scenario.command.line}`, detail: scenario.command.line, risk: 'low' }))) {
        await say('Understood, I did not run the tests. The change is in place.', scenario.usage);
        send({ type: 'turn.completed', usage: scenario.usage, model });
        return;
      }
      const commandId = nextId('call');
      send({ type: 'agent.state', state: 'working', activity: 'test', target: scenario.command.line, summary: 'Running tests' });
      send({ type: 'tool.started', toolCallId: commandId, tool: 'run_command', kind: 'test', label: `Run ${scenario.command.line}`, target: scenario.command.line });
      send({ type: 'command.started', commandId, command: scenario.command.line });
      for (const line of scenario.command.output) {
        await step(240);
        send({ type: 'command.output', commandId, stream: 'stdout', text: `${line}\n` });
      }
      send({ type: 'command.completed', commandId, exitCode: scenario.command.exitCode, durationMs: 2140 });
      send({ type: 'tool.completed', toolCallId: commandId, tool: 'run_command', kind: 'test', label: `Run ${scenario.command.line}`, ok: scenario.command.exitCode === 0, output: `exit ${scenario.command.exitCode}` });
      send({ type: 'agent.state', state: 'thinking' });
      await step(500);
      await say(scenario.final, scenario.usage);
      send({ type: 'turn.completed', usage: scenario.usage, model });
    } catch (error) {
      if (error === CANCELLED) send({ type: 'turn.failed', error: 'Cancelled.' });
      else send({ type: 'turn.failed', error: error instanceof Error ? error.message : String(error) });
    } finally {
      send({ type: 'agent.state', state: 'idle' });
      summary.running = false;
      delete summary.pendingApprovalId;
      runs.delete(id);
    }
  }

  function startTurn(summary: SessionSummary, text: string, seed?: { clock: () => Date; decide?: ApprovalDecisionInput }) {
    const run: Run = { cancelled: false, pace: seed ? 0 : 1, clock: seed?.clock ?? now, ...(seed?.decide ? { decide: seed.decide } : {}) };
    runs.set(summary.id, run);
    if (!summary.title) summary.title = text.length > 48 ? `${text.slice(0, 47).trimEnd()}…` : text;
    void runTurn(summary, text, run);
  }

  function toView(input: ConnectionInput, id: string, createdAt: string, secret?: string): ConnectionView {
    const credentialRef = `secret-${id}`;
    if (secret) storedSecrets.add(credentialRef);
    const credential = input.credential.kind === 'stored' ? { kind: 'stored' as const, ref: credentialRef } : input.credential;
    const credentialStatus = credential.kind === 'none' ? 'not-needed'
      : credential.kind === 'stored' ? (storedSecrets.has(credentialRef) ? 'ok' : 'missing')
        : FAKE_ENV.has(credential.variable) ? 'ok' : 'missing';
    return {
      id, name: input.name, preset: input.preset, api: input.api, baseUrl: input.baseUrl, model: input.model, credential, features: input.features,
      ...(input.effort ? { effort: input.effort } : {}), orchestration: input.orchestration ?? defaultOrchestration(input.preset), createdAt, updatedAt: iso(), credentialStatus,
    };
  }

  function addWorkspace(name: string, folder: string, connectionId: string, permissions: Workspace['permissions']): Workspace {
    const workspace: Workspace = { id: nextId('workspace'), profileId: state.profile.id, name, projectLocation: folder, providerProfileId: connectionId, createdAt: iso(), updatedAt: iso() };
    if (permissions) workspace.permissions = permissions;
    state.workspaces.push(workspace);
    return workspace;
  }

  function addSession(workspace: Workspace, title = ''): SessionSummary {
    const summary: SessionSummary = {
      id: nextId('session'), workspaceId: workspace.id, connectionId: workspace.providerProfileId ?? '', title, control: 'managed',
      createdAt: iso(), lastActiveAt: iso(), running: false,
    };
    state.sessions.unshift(summary);
    emit(summary.id, { type: 'session.started', control: 'managed', ...(title ? { title } : {}) });
    return summary;
  }

  if (options.seed === 'ready') {
    state.setupComplete = true;
    storedSecrets.add('secret-connection-seed');
    state.connections.push(
      { ...toView({ name: 'Anthropic', preset: 'anthropic', api: 'anthropic-messages', baseUrl: 'https://api.anthropic.com', model: 'claude-opus-5-5', credential: { kind: 'stored' }, features: { memory: 'extalia', skills: 'extalia' }, effort: 'high' }, 'connection-seed', iso()) },
      toView({ name: 'Ollama', preset: 'ollama', api: 'openai-chat', baseUrl: 'http://localhost:11434/v1', model: 'qwen3-coder:30b', credential: { kind: 'none' }, features: { memory: 'extalia', skills: 'off' } }, 'connection-local', iso()),
    );
    const app = addWorkspace('demo-app', `${HOME}/demo-app`, 'connection-seed', { fileWrite: 'ask', commands: 'ask' });
    addWorkspace('docs-site', `${HOME}/docs-site`, 'connection-local', { fileWrite: 'allow', commands: 'ask' });
    // Replayed instantly with timestamps in the past: one finished session and one waiting for approval.
    const past = (minutesAgo: number) => { let offset = 0; return () => new Date(Date.now() - minutesAgo * 60_000 + (offset += 1_200)); };
    startTurn(addSession(app), 'Fix the flaky login test.', { clock: past(26 * 60), decide: 'once' });
    startTurn(addSession(app), 'Explain the build setup', { clock: past(50) });
    startTurn(addSession(app), 'Add a test coverage script and run it.', { clock: past(3) });
  }

  const latency = () => sleep(140);

  return {
    async getState() { await latency(); return snapshot(); },
    async saveConnection(input, secret) {
      await latency();
      if (!input.name.trim()) throw new Error('The connection needs a name.');
      const existing = input.id ? state.connections.find(item => item.id === input.id) : undefined;
      const id = existing?.id ?? nextId('connection');
      const view = toView(input, id, existing?.createdAt ?? iso(), secret);
      if (existing) state.connections[state.connections.indexOf(existing)] = view;
      else state.connections.push(view);
      return snapshot();
    },
    async deleteConnection(id) {
      await latency();
      const user = state.workspaces.find(item => item.providerProfileId === id);
      if (user) throw new Error(`The workspace “${user.name}” uses this connection. Choose another connection there first.`);
      state.connections = state.connections.filter(item => item.id !== id);
      return snapshot();
    },
    async testConnection(input, secret) {
      await sleep(900);
      const preset = presetById(input.preset);
      if (/fail|invalid/i.test(input.baseUrl) || secret === 'bad') return { ok: false, error: 'The endpoint answered 401 Unauthorized. Check the API key.' };
      if (preset.apiKey === 'required' && input.credential.kind === 'env' && !FAKE_ENV.has(input.credential.variable)) {
        return { ok: false, error: `The environment variable ${input.credential.variable} is not set.` };
      }
      return { ok: true, latencyMs: preset.local ? 38 : 214, models: MODEL_LISTS[preset.id] ?? ['gpt-5.5', 'gpt-5.5-mini', 'o5'] };
    },
    async checkFolder(path) {
      await latency();
      const value = path.trim().replace(/[\\/]+$/, '').replace(/^~(?=$|\/)/, '/Users/you');
      if (!value) return { ok: false, error: 'Enter the path of a folder.' };
      if (!/^(\/|[A-Za-z]:[\\/])/.test(value)) return { ok: false, error: 'Use an absolute path, such as /Users/<name>/projects/app.' };
      if (/missing|nope/i.test(value)) return { ok: false, error: 'No folder exists at this path.' };
      return { ok: true, path: value, name: value.split(/[\\/]/).pop() || value };
    },
    async saveWorkspace(input) {
      await latency();
      const existing = input.id ? state.workspaces.find(item => item.id === input.id) : undefined;
      if (existing) Object.assign(existing, { name: input.name, projectLocation: input.projectLocation, providerProfileId: input.connectionId, permissions: input.permissions, updatedAt: iso() });
      else addWorkspace(input.name, input.projectLocation, input.connectionId, input.permissions);
      return snapshot();
    },
    async deleteWorkspace(id) {
      await latency();
      state.workspaces = state.workspaces.filter(item => item.id !== id);
      state.sessions = state.sessions.filter(item => item.workspaceId !== id);
      return snapshot();
    },
    async completeSetup(mode = 'managed') { await latency(); state.setupComplete = true; state.workflow = mode; return snapshot(); },
    async setWorkflow(mode) { state.workflow = mode; state.setupComplete = mode === 'observe' || Boolean(state.connections.length && state.workspaces.length); return snapshot(); },
    async observeImports() { throw new Error('Live native observation needs the Desktop host or local Bridge. Mock histories cannot be watched.'); },
    async observationSession() { throw new Error('No native transcript is available in this mock host.'); },
    async setObservation() { throw new Error('No native transcript is available in this mock host.'); },
    async createSession(workspaceId) {
      await latency();
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      return structuredClone(addSession(workspace));
    },
    async renameSession(sessionId, title) { await latency(); session(sessionId).title = title.trim(); return snapshot(); },
    async deleteSession(sessionId) {
      await latency();
      const run = runs.get(sessionId);
      if (run) run.cancelled = true;
      for (const request of pending.values()) if (request.sessionId === sessionId) request.resolve(CANCELLED);
      state.sessions = state.sessions.filter(item => item.id !== sessionId);
      events.delete(sessionId);
      return snapshot();
    },
    async sessionEvents(sessionId) { await latency(); return structuredClone(events.get(sessionId) ?? []); },
    async sendPrompt(sessionId, text) {
      await latency();
      const summary = session(sessionId);
      if (summary.running) throw new Error('The agent is still working on the previous prompt.');
      startTurn(summary, text);
    },
    async resolveApproval(sessionId, approvalId, decision) {
      await latency();
      const request = pending.get(approvalId);
      if (!request || request.sessionId !== sessionId) throw new Error('This approval is no longer pending.');
      request.resolve(decision);
    },
    async cancel(sessionId) {
      await latency();
      const run = runs.get(sessionId);
      if (!run || run.cancelled) return;
      run.cancelled = true;
      emit(sessionId, { type: 'user.intervention', action: 'cancel' });
      for (const request of pending.values()) if (request.sessionId === sessionId) request.resolve(CANCELLED);
    },
    ...imports.methods,
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function createMockUpdater(options: MockOptions): UpdateCapability {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const latest = '0.2.0';
  const base = { current: __APP_VERSION__, channel: 'stable' as const, ...(options.host === 'bridge' ? { command: 'npm i -g extalia-vo@latest' } : {}) };
  let status: UpdateStatus = options.update
    ? { ...base, latest, state: options.update, ...(options.update === 'ready' && options.host === 'desktop' ? { restartInSeconds: 30 } : {}), ...(options.update === 'downloading' ? { progress: 0.42 } : {}) }
    : { ...base, latest: base.current, state: 'up-to-date' };
  const publish = (next: UpdateStatus) => { status = next; for (const listener of listeners) listener(status); };
  return {
    async status() { return status; },
    async check() {
      publish({ ...status, state: 'checking' });
      await sleep(800);
      publish({ ...base, latest, state: 'available' });
      return status;
    },
    async install() {
      publish({ ...status, state: 'installing' });
      await sleep(1500);
      publish({ ...base, latest: base.current, state: 'up-to-date' });
    },
    async postpone() { const { restartInSeconds: _ignored, ...rest } = status; publish(rest); },
    onStatus(listener) {
      listeners.add(listener);
      listener(status);
      return () => { listeners.delete(listener); };
    },
  };
}

export function createMockPlatform(options: MockOptions): Platform {
  const desktop = options.host === 'desktop';
  return {
    info: { kind: desktop ? 'desktop' : 'web', appVersion: __APP_VERSION__, os: 'macos', ...(desktop ? { arch: 'arm64', shellVersion: 'mock' } : {}) },
    capabilities: {
      agents: createMockAgents(options),
      updater: createMockUpdater(options),
      ...(desktop ? { filesystem: { selectDirectory: async () => { await sleep(200); return { name: 'demo-app', path: `${HOME}/demo-app` }; } } } : {}),
    },
  };
}
