import type { OfficeActivity } from '../activityFeed';
import type { OfficeAgent, PresenceTeams } from '../presence';
import { lookIdentity } from '../scene/avatars/appearance';
import { statusTone, type StatusTone } from './status';

export interface BoardRow {
  agent: OfficeAgent;
  /** 0 for a lead (or an agent whose parent is not on the board), 1 for its subagents, and so on. */
  depth: number;
  /** Every agent nested under this one, at any depth, whether or not they are listed. */
  descendants: number;
  /** False when the agent's nested agents are collapsed (they are then left out of the rows). */
  expanded: boolean;
  /**
   * v0.0.30 tree lines. `guides[k]` is true when the trunk of the ancestor at
   * depth `k` passes this row on to a later sibling branch (length `depth - 1`).
   */
  guides: boolean[];
  /** The last child of its parent: its elbow ends the parent's trunk (`└`), otherwise the trunk goes on (`├`). */
  last: boolean;
  /** Its nested agents are listed right below, so a stem runs down from its portrait to them. */
  stem: boolean;
}

/**
 * The agents board as a flat list in tree order: each lead is followed by its subagents, unless the lead is in `collapsed`.
 * `order` (v0.0.50, flat ids from `boardOrder`) sorts the siblings; without it they keep the input order. An agent whose
 * parent is not on the board, or whose parent chain loops back to it, is a lead of its own, so no agent ever disappears.
 */
export function boardRows(agents: readonly OfficeAgent[], collapsed: ReadonlySet<string> = new Set(), order?: readonly string[]): BoardRow[] {
  const { parentOf, childrenOf } = treeOf(agents);
  const rank = order ? new Map(order.map((id, index) => [id, index])) : undefined;
  const ranked = (list: readonly OfficeAgent[]): OfficeAgent[] => rank
    ? [...list].sort((a, b) => (rank.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.id) ?? Number.MAX_SAFE_INTEGER))
    : [...list];
  for (const [parent, children] of childrenOf) childrenOf.set(parent, ranked(children));

  const descendantsOf = (id: string): number => (childrenOf.get(id) ?? [])
    .reduce((total, child) => total + 1 + descendantsOf(child.id), 0);

  const rows: BoardRow[] = [];
  const visit = (agent: OfficeAgent, depth: number, guides: boolean[], last: boolean) => {
    const expanded = !collapsed.has(agent.id);
    const children = childrenOf.get(agent.id) ?? [];
    rows.push({ agent, depth, descendants: descendantsOf(agent.id), expanded, guides, last, stem: expanded && children.length > 0 });
    if (!expanded) return;
    // A child's guides: this row's, plus whether this row's own trunk (its parent's) continues past it.
    const inherited = depth === 0 ? [] : [...guides, !last];
    children.forEach((child, index) => visit(child, depth + 1, inherited, index === children.length - 1));
  };
  for (const agent of ranked(agents.filter(item => !parentOf.has(item.id)))) visit(agent, 0, [], true);
  return rows;
}

/** v0.0.50: the parent links the board draws (a loop or a missing parent makes a lead) and each parent's children, in input order. */
function treeOf(agents: readonly OfficeAgent[]): { parentOf: Map<string, string>; childrenOf: Map<string, OfficeAgent[]> } {
  const byId = new Map(agents.map(agent => [agent.id, agent]));
  const parentOf = new Map<string, string>();
  for (const agent of agents) {
    const parent = agent.parentId;
    if (!parent || parent === agent.id || !byId.has(parent)) continue;
    if (reachesAgent(byId, parent, agent.id)) continue;
    parentOf.set(agent.id, parent);
  }
  const childrenOf = new Map<string, OfficeAgent[]>();
  for (const agent of agents) {
    const parent = parentOf.get(agent.id);
    if (parent === undefined) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(agent);
    childrenOf.set(parent, list);
  }
  return { parentOf, childrenOf };
}

/**
 * v0.0.50: the board's agent ids in display order (flat tree order, collapsing ignored): leads newest first by their latest
 * activity, where a lead's latest is its own or any descendant's, and each lead's subagents newest first the same way.
 * Equal times keep the input order (a stable sort), so equal rows never swap places between renders.
 */
