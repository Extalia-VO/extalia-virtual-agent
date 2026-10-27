import { useEffect, useRef, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { budgetPixelRatio, createBudgetController, getRenderBudget, getRenderBudgetLevel, RENDER_BUDGET_LEVELS, setRenderBudgetLevel, subscribeRenderBudget, updateBudget } from './renderBudget';

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
  const sample = useRef({ controller: { ...createBudgetController(), level: getRenderBudgetLevel() }, seconds: 0, frames: 0, warmup: 3, last: 0, pinned: false, fps: 0 });

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

  useFrame(() => {
    const data = sample.current;
    const now = performance.now();
    const seconds = data.last ? (now - data.last) / 1000 : 0;
    data.last = now;
    // Hidden tabs and long stalls (shader compiles, tab switches) are not representative.
    if (document.hidden || seconds > 0.5) { data.seconds = 0; data.frames = 0; data.warmup = Math.max(data.warmup, 1); return; }
    if (data.warmup > 0) { data.warmup -= seconds; return; }
    data.seconds += seconds;
    data.frames += 1;
    if (data.seconds < 2) return;
    data.fps = data.frames / data.seconds;
    data.seconds = 0; data.frames = 0;
    if (!data.pinned) {
      const before = getRenderBudgetLevel();
      const next = updateBudget(data.controller, { fps: data.fps });
      if (next !== before) { setRenderBudgetLevel(next); data.warmup = 1.5; }
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
