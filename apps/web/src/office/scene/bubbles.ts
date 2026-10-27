import type { ActivityKind } from '@extalia/protocol';
import { latestByCharacter, type OfficeActivity, type OfficeActivityKind } from '../activityFeed';
import type { OfficeAgentStatus } from '../presence';
import type { IconName } from '../../ui/Icon';
import type { FurnishedOfficeView } from './FurnishedFloors';

/** Statuses with nothing going on: a character in these shows no bubble, even within the expiry window. */
const QUIET_STATUSES: ReadonlySet<OfficeAgentStatus> = new Set(['idle', 'offline', 'paused', 'unavailable', 'observing']);

/** Statuses where a character may be doing something; `presenceActivity` narrows waiting and observed further. Blocked is not progress: only its fresh event shows. */
const ACTIVE_STATUSES: ReadonlySet<OfficeAgentStatus> = new Set(['thinking', 'working', 'delegating', 'waiting']);

/** Characters whose bubbles must stay hidden because they are idle or away, or (v0.0.43) stopped responding. */
export function quietCharacters(agents: readonly { id: string; status: OfficeAgentStatus; stalled?: boolean | undefined }[]): Set<string> {
  return new Set(agents.filter(agent => QUIET_STATUSES.has(agent.status) || agent.stalled).map(agent => agent.id));
}

/** How long a transient activity bubble stays fully visible after its activity arrives. */
export const BUBBLE_VISIBLE_MS = 4000;
/** Fade-out after the visible time; zero with reduced motion. */
export const BUBBLE_FADE_MS = 380;
/** Busy floors show only the most recent lines. */
export const MAX_BUBBLES = 6;

/** speech: a reply · thought: a prompt or tool/thinking step · attention: waiting for approval · handoff: delegated · error: failed turn. */
export type BubbleTone = 'speech' | 'thought' | 'attention' | 'handoff' | 'error';

const TONES: Partial<Record<OfficeActivityKind, BubbleTone>> = {
  prompt: 'thought', reply: 'speech', tool: 'thought', approval: 'attention', delegated: 'handoff', failed: 'error',
};

const KIND_ICON: Record<ActivityKind, IconName> = {
  edit: 'edit', command: 'terminal', test: 'beaker', search: 'search', read: 'file', web: 'globe', delegate: 'users', knowledge: 'book', think: 'spark', tool: 'tool',
};

/** The bubble style for an activity kind; finished turns (`done`) have none so completed turns clear the bubble. */
export function bubbleTone(kind: OfficeActivityKind): BubbleTone | undefined {
  return TONES[kind];
}

export function bubbleIcon(activity: OfficeActivity): IconName | undefined {
  switch (activity.kind) {
    case 'prompt': return 'spark';
    case 'reply': return 'chat';
    case 'tool': return KIND_ICON[activity.activity ?? 'tool'];
    case 'approval': return 'shield';
    case 'delegated': return 'users';
    case 'failed': return 'alert';
    default: return undefined;
  }
}

export interface BubbleAgent {
  id: string;
  sessionId?: string;
  status: OfficeAgentStatus;
  /** Observed (outside-app) sessions stop counting as busy once their own last event is no longer recent (`live` false). */
  control?: 'managed' | 'observed' | undefined;
  live?: boolean | undefined;
  /** `waiting` only shows a bubble while an approval is actually pending. */
  pendingApprovalId?: string | undefined;
  activity?: ActivityKind | undefined;
  target?: string | undefined;
  summary?: string | undefined;
  lastActivityAt?: string | undefined;
}

export interface ActivityBubble {
  characterId: string;
  activity: OfficeActivity;
  tone: BubbleTone;
  icon?: IconName;
  /** When the bubble starts fading and when it is gone, on the clock of `now`. */
  fadeAt: number;
  hideAt: number;
  fading: boolean;
}

/** A newly seen activity whose own timestamp is older than this is late history (a reload, an observed transcript catching up), not news. */
export const STALE_ARRIVAL_MS = 30_000;

/**
 * When each activity arrived, by activity id. Ids seen after the first sync
 * arrive `now`; on the first sync (`previous` undefined) activities take their
 * own timestamp, so an Office that mounts again does not replay old lines.
 * Late history (own timestamp older than `STALE_ARRIVAL_MS`) also keeps its own
 * timestamp, so it never pops a bubble for work that already happened.
 * Ids no longer in `activities` are dropped.
 */
export function trackArrivals(previous: ReadonlyMap<string, number> | undefined, activities: readonly OfficeActivity[], now: number): Map<string, number> {
  const arrivals = new Map<string, number>();
  for (const activity of activities) {
    const known = previous?.get(activity.id);
    if (known !== undefined) { arrivals.set(activity.id, known); continue; }
    const at = Date.parse(activity.at);
    const own = Number.isFinite(at) ? Math.min(at, now) : Number.NEGATIVE_INFINITY;
    arrivals.set(activity.id, previous && own >= now - STALE_ARRIVAL_MS ? now : own);
  }
  return arrivals;
}

/** Characters whose bubbles can show in `view`: the same rule as name tags (never on the campus). */
export function bubbleCharacters(allocations: readonly { agentId: string; floor: 1 | 2 | 3 }[], view: FurnishedOfficeView): Set<string> {
  if (view === 'campus') return new Set();
  return new Set(allocations.filter(seat => view === 'stack' || view === seat.floor).map(seat => seat.agentId));
}

