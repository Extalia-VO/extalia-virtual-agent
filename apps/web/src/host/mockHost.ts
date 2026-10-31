import { applyTeamSpec, defaultOrchestration, generateFullName, initialSessionTeam, parseTeamSpec, withDistinctMemberNames, pickTeamModels, planModelOrder, planTeamHeuristic, presetById, type AgentTeam, type Workspace } from '@extalia/core';
import type {
  AgentAppConnection, AgentAppConnectOptions, AgentAppConnectPlan, AgentAppConnectResult, AgentAppDisconnectResult,
  AgentAppId, AgentAppTestResult, AgentHostApi, ApprovalDecisionInput, ConnectionInput, ConnectionView,
  HookIngestStatus, HostState, ModelChoices, Platform, ProfilePreferences, SessionSummary, UpdateCapability, UpdateStatus, UserProfile,
} from '@extalia/platform';
import { attachmentLimit, classifyAttachment, normalizeAgentTeam, normalizeIntegrationGate, normalizePromptLearnSkill, normalizeSessionOptions, normalizeTeamPlanRequest, sanitizeAttachmentName, type PromptAttachment } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent, type RiskLevel, type Usage } from '@extalia/protocol';
import { createMockAppearances } from './mockAppearances';
import { createMockLibrary } from './mockLibrary';
import { createMockMissions } from './mockMissions';
import { createMockWorktrees } from './mockWorktrees';
import { createMockWorkspaceInspection, createMockWorkspaceSkills } from './mockWorkspace';
import { createMockBuiltinSkills, createMockSkillRegistry, type MockSkillMode } from './mockSkillRegistry';
import { createMockKnowledge } from './mockKnowledge';
import { createMockKnowledgeSettings } from './mockKnowledgeSettings';
import { browserNotifications } from '../approvals/browserNotifications';

const MOCK_WORKSPACE_TEAMS_KEY = 'extalia.mock.workspace-teams';
const MOCK_HERMES_DEFAULT_MODEL = 'anthropic/claude-sonnet-5-5';
/** A router-sized catalog (v0.0.39: long enough to need the team dialog's model filter). */
const MOCK_HERMES_MODELS = [
  'anthropic/claude-haiku-5-5', 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'google/gemini-3-flash', 'google/gemini-3-pro', 'openai/gpt-5', 'openai/gpt-5-mini',
  'openai/text-embedding-3-large', 'qwen/qwen3-coder', 'deepseek/deepseek-reasoner', 'deepseek/deepseek-chat', 'mistral/mistral-large', 'mistral/mistral-small',
  'meta/llama-4-70b', 'meta/llama-4-8b', 'xai/grok-4', 'xai/grok-4-fast', 'moonshot/kimi-k2', 'zhipu/glm-4.6', 'openai/gpt-5-nano', 'google/gemini-3-flash-lite',
  'qwen/qwen3-max', 'cohere/command-a', 'amazon/nova-pro', 'amazon/nova-lite',
];

/**
 * Development-only, in-memory agent host so the UI can be built and
 * screenshotted without a runtime. Loaded only by `vite dev`/development
 * builds with `?mock` in the URL; production builds never contain it.
 *
 * URL options: `mock=ready` starts after setup with sample sessions,
 * `host=desktop` behaves like the Desktop app (folder picker),
 * `update=available|ready|downloading` shows the update banner, and `hermes`
 * reports Hermes Agent as installed (its sessions still run the mock scenarios;
 * with `mock=ready` it also adds a Hermes workspace, `agent-lab`, with one session),
 * and `observed` (with `mock=ready`) adds outside-app sessions whose transcript
 * activity events keep arriving, one working and one idle; `migrated` (with
 * `mock=ready`) keeps the sample data but asks for the welcome setup again;
 * `otp` (with `mock=ready`) adds a session whose prompt defines a subagent team
 * (`MOCK_OTP_TEAM_PROMPT`), as a user would write it. The Skill Security Center shows sample registry
 * revisions on the Skills page; `skills=legacy` hides it (W0 panels), `skills=offline` reports the native core unavailable and
 * `skills=review` lets the sample daemon record reviews. With `mock=ready` the Knowledge page shows a sample vault
 * (`mockKnowledge.ts`); `knowledge=large` adds ~390 generated notes (a realistic vault graph), `knowledge=empty` starts with an empty
 * vault and `knowledge=off` leaves the knowledge methods out (page hidden); `knowledge=conflict` makes the next note save conflict.
 */

export interface MockOptions {
  seed: 'setup' | 'ready';
  host: 'desktop' | 'bridge';
  update?: UpdateStatus['state'];
  hermes?: boolean;
  /** Adds observed (outside-app) demo sessions that emit transcript-channel activity. */
  observed?: boolean;
  /** With `mock=ready`: an older configuration whose welcome setup must run once more (prefilled). */
  migrated?: boolean;
  /** With `mock=ready`: a session started with a prompt that defines a subagent team (`MOCK_OTP_TEAM_PROMPT`). */
  otp?: boolean;
  /** With `mock=ready`: retained native missions (one completed, one failed, one with write-capable workers and their worktree integration demo) for the Missions page. */
  missions?: boolean;
  /** Skill Security Center: `legacy` (W0 panels), `offline` (native core unavailable) or `review` (daemon serves reviews). */
  skills?: MockSkillMode;
  /**
   * Knowledge (W5, with `mock=ready`): a `large` generated vault (~400 notes), an `empty` vault, `off` (a host without the knowledge
   * methods), or `conflict` (the sample vault; the next note save meets an outside edit and conflicts).
   */
  knowledge?: 'large' | 'empty' | 'off' | 'conflict';
}

/** A prompt that defines a two-member team (the short format, Indonesian and English labels mixed). */
export const MOCK_OTP_TEAM_PROMPT = [
  'Eksekusi fitur OTP Login Endpoint:',
  'Subagent A:',
  '- Name: Elena Mark',
  '- Gender: female',
  '- Role: Backend Engineer',
  '- Model: claude-sonnet-5-5',
  '- Soul: "Pragmatic, clean architect. Small modules, standard JSON responses."',
  '- Tugas: Buat route POST /api/auth/otp, controller, validasi request format, dan respon JSON standar.',
  '- Lingkup: src/auth/',
  'Subagent B:',
  '- Name: Kaelen Vael',
  '- Gender: male',
  '- Role: Backend Engineer',
  '- Model: claude-opus-5-5, claude-sonnet-5-5',
  '- Soul: "Paranoid security & concurrency engineer."',
  '- Tugas: Audit skema Elena. Tambahkan rate limiter, hash token OTP, dan transactional lock.',
  '- Batasan: "migrations/, .env"',
].join('\n');

