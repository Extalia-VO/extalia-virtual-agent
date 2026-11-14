import { QA_HOOKS } from '../qaHooks';
import { useSolarEnvironment } from '../Environment';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { budgetComposition, budgetPixelRatio, createBudgetController, createRenderFrameSampler, effectiveBudgetFps, getRenderBudget, getRenderBudgetLevel, observeBudgetComposition, RENDER_BUDGET_LEVELS, resetBudgetController, resetRenderFrameSampler, sampleRenderFrame, setRenderBudgetLevel, subscribeRenderBudget, updateBudget } from './renderBudget';
import { publishOfficeFps } from './renderStats';
import type { BudgetRosterMember } from './renderBudget';

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
 * Pursues 60 fps without capping throughput. Only measured, useful DPR reductions
 * survive a trial; view/load/context changes invalidate its frame-time comparison.
 */
export function AdaptiveRenderBudget({ view, admittedIdentity, roster }: { view: string | number; admittedIdentity: string; roster(): readonly BudgetRosterMember[] }) {
  const gl = useThree(state => state.gl);
  const size = useThree(state => state.size);
  const setDpr = useThree(state => state.setDpr);
  const budget = useSyncExternalStore(subscribeRenderBudget, getRenderBudget, getRenderBudget);
  const { state: { factors }, lightOverride } = useSolarEnvironment();
  const lighting = `${lightOverride}:${factors.nightFactor}:${factors.interiorLightFactor}:${factors.exteriorLightFactor}`;
  const identity = useMemo(() => JSON.stringify([view, admittedIdentity, size.width, size.height, lighting]), [view, admittedIdentity, size.width, size.height, lighting]);
  // Reconcile inside the root before its first painted frame as well as through
  // Canvas props: async/suspended root configuration can precede the outer ref measurement.
  useLayoutEffect(() => {
    const ratio = budgetPixelRatio(budget, window.devicePixelRatio, size.width, size.height);
    if (gl.getPixelRatio() !== ratio) setDpr(ratio);
  }, [budget, gl, setDpr, size.width, size.height]);
  // A remounted canvas resumes from the level this session already settled on.
  const sample = useRef({ controller: { ...createBudgetController(), level: getRenderBudgetLevel() }, sampler: createRenderFrameSampler(), pinned: false, fps: 0, view: new Float64Array(32), sceneKey: -1,
    triangles: 0, calls: 0, adaptAfter: 0, composition: { key: null as string | null }, rosterCount: 0, compositionTransient: false,
    identity: null as string | null, nativeRatio: -1, geometries: -1, textures: -1, avatarEpoch: -1, load: null as { triangles: number; calls: number } | null });

  useEffect(() => {
    if (QA_HOOKS) {
      // QA: pin a level (or null to resume adaptation) when measuring a specific budget.
      (window as BudgetWindow).__EXTALIA_SET_RENDER_BUDGET__ = level => {
        sample.current.pinned = level !== null;
        if (level !== null) setRenderBudgetLevel(level);
        resetBudgetController(sample.current.controller, getRenderBudgetLevel());
        sample.current.load = null;
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
    const data = sample.current;
    publishOfficeFps(null);
    const resetAfterVisibilityChange = () => {
      resetRenderFrameSampler(data.sampler);
      if (!data.pinned) setRenderBudgetLevel(resetBudgetController(data.controller));
      data.load = null;
      data.triangles = 0; data.calls = 0;
      publishOfficeFps(null);
    };
    document.addEventListener('visibilitychange', resetAfterVisibilityChange);
    gl.domElement.addEventListener('webglcontextlost', resetAfterVisibilityChange);
    gl.domElement.addEventListener('webglcontextrestored', resetAfterVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', resetAfterVisibilityChange);
      gl.domElement.removeEventListener('webglcontextlost', resetAfterVisibilityChange);
      gl.domElement.removeEventListener('webglcontextrestored', resetAfterVisibilityChange);
      if (!data.pinned) setRenderBudgetLevel(resetBudgetController(data.controller));
      publishOfficeFps(null);
    };
  }, [gl]);

  useFrame(state => {
    const data = sample.current, now = performance.now();
    // Camera motion, resizing, floor visibility and mounted model counts change
    // the workload. Never compare samples across those different scenes.
    let changed = false;
    for (let i = 0; i < 32; i++) {
      const value = i < 16 ? state.camera.matrixWorld.elements[i]! : state.camera.projectionMatrix.elements[i - 16]!;
      if (Math.abs(value - data.view[i]!) > 1e-3) changed = true;
      data.view[i] = value;
    }
    const sceneKey = state.scene.children.reduce((sum, child, i) => sum + (child.visible ? i + 1 : 0) + child.children.length * 31, 0)
      + (state.scene.userData.modelInstanceBatchStats?.sources ?? 0) * 997 + size.width * 17 + size.height * 23;
    if (sceneKey !== data.sceneKey) { changed = true; data.sceneKey = sceneKey; }
    const geometries = gl.info.memory.geometries, textures = gl.info.memory.textures;
    const avatarEpoch = state.scene.userData.officeAvatarCompositionEpoch ?? 0;
    if (identity !== data.identity || window.devicePixelRatio !== data.nativeRatio || geometries !== data.geometries || textures !== data.textures || avatarEpoch !== data.avatarEpoch) changed = true;
    data.identity = identity; data.nativeRatio = window.devicePixelRatio; data.geometries = geometries; data.textures = textures; data.avatarEpoch = avatarEpoch;
    if (changed && !data.pinned) {
      if (data.controller.windows || data.controller.probe) setRenderBudgetLevel(resetBudgetController(data.controller));
      // Keep reporting delivered FPS during navigation; only adaptation waits for
      // one settled interval plus a completely new measurement window.
      data.adaptAfter = now + 2000;
      data.load = null; data.triangles = 0; data.calls = 0;
    }
    data.triangles = Math.max(data.triangles, gl.info.render.triangles);
    data.calls = Math.max(data.calls, gl.info.render.calls);
    const fps = sampleRenderFrame(data.sampler, now, !document.hidden);
    if (fps === null) return;
    data.fps = fps;
    publishOfficeFps(data.sampler.rawFps);
    const composition = budgetComposition({ view, admittedIdentity, roster: roster(), geometries, textures, avatarEpoch });
    data.rosterCount = composition.rosterCount; data.compositionTransient = composition.transient;
    if (!data.pinned && observeBudgetComposition(data.controller, data.composition, composition)) {
      setRenderBudgetLevel(data.controller.level);
      data.adaptAfter = now + 2000; data.load = null;
    }
    const load = { triangles: data.triangles, calls: data.calls };
    data.triangles = 0; data.calls = 0;
    if (!data.pinned && data.load && (Math.abs(load.triangles - data.load.triangles) > Math.max(1000, data.load.triangles * 0.25)
      || Math.abs(load.calls - data.load.calls) > Math.max(20, data.load.calls * 0.25))) {
      setRenderBudgetLevel(resetBudgetController(data.controller));
      resetRenderFrameSampler(data.sampler); data.load = load;
      return;
    }
    data.load = load;
    if (!data.pinned && now >= data.adaptAfter) {
      const before = getRenderBudgetLevel();
      const next = updateBudget(data.controller, { fps: data.fps, rawFps: data.sampler.rawFps },
        level => budgetPixelRatio(RENDER_BUDGET_LEVELS[level]!, window.devicePixelRatio, size.width, size.height));
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
        rosterCount: data.rosterCount, compositionTransient: data.compositionTransient, avatarEpoch,
        targetFps: 60, settling: !data.pinned && now < data.adaptAfter, decision: data.controller.decision, baselineMs: data.controller.baselineMs, candidateMs: data.controller.candidateMs,
        probe: data.controller.probe ? { direction: data.controller.probe.direction, from: data.controller.probe.from, to: data.controller.level,
          measuredWindows: data.controller.probe.samples.length } : null,
        reductionCooldownWindows: Math.max(0, data.controller.downAfter - data.controller.windows),
      };
    }
  });
  return null;
}
