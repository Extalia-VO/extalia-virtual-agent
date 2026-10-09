import { RUNTIME_PROFILE_PATTERN, safeLabel, safeText } from '@extalia/core';
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
    if (input.yolo) args.push('--yolo');
    return { args, stdin: input.prompt };
  }

  createStreamParser(options: HermesStreamOptions = {}): (line: string) => HermesStreamUpdate | undefined {
    const newId = options.newId ?? defaultId;
    /** Open calls by Hermes call id, or by tool name when Hermes gives none. */
    const open = new Map<string, { id: string; name: string; kind: ActivityKind; label: string; target?: string }[]>();
    let model: string | undefined;

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
          const call = { id: callId ?? newId(), name, ...describeTool(name, data.input) };
          const key = callId ?? name;
          open.set(key, [...(open.get(key) ?? []), call]);
          events.push({ type: 'agent.state', state: 'working', activity: call.kind, summary: call.label, ...(call.target ? { target: call.target } : {}) });
          events.push({ type: 'tool.started', toolCallId: call.id, tool: name, kind: call.kind, label: call.label, ...(call.target ? { target: call.target } : {}) });
          return update;
        }
        case 'tool_result': {
          const key = callId ?? name;
          const call = open.get(key)?.shift() ?? { id: callId ?? newId(), name, ...describeTool(name, undefined) };
          if (!open.get(key)?.length) open.delete(key);
          const result = parseHermesToolOutput(data.output, data.is_error === true);
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
