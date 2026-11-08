import { Color, CustomBlending, NormalBlending, PerspectiveCamera, Scene, Vector3, type ShaderMaterial, type InstancedMesh, type InterleavedBufferAttribute, type Points } from 'three';
import type { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultGraphRenderer, type GraphOptions, type OrbitLike } from '../src/knowledge/vault/vaultGraphRenderer';
import { encodeFrame, type SimCommand } from '../src/knowledge/vault/simProtocol';
import { GRAPH_PRESETS } from '../src/knowledge/vault/graphAppearance';
import { prepareVaultGraph } from '../src/knowledge/vault/vaultGraphModel';
import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';

class FakeCanvas extends EventTarget {
  style: Record<string, string> = {};
  clientWidth = 100;
  clientHeight = 100;
  captured = new Set<number>();
  setPointerCapture = vi.fn((id: number) => this.captured.add(id));
  releasePointerCapture = vi.fn((id: number) => this.captured.delete(id));
  hasPointerCapture = (id: number) => this.captured.has(id);
  getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 100, right: 100, bottom: 100, x: 0, y: 0, toJSON: () => ({}) });
}

class FakeWorker {
  static all: FakeWorker[] = [];
  onmessage: ((event: MessageEvent) => void) | null = null;
  postMessage = vi.fn((message: SimCommand) => this.commands.push(message));
  terminate = vi.fn();
  commands: SimCommand[] = [];
  constructor() { FakeWorker.all.push(this); }
  frame(positions: number[], running = false) {
    this.onmessage?.({ data: encodeFrame(Float32Array.from(positions), running ? 0.2 : 0, running).message } as MessageEvent);
  }
}

function node(nodeId: string, title = nodeId): KnowledgeOverviewNode {
  return { nodeId, title, path: `${title}.md`, folder: 'Notes', tags: [], degree: 0, inDegree: 0, outDegree: 0, modifiedAt: '2026-10-01T00:00:00.000Z' };
}
function graph(names: string[] = ['a']) {
  const nodes = names.map(name => node(name));
  const overview: KnowledgeOverview = { generation: 1, totalNodes: nodes.length, totalEdges: 0, truncated: false, nodes, edges: [] };
  return prepareVaultGraph(overview);
}

function options(g = graph(), patch: Partial<GraphOptions> = {}): GraphOptions {
  return {
    graph: g, colours: g.nodes.map(() => '#7c9cff'), mask: new Uint8Array(g.nodes.length).fill(1), selected: null,
    highlight: null, activeResult: null, showLabels: true, showHalos: false, reducedMotion: false, showFps: false,
    returnToLayout: true, restoreRevision: 0, onSelect: vi.fn(), ...patch,
  };
}

function pointer(type: string, { x = 50, y = 50, id = 1, button = 0, buttons = type === 'pointerup' ? 0 : 1 } = {}) {
  const event = new Event(type);
  Object.assign(event, { pointerId: id, clientX: x, clientY: y, button, buttons });
  return event;
}

function harness(initial = options()) {
  FakeWorker.all = [];
  const canvas = new FakeCanvas();
  const documentTarget = Object.assign(new EventTarget(), {
    hidden: false,
    createElement: () => ({ width: 0, height: 0, getContext: () => ({
      createRadialGradient: () => ({ addColorStop: vi.fn() }), fillRect: vi.fn(), fillStyle: '',
    }) }),
  });
  vi.stubGlobal('document', documentTarget);
  vi.stubGlobal('Worker', FakeWorker);
  const scene = new Scene();
  const camera = new PerspectiveCamera(50, 1, 0.5, 20_000);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateProjectionMatrix();
  camera.updateMatrixWorld(true);
  const orbit: OrbitLike = { target: new Vector3(), enabled: true, update: vi.fn() };
  const invalidate = vi.fn();
  const renderer = new VaultGraphRenderer({
    scene, camera, gl: { domElement: canvas, getPixelRatio: () => 1, info: { render: { calls: 0 } } } as never,
    invalidate, labels: null, fps: null,
  });
  renderer.setControls(orbit);
  renderer.update(initial);
  const worker = FakeWorker.all[0]!;
  const drawFrame = (positions = initial.graph.nodes.flatMap(() => [0, 0, 0]), running = false) => {
    worker.frame(positions, running);
    renderer.frame({ width: 100, height: 100 }, 0, 0);
    scene.updateMatrixWorld(true);
    camera.updateMatrixWorld(true);
  };
  return { canvas, documentTarget, scene, camera, orbit, renderer, worker, drawFrame, initial };
}