export function mockOptionsFromSearch(search: string): MockOptions {
  const params = new URLSearchParams(search);
  const update = params.get('update');
  const states: UpdateStatus['state'][] = ['available', 'downloading', 'ready', 'installing', 'up-to-date', 'error', 'unsupported'];
  return {
    seed: params.get('mock') === 'ready' ? 'ready' : 'setup',
    host: params.get('host') === 'desktop' ? 'desktop' : 'bridge',
    ...(update && (states as string[]).includes(update) ? { update: update as UpdateStatus['state'] } : {}),
    ...(params.has('hermes') ? { hermes: true } : {}),
    ...(params.has('observed') ? { observed: true } : {}),
    ...(params.has('migrated') ? { migrated: true } : {}),
    ...(params.has('otp') ? { otp: true } : {}),
    ...(params.has('missions') ? { missions: true } : {}),
    ...(['legacy', 'offline', 'review'].includes(params.get('skills') ?? '') ? { skills: params.get('skills') as MockSkillMode } : {}),
    ...(['large', 'empty', 'off', 'conflict'].includes(params.get('knowledge') ?? '') ? { knowledge: params.get('knowledge') as 'large' | 'empty' | 'off' | 'conflict' } : {}),
  };
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
const APP_VERSION = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : '0.1.0';
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

const EXPLAIN = '## Build setup\n\nThe project uses **Vite** for development and production builds:\n\n1. `npm run dev` starts the dev server on port 5173.\n2. `npm run build` type-checks with `tsc` and bundles into `dist/`.\n3. `npm test` runs *Vitest* once.\n\nThe main scripts at a glance:\n| Command | What it does | Output |\n| --- | :--- | ---: |\n| `npm run dev` | Starts the dev server | `localhost:5173` |\n| `npm run build` | Type-checks, then bundles | `dist/` |\n| `npm test` | Runs *Vitest* once | `exit 0` |\n\n> Environment variables prefixed with `VITE_` are exposed to the browser, so never put secrets in them.\n\nThe configuration lives in `vite.config.ts`:\n\n```ts\nexport default defineConfig({\n  plugins: [react()],\n  build: { sourcemap: true },\n});\n```';

const CANCELLED = Symbol('cancelled');

interface Run {
  cancelled: boolean;
  pace: number;
  clock: () => Date;
  /** Seeded history answers its own approvals. */
  decide?: ApprovalDecisionInput;
  /** v0.0.49: the prompt's attachments (names, kinds, sizes), as its event carries them. */
  attachments?: { name: string; kind: 'image' | 'text' | 'file'; size: number }[];
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

  const dataDirectory = '/Users/you/.extalia-vo';
  const state: HostState = {
    setupComplete: false,
    dataDirectory,
    profile: { id: 'profile-default', name: 'Personal' },
    connections: [],
    workspaces: [],
    sessions: [],
    library: [],
    storage: { dataDirectory, secretStore: 'os-keychain' },
    host: { kind: options.host, version: APP_VERSION },
  };
  const events = new Map<string, ExtaliaEvent[]>();
  const listeners = new Set<(event: ExtaliaEvent) => void>();
  const runs = new Map<string, Run>();
  const pending = new Map<string, PendingApproval>();
  const grants = new Map<string, Set<'write' | 'execute'>>();
  const storedSecrets = new Set<string>();
  /** Subagent teams per session (kept with the session record on a real host). */
  const teams = new Map<string, AgentTeam>();
  /** v0.0.43: simulated read-only native missions (deterministic plans, demo answers marked unverified). */
  /** ADR 0028: demo worktrees and integration proposals of write-capable mission tasks. */
  const worktreeHost = createMockWorktrees(dataDirectory, id => state.workspaces.find(item => item.id === id)?.projectLocation,
    id => structuredClone(state.workspaces.find(item => item.id === id)?.integrationGate));
  const missionHost = createMockMissions({ state, events, listeners, teams, listModels: id => MODEL_LISTS[state.connections.find(item => item.id === id)?.preset ?? ''] ?? [], onFinished: run => { worktreeHost.register(run); } });
  /** Names in use in the mock Office (leads and members), so generated names stay unique like on a real host. */
  const officeNames = (exceptTeamOf?: string) => [
    ...state.sessions.flatMap(item => (item.agentName ? [item.agentName] : [])),
    ...[...teams.entries()].flatMap(([id, team]) => (id === exceptTeamOf ? [] : team.members.map(member => member.name))),
  ];
  /** Apply a team written into a prompt (subagent blocks) to a managed Native session; true when one was applied. */
  function applyPromptTeam(summary: SessionSummary, text: string): boolean {
    if (summary.control !== 'managed') return false;
    const spec = parseTeamSpec(text);
    if (!spec) return false;
    setTeam(summary, applyTeamSpec(teams.get(summary.id), spec, { taken: officeNames(summary.id), seed: summary.id, newId: () => nextId('member') }));
    return true;
  }
  function setTeam(summary: SessionSummary, team: AgentTeam | null) {
    if (team) {
      teams.set(summary.id, { ...team, updatedAt: iso() });
      summary.team = { enabled: team.enabled, size: team.members.length };
    } else {
      teams.delete(summary.id);
      delete summary.team;
    }
  }

  const snapshot = (): HostState => structuredClone(state);
  // The shared profile (`config/profile.json` on a real host), kept in memory and validated like the host does.
  let profile: UserProfile = { schema: 'extalia.profile.v1', preferences: {}, updatedAt: new Date(0).toISOString() };
  const PREFERENCE_KEYS = ['language', 'theme', 'material', 'font', 'sidebar'] as const;
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
      send({ type: 'approval.resolved', approvalId, decision: decision === 'reject' ? 'rejected' : 'granted', by: 'user', choice: decision });
      return decision !== 'reject';
    };

    try {
      summary.running = true;
      send({ type: 'prompt.submitted', text, via: 'extalia', ...(run.attachments ? { attachments: run.attachments } : {}) });
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
      const team = teams.get(id);
      if (team?.enabled && team.members.length) {
        // The lead hands a part of the request to each member, as the runtime does with `delegate_task` + `member`.
        for (const [index, member] of team.members.entries()) {
          const delegateId = nextId('call');
          const label = `Delegating to ${member.name}: ${member.task ?? member.role}`.slice(0, 120);
          send({ type: 'tool.started', toolCallId: delegateId, tool: 'delegate_task', kind: 'delegate', label, target: member.name });
          send({ type: 'subagent.spawned', subagentId: member.id, role: member.role, label: member.name });
          send({ type: 'subagent.state', subagentId: member.id, state: 'working', summary: member.task ?? `Working as ${member.role}` });
          if (index === 1 && member.models.length > 1) {
            await step(400);
            send({ type: 'subagent.state', subagentId: member.id, state: 'working', summary: `Switched to ${member.models[1]} (${member.models[0]} hit a limit)` });
          }
          const call = nextId('call');
          const target = index % 2 ? 'src' : scenario.read.path;
          const tool = index % 2 ? 'search_files' : 'read_file';
          const kind = index % 2 ? 'search' : 'read';
          send({ type: 'tool.started', toolCallId: call, tool, kind, label: `${index % 2 ? 'Search' : 'Read'} ${target}`, target }, member.id);
          await step(600);
          send({ type: 'tool.completed', toolCallId: call, tool, kind, label: `${index % 2 ? 'Search' : 'Read'} ${target}`, ok: true }, member.id);
          if (member.access === 'write') {
            // A write member edits a file inside its scope itself (the runtime runs writers one at a time).
            const scoped = member.scope?.[0];
            const file = scoped && /\.[a-z0-9]+$/i.test(scoped) ? scoped : `${scoped ?? 'src'}/${member.role.toLowerCase().replace(/[^a-z0-9]+/g, '-')}.ts`;
            const edit = nextId('call');
            send({ type: 'tool.started', toolCallId: edit, tool: 'edit_file', kind: 'edit', label: `Editing ${file}`, target: file }, member.id);
            await step(500);
            send({ type: 'file.written', path: file, change: 'update' }, member.id);
            send({ type: 'tool.completed', toolCallId: edit, tool: 'edit_file', kind: 'edit', label: `Editing ${file}`, target: file, ok: true, output: `Edited ${file}.` }, member.id);
          }
          const finding = `${member.role}: ${member.access === 'write' ? 'changes ready for review' : 'findings ready for the lead'}.`;
          send({ type: 'subagent.state', subagentId: member.id, state: 'idle', summary: finding });
          send({ type: 'tool.completed', toolCallId: delegateId, tool: 'delegate_task', kind: 'delegate', label, target: member.name, ok: true, output: finding });
        }
      } else if (connection?.orchestration?.enabled !== false && scenario === COVERAGE) {
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

  function startTurn(summary: SessionSummary, text: string, seed?: { clock: () => Date; decide?: ApprovalDecisionInput }, attachments?: Run['attachments']) {
    const run: Run = { cancelled: false, pace: seed ? 0 : 1, clock: seed?.clock ?? now, ...(seed?.decide ? { decide: seed.decide } : {}), ...(attachments?.length ? { attachments } : {}) };
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

  /** Sample model lists (nothing is contacted); the effort control is offered for every mock workspace. */
  function modelChoicesFor(workspace: Workspace): ModelChoices {
    const efforts = ['low', 'medium', 'high'] as ModelChoices['efforts'];
    if (workspace.runtimeId === 'hermes') {
      return { runtime: 'hermes', defaultModel: workspace.runtimeModel || MOCK_HERMES_DEFAULT_MODEL, models: [...MOCK_HERMES_MODELS], efforts, permissionModes: ['workspace'] };
    }
    const connection = state.connections.find(item => item.id === workspace.providerProfileId);
    const defaultModel = connection?.model || 'mock-agent';
    return {
      runtime: 'extalia-native', defaultModel, efforts, ...(connection?.effort ? { defaultEffort: connection.effort } : {}),
      models: [...new Set([defaultModel, 'anthropic/claude-opus-5-5', 'anthropic/claude-sonnet-5-5', 'openai/gpt-5', 'qwen/qwen3-coder'])],
      permissionModes: ['workspace', 'ask', 'accept-edits', 'plan'],
    };
  }

  function addWorkspace(name: string, folder: string, connectionId: string, permissions: Workspace['permissions']): Workspace {
    const workspace: Workspace = { id: nextId('workspace'), profileId: state.profile.id, name, projectLocation: folder, providerProfileId: connectionId, createdAt: iso(), updatedAt: iso() };
    if (permissions) workspace.permissions = permissions;
    state.workspaces.push(workspace);
    return workspace;
  }

  /** Mock-only: default teams by project folder in sessionStorage, so a reload keeps them like a real host's config does. */
  function restoreWorkspaceTeams() {
    let stored: Record<string, unknown>;
    try { stored = JSON.parse(sessionStorage.getItem(MOCK_WORKSPACE_TEAMS_KEY) ?? '{}') as Record<string, unknown>; } catch { return; }
    for (const workspace of state.workspaces) {
      const raw = workspace.projectLocation ? stored[workspace.projectLocation] : undefined;
      if (!raw) continue;
      try { const team = normalizeAgentTeam(raw); if (team) workspace.team = team; } catch { /* a damaged entry is ignored */ }
    }
  }
  function storeWorkspaceTeams() {
    const teamsByFolder = Object.fromEntries(state.workspaces.flatMap(item => (item.team && item.projectLocation ? [[item.projectLocation, item.team]] : [])));
    try { sessionStorage.setItem(MOCK_WORKSPACE_TEAMS_KEY, JSON.stringify(teamsByFolder)); } catch { /* storage blocked */ }
  }

  function addSession(workspace: Workspace, title = ''): SessionSummary {
    const id = nextId('session');
    // The lead's full name and gender, unique in the Office, as the real host assigns at creation.
    const lead = generateFullName(id, new Set(officeNames().map(name => name.toLowerCase())));
    const summary: SessionSummary = {
      id, workspaceId: workspace.id, connectionId: workspace.providerProfileId ?? '', title, control: 'managed',
      createdAt: iso(), lastActiveAt: iso(), running: false, agentName: lead.name, agentGender: lead.gender,
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
    // Missions in demo-app may also use the local connection (two providers, as `setWorkspaceMissionConnections` allows).
    app.missionConnectionIds = ['connection-local'];
    // ADR 0028: demo-app has an integration test gate; docs-site has none (its Changes panel offers a suggestion).
    app.integrationGate = { command: 'npm test' };
    addWorkspace('docs-site', `${HOME}/docs-site`, 'connection-local', { fileWrite: 'allow', commands: 'ask' });
    // Replayed instantly with timestamps in the past: one finished session and one waiting for approval.
    const past = (minutesAgo: number) => { let offset = 0; return () => new Date(Date.now() - minutesAgo * 60_000 + (offset += 1_200)); };
    startTurn(addSession(app), 'Fix the flaky login test.', { clock: past(26 * 60), decide: 'once' });
    // v0.0.48: the second sample session has used 62% of its 200k window (its lead's context in use).
    const explained = addSession(app);
    explained.context = { usedTokens: 124_000, windowTokens: 200_000, estimated: false, compactions: 0, updatedAt: iso() };
    startTurn(explained, 'Explain the build setup', { clock: past(50) });
    // The newest sample session leads a small subagent team, so the board shows members under their lead.
    const lead = addSession(app);
    const allowedModels = ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-4-5'];
    const goal = 'Add a test coverage script and run it.';
    const souls = ['Curious and thorough; cites every file it reads.', 'Skeptical reviewer; looks for the case nobody tested.', 'Calm analyst; compares options before choosing.'];
    const planned = planTeamHeuristic({ goal, count: 3, allowedModels }, () => nextId('member'), officeNames());
    // The first member may edit inside its scope (a write member); the others only read.
    const members = planned.map((member, index) => ({ ...member, soul: souls[index]!, ...(index === 0 ? { access: 'write' as const, scope: ['package.json', 'src'], forbidden: ['src/generated'] } : { access: 'read' as const }) }));
    setTeam(lead, { enabled: true, allowedModels, goal, rules: ['Run the tests before reporting.'], members });
    startTurn(lead, goal, { clock: past(3) });
    if (options.hermes) {
      // v0.0.32: a Hermes Agent workspace (profile `default`, models from a local router stand-in) with one session.
      const lab: Workspace = { id: nextId('workspace'), profileId: state.profile.id, name: 'agent-lab', projectLocation: `${HOME}/agent-lab`, runtimeId: 'hermes', runtimeProfileId: 'default', permissions: { fileWrite: 'ask', commands: 'ask' }, createdAt: iso(), updatedAt: iso() };
      state.workspaces.push(lab);
      const hermesSession = addSession(lab);
      hermesSession.runtime = { id: 'hermes', profile: 'default' };
      startTurn(hermesSession, 'Explain the build setup', { clock: past(30) });
    }
    if (options.otp) {
      const otp = addSession(app);
      applyPromptTeam(otp, MOCK_OTP_TEAM_PROMPT);
      startTurn(otp, MOCK_OTP_TEAM_PROMPT, { clock: past(1), decide: 'once' });
    }
  }

  // v0.0.47: workspace default teams survive a page reload of the mock (a real host keeps them in its config).
  restoreWorkspaceTeams();

  if (options.migrated && options.seed === 'ready') state.setupComplete = false;
  if (options.observed && options.seed === 'ready') seedObservedDemo();
  if (options.missions && options.seed === 'ready') setTimeout(seedMissionDemo, 0);

  /** Two retained missions in the past (after the seeded turns settle): one completed, one with a failed branch. */
  function seedMissionDemo() {
    const native = state.sessions.filter(item => item.control === 'managed' && !item.runtime && item.workspaceId === state.workspaces[0]?.id);
    const [first, second] = [native.at(-1), native.at(-2)];
    const missionAt = (minutesAgo: number) => new Date(Date.now() - minutesAgo * 60_000);
    const seed = (summary: SessionSummary | undefined, goal: string, minutesAgo: number, fail: string[] = []) => {
      if (!summary) return;
      const plan = missionHost.plan(summary.id, { goal, maxTasks: 4 });
      missionHost.start(summary.id, { title: plan.title, tasks: plan.tasks.map(({ role: _role, rationale: _rationale, ...task }) => task), maxConcurrency: plan.maxConcurrency }, { at: missionAt(minutesAgo), fail });
    };
    seed(second, 'Review the build setup for risks.', 40);
    seed(first, 'Find why the login test is flaky.', 90, ['review-risks']);
    // After the seeded missions above settle (they finish within microtasks), so the session is free again.
    setTimeout(() => seedWriteMission(first, 20), 0);
  }

  /**
   * ADR 0028 demo: a finished mission with four write-capable workers whose integration proposals show
   * every outcome (ready after a stale one, failed gate with a log, conflict with paths, applied) plus orphans.
   */
  function seedWriteMission(summary: SessionSummary | undefined, minutesAgo: number) {
    const workspace = summary && state.workspaces.find(item => item.id === summary.workspaceId);
    const connection = workspace && state.connections.find(item => item.id === workspace.providerProfileId);
    if (!summary || !connection) return;
    const at = new Date(Date.now() - minutesAgo * 60_000);
    const writer = (id: string, title: string, dependsOn: string[] = []) => ({ id, title, instructions: `${title}.`, connectionId: connection.id, model: connection.model, dependsOn, access: 'write' as const });
    const run = missionHost.start(summary.id, { title: 'Fix the login form', maxConcurrency: 4, tasks: [
      writer('fix-validation', 'Fix login validation'), writer('stabilize-test', 'Stabilize the flaky login test'),
      writer('refactor-form', 'Refactor the login form'), writer('update-docs', 'Update the login docs'),
    ] }, { at });
    // No gate in the requests: the workspace setting runs (as on a real host).
    const gate = {};
    const later = (minutes: number) => new Date(at.getTime() + minutes * 60_000).toISOString();
    worktreeHost.plan(run.id, [{}, { outcome: 'gate_failed' }, { outcome: 'conflict', conflicts: ['src/login/LoginForm.tsx', 'src/login/form.css'] }, {}], records => {
      const [fix, flaky, form, docs] = records;
      if (!fix || !flaky || !form || !docs) return;
      worktreeHost.settle(worktreeHost.propose(fix.id, gate, later(4)).id, 'stale', later(5));
      worktreeHost.propose(fix.id, gate, later(6));
      worktreeHost.propose(flaky.id, gate, later(7));
      worktreeHost.propose(form.id, gate, later(8));
      worktreeHost.settle(worktreeHost.propose(docs.id, gate, later(9)).id, 'applied', later(10));
      worktreeHost.addOrphans(run);
    });
  }

  /** Observed sessions mirror an agent in another app: read-only, mapped to a workspace by project path, activity from `transcript` events. */
  function seedObservedDemo() {
    // v0.0.37: observed sessions carry their source, channel, lead model and a generated lead name;
    // sub-agents arrive as `subagent.spawned` (label, role, model) and their steps carry their own agent id.
    const observedNames = new Set<string>();
    const observe = (title: string, workspace: Workspace | undefined, lastMinutesAgo: number,
      source: { sourceId?: 'codex' | 'claude-code'; channel?: 'hook' | 'transcript'; model?: string } = {}): SessionSummary => {
      const id = nextId('observed'), lead = generateFullName(`${id}#observed`, observedNames);
      observedNames.add(lead.name.toLowerCase());
      const summary: SessionSummary = {
        id, workspaceId: workspace?.id ?? '', connectionId: '', title, control: 'observed', running: false,
        createdAt: new Date(Date.now() - 90 * 60_000).toISOString(), lastActiveAt: new Date(Date.now() - lastMinutesAgo * 60_000).toISOString(),
        agentName: lead.name, agentGender: lead.gender, ...(source.model ? { model: source.model } : {}),
        observation: { sourceId: source.sourceId ?? 'codex', nativeSessionId: `native-${title.length}`, watching: true, status: 'watching', channel: source.channel ?? 'transcript',
          ...(source.channel === 'hook' ? { hook: true } : {}), ...(workspace?.projectLocation ? { projectPath: `${workspace.projectLocation}/src` } : {}) },
      };
      state.sessions.push(summary);
      return summary;
    };
    const record = (summary: SessionSummary, body: EventBody, at: Date, agentId = 'primary') => {
      const list = events.get(summary.id) ?? [];
      const runtime = summary.observation?.sourceId ?? 'codex', hook = summary.observation?.channel === 'hook';
      const event = createEvent({ sessionId: summary.id, agentId, source: { runtime, channel: hook ? 'hook' : 'transcript', adapter: hook ? `${runtime}-hooks` : 'native-transcript' }, body }, () => at);
      event.seq = list.length + 1;
      list.push(event); events.set(summary.id, list);
      summary.lastActiveAt = event.at;
      for (const listener of listeners) listener(event);
    };
    const workspaces = state.workspaces;
    const live = observe('Refactor the router', workspaces[0], 0, { sourceId: 'codex', channel: 'transcript', model: 'gpt-5.5' });
    const stale = observe('Update the changelog', workspaces[1], 25, { sourceId: 'codex', channel: 'transcript', model: 'gpt-5.5' });
    const claude = observe('Review the login flow', workspaces[1] ?? workspaces[0], 2, { sourceId: 'claude-code', channel: 'hook', model: 'claude-opus-5-5' });
    // v0.0.48: the Codex thread has compacted once and sits at 30% of its window; the Claude Code lead is near its limit (96%).
    live.context = { usedTokens: 118_000, windowTokens: 400_000, estimated: false, compactions: 1, updatedAt: iso() };
    claude.context = { usedTokens: 192_400, windowTokens: 200_000, estimated: false, compactions: 2, updatedAt: iso() };
    const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
    // Codex: two sub-agent threads (nicknamed by Codex), spawned by the lead.
    record(live, { type: 'subagent.spawned', subagentId: 'thread-child-a', label: 'Carver the 2nd', role: 'explorer', model: 'gpt-5.5-mini' }, minutesAgo(38));
    record(live, { type: 'agent.state', state: 'working', activity: 'read', summary: 'Read src/routes', target: 'src/routes' }, minutesAgo(37.5), 'thread-child-a');
    record(live, { type: 'subagent.spawned', subagentId: 'thread-child-b', label: 'Hollis', role: 'worker', model: 'gpt-5.5' }, minutesAgo(37));
    record(live, { type: 'tool.started', tool: 'exec_command', kind: 'test', label: 'Running pnpm test guards', target: 'pnpm test guards' }, minutesAgo(36.5), 'thread-child-b');
    record(live, { type: 'tool.completed', tool: 'exec_command', kind: 'test', label: 'Running pnpm test guards', ok: true, target: 'pnpm test guards' }, minutesAgo(36), 'thread-child-b');
    // Claude Code: a subagent labelled by its task description, typed by its agent type.
    record(claude, { type: 'session.started', control: 'observed', title: 'Review the login flow', model: 'claude-opus-5-5' }, minutesAgo(10));
    record(claude, { type: 'prompt.submitted', via: 'native', text: 'Review the login flow for missing error states.', attachments: [
      { name: 'login-error.png', kind: 'image', size: 48_210, ref: MOCK_IMAGE_REFS[0] },
      { name: 'signup-form.png', kind: 'image', size: 61_904, ref: MOCK_IMAGE_REFS[1] },
      { name: 'error-states.md', kind: 'text', size: 2_140 },
    ] }, minutesAgo(9));
    record(claude, { type: 'subagent.spawned', subagentId: 'a1b2c3d4e5f6a7b8c', label: 'Audit login error states', role: 'general-purpose', model: 'claude-sonnet-5' }, minutesAgo(8));
    record(claude, { type: 'prompt.submitted', via: 'native', text: 'Audit the login form for missing error states. The screenshot shows the current failure view.', attachments: [
      { name: 'login-error.png', kind: 'image', size: 48_210, ref: MOCK_IMAGE_REFS[0] },
    ] }, minutesAgo(7.5), 'a1b2c3d4e5f6a7b8c');
    record(claude, { type: 'tool.started', tool: 'Read', kind: 'read', label: 'Read: login.tsx', target: 'login.tsx' }, minutesAgo(7), 'a1b2c3d4e5f6a7b8c');
    record(claude, { type: 'tool.completed', tool: 'Read', kind: 'read', label: 'Read: login.tsx', ok: true, target: 'login.tsx' }, minutesAgo(6.5), 'a1b2c3d4e5f6a7b8c');
    record(claude, { type: 'model.completed', text: 'Two error states are missing.', model: 'claude-sonnet-5' }, minutesAgo(6), 'a1b2c3d4e5f6a7b8c');
    record(claude, { type: 'turn.completed' }, minutesAgo(6), 'a1b2c3d4e5f6a7b8c');
    record(claude, { type: 'model.completed', text: 'The subagent found two missing error states.', model: 'claude-opus-5-5' }, minutesAgo(2));
    record(stale, { type: 'prompt.submitted', via: 'native', text: 'Summarize this week in the changelog.' }, minutesAgo(26));
    record(stale, { type: 'agent.state', state: 'working', activity: 'edit', target: 'CHANGELOG.md' }, minutesAgo(25.5));
    record(stale, { type: 'turn.completed', summary: 'Changelog updated.' }, minutesAgo(25));
    // A Claude Code session with every message form the transcript can show.
    const rich = observe('Polish the conversation view', workspaces[0], 1, { sourceId: 'claude-code', channel: 'hook', model: 'claude-opus-5-5' });
    record(rich, { type: 'session.started', control: 'observed', title: 'Polish the conversation view', model: 'claude-opus-5-5' }, minutesAgo(30));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<command-name>/compact</command-name>\n<command-message>compact</command-message>\n<command-args>keep the UI notes</command-args>' }, minutesAgo(29.5));
    record(rich, { type: 'prompt.submitted', via: 'native', text: `Make the session dialog easier to read.\n\n${Array.from({ length: 18 }, (_, index) => `${index + 1}. Requirement ${index + 1}: keep the transcript calm and readable.`).join('\n')}` }, minutesAgo(29));
    for (const [tool, kind, label, target] of [['Read', 'read', 'Read TranscriptView.tsx', 'TranscriptView.tsx'], ['Grep', 'search', 'Searched for "bubble"', 'bubble'], ['Edit', 'edit', 'Edited styles.css', 'styles.css'], ['Bash', 'test', 'Ran pnpm test', 'pnpm test']] as const) {
      record(rich, { type: 'tool.started', tool, kind, label, target }, minutesAgo(28));
      record(rich, { type: 'tool.completed', tool, kind, label, ok: true, target }, minutesAgo(27.5));
    }
    record(rich, { type: 'file.written', path: 'apps/web/src/chat/codeHighlight.ts', change: 'add' }, minutesAgo(27.4));
    record(rich, { type: 'file.written', path: 'apps/web/src/styles.css', change: 'update' }, minutesAgo(27.3));
    record(rich, { type: 'file.written', path: 'apps/web/src/chat/UserMessage.tsx', change: 'update' }, minutesAgo(27.2));
    record(rich, { type: 'file.written', path: 'apps/web/src/chat/UserMessage.tsx', change: 'update' }, minutesAgo(27.1));
    record(rich, { type: 'file.written', path: 'docs/old-notes.md', change: 'delete' }, minutesAgo(27.05));
    record(rich, { type: 'model.completed', model: 'claude-opus-5-5', text: [
      '## What changed', '', 'The transcript now reads like a document. **User turns** stay in a quiet bubble, and ~~raw tags~~ never appear.', '',
      '### Checklist', '', '- [x] Parse every notification field', '- [ ] Record the release notes', '- Tool runs', '  - Fold into one line', '  - Open on demand', '    1. Show each call', '    2. Keep the output', '',
      '> Keep the source intact.', '>', '> - Presentation only', '> - Originals stay one click away', '',
      '| Surface | Status | Notes |', '| :--- | :---: | ---: |', '| Chat | Done | 14 px |', '| Observe | Done | Same view |', '',
      '```ts', '// Highlighted without any dependency.', 'export const pick = async (id: string) => { return `agent ${id}`; };', '```', '',
      '```diff', '@@ -1,2 +1,2 @@', '-border-radius: 16px 16px 4px 16px;', '+border-radius: 18px;', '```', '', 'See `apps/web/src/chat/UserMessage.tsx` for the details.',
    ].join('\n') }, minutesAgo(27));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<bash-input>pnpm test chat</bash-input><bash-stdout> ✓ markdown.test.ts (64 tests)\n ✓ messagePresentation.test.ts (31 tests)\n</bash-stdout><bash-stderr></bash-stderr>' }, minutesAgo(26));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<task-notification>\n<task-id>a6f476de8d30e625a</task-id>\n<output-file>/tmp/mock/tasks/a6f476de8d30e625a.output</output-file>\n<status>completed</status>\n<summary>Agent "More traffic with intervals + truck" is waiting on its own background work</summary>\n<note>This agent stopped with background work of its own still running.</note>\n<result>Traffic intervals are in place and the truck route is live.\n\n- 3 new spawn points\n- `pnpm test` passes</result>\n<usage><subagent_tokens>324115</subagent_tokens><tool_uses>115</tool_uses><duration_ms>2073526</duration_ms></usage>\n</task-notification>' }, minutesAgo(25));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<task-notification>\n<task-id>b4so3seay</task-id>\n<status>failed</status>\n<summary>Background command "Run the checks" failed with exit code 143</summary>\n</task-notification>' }, minutesAgo(24));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<system-reminder>The date changed.</system-reminder>' }, minutesAgo(23));
    record(rich, { type: 'prompt.submitted', via: 'native', text: '<local-command-stdout>Compacted the conversation.</local-command-stdout>' }, minutesAgo(22.5));
    record(rich, { type: 'prompt.submitted', via: 'native', text: 'Bagus, sekarang samakan juga halaman Observe.\n[Image: source: /tmp/mock/review.png]' }, minutesAgo(22));
    record(rich, { type: 'model.completed', model: 'claude-opus-5-5', text: 'Selesai. Halaman Chat, Observe dan modal memakai tampilan yang sama.' }, minutesAgo(21));
    record(rich, { type: 'turn.completed' }, minutesAgo(21));
    // v0.0.43: a Claude Code agent that went silent mid-work 5 minutes ago (its app stopped without a final hook): "No response".
    const silent = observe('Migrate the settings store', workspaces[0], 5, { sourceId: 'claude-code', channel: 'hook', model: 'claude-sonnet-5' });
    record(silent, { type: 'prompt.submitted', via: 'native', text: 'Migrate the settings store to the new schema.' }, minutesAgo(7));
    record(silent, { type: 'agent.state', state: 'working', summary: 'Working on the migration' }, minutesAgo(5));
    // A Codex agent whose turn stopped on a used-up plan: "Out of tokens or quota".
    const quota = observe('Translate the onboarding copy', workspaces[1] ?? workspaces[0], 4, { sourceId: 'codex', channel: 'transcript', model: 'gpt-5.5' });
    record(quota, { type: 'prompt.submitted', via: 'native', text: 'Translate the onboarding copy to Indonesian.' }, minutesAgo(6));
    record(quota, { type: 'tool.started', tool: 'read', kind: 'read', label: 'Read onboarding.json', target: 'onboarding.json' }, minutesAgo(5.5));
    record(quota, { type: 'tool.completed', tool: 'read', kind: 'read', label: 'Read onboarding.json', ok: true, target: 'onboarding.json' }, minutesAgo(5));
    record(quota, { type: 'turn.failed', error: 'Out of tokens or quota', reason: 'quota' }, minutesAgo(4));
    record(quota, { type: 'agent.state', state: 'idle', phase: 'error', reason: 'quota' }, minutesAgo(4));
    // Earlier runs: subagents that finished hours ago, and a whole session from this morning. They are listed under "Earlier".
    for (const [index, label] of ['Scout', 'Mapper', 'Linter'].entries()) {
      const child = `thread-old-${index}`;
      record(live, { type: 'subagent.spawned', subagentId: child, label, role: 'explorer', model: 'gpt-5.5-mini' }, minutesAgo(190 - index));
      record(live, { type: 'agent.state', state: 'working', activity: 'search', summary: 'Searching the routes' }, minutesAgo(189 - index), child);
      record(live, { type: 'subagent.state', subagentId: child, state: 'offline' }, minutesAgo(180 - index));
    }
    const morning = observe('Tidy the test fixtures', workspaces[0], 300, { sourceId: 'claude-code', channel: 'hook', model: 'claude-opus-5-5' });
    record(morning, { type: 'prompt.submitted', via: 'native', text: 'Tidy the test fixtures.' }, minutesAgo(310));
    for (const child of ['b1c2d3e4f5a6b7c8d', 'c2d3e4f5a6b7c8d9e']) {
      record(morning, { type: 'subagent.spawned', subagentId: child, label: 'Clean fixtures', role: 'general-purpose', model: 'claude-sonnet-5' }, minutesAgo(305));
      record(morning, { type: 'tool.started', tool: 'Edit', kind: 'edit', label: 'Editing via Edit: fixtures.ts', target: 'fixtures.ts' }, minutesAgo(304), child);
    }
    record(morning, { type: 'turn.completed', summary: 'Fixtures tidied.' }, minutesAgo(300));
    record(live, { type: 'prompt.submitted', via: 'native', text: 'Split the router into route modules.' }, minutesAgo(40));
    record(live, { type: 'turn.completed', summary: 'Earlier work finished.' }, minutesAgo(39));
    // Live activity starts a few seconds after load, then loops like a real turn.
    const steps: ((at: Date) => void)[] = [
      at => record(live, { type: 'prompt.submitted', via: 'native', text: 'Now move the route guards into their own file.' }, at),
      at => record(live, { type: 'tool.started', tool: 'read', kind: 'read', label: 'Read src/router.ts', target: 'src/router.ts' }, at),
      at => record(live, { type: 'tool.completed', tool: 'read', kind: 'read', label: 'Read src/router.ts', ok: true, target: 'src/router.ts' }, at),
      at => record(live, { type: 'tool.started', tool: 'apply_patch', kind: 'edit', label: 'Edit src/guards.ts', target: 'src/guards.ts' }, at),
      at => record(live, { type: 'tool.completed', tool: 'apply_patch', kind: 'edit', label: 'Edit src/guards.ts', ok: true, target: 'src/guards.ts' }, at),
      at => record(live, { type: 'tool.started', tool: 'shell', kind: 'test', label: 'Run pnpm test router', target: 'pnpm test router' }, at),
      at => record(live, { type: 'agent.state', state: 'working', activity: 'read', summary: 'Read src/guards.ts', target: 'src/guards.ts' }, at, 'thread-child-a'),
      at => record(live, { type: 'tool.completed', tool: 'shell', kind: 'test', label: 'Run pnpm test router', ok: true }, at),
      at => record(live, { type: 'turn.completed', summary: 'Guards moved; router tests pass.' }, at),
    ];
    let index = 0;
    setTimeout(() => setInterval(() => { steps[index % steps.length]!(new Date()); index += 1; }, 5_000), 3_000);
  }

  const latency = () => sleep(140);
  /** v0.0.49 mock: uploaded attachments by id until a prompt takes them. */
  const mockAttachments = new Map<string, { sessionId: string; info: PromptAttachment }>();
  let hookPort = 4317;
  let hookLabelsOnly = false;
  let hermesDashboardUrl: string | undefined;
  const defaultIgnoreFolders = ['~/.claude-mem'];
  let ignoreFolders = [...defaultIgnoreFolders];
  const lastHookEvents: Record<AgentAppId, string | undefined> = {
    codex: options.observed ? iso() : undefined,
    claude: undefined,
    gemini: undefined,
    antigravity: undefined,
    hermes: undefined,
  };
  const appConnections: Record<AgentAppId, AgentAppConnection> = {
    codex: {
      app: 'codex',
      label: 'Codex',
      supported: true,
      installed: true,
      version: '0.161.0',
      versionVerified: true,
      configPath: '/Users/you/.codex/config.toml',
      connected: false,
      state: 'not-connected',
      trust: { status: 'unknown', trusted: 0, total: 0 },
      warnings: [],
      events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'PostToolUse', 'SubagentStart', 'SubagentStop', 'Stop', 'SessionEnd'],
      ...(lastHookEvents.codex ? { lastEventAt: lastHookEvents.codex } : {}),
      hostRunning: true,
      port: hookPort,
    },
    claude: {
      app: 'claude',
      label: 'Claude Code',
      supported: true,
      installed: true,
      version: '2.1.295',
      versionVerified: true,
      configPath: '/Users/you/.claude/settings.json',
      connected: false,
      state: 'not-connected',
      trust: { status: 'not-applicable', trusted: 0, total: 0 },
      warnings: [],
      events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'PermissionRequest', 'SubagentStart', 'SubagentStop', 'Stop'],
      hostRunning: true,
      port: hookPort,
    },
    gemini: {
      app: 'gemini',
      label: 'Gemini CLI',
      supported: true,
      installed: true,
      version: '0.5.0',
      versionVerified: true,
      configPath: '/Users/you/.gemini/settings.json',
      connected: false,
      state: 'not-connected',
      trust: { status: 'not-applicable', trusted: 0, total: 0 },
      warnings: [],
      events: ['SessionStart', 'SessionEnd', 'BeforeAgent', 'AfterAgent', 'BeforeTool', 'AfterTool', 'Notification'],
      hostRunning: true,
      port: hookPort,
    },
    antigravity: {
      app: 'antigravity',
      label: 'Antigravity',
      supported: true,
      installed: true,
      version: '2.0.0',
      versionVerified: true,
      configPath: '/Users/you/.gemini/config/hooks.json',
      connected: false,
      state: 'not-connected',
      trust: { status: 'not-applicable', trusted: 0, total: 0 },
      warnings: [],
      events: ['PreInvocation', 'PostInvocation', 'PreToolUse', 'PostToolUse', 'Stop'],
      hostRunning: true,
      port: hookPort,
    },
    hermes: {
      app: 'hermes',
      label: 'Hermes Agent',
      supported: true,
      installed: Boolean(options.hermes),
      ...(options.hermes ? { version: '0.4.2', versionVerified: true } : {}),
      configPath: '/Users/you/.hermes/config.yaml',
      connected: false,
      state: 'not-connected',
      trust: { status: 'not-applicable', trusted: 0, total: 0 },
      warnings: [],
      events: ['on_session_start', 'on_session_end', 'pre_llm_call', 'pre_tool_call', 'post_tool_call', 'subagent_start', 'subagent_stop', 'pre_approval_request'],
      hostRunning: true,
      port: hookPort,
    },
  };

  return {
    async getState() { await latency(); return snapshot(); },
    async getProfile() { await latency(); return structuredClone(profile); },
    async saveProfile(patch) {
      await latency();
      if (!patch || typeof patch !== 'object') throw new Error('The profile change is not valid.');
      const next: UserProfile = { ...profile, preferences: { ...profile.preferences }, updatedAt: iso() };
      if (patch.displayName !== undefined) {
        const name = (patch.displayName ?? '').replace(/\s+/g, ' ').trim();
        if (name.length > 80) throw new Error('Use a display name of up to 80 characters without control characters.');
        if (name) next.displayName = name; else delete next.displayName;
      }
      for (const [key, value] of Object.entries(patch.preferences ?? {})) {
        if (!(PREFERENCE_KEYS as readonly string[]).includes(key)) throw new Error(`Unknown interface preference: ${key}.`);
        const field = key as keyof ProfilePreferences;
        if (value === null || value === undefined) { delete next.preferences[field]; continue; }
        if (field === 'language' ? value !== 'en' && value !== 'id' : !/^[a-z0-9][a-z0-9-]{0,39}$/.test(String(value))) throw new Error(`The ${key} preference is not valid.`);
        (next.preferences as Record<string, string>)[field] = String(value);
      }
      profile = next;
      return structuredClone(profile);
    },
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
    async browseDirectories(requested) {
      await latency();
      const current = requested || HOME;
      return { path: current, homePath: HOME, ...(current !== '/' ? { parentPath: current.slice(0, current.lastIndexOf('/')) || '/' } : {}),
        roots: [{ name: '/', path: '/' }], truncated: false,
        entries: current === HOME ? [{ name: 'demo-app', path: `${HOME}/demo-app` }, { name: 'projects', path: `${HOME}/projects` }] : [] };
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
      if (input.missionConnectionIds !== undefined && (!Array.isArray(input.missionConnectionIds) || input.missionConnectionIds.length > 8
        || new Set(input.missionConnectionIds).size !== input.missionConnectionIds.length
        || input.missionConnectionIds.some(id => !state.connections.some(connection => connection.id === id)))) throw new Error('Choose up to 8 saved connections.');
      const existing = input.id ? state.workspaces.find(item => item.id === input.id) : undefined;
      const workspace = existing ?? addWorkspace(input.name, input.projectLocation, input.connectionId ?? '', input.permissions);
      Object.assign(workspace, { name: input.name, projectLocation: input.projectLocation, providerProfileId: input.connectionId ?? '', permissions: input.permissions, updatedAt: iso() });
      for (const key of ['runtimeId', 'runtimeProfileId', 'runtimeModel'] as const) delete workspace[key];
      if (input.runtimeId === 'hermes') Object.assign(workspace, { runtimeId: 'hermes', runtimeProfileId: input.runtimeProfileId || 'default', ...(input.runtimeModel ? { runtimeModel: input.runtimeModel } : {}) });
      if (input.missionConnectionIds !== undefined) workspace.missionConnectionIds = [...input.missionConnectionIds];
      // ADR 0028: omission keeps the gate, `null` removes it, anything else is validated like on the host.
      if (input.integrationGate === null) delete workspace.integrationGate;
      else if (input.integrationGate !== undefined) workspace.integrationGate = normalizeIntegrationGate(input.integrationGate);
      return snapshot();
    },
    async deleteWorkspace(id) {
      await latency();
      state.workspaces = state.workspaces.filter(item => item.id !== id);
      state.sessions = state.sessions.filter(item => item.workspaceId !== id);
      return snapshot();
    },
    async setWorkspaceMissionConnections(workspaceId, connectionIds) {
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace || workspace.runtimeId === 'hermes') throw new Error('Choose an Extalia Native workspace.');
      if (!Array.isArray(connectionIds) || connectionIds.length > 8 || new Set(connectionIds).size !== connectionIds.length
        || connectionIds.some(id => !state.connections.some(connection => connection.id === id))) throw new Error('Choose up to 8 saved connections.');
      workspace.missionConnectionIds = [...connectionIds];
      return snapshot();
    },
    async completeSetup(mode = 'managed') {
      await latency();
      if (mode !== 'managed' && mode !== 'observe') throw new Error('Invalid workflow mode.');
      if (mode === 'managed') {
        const native = state.workspaces.some(item => (item.runtimeId ?? 'extalia-native') === 'extalia-native');
        if (native && !state.connections.length) throw new Error('Add a model connection first.');
        if (!state.workspaces.length && !state.connections.length && !options.hermes) throw new Error('Add a model connection or install Hermes Agent first.');
      }
      state.setupComplete = true; state.workflow = mode; return snapshot();
    },
    async setWorkflow(mode) { state.workflow = mode; state.setupComplete = state.setupComplete || mode === 'observe'; return snapshot(); },
    async observeImports() { throw new Error('Live native observation needs the Desktop host or local Bridge. Mock histories cannot be watched.'); },
    async observationSession() { throw new Error('No native transcript is available in this mock host.'); },
    async setObservation() { throw new Error('No native transcript is available in this mock host.'); },
    async setAutoWatch() { throw new Error('Watching new sessions automatically needs the Desktop host or local Bridge.'); },
    async createSession(workspaceId, sessionOptions) {
      await latency();
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      const { team, ...checked } = normalizeSessionOptions(sessionOptions);
      const summary = addSession(workspace);
      if (workspace.runtimeId === 'hermes') summary.runtime = { id: 'hermes', profile: workspace.runtimeProfileId || 'default' };
      if (Object.keys(checked).length) summary.options = checked;
      // v0.0.47: as on a real host, a new session copies the workspace's default team unless given one (or `team: null`).
      const own = initialSessionTeam(workspace.team, team);
      if (own) setTeam(summary, withDistinctMemberNames(own, new Set(officeNames().map(name => name.toLowerCase())), summary.id));
      return structuredClone(summary);
    },
    async setSessionOptions(sessionId, sessionOptions) {
      await latency();
      const summary = session(sessionId);
      if (summary.control !== 'managed') throw new Error('Observed sessions run in their own app; choose the model there.');
      const { team: _team, ...checked } = normalizeSessionOptions(sessionOptions);
      if (Object.keys(checked).length) summary.options = checked; else delete summary.options;
      return structuredClone(summary);
    },
    // Sample model lists (nothing is contacted); the effort control is offered for every mock workspace.
    async modelChoices(workspaceId): Promise<ModelChoices> {
      await latency();
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      return modelChoicesFor(workspace);
    },
    async getSessionTeam(sessionId) {
      await latency();
      const team = teams.get(session(sessionId).id);
      return team && structuredClone(team);
    },
    async saveWorkspaceTeam(workspaceId, team) {
      await latency();
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      const checked = normalizeAgentTeam(team);
      if (checked) workspace.team = { ...checked, updatedAt: iso() }; else delete workspace.team;
      workspace.updatedAt = iso();
      storeWorkspaceTeams();
      return snapshot();
    },
    async saveSessionTeam(sessionId, team) {
      await latency();
      const summary = session(sessionId);
      if (summary.control !== 'managed') throw new Error('Observed sessions run in their own app; a subagent team needs a managed session.');
      setTeam(summary, normalizeAgentTeam(team));
      const saved = teams.get(sessionId);
      return saved && structuredClone(saved);
    },
    // A deterministic split (nothing is contacted), like the real host's fallback when the model cannot plan.
    // As on a real host the goal and the models are optional: without models the plan picks from the workspace's.
    async planTeam(workspaceId, request) {
      await latency();
      await sleep(400);
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      const checked = normalizeTeamPlanRequest(request);
      const choices = modelChoicesFor(workspace);
      const recentTitles = state.sessions.filter(item => item.workspaceId === workspaceId && item.title).map(item => item.title).slice(0, 5);
      const planned = {
        ...checked, context: { workspace: workspace.name, recentTitles },
        ...(checked.allowedModels.length ? {} : { candidateModels: pickTeamModels(choices.models, choices.defaultModel ? [choices.defaultModel] : []) }),
      };
      const members = planTeamHeuristic(planned, () => nextId('member'), officeNames());
      const choosing = !checked.allowedModels.length && Boolean(planned.candidateModels?.length);
      return { members, source: 'heuristic', note: 'A standard split was used: the mock host does not ask a model.', ...(choosing ? { allowedModels: planModelOrder(members) } : {}) };
    },
    async continueSession(source, workspaceId) {
      await latency();
      const workspace = state.workspaces.find(item => item.id === workspaceId);
      if (!workspace) throw new Error('This workspace no longer exists.');
      if (source.kind !== 'library') throw new Error('No native transcript is available in this mock host.');
      const conversation = await imports.methods.librarySession(source.id);
      const summary = addSession(workspace, conversation.title);
      const own = initialSessionTeam(workspace.team, undefined);
      if (own) setTeam(summary, withDistinctMemberNames(own, new Set(officeNames().map(name => name.toLowerCase())), summary.id));
      summary.continuedFrom = { sourceId: conversation.provenance.sourceId, title: conversation.title };
      const origin = { runtime: conversation.provenance.sourceId, channel: 'import' as const, adapter: 'continuation' };
      for (const message of conversation.messages.filter(item => item.role === 'user' || item.role === 'assistant').slice(-20)) {
        const list = events.get(summary.id)!;
        const event = createEvent({ sessionId: summary.id, source: origin, agentId: origin.runtime, body: message.role === 'user'
          ? { type: 'prompt.submitted', text: message.content, via: 'native' } : { type: 'model.completed', text: message.content } });
        event.seq = list.length + 1;
        list.push(event);
        for (const listener of listeners) listener(event);
      }
      return structuredClone(summary);
    },
    async renameSession(sessionId, title) { await latency(); session(sessionId).title = title.trim(); return snapshot(); },
    async deleteSession(sessionId) {
      await latency();
      const run = runs.get(sessionId);
      if (run) run.cancelled = true;
      for (const request of pending.values()) if (request.sessionId === sessionId) request.resolve(CANCELLED);
      state.sessions = state.sessions.filter(item => item.id !== sessionId);
      events.delete(sessionId);
      teams.delete(sessionId);
      return snapshot();
    },
    async sessionEvents(sessionId) { await latency(); return structuredClone(events.get(sessionId) ?? []); },
    async planNativeMission(sessionId, request) { await latency(); await sleep(600); return missionHost.plan(sessionId, request); },
    async startNativeMission(sessionId, request) { await latency(); return missionHost.start(sessionId, request); },
    async nativeMissionRun(sessionId, missionId) { await latency(); return missionHost.run(sessionId, missionId); },
    async listNativeMissions(sessionId) { await latency(); return missionHost.list(sessionId); },
    async listWorktrees() { await latency(); return worktreeHost.list(); },
    async worktreeStatus(worktreeId) { await latency(); return worktreeHost.status(worktreeId); },
    async worktreeDiff(worktreeId) { await latency(); return worktreeHost.diff(worktreeId); },
    async worktreeOrphans() { await latency(); return worktreeHost.orphans(); },
    async removeWorktree(worktreeId, confirm) { await latency(); worktreeHost.remove(worktreeId, confirm); },
    async proposeIntegration(worktreeId, request) { await latency(); await sleep(700); return worktreeHost.propose(worktreeId, request); },
    async integrationProposals() { await latency(); return worktreeHost.proposals(); },
    async applyIntegration(proposalId, approval) { await latency(); return worktreeHost.apply(proposalId, approval); },
    async uploadAttachment(sessionId, file) {
      await latency();
      session(sessionId);
      const { kind, mimeType } = classifyAttachment(file.name, file.mimeType);
      const size = Math.floor(file.data.length * 3 / 4);
      const name = sanitizeAttachmentName(file.name);
      if (size > attachmentLimit(kind)) throw new Error(`${name} is larger than ${Math.round(attachmentLimit(kind) / (1024 * 1024))} MB.`);
      const info: PromptAttachment = { id: nextId('attachment'), name, mimeType, size, kind };
      mockAttachments.set(info.id, { sessionId, info });
      return structuredClone(info);
    },
    async removeAttachment(sessionId, attachmentId) {
      await latency();
      if (mockAttachments.get(attachmentId)?.sessionId === sessionId) mockAttachments.delete(attachmentId);
    },
    async attachmentPreview(_sessionId, ref) {
      await latency();
      const index = MOCK_IMAGE_REFS.indexOf(ref);
      return index < 0 ? undefined : mockScreenshot(index);
    },
    async sendPrompt(sessionId, text, promptOptions) {
      await latency();
      if (normalizePromptLearnSkill(promptOptions) || /^\/learn-skill(?:\s|$)/.test(text.trim())) throw new Error('Skill learning requires the native skill registry; it is not available in this preview.');
      const summary = session(sessionId);
      if (summary.running) throw new Error('The agent is still working on the previous prompt.');
      const ids = promptOptions?.attachmentIds ?? [];
      if (ids.length > 10) throw new Error('Up to 10 files per message.');
      const attached = ids.map(id => {
        const entry = mockAttachments.get(id);
        if (!entry || entry.sessionId !== sessionId) throw new Error('This attachment is no longer available. Attach the file again.');
        return entry.info;
      });
      for (const id of ids) mockAttachments.delete(id);
      // A team written into the prompt becomes the session's team before the turn, as on a real host.
      const fromPrompt = applyPromptTeam(summary, text);
      startTurn(summary, text, undefined, attached.map(info => ({ name: info.name, kind: info.kind, size: info.size })));
      if (fromPrompt) for (const member of teams.get(sessionId)?.members ?? []) emit(sessionId, { type: 'subagent.spawned', subagentId: member.id, role: member.role, label: member.name });
    },
    async resolveApproval(sessionId, approvalId, decision) {
      await latency();
      const request = pending.get(approvalId);
      if (!request || request.sessionId !== sessionId) throw new Error('This approval is no longer pending.');
      request.resolve(decision);
    },
    async cancel(sessionId) {
      await latency();
      if (missionHost.cancel(sessionId)) return;
      const run = runs.get(sessionId);
      if (!run || run.cancelled) return;
      run.cancelled = true;
      emit(sessionId, { type: 'user.intervention', action: 'cancel' });
      for (const request of pending.values()) if (request.sessionId === sessionId) request.resolve(CANCELLED);
    },
    // Hermes Agent is reported as installed only with `?hermes`; nothing real is started.
    async runtimes() {
      return [{ id: 'extalia-native', available: true, profiles: [] }, { id: 'hermes', available: Boolean(options.hermes), profiles: options.hermes ? ['default', 'work'] : [] }];
    },
    // A local router stand-in, so the Hermes model list can be tried without Hermes.
    async hermesModels(profile) {
      await latency();
      return { profile, defaultModel: MOCK_HERMES_DEFAULT_MODEL, provider: 'custom', endpoint: 'localhost:20128', source: 'endpoint' as const, models: [...MOCK_HERMES_MODELS] };
    },
    async agentAppConnections(): Promise<AgentAppConnection[]> {
      await latency();
      return (['codex', 'claude', 'gemini', 'antigravity', 'hermes'] as const).map(id => {
        const entry = appConnections[id];
        const lastEventAt = lastHookEvents[id] ?? entry.lastEventAt;
        return structuredClone({
          ...entry,
          port: hookPort,
          ...(lastEventAt ? { lastEventAt } : {}),
        });
      });
    },
    async planAgentAppConnect(app, connectOptions?: AgentAppConnectOptions): Promise<AgentAppConnectPlan> {
      await latency();
      const entry = appConnections[app];
      const port = connectOptions?.port ?? hookPort;
      const backupRoot = `${state.storage.dataDirectory}/backups/${app}`;
      const forwarderPath = `${state.storage.dataDirectory}/hooks/forward.mjs`;
      if (!entry.supported) {
        return {
          app,
          supported: false,
          installed: entry.installed,
          ...(entry.version ? { version: entry.version } : {}),
          ...(entry.versionVerified !== undefined ? { versionVerified: entry.versionVerified } : {}),
          ...(entry.configPath ? { configPath: entry.configPath } : {}),
          changes: false,
          diff: '',
          events: [],
          needsTrust: false,
          warnings: [...entry.warnings],
          backupRoot,
          forwarderPath,
          port,
          restartHint: '',
        };
      }
      const changes = !entry.connected || Boolean(connectOptions?.rotate) || port !== entry.port;
      const diff = changes
        ? [
            `--- a${entry.configPath}`,
            `+++ b${entry.configPath}`,
            '@@ -1,1 +1,7 @@',
            ' {',
            `+  // extalia:managed (${entry.events.join(', ')})`,
            `+  "url": "http://127.0.0.1:${port}/api/hooks/${app}",`,
            '+  "token": "extalia_hook_••••••••"',
            ' }',
          ].join('\n')
        : '';
      const needsTrust = app === 'codex' && (!entry.connected || entry.trust.status !== 'trusted');
      const restartHint = app === 'codex'
        ? 'Restart Codex so it loads the new hooks. In Codex, open /hooks and approve the Extalia hooks.'
        : app === 'gemini'
          ? 'Restart Gemini CLI so it loads the new hooks.'
          : app === 'antigravity'
            ? 'Restart Antigravity (or start a new conversation) so it loads the new hooks.'
            : app === 'hermes'
              ? 'Restart running Hermes sessions so they load the outbound webhook configuration.'
              : 'Restart Claude Code so it loads the new hooks.';
      return {
        app,
        supported: true,
        installed: entry.installed,
        ...(entry.version ? { version: entry.version } : {}),
        ...(entry.versionVerified !== undefined ? { versionVerified: entry.versionVerified } : {}),
        ...(entry.configPath ? { configPath: entry.configPath } : {}),
        changes,
        diff,
        events: [...entry.events],
        needsTrust,
        ...(app === 'codex' ? { trustHint: 'In Codex, open /hooks and approve the Extalia hooks.' } : {}),
        warnings: [...entry.warnings],
        backupRoot,
        forwarderPath,
        port,
        restartHint,
      };
    },
    async applyAgentAppConnect(app, connectOptions?: AgentAppConnectOptions): Promise<AgentAppConnectResult> {
      await latency();
      const entry = appConnections[app];
      if (!entry.supported) throw new Error(`${entry.label} hook connection is not supported yet.`);
      if (connectOptions?.port) hookPort = connectOptions.port;
      const changed = !entry.connected || Boolean(connectOptions?.rotate) || entry.port !== hookPort;
      entry.connected = true;
      entry.state = 'connected';
      entry.port = hookPort;
      if (app === 'codex') {
        entry.trust = connectOptions?.trust
          ? { status: 'trusted', trusted: entry.events.length, total: entry.events.length }
          : { status: 'untrusted', trusted: 0, total: entry.events.length };
      } else {
        entry.trust = { status: 'not-applicable', trusted: 0, total: 0 };
      }
      const eventTime = iso();
      lastHookEvents[app] = eventTime;
      entry.lastEventAt = eventTime;
      const restartHint = app === 'codex'
        ? 'Restart Codex so it loads the new hooks. In Codex, open /hooks and approve the Extalia hooks.'
        : app === 'gemini'
          ? 'Restart Gemini CLI so it loads the new hooks.'
          : app === 'antigravity'
            ? 'Restart Antigravity (or start a new conversation) so it loads the new hooks.'
            : app === 'hermes'
              ? 'Restart running Hermes sessions so they load the outbound webhook configuration.'
              : 'Restart Claude Code so it loads the new hooks.';
      return {
        app,
        changed,
        configPath: entry.configPath ?? `/Users/you/.${app}/settings.json`,
        ...(changed ? { backupPath: `${state.storage.dataDirectory}/backups/${app}/backup-${++counter}` } : {}),
        undoCommand: `npx -y extalia-vo@latest disconnect ${app}`,
        trust: structuredClone(entry.trust),
        test: { ok: true, status: 'delivered', message: 'Synthetic hook event delivered to the running host.' },
        restartHint,
        warnings: [...entry.warnings],
      };
    },
    async disconnectAgentApp(app): Promise<AgentAppDisconnectResult> {
      await latency();
      const entry = appConnections[app];
      const changed = entry.connected || entry.state !== 'not-connected';
      const removed = changed ? entry.events.length : 0;
      entry.connected = false;
      entry.state = 'not-connected';
      entry.trust = app === 'codex'
        ? { status: 'unknown', trusted: 0, total: 0 }
        : { status: 'not-applicable', trusted: 0, total: 0 };
      delete entry.lastEventAt;
      lastHookEvents[app] = undefined;
      return {
        app,
        changed,
        ...(entry.configPath ? { configPath: entry.configPath } : {}),
        restoredExactly: changed,
        removed,
        warnings: [],
      };
    },
    async testAgentAppConnection(app): Promise<AgentAppTestResult> {
      await latency();
      const entry = appConnections[app];
      if (!entry.supported) {
        return { ok: false, status: 'skipped', message: `${entry.label} hooks are not supported yet.` };
      }
      const eventTime = iso();
      lastHookEvents[app] = eventTime;
      entry.lastEventAt = eventTime;
      return { ok: true, status: 'delivered', message: 'Synthetic hook event delivered to the running host.' };
    },
    async hookIngest(): Promise<HookIngestStatus> {
      await latency();
      return {
        port: hookPort,
        tokenPath: `${state.storage.dataDirectory}/hooks/token`,
        lastEvents: { ...lastHookEvents },
        labelsOnly: hookLabelsOnly,
        ...(hermesDashboardUrl ? { hermesDashboardUrl } : {}),
        ignoreFolders: [...ignoreFolders], defaultIgnoreFolders: [...defaultIgnoreFolders],
      };
    },
    async setHookPrivacy(privacyOptions) {
      await latency();
      if (privacyOptions.labelsOnly !== undefined) hookLabelsOnly = Boolean(privacyOptions.labelsOnly);
      if (privacyOptions.hermesDashboardUrl !== undefined) {
        const trimmed = privacyOptions.hermesDashboardUrl?.trim() ?? '';
        hermesDashboardUrl = trimmed || undefined;
      }
      if (privacyOptions.ignoreFolders !== undefined) {
        if (privacyOptions.ignoreFolders === null) ignoreFolders = [...defaultIgnoreFolders];
        else {
          const next = privacyOptions.ignoreFolders.map(folder => folder.trim().replace(/(.)[\\/]+$/, '$1')).filter(Boolean);
          if (next.length > 50 || next.some(folder => !(folder === '~' || /^~[\\/]/.test(folder) || /^(?:\/|[A-Za-z]:[\\/])/.test(folder)))) throw new Error('Enter a full folder path or one starting with ~/.');
          ignoreFolders = [...new Set(next)];
        }
      }
      return {
        port: hookPort,
        tokenPath: `${state.storage.dataDirectory}/hooks/token`,
        lastEvents: { ...lastHookEvents },
        labelsOnly: hookLabelsOnly,
        ...(hermesDashboardUrl ? { hermesDashboardUrl } : {}),
        ignoreFolders: [...ignoreFolders], defaultIgnoreFolders: [...defaultIgnoreFolders],
      };
    },
    ...imports.methods,
    ...createMockAppearances(() => new Set(state.sessions.map(item => item.id)), latency),
    ...createMockWorkspaceInspection(id => { if (!state.workspaces.some(item => item.id === id)) throw new Error('That workspace no longer exists.'); }, latency),
    ...createMockWorkspaceSkills(id => { if (!state.workspaces.some(item => item.id === id)) throw new Error('That workspace no longer exists.'); }, latency),
    ...createMockSkillRegistry(options.skills ?? 'registry', latency),
    ...createMockBuiltinSkills(latency),
    ...(options.seed === 'ready' && options.knowledge !== 'off' ? createMockKnowledge(options.knowledge === 'empty' || options.knowledge === 'large' ? options.knowledge : 'sample', latency, Date.now(), { conflict: options.knowledge === 'conflict' }) : {}),
    ...(options.seed === 'ready' && options.knowledge !== 'off' ? createMockKnowledgeSettings(latency) : {}),
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

