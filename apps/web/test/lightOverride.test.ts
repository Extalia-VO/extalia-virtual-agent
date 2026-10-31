import { describe, expect, it } from 'vitest';
import { DAYLIGHT_INTERIOR_LEVEL, LIGHT_OVERRIDE_STORAGE_KEY, loadLightOverride, resolveInteriorLights, saveLightOverride } from '../src/office/scene/environment/lightOverride';
import { createBudgetController, createRenderFrameSampler, RECOVERY_WINDOWS, RENDER_BUDGET_LEVELS, budgetPixelRatio, resetRenderFrameSampler, sampleRenderFrame, updateBudget } from '../src/office/scene/environment/renderBudget';

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
  it('downgrades after one slow visible frame window', () => {
    const sampler = createRenderFrameSampler(0);
    const controller = createBudgetController();
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
    // 30 ms frames throughout (33 fps) stay slow.
    expect(windowFps(() => 30)).toBeLessThan(40);
  });

  it('steps down at once below 40 fps (frame time over 25 ms), after two marginal windows, and back up carefully', () => {
    const controller = createBudgetController();
    expect(updateBudget(controller, { fps: 30 })).toBe(1);
    expect(updateBudget(controller, { fps: 42 })).toBe(1);
    expect(updateBudget(controller, { fps: 42 })).toBe(2);
    expect(updateBudget(controller, { fps: 50 })).toBe(2);
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) expect(updateBudget(controller, { fps: 60 })).toBe(2);
    expect(updateBudget(controller, { fps: 60 })).toBe(1);
    // One slow second interrupts recovery.
    for (let i = 0; i < RECOVERY_WINDOWS - 1; i++) updateBudget(controller, { fps: 60 });
    updateBudget(controller, { fps: 50 });
    expect(updateBudget(controller, { fps: 60 })).toBe(1);
  });

  it('stays at the lowest level and does not retry a level that failed twice', () => {
    const controller = createBudgetController();
    for (let i = 0; i < 20; i++) updateBudget(controller, { fps: 10 });
    expect(controller.level).toBe(RENDER_BUDGET_LEVELS.length - 1);
    const settled = createBudgetController();
    for (let round = 0; round < 2; round++) {
      updateBudget(settled, { fps: 20 });
      for (let i = 0; i < RECOVERY_WINDOWS; i++) updateBudget(settled, { fps: 60 });
    }
    // Level 0 failed twice, so recovering from a later slowdown settles at level 1, never 0.
    updateBudget(settled, { fps: 20 });
    for (let i = 0; i < 2 * RECOVERY_WINDOWS; i++) updateBudget(settled, { fps: 60 });
    expect(settled.level).toBe(1);
  });

  it('never exceeds the display pixel ratio or the level cap', () => {
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[0]!, 2)).toBe(1.25);
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[0]!, 1)).toBe(1);
    expect(budgetPixelRatio(RENDER_BUDGET_LEVELS[RENDER_BUDGET_LEVELS.length - 1]!, 2)).toBeLessThan(1);
  });

});
