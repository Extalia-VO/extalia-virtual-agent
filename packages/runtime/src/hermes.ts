import { EFFORTS, RUNTIME_PROFILE_PATTERN, safeLabel, safeText, type AgentTeam, type Effort, type TeamMember } from '@extalia/core';
import { classifyTool, type ActivityKind, type EventBody, type FileChangeKind, type Usage } from '@extalia/protocol';

/**
 * Hermes Agent as a managed runtime: command line and stream-json mapping.
 *
 * Verified against Hermes Agent v0.21 (`hermes chat --help` and its
 * `hermes_cli/stream_json.py`). One prompt is one process:
 * `hermes -p <profile> chat --query-file - --oneshot --format stream-json …`
 * reads the prompt from stdin and writes one JSON object per stdout line:
 * `system/init` (model, session_id) → `text` deltas, `tool_use`, `tool_result`
 * → one terminal `result` (session_id, exit_code, text, tokens, error).
 * Diagnostics go to stderr. Without a TTY Hermes runs in single-query mode and
 * answers its own approval prompts with `approvals.single_query_mode`
 * (default `deny`); `--yolo` bypasses them.
 *
 * Process handling lives in the host; this module only builds arguments and
 * maps lines to protocol bodies. The host wraps bodies in envelopes, so ids and
 * sequence numbers stay unique across turns.
 */

export const HERMES_VERIFIED_VERSIONS = ['0.21'] as const;

/** Hermes profile ids (`default` or a directory under `$HERMES_HOME/profiles`). */
export const HERMES_PROFILE_PATTERN = RUNTIME_PROFILE_PATTERN;
/** Hermes session ids as printed by Hermes; anything else is never passed back to `--resume`. */
export const HERMES_SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
/** Session source tag, so Hermes can tell Extalia's sessions apart. */
export const HERMES_SOURCE_TAG = 'extalia';

export interface HermesPlanInput {
  cwd: string;
  prompt: string;
  /** Hermes profile; `default` is passed explicitly so a sticky `hermes profile use` choice does not apply. */
  profile?: string;
  model?: string;
  provider?: string;
  /** Reasoning effort (`--reasoning`, Hermes Agent versions that list it in `hermes chat --help`). */
  reasoning?: Effort;
  resumeSessionId?: string;
  /** Bypass Hermes' dangerous-command approvals. Only for workspaces that allow edits and commands without asking. */
  yolo?: boolean;
}

export interface HermesPlanResult {
  args: readonly string[];
  stdin: string;
}

export interface HermesToolOutput {
  ok: boolean;
  output?: string;
  exitCode?: number;
  files: readonly { path: string; change: FileChangeKind }[];
}

const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && Boolean(item)) : [];

/** Parses a Hermes tool result: JSON from most tools (`output`, `exit_code`, `files_modified`, …) or plain text. */
export function parseHermesToolOutput(raw: unknown, isError: boolean): HermesToolOutput {
  const text = typeof raw === 'string' ? raw : '';
  let data: Record<string, unknown> | undefined;
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed as Record<string, unknown>;
  } catch {
    // Plain text, or JSON cut off by Hermes' output cap.
  }
  if (!data) return { ok: !isError, files: [], ...(text ? { output: text } : {}) };

  const exitCode = [data.exit_code, data.returncode, data.exitCode].find(value => typeof value === 'number') as number | undefined;
  const output = [data.output, data.stdout, data.content, data.error].find(value => typeof value === 'string' && value) as string | undefined;
  const files = [
    ...strings(data.files_created).map(path => ({ path, change: 'add' as const })),
    ...strings(data.files_modified).map(path => ({ path, change: 'update' as const })),
    ...strings(data.files_deleted).map(path => ({ path, change: 'delete' as const })),
  ];
  if (!files.length && typeof data.resolved_path === 'string' && data.resolved_path && data.success === true) files.push({ path: data.resolved_path, change: 'update' });
  const ok = !isError && !data.error && data.success !== false && (exitCode === undefined || exitCode === 0);
  return { ok, files, ...(output ? { output } : {}), ...(exitCode !== undefined ? { exitCode } : {}) };
}

/** The terminal `result` record. */
export interface HermesResult {
  exitCode: number;
  error?: string;
  usage?: Usage;
}