afterEach(() => vi.unstubAllGlobals());

describe('vault graph renderer integration', () => {
  it('sends the initial interaction settings and only sends restore once per revision', () => {
    const h = harness(options(graph(), { reducedMotion: true }));
    expect(h.worker.commands.map(command => command.type)).toEqual(['init', 'interaction']);
    expect(h.worker.commands[1]).toEqual({ type: 'interaction', returnToLayout: true, reducedMotion: true });

    const changed = options(h.initial.graph, { returnToLayout: false, reducedMotion: false });
    h.renderer.update(changed);
    h.renderer.update({ ...changed });
    expect(h.worker.commands.filter(command => command.type === 'interaction')).toHaveLength(2);
    expect(h.worker.commands.at(-1)).toEqual({ type: 'interaction', returnToLayout: false, reducedMotion: false });

    h.renderer.update({ ...changed, restoreRevision: 1 });
    h.renderer.update({ ...changed, restoreRevision: 1 });
    expect(h.worker.commands.filter(command => command.type === 'restore')).toHaveLength(1);
    h.renderer.update({ ...changed, restoreRevision: 2 });
    expect(h.worker.commands.filter(command => command.type === 'restore')).toHaveLength(2);
    h.renderer.dispose();
  });

  it('applies real line width, visibility and glow controls without replacing the graph', () => {
    const g = graph(['a', 'b']);
    const h = harness(options(g, { showHalos: true }));
    h.drawFrame([0, 0, 0, 10, 0, 0]);
    const lines = h.scene.children.find(child => 'isLineSegments2' in child) as LineSegments2;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    h.renderer.update({ ...h.initial, appearance: { ...GRAPH_PRESETS.nebula, linkWidth: 2, showLinks: false, glow: 0 } });
    expect(lines.visible).toBe(false);
    expect(lines.material.linewidth).toBe(2);
    expect(Array.from(halos.geometry.attributes.aGlow!.array).every(value => value === 0)).toBe(true);
    expect(FakeWorker.all).toHaveLength(1);
    h.renderer.dispose();
  });

  it('switches projection on the same worker and applies explicit camera zoom', () => {
    const h = harness(); h.drawFrame();
    const distance = h.camera.position.distanceTo(h.orbit.target);
    h.renderer.update({ ...h.initial, cameraAction: { kind: 'in', revision: 1 } });
    expect(h.camera.position.distanceTo(h.orbit.target)).toBeCloseTo(distance * .75);
    h.renderer.update({ ...h.initial, dimensions: 2 });
    expect(h.worker.commands.at(-1)).toEqual({ type: 'dimensions', value: 2 });
    expect(FakeWorker.all).toHaveLength(1);
    h.renderer.dispose();
  });

  it('changes edge/halo compositing with the app theme on the same graph', () => {
    const h = harness(options(graph(['a', 'b']), { showHalos: true })); h.drawFrame([0, 0, 0, 10, 0, 0]);
    const lines = h.scene.children.find(child => 'isLineSegments2' in child) as LineSegments2;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    h.renderer.update({ ...h.initial, theme: { light: true, background: '#eef2f7' } });
    expect(lines.material.blending).toBe(NormalBlending);
    expect(lines.material.fog).toBe(false);
    expect((halos.material as ShaderMaterial).uniforms.uLight!.value).toBe(1);
    h.renderer.update({ ...h.initial, theme: { light: false, background: '#24262a' } });
    expect(lines.material.blending).toBe(NormalBlending);
    expect((halos.material as ShaderMaterial).blending).toBe(CustomBlending);
    expect(lines.material.fog).toBe(true);
    expect((halos.material as ShaderMaterial).uniforms.uLight!.value).toBe(0);
    expect(FakeWorker.all).toHaveLength(1);
    h.renderer.dispose();
  });

  it('keeps star geometry bounded, follows CSS viewport size and hides masked cores', () => {
    const h = harness(options(graph(['a', 'b']), { mask: Uint8Array.of(1, 0) }));
    h.drawFrame([0, 0, 0, 10, 0, 0]);
    const core = h.scene.children.find(child => 'isInstancedMesh' in child) as InstancedMesh;
    expect(core.geometry.attributes.position!.count).toBe(4);
    expect(core.geometry.index!.count).toBe(6);
    expect((core.material as ShaderMaterial).depthWrite).toBe(true);
    expect((core.material as ShaderMaterial).uniforms.uViewportHeight!.value).toBe(100);
    expect(core.instanceMatrix.array[16]).toBe(0);
    expect(h.scene.children).toHaveLength(3);
    h.renderer.dispose();
  });

  it('initializes replacement graph materials in the current light theme', () => {
    const h = harness(options(graph(), { theme: { light: true, background: '#eef2f7' }, showHalos: true }));
    h.renderer.update({ ...h.initial, graph: graph(['new']), mask: Uint8Array.of(1) });
    const core = h.scene.children.find(child => 'isInstancedMesh' in child) as InstancedMesh;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    expect((core.material as ShaderMaterial).uniforms.uLight!.value).toBe(1);
    expect((halos.material as ShaderMaterial).uniforms.uLight!.value).toBe(1);
    expect((halos.material as ShaderMaterial).blending).toBe(NormalBlending);
    h.renderer.dispose();
  });

  it('picks the front star when projected cores overlap and remains correct after orbiting', () => {
    const select = vi.fn();
    const h = harness(options(graph(['far', 'near']), { onSelect: select }));
    h.drawFrame([0, 0, 0, 0, 0, 2]);
    h.canvas.dispatchEvent(pointer('pointerdown')); h.canvas.dispatchEvent(pointer('pointerup'));
    expect(select).toHaveBeenLastCalledWith(1);
    h.camera.position.set(10, 0, 0); h.camera.lookAt(0, 0, 0); h.camera.updateMatrixWorld(true);
    h.drawFrame([0, 0, 0, 2, 0, 0]);
    h.canvas.dispatchEvent(pointer('pointerdown')); h.canvas.dispatchEvent(pointer('pointerup'));
    expect(select).toHaveBeenLastCalledWith(1);
    h.renderer.dispose();
  });

  it('provides the real WebGL fog uniforms for instanced star cores', () => {
    const h = harness();
    const core = h.scene.children.find(child => 'isInstancedMesh' in child) as InstancedMesh;
    const material = core.material as ShaderMaterial;
    expect(material.fog).toBe(true);
    for (const name of ['fogColor', 'fogNear', 'fogFar']) expect(material.uniforms[name]?.value).toBeDefined();
    h.renderer.update({ ...h.initial, theme: { light: true, background: '#eef2f7' } });
    expect(material.uniforms.uLight!.value).toBe(1);
    h.renderer.dispose();
  });

  for (const light of [false, true]) it(`keeps real edge colours readable and focus distinct in ${light ? 'light' : 'dark'} mode`, () => {
    const nodes = ['a', 'b', 'c', 'd'].map(name => node(name));
    const g = prepareVaultGraph({ generation: 1, totalNodes: 4, totalEdges: 2, truncated: false, nodes,
      edges: [{ source: 'a', target: 'b', type: 'links_to' }, { source: 'c', target: 'd', type: 'links_to' }] });
    const background = light ? '#eef2f7' : '#24262a';
    const h = harness(options(g, { theme: { light, background } }));
    h.drawFrame([0, 0, 0, 10, 0, 0, 20, 0, 0, 30, 0, 0]);
    const lines = h.scene.children.find(child => 'isLineSegments2' in child) as LineSegments2;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    const bg = new Color(background);
    const luminance = (rgb: readonly number[]) => .2126 * rgb[0]! + .7152 * rgb[1]! + .0722 * rgb[2]!;
    const contrast = (rgb: readonly number[]) => {
      const a = luminance(rgb), b = luminance([bg.r, bg.g, bg.b]);
      return (Math.max(a, b) + .05) / (Math.min(a, b) + .05);
    };
    const colours = () => Array.from((lines.geometry.attributes.instanceColorStart as InterleavedBufferAttribute).data.array as Float32Array);
    const baseline = contrast(colours().slice(0, 3));
    expect(baseline).toBeGreaterThan(light ? 1.9 : 2);
    h.renderer.update({ ...h.initial, selected: 0 });
    expect(contrast(colours().slice(0, 3))).toBeGreaterThan(baseline);
    expect(contrast(colours().slice(6, 9))).toBeLessThan(baseline);
    expect(Array.from(halos.geometry.attributes.aFocus!.array)).toEqual([1, 0, 0, 0]);
    // The selection cue survives disabling decorative glow.
    expect(Array.from(halos.geometry.attributes.aGlow!.array)).toEqual([0, 0, 0, 0]);
    h.renderer.update({ ...h.initial, selected: 0, mask: Uint8Array.of(0, 1, 1, 1) });
    expect(Array.from(halos.geometry.attributes.aFocus!.array)).toEqual([0, 0, 0, 0]);
    expect(FakeWorker.all).toHaveLength(1);
    h.renderer.dispose();
  });

  it('stops the actual pulse timer when idle and restarts it after interaction', () => {
    vi.useFakeTimers();
    const now = vi.spyOn(performance, 'now').mockReturnValue(0);
    const h = harness(options(graph(), { showHalos: true }));
    try {
      expect(vi.getTimerCount()).toBe(1);
      now.mockReturnValue(18_000); vi.advanceTimersByTime(34);
      expect(vi.getTimerCount()).toBe(0);
      h.canvas.dispatchEvent(new Event('wheel'));
      expect(vi.getTimerCount()).toBe(1);
      h.renderer.dispose(); expect(vi.getTimerCount()).toBe(0);
    } finally { h.renderer.dispose(); now.mockRestore(); vi.useRealTimers(); }
  });

  it('selects a click but treats pointer movement as a drag', () => {
    const select = vi.fn();
    const h = harness(options(graph(), { onSelect: select }));
    h.drawFrame();

    h.canvas.dispatchEvent(pointer('pointerdown'));
    h.canvas.dispatchEvent(pointer('pointerup'));
    expect(select).toHaveBeenCalledWith(0);
    expect(h.orbit.enabled).toBe(true);

    h.canvas.dispatchEvent(pointer('pointerdown', { id: 2 }));
    h.canvas.dispatchEvent(pointer('pointermove', { id: 2, x: 65, buttons: 1 }));
    h.canvas.dispatchEvent(pointer('pointerup', { id: 2, x: 65 }));
    expect(select).toHaveBeenCalledTimes(1);
    expect(h.worker.commands.some(command => command.type === 'drag')).toBe(true);
    expect(h.worker.commands.some(command => command.type === 'release')).toBe(true);
    expect(h.orbit.enabled).toBe(true);
    h.renderer.dispose();
  });

  it('does not turn cancelled or lost pointer capture into a note selection', () => {
    const select = vi.fn();
    const h = harness(options(graph(), { onSelect: select }));
    h.drawFrame();
    h.canvas.dispatchEvent(pointer('pointerdown', { id: 4 }));
    h.canvas.dispatchEvent(pointer('pointercancel', { id: 4 }));
    h.canvas.dispatchEvent(pointer('pointerdown', { id: 5 }));
    h.canvas.dispatchEvent(pointer('lostpointercapture', { id: 5 }));
    expect(select).not.toHaveBeenCalled();
    expect(h.orbit.enabled).toBe(true);
    h.renderer.dispose();
  });

  it('releases capture and re-enables orbit on filter, graph refresh, and hidden-document transitions', () => {
    const h = harness();
    h.drawFrame();
    h.canvas.dispatchEvent(pointer('pointerdown'));
    h.canvas.dispatchEvent(pointer('pointermove', { x: 65, buttons: 1 }));
    expect(h.orbit.enabled).toBe(false);

    h.renderer.update({ ...h.initial, mask: new Uint8Array([0]) });
    expect(h.canvas.hasPointerCapture(1)).toBe(false);
    expect(h.orbit.enabled).toBe(true);

    h.renderer.update(h.initial);
    h.canvas.dispatchEvent(pointer('pointerdown', { id: 2 }));
    const refreshed = options(graph(['a']));
    h.renderer.update(refreshed);
    expect(h.canvas.hasPointerCapture(2)).toBe(false);
    expect(h.orbit.enabled).toBe(true);
    expect(h.worker.terminate).toHaveBeenCalledOnce();

    h.renderer.dispose();

    const hidden = harness();
    hidden.drawFrame();
    hidden.canvas.dispatchEvent(pointer('pointerdown', { id: 3 }));
    hidden.canvas.dispatchEvent(pointer('pointermove', { id: 3, x: 65, buttons: 1 }));
    expect(hidden.worker.commands.some(command => command.type === 'drag')).toBe(true);
    Object.assign(hidden.documentTarget, { hidden: true });
    hidden.documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(hidden.canvas.hasPointerCapture(3)).toBe(false);
    expect(hidden.orbit.enabled).toBe(true);
    expect(hidden.worker.commands.slice(-2).map(command => command.type)).toEqual(['release', 'pause']);
    hidden.renderer.dispose();
  });

  it('disposes worker and scene objects, and snaps reduced-motion terminal frames', () => {
    const h = harness(options(graph(), { reducedMotion: true }));
    h.drawFrame();
    h.worker.frame([8, 4, -2], false);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0);
    const core = h.scene.children.find(child => 'instanceMatrix' in child) as InstancedMesh;
    const matrix = core.instanceMatrix.array as Float32Array;
    expect(Array.from(matrix.slice(12, 15))).toEqual([8, 4, -2]);

    h.renderer.dispose();
    expect(h.worker.terminate).toHaveBeenCalledOnce();
    expect(h.scene.children).toHaveLength(0);
    h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(h.worker.postMessage).not.toHaveBeenCalledWith({ type: 'resume' });
  });

  it('keeps a dragged node in place when a stale terminal frame arrives in reduced motion', () => {
    const h = harness(options(graph(), { reducedMotion: true }));
    h.drawFrame();
    h.canvas.dispatchEvent(pointer('pointerdown', { id: 6 }));
    h.canvas.dispatchEvent(pointer('pointermove', { id: 6, x: 65, buttons: 1 }));
    h.renderer.frame({ width: 100, height: 100 }, 0, 0);
    const core = h.scene.children.find(child => 'instanceMatrix' in child) as InstancedMesh;
    const draggedPosition = Array.from((core.instanceMatrix.array as Float32Array).slice(12, 15));
    expect(draggedPosition).not.toEqual([0, 0, 0]);

    h.worker.frame([0, 0, 0], false);
    h.renderer.frame({ width: 100, height: 100 }, 0, 0);
    const afterStaleFrame = Array.from((core.instanceMatrix.array as Float32Array).slice(12, 15));
    expect(afterStaleFrame).toEqual(draggedPosition);
    h.renderer.dispose();
  });

  it('does not fly to a selected or active search target hidden by the time mask', () => {
    const g = graph(['a', 'b']);
    const h = harness(options(g));
    h.drawFrame();
    const cameraBefore = h.camera.position.clone();
    const targetBefore = h.orbit.target.clone();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);

    h.renderer.update(options(g, { showHalos: true, mask: new Uint8Array([0, 1]), selected: 0, activeResult: 0 }));
    clock.mockReturnValue(2000);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 1);

    expect(h.camera.position.toArray()).toEqual(cameraBefore.toArray());
    expect(h.orbit.target.toArray()).toEqual(targetBefore.toArray());
    clock.mockRestore();
    h.renderer.dispose();
  });

  it('cancels an in-progress flight and preserves the camera when the mask shrinks or clears', () => {
    const g = graph(['a', 'b']);
    const h = harness(options(g));
    h.drawFrame();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    h.renderer.update(options(g, { selected: 0 }));
    clock.mockReturnValue(1350);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0.35);
    const midFlightCamera = h.camera.position.clone();
    const midFlightTarget = h.orbit.target.clone();

    h.renderer.update(options(g, { selected: 0, mask: new Uint8Array([0, 1]) }));
    clock.mockReturnValue(2000);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 1);
    expect(h.camera.position.toArray()).toEqual(midFlightCamera.toArray());
    expect(h.orbit.target.toArray()).toEqual(midFlightTarget.toArray());

    h.renderer.update(options(g, { selected: 0, mask: new Uint8Array([1, 1]) }));
    clock.mockReturnValue(3000);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 2);
    expect(h.camera.position.toArray()).toEqual(midFlightCamera.toArray());
    expect(h.orbit.target.toArray()).toEqual(midFlightTarget.toArray());
    clock.mockRestore();
    h.renderer.dispose();
  });

  it('cancels an in-progress flight when a graph refresh reorders and removes its target', () => {
    const g = graph(['a', 'b', 'c']);
    const h = harness(options(g));
    h.drawFrame();
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    h.renderer.update(options(g, { selected: 0 }));
    clock.mockReturnValue(1300);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0.3);
    const midFlightCamera = h.camera.position.clone();
    const midFlightTarget = h.orbit.target.clone();

    const refreshed = graph(['c', 'b']);
    h.renderer.update(options(refreshed));
    const refreshedWorker = FakeWorker.all.at(-1)!;
    refreshedWorker.frame([30, 0, 0, 60, 0, 0]);
    clock.mockReturnValue(2000);
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 1);

    expect(h.camera.position.toArray()).toEqual(midFlightCamera.toArray());
    expect(h.orbit.target.toArray()).toEqual(midFlightTarget.toArray());
    clock.mockRestore();
    h.renderer.dispose();
  });

  it('collapses hidden edge geometry and halos, then restores them when unmasked', () => {
    const nodes = [node('a'), node('b')];
    const overview: KnowledgeOverview = {
      generation: 1, totalNodes: 2, totalEdges: 1, truncated: false, nodes,
      edges: [{ source: 'a', target: 'b', type: 'links_to' }],
    };
    const g = prepareVaultGraph(overview);
    const h = harness(options(g, { showHalos: true }));
    h.drawFrame([0, 0, 0, 10, 0, 0]);
    const lines = h.scene.children.find(child => child instanceof Object && 'isLineSegments2' in child) as LineSegments2;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    const linePositions = () => Array.from((lines.geometry.attributes.instanceStart as InterleavedBufferAttribute).data.array as Float32Array);
    const haloGlow = () => Array.from(halos.geometry.attributes.aGlow!.array as Float32Array);
    expect(linePositions()).toEqual([0, 0, 0, 10, 0, 0]);

    h.renderer.update(options(g, { showHalos: true, mask: Uint8Array.from([1, 0]) }));
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0);
    expect(linePositions()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(haloGlow()[1]).toBe(0);

    h.renderer.update(options(g, { showHalos: true, mask: new Uint8Array([1, 1]) }));
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0.016);
    expect(linePositions()).toEqual([0, 0, 0, 10, 0, 0]);
    expect(haloGlow()[1]).toBeGreaterThan(0);
    h.renderer.dispose();
  });
});

