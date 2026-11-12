/**
 * Render budget shared by the adaptive controller, the key light and fixture lighting.
 * Levels trade resolution first, then shadow refresh rate, live fixture beams and shadow
 * detail; the baked fixture irradiance (the visible light pools) is never reduced.
 */
export interface RenderBudgetLevel {
  /** Upper bound for the canvas pixel ratio (the device ratio is never exceeded). */
  maxDpr: number;
  /** Maximum physical canvas short edge in pixels; aspect ratio can change the long edge. */
  resolutionHeight: number;
  /** Optional total physical canvas pixel cap, including ultrawide canvases. */
  maxPixels?: number;
  /** Live spot lights that add local detail to the nearest fixtures (baked pools stay). */
  liveBeams: number;
  /** Key light (sun/moon) shadow map size. */
  shadowMapSize: number;
  /** Seconds between shadow map refreshes while no light moves (walkers still update). */
  shadowRefreshSeconds: number;
  /** Most campus cars moving at once (instanced; their real headlight spots stay at two). */
  trafficCars: number;
}

export const RENDER_BUDGET_LEVELS: readonly RenderBudgetLevel[] = [
  { resolutionHeight: 2160, maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.25, trafficCars: 16 },
  { resolutionHeight: 1440, maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.25, trafficCars: 14 },
  { resolutionHeight: 1080, maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.5, trafficCars: 10 },
  // Keep the first recovery step cheap; changing the live-light count recompiles lit materials.
  { resolutionHeight: 720, maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 0, shadowMapSize: 512, shadowRefreshSeconds: 1, trafficCars: 6 },
  { resolutionHeight: 480, maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 0, shadowMapSize: 512, shadowRefreshSeconds: 1, trafficCars: 6 },
];

export const TARGET_FPS = 40;
/** Begin sharp, then let measured load reduce the drawing buffer if necessary. */
export const INITIAL_RENDER_BUDGET_LEVEL = 2;

let level = INITIAL_RENDER_BUDGET_LEVEL;
const listeners = new Set<() => void>();

export function getRenderBudgetLevel(): number { return level; }
export function getRenderBudget(): RenderBudgetLevel { return RENDER_BUDGET_LEVELS[level]!; }
export function setRenderBudgetLevel(next: number): void {
  if (!Number.isFinite(next)) return;
  const clamped = Math.max(0, Math.min(RENDER_BUDGET_LEVELS.length - 1, Math.round(next)));
  if (clamped === level) return;
  level = clamped;
  listeners.forEach(listener => listener());
}
export function subscribeRenderBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Fit physical resolution to the level and native display without supersampling small canvases. */
export function budgetPixelRatio(budget: RenderBudgetLevel, devicePixelRatio: number, width = 1920, height = 1080): number {
  const nativeRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  const cssWidth = Number.isFinite(width) && width > 0 ? width : 1920;
  const cssHeight = Number.isFinite(height) && height > 0 ? height : 1080;
  // Taking each square root first avoids overflow for very large finite dimensions.
  const pixelCap = budget.maxPixels !== undefined && Number.isFinite(budget.maxPixels) && budget.maxPixels > 0
    ? Math.sqrt(budget.maxPixels) / Math.sqrt(cssWidth) / Math.sqrt(cssHeight)
    : Infinity;
  return Math.min(nativeRatio, budget.maxDpr, budget.resolutionHeight / Math.min(cssWidth, cssHeight), pixelCap);
}

export interface BudgetSample { fps: number }
export interface BudgetController {
  level: number;
  slow: number;
  fast: number;
  /** Saturating failure count per level, used only for bounded retry backoff. */
  failures: number[];
  /** Foreground measurement windows only: hidden time never expires a retry delay. */
  windows: number;
  retryAfter: number[];
  stable: number;
}

export function createBudgetController(): BudgetController {
  return { level: INITIAL_RENDER_BUDGET_LEVEL, slow: 0, fast: 0, stable: 0, windows: 0,
    failures: RENDER_BUDGET_LEVELS.map(() => 0), retryAfter: RENDER_BUDGET_LEVELS.map(() => 0) };
}

/** Windows (about one second each) of sustained headroom before trying the level above again. */
export const RECOVERY_WINDOWS = 6;
/** Also probe higher quality on a stable, frame-capped display without requiring 57/60 Hz. */
export const PROBE_WINDOWS = 30;
export const MAX_RETRY_WINDOWS = 120;

