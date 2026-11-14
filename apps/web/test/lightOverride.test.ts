import { describe, expect, it } from 'vitest';
import { DAYLIGHT_INTERIOR_LEVEL, LIGHT_OVERRIDE_STORAGE_KEY, loadLightOverride, resolveInteriorLights, saveLightOverride } from '../src/office/scene/environment/lightOverride';
import { createBudgetController, createRenderFrameSampler, getRenderBudget, getRenderBudgetLevel, INITIAL_RENDER_BUDGET_LEVEL, MAX_RETRY_WINDOWS, PROBE_WINDOWS, RECOVERY_WINDOWS, RENDER_BUDGET_LEVELS, SLOW_WINDOWS, TARGET_FPS, budgetPixelRatio, effectiveBudgetFps, resetRenderFrameSampler, sampleRenderFrame, setRenderBudgetLevel, updateBudget } from '../src/office/scene/environment/renderBudget';

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
  it('starts at 1080p and recovers one resolution step at a time with sustained headroom', () => {
    expect(RENDER_BUDGET_LEVELS.map(budget => budget.resolutionHeight)).toEqual([2160, 1440, 1080, 720, 480]);
    const controller = createBudgetController();
    const lowest = RENDER_BUDGET_LEVELS.length - 1;
    expect(getRenderBudgetLevel()).toBe(INITIAL_RENDER_BUDGET_LEVEL);
    expect(getRenderBudget().resolutionHeight).toBe(1080);
    expect(controller.level).toBe(INITIAL_RENDER_BUDGET_LEVEL);
    for (let next = INITIAL_RENDER_BUDGET_LEVEL - 1; next >= 0; next--) {
      for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 57 })).toBe(next + 1);
      expect(updateBudget(controller, { fps: 57 })).toBe(next);
    }
    for (let i = 0; i < RECOVERY_WINDOWS; i++) expect(updateBudget(controller, { fps: 60 })).toBe(0);
    for (const index of [lowest, lowest - 1]) {
      expect(RENDER_BUDGET_LEVELS[index]).toMatchObject({ liveBeams: 0, shadowMapSize: 512, shadowRefreshSeconds: 1 });
    }
    expect(RENDER_BUDGET_LEVELS.every(budget => budget.liveBeams <= 6 && budget.shadowMapSize <= 1024)).toBe(true);
  });

  it('keeps the shared level valid when passed non-finite values and clamps ordinary levels', () => {
    const previous = getRenderBudgetLevel();
    try {
      setRenderBudgetLevel(-10);
      expect(getRenderBudgetLevel()).toBe(0);
      for (const invalid of [NaN, Infinity, -Infinity]) {
        setRenderBudgetLevel(invalid);
        expect(getRenderBudgetLevel()).toBe(0);
      }
      setRenderBudgetLevel(100);
      expect(getRenderBudgetLevel()).toBe(RENDER_BUDGET_LEVELS.length - 1);
    } finally {
      setRenderBudgetLevel(previous);
    }
  });

  it('downgrades gradually after sustained slow visible frame windows', () => {
    const sampler = createRenderFrameSampler(0);
    const controller = createBudgetController();
    controller.level = 0;
    let now = 100;
    sampleRenderFrame(sampler, now, true);
    let windows = 0;
    for (let i = 0; i < 20 && controller.level === 0; i++) {
      now += 600; // foreground stalls at ~1.7 fps; these intervals must not be discarded
      const fps = sampleRenderFrame(sampler, now, true);
      if (fps !== null) {
        windows++;
        updateBudget(controller, { fps });
      }
    }
    expect(windows).toBe(SLOW_WINDOWS);
    expect(controller.level).toBe(1);
  });

  it('resets timing on hide/resume so hidden duration cannot trigger a downgrade', () => {
    const sampler = createRenderFrameSampler(0);
    const controller = createBudgetController();
    controller.level = 0;
    sampleRenderFrame(sampler, 100, true);
    sampleRenderFrame(sampler, 200, true);
    resetRenderFrameSampler(sampler);
    expect(sampleRenderFrame(sampler, 60_000, false)).toBeNull();
    // The first resumed frame starts a fresh clock; subsequent healthy frames are
    // measured normally, regardless of the minute spent hidden.
    expect(sampleRenderFrame(sampler, 60_016, true)).toBeNull();
    let windows = 0;
    for (let i = 0; i < 300; i++) {
      const fps = sampleRenderFrame(sampler, 60_032 + i * 16, true);
      if (fps !== null) {
        windows++;
        updateBudget(controller, { fps });
      }
    }
    expect(windows).toBeGreaterThan(0);
    expect(controller.level).toBe(0);
  });

  it('ignores one hitch in an otherwise smooth window but not a sustained slowdown', () => {
    const sampler = createRenderFrameSampler(0);
    let now = 1000;
    sampleRenderFrame(sampler, now, true);
    const windowFps = (frameMs: (i: number) => number) => {
      for (let i = 0; i < 400; i++) {
        now += frameMs(i);
        const fps = sampleRenderFrame(sampler, now, true);
        if (fps !== null) return fps;
      }
      return null;
    };
    // 300 ms compile stall followed by 60 fps frames.
    expect(windowFps(i => (i === 0 ? 300 : 1000 / 60))).toBeGreaterThan(55);
    expect(sampler.rawFps).toBeLessThan(50); // the user sees the hitch in actual throughput
    // Sustained 33 fps remains usable; sustained 25 fps remains below target.
    expect(windowFps(() => 30)).toBeGreaterThan(TARGET_FPS);
    expect(windowFps(() => 40)).toBeLessThan(TARGET_FPS);
  });

  it('counts recurrent raw-FPS stalls even when each window trims them to 32 fps', () => {
    const sampler = createRenderFrameSampler(0), controller = createBudgetController();
    let now = 1000; sampleRenderFrame(sampler, now, true);
    for (let window = 0; window < SLOW_WINDOWS; window++) {
      let measured = false;
      for (let frame = 0; frame < 100; frame++) {
        now += frame === 0 ? 200 : 1000 / 32;
        const fps = sampleRenderFrame(sampler, now, true);
        if (fps === null) continue;
        expect(fps).toBeCloseTo(32); expect(sampler.rawFps).toBeLessThan(TARGET_FPS);
        expect(effectiveBudgetFps({ fps, rawFps: sampler.rawFps })).toBeCloseTo(sampler.rawFps!);
        expect(updateBudget(controller, { fps, rawFps: sampler.rawFps })).toBe(window < SLOW_WINDOWS - 1 ? 2 : 3);
        measured = true; break;
      }
      expect(measured).toBe(true);
    }
  });

  it('keeps one isolated trimmed hitch from costing a level while real healthy frames recover', () => {
    const sampler = createRenderFrameSampler(0), controller = createBudgetController();
    let now = 1000; sampleRenderFrame(sampler, now, true);
    const nextWindow = (hitch = false) => {
      for (let frame = 0; frame < 100; frame++) {
        now += hitch && frame === 0 ? 200 : 1000 / 32;
        const fps = sampleRenderFrame(sampler, now, true);
        if (fps !== null) return { fps, rawFps: sampler.rawFps };
      }
      throw new Error('No frame window was measured.');
    };
    expect(updateBudget(controller, nextWindow(true))).toBe(2);
    expect(controller.slow).toBe(1);
    for (let i = 0; i < PROBE_WINDOWS - 1; i++) expect(updateBudget(controller, nextWindow())).toBe(2);
    expect(controller.slow).toBe(0);
    expect(updateBudget(controller, nextWindow())).toBe(1);
  });

  it('does not upscale at raw 30 fps and tolerates absent or invalid raw samples', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 100; i++) expect(updateBudget(controller, { fps: 60, rawFps: 30 })).toBe(2);
    for (const rawFps of [undefined, null, NaN, Infinity, -Infinity, 0, -1]) {
      expect(effectiveBudgetFps({ fps: 32, rawFps })).toBe(32);
    }
    expect(effectiveBudgetFps({ fps: 25, rawFps: 32 })).toBe(25);
    expect(effectiveBudgetFps({ fps: 32, rawFps: 25 })).toBe(25);
    const before = structuredClone(controller);
    for (const fps of [NaN, Infinity, -Infinity, 0, -1]) updateBudget(controller, { fps, rawFps: 25 });
    expect(controller).toEqual(before);
  });

  it('steps down one tier after three sub-30 windows and interrupts transient slow streaks', () => {
    const controller = createBudgetController(); controller.level = 0;
    expect(TARGET_FPS).toBe(30);
    expect(updateBudget(controller, { fps: 27 })).toBe(0);
    expect(updateBudget(controller, { fps: 27 })).toBe(0);
    expect(updateBudget(controller, { fps: 30 })).toBe(0);
    for (let tier = 1; tier < RENDER_BUDGET_LEVELS.length; tier++) {
      for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 27 })).toBe(tier - 1);
      expect(updateBudget(controller, { fps: 27 })).toBe(tier);
    }
    for (let i = 0; i < 30; i++) expect(updateBudget(controller, { fps: 30 })).toBe(4);
  });

  it('keeps an exact 30 Hz sampled trace neutral despite floating interval rounding', () => {
    const sampler = createRenderFrameSampler(0), controller = createBudgetController();
    let now = 1, windows = 0; sampleRenderFrame(sampler, now, true);
    for (let frame = 0; frame < 600; frame++) {
      now += 1000 / 30;
      const fps = sampleRenderFrame(sampler, now, true);
      if (fps === null) continue;
      windows++;
      expect(updateBudget(controller, { fps, rawFps: sampler.rawFps })).toBe(2);
      expect(controller).toMatchObject({ slow: 0, fast: 0, stable: 0 });
    }
    expect(windows).toBeGreaterThanOrEqual(18);
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 29.9 })).toBe(2);
    expect(updateBudget(controller, { fps: 29.9 })).toBe(3);
    while (controller.windows < controller.retryAfter[2]!) updateBudget(controller, { fps: 30.1 });
    expect(controller.level).toBe(2);
  });

  it('holds exactly 30 fps at an interior tier and uses six windows at 40 fps', () => {
    const controller = createBudgetController(); controller.level = 2;
    for (let i = 0; i < 300; i++) expect(updateBudget(controller, { fps: 30 })).toBe(2);
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 40 })).toBe(2);
    expect(updateBudget(controller, { fps: 40 })).toBe(1);
  });

  it('keeps a single hitch from lowering quality or immediately recovering after slow input', () => {
    const controller = createBudgetController(); controller.level = 1;
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 60 })).toBe(1);
    expect(updateBudget(controller, { fps: 15 })).toBe(1);
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 60 })).toBe(1);
    expect(updateBudget(controller, { fps: 60 })).toBe(0);
  });

  it.each([30.1, 31, 32, 35, 39])('recovers every tier at stable %s fps after a deep slowdown', fps => {
    const controller = createBudgetController(); controller.level = 0;
    for (let i = 0; i < 60; i++) updateBudget(controller, { fps: 18 });
    expect(controller.level).toBe(4);
    const visited = [controller.level];
    for (let i = 0; i < 4 * MAX_RETRY_WINDOWS && controller.level > 0; i++) {
      const previous = controller.level, next = updateBudget(controller, { fps });
      expect(Math.abs(next - previous)).toBeLessThanOrEqual(1);
      if (next !== previous) visited.push(next);
    }
    expect(visited).toEqual([4, 3, 2, 1, 0]);
  });

  it('backs off repeated failed probes but always retries after load clears', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 20; i++) updateBudget(controller, { fps: 10 });
    expect(controller.level).toBe(RENDER_BUDGET_LEVELS.length - 1);
    const settled = createBudgetController(); settled.level = 0;
    for (let round = 0; round < 7; round++) {
      for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(updateBudget(settled, { fps: 20 })).toBe(0);
      expect(updateBudget(settled, { fps: 20 })).toBe(1);
      const delay = settled.retryAfter[0]! - settled.windows;
      expect(delay).toBe(Math.min(MAX_RETRY_WINDOWS, 15 * 2 ** Math.min(3, round)));
      for (let i = 0; i < delay - 1; i++) expect(updateBudget(settled, { fps: 31 })).toBe(1);
      expect(updateBudget(settled, { fps: 31 })).toBe(0);
    }
    for (let i = 0; i < 200; i++) expect(updateBudget(settled, { fps: 31 })).toBe(0);
  });

  it('probes on stable 35 fps displays, gradually rolls back costly probes and ignores invalid samples', () => {
    const controller = createBudgetController(); controller.level = 4;
    for (let i = 0; i < PROBE_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 35 })).toBe(4);
    expect(updateBudget(controller, { fps: 35 })).toBe(3);
    for (let i = 0; i < SLOW_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 25 })).toBe(3);
    expect(updateBudget(controller, { fps: 25 })).toBe(4);
    const snapshot = structuredClone(controller);
    for (const fps of [NaN, Infinity, -Infinity, 0, -5]) updateBudget(controller, { fps });
    expect(controller).toEqual(snapshot);
    while (controller.windows < controller.retryAfter[3]!) updateBudget(controller, { fps: 35 });
    expect(controller.level).toBe(3);
  });

  it('recovers from sustained load all the way back to the sharpest tier without oscillating on marginal load', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 60; i++) updateBudget(controller, { fps: 18 });
    expect(controller.level).toBe(4);
    for (let i = 0; i < 60; i++) updateBudget(controller, { fps: 60 });
    expect(controller.level).toBe(0);
    for (let i = 0; i < 300; i++) updateBudget(controller, { fps: i % 2 ? 31 : 29 });
    expect(controller.level).toBe(0);
  });

  it('fits every resolution step to physical landscape and portrait canvas dimensions', () => {
    for (const budget of RENDER_BUDGET_LEVELS) {
      for (const [width, height] of [[3840, 2160], [2160, 3840]]) {
        const ratio = budgetPixelRatio(budget, 2, width!, height!);
        expect(Math.min(width!, height!) * ratio).toBeCloseTo(budget.resolutionHeight);
        expect(Math.max(width!, height!) * ratio).toBeCloseTo(budget.resolutionHeight * 16 / 9);
      }
    }
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[4]!, 2)).toBeCloseTo(480 / 1080);
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

});
