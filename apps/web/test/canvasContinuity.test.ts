import { describe, expect, it, vi } from 'vitest';
import type { RootStore } from '@react-three/fiber';
import { subscribeCanvasContinuity } from '../src/office/scene/environment/CanvasContinuity';

function resizeHarness() {
  const canvas = { width: 1000, height: 600 };
  const listeners = new Set<() => void>();
  const context = { isContextLost: vi.fn(() => false) };
  const render = vi.fn();
  const advance = vi.fn();
  const state = { gl: { domElement: canvas, getContext: () => context, render },
    scene: {}, camera: { width: 1000, height: 600 }, size: { width: 1000, height: 600 },
    viewport: { dpr: 1 }, internal: { active: true }, advance };
  const notify = () => { for (const listener of listeners) listener(); };
  const store = { getState: () => state, subscribe: (listener: () => void) => {
    listeners.add(listener); return () => { listeners.delete(listener); };
  } } as unknown as RootStore;
  // Installed before the child, like R3F's root-store resize subscription.
  let requested = { width: 1000, height: 600, dpr: 1 };
  let applied = requested;
  listeners.add(() => {
    if (requested === applied) return;
    applied = requested;
    state.camera.width = requested.width;
    state.camera.height = requested.height;
    canvas.width = Math.floor(requested.width * requested.dpr);
    canvas.height = Math.floor(requested.height * requested.dpr);
  });
  const resize = (width: number, height: number, dpr: number) => {
    state.size = { width, height };
    state.viewport.dpr = dpr;
    requested = { width, height, dpr }; notify();
  };
  return { state, canvas, context, render, advance, notify, store, resize };
}

describe('Office drawing-buffer continuity', () => {
  it('restores a DPR-cleared buffer synchronously without advancing animation', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    const drawn: number[][] = [];
    h.render.mockImplementation((scene, camera) => {
      expect(scene).toBe(h.state.scene);
      expect(camera).toBe(h.state.camera);
      drawn.push([h.canvas.width, h.canvas.height, camera.width, camera.height]);
    });
    h.resize(1000, 600, .7);
    expect(drawn).toEqual([[700, 420, 1000, 600]]);
    expect(h.advance).not.toHaveBeenCalled();
    h.notify();
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('draws with the updated camera after a container resize and handles both quality directions', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    const dimensions: number[][] = [];
    h.render.mockImplementation((_scene, camera) => {
      dimensions.push([h.canvas.width, h.canvas.height, camera.width, camera.height]);
    });
    h.resize(800, 500, 1.25);
    h.resize(800, 500, .85);
    h.resize(1200, 700, 1.25);
    expect(dimensions).toEqual([[1000, 625, 800, 500], [680, 425, 800, 500], [1500, 875, 1200, 700]]);
  });

  it('ignores ordinary state updates and unsubscribes without drawing', () => {
    const h = resizeHarness();
    const stop = subscribeCanvasContinuity(h.store);
    h.notify(); h.notify();
    expect(h.render).not.toHaveBeenCalled();
    stop();
    h.resize(900, 600, 1);
    expect(h.render).not.toHaveBeenCalled();
  });

  it('restores a fractional layout resize even when backing dimensions round to the same pixels', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    h.resize(1000.2, 600.2, 1);
    expect(h.canvas).toEqual({ width: 1000, height: 600 });
    expect(h.render).toHaveBeenCalledTimes(1);
    h.notify();
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('restores a DPR resize even when backing dimensions round to the same pixels', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    h.resize(1000, 600, 1.0001);
    expect(h.canvas).toEqual({ width: 1000, height: 600 });
    expect(h.render).toHaveBeenCalledTimes(1);
    h.notify();
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('does not render an inactive, empty or lost canvas', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    h.state.internal.active = false;
    h.resize(800, 500, 1);
    h.state.internal.active = true;
    h.resize(0, 0, 1);
    h.context.isContextLost.mockReturnValue(true);
    h.resize(900, 600, 1);
    expect(h.render).not.toHaveBeenCalled();
    h.context.isContextLost.mockReturnValue(false);
    h.resize(1000, 700, 1);
    expect(h.render).toHaveBeenCalledTimes(1);
  });

  it('does not recursively redraw when a render callback notifies the store', () => {
    const h = resizeHarness();
    subscribeCanvasContinuity(h.store);
    h.render.mockImplementation(h.notify);
    h.resize(800, 500, 1);
    expect(h.render).toHaveBeenCalledTimes(1);
  });
});