/** What one stdout line contributed; `undefined` for lines that are not Hermes stream records. */
export interface HermesStreamUpdate {
  events: EventBody[];
  /** Hermes' own session id (from `init` or `result`), for `--resume` on the next prompt. */
  sessionId?: string;
  model?: string;
  result?: HermesResult;
}

export interface HermesStreamOptions {
  /** Ids for tool calls Hermes does not number itself. */
  newId?: () => string;
  /**
   * The session's enabled subagent team: a `delegate_task` call whose task names a member
   * (as the team brief asks) is shown as that member's `subagent.spawned`.
   */
  team?: readonly Pick<TeamMember, 'id' | 'name' | 'role'>[];
}

/** Hermes' own delegation tool (`tools/delegate_tool.py`). */
export const HERMES_DELEGATE_TOOL = 'delegate_task';

const clip = (value: string, limit: number) => {
  const clean = value.replace(/\s+/g, ' ').trim();
  return clean.length > limit ? `${clean.slice(0, limit - 1).trimEnd()}…` : clean;
};

/**
 * The team brief put before a Hermes prompt when the session's team is enabled.
 * v0.0.39: the lead delegates only the parts that concern a member's role.
 * Hermes cannot run a member on its own model (its children all use
 * `delegation.model` or the lead's), so the brief asks the lead to hand each
 * member's part to `delegate_task` with the member's name, persona, task and
 * scope written into the task; the member models are not mentioned.
 */
export function hermesTeamBrief(team: Pick<AgentTeam, 'members' | 'rules' | 'goal'>, options: { fromPrompt?: boolean } = {}): string {
  const members = team.members.map((member, index) => {
    const write = member.access === 'write';
    const parts = [
      `${index + 1}. ${member.name} — ${member.role} (${write ? `may edit${member.scope?.length ? ` only ${member.scope.join(', ')}` : ' within the workspace'}` : 'read-only'}`
        + `${member.forbidden?.length ? `; never edit ${member.forbidden.join(', ')}` : ''})`,
      ...(member.task ? [`   Task: ${clip(member.task, 500)}`] : []),
      ...(member.soul ? [`   Persona: ${clip(member.soul, 300)}`] : []),
    ];
    return parts.join('\n');
  });
  const rules = (team.rules ?? []).map(rule => `- ${clip(rule, 300)}`);
  return [
    '<extalia-team>',
    `You lead a subagent team set up in Extalia${options.fromPrompt ? ' from this prompt' : ''}. Delegate only when this request actually concerns a member's role, task or scope`,
    '(or the user asks for a member or the team); the user does not need to name them. Handle small, quick or unrelated requests (questions, chat, tiny edits,',
    'anything no member\'s role covers) yourself, without delegating. When parts of the request do match members, pick every member whose role the work spans and',
    `hand each one its part with your ${HERMES_DELEGATE_TOOL} tool (one \`tasks\` entry per chosen member; independent read-only parts in one batch).`,
    'Start every task\'s goal with "[<member name> · <role>]", then a specific, self-contained goal; put the member\'s persona, task, scope, forbidden paths and the rules below in its context.',
    'Members that edit files run one at a time (separate calls), never in the same batch as another editing member. Read-only members must not change files.',
    'Combine their results, check them, and give the final answer yourself. If delegation is unavailable, do the members\' parts yourself in this order.',
    ...(team.goal ? [`Team goal: ${clip(team.goal, 300)}`] : []),
    'Members:',
    ...members,
    ...(rules.length ? ['Rules for every member:', ...rules] : []),
    '</extalia-team>',
  ].join('\n');
}

/** The team member a delegated task names: by name first, then by a role only one member has. */
export function matchTeamMember<T extends Pick<TeamMember, 'name' | 'role'>>(members: readonly T[], text: string): T | undefined {
  const haystack = text.toLowerCase();
  const byName = members.filter(member => member.name.trim() && haystack.includes(member.name.trim().toLowerCase()))
    .sort((a, b) => haystack.indexOf(a.name.toLowerCase()) - haystack.indexOf(b.name.toLowerCase()));
  if (byName[0]) return byName[0];
  const byRole = members.filter(member => member.role.trim() && haystack.includes(member.role.trim().toLowerCase()));
  return byRole.length === 1 ? byRole[0] : undefined;
}

