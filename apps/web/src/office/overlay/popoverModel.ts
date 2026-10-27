import type { Messages } from '../../i18n';
import type { OfficeAgent } from '../presence';

/** The four states a character card shows; detail stays in the session dialog. */
export type PopoverState = 'working' | 'break' | 'waiting' | 'idle';

/**
 * Short state of a character. `onBreak` is the caller's knowledge that the
 * character sits at a lounge resource; a working character is never on a break.
 */
export function popoverState(agent: Pick<OfficeAgent, 'status' | 'pendingApprovalId'> & Partial<Pick<OfficeAgent, 'stalled'>>, onBreak = false): PopoverState {
  // v0.0.43: a silent agent is not shown working: the Office waits to hear from it.
  if (agent.pendingApprovalId || (agent.stalled && agent.status !== 'offline')) return 'waiting';
  switch (agent.status) {
    case 'working': case 'thinking': case 'delegating': case 'stopping': return 'working';
    case 'waiting': case 'blocked': return 'waiting';
    default: return onBreak ? 'break' : 'idle';
  }
}

/**
 * One plain sentence on what the character is doing, from its reported status
 * and activity kind only. Targets, summaries and commands are never shown here:
 * they can hold paths or terminal text.
 */
export function popoverSummary(t: Messages, agent: Pick<OfficeAgent, 'status' | 'activity' | 'pendingApprovalId'> & Partial<Pick<OfficeAgent, 'phase' | 'reason' | 'stalled' | 'mission'>>, onBreak = false): string {
  const s = t.characterPopover.summary;
  if (agent.pendingApprovalId) return s.approval;
  // v0.0.47: a mission task whose outcome is unknown is not merely blocked: it needs reconciliation.
  if (agent.mission?.state === 'unknown' && agent.status !== 'offline') return t.officeMissions.unknownSummary;
  if (agent.stalled && agent.status !== 'offline') return s.noResponse;
  if (agent.phase === 'error' && agent.reason && agent.reason !== 'interrupted') return s.reason[agent.reason];
  // v0.0.38: a stated phase (planning, waiting for you, compacting, …) says more than the status; a ready agent may be on a break.
  if (agent.phase && !(onBreak && agent.status === 'idle' && agent.phase !== 'error')) return s.phase[agent.phase];
  switch (agent.status) {
    case 'working': case 'thinking': case 'delegating':
      return agent.activity ? s.activity[agent.activity] : s[agent.status];
    case 'waiting': return s.approval;
    case 'stopping': return s.stopping;
    case 'blocked': return s.blocked;
    case 'offline': return s.offline;
    case 'observing': return s.observing;
    case 'paused': return s.paused;
    case 'unavailable': return s.unavailable;
    default: return onBreak ? s.break : s.idle;
  }
}

export type Pixel = readonly [x: number, y: number];
export interface Rect { x: number; y: number; width: number; height: number }
export type PopoverSide = 'above' | 'below' | 'right' | 'left' | 'docked';
/** Card position in stage pixels; `arrow` is the pointer offset along the side facing the character. */
export interface PopoverPlacement { x: number; y: number; side: PopoverSide; arrow: number }

export interface PlacementOptions {
  /** Other overlays (agents panel, lead bar, toasts…) the card should not cover. */
  obstacles?: readonly Rect[];
  /** Space kept free at the stage edges. */
  margin?: number;
  /** Distance between the card and the character. */
  gap?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(Math.max(value, min), Math.max(min, max));

function overlap(a: Rect, b: Rect): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return width > 0 && height > 0 ? width * height : 0;
}

/**
 * Where the character card goes: above the head, below the feet, then beside
 * the character, kept inside the stage. The first side that covers neither
 * another overlay nor the character wins; otherwise the side covering least.
 */
export function placeCharacterPopover(head: Pixel, feet: Pixel, size: Pixel, viewport: Pixel, options: PlacementOptions = {}): PopoverPlacement {
  const { obstacles = [], margin = 8, gap = 12 } = options;
  const [width, height] = size;
  const [viewWidth, viewHeight] = viewport;
  const top = Math.min(head[1], feet[1]), bottom = Math.max(head[1], feet[1]);
  const middle = (top + bottom) / 2;
  // The character's own box (roughly a third of its height wide) must stay visible.
  const bodyWidth = Math.max(16, (bottom - top) * 0.45);
  const body: Rect = { x: head[0] - bodyWidth / 2, y: top, width: bodyWidth, height: bottom - top };
  const fitX = (x: number) => clamp(x, margin, viewWidth - width - margin);
  const fitY = (y: number) => clamp(y, margin, viewHeight - height - margin);
  const candidates: PopoverPlacement[] = [
    { side: 'above', x: fitX(head[0] - width / 2), y: fitY(top - gap - height), arrow: 0 },
    { side: 'below', x: fitX(head[0] - width / 2), y: fitY(bottom + gap), arrow: 0 },
    { side: 'right', x: fitX(head[0] + bodyWidth / 2 + gap), y: fitY(middle - height / 2), arrow: 0 },
    { side: 'left', x: fitX(head[0] - bodyWidth / 2 - gap - width), y: fitY(middle - height / 2), arrow: 0 },
  ];
  let best: PopoverPlacement | undefined;
  let bestCost = Infinity;
  for (const candidate of candidates) {
    const card: Rect = { x: candidate.x, y: candidate.y, width, height };
    // Covering the character is worse than covering a panel: the card points at it.
    const cost = obstacles.reduce((sum, rect) => sum + overlap(card, rect), 0) + overlap(card, body) * 4;
    if (cost < bestCost) { best = candidate; bestCost = cost; }
    if (cost === 0) break;
  }
  const chosen = best!;
  const vertical = chosen.side === 'above' || chosen.side === 'below';
  const arrow = vertical ? clamp(head[0] - chosen.x, 18, width - 18) : clamp(middle - chosen.y, 18, height - 18);
  return { ...chosen, arrow };
}

/** The character is out of view (another floor, off screen): park the card at the top, clear of other overlays. */
export function dockCharacterPopover(size: Pixel, viewport: Pixel, options: Pick<PlacementOptions, 'obstacles' | 'margin'> = {}): PopoverPlacement {
  const { obstacles = [], margin = 8 } = options;
  const [width, height] = size;
  const [viewWidth, viewHeight] = viewport;
  const spots: Array<[number, number]> = [
    [(viewWidth - width) / 2, margin], [margin, margin], [margin, viewHeight - height - margin],
  ];
  let best: [number, number] = spots[0]!;
  let bestCost = Infinity;
  for (const [rawX, rawY] of spots) {
    const x = clamp(rawX, margin, viewWidth - width - margin), y = clamp(rawY, margin, viewHeight - height - margin);
    const cost = obstacles.reduce((sum, rect) => sum + overlap({ x, y, width, height }, rect), 0);
    if (cost < bestCost) { best = [x, y]; bestCost = cost; }
    if (cost === 0) break;
  }
  return { x: best[0], y: best[1], side: 'docked', arrow: width / 2 };
}
