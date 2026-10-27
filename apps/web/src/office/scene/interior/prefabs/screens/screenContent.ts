import type { ActivityKind } from '@extalia/protocol';
import { MESSAGES, type Language } from '../../../../../i18n';
import type { OfficeAgent, OfficeAgentStatus } from '../../../../presence';
import { presenceCategory, semanticPhrase, type SemanticCategory } from '../../../../semanticBubble';

/**
 * Pure screen-content model: which device shows what, for whom, and when it is dark.
 * Nothing here touches the DOM, three.js or React, so every rule is unit-testable.
 *
 * Truthfulness: content is derived only from the seated presence (`status`, `activity`)
 * and from the device itself. Anything else is generic placeholder art; no file names,
 * command output, test results or metrics are invented. Raw `target` and `summary` text
 * is never painted: the work line is a safe phrase (see `office/semanticBubble.ts`).
 */

/** Physical device. Drives the shell (OS chrome), type size and resolution class. */
export type ScreenDevice = 'monitor' | 'all-in-one' | 'laptop' | 'wall' | 'tv';
/** Visual shell: a bare external display, a desktop with a taskbar, a laptop OS, or a wall panel. */
export type ScreenStyle = 'monitor' | 'desktop' | 'laptop' | 'wall';

/**
 * Authored hint for a screen.
 *  - Workstation devices take their role from the desk slot; only `welcome` (front desk) overrides it.
 *    `code`, `chart`, `ops` and `research` are accepted for older call sites and ignored.
 *  - Wall devices use it as the board type; `status` and unset mean the office overview.
 */
export type ScreenVariant =
  | 'status' | 'code' | 'chart' | 'ops' | 'research'
  | 'agents' | 'presentation' | 'media' | 'welcome' | 'monitoring' | 'diagram' | 'knowledge' | 'signage';

export type ScreenKind =
  | 'editor' | 'terminal' | 'tests' | 'docs' | 'dashboard' | 'approval'
  | 'lock' | 'off'
  | 'agents' | 'standby' | 'media' | 'welcome' | 'monitoring' | 'diagram' | 'signage';

export type ScreenDetail =
  | 'ambient' | 'edit' | 'think' | 'blocked'
  | 'command' | 'test' | 'search' | 'read' | 'web' | 'delegate'
  | 'greeting' | 'directory' | 'idle'
  /** Idle extra displays of a desk: monitor 2 (or the laptop beside a monitor) and monitor 3. */
  | 'screensaver' | 'clock';

export type ScreenMode = 'live' | 'locked' | 'off';

/** Live statuses: the agent is doing (or about to do) something on its machine. */
const LIVE_STATUSES: ReadonlySet<OfficeAgentStatus> = new Set(['thinking', 'working', 'waiting', 'delegating', 'blocked']);

export interface ScreenOccupant {
  name: string;
  status: OfficeAgentStatus;
  activity?: ActivityKind;
  target?: string;
  summary?: string;
}

export function occupantFromAgent(agent: OfficeAgent | undefined): ScreenOccupant | undefined {
  if (!agent) return undefined;
  return {
    name: agent.displayName, status: agent.status,
    ...(agent.activity ? { activity: agent.activity } : {}),
    ...(agent.target ? { target: agent.target } : {}),
    ...(agent.summary ? { summary: agent.summary } : {}),
  };
}

export interface BoardAgent { name: string; status: OfficeAgentStatus; activity?: ActivityKind }
/** Real counts behind the office-overview boards: nothing here is invented. */
export interface BoardData {
  total: number;
  /** Agents per status (offline presences are not counted). */
  statuses: Partial<Record<OfficeAgentStatus, number>>;
  activities: Partial<Record<ActivityKind, number>>;
  /** The first few agents, busiest first. */
  top: BoardAgent[];
}

const STATUS_RANK: Record<string, number> = { working: 0, waiting: 1, blocked: 2, delegating: 3, thinking: 4, observing: 5, idle: 6, paused: 7, stopping: 8, unavailable: 9 };