/** Synthesize an ongoing activity from a busy character's live presence so its bubble stays visible while working. */
function presenceActivity(agent: BubbleAgent, now: number): OfficeActivity | undefined {
  if (!ACTIVE_STATUSES.has(agent.status)) return undefined;
  // An observed session whose last event is no longer recent is not doing anything right now.
  if (agent.control === 'observed' && agent.live === false) return undefined;
  // Waiting with nothing pending is not an activity in progress: only fresh events show then.
  if (agent.status === 'waiting' && !agent.pendingApprovalId) return undefined;
  const sessionId = agent.sessionId ?? agent.id.split(':')[0] ?? agent.id;
  const at = agent.lastActivityAt ?? new Date(now).toISOString();
  const text = agent.target ?? agent.summary ?? agent.status;
  if (agent.status === 'waiting') {
    return { id: `presence:${agent.id}:waiting`, characterId: agent.id, sessionId, kind: 'approval', text, at };
  }
  if (agent.status === 'delegating' && !agent.activity) {
    return { id: `presence:${agent.id}:delegating`, characterId: agent.id, sessionId, kind: 'delegated', activity: 'delegate', text, at };
  }
  const activity: ActivityKind = agent.activity ?? (agent.status === 'thinking' ? 'think' : 'tool');
  return { id: `presence:${agent.id}:${agent.status}:${activity}`, characterId: agent.id, sessionId, kind: 'tool', activity, text, at };
}

export interface BubbleSelection {
  activities: readonly OfficeActivity[];
  arrivals: ReadonlyMap<string, number>;
  now: number;
  /** Characters on the visible floor. */
  visible: ReadonlySet<string>;
  /** Idle or away characters: no bubble (see `quietCharacters`). */
  quiet?: ReadonlySet<string>;
  /** Live character presences so busy characters keep showing their current activity after the initial event window. */
  agents?: readonly BubbleAgent[];
  selectedId: string | null;
  max?: number;
  visibleMs?: number;
  fadeMs?: number;
}

/**
 * At most one bubble per visible character: its newest activity, while that is
 * a bubble-worthy kind and younger than `visibleMs + fadeMs`, or its ongoing
 * live presence while the character is actively thinking, working, delegating
 * or waiting on a pending approval (observed sessions only while live). A
 * finished turn (`done`) or idle state clears the bubble.
 */
export function selectBubbles({
  activities, arrivals, now, visible, quiet, agents, selectedId, max = MAX_BUBBLES, visibleMs = BUBBLE_VISIBLE_MS, fadeMs = BUBBLE_FADE_MS,
}: BubbleSelection): Map<string, ActivityBubble> {
  const latest = latestByCharacter(activities);
  const candidates: { bubble: ActivityBubble; arrived: number }[] = [];
  const covered = new Set<string>();

  for (const [characterId, activity] of latest) {
    const arrived = arrivals.get(activity.id);
    if (arrived === undefined || !visible.has(characterId) || quiet?.has(characterId) || !bubbleTone(activity.kind)) continue;
    const fadeAt = arrived + visibleMs;
    const hideAt = fadeAt + fadeMs;
    if (now >= hideAt) continue;
    covered.add(characterId);
    candidates.push({
      arrived,
      bubble: { characterId, activity, tone: bubbleTone(activity.kind)!, icon: bubbleIcon(activity), fadeAt, hideAt, fading: now >= fadeAt },
    });
  }

  if (agents) {
    for (const agent of agents) {
      if (covered.has(agent.id) || !visible.has(agent.id) || quiet?.has(agent.id)) continue;
      const lastEvent = latest.get(agent.id);
      if (lastEvent?.kind === 'done') continue;
      const ongoing = presenceActivity(agent, now);
      if (!ongoing) continue;
      const tone = bubbleTone(ongoing.kind);
      if (!tone) continue;
      const arrived = Date.parse(agent.lastActivityAt ?? '') || now;
      candidates.push({
        arrived,
        bubble: {
          characterId: agent.id,
          activity: ongoing,
          tone,
          icon: bubbleIcon(ongoing),
          fadeAt: now + visibleMs,
          hideAt: now + visibleMs + fadeMs,
          fading: false,
        },
      });
    }
  }

  candidates.sort((a, b) => b.arrived - a.arrived || b.bubble.activity.at.localeCompare(a.bubble.activity.at) || a.bubble.characterId.localeCompare(b.bubble.characterId));
  const selected = candidates.find(candidate => candidate.bubble.characterId === selectedId);
  const chosen = (selected ? [selected, ...candidates.filter(candidate => candidate !== selected)] : candidates).slice(0, Math.max(0, max));
  return new Map(chosen.map(({ bubble }) => [bubble.characterId, bubble]));
}

/** Milliseconds until a shown bubble starts fading or disappears, or undefined when nothing is pending. */
export function nextBubbleChange(bubbles: Iterable<ActivityBubble>, now: number): number | undefined {
  let next: number | undefined;
  for (const bubble of bubbles) {
    for (const at of [bubble.fadeAt, bubble.hideAt]) {
      if (at > now && (next === undefined || at - now < next)) next = at - now;
    }
  }
  return next;
}
