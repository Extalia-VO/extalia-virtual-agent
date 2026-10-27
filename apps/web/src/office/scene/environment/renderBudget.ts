/**
 * Render budget shared by the adaptive controller, the key light and fixture lighting.
 * Levels trade resolution first, then shadow refresh rate, live fixture beams and shadow
 * detail; the baked fixture irradiance (the visible light pools) is never reduced.
 */
export interface RenderBudgetLevel {
  /** Upper bound for the canvas pixel ratio (the device ratio is never exceeded). */
  maxDpr: number;
  /** Live spot lights that add local detail to the nearest fixtures (baked pools stay). */
  liveBeams: number;
  /** Key light (sun/moon) shadow map size. */
  shadowMapSize: number;
  /** Seconds between shadow map refreshes while no light moves (walkers still update). */
  shadowRefreshSeconds: number;
}

export const RENDER_BUDGET_LEVELS: readonly RenderBudgetLevel[] = [
  { maxDpr: 1.25, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.25 },
  { maxDpr: 1, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.25 },
  // Live beams stay until the last level: hiding a light recompiles every lit material once.
  { maxDpr: 0.85, liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: 0.5 },
  { maxDpr: 0.7, liveBeams: 0, shadowMapSize: 512, shadowRefreshSeconds: 1 },
];

export const TARGET_FPS = 40;

let level = 0;
const listeners = new Set<() => void>();

export function getRenderBudgetLevel(): number { return level; }
export function getRenderBudget(): RenderBudgetLevel { return RENDER_BUDGET_LEVELS[level]!; }
export function setRenderBudgetLevel(next: number): void {
  const clamped = Math.max(0, Math.min(RENDER_BUDGET_LEVELS.length - 1, Math.round(next)));
  if (clamped === level) return;
  level = clamped;
  listeners.forEach(listener => listener());
}
export function subscribeRenderBudget(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Pixel ratio for a level: the display's own ratio (at least 1), capped by the level. */
export function budgetPixelRatio(budget: RenderBudgetLevel, devicePixelRatio: number): number {
  return Math.min(budget.maxDpr, Math.max(1, devicePixelRatio || 1));
}

export interface BudgetSample { fps: number }
export interface BudgetController {
  level: number;
  slow: number;
  fast: number;
  /** Times each level was abandoned for being too slow. */
  failures: number[];
}

export function createBudgetController(): BudgetController {
  return { level: 0, slow: 0, fast: 0, failures: RENDER_BUDGET_LEVELS.map(() => 0) };
}

/**
 * Feed one measurement window (about two seconds). Two slow windows (< target + 5 fps
 * headroom) step down a level; eight smooth windows step back up unless that level
 * has already proved too slow twice. Returns the level to use.
 */
export function updateBudget(controller: BudgetController, { fps }: BudgetSample): number {
  const max = RENDER_BUDGET_LEVELS.length - 1;
  controller.slow = fps < TARGET_FPS + 5 ? controller.slow + 1 : 0;
  controller.fast = fps >= 57 ? controller.fast + 1 : 0;
  if (controller.slow >= 2 && controller.level < max) {
    controller.failures[controller.level] = (controller.failures[controller.level] ?? 0) + 1;
    controller.level += 1;
    controller.slow = 0; controller.fast = 0;
  } else if (controller.fast >= 8 && controller.level > 0 && (controller.failures[controller.level - 1] ?? 0) < 2) {
    controller.level -= 1;
    controller.slow = 0; controller.fast = 0;
  }
  return controller.level;
}

/** State for measuring rendered frame intervals without counting hidden-tab time. */
export interface RenderFrameSampler {
  seconds: number;
  frames: number;
  warmup: number;
  last: number;
}

export function createRenderFrameSampler(warmupSeconds = 3): RenderFrameSampler {
  return { seconds: 0, frames: 0, warmup: warmupSeconds, last: 0 };
}

/**
 * Forget timing across visibility transitions. The first resumed frame only starts
 * the clock; it cannot include time spent in a suspended/background tab.
 */
export function resetRenderFrameSampler(sampler: RenderFrameSampler): void {
  sampler.seconds = 0;
  sampler.frames = 0;
  sampler.last = 0;
  sampler.warmup = Math.max(sampler.warmup, 1);
}

/** Record one foreground frame and return an FPS window once two seconds are measured. */
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
  if (sampler.seconds < 2) return null;
  const fps = sampler.frames / sampler.seconds;
  sampler.seconds = 0;
  sampler.frames = 0;
  return fps;
}