export function boardFromAgents(agents: readonly OfficeAgent[], limit = 6): BoardData {
  const present = agents.filter(agent => agent.status !== 'offline');
  const statuses: BoardData['statuses'] = {};
  const activities: BoardData['activities'] = {};
  for (const agent of present) {
    statuses[agent.status] = (statuses[agent.status] ?? 0) + 1;
    if (agent.activity && isLiveStatus(agent.status)) activities[agent.activity] = (activities[agent.activity] ?? 0) + 1;
  }
  const top = present
    .slice()
    .sort((a, b) => (STATUS_RANK[a.status] ?? 10) - (STATUS_RANK[b.status] ?? 10) || a.displayName.localeCompare(b.displayName) || a.id.localeCompare(b.id))
    .slice(0, limit)
    .map(agent => ({ name: agent.displayName, status: agent.status, ...(agent.activity ? { activity: agent.activity } : {}) }));
  return { total: present.length, statuses, activities, top };
}

export interface ScreenRequest {
  device: ScreenDevice;
  variant?: ScreenVariant | undefined;
  /** 1-based role index on a multi-screen desk: 1 = main/editor, 2 = terminal/tests, 3 = docs. */
  slot?: number | undefined;
  /** Number of screens on the desk (1 for a single screen). */
  slots?: number | undefined;
  occupant?: ScreenOccupant | undefined;
  /** What an unoccupied workstation screen shows: the lock screen, or a front-desk welcome screen. */
  idleContent?: 'lock' | 'welcome' | undefined;
  lightsOn: boolean;
  /** True after dusk; with the lamps off an unoccupied screen goes dark. */
  night: boolean;
  /** False for a screen that is physically off. */
  powered?: boolean | undefined;
  /** Reduced motion: animated content is painted once; only clocks keep ticking. */
  reducedMotion?: boolean | undefined;
}

export interface ResolvedScreen {
  mode: ScreenMode;
  kind: ScreenKind;
  style: ScreenStyle;
  detail: ScreenDetail;
  /** The focus screen of an active desk: animated and highlighted. Other screens stay ambient. */
  hot: boolean;
  /** Repaint interval in ms for live content; 0 = painted once. Never below `MIN_LIVE_INTERVAL_MS`. */
  liveMs: number;
  /** What the screen says about the work: a safe category, never the raw command, path or summary. */
  phrase?: SemanticCategory;
  name?: string;
  /** Status key for the lock screen label (translated at draw time). */
  label?: string;
}

/** Live textures repaint at most twice per second. */
export const MIN_LIVE_INTERVAL_MS = 500;
const CLOCK_INTERVAL_MS = 15_000;

export function styleForDevice(device: ScreenDevice): ScreenStyle {
  return device === 'laptop' ? 'laptop' : device === 'all-in-one' ? 'desktop' : device === 'monitor' ? 'monitor' : 'wall';
}
export const isWallDevice = (device: ScreenDevice) => device === 'wall' || device === 'tv';

export function isLiveStatus(status: OfficeAgentStatus): boolean {
  return LIVE_STATUSES.has(status);
}

type WorkKind = 'editor' | 'terminal' | 'tests' | 'docs' | 'dashboard' | 'approval';
interface Intent { kind: WorkKind; detail: ScreenDetail }

/**
 * Activity to content: edit → editor with a moving highlighted line; command/test → terminal / test
 * runner; search/read/web/knowledge → docs or browser; thinking → editor with a blinking cursor;
 * waiting (approval) → an approval dialog; delegating → an agent overview.
 */
export function intentForOccupant(occupant: ScreenOccupant): Intent {
  if (occupant.status === 'waiting') return { kind: 'approval', detail: 'idle' };
  switch (occupant.activity) {
    case 'edit': return { kind: 'editor', detail: 'edit' };
    case 'command': case 'tool': return { kind: 'terminal', detail: 'command' };
    case 'test': return { kind: 'tests', detail: 'test' };
    case 'search': return { kind: 'docs', detail: 'search' };
    case 'read': case 'knowledge': return { kind: 'docs', detail: 'read' };
    case 'web': return { kind: 'docs', detail: 'web' };
    case 'delegate': return { kind: 'dashboard', detail: 'delegate' };
    case 'think': return { kind: 'editor', detail: 'think' };
    default: break;
  }
  if (occupant.status === 'delegating') return { kind: 'dashboard', detail: 'delegate' };
  if (occupant.status === 'blocked') return { kind: 'editor', detail: 'blocked' };
  return { kind: 'editor', detail: 'think' };
}

/** Default (ambient) role of a desk slot. */
export function slotRole(slot: number, slots: number): WorkKind {
  if (slots <= 1) return 'editor';
  if (slot <= 1) return 'editor';
  return slot === 2 ? 'terminal' : 'docs';
}

