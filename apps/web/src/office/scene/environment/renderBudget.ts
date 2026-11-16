/**
 * Render budget shared by the adaptive controller, the key light and fixture lighting.
 * Resolution probes leave lights, shadows and traffic unchanged so pixel response
 * can be measured without changing the scene workload.
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

const SCENE_RESOURCES = { maxDpr: 2, maxPixels: 3840 * 2160, liveBeams: 6,
  shadowMapSize: 1024, shadowRefreshSeconds: 0.5, trafficCars: 10 };
export const RENDER_BUDGET_LEVELS: readonly RenderBudgetLevel[] = [2160, 1440, 1080, 900, 720]
  .map(resolutionHeight => ({ ...SCENE_RESOURCES, resolutionHeight }));

/** An adaptation objective, never a limit on requestAnimationFrame or delivered FPS. */
export const TARGET_FPS = 60;
/** Begin sharp, then let measured load reduce the drawing buffer if necessary. */
export const INITIAL_RENDER_BUDGET_LEVEL = 2;
/** Lowest-resolution 720p tier in `RENDER_BUDGET_LEVELS`. */
export const LIGHTWEIGHT_RENDER_BUDGET_LEVEL = 4;

export interface GpuTierInput {
  renderer?: string | null | undefined;
  vendor?: string | null | undefined;
  devicePixelRatio?: number | null | undefined;
  width?: number | null | undefined;
  height?: number | null | undefined;
  hardwareConcurrency?: number | null | undefined;
}

const DISCRETE_GPU_PATTERN = /nvidia|geforce|rtx|gtx|quadro|radeon\s+rx|radeon\s+pro|arc\s+a\d|apple\s+m[1-9]\s+(?:max|ultra)/i;
const INTEGRATED_OR_MOBILE_GPU_PATTERN = /intel|iris|uhd|hd\s+graphics|apple\s+m[1-9](?!\s+(?:max|ultra))|apple\s+gpu|amd\s+radeon\(tm\)\s+graphics|radeon\s+graphics|vega|adreno|mali|powervr|llvmpipe|swiftshader|subzero|virgl|basic\s+render/i;

/** Classify integrated/mobile/software GPUs vs discrete GPUs from WebGL renderer metadata and display geometry. */
export function detectInitialRenderBudgetLevel(input?: GpuTierInput | null): number {
  if (!input) return INITIAL_RENDER_BUDGET_LEVEL;
  const signature = `${input.vendor ?? ''} ${input.renderer ?? ''}`.trim();
  if (signature && DISCRETE_GPU_PATTERN.test(signature)) return INITIAL_RENDER_BUDGET_LEVEL;
  if (signature && INTEGRATED_OR_MOBILE_GPU_PATTERN.test(signature)) return LIGHTWEIGHT_RENDER_BUDGET_LEVEL;
  const dpr = typeof input.devicePixelRatio === 'number' && Number.isFinite(input.devicePixelRatio) ? input.devicePixelRatio : 1;
  const cores = typeof input.hardwareConcurrency === 'number' && Number.isFinite(input.hardwareConcurrency) ? input.hardwareConcurrency : 8;
  if (dpr >= 1.5 || cores <= 6) return LIGHTWEIGHT_RENDER_BUDGET_LEVEL;
  return INITIAL_RENDER_BUDGET_LEVEL;
}

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

export interface BudgetSample {
  /** Hitch-filtered rate from the same foreground window. */
  fps: number;
  /** Actual delivered throughput; repeated hitches must not look like spare capacity. */
  rawFps?: number | null | undefined;
}

/** Keep adaptation aligned with delivered FPS without rejecting older filtered-only callers. */
export function effectiveBudgetFps({ fps, rawFps }: BudgetSample): number {
  if (!Number.isFinite(fps) || fps <= 0) return fps;
  return typeof rawFps === 'number' && Number.isFinite(rawFps) && rawFps > 0 ? Math.min(fps, rawFps) : fps;
}
type Probe = { from: number; direction: 'down' | 'up'; beforeMs: number; samples: number[] };
export interface BudgetController {
  level: number;
  slow: number;
  fast: number;
  windows: number;
  lastChange: number;
  downAfter: number;
  restoreAfter: number;
  history: number[];
  probe?: Probe;
  decision: 'initial' | 'invalidated' | 'probe-down' | 'probe-up' | 'retained' | 'no-response' | 'restored' | 'restore-costly' | 'unstable';
  baselineMs: number | null;
  candidateMs: number | null;
}

