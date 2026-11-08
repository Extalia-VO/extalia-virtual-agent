import {
  AddEquation, BufferAttribute, BufferGeometry, Color, DynamicDrawUsage, PlaneGeometry, InstancedBufferAttribute, InstancedMesh,
  CustomBlending, NormalBlending, OneFactor, Plane, Points, Raycaster, ShaderMaterial, Vector2, Vector3, ZeroFactor,
  type Fog, type InterleavedBufferAttribute, type PerspectiveCamera, type Scene, type WebGLRenderer,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { GraphTheme } from './graphTheme';
import { graphAppearance, type GraphAppearance } from './graphAppearance';
import { graphEdgeColour } from './graphVisualStyle';
import { createGraphNodeMaterial } from './graphNodeMaterial';
import { GRAPH_STAR_HALO_GLSL } from './graphReferenceStyle';
import { decodeFrame, encodeInit, encodeMask, graphDepthSeed, type Encoded, type SimCommand } from './simProtocol';
import { graphClusters, labelCandidates, neighbourSet, nodeLook, QUALITY_TIERS, updateQuality, type NodeLook, type QualityState, type VaultGraph } from './vaultGraphModel';

/**
 * The imperative half of the whole-vault 3D graph. Three draw calls whatever the vault size: one
 * InstancedMesh of camera-facing star cores, one additive Points cloud of procedural halos and one
 * LineSegments2 of vertex-coloured edges. Positions come from the force simulation (a worker) at
 * up to 30 Hz; frames ease between them. The canvas renders on demand: while the layout moves,
 * the camera moves, or hubs pulse for a while after the last interaction.
 */
export interface GraphOptions {
  /** Present only during Explore; null current means an explicit starting-note choice. */
  explore?: { current: number | null; revision: number } | null;
  graph: VaultGraph;
  appearance?: GraphAppearance;
  theme?: GraphTheme;
  dimensions?: 2 | 3;
  cameraAction?: { kind: 'fit' | 'in' | 'out'; revision: number };
  /** Palette colour per node (hex, sRGB). */
  colours: readonly string[];
  /** 1 for notes the time filter keeps. */
  mask: Uint8Array;
  selected: number | null;
  /** Search matches (`null` without a query): highlighted, the rest dimmed. */
  highlight: readonly number[] | null;
  activeResult: number | null;
  showLabels: boolean;
  showHalos: boolean;
  reducedMotion: boolean;
  showFps: boolean;
  returnToLayout: boolean;
  /** Increments only for an explicit layout restore; unrelated renders preserve interaction. */
  restoreRevision: number;
  onSelect: (index: number) => void;
}

export interface GraphContext {
  scene: Scene;
  camera: PerspectiveCamera;
  gl: WebGLRenderer;
  invalidate: () => void;
  labels: HTMLDivElement | null;
  fps: HTMLDivElement | null;
}

/** The orbit controls' part the renderer drives (drei / three-stdlib OrbitControls). */
export interface OrbitLike { target: Vector3; enabled: boolean; update: () => unknown }

type GraphWindow = Window & { __EXTALIA_GRAPH_FPS__?: unknown; __EXTALIA_GRAPH_PROJECT__?: (index: number) => { x: number; y: number; hubs: number[] } };

const LABEL_POOL = 24;
/** Hubs pulse for this long after the last interaction, then fade out and the canvas goes idle. */
const PULSE_IDLE_MS = 15_000;
const PULSE_HUBS = 6;

/**
 * Light that adds colour and leaves alpha alone: the canvas is transparent over the stage's CSS
 * gradient, so ordinary additive blending (which also writes alpha) would paint dark discs.
 */
const ADDITIVE_LIGHT = {
  blending: CustomBlending, blendEquation: AddEquation, blendSrc: OneFactor, blendDst: OneFactor, blendSrcAlpha: ZeroFactor, blendDstAlpha: OneFactor,
} as const;

const HALO_VERTEX = /* glsl */ `
attribute vec3 aColor;
attribute float aSize;
attribute float aGlow;
attribute float aPulse;
attribute float aFocus;
attribute float aCoreSize;
uniform float uScale;
uniform float uPixelRatio;
uniform float uMaxSize;
uniform float uFocusSize;
uniform float uTime;
uniform float uPulse;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vColor;
varying float vGlow;
varying float vFocus;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float wave = aPulse > 0.0 ? sin(uTime * 1.7 + aPulse * 6.2831) * uPulse : 0.0;
  float depth = max(-mv.z, 0.001);
  float size = aSize * (1.0 + 0.16 * wave) * uScale / depth;
  // The core is clamped in CSS pixels; its halo must use the same screen scale.
  // The reference star texture's core occupies 40% of its diameter.
  float coreRadius = clamp(aCoreSize * uScale / depth, 1.2 * uPixelRatio, 6.0 * uPixelRatio);
  size = max(size, coreRadius * 5.0);
  if (aFocus > 0.0) size = clamp(size, uFocusSize, uFocusSize * 3.0);
  gl_PointSize = aSize > 0.0 ? min(uMaxSize, size) : 0.0;
  float fog = clamp((uFogFar - depth) / max(uFogFar - uFogNear, 0.001), 0.08, 1.0);
  vFocus = aFocus;
  vGlow = aSize > 0.0 ? aGlow : 0.0;
  vColor = aColor * aGlow * 1.2 * fog * (1.0 + 0.2 * wave);
}`;
const HALO_FRAGMENT = /* glsl */ `
uniform float uLight;
varying float vGlow;
varying float vFocus;
${GRAPH_STAR_HALO_GLSL}
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  if (d > 1.0) discard;
  float radius = sqrt(d);
  float falloff = graphStarHaloAlpha(radius, max(fwidth(radius), 0.001));
  float ring = (1.0 - smoothstep(0.018, 0.05, abs(sqrt(d) - 0.52))) * vFocus;
  vec3 ringColour = mix(vec3(0.55, 0.72, 0.95), vec3(0.08, 0.18, 0.35), uLight);
  gl_FragColor = uLight > 0.5
    ? vec4(mix(vColor, ringColour, ring), max(falloff * min(vGlow, 1.0) * 0.3, ring * 0.85))
    : vec4(vColor * falloff + ringColour * ring * 0.7, 0.0);
}`;

interface Buffers {
  graph: VaultGraph;
  count: number;
  edgeCount: number;
  looks: NodeLook[];
  target: Float32Array;
  display: Float32Array;
  scales: Float32Array;
  base: Float32Array;
  core: InstancedMesh;
  halos: Points;
  haloMaterial: ShaderMaterial;
  lines: LineSegments2;
  lineMaterial: LineMaterial;
  edgePositions: Float32Array;
  haloSize: Float32Array;
  haloGlow: Float32Array;
  haloColour: Float32Array;
  haloFocus: Float32Array;
  edgeColour: Float32Array;
  dispose: () => void;
}

function createBuffers(graph: VaultGraph): Buffers {
  const count = graph.nodes.length;
  const edgeCount = graph.edges.length / 2;
  const display = new Float32Array(count * 3);
  const geometry = new PlaneGeometry(2, 2);
  const coreMaterial = createGraphNodeMaterial();
  const core = new InstancedMesh(geometry, coreMaterial, Math.max(1, count));
  core.count = count;
  core.frustumCulled = false;
  core.renderOrder = 2;
  core.instanceMatrix.setUsage(DynamicDrawUsage);
  const matrices = core.instanceMatrix.array as Float32Array;
  matrices.fill(0);
  for (let i = 0; i < count; i++) matrices[i * 16 + 15] = 1;
  core.instanceColor = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);

  const haloGeometry = new BufferGeometry();
  const haloColour = new Float32Array(count * 3), haloSize = new Float32Array(count), haloGlow = new Float32Array(count), haloPulse = new Float32Array(count);
  const scales = new Float32Array(count);
  graph.hubs.slice(0, PULSE_HUBS).forEach((index, rank) => { haloPulse[index] = 0.17 * (rank + 1); });
  const haloFocus = new Float32Array(count);
  haloGeometry.setAttribute('aFocus', new BufferAttribute(haloFocus, 1));
  haloGeometry.setAttribute('aCoreSize', new BufferAttribute(scales, 1));
  haloGeometry.setAttribute('position', new BufferAttribute(display, 3).setUsage(DynamicDrawUsage));
  haloGeometry.setAttribute('aColor', new BufferAttribute(haloColour, 3));
  haloGeometry.setAttribute('aSize', new BufferAttribute(haloSize, 1));
  haloGeometry.setAttribute('aGlow', new BufferAttribute(haloGlow, 1));
  haloGeometry.setAttribute('aPulse', new BufferAttribute(haloPulse, 1));
  const haloMaterial = new ShaderMaterial({
    vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT, transparent: true, depthWrite: false, ...ADDITIVE_LIGHT,
    uniforms: { uLight: { value: 0 }, uScale: { value: 400 }, uPixelRatio: { value: 1 }, uMaxSize: { value: 256 }, uFocusSize: { value: 24 }, uTime: { value: 0 }, uPulse: { value: 0 }, uFogNear: { value: 200 }, uFogFar: { value: 900 } },
  });
  const halos = new Points(haloGeometry, haloMaterial);
  halos.frustumCulled = false;
  halos.renderOrder = 3;

  const lineGeometry = new LineSegmentsGeometry();
  lineGeometry.setPositions(new Float32Array(edgeCount * 6));
  lineGeometry.setColors(new Float32Array(edgeCount * 6));
  const edgePositions = (lineGeometry.attributes.instanceStart as InterleavedBufferAttribute).data.array as Float32Array;
  const edgeColour = (lineGeometry.attributes.instanceColorStart as InterleavedBufferAttribute).data.array as Float32Array;
  const lineMaterial = new LineMaterial({ vertexColors: true, transparent: true, alphaToCoverage: true, depthWrite: false, fog: true, toneMapped: false, linewidth: .85, blending: NormalBlending });
  const lines = new LineSegments2(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 1;

  return {
    graph, count, edgeCount, looks: Array.from(graph.degree, degree => nodeLook(degree, graph.maxDegree)),
    target: new Float32Array(count * 3), display, scales, base: new Float32Array(count * 3),
    core, halos, haloMaterial, lines, lineMaterial, edgePositions, haloSize, haloGlow, haloColour, haloFocus, edgeColour,
    dispose: () => {
      geometry.dispose(); coreMaterial.dispose(); core.dispose();
      haloGeometry.dispose(); haloMaterial.dispose(); lineGeometry.dispose(); lineMaterial.dispose();
    },
  };
}

interface SimHandle { send: (encoded: Encoded<SimCommand>) => void; dispose: () => void }

/** The simulation in a worker; on the main thread (sliced, same code) where workers are unavailable. */
function startSimulation(onFrame: (data: unknown) => void): SimHandle {
  try {
    const worker = new Worker(new URL('./forceWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = event => onFrame(event.data);
    return { send: ({ message, transfer }) => worker.postMessage(message, transfer), dispose: () => worker.terminate() };
  } catch {
    const queue: SimCommand[] = [];
    let core: { handle: (command: SimCommand) => void } | null = null;
    let disposed = false;
    void import('./simCore').then(({ createSimCore }) => {
      if (disposed) return;
      core = createSimCore({ post: ({ message }) => { if (!disposed) onFrame(message); }, schedule: run => { setTimeout(run, 16); }, now: () => performance.now() });
      queue.splice(0).forEach(command => core!.handle(command));
    });
    return {
      send: ({ message }) => { if (core) core.handle(message); else queue.push(message); },
      dispose: () => { disposed = true; core?.handle({ type: 'pause' }); },
    };
  }
}

const command = (message: SimCommand): Encoded<SimCommand> => ({ message, transfer: [] });

export class VaultGraphRenderer {
  private buffers: Buffers | null = null;
  private sim: SimHandle | null = null;
  private options: GraphOptions | null = null;
  private controls: OrbitLike | null = null;
  private hovered: number | null = null;
  private hasFrame = false;
  private moving = false;
  private simRunning = false;
  private userMoved = false;
  private geometryDirty = false;
  private radius = 120;
  private readonly centre = new Vector3();
  private drag: null | { index: number; pointer: number; plane: Plane; x: number; y: number; moved: boolean } = null;
  private fly: null | { from: Vector3; to: Vector3; fromTarget: Vector3; toTarget: Vector3; start: number; duration: number } = null;
  private exploreFlightPending = false;
  private exploreKeepDistance = false;
  private exploreFit = false;
  private labelIndices: number[] = [];
  private labelFocus = new Set<number>();
  private lastActivity = performance.now();
  private quality: QualityState = { tier: 0, slow: 0, fast: 0 };
  private readonly meter = { frames: 0, seconds: 0, fps: 0, windowFrames: 0, windowSeconds: 0 };
  private pulseTimer: ReturnType<typeof setInterval> | null = null;
  private readonly raycaster = new Raycaster();
  private readonly ndc = new Vector2();
  private readonly projected = new Vector3();
  private readonly cleanups: (() => void)[] = [];

  constructor(private readonly ctx: GraphContext) {
    const element = ctx.gl.domElement;
    const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      element.addEventListener(type, listener as EventListener, options);
      this.cleanups.push(() => element.removeEventListener(type, listener as EventListener, options));
    };
    // Capture phase: decide before the orbit controls whether a press grabs a note.
    on('pointerdown', event => this.onDown(event), { capture: true });
    on('pointermove', event => this.onMove(event));
    on('pointerup', event => this.onUp(event));
    on('pointercancel', event => this.onUp(event));
    on('lostpointercapture', event => this.onUp(event));
    on('pointerleave', () => { if (!this.drag) this.setHovered(null); });
    on('wheel', () => this.touch(), { passive: true });
    const visibility = () => {
      if (document.hidden) {
        const drag = this.clearDrag();
        if (drag?.moved) this.sim?.send(command({ type: 'release', index: drag.index }));
      }
      this.sim?.send(command({ type: document.hidden || this.options?.explore ? 'pause' : 'resume' }));
    };
    document.addEventListener('visibilitychange', visibility);
    this.cleanups.push(() => document.removeEventListener('visibilitychange', visibility));
    if (ctx.labels) {
      const root = ctx.labels;
      root.replaceChildren(...Array.from({ length: LABEL_POOL }, () => { const span = document.createElement('span'); span.className = 'vault-graph-label'; span.hidden = true; return span; }));
      this.cleanups.push(() => root.replaceChildren());
    }
  }

  setControls(controls: OrbitLike | null) { this.controls = controls; }

  /** Called by the orbit controls when the user starts moving the camera. */
  userStart() { this.userMoved = true; this.fly = null; this.exploreFlightPending = false; this.touch(); }

  update(next: GraphOptions) {
    const before = this.options;
    this.options = next;
    if (next.explore && !before?.explore) {
      const drag = this.clearDrag();
      if (drag?.moved) this.sim?.send(command({ type: 'release', index: drag.index }));
    }
    if (!before || before.graph !== next.graph) this.setGraph(next.graph);
    const buffers = this.buffers!;
    if (!before || before.graph !== next.graph || before.colours !== next.colours) {
      const colour = new Color();
      next.colours.forEach((hex, i) => { colour.set(hex); buffers.base[i * 3] = colour.r; buffers.base[i * 3 + 1] = colour.g; buffers.base[i * 3 + 2] = colour.b; });
    }
    if (before && before.graph === next.graph && before.mask !== next.mask) {
      // Visibility changes are view filters, not a request to reframe or keep flying.
      this.userStart();
      this.clearDrag();
      this.sim?.send(encodeMask(next.mask));
      this.simRunning = true;
    }
    if (before?.graph === next.graph && (before.returnToLayout !== next.returnToLayout || before.reducedMotion !== next.reducedMotion)) {
      this.sim?.send(command({ type: 'interaction', returnToLayout: next.returnToLayout, reducedMotion: next.reducedMotion }));
    }
    if (before?.graph === next.graph && before.dimensions !== next.dimensions) {
      this.userStart(); this.clearDrag(); this.userMoved = false;
      this.sim?.send(command({ type: 'dimensions', value: next.dimensions ?? 3 }));
      if (next.explore && this.hasFrame) {
        const groups = graphClusters(next.graph);
        // Match the worker's structural projection before freezing its physics;
        // late worker frames must still be ignored during the tour.
        for (let index = 0; index < buffers.count; index++) {
          const z = next.dimensions === 2 ? 0 : graphDepthSeed(index, groups[index] ?? 0);
          buffers.display[index * 3 + 2] = z;
          buffers.target[index * 3 + 2] = z;
        }
        this.geometryDirty = true;
        this.measureExtent();
      }
      if (this.controls && next.dimensions === 2) {
        const distance = this.ctx.camera.position.distanceTo(this.controls.target);
        this.ctx.camera.position.copy(this.controls.target).add(new Vector3(0, 0, distance));
        this.ctx.camera.up.set(0, 1, 0); this.ctx.camera.lookAt(this.controls.target); this.controls.update();
      }
    }
    if (next.cameraAction && before?.cameraAction !== next.cameraAction) {
      if (next.cameraAction.kind === 'fit') { this.userStart(); this.userMoved = false; }
      else if (this.controls) {
        this.userStart();
        const direction = this.ctx.camera.position.clone().sub(this.controls.target);
        const distance = Math.max(6, Math.min(5000, direction.length() * (next.cameraAction.kind === 'in' ? .75 : 1.33)));
        this.ctx.camera.position.copy(this.controls.target).add(direction.normalize().multiplyScalar(distance));
        this.controls.update();
      }
    }
    if (before?.graph === next.graph && before.restoreRevision !== next.restoreRevision) {
      this.clearDrag();
      this.sim?.send(command({ type: 'restore' }));
    }
    if (!before || before.showHalos !== next.showHalos || before.reducedMotion !== next.reducedMotion) this.syncPulse();
    const light = next.theme?.light ?? false;
    if (!before || before.graph !== next.graph || before.theme?.light !== next.theme?.light) {
      buffers.haloMaterial.blending = light ? NormalBlending : CustomBlending;
      // A pale background already conveys depth; avoid fog erasing its finest paths.
      buffers.lineMaterial.fog = !light;
      (buffers.core.material as ShaderMaterial).uniforms.uLight!.value = light ? 1 : 0;
      buffers.haloMaterial.uniforms.uLight!.value = light ? 1 : 0;
      buffers.haloMaterial.needsUpdate = buffers.lineMaterial.needsUpdate = true;
    }
    const fog = this.ctx.scene.fog as Fog | null;
    if (fog?.color && next.theme?.background) fog.color.set(next.theme.background);
    this.restyle();
    if (!next.explore) {
      if (before?.explore) {
        this.fly = null; this.exploreFlightPending = false;
        if (!document.hidden) this.sim?.send(command({ type: 'resume' }));
      }
      if (before?.graph === next.graph && before.selected !== next.selected) this.flyTo(next.selected);
      if (before?.graph === next.graph && before.activeResult !== next.activeResult) this.flyTo(next.activeResult);
    } else {
      this.clearDrag();
      const fitRequested = next.cameraAction?.kind === 'fit' && before?.cameraAction !== next.cameraAction;
      if (!before?.explore || next.explore.current !== null) this.userMoved = true;
      if (next.explore.current === null && fitRequested) this.userMoved = false;
      if (!before?.explore || before.graph !== next.graph || before.mask !== next.mask || before.dimensions !== next.dimensions || before.restoreRevision !== next.restoreRevision) {
        this.sim?.send(command({ type: 'pause' }));
      }
      this.simRunning = false; this.moving = false;
      if (this.hasFrame) buffers.target.set(buffers.display);
      if (!before?.explore || before.graph !== next.graph || before.explore.current !== next.explore.current || before.explore.revision !== next.explore.revision || fitRequested) {
        this.fly = null;
        this.exploreFlightPending = next.explore.current !== null;
        this.exploreKeepDistance = before?.explore?.current !== null && before?.explore?.current !== undefined && before.graph === next.graph;
        this.exploreFit = fitRequested;
        this.flyExplore();
      }
    }
  }

  dispose() {
    this.clearDrag();
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.sim?.dispose();
    if (this.buffers) { this.ctx.scene.remove(this.buffers.core, this.buffers.halos, this.buffers.lines); this.buffers.dispose(); }
    this.buffers = null; this.sim = null;
  }

  /** A new or refreshed vault: new buffers and simulation; notes it still has keep their place. */
  private setGraph(graph: VaultGraph) {
    this.clearDrag();
    const previous = this.buffers;
    if (previous) this.userStart();
    this.sim?.dispose();
    const buffers = createBuffers(graph);
    let seed: Float32Array | undefined;
    if (previous && this.hasFrame) {
      seed = new Float32Array(graph.nodes.length * 3).fill(Number.NaN);
      let kept = 0;
      graph.nodes.forEach((node, i) => {
        const at = previous.graph.indexById.get(node.nodeId);
        if (at !== undefined) { seed!.set(previous.display.subarray(at * 3, at * 3 + 3), i * 3); kept++; }
      });
      if (kept < graph.nodes.length / 2) seed = undefined;
    }
    if (previous) { this.ctx.scene.remove(previous.core, previous.halos, previous.lines); previous.dispose(); }
    this.ctx.scene.add(buffers.lines, buffers.core, buffers.halos);
    this.buffers = buffers;
    this.hasFrame = false; this.simRunning = true; this.hovered = null; this.drag = null;
    const sim = startSimulation(data => this.onFrame(buffers, data));
    sim.send(encodeInit(graph.nodes.length, graph.edges, graph.degree, seed, this.options?.dimensions ?? 3, graphClusters(graph)));
    sim.send(command({ type: 'interaction', returnToLayout: this.options!.returnToLayout, reducedMotion: this.options!.reducedMotion }));
    if (this.options && !this.options.mask.every(Boolean)) sim.send(encodeMask(this.options.mask));
    if (document.hidden) sim.send(command({ type: 'pause' }));
    this.sim = sim;
  }

  private onFrame(buffers: Buffers, data: unknown) {
    if (buffers !== this.buffers) return;
    // A worker message already in flight cannot move an exploration layout.
    if (this.options?.explore && this.hasFrame) return;
    const frame = decodeFrame(data, buffers.count);
    if (!frame) return;
    buffers.target.set(frame.positions);
    const drag = this.drag;
    if (drag?.moved) buffers.target.set(buffers.display.subarray(drag.index * 3, drag.index * 3 + 3), drag.index * 3);
    if (!this.hasFrame || (this.options?.reducedMotion && !frame.running)) { buffers.display.set(buffers.target); this.hasFrame = true; this.geometryDirty = true; }
    this.simRunning = frame.running;
    this.moving = true;
    this.measureExtent();
    if (this.options?.explore) {
      buffers.target.set(buffers.display);
      this.moving = false; this.simRunning = false;
      this.sim?.send(command({ type: 'pause' }));
      this.flyExplore();
    }
    this.ctx.invalidate();
  }

  /** Sizes, colours and dimming for the hover / search / selection focus. */
  private restyle() {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options) return;
    const { graph, mask, selected, highlight, activeResult, showHalos, showLabels } = options;
    const hovered = this.hovered;
    const { scales, base, haloSize, haloGlow, haloColour, haloFocus, edgeColour, looks } = buffers;
    const coreColour = buffers.core.instanceColor!.array as Float32Array;
    const exploring = Boolean(options.explore);
    const exploreCurrent = options.explore?.current;
    const anchor = exploreCurrent !== null && exploreCurrent !== undefined && mask[exploreCurrent] === 1 ? exploreCurrent : null;
    const centre = exploring ? anchor : hovered ?? (highlight ? null : selected);
    const focus = centre !== null ? neighbourSet(graph, centre) : !exploring && highlight ? new Set(highlight) : null;
    const tier = QUALITY_TIERS[this.quality.tier]!;
    const appearance = graphAppearance(options.appearance);
    const light = options.theme?.light ?? false;
    const background = new Color(options.theme?.background ?? '#05070d');
    const backgroundChannels = [background.r, background.g, background.b];
    let visibleEdges = 0;
    for (let e = 0; e < buffers.edgeCount; e++) if (mask[graph.edges[e * 2]!] && mask[graph.edges[e * 2 + 1]!]) visibleEdges++;
    const density = buffers.count > 300 ? .62 : buffers.count > 80 ? .76 : .92;
    buffers.lines.visible = appearance.showLinks;
    buffers.lineMaterial.linewidth = appearance.linkWidth;
    for (let i = 0; i < buffers.count; i++) {
      const look = looks[i]!;
      const visible = mask[i] === 1;
      const lit = !focus || focus.has(i);
      const special = i === hovered || (exploring ? i === anchor : i === selected || i === activeResult);
      scales[i] = visible ? look.radius * appearance.nodeSize * density * .72 * (special ? 1.4 : 1) : 0;
      const dim = lit ? 1 : 0.16;
      for (let c = 0; c < 3; c++) {
        const value = base[i * 3 + c]!;
        const coreValue = (value * (1 - look.lift) + look.lift) * (light ? .65 : 1);
        coreColour[i * 3 + c] = light ? coreValue + (backgroundChannels[c]! - coreValue) * (lit ? 0 : .85) : coreValue * dim;
        haloColour[i * 3 + c] = value;
      }
      haloFocus[i] = visible && special ? 1 : 0;
      haloSize[i] = !visible ? 0 : special ? scales[i]! * 6 : showHalos ? look.halo * appearance.nodeSize * tier.haloScale * .72 : 0;
      haloGlow[i] = (!visible || !showHalos ? 0 : lit ? (focus && focus.size < 200 ? Math.max(look.glow, 0.32) : look.glow) * (special ? 1.4 : 1) : look.glow * 0.05) * appearance.glow;
    }
    const a3 = [0, 0, 0], b3 = [0, 0, 0];
    for (let e = 0; e < buffers.edgeCount; e++) {
      const a = graph.edges[e * 2]!, b = graph.edges[e * 2 + 1]!;
      const visible = mask[a] === 1 && mask[b] === 1;
      const incident = centre !== null ? a === centre || b === centre : focus ? focus.has(a) && focus.has(b) : true;
      const emphasis = focus ? incident ? 'focus' : 'muted' : 'normal';
      for (let c = 0; c < 3; c++) { a3[c] = base[a * 3 + c]!; b3[c] = base[b * 3 + c]!; }
      const aimed = exploring && incident && hovered !== null && (a === hovered || b === hovered);
      const opacity = visible ? appearance.linkOpacity * (aimed ? 1.8 : 1) : 0;
      const start = graphEdgeColour(a3, b3, backgroundChannels, light, opacity, visibleEdges, emphasis);
      const end = graphEdgeColour(b3, a3, backgroundChannels, light, opacity, visibleEdges, emphasis);
      edgeColour.set(start, e * 6); edgeColour.set(end, e * 6 + 3);
    }
    buffers.core.instanceColor!.needsUpdate = true;
    const halo = buffers.halos.geometry.attributes;
    halo.aFocus!.needsUpdate = true; halo.aSize!.needsUpdate = true; halo.aCoreSize!.needsUpdate = true; halo.aGlow!.needsUpdate = true; halo.aColor!.needsUpdate = true;
    (buffers.lines.geometry.attributes.instanceColorStart as InterleavedBufferAttribute).data.needsUpdate = true;
    const labelTargets = exploring ? [anchor, hovered] : [hovered, selected, activeResult];
    this.labelIndices = anchor !== null && focus
      ? [...new Set([anchor, hovered, ...(showLabels ? [...focus] : [])])].filter((index): index is number => index !== null && mask[index] === 1).slice(0, LABEL_POOL)
      : labelCandidates(graph, mask, labelTargets, showLabels ? tier.hubLabels : 0).slice(0, LABEL_POOL);
    this.labelFocus = new Set(labelTargets.filter((item): item is number => item !== null));
    this.geometryDirty = true;
    this.ctx.invalidate();
  }

  /** Ease the camera and the orbit target to a note (selection, active search match). */
  private flyTo(index: number | null) {
    const orbit = this.controls, buffers = this.buffers;
    if (index === null || !orbit || !buffers || !this.hasFrame || this.options?.mask[index] !== 1) return;
    const camera = this.ctx.camera;
    const at = new Vector3().fromArray(buffers.display, index * 3);
    const toward = camera.position.clone().sub(orbit.target).normalize();
    const element = this.ctx.gl.domElement;
    // Narrow stages (phones) see less sideways: back off so neighbours stay in view.
    const aspect = Math.max(0.5, Math.min(1, element.clientWidth / Math.max(1, element.clientHeight)));
    const distance = Math.min(700, Math.max(140, this.radius * 1.1, buffers.looks[index]!.radius * 30) / aspect);
    this.userMoved = true;
    this.fly = {
      from: camera.position.clone(), to: at.clone().addScaledVector(toward, distance), fromTarget: orbit.target.clone(), toTarget: at,
      start: performance.now(), duration: this.options?.reducedMotion ? 0 : 700,
    };
    this.ctx.invalidate();
  }

  /** Explore pans along actual indexed neighbours without resetting the user's hop scale. */
  private flyExplore() {
    const index = this.options?.explore?.current;
    const orbit = this.controls, buffers = this.buffers;
    if (!this.exploreFlightPending || index === null || index === undefined || !orbit || !buffers || !this.hasFrame || this.options?.mask[index] !== 1) return;
    const camera = this.ctx.camera;
    const at = new Vector3().fromArray(buffers.display, index * 3);
    const offset = camera.position.clone().sub(orbit.target);
    if (offset.lengthSq() < 0.001) offset.set(0, 0, 140);
    if (!this.exploreKeepDistance || this.exploreFit) {
      const element = this.ctx.gl.domElement;
      const aspect = Math.max(0.5, Math.min(1, element.clientWidth / Math.max(1, element.clientHeight)));
      let distance = Math.min(offset.length(), Math.max(90, Math.min(350, this.radius * .55 / aspect)));
      if (this.exploreFit) {
        let radius = 0;
        for (const neighbour of neighbourSet(buffers.graph, index)) if (this.options.mask[neighbour] === 1) {
          radius = Math.max(radius, new Vector3().fromArray(buffers.display, neighbour * 3).distanceTo(at));
        }
        distance = Math.min(5000, Math.max(60, radius / Math.sin(camera.fov * Math.PI / 360) / aspect * 1.12));
      }
      offset.normalize().multiplyScalar(distance);
    }
    this.fly = { from: camera.position.clone(), to: at.clone().add(offset), fromTarget: orbit.target.clone(), toTarget: at,
      start: performance.now(), duration: this.options.reducedMotion ? 0 : 600 };
    this.exploreFlightPending = false;
    this.ctx.invalidate();
  }

  /** Hubs pulse gently while someone is around; then the canvas goes fully idle. */
  private syncPulse() {
    const on = Boolean(this.options?.showHalos && !this.options.reducedMotion);
    if (on && !this.pulseTimer) {
      this.pulseTimer = setInterval(() => {
        if (document.hidden || performance.now() - this.lastActivity >= PULSE_IDLE_MS + 2_000) {
          if (this.pulseTimer) clearInterval(this.pulseTimer); this.pulseTimer = null; return;
        }
        this.ctx.invalidate();
      }, 1000 / 30);
    } else if (!on && this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
  }

  private touch() { this.lastActivity = performance.now(); this.syncPulse(); }

  private pick(event: PointerEvent): number | null {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options || !this.hasFrame) return null;
    const rect = this.ctx.gl.domElement.getBoundingClientRect();
    if (!rect.width || !rect.height) return null;
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.ctx.camera);
    // Shader billboards face the camera, unlike their CPU-side base quads. Project their centres
    // for picking in every orientation; keep a six-CSS-pixel target even for tiny distant stars.
    let nearest: number | null = null, distance = 36, depth = Infinity;
    const current = options.explore?.current;
    const reachable = current !== undefined && current !== null ? neighbourSet(options.graph, current) : null;
    for (let i = 0; i < buffers.count; i++) {
      if (!options.mask[i]) continue;
      if (reachable && !reachable.has(i)) continue;
      const point = this.projected.fromArray(buffers.display, i * 3).project(this.ctx.camera);
      if (point.z < -1 || point.z > 1) continue;
      const x = (point.x + 1) * rect.width / 2 + rect.left - event.clientX;
      const y = (1 - point.y) * rect.height / 2 + rect.top - event.clientY;
      const squared = x * x + y * y;
      if (squared < distance || (nearest !== null && Math.abs(squared - distance) < 1e-6 && point.z < depth)) {
        distance = squared; depth = point.z; nearest = i;
      }
    }
    return nearest;
  }

  private setHovered(index: number | null) {
    if (index === this.hovered) return;
    this.hovered = index;
    this.ctx.gl.domElement.style.cursor = index === null ? '' : 'pointer';
    this.restyle();
  }

  private onDown(event: PointerEvent) {
    this.touch();
    if (event.button !== 0 || this.drag) return;
    const index = this.pick(event);
    if (index === null || !this.buffers) return;
    this.ctx.gl.domElement.setPointerCapture(event.pointerId);
    const at = new Vector3().fromArray(this.buffers.display, index * 3);
    const normal = this.ctx.camera.getWorldDirection(new Vector3()).negate();
    this.drag = { index, pointer: event.pointerId, plane: new Plane().setFromNormalAndCoplanarPoint(normal, at), x: event.clientX, y: event.clientY, moved: false };
    // The orbit controls ignore this press.
    if (this.controls) this.controls.enabled = false;
  }

  private onMove(event: PointerEvent) {
    this.touch();
    const drag = this.drag, buffers = this.buffers;
    if (drag && buffers && event.pointerId === drag.pointer) {
      if (!drag.moved && Math.hypot(event.clientX - drag.x, event.clientY - drag.y) < 4) return;
      drag.moved = true;
      if (this.options?.explore) return;
      const rect = this.ctx.gl.domElement.getBoundingClientRect();
      this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.ctx.camera);
      const hit = this.raycaster.ray.intersectPlane(drag.plane, new Vector3());
      if (!hit) return;
      this.userStart();
      buffers.display.set([hit.x, hit.y, hit.z], drag.index * 3);
      buffers.target.set([hit.x, hit.y, hit.z], drag.index * 3);
      this.geometryDirty = true;
      this.sim?.send(command({ type: 'drag', index: drag.index, x: hit.x, y: hit.y, z: hit.z }));
      this.ctx.invalidate();
      return;
    }
    // No picking while orbiting (a button is held).
    if (event.buttons) return;
    this.setHovered(this.pick(event));
  }

  /** Release capture before graph replacement/filtering can discard the gesture. */
  private clearDrag() {
    const drag = this.drag;
    this.drag = null;
    if (this.controls) this.controls.enabled = true;
    if (drag && this.ctx.gl.domElement.hasPointerCapture(drag.pointer)) this.ctx.gl.domElement.releasePointerCapture(drag.pointer);
    return drag;
  }

  private onUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    this.clearDrag();
    if (drag.moved) {
      this.sim?.send(command({ type: 'release', index: drag.index }));
    } else if (event.type === 'pointerup') this.options?.onSelect(drag.index);
  }

  /** Centre and outer radius of the shown notes (90th percentile distance, so a few strays do not shrink the view). */
  private measureExtent() {
    const buffers = this.buffers, mask = this.options?.mask;
    if (!buffers || !mask) return;
    const positions = buffers.target;
    let x = 0, y = 0, z = 0, n = 0;
    for (let i = 0; i < buffers.count; i++) if (mask[i]) { x += positions[i * 3]!; y += positions[i * 3 + 1]!; z += positions[i * 3 + 2]!; n++; }
    if (!n) return;
    x /= n; y /= n; z /= n;
    const distances: number[] = [];
    for (let i = 0; i < buffers.count; i++) if (mask[i]) distances.push(Math.hypot(positions[i * 3]! - x, positions[i * 3 + 1]! - y, positions[i * 3 + 2]! - z));
    distances.sort((a, b) => a - b);
    this.centre.set(x, y, z);
    this.radius = Math.max(30, (distances[Math.floor(distances.length * 0.9)] ?? 30) * 1.1);
  }

  /** Instance matrices (uniform scale + translation), halo positions and edge endpoints from the displayed positions. */
  private writeGeometry(buffers: Buffers) {
    const { display, scales, core, halos, lines } = buffers;
    const matrices = core.instanceMatrix.array as Float32Array;
    for (let i = 0; i < buffers.count; i++) {
      const o = i * 16, s = scales[i]!;
      matrices[o] = s; matrices[o + 5] = s; matrices[o + 10] = s;
      matrices[o + 12] = display[i * 3]!; matrices[o + 13] = display[i * 3 + 1]!; matrices[o + 14] = display[i * 3 + 2]!;
    }
    core.instanceMatrix.needsUpdate = true;
    // Raycasting recomputes the bounds lazily from the moved instances.
    core.boundingSphere = null;
    halos.geometry.attributes.position!.needsUpdate = true;
    const positions = buffers.edgePositions;
    const edges = buffers.graph.edges;
    for (let e = 0; e < edges.length; e += 2) {
      // Collapse filtered segments; background-coloured hidden edges must never paint over visible links.
      const a = edges[e]!, b = edges[e + 1]!;
      if (this.options?.mask[a] !== 1 || this.options.mask[b] !== 1) { positions.fill(0, e * 3, e * 3 + 6); continue; }
      positions.set(display.subarray(a * 3, a * 3 + 3), e * 3);
      positions.set(display.subarray(b * 3, b * 3 + 3), e * 3 + 3);
    }
    (lines.geometry.attributes.instanceStart as InterleavedBufferAttribute).data.needsUpdate = true;
  }

  /** One rendered frame (before three renders it). */
  frame(size: { width: number; height: number }, delta: number, time: number) {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options) return;
    const { camera, invalidate, gl, scene } = this.ctx;
    buffers.lineMaterial.resolution.set(size.width, size.height);
    (buffers.core.material as ShaderMaterial).uniforms.uViewportHeight!.value = size.height;
    const dt = Math.min(delta, 0.1);
    if (this.hasFrame && this.moving) {
      const k = 1 - Math.exp(-dt * 11);
      let largest = 0;
      const { target, display } = buffers;
      for (let i = 0; i < display.length; i++) {
        const step = (target[i]! - display[i]!) * k;
        display[i] = display[i]! + step;
        if (Math.abs(step) > largest) largest = Math.abs(step);
      }
      this.moving = largest > 0.004 || this.simRunning;
      if (!this.moving) display.set(target);
      this.geometryDirty = true;
    }
    if (this.geometryDirty) { this.geometryDirty = false; this.writeGeometry(buffers); }
    if (this.moving || this.drag) invalidate();

    // Camera: fly animation, else frame the layout until the user takes over.
    const orbit = this.controls;
    const fovRad = (camera.fov * Math.PI) / 180;
    if (orbit && this.fly) {
      const fly = this.fly;
      const t = fly.duration ? Math.min(1, (performance.now() - fly.start) / fly.duration) : 1;
      const eased = 1 - (1 - t) ** 3;
      camera.position.lerpVectors(fly.from, fly.to, eased);
      orbit.target.lerpVectors(fly.fromTarget, fly.toTarget, eased);
      orbit.update();
      if (t >= 1) this.fly = null; else invalidate();
    } else if (orbit && !this.userMoved && this.hasFrame) {
      const aspect = Math.max(0.45, Math.min(1, size.width / Math.max(1, size.height)));
      const want = (this.radius / Math.sin(fovRad / 2)) / aspect * 0.9 + 20;
      const direction = camera.position.clone().sub(orbit.target).normalize();
      const k = 1 - Math.exp(-dt * 4);
      orbit.target.lerp(this.centre, k);
      const distance = camera.position.distanceTo(orbit.target);
      const next = distance + (want - distance) * k;
      camera.position.copy(orbit.target).addScaledVector(direction, next);
      orbit.update();
      if (Math.abs(want - next) > 0.5) invalidate();
    }

    // Depth cue: fog and halo fade follow the orbit distance.
    const distance = orbit ? camera.position.distanceTo(orbit.target) : 400;
    const fogNear = distance * 0.55, fogFar = distance + this.radius * 2.2;
    const fog = scene.fog as Fog | null;
    if (fog && 'near' in fog) { fog.near = fogNear; fog.far = fogFar; }
    const tier = QUALITY_TIERS[this.quality.tier]!;
    const uniforms = buffers.haloMaterial.uniforms;
    const pixelRatio = gl.getPixelRatio();
    uniforms.uPixelRatio!.value = pixelRatio;
    uniforms.uScale!.value = (size.height * pixelRatio * 0.5) / Math.tan(fovRad / 2);
    uniforms.uMaxSize!.value = 220 * pixelRatio * tier.haloScale;
    uniforms.uFocusSize!.value = 24 * pixelRatio;
    uniforms.uFogNear!.value = fogNear; uniforms.uFogFar!.value = fogFar;
    uniforms.uTime!.value = time;
    const idle = performance.now() - this.lastActivity;
    uniforms.uPulse!.value = this.pulseTimer ? Math.max(0, Math.min(1, 1 - (idle - PULSE_IDLE_MS) / 2_000)) : 0;

    this.placeLabels(buffers, size);
    this.measure(delta, options, buffers, pixelRatio);
  }

  /** Label pool: plain DOM spans under their notes. */
  private placeLabels(buffers: Buffers, size: { width: number; height: number }) {
    const root = this.ctx.labels;
    if (!root) return;
    const spans = root.children;
    const placed: { x: number; y: number; width: number }[] = [];
    for (let slot = 0; slot < spans.length; slot++) {
      const span = spans[slot] as HTMLElement;
      const index = this.labelIndices[slot];
      if (index === undefined) { if (!span.hidden) span.hidden = true; continue; }
      const p = this.projected.fromArray(buffers.display, index * 3).project(this.ctx.camera);
      if (p.z > 1 || Math.abs(p.x) > 1.1 || Math.abs(p.y) > 1.1) { span.hidden = true; continue; }
      const title = buffers.graph.nodes[index]!.title;
      if (span.textContent !== title) span.textContent = title;
      const focus = this.labelFocus.has(index) ? 'true' : 'false';
      if (span.dataset.focus !== focus) span.dataset.focus = focus;
      const x = ((p.x + 1) / 2) * size.width, y = ((1 - p.y) / 2) * size.height;
      const width = Math.min(220, title.length * 6.2);
      if (focus === 'false' && placed.some(box => Math.abs(y - box.y) < 24 && Math.abs(x - box.x) < (width + box.width) / 2 + 8)) { span.hidden = true; continue; }
      placed.push({ x, y, width }); span.hidden = false;
      span.style.transform = `translate(${x}px, ${y}px) translate(-50%, 10px)`;
    }
  }

  /** Frame-rate windows (only while frames run back to back): step the quality tier, feed the dev readout. */
  private measure(delta: number, options: GraphOptions, buffers: Buffers, pixelRatio: number) {
    const meter = this.meter;
    if (delta > 0.2) { meter.windowFrames = 0; meter.windowSeconds = 0; meter.frames = 0; meter.seconds = 0; return; }
    meter.frames++; meter.seconds += delta; meter.windowFrames++; meter.windowSeconds += delta;
    if (meter.seconds >= 1) {
      meter.fps = meter.frames / meter.seconds;
      meter.frames = 0; meter.seconds = 0;
      if (import.meta.env.DEV && options.showFps) {
        const info = {
          fps: Math.round(meter.fps * 10) / 10, frameMs: Math.round((1000 / meter.fps) * 10) / 10, nodes: buffers.count, edges: buffers.edgeCount,
          tier: this.quality.tier, dpr: pixelRatio, calls: this.ctx.gl.info.render.calls, settled: !this.simRunning,
        };
        (window as GraphWindow).__EXTALIA_GRAPH_FPS__ = info;
        // QA: where a note is on screen (client pixels), to hover or click it in automated checks.
        (window as GraphWindow).__EXTALIA_GRAPH_PROJECT__ = (index: number) => {
          const rect = this.ctx.gl.domElement.getBoundingClientRect();
          const p = new Vector3().fromArray(buffers.display, index * 3).project(this.ctx.camera);
          return { x: rect.left + ((p.x + 1) / 2) * rect.width, y: rect.top + ((1 - p.y) / 2) * rect.height, hubs: buffers.graph.hubs.slice(0, 10) };
        };
        if (this.ctx.fps) this.ctx.fps.textContent = `${info.fps} fps · ${info.frameMs} ms · ${info.nodes} nodes · ${info.edges} edges · tier ${info.tier} · dpr ${info.dpr}`;
      }
    }
    if (meter.windowSeconds >= 1.5) {
      if (meter.windowFrames >= 24) {
        const tier = this.quality.tier;
        this.quality = updateQuality(this.quality, meter.windowFrames / meter.windowSeconds);
        if (this.quality.tier !== tier) this.restyle();
      }
      meter.windowFrames = 0; meter.windowSeconds = 0;
    }
  }
}