/** Idle picture of a desk slot: the lock prompt on the main display, a screensaver on 2, a clock on 3+. */
export function idleDetail(slot: number): ScreenDetail {
  return slot <= 1 ? 'idle' : slot === 2 ? 'screensaver' : 'clock';
}

/** 1-based slot that shows an intent on a desk with `slots` screens. */
export function hotSlotFor(kind: WorkKind, slots: number): number {
  if (slots <= 1 || kind === 'approval' || kind === 'editor') return 1;
  if (kind === 'terminal' || kind === 'tests') return 2;
  return slots >= 3 ? 3 : 2;
}

const wallKind = (variant: ScreenVariant | undefined): ScreenKind => {
  switch (variant) {
    case 'presentation': return 'standby';
    case 'media': return 'media';
    case 'welcome': return 'welcome';
    case 'monitoring': return 'monitoring';
    case 'diagram': return 'diagram';
    case 'signage': return 'signage';
    case 'knowledge': return 'docs';
    default: return 'agents';
  }
};

/** Kinds that draw a clock: under reduced motion they keep updating at the clock rate and nothing else moves. */
const CLOCK_KINDS: ReadonlySet<ScreenKind> = new Set(['lock', 'agents', 'standby', 'welcome', 'signage']);

const LIVE_MS: Record<ScreenKind, number> = {
  editor: MIN_LIVE_INTERVAL_MS, terminal: MIN_LIVE_INTERVAL_MS, tests: MIN_LIVE_INTERVAL_MS, docs: MIN_LIVE_INTERVAL_MS,
  dashboard: MIN_LIVE_INTERVAL_MS, approval: MIN_LIVE_INTERVAL_MS,
  lock: 900, off: 0, agents: 900, standby: 900, media: MIN_LIVE_INTERVAL_MS,
  welcome: 900, monitoring: MIN_LIVE_INTERVAL_MS, diagram: MIN_LIVE_INTERVAL_MS, signage: 900,
};
const AMBIENT_LIVE_MS = 1000;
const STATIC_WHEN_AMBIENT: ReadonlySet<ScreenKind> = new Set(['editor', 'terminal', 'tests', 'docs', 'dashboard']);

function finish(base: Omit<ResolvedScreen, 'liveMs'>): ResolvedScreen {
  const liveMs = base.mode === 'off' ? 0
    : STATIC_WHEN_AMBIENT.has(base.kind) && !base.hot ? AMBIENT_LIVE_MS : LIVE_MS[base.kind];
  return { ...base, liveMs };
}

/** Lock-screen status label key for a seated but not actively working presence. */
const LOCK_LABEL: Partial<Record<OfficeAgentStatus, string>> = {
  idle: 'IDLE', observing: 'OBSERVING', paused: 'PAUSED', unavailable: 'UNAVAILABLE', stopping: 'STOPPING',
};

export function resolveScreenContent(request: ScreenRequest): ResolvedScreen {
  const resolved = resolveContent(request);
  if (!request.reducedMotion || resolved.liveMs === 0) return resolved;
  return { ...resolved, liveMs: CLOCK_KINDS.has(resolved.kind) ? CLOCK_INTERVAL_MS : 0 };
}

function resolveContent(request: ScreenRequest): ResolvedScreen {
  const style = styleForDevice(request.device);
  const dark = (kind: ScreenKind = 'off'): ResolvedScreen => finish({ mode: 'off', kind, style, detail: 'ambient', hot: false });
  if (request.powered === false) return dark();

  if (isWallDevice(request.device)) {
    const kind = wallKind(request.variant);
    return finish({
      mode: 'live', kind, style, hot: true,
      detail: kind === 'docs' ? 'read' : kind === 'welcome' ? 'greeting' : 'ambient',
    });
  }

  const slot = Math.max(1, Math.floor(request.slot ?? 1));
  const slots = Math.max(slot, Math.floor(request.slots ?? 1));
  if (request.variant === 'welcome') {
    return finish({ mode: 'live', kind: 'welcome', style, hot: true, detail: slot >= 2 ? 'directory' : 'greeting' });
  }

  const occupant = request.occupant;
  // Only the main display shows the lock prompt; the desk's other displays idle with their own picture.
  const lockDetail = idleDetail(slot);
  if (!occupant || occupant.status === 'offline') {
    if (request.idleContent === 'welcome') return finish({ mode: 'live', kind: 'welcome', style, hot: true, detail: 'greeting' });
    if (occupant?.status === 'offline' && !request.lightsOn && request.night) return dark();
    return finish({ mode: 'locked', kind: 'lock', style, detail: lockDetail, hot: false });
  }
  if (!isLiveStatus(occupant.status)) {
    const label = LOCK_LABEL[occupant.status];
    return finish({
      mode: 'locked', kind: 'lock', style, detail: lockDetail, hot: false,
      ...(lockDetail === 'idle' ? { name: occupant.name, ...(label ? { label } : {}) } : {}),
    });
  }

  const intent = intentForOccupant(occupant);
  const phrase = presenceCategory(occupant);
  if (slot === hotSlotFor(intent.kind, slots)) {
    return finish({
      mode: 'live', kind: intent.kind, style, detail: intent.detail, hot: true, name: occupant.name,
      ...(phrase ? { phrase } : {}),
    });
  }
  // The agent is busy on another screen of this desk: this one keeps its own role, still and distinct.
  return finish({ mode: 'live', kind: slotRole(slot, slots), style, detail: 'ambient', hot: false, name: occupant.name });
}

