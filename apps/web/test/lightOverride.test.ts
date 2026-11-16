import { describe, expect, it } from 'vitest';
import { DAYLIGHT_INTERIOR_LEVEL, LIGHT_OVERRIDE_STORAGE_KEY, loadLightOverride, resolveInteriorLights, saveLightOverride } from '../src/office/scene/environment/lightOverride';
import {
  createBudgetController, createRenderFrameSampler, detectInitialRenderBudgetLevel, getRenderBudget,
  getRenderBudgetLevel, INITIAL_RENDER_BUDGET_LEVEL, LIGHTWEIGHT_RENDER_BUDGET_LEVEL, MAX_RETRY_WINDOWS,
  PROBE_WINDOWS, RECOVERY_WINDOWS, PROBE_SAMPLE_WINDOWS, RENDER_BUDGET_LEVELS, SLOW_WINDOWS, TARGET_FPS,
  budgetPixelRatio, effectiveBudgetFps, resetBudgetController, resetRenderFrameSampler, sampleRenderFrame,
  setRenderBudgetLevel, updateBudget,
} from '../src/office/scene/environment/renderBudget';

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    values,
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

describe('lights override', () => {
  it('follows the time of day in auto', () => {
    expect(resolveInteriorLights('auto', 0)).toEqual({ lightsOn: false, interiorLightFactor: DAYLIGHT_INTERIOR_LEVEL });
    expect(resolveInteriorLights('auto', 1)).toEqual({ lightsOn: true, interiorLightFactor: 1 });
    expect(resolveInteriorLights('auto', 0.49).lightsOn).toBe(false);
    expect(resolveInteriorLights('auto', 0.5).lightsOn).toBe(true);
    expect(resolveInteriorLights('auto', 2).interiorLightFactor).toBe(1);
  });

  it('forces lamps on while Off preserves daylight fill and fades it out at night', () => {
    for (const demand of [0, 0.5, 1]) {
      expect(resolveInteriorLights('on', demand)).toEqual({ lightsOn: true, interiorLightFactor: 1 });
      expect(resolveInteriorLights('off', demand)).toEqual({ lightsOn: false,
        interiorLightFactor: (DAYLIGHT_INTERIOR_LEVEL + (1 - DAYLIGHT_INTERIOR_LEVEL) * demand) * (1 - demand) });
    }
    expect(resolveInteriorLights('off', .7, 0).interiorLightFactor).toBe(resolveInteriorLights('auto', .7, 0).interiorLightFactor);
    expect(resolveInteriorLights('off', 1, 1).interiorLightFactor).toBe(0);
  });

  it('remembers the choice per device and tolerates unavailable storage', () => {
    const storage = memoryStorage();
    expect(loadLightOverride(storage)).toBe('auto');
    saveLightOverride('off', storage);
    expect(storage.values.get(LIGHT_OVERRIDE_STORAGE_KEY)).toBe('off');
    expect(loadLightOverride(storage)).toBe('off');
    saveLightOverride('auto', storage);
    expect(storage.values.has(LIGHT_OVERRIDE_STORAGE_KEY)).toBe(false);
    expect(loadLightOverride(memoryStorage({ [LIGHT_OVERRIDE_STORAGE_KEY]: 'dim' }))).toBe('auto');
    const blocked = { getItem: () => { throw new Error('blocked'); }, setItem: () => { throw new Error('blocked'); }, removeItem: () => { throw new Error('blocked'); } };
    expect(loadLightOverride(blocked)).toBe('auto');
    expect(() => saveLightOverride('on', blocked)).not.toThrow();
  });
});

