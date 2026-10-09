import {
  ACTIVITY_KINDS, AGENT_STATES, EVENT_CHANNELS, PROTOCOL_VERSION,
  type EventBody, type EventType, type ExtaliaEvent,
} from './events.js';

/** Identifiers: non-empty, single line, bounded. */
const ID_LIMIT = 200;
/** Runtime/adapter identifiers are open but constrained, so they can key registries and file names. */
export const RUNTIME_ID_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Free text (prompts, model output, command output) is bounded per event. */
export const TEXT_LIMIT = 200_000;
const LABEL_LIMIT = 2_000;

type FieldRule =
  | { kind: 'id' | 'label' | 'text' | 'boolean' | 'usage' | 'labels'; optional?: true }
  | { kind: 'number'; optional?: true; integer?: true; min?: number; max?: number }
  | { kind: 'enum'; values: readonly string[]; optional?: true };

interface BodySpec {
  fields: Record<string, FieldRule>;
  /** Envelope fields this event type cannot be interpreted without. */
  requires?: ('agentId' | 'taskId')[];
}

const id = { kind: 'id' } as const;
const optId = { kind: 'id', optional: true } as const;
const label = { kind: 'label' } as const;
const optLabel = { kind: 'label', optional: true } as const;
const text = { kind: 'text' } as const;
const optText = { kind: 'text', optional: true } as const;
const bool = { kind: 'boolean' } as const;
const optBool = { kind: 'boolean', optional: true } as const;
const usage = { kind: 'usage', optional: true } as const;
const ratio = { kind: 'number', min: 0, max: 1 } as const;
const optCount = { kind: 'number', integer: true, min: 0, optional: true } as const;
const agentState = { kind: 'enum', values: AGENT_STATES } as const;
const activity = { kind: 'enum', values: ACTIVITY_KINDS } as const;

/** Field rules per event type. Typed as a complete record so a new event type cannot ship without rules. */
export const EVENT_SPECS: Readonly<Record<EventType, BodySpec>> = {
  'session.started': { fields: { control: { kind: 'enum', values: ['managed', 'observed'] }, title: optLabel, model: optLabel, cwd: optLabel } },
  'session.updated': { fields: { revision: id, messageCount: { kind: 'number', integer: true, min: 0 } } },
  'session.ended': { fields: { reason: optLabel } },
  'prompt.submitted': { fields: { text, via: { kind: 'enum', values: ['extalia', 'native'] } } },
  'user.intervention': { fields: { action: { kind: 'enum', values: ['steer', 'pause', 'resume', 'cancel'] }, text: optText } },
  'model.thinking': { fields: {} },
  'model.delta': { fields: { text } },
  'model.completed': { fields: { text, model: optLabel, usage } },
  'turn.completed': { fields: { summary: optText, model: optLabel, usage, costUsd: { kind: 'number', min: 0, optional: true } } },
  'turn.failed': { fields: { error: text } },
  'agent.created': { fields: { name: label, role: optLabel, parentAgentId: optId }, requires: ['agentId'] },
  'agent.state': { fields: { state: agentState, activity: { ...activity, optional: true }, summary: optLabel, target: optLabel, progress: { ...ratio, optional: true } }, requires: ['agentId'] },
  'agent.stopped': { fields: { reason: optLabel }, requires: ['agentId'] },
  'agent.error': { fields: { message: text, recoverable: optBool }, requires: ['agentId'] },
  'subagent.spawned': { fields: { subagentId: id, role: optLabel, label: optLabel }, requires: ['agentId'] },
  'subagent.state': { fields: { subagentId: id, state: agentState, summary: optLabel }, requires: ['agentId'] },
  'tool.started': { fields: { toolCallId: optId, tool: label, kind: activity, label, target: optLabel } },
  'tool.output': { fields: { toolCallId: optId, text } },
  'tool.completed': { fields: { toolCallId: optId, tool: label, kind: activity, label, ok: bool, target: optLabel, output: optText } },
  'command.started': { fields: { commandId: optId, command: text, cwd: optLabel } },
  'command.output': { fields: { commandId: optId, stream: { kind: 'enum', values: ['stdout', 'stderr'] }, text } },
  'command.completed': { fields: { commandId: optId, exitCode: { kind: 'number', integer: true }, durationMs: optCount } },
  'file.read': { fields: { path: label } },
  'file.written': { fields: { path: label, change: { kind: 'enum', values: ['add', 'update', 'delete'] } } },
  'task.created': { fields: { title: label, parentTaskId: optId }, requires: ['taskId'] },
  'task.assigned': { fields: { assigneeAgentId: id }, requires: ['taskId'] },
  'task.progress': { fields: { progress: ratio, summary: optLabel }, requires: ['taskId'] },
  'task.completed': { fields: { ok: bool, summary: optText }, requires: ['taskId'] },
  'approval.requested': { fields: { approvalId: id, action: label, detail: optText, risk: { kind: 'enum', values: ['low', 'medium', 'high'], optional: true } } },
  'approval.resolved': { fields: { approvalId: id, decision: { kind: 'enum', values: ['granted', 'rejected'] }, by: { kind: 'enum', values: ['user', 'policy'] } } },
  'git.status': { fields: { changedFiles: { kind: 'number', integer: true, min: 0 }, branch: optLabel, ahead: optCount, behind: optCount } },
  'git.commit': { fields: { sha: { kind: 'id' }, message: optText } },
  'git.push': { fields: { ok: bool, remote: optLabel, branch: optLabel } },
  'meeting.started': { fields: { meetingId: id, participants: { kind: 'labels' }, topic: optLabel } },
  'meeting.completed': { fields: { meetingId: id, decisions: { kind: 'labels', optional: true }, actionItems: { kind: 'labels', optional: true } } },
};

