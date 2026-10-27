import { describe, expect, it, vi } from 'vitest';
import { Group, OrthographicCamera, PerspectiveCamera } from 'three';
import { MIN_ANIMATED_SCREEN_HEIGHT, projectedPanelHeight, setScreenView, shouldAnimateScreen } from '../src/office/scene/interior/prefabs/screens/screenView';
import { ScreenTextureCache } from '../src/office/scene/interior/prefabs/screens/screenTextureCache';

function overview() {
  const camera = new OrthographicCamera(-600, 600, 400, -400, .1, 500);
  camera.position.z = 10;
  const group = new Group();
  const zoom = (value: number) => {
    camera.zoom = value; camera.updateProjectionMatrix(); camera.updateMatrixWorld(true);
    setScreenView(camera, 800); group.updateMatrixWorld(true);
  };
  zoom(9);
  return { camera, group, zoom };
}

describe('screen live-paint size budget', () => {
  it('keeps tiny overview pictures static and resumes at the useful projected pixel size', () => {
    const h = overview();
    expect(projectedPanelHeight(h.group, .4)).toBeCloseTo(3.6);
    expect(shouldAnimateScreen(h.group, .4)).toBe(false);
    h.zoom(45);
    expect(projectedPanelHeight(h.group, .4)).toBeCloseTo(MIN_ANIMATED_SCREEN_HEIGHT);
    expect(shouldAnimateScreen(h.group, .4)).toBe(true);
    h.zoom(60); expect(shouldAnimateScreen(h.group, .4)).toBe(true);
    h.zoom(9); expect(shouldAnimateScreen(h.group, .4)).toBe(false);
  });

  it('retains ordinary visibility for light spill and excludes hidden floors or offscreen panels', () => {
    const h = overview(); const floor = new Group(); floor.add(h.group);
    expect(projectedPanelHeight(h.group, .4)).toBeGreaterThan(0);
    expect(shouldAnimateScreen(h.group, .4)).toBe(false);
    h.zoom(60); floor.visible = false;
    expect(shouldAnimateScreen(h.group, .4)).toBe(false);
    floor.visible = true; h.group.position.x = 2000; h.group.updateMatrixWorld(true);
    expect(shouldAnimateScreen(h.group, .4)).toBe(false);
    h.group.position.x = 0; h.group.scale.y = .25; h.group.updateMatrixWorld(true);
    expect(shouldAnimateScreen(h.group, .4)).toBe(false);
  });

  it('uses the same projected-size boundary for perspective camera movement', () => {
    const camera = new PerspectiveCamera(50, 1.5, .1, 500); const panel = new Group();
    camera.position.z = 40; camera.updateMatrixWorld(true); setScreenView(camera, 800);
    expect(shouldAnimateScreen(panel, .4)).toBe(false);
    camera.position.z = 3; camera.updateMatrixWorld(true);
    expect(shouldAnimateScreen(panel, .4)).toBe(true);
    panel.position.z = 5; panel.updateMatrixWorld(true);
    expect(shouldAnimateScreen(panel, .4)).toBe(false);
  });

  it('paints initial and changed content at overview size, retains photometry, and resumes animation after zoom', () => {
    const h = overview(); let time = 0;
    const paint = vi.fn((surface: { frame: number }, _spec: unknown, _now: number, frame: number) => { surface.frame = frame; });
    const cache = new ScreenTextureCache({ create: () => ({ frame: -1 }), paint, dispose: vi.fn() }, { clock: () => time });
    const first = cache.obtain({ key: 'working', liveMs: 500 });
    const onPaint = vi.fn();
    const stop = cache.retain('working', { isVisible: () => shouldAnimateScreen(h.group, .4), onPaint });
    expect(paint).toHaveBeenCalledOnce(); expect(onPaint).toHaveBeenCalledWith(first);
    time = 1000; expect(cache.tick()).toBe(0); expect(paint).toHaveBeenCalledOnce();
    h.zoom(60); time = 1500; expect(cache.tick()).toBe(1); expect(first.frame).toBe(1);
    h.zoom(9); time = 2000; expect(cache.tick()).toBe(0);
    cache.obtain({ key: 'waiting', liveMs: 500 });
    expect(paint).toHaveBeenCalledTimes(3);
    stop(); cache.clear();
  });
});