describe('adaptive render budget', () => {
  const feed = (controller: ReturnType<typeof createBudgetController>, fps: number, count: number) => {
    for (let i = 0; i < count; i++) updateBudget(controller, { fps, rawFps: fps });
  };
  it('keeps resolution trials independent of lights, shadows and traffic and never uses a 480p tier', () => {
    expect(TARGET_FPS).toBe(60);
    expect(RENDER_BUDGET_LEVELS.map(budget => budget.resolutionHeight)).toEqual([2160, 1440, 1080, 900, 720]);
    expect(getRenderBudgetLevel()).toBe(INITIAL_RENDER_BUDGET_LEVEL);
    expect(getRenderBudget().resolutionHeight).toBe(1080);
    const resources = RENDER_BUDGET_LEVELS.map(({ resolutionHeight: _height, ...rest }) => rest);
    resources.forEach(resource => expect(resource).toEqual(resources[INITIAL_RENDER_BUDGET_LEVEL]));
    expect(resources[0]).toMatchObject({ liveBeams: 6, shadowMapSize: 1024, shadowRefreshSeconds: .5, trafficCars: 10 });
  });
  it('rolls back an ineffective CPU-bound reduction and blocks further cuts during cooldown', () => {
    const controller = createBudgetController();
    feed(controller, 25, SLOW_WINDOWS);
    expect(controller).toMatchObject({ level: 3, decision: 'probe-down', baselineMs: 40 });
    feed(controller, 25, PROBE_SAMPLE_WINDOWS);
    expect(controller).toMatchObject({ level: 2, decision: 'no-response', baselineMs: 40, candidateMs: 40 });
    const minimum = controller.level;
    for (let i = 0; i < MAX_RETRY_WINDOWS - 1; i++) {
      updateBudget(controller, { fps: 25, rawFps: 25 });
      // Restoration trials are allowed; further resolution cuts are not.
      expect(controller.level).toBeLessThanOrEqual(minimum);
    }
    expect(controller.level).toBe(0);
  });
  it('skips resolution tiers that produce the same native drawing buffer', () => {
    const ratio = (level: number) => budgetPixelRatio(RENDER_BUDGET_LEVELS[level]!, 1, 1502, 864);
    const controller = createBudgetController();
    for (let i = 0; i < SLOW_WINDOWS; i++) updateBudget(controller, { fps: 40 }, ratio);
    expect(controller.probe?.from).toBe(2);
    expect(controller.level).toBe(4);
    const small = createBudgetController();
    for (let i = 0; i < PROBE_WINDOWS; i++) updateBudget(small, { fps: 40 }, () => 1);
    expect(small.probe).toBeUndefined();
    expect(small.level).toBe(INITIAL_RENDER_BUDGET_LEVEL);
  });
  it.each([28, 29.5])('retains a warmed, material GPU response at %s fps', fps => {
    const controller = createBudgetController(); feed(controller, 25, SLOW_WINDOWS);
    feed(controller, fps, PROBE_SAMPLE_WINDOWS);
    expect(controller).toMatchObject({ level: 3, decision: 'retained' });
    expect(controller.baselineMs! - controller.candidateMs!).toBeGreaterThanOrEqual(4);
  });
  it.each([[25, 26], [1000 / 18, 1000 / 16.5]])('requires both relative and absolute savings (fps %s → %s)', (before, after) => {
    const controller = createBudgetController(); feed(controller, before!, SLOW_WINDOWS);
    feed(controller, after!, PROBE_SAMPLE_WINDOWS);
    expect(controller).toMatchObject({ level: 2, decision: 'no-response' });
  });
  it('does not compare transient spikes or unstable baseline/candidate windows as GPU gains', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 10; i++) { feed(controller, 60, 2); feed(controller, 15, 1); }
    expect(controller.level).toBeLessThanOrEqual(2); expect(controller.probe?.direction).not.toBe('down');
    resetBudgetController(controller, 2); feed(controller, 25, SLOW_WINDOWS);
    for (const fps of [50, 15, 50]) feed(controller, fps, 1);
    expect(controller).toMatchObject({ level: 2, decision: 'unstable' });
  });
  it('restores quality below 60 fps when extra pixels cost no meaningful throughput', () => {
    const controller = createBudgetController(); controller.level = 4;
    controller.downAfter = 500; // previous no-response result
    const visited = [controller.level];
    for (let i = 0; i < 4 * (PROBE_WINDOWS + PROBE_SAMPLE_WINDOWS); i++) {
      updateBudget(controller, { fps: 24, rawFps: 24 });
      if (controller.level !== visited.at(-1)) visited.push(controller.level);
    }
    expect(visited).toEqual([4, 3, 2, 1, 0]); expect(controller.decision).toBe('restored');
  });
  it('rejects a costly restoration and retries only after bounded foreground cooldown', () => {
    const controller = createBudgetController(); controller.level = 4;
    feed(controller, 40, PROBE_WINDOWS); expect(controller.level).toBe(3);
    feed(controller, 25, PROBE_SAMPLE_WINDOWS); expect(controller).toMatchObject({ level: 4, decision: 'restore-costly' });
    feed(controller, 40, MAX_RETRY_WINDOWS - 1); expect(controller.level).toBe(4);
    feed(controller, 40, 1); expect(controller).toMatchObject({ level: 3, decision: 'probe-up' });
  });
  it.each([60, 90, 120, 144])('allows %s fps throughput and recovers sharper levels without a frame cap', fps => {
    const controller = createBudgetController();
    feed(controller, fps, 2 * (RECOVERY_WINDOWS + PROBE_SAMPLE_WINDOWS));
    expect(controller.level).toBe(0);
    expect(effectiveBudgetFps({ fps, rawFps: fps })).toBe(fps);
    feed(controller, fps, 100); expect(controller.level).toBe(0);
  });
  it('aborts unproven reductions/restorations and clears stale measurements on invalidation', () => {
    const controller = createBudgetController(); feed(controller, 25, SLOW_WINDOWS);
    feed(controller, 40, 1); expect(controller.probe?.samples).toHaveLength(1);
    expect(resetBudgetController(controller)).toBe(2);
    expect(controller).toMatchObject({ level: 2, decision: 'invalidated', windows: 0, history: [], baselineMs: null, candidateMs: null });
    expect(controller.probe).toBeUndefined();
    feed(controller, 60, RECOVERY_WINDOWS); expect(controller.level).toBe(1);
    expect(resetBudgetController(controller)).toBe(2);
  });
  it('uses raw throughput for decisions and ignores invalid samples without advancing clocks', () => {
    expect(effectiveBudgetFps({ fps: 90, rawFps: 25 })).toBe(25);
    const controller = createBudgetController();
    for (let i = 0; i < SLOW_WINDOWS; i++) updateBudget(controller, { fps: 90, rawFps: 25 });
    expect(controller.level).toBe(3);
    const snapshot = structuredClone(controller);
    for (const fps of [NaN, Infinity, -Infinity, 0, -1]) updateBudget(controller, { fps, rawFps: 25 });
    expect(controller).toEqual(snapshot);
    for (const rawFps of [undefined, null, NaN, Infinity, -1]) expect(effectiveBudgetFps({ fps: 120, rawFps })).toBe(120);
  });
  it('keeps valid shared levels and clamps ordinary level requests', () => {
    const previous = getRenderBudgetLevel();
    try {
      setRenderBudgetLevel(-1); expect(getRenderBudgetLevel()).toBe(0);
      for (const invalid of [NaN, Infinity, -Infinity]) { setRenderBudgetLevel(invalid); expect(getRenderBudgetLevel()).toBe(0); }
      setRenderBudgetLevel(100); expect(getRenderBudgetLevel()).toBe(4);
    } finally { setRenderBudgetLevel(previous); }
  });
  it('samples full foreground stalls and resets hidden/context timing before resuming', () => {
    const sampler = createRenderFrameSampler(0); sampleRenderFrame(sampler, 100, true);
    expect(sampleRenderFrame(sampler, 1300, true)).toBeCloseTo(1 / 1.2);
    expect(sampler.rawFps).toBeCloseTo(1 / 1.2);
    resetRenderFrameSampler(sampler); expect(sampleRenderFrame(sampler, 60_000, false)).toBeNull();
    expect(sampler).toMatchObject({ rawFps: null, frames: 0, seconds: 0, last: 0 });
    expect(sampleRenderFrame(sampler, 60_016, true)).toBeNull();
    let now = 60_016, result: number | null = null;
    for (let i = 0; i < 145; i++) { now += 1000 / 60; result = sampleRenderFrame(sampler, now, true) ?? result; }
    expect(result).toBeCloseTo(60); expect(sampler.rawFps).toBeCloseTo(60);
  });
  it('reports a one-off hitch in raw throughput while preserving filtered diagnostics', () => {
    const sampler = createRenderFrameSampler(0); let now = 100; sampleRenderFrame(sampler, now, true);
    let result: number | null = null;
    for (let i = 0; i < 100 && result === null; i++) { now += i === 0 ? 300 : 1000 / 60; result = sampleRenderFrame(sampler, now, true); }
    expect(result).toBeCloseTo(60); expect(sampler.rawFps).toBeLessThan(50);
  });

  it('fits every resolution step to physical landscape and portrait canvas dimensions', () => {
    for (const budget of RENDER_BUDGET_LEVELS) {
      for (const [width, height] of [[3840, 2160], [2160, 3840]]) {
        const ratio = budgetPixelRatio(budget, 2, width!, height!);
        expect(Math.min(width!, height!) * ratio).toBeCloseTo(budget.resolutionHeight);
        expect(Math.max(width!, height!) * ratio).toBeCloseTo(budget.resolutionHeight * 16 / 9);
      }
    }
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[4]!, 2)).toBeCloseTo(720 / 1080);
  });

  it('respects native display ratios below one and caps high-density displays without supersampling', () => {
    const highest = RENDER_BUDGET_LEVELS[0]!;
    expect(budgetPixelRatio(highest, 0.75, 640, 360)).toBe(0.75);
    expect(budgetPixelRatio(highest, 1, 640, 360)).toBe(1);
    expect(budgetPixelRatio(highest, 3, 640, 360)).toBe(2);
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[4]!, 1, 320, 240)).toBe(1);
  });

  it('caps total pixels on ultrawide canvases as well as the short edge', () => {
    const highest = RENDER_BUDGET_LEVELS[0]!;
    const width = 5120, height = 1440;
    const ratio = budgetPixelRatio(highest, 2, width, height);
    expect(width * ratio * height * ratio).toBeCloseTo(3840 * 2160);
    expect(height * ratio).toBeLessThan(highest.resolutionHeight);
    const { maxPixels: _maxPixels, ...withoutPixelCap } = highest;
    expect(budgetPixelRatio(withoutPixelCap, 2, width, height)).toBe(2160 / height);
  });

  it('uses finite positive fallbacks for invalid dimensions and display ratios', () => {
    const budget = RENDER_BUDGET_LEVELS[4]!;
    const fallback = budgetPixelRatio(budget, 1, 1920, 1080);
    for (const invalid of [0, -1, NaN, Infinity, -Infinity]) {
      expect(budgetPixelRatio(budget, invalid)).toBe(fallback);
      expect(budgetPixelRatio(budget, 1, invalid, invalid)).toBe(fallback);
      expect(budgetPixelRatio(budget, 1, invalid, 1080)).toBe(fallback);
      expect(budgetPixelRatio(budget, 1, 1920, invalid)).toBe(fallback);
    }
    const hugeCanvasRatio = budgetPixelRatio(budget, 2, Number.MAX_VALUE, Number.MAX_VALUE);
    expect(Number.isFinite(hugeCanvasRatio)).toBe(true);
    expect(hugeCanvasRatio).toBeGreaterThan(0);
  });

  it('detects integrated, mobile and software GPUs vs discrete GPUs', () => {
    expect(detectInitialRenderBudgetLevel({ renderer: 'ANGLE (Intel, Intel(R) Iris(R) Xe Graphics)', vendor: 'Google Inc.' }))
      .toBe(LIGHTWEIGHT_RENDER_BUDGET_LEVEL);
    expect(detectInitialRenderBudgetLevel({ renderer: 'Apple M2', vendor: 'Apple' }))
      .toBe(LIGHTWEIGHT_RENDER_BUDGET_LEVEL);
    expect(detectInitialRenderBudgetLevel({ renderer: 'Google SwiftShader', vendor: 'Google Inc.' }))
      .toBe(LIGHTWEIGHT_RENDER_BUDGET_LEVEL);
    expect(detectInitialRenderBudgetLevel({ renderer: 'NVIDIA GeForce RTX 4070', vendor: 'NVIDIA Corporation' }))
      .toBe(INITIAL_RENDER_BUDGET_LEVEL);
    expect(detectInitialRenderBudgetLevel({ renderer: 'Apple M3 Max', vendor: 'Apple' }))
      .toBe(INITIAL_RENDER_BUDGET_LEVEL);
  });

});
