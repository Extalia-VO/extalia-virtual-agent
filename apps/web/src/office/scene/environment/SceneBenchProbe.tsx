import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import type { Object3D, OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import { overviewFlags } from './overviewLod';

/** Renderer statistics for one measurement window (`__EXTALIA_BENCH__.measure`). */
export interface BenchWindow {
  frames: number;
  seconds: number;
  /** Frames per second over the whole window. */
  fps: number;
  /** FPS of the median and the 95th-percentile-slowest frame interval. */
  medianFps: number;
  p5Fps: number;
  /** Frames counted in each whole second of the window: median and 5th percentile (lowest 5 %). */
  secondMedianFps: number;
  secondP5Fps: number;
  /** Main-thread milliseconds inside `renderer.render` (submission, not GPU execution). */
  renderMs: number;
  /** GPU milliseconds per frame from `EXT_disjoint_timer_query_webgl2`, when the browser exposes it. */
  gpuMs: number | null;
  /** Median and slowest single-frame GPU milliseconds. */
  gpuMedianMs: number | null;
  gpuMaxMs: number | null;
  calls: number;
  triangles: number;
  maxCalls: number;
  programs: number;
  geometries: number;
  textures: number;
}

type Point = [number, number, number];
type BenchApi = {
  camera(target: Point, offset: Point, zoom: number): void;
  measure(ms: number): Promise<BenchWindow>;
  /** Hide (false) or restore (true/undefined) every object whose name matches the pattern. */
  toggle(pattern: string, visible: boolean): number;
  /** Named objects with their visible mesh and triangle counts, for picking toggle patterns. */
  names(pattern?: string): { name: string; meshes: number; triangles: number }[];
  /** Scene hierarchy down to `depth` with visible mesh and triangle counts (unnamed nodes show their type). */
  tree(depth: number, minTriangles?: number): string[];
  shadows(enabled: boolean): void;
  lights(): { type: string; name: string; castShadow: boolean; visible: boolean }[];
  /** Stop (true) or resume (false) the render loop, e.g. while the benchmark waits for an idle GPU. */
  pause(paused: boolean): void;
  /** Overview level-of-detail switches, for A/B runs in one page. */
  flags: typeof overviewFlags;
  /** Raw renderer and scene for ad-hoc inspection from the benchmark page. */
  renderer: unknown;
  scene: unknown;
};
type ProbeWindow = Window & { __EXTALIA_BENCH__?: BenchApi };

const percentile = (sorted: readonly number[], fraction: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ?? 0;

function visibleStats(root: Object3D) {
  let meshes = 0, triangles = 0;
  root.traverseVisible(object => {
    const mesh = object as Object3D & { isMesh?: boolean; geometry?: { index: { count: number } | null; attributes: { position?: { count: number } } }; count?: number; isInstancedMesh?: boolean };
    if (!mesh.isMesh || !mesh.geometry) return;
    meshes++;
    const vertices = mesh.geometry.index?.count ?? mesh.geometry.attributes.position?.count ?? 0;
    triangles += vertices / 3 * (mesh.isInstancedMesh ? mesh.count ?? 1 : 1);
  });
  return { meshes, triangles: Math.round(triangles) };
}

/** QA/benchmark probe (`QA_HOOKS` builds only): fixed cameras, frame statistics and subsystem toggles. */
export function SceneBenchProbe() {
  const gl = useThree(state => state.gl);
  const scene = useThree(state => state.scene);
  const camera = useThree(state => state.camera);
  const controls = useThree(state => state.controls) as unknown as { target: Vector3; update(): void } | null;
  const setFrameloop = useThree(state => state.setFrameloop);

  useEffect(() => {
    const context = gl.getContext() as WebGL2RenderingContext;
    const timer = context.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number; GPU_DISJOINT_EXT: number } | null;
    const original = gl.render;
    const live = { renderMs: [] as number[], calls: [] as number[], triangles: [] as number[], gpu: [] as number[], recording: false,
      queries: [] as WebGLQuery[] };
    gl.render = function render(...args: Parameters<typeof original>) {
      if (!live.recording) return original.apply(this, args);
      const query = timer ? context.createQuery() : null;
      if (query && timer) context.beginQuery(timer.TIME_ELAPSED_EXT, query);
      const started = performance.now();
      original.apply(this, args);
      live.renderMs.push(performance.now() - started);
      if (query && timer) { context.endQuery(timer.TIME_ELAPSED_EXT); live.queries.push(query); }
      live.calls.push(gl.info.render.calls);
      live.triangles.push(gl.info.render.triangles);
      // Resolve finished GPU timers without stalling the pipeline.
      while (timer && live.queries.length && context.getQueryParameter(live.queries[0]!, context.QUERY_RESULT_AVAILABLE)) {
        const done = live.queries.shift()!;
        if (!context.getParameter(timer.GPU_DISJOINT_EXT)) live.gpu.push(Number(context.getQueryParameter(done, context.QUERY_RESULT)) / 1e6);
        context.deleteQuery(done);
      }
    };
    const hidden = new Map<Object3D, boolean>();
    const api: BenchApi = {
      renderer: gl,
      scene,
      flags: overviewFlags,
      pause(paused) { setFrameloop(paused ? 'never' : 'always'); },
      camera(target, offset, zoom) {
        camera.position.set(target[0] + offset[0], target[1] + offset[1], target[2] + offset[2]);
        (camera as OrthographicCamera | PerspectiveCamera).zoom = zoom;
        camera.lookAt(...target);
        (camera as OrthographicCamera).updateProjectionMatrix();
        if (controls) { controls.target.set(...target); controls.update(); }
      },
      measure(ms) {
        live.renderMs = []; live.calls = []; live.triangles = []; live.gpu = []; live.recording = true;
        return new Promise(resolve => {
          const intervals: number[] = [];
          const started = performance.now();
          let last = started;
          const tick = (now: number) => {
            intervals.push(now - last); last = now;
            if (now - started < ms) { requestAnimationFrame(tick); return; }
            live.recording = false;
            intervals.shift();
            const sorted = [...intervals].sort((a, b) => a - b);
            // Per-second FPS: vsync quantises single frame intervals to 60/30/20 fps, whole seconds are not.
            const perSecond: number[] = [];
            let elapsed = 0, inSecond = 0;
            for (const interval of intervals) {
              elapsed += interval; inSecond++;
              if (elapsed >= 1000) { perSecond.push(inSecond * 1000 / elapsed); elapsed = 0; inSecond = 0; }
            }
            const seconds2 = [...perSecond].sort((a, b) => a - b);
            const mean = (values: number[]) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
            const seconds = intervals.reduce((sum, value) => sum + value, 0) / 1000;
            const round = (value: number, digits = 1) => Math.round(value * 10 ** digits) / 10 ** digits;
            resolve({ frames: intervals.length, seconds: round(seconds, 2), fps: round(intervals.length / seconds),
              medianFps: round(1000 / percentile(sorted, 0.5)), p5Fps: round(1000 / percentile(sorted, 0.95)),
              secondMedianFps: round(percentile(seconds2, 0.5)), secondP5Fps: round(seconds2[Math.floor((seconds2.length - 1) * 0.05)] ?? 0),
              renderMs: round(mean(live.renderMs), 2), gpuMs: live.gpu.length ? round(mean(live.gpu), 2) : null,
              gpuMedianMs: live.gpu.length ? round(percentile([...live.gpu].sort((a, b) => a - b), 0.5), 2) : null,
              gpuMaxMs: live.gpu.length ? round(Math.max(...live.gpu), 2) : null,
              calls: Math.round(mean(live.calls)), triangles: Math.round(mean(live.triangles)), maxCalls: Math.max(0, ...live.calls),
              programs: gl.info.programs?.length ?? 0, geometries: gl.info.memory.geometries, textures: gl.info.memory.textures });
          };
          requestAnimationFrame(now => { last = now; requestAnimationFrame(tick); });
        });
      },
      toggle(pattern, visible) {
        const match = new RegExp(pattern);
        let count = 0;
        if (visible) {
          for (const [object, was] of hidden) if (match.test(object.name)) { object.visible = was; hidden.delete(object); count++; }
          return count;
        }
        scene.traverse(object => {
          if (!object.name || !match.test(object.name) || hidden.has(object)) return;
          hidden.set(object, object.visible); object.visible = false; count++;
        });
        return count;
      },
      names(pattern) {
        const match = pattern ? new RegExp(pattern) : null;
        const result: { name: string; meshes: number; triangles: number }[] = [];
        scene.traverse(object => { if (object.name && (!match || match.test(object.name))) result.push({ name: object.name, ...visibleStats(object) }); });
        return result;
      },
      tree(depth, minTriangles = 5000) {
        const lines: string[] = [];
        const walk = (object: Object3D, level: number) => {
          const stats = visibleStats(object);
          if (stats.triangles < minTriangles) return;
          lines.push(`${'  '.repeat(level)}${object.name || object.type} [${object.visible ? 'shown' : 'hidden'}] meshes=${stats.meshes} tris=${stats.triangles}`);
          if (level < depth) object.children.forEach(child => walk(child, level + 1));
        };
        walk(scene, 0);
        return lines;
      },
      shadows(enabled) {
        gl.shadowMap.enabled = enabled;
        scene.traverse(object => { const material = (object as Object3D & { material?: { needsUpdate: boolean } }).material; if (material) material.needsUpdate = true; });
      },
      lights() {
        const result: { type: string; name: string; castShadow: boolean; visible: boolean }[] = [];
        scene.traverse(object => { if ((object as Object3D & { isLight?: boolean }).isLight) result.push({ type: object.type, name: object.name, castShadow: object.castShadow, visible: object.visible }); });
        return result;
      },
    };
    (window as ProbeWindow).__EXTALIA_BENCH__ = api;
    return () => {
      gl.render = original;
      for (const [object, was] of hidden) object.visible = was;
      delete (window as ProbeWindow).__EXTALIA_BENCH__;
    };
  }, [gl, scene, camera, controls, setFrameloop]);
  return null;
}