export const EVENT_TYPES = Object.keys(EVENT_SPECS) as EventType[];

export function isEventType(value: unknown): value is EventType {
  return typeof value === 'string' && Object.hasOwn(EVENT_SPECS, value);
}

export type ParseFailureCode = 'invalid' | 'unsupported-version' | 'unknown-type';
export type ParseResult =
  | { ok: true; event: ExtaliaEvent }
  | { ok: false; code: ParseFailureCode; errors: string[] };

const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

/** True for a real UTC instant written as `YYYY-MM-DDTHH:mm:ss[.sss]Z`. */
export function isUtcTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || !TIMESTAMP.test(value)) return false;
  const time = Date.parse(value);
  if (!Number.isFinite(time)) return false;
  // Reject calendar overflow such as 2026-02-30, which Date.parse silently rolls over.
  return new Date(time).toISOString().slice(0, 19) === value.slice(0, 19);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function checkString(value: unknown, path: string, limit: number, allowEmpty: boolean, singleLine: boolean, errors: string[]): void {
  if (typeof value !== 'string') { errors.push(`${path}: expected a string.`); return; }
  if (!allowEmpty && !value.trim()) errors.push(`${path}: must not be empty.`);
  if (value.length > limit) errors.push(`${path}: longer than ${limit} characters.`);
  if (singleLine && /[\r\n]/.test(value)) errors.push(`${path}: must be a single line.`);
}

function checkField(value: unknown, rule: FieldRule, path: string, errors: string[]): void {
  switch (rule.kind) {
    case 'id': return checkString(value, path, ID_LIMIT, false, true, errors);
    case 'label': return checkString(value, path, LABEL_LIMIT, false, false, errors);
    case 'text': return checkString(value, path, TEXT_LIMIT, true, false, errors);
    case 'boolean':
      if (typeof value !== 'boolean') errors.push(`${path}: expected true or false.`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !rule.values.includes(value)) errors.push(`${path}: expected one of ${rule.values.join(', ')}.`);
      return;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) { errors.push(`${path}: expected a finite number.`); return; }
      if (rule.integer && !Number.isInteger(value)) errors.push(`${path}: expected an integer.`);
      if (rule.min !== undefined && value < rule.min) errors.push(`${path}: must be at least ${rule.min}.`);
      if (rule.max !== undefined && value > rule.max) errors.push(`${path}: must be at most ${rule.max}.`);
      return;
    case 'labels':
      if (!Array.isArray(value)) { errors.push(`${path}: expected an array of strings.`); return; }
      value.forEach((item, index) => checkString(item, `${path}[${index}]`, LABEL_LIMIT, false, false, errors));
      return;
    case 'usage': {
      if (!isRecord(value)) { errors.push(`${path}: expected an object.`); return; }
      for (const [key, count] of Object.entries(value)) {
        if (!['inputTokens', 'outputTokens', 'cachedInputTokens'].includes(key)) errors.push(`${path}.${key}: unknown field.`);
        else checkField(count, { kind: 'number', integer: true, min: 0 }, `${path}.${key}`, errors);
      }
      return;
    }
  }
}

const ENVELOPE_KEYS = new Set(['v', 'id', 'at', 'sessionId', 'seq', 'agentId', 'taskId', 'parentId', 'correlationId', 'source', 'body']);

/**
 * Validate an untrusted value as an Extalia event. Unknown fields are rejected so
 * that adapters cannot smuggle runtime-specific payloads past the protocol.
 */