/**
 * Feed one measurement window (about one second). A window slower than the target (mean frame time
 * over 25 ms) steps down a level at once; two windows in a row under the target + 5 fps headroom also
 * step down. Six windows with headroom (≥ 48 fps), or thirty stable windows (≥ 40 fps), try
 * one sharper level. Failed levels cool down for 15/30/60/120 foreground windows, never
 * permanently locking out recovery after a heavy scene, resize or temporary load.
 */
export function updateBudget(controller: BudgetController, { fps }: BudgetSample): number {
  const max = RENDER_BUDGET_LEVELS.length - 1;
  if (!Number.isFinite(fps) || fps <= 0) return controller.level;
  controller.windows += 1;
  controller.slow = fps < TARGET_FPS + 5 ? controller.slow + 1 : 0;
  controller.fast = fps >= 48 ? controller.fast + 1 : 0;
  controller.stable = fps >= TARGET_FPS ? controller.stable + 1 : 0;
  if ((fps < TARGET_FPS || controller.slow >= 2) && controller.level < max) {
    const failures = Math.min(4, (controller.failures[controller.level] ?? 0) + 1);
    controller.failures[controller.level] = failures;
    controller.retryAfter[controller.level] = controller.windows + Math.min(MAX_RETRY_WINDOWS, 15 * 2 ** (failures - 1));
    controller.level += 1;
    controller.slow = 0; controller.fast = 0; controller.stable = 0;
  } else if ((controller.fast >= RECOVERY_WINDOWS || controller.stable >= PROBE_WINDOWS)
    && controller.level > 0 && controller.windows >= controller.retryAfter[controller.level - 1]!) {
    controller.level -= 1;
    controller.slow = 0; controller.fast = 0; controller.stable = 0;
  }
  return controller.level;
}

/** State for measuring rendered frame intervals without counting hidden-tab time. */
export interface RenderFrameSampler {
  seconds: number;
  frames: number;
  warmup: number;
  last: number;
  /** Longest frame interval (seconds) in the current window. */
  longest: number;
  /** Unfiltered throughput for the visible FPS readout (includes one-off hitches). */
  rawFps: number | null;
}

export function createRenderFrameSampler(warmupSeconds = 3): RenderFrameSampler {
  return { seconds: 0, frames: 0, warmup: warmupSeconds, last: 0, longest: 0, rawFps: null };
}

/** Windows with at least this many frames ignore their single longest frame (a one-off hitch). */
const HITCH_MIN_FRAMES = 10;

/**
 * Forget timing across visibility transitions. The first resumed frame only starts
 * the clock; it cannot include time spent in a suspended/background tab.
 */
export function resetRenderFrameSampler(sampler: RenderFrameSampler): void {
  sampler.seconds = 0;
  sampler.frames = 0;
  sampler.longest = 0;
  sampler.rawFps = null;
  sampler.last = 0;
  sampler.warmup = Math.max(sampler.warmup, 1);
}

/** Seconds per measurement window: short, so a slow scene is caught within about a second. */
export const BUDGET_WINDOW_SECONDS = 1;

/** Record one foreground frame and return an FPS window once a window is measured. */
export function sampleRenderFrame(sampler: RenderFrameSampler, nowMs: number, visible: boolean): number | null {
  if (!visible) {
    resetRenderFrameSampler(sampler);
    return null;
  }
  if (!sampler.last) {
    sampler.last = nowMs;
    return null;
  }
  const seconds = Math.max(0, (nowMs - sampler.last) / 1000);
  sampler.last = nowMs;
  if (sampler.warmup > 0) {
    sampler.warmup = Math.max(0, sampler.warmup - seconds);
    return null;
  }
  // Keep real elapsed time, including long foreground stalls: discarding these
  // intervals made sustained low-FPS rendering invisible to the budget controller.
  sampler.seconds += seconds;
  sampler.frames += 1;
  sampler.longest = Math.max(sampler.longest, seconds);
  if (sampler.seconds < BUDGET_WINDOW_SECONDS) return null;
  // A single hitch (a shader compile, a texture upload) is not a slow scene: a window that otherwise
  // ran smoothly leaves it out, so it cannot cost a level that would then take seconds to win back.
  // Stalls in short windows (few frames) and repeated slow frames still count in full.
  const hitch = sampler.frames >= HITCH_MIN_FRAMES ? sampler.longest : 0;
  sampler.rawFps = sampler.frames / sampler.seconds;
  const fps = (sampler.frames - (hitch ? 1 : 0)) / Math.max(1e-6, sampler.seconds - hitch);
  sampler.seconds = 0;
  sampler.frames = 0;
  sampler.longest = 0;
  return fps;
}
