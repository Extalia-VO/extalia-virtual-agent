import { generateFullName, sourceLabel, type MemberGender } from '@extalia/core';
import type { SessionSummary } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';

/**
 * v0.0.37: where an agent on the board comes from. Observed agents name the outside app (source)
 * and how its newest events arrive (channel); managed agents name the runtime that drives them.
 */
export type ObservedChannel = 'hook' | 'transcript' | 'dashboard';
export type OriginMark = 'codex' | 'claude-code' | 'gemini-cli' | 'antigravity' | 'hermes' | 'extalia-native' | 'other';

export interface AgentOrigin {
  /** Which brand mark to draw. */
  mark: OriginMark;
  /** Brand label ("Codex", "Claude Code", "Gemini CLI", "Antigravity", "Hermes", "Extalia Native"). */
  label: string;
  /** Observed sessions only. */
  channel?: ObservedChannel;
}

const OBSERVED_SOURCES: Readonly<Record<string, { mark: OriginMark; label: string }>> = {
  codex: { mark: 'codex', label: 'Codex' },
  claude: { mark: 'claude-code', label: 'Claude Code' },
  'claude-code': { mark: 'claude-code', label: 'Claude Code' },
  gemini: { mark: 'gemini-cli', label: 'Gemini CLI' },
  'gemini-cli': { mark: 'gemini-cli', label: 'Gemini CLI' },
  antigravity: { mark: 'antigravity', label: 'Antigravity' },
  'antigravity-ide': { mark: 'antigravity', label: 'Antigravity' },
  hermes: { mark: 'hermes', label: 'Hermes' },
};

/** The observed source id normalised to the mark/label family (hook app ids and importer source ids both work). */
export function observedSource(sourceId: string | undefined): { mark: OriginMark; label: string } {
  const id = (sourceId ?? '').trim().toLowerCase();
  return OBSERVED_SOURCES[id] ?? { mark: 'other', label: id ? sourceLabel(id) : '' };
}

type ObservationMeta = NonNullable<SessionSummary['observation']> & { channel?: unknown; model?: unknown };

/**
 * How an observed session's newest events arrive. Hosts that report `observation.channel` win; older
 * hosts imply it: hook-connected sessions are live via hook, Hermes sessions come from its dashboard,
 * everything else is read from the transcript.
 */
export function observedChannel(session: SessionSummary): ObservedChannel | undefined {
  if (session.control !== 'observed' || !session.observation) return undefined;
  const meta = session.observation as ObservationMeta;
  if (meta.channel === 'hook' || meta.channel === 'transcript' || meta.channel === 'dashboard') return meta.channel;
  if (meta.hook) return 'hook';
  return observedSource(meta.sourceId).mark === 'hermes' ? 'dashboard' : 'transcript';
}

/** The origin of every agent of `session`: the outside app for observed sessions, the runtime for managed ones. */
export function sessionOrigin(session: SessionSummary): AgentOrigin {
  if (session.control === 'observed') {
    const source = observedSource(session.observation?.sourceId);
    const channel = observedChannel(session);
    return { ...source, ...(channel ? { channel } : {}) };
  }
  return session.runtime?.id === 'hermes' ? { mark: 'hermes', label: 'Hermes' } : { mark: 'extalia-native', label: 'Extalia Native' };
}

const cleanModel = (value: unknown): string | undefined => typeof value === 'string' && value.trim() ? value.trim() : undefined;

/** The lead model a host reports on the summary (`model`, or `observation.model` on hosts that nest it). */
export function sessionLeadModel(session: SessionSummary): string | undefined {
  return cleanModel((session as SessionSummary & { model?: unknown }).model) ?? cleanModel((session.observation as ObservationMeta | undefined)?.model);
}

/**
 * The newest model each agent of a session reported, keyed by agent id ('primary' for the lead). Model-bearing
 * events are `session.started`, `model.completed`, `turn.completed` (the agent's own) and `subagent.spawned`
 * (keyed by the sub-agent it names). "Newest" is the latest event time; events at the same time keep their
 * sequence order, and events without a sequence keep their input order. The input order itself does not matter:
 * hook and transcript events arrive interleaved, and a re-read transcript window repeats older events.
 * Copied history (`import` channel) never counts.
 */
export function latestAgentModels(events: readonly ExtaliaEvent[]): Map<string, string> {
  const models = new Map<string, string>();
  const ranked = events
    .map((event, index) => ({ event, index, at: Date.parse(event.at) }))
    .filter(({ event }) => event.source.channel !== 'import');
  const time = (value: number) => (Number.isFinite(value) ? value : -Infinity);
  ranked.sort((a, b) => {
    if (time(a.at) !== time(b.at)) return time(a.at) < time(b.at) ? -1 : 1;
    return (a.event.seq ?? -1) - (b.event.seq ?? -1) || a.index - b.index;
  });
  for (const { event } of ranked) {
    const body = event.body;
    if (body.type === 'subagent.spawned') {
      const model = cleanModel(body.model);
      if (model) models.set(body.subagentId, model);
      continue;
    }
    if (body.type !== 'session.started' && body.type !== 'model.completed' && body.type !== 'turn.completed') continue;
    const model = cleanModel(body.model);
    if (model) models.set(event.agentId ?? 'primary', model);
  }
  return models;
}

const CONNECTORS = new Set(['the', 'of', 'van', 'von', 'de', 'da', 'del', 'der', 'la', 'le', 'bin', 'binti', 'al', 'el', 'y']);
const SUFFIX = /^(?:\d+(?:st|nd|rd|th)|[IVX]{1,4}|Jr\.?|Sr\.?)$/;
const NAME_WORD = /^\p{Lu}[\p{Ll}'’-]+$/u;

/**
 * True for labels that read like a person's name ("Carver the 2nd", "Ada Lovelace") rather than a task
 * ("Team setup dialog UI", "explorer"): one to four words, starting with a capitalised name, every word a
 * capitalised name, a connector ("the", "van") or a suffix ("2nd", "III").
 */
export function looksLikePersonName(label: string | undefined): boolean {
  const words = (label ?? '').trim().split(/\s+/).filter(Boolean);
  if (!words.length || words.length > 4 || !NAME_WORD.test(words[0]!)) return false;
  return words.every(word => NAME_WORD.test(word) || CONNECTORS.has(word) || SUFFIX.test(word));
}

export interface ObservedSubagentIdentity {
  name: string;
  gender?: MemberGender;
  /** The task line under the name (the source's label, description or role); absent when nothing is known. */
  task?: string;
}

/**
 * What an observed subagent is called. A person-like nickname from the source (Codex `agent_nickname`) is kept;
 * otherwise the subagent gets a generated full name seeded by `${sessionId}:${subagentId}`, and the source's
 * label (Claude `description`) or role becomes its task line. Claude Code labels are always descriptions.
 */
export function observedSubagentIdentity(input: {
  sessionId: string; subagentId: string; sourceId?: string | undefined; label?: string | undefined; role?: string | undefined; taken?: ReadonlySet<string>;
}): ObservedSubagentIdentity {
  const label = input.label?.trim() && input.label.trim() !== input.subagentId ? input.label.trim() : undefined;
  const role = input.role?.trim() || undefined;
  const describes = observedSource(input.sourceId).mark === 'claude-code';
  if (label && !describes && looksLikePersonName(label)) return { name: label, ...(role ? { task: role } : {}) };
  const generated = generateFullName(`${input.sessionId}:${input.subagentId}`, input.taken ?? new Set());
  const task = label ?? role;
  return { name: generated.name, gender: generated.gender, ...(task ? { task } : {}) };
}