export function parseEvent(raw: unknown): ParseResult {
  if (!isRecord(raw)) return { ok: false, code: 'invalid', errors: ['Event must be an object.'] };
  if (raw.v !== PROTOCOL_VERSION) return { ok: false, code: 'unsupported-version', errors: [`Expected protocol version ${PROTOCOL_VERSION}.`] };
  const errors: string[] = [];
  for (const key of Object.keys(raw)) if (!ENVELOPE_KEYS.has(key)) errors.push(`${key}: unknown envelope field.`);
  checkString(raw.id, 'id', ID_LIMIT, false, true, errors);
  checkString(raw.sessionId, 'sessionId', ID_LIMIT, false, true, errors);
  if (!isUtcTimestamp(raw.at)) errors.push('at: expected a UTC timestamp such as 2026-01-31T12:00:00.000Z.');
  if (raw.seq !== undefined) checkField(raw.seq, { kind: 'number', integer: true, min: 0 }, 'seq', errors);
  for (const key of ['agentId', 'taskId', 'parentId', 'correlationId'] as const) {
    if (raw[key] !== undefined) checkString(raw[key], key, ID_LIMIT, false, true, errors);
  }

  if (!isRecord(raw.source)) errors.push('source: expected an object.');
  else {
    const source = raw.source;
    for (const key of Object.keys(source)) if (!['runtime', 'channel', 'adapter', 'adapterVersion'].includes(key)) errors.push(`source.${key}: unknown field.`);
    if (typeof source.runtime !== 'string' || !RUNTIME_ID_PATTERN.test(source.runtime)) errors.push('source.runtime: expected a lowercase identifier such as "hermes".');
    if (typeof source.channel !== 'string' || !(EVENT_CHANNELS as readonly string[]).includes(source.channel)) errors.push(`source.channel: expected one of ${EVENT_CHANNELS.join(', ')}.`);
    if (source.adapter !== undefined && (typeof source.adapter !== 'string' || !RUNTIME_ID_PATTERN.test(source.adapter))) errors.push('source.adapter: expected a lowercase identifier.');
    if (source.adapterVersion !== undefined) checkString(source.adapterVersion, 'source.adapterVersion', 64, false, true, errors);
  }

  if (!isRecord(raw.body)) errors.push('body: expected an object.');
  else if (!isEventType(raw.body.type)) {
    return { ok: false, code: 'unknown-type', errors: [`body.type: unknown event type ${JSON.stringify(raw.body.type)}.`] };
  } else {
    const spec = EVENT_SPECS[raw.body.type];
    for (const key of Object.keys(raw.body)) if (key !== 'type' && !Object.hasOwn(spec.fields, key)) errors.push(`body.${key}: unknown field for ${raw.body.type}.`);
    for (const [key, rule] of Object.entries(spec.fields)) {
      const value = raw.body[key];
      if (value === undefined) { if (!rule.optional) errors.push(`body.${key}: required for ${raw.body.type}.`); }
      else checkField(value, rule, `body.${key}`, errors);
    }
    for (const key of spec.requires ?? []) if (raw[key] === undefined) errors.push(`${key}: required for ${raw.body.type}.`);
  }

  if (errors.length) return { ok: false, code: 'invalid', errors };
  return { ok: true, event: raw as unknown as ExtaliaEvent };
}

/** Parse newline-delimited JSON events. Blank lines are skipped; each line reports independently. */
export function parseEventLines(input: string): { line: number; result: ParseResult }[] {
  const results: { line: number; result: ParseResult }[] = [];
  input.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    let raw: unknown;
    try { raw = JSON.parse(line); } catch { results.push({ line: index + 1, result: { ok: false, code: 'invalid', errors: ['Line is not valid JSON.'] } }); return; }
    results.push({ line: index + 1, result: parseEvent(raw) });
  });
  return results;
}

function randomId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (crypto?.randomUUID) return crypto.randomUUID();
  return `evt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export type EventInit<B extends EventBody = EventBody> = Omit<ExtaliaEvent<B>, 'v' | 'id' | 'at'> & { id?: string; at?: string };

/** Build a validated event, filling `v`, `id` and `at`. Throws when the result is not a valid event. */
export function createEvent<B extends EventBody>(init: EventInit<B>, now: () => Date = () => new Date()): ExtaliaEvent<B> {
  const candidate = { ...init, v: PROTOCOL_VERSION, id: init.id ?? randomId(), at: init.at ?? now().toISOString() };
  const result = parseEvent(candidate);
  if (!result.ok) throw new Error(`Invalid ${init.body.type} event: ${result.errors.join(' ')}`);
  return candidate as ExtaliaEvent<B>;
}
