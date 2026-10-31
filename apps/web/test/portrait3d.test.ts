import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial } from 'three';
import { defaultCharacterAppearance, lookIdentity, lookSeed } from '../src/office/scene/avatars/appearance';
import { portraitSubject } from '../src/office/overlay/portrait3d/model';

const fiber = vi.hoisted(() => ({ createRoot: vi.fn(), configure: vi.fn(), render: vi.fn(), unmount: vi.fn(), advance: vi.fn() }));
vi.mock('@react-three/fiber', () => ({
  createRoot: fiber.createRoot,
  createPortal: vi.fn(),
  extend: vi.fn(),
  useFrame: vi.fn(),
}));
vi.mock('../src/office/scene/avatars/OfficeCharacter', () => ({ CharacterBody: () => null }));

describe('portrait appearance sharing', () => {
  it('uses the exact name seed and resolved appearance of the office body', () => {
    const identity = lookIdentity('Example Agent', 'female');
    const subject = portraitSubject({ characterId: 'presence-a', identity });
    expect(subject.id).toBe(lookSeed('presence-a', identity));
    expect(subject.appearance).toEqual(defaultCharacterAppearance(subject.id, 'feminine'));
  });

  it('shares one rendering for duplicate views, independent of saved field order', () => {
    const appearance = defaultCharacterAppearance('presence-a');
    const reordered = Object.fromEntries(Object.entries(appearance).reverse()) as typeof appearance;
    expect(portraitSubject({ characterId: 'presence-a', appearance }).key).toBe(portraitSubject({ characterId: 'presence-a', appearance: reordered }).key);
    expect(portraitSubject({ characterId: 'presence-b', appearance }).key).not.toBe(portraitSubject({ characterId: 'presence-a', appearance }).key);
  });

  it('invalidates an edited look while preserving the saved appearance', () => {
    const appearance = defaultCharacterAppearance('presence-a');
    const a = portraitSubject({ characterId: 'presence-a', appearance });
    const b = portraitSubject({ characterId: 'presence-a', appearance: { ...appearance, hairColor: '#abcdef' } });
    expect(a.appearance).toBe(appearance);
    expect(b.key).not.toBe(a.key);
  });
});

