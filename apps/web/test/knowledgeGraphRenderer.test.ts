import { PerspectiveCamera, Scene, Vector3, type InstancedMesh, type LineSegments, type Points } from 'three';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { VaultGraphRenderer, type GraphOptions, type OrbitLike } from '../src/knowledge/vault/vaultGraphRenderer';
import { encodeFrame, type SimCommand } from '../src/knowledge/vault/simProtocol';
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

    h.renderer.update(options(g, { mask: new Uint8Array([0, 1]), selected: 0, activeResult: 0 }));
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
    const h = harness(options(g));
    h.drawFrame([0, 0, 0, 10, 0, 0]);
    const lines = h.scene.children.find(child => child instanceof Object && 'isLineSegments' in child) as LineSegments;
    const halos = h.scene.children.find(child => 'isPoints' in child) as Points;
    const linePositions = () => Array.from(lines.geometry.attributes.position!.array as Float32Array);
    const haloGlow = () => Array.from(halos.geometry.attributes.aGlow!.array as Float32Array);
    expect(linePositions()).toEqual([0, 0, 0, 10, 0, 0]);

    h.renderer.update(options(g, { mask: Uint8Array.from([1, 0]) }));
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0);
    expect(linePositions()).toEqual([0, 0, 0, 0, 0, 0]);
    expect(haloGlow()[1]).toBe(0);

    h.renderer.update(options(g, { mask: new Uint8Array([1, 1]) }));
    h.renderer.frame({ width: 100, height: 100 }, 0.016, 0.016);
    expect(linePositions()).toEqual([0, 0, 0, 10, 0, 0]);
    expect(haloGlow()[1]).toBeGreaterThan(0);
    h.renderer.dispose();
  });
});