function createMockUpdater(options: MockOptions): UpdateCapability {
  const listeners = new Set<(status: UpdateStatus) => void>();
  const latest = '0.2.0';
  const base = { current: APP_VERSION, channel: 'stable' as const, ...(options.host === 'bridge' ? { command: 'npm i -g extalia-vo@latest' } : {}) };
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
    info: { kind: desktop ? 'desktop' : 'web', appVersion: APP_VERSION, os: 'macos', ...(desktop ? { arch: 'arm64', shellVersion: 'mock' } : {}) },
    capabilities: {
      agents: createMockAgents(options),
      updater: createMockUpdater(options),
      // The mock only reloads the page; nothing is really restarted.
      restart: { kind: desktop ? 'relaunch' : 'reload', restart: async () => { location.reload(); } },
      // v0.0.48: approval notifications use the browser API here (shown only after the Settings opt-in).
      ...(browserNotifications() ? { notifications: browserNotifications() } : {}),
      ...(desktop ? { filesystem: { selectDirectory: async () => { await sleep(200); return { name: 'demo-app', path: `${HOME}/demo-app` }; } } } : {}),
    },
  };
}

/** Image references of the observed demo prompts (SHA-256 shaped). */
const MOCK_IMAGE_REFS = ['a'.repeat(63) + '1', 'b'.repeat(63) + '2'];