// ---------------------------------------------------------------------------------------------
// Surface specification and cache key
// ---------------------------------------------------------------------------------------------

export const DESIGN_WIDTH = 1024;

export interface SurfaceGeometry { designHeight: number; pixelWidth: number; pixelHeight: number }

/** Canvas size for a panel: 1024 design units wide, height from the panel's real aspect ratio. */
export function surfaceGeometry(width: number, height: number): SurfaceGeometry {
  const aspect = width / Math.max(1e-3, height);
  const designHeight = Math.max(256, Math.min(640, Math.round(DESIGN_WIDTH / aspect / 16) * 16));
  // Desk-scale panels never fill more than ~100 px of a typical view; wall panels get the full width.
  const pixelWidth = width <= 1.2 ? 512 : 1024;
  return { designHeight, pixelWidth, pixelHeight: Math.round(pixelWidth * designHeight / DESIGN_WIDTH) };
}

export interface SurfaceInputs {
  language: string;
  /** Stable per-seat offset (0..3) so neighbouring desks neither animate in lockstep nor share a wallpaper. */
  phase: number;
  /** Authored heading of a wall board (an architectural label, already translated or authored). */
  title?: string | undefined;
  subtitle?: string | undefined;
  /** What the office-overview board shows; only part of the key for that kind. */
  board?: BoardData | undefined;
}

export interface SurfaceSpec extends ResolvedScreen, SurfaceGeometry, Required<Pick<SurfaceInputs, 'language' | 'phase'>> {
  key: string;
  /** Painter text for the work line: the `phrase` in the spec's language. Never raw presence text. */
  target?: string | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  board?: BoardData | undefined;
}

/** FNV-1a, enough to keep keys short while text content stays part of them. */
export function hashText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/** Seat-stable 0..3 phase; undefined ids share phase 0. */
export function phaseFor(id: string | undefined): number {
  if (!id) return 0;
  return Number.parseInt(hashText(id).slice(-2), 36) % 4;
}

/** Kinds whose pixels depend on the per-seat phase. */
const PHASED: ReadonlySet<ScreenKind> = new Set(['lock', 'editor', 'terminal', 'tests', 'docs', 'dashboard', 'approval', 'media', 'monitoring', 'diagram']);

/**
 * Cache key: every input that changes the pixels, nothing else. Two screens with the same key share
 * one canvas texture, so a 16-seat pod with the same activity costs a handful of textures.
 */
export function buildSurfaceSpec(resolved: ResolvedScreen, geometry: SurfaceGeometry, inputs: SurfaceInputs): SurfaceSpec {
  const phase = PHASED.has(resolved.kind) ? inputs.phase % 4 : 0;
  const board = resolved.kind === 'agents' ? inputs.board : undefined;
  const messages = MESSAGES[inputs.language as Language] ?? MESSAGES.en;
  const target = resolved.phrase ? semanticPhrase(resolved.phrase, messages) : undefined;
  const text = JSON.stringify([resolved.phrase ?? '', resolved.name ?? '', resolved.label ?? '',
    inputs.title ?? '', inputs.subtitle ?? '', board ?? '']);
  const key = [
    'screen', resolved.kind, resolved.style, resolved.detail, resolved.hot ? 'hot' : 'amb',
    `${geometry.designHeight}.${geometry.pixelWidth}`, inputs.language, phase, hashText(text),
  ].join('|');
  return { ...resolved, ...geometry, key, language: inputs.language, phase, target, title: inputs.title, subtitle: inputs.subtitle, board };
}
