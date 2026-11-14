import { QA_HOOKS } from '../qaHooks';
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { budgetPixelRatio, createBudgetController, createRenderFrameSampler, effectiveBudgetFps, getRenderBudget, getRenderBudgetLevel, RENDER_BUDGET_LEVELS, resetRenderFrameSampler, sampleRenderFrame, setRenderBudgetLevel, subscribeRenderBudget, updateBudget } from './renderBudget';
import { publishOfficeFps } from './renderStats';

type BudgetWindow = Window & {
  __EXTALIA_RENDER_BUDGET__?: unknown;
  __EXTALIA_SET_RENDER_BUDGET__?: (level: number | null) => void;
};

/** Canvas pixel ratio for the current budget level; pass it as the Canvas `dpr` (R3F re-applies that prop on render). */
export function useBudgetPixelRatio(canvas: HTMLCanvasElement | null): number {
  const budget = useSyncExternalStore(subscribeRenderBudget, getRenderBudget, getRenderBudget);
  const [display, setDisplay] = useState({ width: 1920, height: 1080, ratio: 1 });
  useLayoutEffect(() => {
    // R3F's full-size container is valid before the canvas's initial 300 × 150
    // intrinsic box is replaced. Measuring that temporary box could select native DPR.
    const container = canvas?.parentElement ?? canvas;
    const measure = () => {
      const bounds = container?.getBoundingClientRect();
      const width = bounds?.width || window.innerWidth;
      const height = bounds?.height || window.innerHeight;
      const ratio = window.devicePixelRatio;
      setDisplay(previous => previous.width === width && previous.height === height && previous.ratio === ratio
        ? previous : { width, height, ratio });
    };
    measure();
    // Observe the sizing container, never the backing buffer: DPR cannot feed back into sizing.
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    if (container) observer?.observe(container);
    // Numeric R3F DPR opts out of its own display-density follower. Re-arm this
    // query whenever the density changes, even if CSS dimensions stay identical.
    let density: MediaQueryList | undefined;
    const watchDensity = () => {
      density?.removeEventListener('change', densityChanged);
      density = window.matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`);
      density.addEventListener('change', densityChanged);
    };
    const densityChanged = () => { measure(); watchDensity(); };
    watchDensity();
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect(); density?.removeEventListener('change', densityChanged);
      window.removeEventListener('resize', measure);
    };
  }, [canvas]);
  return budgetPixelRatio(budget, display.ratio, display.width, display.height);
}

/**
 * Targets a 30 fps floor: starts near 1080p, measures one-second windows after warm-up and moves
 * between budget levels (pixel ratio, live beams, shadow detail) with hysteresis.
 */
export function AdaptiveRenderBudget() {
  const gl = useThree(state => state.gl);
  const size = useThree(state => state.size);
  const setDpr = useThree(state => state.setDpr);
  const budget = useSyncExternalStore(subscribeRenderBudget, getRenderBudget, getRenderBudget);
  // Reconcile inside the root before its first painted frame as well as through
  // Canvas props: async/suspended root configuration can precede the outer ref measurement.
  useLayoutEffect(() => {
    const ratio = budgetPixelRatio(budget, window.devicePixelRatio, size.width, size.height);
    if (gl.getPixelRatio() !== ratio) setDpr(ratio);
  }, [budget, gl, setDpr, size.width, size.height]);
  // A remounted canvas resumes from the level this session already settled on.
  const sample = useRef({ controller: { ...createBudgetController(), level: getRenderBudgetLevel() }, sampler: createRenderFrameSampler(), pinned: false, fps: 0 });

  useEffect(() => {
    if (QA_HOOKS) {
      // QA: pin a level (or null to resume adaptation) when measuring a specific budget.
      (window as BudgetWindow).__EXTALIA_SET_RENDER_BUDGET__ = level => {
        sample.current.pinned = level !== null;
        if (level !== null) setRenderBudgetLevel(level);
        sample.current.controller.level = getRenderBudgetLevel();
        sample.current.controller.slow = 0;
        sample.current.controller.fast = 0;
        sample.current.controller.stable = 0;
        resetRenderFrameSampler(sample.current.sampler);
      };
    }
    return () => {
      if (QA_HOOKS) {
        delete (window as BudgetWindow).__EXTALIA_SET_RENDER_BUDGET__;
        delete (window as BudgetWindow).__EXTALIA_RENDER_BUDGET__;
      }
    };
  }, []);

  useEffect(() => {
    publishOfficeFps(null);
    const resetAfterVisibilityChange = () => {
      resetRenderFrameSampler(sample.current.sampler);
      // Foreground streaks must describe the current scene, not a pre-hide or
      // pre-context-loss burst. Keep the chosen level and bounded retry clock.
      sample.current.controller.slow = 0;
      sample.current.controller.fast = 0;
      sample.current.controller.stable = 0;
      publishOfficeFps(null);
    };
    document.addEventListener('visibilitychange', resetAfterVisibilityChange);
    gl.domElement.addEventListener('webglcontextlost', resetAfterVisibilityChange);
    gl.domElement.addEventListener('webglcontextrestored', resetAfterVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', resetAfterVisibilityChange);
      gl.domElement.removeEventListener('webglcontextlost', resetAfterVisibilityChange);
      gl.domElement.removeEventListener('webglcontextrestored', resetAfterVisibilityChange);
      publishOfficeFps(null);
    };
  }, [gl]);

  useFrame(() => {
    const data = sample.current;
    const fps = sampleRenderFrame(data.sampler, performance.now(), !document.hidden);
    if (fps === null) return;
    data.fps = fps;
    publishOfficeFps(data.sampler.rawFps);
    if (!data.pinned) {
      const before = getRenderBudgetLevel();
      const next = updateBudget(data.controller, { fps: data.fps, rawFps: data.sampler.rawFps });
      if (next !== before) { setRenderBudgetLevel(next); data.sampler.warmup = 1.5; }
    }
    if (QA_HOOKS) {
      const budget = getRenderBudget();
      (window as BudgetWindow).__EXTALIA_RENDER_BUDGET__ = {
        level: getRenderBudgetLevel(), levels: RENDER_BUDGET_LEVELS.length, fps: Math.round((data.sampler.rawFps ?? fps) * 10) / 10,
        budgetFps: Math.round(effectiveBudgetFps({ fps: data.fps, rawFps: data.sampler.rawFps }) * 10) / 10,
        filteredFps: Math.round(data.fps * 10) / 10,
        pixelRatio: gl.getPixelRatio(), liveBeams: budget.liveBeams, shadowMapSize: budget.shadowMapSize,
        resolutionHeight: budget.resolutionHeight, canvasWidth: gl.domElement.width, canvasHeight: gl.domElement.height,
        drawCalls: gl.info.render.calls, triangles: gl.info.render.triangles, pinned: data.pinned,
      };
    }
  });
  return null;
}