/** A drawn stand-in screenshot for a demo attachment; nothing when the page cannot draw (tests). */
function mockScreenshot(index: number): { mimeType: 'image/png'; data: string } | undefined {
  if (typeof document === 'undefined') return undefined;
  const canvas = document.createElement('canvas');
  canvas.width = 480; canvas.height = 300;
  const context = canvas.getContext('2d');
  if (!context) return undefined;
  context.fillStyle = index ? '#eef3f8' : '#fbefef'; context.fillRect(0, 0, 480, 300);
  context.fillStyle = '#ffffff'; context.fillRect(90, 50, 300, 200);
  context.strokeStyle = '#c9d2dc'; context.strokeRect(90, 50, 300, 200);
  context.fillStyle = '#1f2a37'; context.font = '600 18px sans-serif'; context.fillText(index ? 'Create account' : 'Sign in', 110, 85);
  for (const y of [110, 160]) { context.strokeStyle = '#9aa5b1'; context.strokeRect(110, y, 260, 32); }
  if (!index) { context.fillStyle = '#c0392b'; context.font = '13px sans-serif'; context.fillText('Something went wrong', 110, 215); }
  const url = canvas.toDataURL('image/png');
  return { mimeType: 'image/png', data: url.slice(url.indexOf(',') + 1) };
}

