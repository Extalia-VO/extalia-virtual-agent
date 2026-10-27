/**
 * Which seated animation a character shows at its desk, from what its presence
 * reports right now: edits type, reads and searches scroll and read, thinking
 * puts a hand to the chin or leans back, commands and tests type briefly and
 * then watch the output. Idle characters only rest, sip or stretch. Pure and
 * deterministic: the same character, activity and time give the same clip,
 * and a per-character seed keeps neighbours out of step.
 */
import type { ActivityKind } from '@extalia/protocol';
import type { ActivityClip } from '../avatars/activityPose';
import type { OfficeAgentStatus } from '../../presence';

export type DeskMode = 'idle' | 'edit' | 'read' | 'think' | 'run' | 'wait';

/** Statuses that keep a character at its desk (an approval wait included). */
const BUSY: ReadonlySet<OfficeAgentStatus> = new Set(['thinking', 'working', 'delegating', 'waiting', 'blocked', 'stopping']);

export interface DeskPresence {
  readonly status: OfficeAgentStatus;
  readonly activity?: ActivityKind | undefined;
  readonly control?: 'managed' | 'observed' | undefined;
  readonly live?: boolean | undefined;
  readonly pendingApprovalId?: string | undefined;
}

/**
 * Real work in progress: a busy status, except observed sessions whose own
 * events are no longer recent (`live` false) — they are idle, like any other.
 */
export function isBusy(agent: DeskPresence): boolean {
  if (agent.pendingApprovalId) return true;
  if (!BUSY.has(agent.status)) return false;
  return !(agent.control === 'observed' && agent.live === false);
}

export function deskMode(agent: DeskPresence): DeskMode {
  if (!isBusy(agent)) return 'idle';
  if (agent.pendingApprovalId || agent.status === 'waiting' || agent.status === 'blocked') return 'wait';
  if (agent.status === 'thinking' || agent.activity === 'think') return 'think';
  switch (agent.activity) {
    case 'read': case 'search': case 'web': case 'knowledge': return 'read';
    case 'command': case 'test': return 'run';
    default: return 'edit';
  }
}

type Segment = readonly [clip: ActivityClip, seconds: number];
/** Each template is one 24 s rhythm; a hash per character and cycle picks the next one. */
const CYCLE_SECONDS = 24;
const TEMPLATES: Readonly<Record<DeskMode, readonly (readonly Segment[])[]>> = {
  edit: [
    [['typing', 10], ['mouse', 4], ['typing', 6], ['read-screen', 4]],
    [['typing', 8], ['thinking', 4], ['typing', 8], ['mouse', 4]],
    [['typing', 12], ['read-screen', 5], ['typing', 5], ['mouse', 2]],
    [['mouse', 3], ['typing', 11], ['read-screen', 4], ['typing', 6]],
  ],
  read: [
    [['mouse', 7], ['read-screen', 9], ['mouse', 5], ['typing', 3]],
    [['read-screen', 10], ['mouse', 6], ['thinking', 4], ['read-screen', 4]],
    [['mouse', 5], ['read-screen', 7], ['mouse', 7], ['read-screen', 5]],
  ],
  think: [
    [['thinking', 9], ['read-screen', 5], ['lean-back', 6], ['thinking', 4]],
    [['lean-back', 8], ['thinking', 8], ['typing', 4], ['read-screen', 4]],
    [['thinking', 12], ['mouse', 4], ['thinking', 8]],
  ],
  run: [
    [['watch-output', 10], ['mouse', 4], ['watch-output', 6], ['read-screen', 4]],
    [['watch-output', 8], ['thinking', 4], ['watch-output', 8], ['typing', 4]],
    [['watch-output', 14], ['read-screen', 6], ['mouse', 4]],
  ],
  wait: [
    [['read-screen', 8], ['lean-back', 8], ['desk-idle', 8]],
    [['lean-back', 10], ['read-screen', 6], ['desk-idle', 8]],
  ],
  idle: [
    [['desk-idle', 14], ['lean-back', 6], ['desk-idle', 4]],
    [['desk-idle', 10], ['sip', 5], ['desk-idle', 4], ['phone', 7], ['stretch', 3]],
    [['lean-back', 10], ['desk-idle', 8], ['read-screen', 6]],
    [['desk-idle', 8], ['mouse', 5], ['desk-idle', 7], ['sip', 4]],
  ],
};

/** A command or test starts with a few seconds of typing before the output is watched. */
export const RUN_TYPING_SECONDS = 4;

export function clipHash(seed: number, salt: number): number {
  let x = (seed ^ Math.imul(salt + 1, 0x9e3779b1)) >>> 0;
  x ^= x >>> 16; x = Math.imul(x, 0x85ebca6b) >>> 0;
  x ^= x >>> 13; x = Math.imul(x, 0xc2b2ae35) >>> 0;
  x ^= x >>> 16;
  return (x >>> 0) / 4294967296;
}

/**
 * The desk clip for `mode` at `seconds` (any monotonic clock), for a character
 * with `seed`; `sinceChange` is how long the current activity has been reported.
 */
export function deskClip(mode: DeskMode, seconds: number, seed: number, sinceChange = Infinity): ActivityClip {
  if (mode === 'run' && sinceChange < RUN_TYPING_SECONDS) return 'typing';
  const templates = TEMPLATES[mode];
  // Offset per character so neighbours change clips at different moments.
  const shifted = Math.max(0, seconds) + clipHash(seed, 7) * CYCLE_SECONDS;
  const cycle = Math.floor(shifted / CYCLE_SECONDS);
  const template = templates[Math.floor(clipHash(seed, cycle) * templates.length)]!;
  let at = shifted - cycle * CYCLE_SECONDS;
  for (const [clip, length] of template) {
    if (at < length) return clip;
    at -= length;
  }
  return template[template.length - 1]![0];
}
