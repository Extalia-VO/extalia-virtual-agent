import {
  AddEquation, BufferAttribute, BufferGeometry, CanvasTexture, Color, DynamicDrawUsage, IcosahedronGeometry, InstancedBufferAttribute, InstancedMesh,
  LineBasicMaterial, CustomBlending, LineSegments, MeshMatcapMaterial, OneFactor, Plane, Points, Raycaster, ShaderMaterial, SRGBColorSpace, Vector2, Vector3, ZeroFactor,
  type Fog, type PerspectiveCamera, type Scene, type WebGLRenderer,
} from 'three';
import { decodeFrame, encodeInit, encodeMask, SIM_REHEAT_ALPHA, type Encoded, type SimCommand } from './simProtocol';
import { edgeEndColour, labelCandidates, neighbourSet, nodeLook, QUALITY_TIERS, updateQuality, type NodeLook, type QualityState, type VaultGraph } from './vaultGraphModel';

/**
 * The imperative half of the whole-vault 3D graph. Three draw calls whatever the vault size: one
 * InstancedMesh of matcap-shaded cores, one additive Points cloud of procedural halos and one
 * LineSegments of vertex-coloured edges. Positions come from the force simulation (a worker) at
 * up to 30 Hz; frames ease between them. The canvas renders on demand: while the layout moves,
 * the camera moves, or hubs pulse for a while after the last interaction.
 */