describe('shared portrait renderer lifecycle', () => {
  let documentTarget: EventTarget & { hidden: boolean; createElement: ReturnType<typeof vi.fn> };
  let sharedCanvas: HTMLCanvasElement;
  let motion: EventTarget & { matches: boolean };
  let frames: Map<number, FrameRequestCallback>;
  let releases: Array<() => void>;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    releases = [];
    frames = new Map();
    let nextFrame = 0;
    sharedCanvas = Object.assign(new EventTarget(), { width: 0, height: 0 }) as unknown as HTMLCanvasElement;
    motion = Object.assign(new EventTarget(), { matches: false });
    documentTarget = Object.assign(new EventTarget(), { hidden: false, createElement: vi.fn(() => sharedCanvas) });
    vi.stubGlobal('document', documentTarget);
    vi.stubGlobal('window', { matchMedia: () => motion });
    vi.stubGlobal('IntersectionObserver', class {});
    vi.stubGlobal('requestAnimationFrame', vi.fn((callback: FrameRequestCallback) => { frames.set(++nextFrame, callback); return nextFrame; }));
    vi.stubGlobal('cancelAnimationFrame', vi.fn((id: number) => frames.delete(id)));
    fiber.configure.mockResolvedValue(undefined);
    fiber.render.mockReturnValue({ getState: () => ({ advance: fiber.advance }) });
    fiber.createRoot.mockReturnValue({ configure: fiber.configure, render: fiber.render, unmount: fiber.unmount });
  });

  afterEach(() => {
    for (const release of releases) release();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function attach(characterId = 'presence-a') {
    const { attachPortrait } = await import('../src/office/overlay/portrait3d/renderer');
    const context = { drawImage: vi.fn(), clearRect: vi.fn() };
    const canvas = { getContext: vi.fn(() => context) } as unknown as HTMLCanvasElement;
    const report = vi.fn();
    const handle = attachPortrait(canvas, { characterId }, report);
    releases.push(handle.remove);
    return { handle, context, report, canvas };
  }

  async function show(handle: Awaited<ReturnType<typeof attach>>['handle']) {
    handle.setVisible(true);
    await Promise.resolve();
    await Promise.resolve();
  }

  function renderedEntries() {
    return fiber.render.mock.lastCall?.[0].props.entries as Array<{ targets: Set<unknown>; scene: { add: (mesh: Mesh) => void }; subject: { appearance?: unknown } }>;
  }

  function runFrame(time: number) {
    const [id, callback] = [...frames.entries()][0]!;
    frames.delete(id);
    callback(time);
  }

  function provideMesh() {
    const geometry = new BoxGeometry();
    const material = new MeshBasicMaterial();
    renderedEntries()[0]!.scene.add(new Mesh(geometry, material));
    releases.push(() => { geometry.dispose(); material.dispose(); });
    const gl = { setClearColor: vi.fn(), clear: vi.fn(), render: vi.fn(), domElement: sharedCanvas };
    fiber.advance.mockImplementation(() => {
      const { manager, entries } = fiber.render.mock.lastCall![0].props;
      manager.paint(gl, entries);
    });
    return gl;
  }

  it('creates no WebGL context for offscreen targets, then deduplicates visible views', async () => {
    const a = await attach();
    const b = await attach();
    expect(fiber.createRoot).not.toHaveBeenCalled();
    await show(a.handle);
    await show(b.handle);
    expect(fiber.createRoot).toHaveBeenCalledTimes(1);
    expect(documentTarget.createElement).toHaveBeenCalledTimes(1);
    expect(renderedEntries()).toHaveLength(1);
    expect(renderedEntries()[0]!.targets.size).toBe(2);
    const c = await attach('presence-b');
    await show(c.handle);
    expect(fiber.createRoot).toHaveBeenCalledTimes(1);
    expect(renderedEntries()).toHaveLength(2);
  });

  it('skips refreshes for equivalent subject references and refreshes changed visible subjects', async () => {
    const a = await attach();
    await show(a.handle);
    const original = { characterId: 'presence-a' };
    fiber.render.mockClear();
    a.handle.update({ ...original });
    expect(fiber.render).not.toHaveBeenCalled();

    const appearance = defaultCharacterAppearance('presence-a');
    a.handle.update({ ...original, appearance });
    expect(fiber.render).toHaveBeenCalledTimes(1);
    expect(renderedEntries()[0]!.subject.appearance).toBe(appearance);
  });

  it('stores hidden subject changes without rendering until the target becomes visible', async () => {
    const a = await attach();
    const appearance = defaultCharacterAppearance('presence-a');
    fiber.render.mockClear();
    a.handle.update({ characterId: 'presence-a', appearance });
    expect(fiber.render).not.toHaveBeenCalled();

    await show(a.handle);
    expect(fiber.render).toHaveBeenCalled();
    expect(renderedEntries()[0]!.subject.appearance).toBe(appearance);
  });

  it('unmounts invisible scenes, pauses a hidden document and releases the final context', async () => {
    const a = await attach();
    await show(a.handle);
    expect(frames.size).toBe(1);
    documentTarget.hidden = true;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(0);
    documentTarget.hidden = false;
    documentTarget.dispatchEvent(new Event('visibilitychange'));
    expect(frames.size).toBe(1);
    a.handle.setVisible(false);
    expect(renderedEntries()).toHaveLength(0);
    expect(frames.size).toBe(0);
    a.handle.remove();
    releases = [];
    vi.advanceTimersByTime(250);
    expect(fiber.unmount).toHaveBeenCalledTimes(1);
  });

  it('renders one scene then copies it to duplicate visible targets, keeping loading fallbacks until a mesh exists', async () => {
    const a = await attach();
    const b = await attach();
    await show(a.handle);
    await show(b.handle);
    runFrame(100);
    expect(a.report).not.toHaveBeenCalled();
    expect(b.report).not.toHaveBeenCalled();
    const gl = provideMesh();
    runFrame(200);
    expect(gl.render).toHaveBeenCalledTimes(1);
    expect(a.context.drawImage).toHaveBeenCalledTimes(1);
    expect(b.context.drawImage).toHaveBeenCalledTimes(1);
    expect(a.report).toHaveBeenCalledWith(true);
    expect(b.report).toHaveBeenCalledWith(true);
    const { getPortrait3DDiagnostics } = await import('../src/office/overlay/portrait3d/renderer');
    expect(getPortrait3DDiagnostics()).toMatchObject({ webglContexts: 1, subjects: 1, targets: 2, visibleScenes: 1, renderedScenes: 1, copiedFrames: 2 });
  });

  it('stops scheduling after a static reduced-motion portrait is ready', async () => {
    motion.matches = true;
    const a = await attach();
    await show(a.handle);
    provideMesh();
    runFrame(100);
    runFrame(200);
    runFrame(300);
    expect(a.report).toHaveBeenCalledWith(true);
    expect(frames.size).toBe(0);
    const { getPortrait3DDiagnostics } = await import('../src/office/overlay/portrait3d/renderer');
    expect(getPortrait3DDiagnostics()).toMatchObject({ reducedMotion: true, scheduled: false, advancedFrames: 3 });
  });

  it('reduces only small-target cadence while advancing actual pose time and refreshing a large or dirty view promptly', async () => {
    const a = await attach();
    Object.assign(a.canvas, { clientWidth: 44, clientHeight: 48 });
    await show(a.handle); provideMesh();
    runFrame(100);
    expect(fiber.advance).toHaveBeenCalledTimes(1);
    const first = fiber.advance.mock.lastCall![0] as number;
    runFrame(150);
    expect(fiber.advance).toHaveBeenCalledTimes(1);
    runFrame(216.6666666667);
    expect(fiber.advance).toHaveBeenCalledTimes(2);
    const second = fiber.advance.mock.lastCall![0] as number;
    expect(second - first).toBeCloseTo(.1166666667, 6);
    runFrame(283.3333333333);
    expect(fiber.advance).toHaveBeenCalledTimes(2);
    Object.assign(a.canvas, { clientWidth: 192, clientHeight: 224 });
    runFrame(300);
    expect(fiber.advance).toHaveBeenCalledTimes(3);
    const third = fiber.advance.mock.lastCall![0] as number;
    expect(third - second).toBeCloseTo(.0833333333, 6);
    a.handle.update({ characterId: 'presence-a', appearance: defaultCharacterAppearance('presence-a') });
    runFrame(310);
    expect(fiber.advance).toHaveBeenCalledTimes(4);
    expect((fiber.advance.mock.lastCall![0] as number) - third).toBeCloseTo(.01, 6);
  });

  it('preserves the supplied fallback when WebGL initialization rejects', async () => {
    fiber.configure.mockRejectedValueOnce(new Error('WebGL unavailable'));
    const a = await attach();
    await show(a.handle);
    expect(a.report).toHaveBeenCalledWith(false);
    expect(fiber.unmount).toHaveBeenCalledTimes(1);
    expect(frames.size).toBe(0);
  });

  it('falls back after a lost context without allocating replacement contexts', async () => {
    const a = await attach();
    await show(a.handle);
    sharedCanvas.dispatchEvent(new Event('webglcontextlost', { cancelable: true }));
    expect(a.report).toHaveBeenCalledWith(false);
    expect(frames.size).toBe(0);
    await show((await attach('presence-b')).handle);
    expect(fiber.createRoot).toHaveBeenCalledTimes(1);
  });
});