function exploreGraph() {
  return prepareVaultGraph({ generation: 1, totalNodes: 3, totalEdges: 2, truncated: false,
    nodes: ['a', 'b', 'c'].map(id => node(id)),
    edges: [{ source: 'a', target: 'b', type: 'links_to' }, { source: 'b', target: 'c', type: 'links_to' }] });
}

describe('Explore camera and renderer lifecycle', () => {
  afterEach(() => vi.restoreAllMocks());

  it('freezes physics, ignores stale worker frames and stays paused across visibility changes until exit', () => {
    const g = exploreGraph();
    const h = harness(options(g, { reducedMotion: true }));
    h.drawFrame([0, 0, 0, 20, 0, 0, 40, 0, 0]);
    h.renderer.update({ ...h.initial, explore: { current: 0, revision: 1 } });
    h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    const core = h.scene.children.find(child => 'isInstancedMesh' in child) as InstancedMesh;
    const frozen = Array.from(core.instanceMatrix.array);
    h.worker.frame([100, 0, 0, 120, 0, 0, 140, 0, 0], true);
    h.renderer.frame({ width: 100, height: 100 }, .016, 2);
    expect(Array.from(core.instanceMatrix.array)).toEqual(frozen);
    h.documentTarget.hidden = true; h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    h.documentTarget.hidden = false; h.documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(h.worker.commands.at(-1)).toEqual({ type: 'pause' });
    h.renderer.update({ ...h.initial, explore: null });
    expect(h.worker.commands.at(-1)).toEqual({ type: 'resume' });
    h.renderer.dispose();
  });

  it('defers entry until positions arrive, then preserves hop distance despite note selection/search changes', () => {
    const g = exploreGraph();
    const initial = options(g, { reducedMotion: true, explore: { current: 0, revision: 1 } });
    const h = harness(initial);
    h.drawFrame([5, 2, 0, 25, 3, 4, 45, 0, 0]);
    expect(h.orbit.target.toArray()).toEqual([5, 2, 0]);
    const offset = h.camera.position.clone().sub(h.orbit.target);
    h.renderer.update({ ...initial, explore: { current: 1, revision: 2 }, selected: 2, activeResult: 2 });
    h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    expect(h.orbit.target.toArray()).toEqual([25, 3, 4]);
    expect(h.camera.position.clone().sub(h.orbit.target).toArray()).toEqual(offset.toArray());
    h.renderer.dispose();
  });

  it('cancels a flight on user takeover and filtered anchors without later delayed motion', () => {
    const g = exploreGraph();
    const h = harness(options(g)); h.drawFrame([0, 0, 0, 20, 0, 0, 40, 0, 0]);
    const clock = vi.spyOn(performance, 'now').mockReturnValue(1000);
    h.renderer.update({ ...h.initial, explore: { current: 1, revision: 1 } });
    clock.mockReturnValue(1250); h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    h.renderer.userStart();
    const position = h.camera.position.clone(), target = h.orbit.target.clone();
    clock.mockReturnValue(2000); h.renderer.frame({ width: 100, height: 100 }, .016, 2);
    expect(h.camera.position.toArray()).toEqual(position.toArray());
    h.renderer.update({ ...h.initial, mask: Uint8Array.of(1, 0, 1), explore: { current: null, revision: 1 } });
    h.renderer.frame({ width: 100, height: 100 }, .016, 3);
    expect(h.camera.position.toArray()).toEqual(position.toArray());
    expect(h.orbit.target.toArray()).toEqual(target.toArray());
    h.renderer.dispose();
  });

  it('gives a frozen flat layout deterministic depth when entering 3D and supports Fit during a tour', () => {
    const g = exploreGraph();
    const h = harness(options(g, { dimensions: 2, reducedMotion: true }));
    h.drawFrame([0, 0, 0, 50, 0, 0, 100, 0, 0]);
    const exploring = { ...h.initial, dimensions: 3 as const, explore: { current: 0, revision: 1 } };
    h.renderer.update(exploring); h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    const core = h.scene.children.find(child => 'isInstancedMesh' in child) as InstancedMesh;
    expect([14, 30, 46].some(at => core.instanceMatrix.array[at] !== 0)).toBe(true);
    h.camera.position.copy(h.orbit.target).add(new Vector3(0, 0, 6));
    h.renderer.update({ ...exploring, cameraAction: { kind: 'fit', revision: 1 } });
    h.renderer.frame({ width: 100, height: 100 }, .016, 2);
    expect(h.camera.position.distanceTo(h.orbit.target)).toBeGreaterThan(100);
    h.renderer.dispose();
  });

  it('releases an in-progress moved node before pausing, and blocks note dragging during Explore', () => {
    const h = harness(options(exploreGraph(), { reducedMotion: true }));
    h.drawFrame([0, 0, 0, 2, 0, 0, 4, 0, 0]);
    h.canvas.dispatchEvent(pointer('pointerdown'));
    h.canvas.dispatchEvent(pointer('pointermove', { x: 80 }));
    expect(h.worker.commands.some(item => item.type === 'drag')).toBe(true);
    h.renderer.update({ ...h.initial, explore: { current: 0, revision: 1 } });
    const release = h.worker.commands.findIndex(item => item.type === 'release');
    const pause = h.worker.commands.findIndex(item => item.type === 'pause');
    expect(release).toBeGreaterThan(-1); expect(release).toBeLessThan(pause);
    h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    const count = h.worker.commands.filter(item => item.type === 'drag').length;
    h.canvas.dispatchEvent(pointer('pointerdown'));
    h.canvas.dispatchEvent(pointer('pointermove', { x: 90 }));
    h.canvas.dispatchEvent(pointer('pointerup', { x: 90 }));
    expect(h.worker.commands.filter(item => item.type === 'drag')).toHaveLength(count);
    h.renderer.dispose();
  });

  it('allows pointer travel only to actual neighbors while unrelated nodes remain a dim backdrop', () => {
    const g = exploreGraph(); const select = vi.fn();
    const h = harness(options(g, { reducedMotion: true, onSelect: select }));
    h.drawFrame([-2, 0, 0, 0, 0, 0, 2, 0, 0]);
    h.renderer.update({ ...h.initial, explore: { current: 0, revision: 1 } });
    h.renderer.frame({ width: 100, height: 100 }, .016, 1);
    h.camera.lookAt(h.orbit.target); h.camera.updateMatrixWorld(true);
    const click = (x: number) => {
      const p = new Vector3(x, 0, 0).project(h.camera);
      const at = (p.x + 1) * 50;
      h.canvas.dispatchEvent(pointer('pointerdown', { x: at }));
      h.canvas.dispatchEvent(pointer('pointerup', { x: at }));
    };
    click(2); expect(select).not.toHaveBeenCalled();
    click(0); expect(select).toHaveBeenCalledWith(1);
    h.renderer.dispose();
  });
});