export interface GraphOptions {
  graph: VaultGraph;
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
uniform float uScale;
uniform float uMaxSize;
uniform float uTime;
uniform float uPulse;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vColor;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float wave = aPulse > 0.0 ? sin(uTime * 1.7 + aPulse * 6.2831) * uPulse : 0.0;
  float depth = max(-mv.z, 0.001);
  gl_PointSize = aSize > 0.0 ? min(uMaxSize, aSize * (1.0 + 0.16 * wave) * uScale / depth) : 0.0;
  float fog = clamp((uFogFar - depth) / max(uFogFar - uFogNear, 0.001), 0.12, 1.0);
  vColor = aColor * aGlow * 1.35 * fog * (1.0 + 0.3 * wave);
}`;
const HALO_FRAGMENT = /* glsl */ `
varying vec3 vColor;
void main() {
  vec2 p = gl_PointCoord * 2.0 - 1.0;
  float d = dot(p, p);
  if (d > 1.0) discard;
  float falloff = (exp(-4.5 * d) - 0.011) * (1.0 - d);
  gl_FragColor = vec4(vColor * falloff, 0.0);
}`;

/** A soft studio matcap drawn at runtime (no binary asset): cores read as small glossy spheres without lights. */
function matcapTexture(): CanvasTexture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const base = ctx.createRadialGradient(size * 0.4, size * 0.36, size * 0.04, size / 2, size / 2, size / 2);
  base.addColorStop(0, '#ffffff');
  base.addColorStop(0.28, '#e9edf5');
  base.addColorStop(0.7, '#9aa3b5');
  base.addColorStop(1, '#3a4152');
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, size, size);
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

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
  lines: LineSegments;
  haloSize: Float32Array;
  haloGlow: Float32Array;
  haloColour: Float32Array;
  edgeColour: Float32Array;
  dispose: () => void;
}

function createBuffers(graph: VaultGraph): Buffers {
  const count = graph.nodes.length;
  const edgeCount = graph.edges.length / 2;
  const display = new Float32Array(count * 3);
  const geometry = new IcosahedronGeometry(1, count > 1200 ? 1 : 2);
  const matcap = matcapTexture();
  const coreMaterial = new MeshMatcapMaterial({ matcap, fog: true });
  const core = new InstancedMesh(geometry, coreMaterial, Math.max(1, count));
  core.count = count;
  core.frustumCulled = false;
  core.instanceMatrix.setUsage(DynamicDrawUsage);
  const matrices = core.instanceMatrix.array as Float32Array;
  matrices.fill(0);
  for (let i = 0; i < count; i++) matrices[i * 16 + 15] = 1;
  core.instanceColor = new InstancedBufferAttribute(new Float32Array(Math.max(1, count) * 3), 3);

  const haloGeometry = new BufferGeometry();
  const haloColour = new Float32Array(count * 3), haloSize = new Float32Array(count), haloGlow = new Float32Array(count), haloPulse = new Float32Array(count);
  graph.hubs.slice(0, PULSE_HUBS).forEach((index, rank) => { haloPulse[index] = 0.17 * (rank + 1); });
  haloGeometry.setAttribute('position', new BufferAttribute(display, 3).setUsage(DynamicDrawUsage));
  haloGeometry.setAttribute('aColor', new BufferAttribute(haloColour, 3));
  haloGeometry.setAttribute('aSize', new BufferAttribute(haloSize, 1));
  haloGeometry.setAttribute('aGlow', new BufferAttribute(haloGlow, 1));
  haloGeometry.setAttribute('aPulse', new BufferAttribute(haloPulse, 1));
  const haloMaterial = new ShaderMaterial({
    vertexShader: HALO_VERTEX, fragmentShader: HALO_FRAGMENT, transparent: true, depthWrite: false, ...ADDITIVE_LIGHT,
    uniforms: { uScale: { value: 400 }, uMaxSize: { value: 256 }, uTime: { value: 0 }, uPulse: { value: 0 }, uFogNear: { value: 200 }, uFogFar: { value: 900 } },
  });
  const halos = new Points(haloGeometry, haloMaterial);
  halos.frustumCulled = false;
  halos.renderOrder = 2;

  const lineGeometry = new BufferGeometry();
  const edgeColour = new Float32Array(edgeCount * 6);
  lineGeometry.setAttribute('position', new BufferAttribute(new Float32Array(edgeCount * 6), 3).setUsage(DynamicDrawUsage));
  lineGeometry.setAttribute('color', new BufferAttribute(edgeColour, 3));
  const lineMaterial = new LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: true, ...ADDITIVE_LIGHT });
  const lines = new LineSegments(lineGeometry, lineMaterial);
  lines.frustumCulled = false;
  lines.renderOrder = 1;

  return {
    graph, count, edgeCount, looks: Array.from(graph.degree, degree => nodeLook(degree, graph.maxDegree)),
    target: new Float32Array(count * 3), display, scales: new Float32Array(count), base: new Float32Array(count * 3),
    core, halos, haloMaterial, lines, haloSize, haloGlow, haloColour, edgeColour,
    dispose: () => {
      geometry.dispose(); coreMaterial.dispose(); matcap.dispose(); core.dispose();
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
    on('pointerleave', () => { if (!this.drag) this.setHovered(null); });
    on('wheel', () => this.touch(), { passive: true });
    const visibility = () => this.sim?.send(command({ type: document.hidden ? 'pause' : 'resume' }));
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
  userStart() { this.userMoved = true; this.fly = null; this.touch(); }

  update(next: GraphOptions) {
    const before = this.options;
    this.options = next;
    if (!before || before.graph !== next.graph) this.setGraph(next.graph);
    const buffers = this.buffers!;
    if (!before || before.graph !== next.graph || before.colours !== next.colours) {
      const colour = new Color();
      next.colours.forEach((hex, i) => { colour.set(hex); buffers.base[i * 3] = colour.r; buffers.base[i * 3 + 1] = colour.g; buffers.base[i * 3 + 2] = colour.b; });
    }
    if (before && before.graph === next.graph && before.mask !== next.mask) {
      this.sim?.send(encodeMask(next.mask));
      this.simRunning = true;
    }
    if (!before || before.showHalos !== next.showHalos || before.reducedMotion !== next.reducedMotion) this.syncPulse();
    this.restyle();
    if (before?.graph === next.graph && before.selected !== next.selected) this.flyTo(next.selected);
    if (before?.graph === next.graph && before.activeResult !== next.activeResult) this.flyTo(next.activeResult);
  }

  dispose() {
    this.cleanups.splice(0).forEach(cleanup => cleanup());
    if (this.pulseTimer) clearInterval(this.pulseTimer);
    this.sim?.dispose();
    if (this.buffers) { this.ctx.scene.remove(this.buffers.core, this.buffers.halos, this.buffers.lines); this.buffers.dispose(); }
    this.buffers = null; this.sim = null;
  }

  /** A new or refreshed vault: new buffers and simulation; notes it still has keep their place. */
  private setGraph(graph: VaultGraph) {
    const previous = this.buffers;
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
    sim.send(encodeInit(graph.nodes.length, graph.edges, graph.degree, seed));
    if (this.options && !this.options.mask.every(Boolean)) sim.send(encodeMask(this.options.mask));
    this.sim = sim;
  }

  private onFrame(buffers: Buffers, data: unknown) {
    if (buffers !== this.buffers) return;
    const frame = decodeFrame(data, buffers.count);
    if (!frame) return;
    buffers.target.set(frame.positions);
    const drag = this.drag;
    if (drag?.moved) buffers.target.set(buffers.display.subarray(drag.index * 3, drag.index * 3 + 3), drag.index * 3);
    if (!this.hasFrame) { buffers.display.set(frame.positions); this.hasFrame = true; this.geometryDirty = true; }
    this.simRunning = frame.running;
    this.moving = true;
    this.measureExtent();
    this.ctx.invalidate();
  }

  /** Sizes, colours and dimming for the hover / search / selection focus. */
  private restyle() {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options) return;
    const { graph, mask, selected, highlight, activeResult, showHalos, showLabels } = options;
    const hovered = this.hovered;
    const { scales, base, haloSize, haloGlow, haloColour, edgeColour, looks } = buffers;
    const coreColour = buffers.core.instanceColor!.array as Float32Array;
    const centre = hovered ?? (highlight ? null : selected);
    const focus = centre !== null ? neighbourSet(graph, centre) : highlight ? new Set(highlight) : null;
    const tier = QUALITY_TIERS[this.quality.tier]!;
    for (let i = 0; i < buffers.count; i++) {
      const look = looks[i]!;
      const visible = mask[i] === 1;
      const lit = !focus || focus.has(i);
      const special = i === hovered || i === selected || i === activeResult;
      scales[i] = visible ? look.radius * (special ? 1.35 : 1) : 0;
      const dim = lit ? 1 : 0.16;
      for (let c = 0; c < 3; c++) {
        const value = base[i * 3 + c]!;
        coreColour[i * 3 + c] = (value * (1 - look.lift) + look.lift) * dim;
        haloColour[i * 3 + c] = value;
      }
      haloSize[i] = visible && showHalos ? look.halo * tier.haloScale * (special ? 1.5 : 1) : 0;
      haloGlow[i] = lit ? (focus && focus.size < 200 ? Math.max(look.glow, 0.32) : look.glow) * (special ? 1.4 : 1) : look.glow * 0.05;
    }
    const a3 = [0, 0, 0], b3 = [0, 0, 0];
    for (let e = 0; e < buffers.edgeCount; e++) {
      const a = graph.edges[e * 2]!, b = graph.edges[e * 2 + 1]!;
      const visible = mask[a] === 1 && mask[b] === 1;
      const incident = centre !== null ? a === centre || b === centre : focus ? focus.has(a) && focus.has(b) : true;
      const intensity = !visible ? 0 : focus ? (incident ? 0.8 : 0.02) : 0.14;
      for (let c = 0; c < 3; c++) { a3[c] = base[a * 3 + c]!; b3[c] = base[b * 3 + c]!; }
      edgeColour.set(edgeEndColour(a3, b3, intensity), e * 6);
      edgeColour.set(edgeEndColour(b3, a3, intensity), e * 6 + 3);
    }
    buffers.core.instanceColor!.needsUpdate = true;
    const halo = buffers.halos.geometry.attributes;
    halo.aSize!.needsUpdate = true; halo.aGlow!.needsUpdate = true; halo.aColor!.needsUpdate = true;
    buffers.lines.geometry.attributes.color!.needsUpdate = true;
    this.labelIndices = labelCandidates(graph, mask, [hovered, selected, activeResult], showLabels ? tier.hubLabels : 0).slice(0, LABEL_POOL);
    this.labelFocus = new Set([hovered, selected, activeResult].filter((item): item is number => item !== null));
    this.geometryDirty = true;
    this.ctx.invalidate();
  }

  /** Ease the camera and the orbit target to a note (selection, active search match). */
  private flyTo(index: number | null) {
    const orbit = this.controls, buffers = this.buffers;
    if (index === null || !orbit || !buffers || !this.hasFrame) return;
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

  /** Hubs pulse gently while someone is around; then the canvas goes fully idle. */
  private syncPulse() {
    const on = Boolean(this.options?.showHalos && !this.options.reducedMotion);
    if (on && !this.pulseTimer) {
      this.pulseTimer = setInterval(() => {
        if (!document.hidden && performance.now() - this.lastActivity < PULSE_IDLE_MS + 2_000) this.ctx.invalidate();
      }, 1000 / 30);
    } else if (!on && this.pulseTimer) { clearInterval(this.pulseTimer); this.pulseTimer = null; }
  }

  private touch() { this.lastActivity = performance.now(); }

  private pick(event: PointerEvent): number | null {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options || !this.hasFrame) return null;
    const rect = this.ctx.gl.domElement.getBoundingClientRect();
    this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(this.ndc, this.ctx.camera);
    for (const hit of this.raycaster.intersectObject(buffers.core, false)) {
      if (hit.instanceId !== undefined && options.mask[hit.instanceId] === 1) return hit.instanceId;
    }
    return null;
  }

  private setHovered(index: number | null) {
    if (index === this.hovered) return;
    this.hovered = index;
    this.ctx.gl.domElement.style.cursor = index === null ? '' : 'pointer';
    this.restyle();
  }

  private onDown(event: PointerEvent) {
    this.touch();
    if (event.button !== 0) return;
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
      const rect = this.ctx.gl.domElement.getBoundingClientRect();
      this.ndc.set(((event.clientX - rect.left) / rect.width) * 2 - 1, -((event.clientY - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(this.ndc, this.ctx.camera);
      const hit = this.raycaster.ray.intersectPlane(drag.plane, new Vector3());
      if (!hit) return;
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

  private onUp(event: PointerEvent) {
    const drag = this.drag;
    if (!drag || event.pointerId !== drag.pointer) return;
    if (this.ctx.gl.domElement.hasPointerCapture(event.pointerId)) this.ctx.gl.domElement.releasePointerCapture(event.pointerId);
    this.drag = null;
    if (this.controls) this.controls.enabled = true;
    if (drag.moved) {
      this.sim?.send(command({ type: 'release', index: drag.index }));
      this.sim?.send(command({ type: 'reheat', alpha: SIM_REHEAT_ALPHA / 3 }));
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
    const positions = lines.geometry.attributes.position!.array as Float32Array;
    const edges = buffers.graph.edges;
    for (let e = 0; e < edges.length; e++) {
      const from = edges[e]! * 3;
      positions[e * 3] = display[from]!; positions[e * 3 + 1] = display[from + 1]!; positions[e * 3 + 2] = display[from + 2]!;
    }
    lines.geometry.attributes.position!.needsUpdate = true;
  }

  /** One rendered frame (before three renders it). */
  frame(size: { width: number; height: number }, delta: number, time: number) {
    const buffers = this.buffers, options = this.options;
    if (!buffers || !options) return;
    const { camera, invalidate, gl, scene } = this.ctx;
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
    uniforms.uScale!.value = (size.height * pixelRatio * 0.5) / Math.tan(fovRad / 2);
    uniforms.uMaxSize!.value = 220 * pixelRatio * tier.haloScale;
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
      span.hidden = false;
      span.style.transform = `translate(${((p.x + 1) / 2) * size.width}px, ${((1 - p.y) / 2) * size.height}px) translate(-50%, 10px)`;
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