export function boardOrder(agents: readonly OfficeAgent[], activityAt: (agent: OfficeAgent) => number | undefined): string[] {
  const { parentOf, childrenOf } = treeOf(agents);
  const latest = new Map<string, number | undefined>();
  const latestOf = (agent: OfficeAgent): number | undefined => {
    if (latest.has(agent.id)) return latest.get(agent.id);
    let newest = activityAt(agent);
    for (const child of childrenOf.get(agent.id) ?? []) {
      const time = latestOf(child);
      if (time !== undefined && (newest === undefined || time > newest)) newest = time;
    }
    latest.set(agent.id, newest);
    return newest;
  };
  // Newest first; an agent without any activity comes after every dated one.
  const newestFirst = (a: OfficeAgent, b: OfficeAgent): number => {
    const x = latestOf(a) ?? Number.NEGATIVE_INFINITY;
    const y = latestOf(b) ?? Number.NEGATIVE_INFINITY;
    return x === y ? 0 : x < y ? 1 : -1;
  };
  const order: string[] = [];
  const visit = (agent: OfficeAgent) => {
    order.push(agent.id);
    for (const child of [...(childrenOf.get(agent.id) ?? [])].sort(newestFirst)) visit(child);
  };
  for (const lead of agents.filter(agent => !parentOf.has(agent.id)).sort(newestFirst)) visit(lead);
  return order;
}

/** v0.0.50: at most one reorder per this many milliseconds, so a burst of activity moves rows once (rows that come or go apply at once). */
export const BOARD_REORDER_MS = 1000;