/** The tasks of a `delegate_task` call (`tasks: [{goal, context}]` or the legacy single `goal`). */
function delegatedTasks(input: unknown): { goal: string; context: string }[] {
  if (!input || typeof input !== 'object') return [];
  const args = input as Record<string, unknown>;
  const raw = Array.isArray(args.tasks) ? args.tasks : typeof args.goal === 'string' ? [args] : [];
  return raw.flatMap(item => {
    if (!item || typeof item !== 'object') return [];
    const task = item as Record<string, unknown>;
    return typeof task.goal === 'string' ? [{ goal: task.goal, context: typeof task.context === 'string' ? task.context : '' }] : [];
  });
}

const OUTPUT_LIMIT = 4_000;
const LABEL_LIMIT = 80;

let fallbackCounter = 0;
const defaultId = () => {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return crypto?.randomUUID?.() ?? `hermes-${Date.now().toString(36)}-${(fallbackCounter++).toString(36)}`;
};

const count = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

function usageOf(tokens: unknown): Usage | undefined {
  if (!tokens || typeof tokens !== 'object') return undefined;
  const raw = tokens as Record<string, unknown>;
  const usage: Usage = {};
  const input = count(raw.input), output = count(raw.output), cached = count(raw.cache_read);
  if (input) usage.inputTokens = input;
  if (output) usage.outputTokens = output;
  if (cached) usage.cachedInputTokens = cached;
  return Object.keys(usage).length ? usage : undefined;
}

/** Label and target for a tool call, from the arguments Hermes reports. */
function describeTool(name: string, input: unknown): { kind: ActivityKind; label: string; target?: string } {
  const { kind, label } = classifyTool(name);
  const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
  const target = [args.path, args.file_path, args.url].find(value => typeof value === 'string' && value) as string | undefined;
  if (kind === 'command' && typeof args.command === 'string' && args.command.trim()) {
    return { kind, label: safeLabel(`Running ${args.command.trim().split(/\r?\n/)[0]}`, LABEL_LIMIT) };
  }
  return { kind, label: safeLabel(target ? `${label}: ${target}` : label, LABEL_LIMIT), ...(target ? { target: safeLabel(target, 300) } : {}) };
}

/**
 * Hermes Agent runtime adapter: command line and stream mapping. Never emits
 * `session.started` (the host does when it opens the session) nor the turn's
 * end, which the host reports once the process exits.
 */
export class HermesAdapter {
  readonly id = 'hermes';

  plan(input: HermesPlanInput): HermesPlanResult {
    const profile = input.profile || 'default';
    if (!HERMES_PROFILE_PATTERN.test(profile)) throw new Error('Invalid Hermes profile name.');
    const args: string[] = [
      '-p', profile, 'chat',
      '--query-file', '-', '--oneshot', '--format', 'stream-json',
      '--source', HERMES_SOURCE_TAG, '--in', input.cwd,
    ];
    if (input.resumeSessionId) {
      if (!HERMES_SESSION_ID_PATTERN.test(input.resumeSessionId)) throw new Error('Invalid Hermes session id.');
      args.push('--resume', input.resumeSessionId);
    }
    // `=` keeps a value from being read as another option.
    if (input.model) args.push(`--model=${input.model}`);
    if (input.provider) args.push(`--provider=${input.provider}`);
    if (input.reasoning) {
      if (!EFFORTS.includes(input.reasoning)) throw new Error('Invalid reasoning effort.');
      args.push(`--reasoning=${input.reasoning}`);
    }
    if (input.yolo) args.push('--yolo');
    return { args, stdin: input.prompt };
  }

