import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { budgetPixelRatio, createBudgetController, createRenderFrameSampler, getRenderBudget, getRenderBudgetLevel, RENDER_BUDGET_LEVELS, resetRenderFrameSampler, sampleRenderFrame, setRenderBudgetLevel, subscribeRenderBudget, updateBudget } from './renderBudget';

type BudgetWindow = Window & {
  __EXTALIA_RENDER_BUDGET__?: unknown;
  __EXTALIA_SET_RENDER_BUDGET__?: (level: number | null) => void;
};

const budgetDpr = () => budgetPixelRatio(getRenderBudget(), typeof window === 'undefined' ? 1 : window.devicePixelRatio);
/** Canvas pixel ratio for the current budget level; pass it as the Canvas `dpr` (R3F re-applies that prop on render). */
export function useBudgetPixelRatio(): number {
  return useSyncExternalStore(subscribeRenderBudget, budgetDpr, budgetDpr);
}

/**
 * Keeps the Office above 40 fps: measures two-second windows after a warm-up and moves
 * between budget levels (pixel ratio, live beams, shadow detail) with hysteresis.
 */
export function AdaptiveRenderBudget() {
  const gl = useThree(state => state.gl);
  // A remounted canvas resumes from the level this session already settled on.
  const sample = useRef({ controller: { ...createBudgetController(), level: getRenderBudgetLevel() }, sampler: createRenderFrameSampler(), pinned: false, fps: 0 });

  useEffect(() => {
    if (import.meta.env.DEV) {
      // QA: pin a level (or null to resume adaptation) when measuring a specific budget.
      (window as BudgetWindow).__EXTALIA_SET_RENDER_BUDGET__ = level => {
        sample.current.pinned = level !== null;
        sample.current.controller.level = level ?? sample.current.controller.level;
        setRenderBudgetLevel(level ?? sample.current.controller.level);
      };
    }
    return () => {
      if (import.meta.env.DEV) {
        delete (window as BudgetWindow).__EXTALIA_SET_RENDER_BUDGET__;
        delete (window as BudgetWindow).__EXTALIA_RENDER_BUDGET__;
      }
    };
  }, []);

  useEffect(() => {
    const resetAfterVisibilityChange = () => resetRenderFrameSampler(sample.current.sampler);
    document.addEventListener('visibilitychange', resetAfterVisibilityChange);
    return () => document.removeEventListener('visibilitychange', resetAfterVisibilityChange);
  }, []);

  useFrame(() => {
    const data = sample.current;
    const fps = sampleRenderFrame(data.sampler, performance.now(), !document.hidden);
    if (fps === null) return;
    data.fps = fps;
    if (!data.pinned) {
      const before = getRenderBudgetLevel();
      const next = updateBudget(data.controller, { fps: data.fps });
      if (next !== before) { setRenderBudgetLevel(next); data.sampler.warmup = 1.5; }
    }
    if (import.meta.env.DEV) {
      const budget = getRenderBudget();
      (window as BudgetWindow).__EXTALIA_RENDER_BUDGET__ = {
        level: getRenderBudgetLevel(), levels: RENDER_BUDGET_LEVELS.length, fps: Math.round(data.fps * 10) / 10,
        pixelRatio: gl.getPixelRatio(), liveBeams: budget.liveBeams, shadowMapSize: budget.shadowMapSize,
        drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, pinned: data.pinned,
      };
    }
  });
  return null;
}