export function sameBoardIds(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * v0.0.50: the board order to show for `desired`, given the order shown and whether a reorder cooldown (BOARD_REORDER_MS after
 * the last change) is running. A change of who is listed applies at once; a pure reorder waits until the cooldown ends.
 */
export function nextBoardOrder(shown: readonly string[], desired: readonly string[], cooling: boolean): { ids: readonly string[]; changed: boolean } {
  if (sameBoardIds(shown, desired)) return { ids: shown, changed: false };
  const listed = new Set(shown);
  const sameAgents = listed.size === desired.length && desired.every(id => listed.has(id));
  if (sameAgents && cooling) return { ids: shown, changed: false };
  return { ids: desired, changed: true };
}

/** True when following parent links from `start` reaches `target` (a loop if `target` is the child being attached). */
function reachesAgent(byId: ReadonlyMap<string, OfficeAgent>, start: string, target: string): boolean {
  let current: string | undefined = start;
  for (let steps = 0; current !== undefined && steps <= byId.size; steps++) {
    if (current === target) return true;
    current = byId.get(current)?.parentId;
  }
  return false;
}

/**
 * A team is permanent even when its members are not working: members of a lead's team that are not
 * in the Office right now are listed under their lead as `offline` rows, so the board always shows
 * who works under whom. Members already present keep their live row.
 */
export function withTeamMembers(agents: readonly OfficeAgent[], teams: PresenceTeams): OfficeAgent[] {
  const present = new Set(agents.map(agent => agent.id));
  const extra: OfficeAgent[] = [];
  for (const lead of agents) {
    if (lead.agentId !== 'primary' || lead.parentId) continue;
    for (const member of teams.get(lead.sessionId) ?? []) {
      const id = `${lead.sessionId}:${member.id}`;
      if (present.has(id) || !member.name.trim()) continue;
      present.add(id);
      const gender = member.gender === 'female' || member.gender === 'male' ? member.gender : undefined;
      extra.push({
        id, sessionId: lead.sessionId, agentId: member.id, displayName: member.name.trim(), control: lead.control,
        status: 'offline', running: false, parentId: lead.id, look: lookIdentity(member.name, gender), ...(lead.earlier ? { earlier: true } : {}),
      });
    }
  }
  return extra.length ? [...agents, ...extra] : [...agents];
}

/** v0.0.43: one session's agents under the board's "Earlier" group. */
export interface EarlierGroup {
  sessionId: string;
  /** The session's lead when it is still in the office (its subagents that left are listed here under its name). */
  presentLead?: OfficeAgent;
  rows: BoardRow[];
  /** Newest activity of the group (epoch ms), for ordering; groups without one come last. */
  at?: number;
}

/**
 * v0.0.43: splits the board into agents in the office and the "Earlier" group (agents with `earlier`: ended or quiet
 * observed sessions, subagents that left). Earlier agents keep their tree per session; a session whose lead is still
 * in the office names it on its group. v0.0.50: rows follow `order` (the settled board order, default `boardOrder`), and
 * groups follow the first place their agents hold in it, so the newest activity comes first.
 */
export function splitBoard(
  agents: readonly OfficeAgent[], collapsed: ReadonlySet<string> = new Set(), activityAt: (agent: OfficeAgent) => number | undefined = () => undefined,
  order?: readonly string[],
): { present: BoardRow[]; earlier: EarlierGroup[]; earlierCount: number } {
  const flat = order ?? boardOrder(agents, activityAt);
  const rank = new Map(flat.map((id, index) => [id, index]));
  const place = (agent: OfficeAgent) => rank.get(agent.id) ?? Number.MAX_SAFE_INTEGER;
  const present = agents.filter(agent => !agent.earlier);
  const earlier = agents.filter(agent => agent.earlier);
  const bySession = new Map<string, OfficeAgent[]>();
  for (const agent of earlier) bySession.set(agent.sessionId, [...(bySession.get(agent.sessionId) ?? []), agent]);
  const groups = [...bySession.entries()].map(([sessionId, members]) => {
    const presentLead = present.find(agent => agent.sessionId === sessionId && agent.agentId === 'primary');
    let at: number | undefined;
    for (const member of members) { const time = activityAt(member); if (time !== undefined && (at === undefined || time > at)) at = time; }
    const group: EarlierGroup = { sessionId, ...(presentLead ? { presentLead } : {}), rows: boardRows(members, collapsed, flat), ...(at !== undefined ? { at } : {}) };
    return { group, place: Math.min(...members.map(place)) };
  });
  groups.sort((a, b) => a.place - b.place);
  return { present: boardRows(present, collapsed, flat), earlier: groups.map(item => item.group), earlierCount: earlier.length };
}

/** v0.0.50: path data for the flowing connector elbows: └ (a lead's last child) and ├ (any other child), in a 13 x 27 box. */
export const TREE_ELBOW_PATHS = {
  /** └: the trunk comes down, rounds the corner (7px) and runs into the row (a 13 x 27 box). */
  last: 'M0.5 0V20A6.5 6.5 0 0 0 7 26.5H13',
  /** ├: the trunk stays; a rounded branch (8px) leaves it and runs into the row. */
  branch: 'M0.5 19A7.5 7.5 0 0 0 8 26.5H13',
} as const;

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
/** Under this many milliseconds an activity reads as "just now". */
const JUST_NOW_MS = 45_000;

/** Largest unit first; `minute` is the fallback below. */
const AGO_UNITS: readonly (readonly [Intl.RelativeTimeFormatUnit, number])[] = [
  ['year', 365 * DAY_MS], ['month', 30 * DAY_MS], ['week', 7 * DAY_MS], ['day', DAY_MS], ['hour', HOUR_MS],
];

const relativeFormats = new Map<string, Intl.RelativeTimeFormat>();
/** Indonesian uses the short forms ("2 mnt lalu", "2 jam lalu") so the time fits beside the status on a 280px panel. */
const relativeStyle = (locale: string): 'long' | 'short' => (locale.toLowerCase().startsWith('id') ? 'short' : 'long');
const absoluteFormats = new Map<string, Intl.DateTimeFormat>();

/**
 * v0.0.38: how long before `now` something happened, in the UI language. Under 45 s it is `justNow`
 * (the translated "just now"); after that Intl.RelativeTimeFormat words it ("1 minute ago",
 * "yesterday", "2 hours ago"; "baru saja", "1 menit yang lalu", "kemarin" in Indonesian).
 */
export function boardAgo(at: number, now: number, locale: string, justNow: string): string {
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < JUST_NOW_MS) return justNow;
  const key = `${locale}:${relativeStyle(locale)}`;
  const format = relativeFormats.get(key) ?? new Intl.RelativeTimeFormat(locale, { numeric: 'auto', style: relativeStyle(locale) });
  relativeFormats.set(key, format);
  for (const [unit, size] of AGO_UNITS) {
    if (elapsed >= size) return format.format(-Math.floor(elapsed / size), unit);
  }
  return format.format(-Math.max(1, Math.floor(elapsed / MINUTE_MS)), 'minute');
}