  createStreamParser(options: HermesStreamOptions = {}): (line: string) => HermesStreamUpdate | undefined {
    const newId = options.newId ?? defaultId;
    /** Open calls by Hermes call id, or by tool name when Hermes gives none. */
    const open = new Map<string, { id: string; name: string; kind: ActivityKind; label: string; target?: string; members?: string[] }[]>();
    let model: string | undefined;
    const team = options.team ?? [];
    /** Members shown as working during this turn; they go idle when it ends. */
    const active = new Set<string>();

    return line => {
      const trimmed = line.trim();
      if (!trimmed.startsWith('{')) return undefined;
      let data: Record<string, unknown>;
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
        data = parsed as Record<string, unknown>;
      } catch {
        return undefined;
      }
      const sessionId = typeof data.session_id === 'string' && HERMES_SESSION_ID_PATTERN.test(data.session_id) ? data.session_id : undefined;
      const update: HermesStreamUpdate = { events: [], ...(sessionId ? { sessionId } : {}) };
      const events = update.events;
      const callId = typeof data.tool_call_id === 'string' && data.tool_call_id ? data.tool_call_id : undefined;
      const name = typeof data.name === 'string' && data.name ? data.name : 'tool';

      switch (data.type) {
        case 'system':
          if (data.subtype !== 'init') return undefined;
          if (typeof data.model === 'string' && data.model.trim()) update.model = model = safeLabel(data.model, 200);
          return update;
        case 'text':
          if (typeof data.text === 'string' && data.text) events.push({ type: 'model.delta', text: data.text });
          return update;
        case 'tool_use': {
          const call: { id: string; name: string; kind: ActivityKind; label: string; target?: string; members?: string[] } = { id: callId ?? newId(), name, ...describeTool(name, data.input) };
          const key = callId ?? name;
          events.push({ type: 'agent.state', state: 'working', activity: call.kind, summary: call.label, ...(call.target ? { target: call.target } : {}) });
          events.push({ type: 'tool.started', toolCallId: call.id, tool: name, kind: call.kind, label: call.label, ...(call.target ? { target: call.target } : {}) });
          if (name === HERMES_DELEGATE_TOOL && team.length) {
            // Hermes' children report no events of their own; the members the tasks name are shown as working.
            call.members = [];
            for (const task of delegatedTasks(data.input)) {
              const member = matchTeamMember(team, task.goal) ?? matchTeamMember(team, task.context);
              if (!member || call.members.includes(member.id)) continue;
              call.members.push(member.id);
              active.add(member.id);
              events.push({ type: 'subagent.spawned', subagentId: member.id, role: safeLabel(member.role, LABEL_LIMIT), label: safeLabel(member.name, LABEL_LIMIT) });
              events.push({ type: 'subagent.state', subagentId: member.id, state: 'working', summary: safeLabel(clip(task.goal, 200), 200) });
            }
          }
          open.set(key, [...(open.get(key) ?? []), call]);
          return update;
        }
        case 'tool_result': {
          const key = callId ?? name;
          const call = open.get(key)?.shift() ?? { id: callId ?? newId(), name, ...describeTool(name, undefined) };
          if (!open.get(key)?.length) open.delete(key);
          const result = parseHermesToolOutput(data.output, data.is_error === true);
          if (!result.ok) for (const member of call.members ?? []) { active.delete(member); events.push({ type: 'subagent.state', subagentId: member, state: 'blocked', summary: 'Could not start' }); }
          for (const file of result.files) events.push({ type: 'file.written', path: safeLabel(file.path, 1000), change: file.change });
          events.push({
            type: 'tool.completed', toolCallId: call.id, tool: name, kind: call.kind, label: call.label, ok: result.ok,
            ...(call.target ? { target: call.target } : {}),
            ...(result.output ? { output: safeText(result.output, OUTPUT_LIMIT) } : {}),
          });
          events.push({ type: 'agent.state', state: 'thinking' });
          return update;
        }
        case 'result': {
          for (const member of active) events.push({ type: 'subagent.state', subagentId: member, state: 'idle' });
          active.clear();
          const text = typeof data.text === 'string' ? data.text : '';
          if (text.trim()) events.push({ type: 'model.completed', text, ...(model ? { model } : {}) });
          const usage = usageOf(data.tokens);
          const exitCode = typeof data.exit_code === 'number' && Number.isInteger(data.exit_code) ? data.exit_code : 1;
          update.result = {
            exitCode,
            ...(typeof data.error === 'string' && data.error.trim() ? { error: safeText(data.error.trim(), 2_000) } : {}),
            ...(usage ? { usage } : {}),
          };
          return update;
        }
        default:
          return undefined;
      }
    };
  }
}
