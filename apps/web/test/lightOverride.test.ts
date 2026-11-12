import { describe, expect, it } from 'vitest';
import { DAYLIGHT_INTERIOR_LEVEL, LIGHT_OVERRIDE_STORAGE_KEY, loadLightOverride, resolveInteriorLights, saveLightOverride } from '../src/office/scene/environment/lightOverride';
import { createBudgetController, createRenderFrameSampler, getRenderBudget, getRenderBudgetLevel, INITIAL_RENDER_BUDGET_LEVEL, MAX_RETRY_WINDOWS, PROBE_WINDOWS, RECOVERY_WINDOWS, RENDER_BUDGET_LEVELS, budgetPixelRatio, resetRenderFrameSampler, sampleRenderFrame, setRenderBudgetLevel, updateBudget } from '../src/office/scene/environment/renderBudget';

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

  it('downgrades after one slow visible frame window', () => {
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
    expect(windows).toBe(1);
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
    // 30 ms frames throughout (33 fps) stay slow.
    expect(windowFps(() => 30)).toBeLessThan(40);
  });

  it('steps down at once below 40 fps (frame time over 25 ms), after two marginal windows, and back up carefully', () => {
    const controller = createBudgetController();
    controller.level = 0;
    expect(updateBudget(controller, { fps: 30 })).toBe(1);
    expect(updateBudget(controller, { fps: 42 })).toBe(1);
    expect(updateBudget(controller, { fps: 42 })).toBe(2);
    expect(updateBudget(controller, { fps: 50 })).toBe(2);
    // Level 1 failed, so its retry delay outlasts the normal six-window recovery.
    while (controller.windows < controller.retryAfter[1]! - 1) expect(updateBudget(controller, { fps: 60 })).toBe(2);
    expect(updateBudget(controller, { fps: 60 })).toBe(1);
    // One slow second interrupts recovery.
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) updateBudget(controller, { fps: 60 });
    updateBudget(controller, { fps: 46 });
    expect(updateBudget(controller, { fps: 60 })).toBe(1);
  });

  it('backs off repeated failed probes but always retries after load clears', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 20; i++) updateBudget(controller, { fps: 10 });
    expect(controller.level).toBe(RENDER_BUDGET_LEVELS.length - 1);
    const settled = createBudgetController(); settled.level = 0;
    for (let round = 0; round < 7; round++) {
      expect(updateBudget(settled, { fps: 20 })).toBe(1);
      const delay = settled.retryAfter[0]! - settled.windows;
      expect(delay).toBe(Math.min(MAX_RETRY_WINDOWS, 15 * 2 ** Math.min(3, round)));
      for (let i = 0; i < delay - 1; i++) expect(updateBudget(settled, { fps: 60 })).toBe(1);
      expect(updateBudget(settled, { fps: 60 })).toBe(0);
    }
    for (let i = 0; i < 200; i++) expect(updateBudget(settled, { fps: 60 })).toBe(0);
  });

  it('probes on stable 45 fps displays, rolls back a costly probe and ignores invalid samples', () => {
    const controller = createBudgetController(); controller.level = 4;
    for (let i = 0; i < PROBE_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 45 })).toBe(4);
    expect(updateBudget(controller, { fps: 45 })).toBe(3);
    expect(updateBudget(controller, { fps: 25 })).toBe(4);
    const snapshot = structuredClone(controller);
    for (const fps of [NaN, Infinity, -Infinity, 0, -5]) updateBudget(controller, { fps });
    expect(controller).toEqual(snapshot);
    for (let i = 0; i < PROBE_WINDOWS; i++) updateBudget(controller, { fps: 45 });
    expect(controller.level).toBe(3);
  });

  it('recovers from sustained load all the way back to the sharpest tier without oscillating on marginal load', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 60; i++) updateBudget(controller, { fps: 18 });
    expect(controller.level).toBe(4);
    for (let i = 0; i < 60; i++) updateBudget(controller, { fps: 60 });
    expect(controller.level).toBe(0);
    for (let i = 0; i < 300; i++) updateBudget(controller, { fps: i % 2 ? 46 : 39 });
    expect(controller.level).toBe(4);
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