/** Compact wording for the line-1 time: "now", "2m", "3h", "1d" (EN) or "baru", "2 mnt", "3 jam", "1 hr" (ID). */
export interface CompactAgo {
  now: string;
  minutes(value: number): string;
  hours(value: number): string;
  days(value: number): string;
}

/** v0.0.38: the shortest honest relative time, for the board row's line 1 (under 45 s is `now`). */
export function boardAgoShort(at: number, now: number, labels: CompactAgo): string {
  const elapsed = now - at;
  if (!Number.isFinite(elapsed) || elapsed < JUST_NOW_MS) return labels.now;
  if (elapsed < HOUR_MS) return labels.minutes(Math.max(1, Math.floor(elapsed / MINUTE_MS)));
  if (elapsed < DAY_MS) return labels.hours(Math.floor(elapsed / HOUR_MS));
  return labels.days(Math.floor(elapsed / DAY_MS));
}

/** The full date and time of an activity, for a `title` next to its relative time. */
export function boardAbsolute(at: number, locale: string): string {
  let format = absoluteFormats.get(locale);
  if (!format) { format = new Intl.DateTimeFormat(locale, { dateStyle: 'medium', timeStyle: 'short' }); absoluteFormats.set(locale, format); }
  return format.format(at);
}

/**
 * v0.0.38: when a board row last did something (epoch ms), or undefined when it has no activity yet. A
 * subagent uses its own newest event; a lead uses its session's newest event (its own or its subagents');
 * an observed lead also counts the `lastActivityAt` its presence reports.
 */
export function boardActivityAt(agent: OfficeAgent, latest: ReadonlyMap<string, Pick<OfficeActivity, 'at' | 'sessionId'>>): number | undefined {
  let newest: number | undefined;
  const consider = (at: string | undefined) => {
    const time = at ? Date.parse(at) : Number.NaN;
    if (Number.isFinite(time) && (newest === undefined || time > newest)) newest = time;
  };
  consider(agent.lastActivityAt);
  if (agent.agentId === 'primary') {
    for (const activity of latest.values()) if (activity.sessionId === agent.sessionId) consider(activity.at);
  } else {
    consider(latest.get(agent.id)?.at);
  }
  return newest;
}

/** v0.0.48: the colour group of a tree connector: the status tone, or `queued` for a mission task not started yet. */
export type BoardTreeTone = StatusTone | 'queued';

export function boardTreeTone(agent: OfficeAgent): BoardTreeTone {
  const tone = statusTone(agent);
  return tone === 'idle' && agent.mission?.state === 'queued' ? 'queued' : tone;
}

/** v0.0.48: a child doing work now (working, thinking, delegating, a tool, planning, compacting): its connector flows toward it. */
export function boardTreeActive(agent: OfficeAgent): boolean {
  if (agent.status === 'offline') return false;
  const tone = statusTone(agent);
  return tone === 'work' || (tone === 'idle' && (agent.phase === 'planning' || agent.phase === 'compacting'));
}

/** v0.0.48: whether any agent nested under `rows[index]` is active, so the trunk from that lead down to its children flows. */
export function boardBranchActive(rows: readonly BoardRow[], index: number): boolean {
  const lead = rows[index];
  if (!lead) return false;
  for (let at = index + 1; at < rows.length; at++) {
    const row = rows[at];
    if (!row || row.depth <= lead.depth) break;
    if (boardTreeActive(row.agent)) return true;
  }
  return false;
}