/** Valid, warmed foreground windows; there is no wall-clock expiry in hidden tabs. */
export const SLOW_WINDOWS = 3;
export const RECOVERY_WINDOWS = 6;
export const PROBE_WINDOWS = 20;
export const PROBE_SAMPLE_WINDOWS = 3;
export const MAX_RETRY_WINDOWS = 60;
const median = (values: readonly number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
const steady = (values: readonly number[]) => values.length >= PROBE_SAMPLE_WINDOWS
  && Math.max(...values) - Math.min(...values) <= Math.max(2, median(values) * 0.15);

export function createBudgetController(): BudgetController {
  return { level: INITIAL_RENDER_BUDGET_LEVEL, slow: 0, fast: 0, windows: 0, lastChange: 0,
    downAfter: 0, restoreAfter: 0, history: [], decision: 'initial', baselineMs: null, candidateMs: null };
}

/** Abort an unproven trial on a new view/load/context, restoring its confirmed level. */
export function resetBudgetController(controller: BudgetController, next = controller.probe?.from ?? controller.level): number {
  delete controller.probe;
  Object.assign(controller, createBudgetController(), { level: next, decision: 'invalidated' });
  return controller.level;
}

export interface BudgetRosterMember {
  readonly id: string;
  phase: string;
  opacity: number;
  floorLow?: number;
  floorHigh?: number;
}
export interface BudgetComposition {
  key: string;
  transient: boolean;
  rosterCount: number;
}

/** Once per measured window: exact membership/phase/resource identity, not a lossy count hash. */
export function budgetComposition(input: { view: string | number; admittedIdentity: string; roster: readonly BudgetRosterMember[];
  geometries: number; textures: number; avatarEpoch: number }): BudgetComposition {
  let transient = false;
  const roster = input.roster.map(member => {
    const fade = !Number.isFinite(member.opacity) ? 1 : member.opacity <= 0 ? 0 : member.opacity >= 1 ? 2 : 1;
    if (fade === 1 || member.phase === 'vanishing') transient = true;
    return [member.id, member.phase, fade, member.floorLow ?? null, member.floorHigh ?? null];
  }).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return { key: JSON.stringify([input.view, input.admittedIdentity, roster, input.geometries, input.textures, input.avatarEpoch]),
    transient, rosterCount: roster.length };
}

/** Roll back an unproven probe before changed composition can be credited as pixel savings. */
export function observeBudgetComposition(controller: BudgetController, guard: { key: string | null }, composition: BudgetComposition): boolean {
  const changed = guard.key !== composition.key || composition.transient;
  guard.key = composition.key;
  if (changed) resetBudgetController(controller);
  return changed;
}

/**
 * Test one adjacent resolution using warmed raw frame times, retaining a reduction
 * only when it saves both 10% and 2 ms. Ineffective reductions roll back and cool
 * down; periodic restoration can recover sharpness even on CPU-bound <60 Hz views.
 * No sleep, frame skipping or FPS ceiling is introduced here.
 */
export function updateBudget(controller: BudgetController, sample: BudgetSample, pixelRatio?: (level: number) => number): number {
  const fps = effectiveBudgetFps(sample);
  if (!Number.isFinite(fps) || fps <= 0) return controller.level;
  const ms = 1000 / fps;
  controller.windows++;
  if (controller.probe) {
    const probe = controller.probe;
    probe.samples.push(ms);
    if (probe.samples.length < PROBE_SAMPLE_WINDOWS) return controller.level;
    const after = median(probe.samples), stable = steady(probe.samples);
    controller.baselineMs = probe.beforeMs; controller.candidateMs = after;
    const improved = probe.beforeMs - after + 1e-6 >= Math.max(2, probe.beforeMs * 0.1);
    const affordable = after <= probe.beforeMs + Math.max(1, probe.beforeMs * 0.05)
      || after <= 1000 / TARGET_FPS + 1e-6;
    if (!stable || (probe.direction === 'down' ? !improved : !affordable)) {
      controller.level = probe.from;
      controller.decision = !stable ? 'unstable' : probe.direction === 'down' ? 'no-response' : 'restore-costly';
      if (probe.direction === 'down') controller.downAfter = controller.windows + MAX_RETRY_WINDOWS;
      else controller.restoreAfter = controller.windows + MAX_RETRY_WINDOWS;
    } else {
      controller.decision = probe.direction === 'down' ? 'retained' : 'restored';
      // Let a restored view settle before another reduction is considered.
      if (probe.direction === 'up') controller.downAfter = Math.max(controller.downAfter, controller.windows + PROBE_WINDOWS);
    }
    delete controller.probe;
    controller.history = []; controller.slow = 0; controller.fast = 0;
    controller.lastChange = controller.windows;
    return controller.level;
  }
  controller.history.push(ms);
  if (controller.history.length > PROBE_SAMPLE_WINDOWS) controller.history.shift();
  controller.slow = fps < TARGET_FPS * 0.95 ? controller.slow + 1 : 0;
  controller.fast = fps >= TARGET_FPS * 0.97 ? controller.fast + 1 : 0;
  if (!steady(controller.history)) return controller.level;
  const restore = controller.level > 0 && controller.windows >= controller.restoreAfter
    && (controller.fast >= RECOVERY_WINDOWS || controller.windows - controller.lastChange >= PROBE_WINDOWS);
  const reduce = controller.level < RENDER_BUDGET_LEVELS.length - 1 && controller.windows >= controller.downAfter
    && controller.slow >= SLOW_WINDOWS;
  const nextLevel = (step: -1 | 1) => {
    if (!pixelRatio) return controller.level + step;
    const ratio = pixelRatio(controller.level);
    for (let next = controller.level + step; next >= 0 && next < RENDER_BUDGET_LEVELS.length; next += step) {
      if (Math.abs(pixelRatio(next) - ratio) > 1e-6) return next;
    }
    return undefined;
  };
  const sharper = restore ? nextLevel(-1) : undefined;
  const next = sharper ?? (reduce ? nextLevel(1) : undefined);
  if (next !== undefined) {
    const direction = sharper === undefined ? 'down' : 'up';
    controller.probe = { from: controller.level, direction, beforeMs: median(controller.history), samples: [] };
    controller.baselineMs = controller.probe.beforeMs; controller.candidateMs = null;
    controller.level = next;
    controller.decision = direction === 'up' ? 'probe-up' : 'probe-down';
    controller.history = []; controller.slow = 0; controller.fast = 0;
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
