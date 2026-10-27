import { describe, expect, it } from 'vitest';
import { ScreenTextureCache, type TextureConsumer, type TextureHost } from '../src/office/scene/interior/prefabs/screens/screenTextureCache';
import {
  buildSurfaceSpec, MIN_LIVE_INTERVAL_MS, resolveScreenContent, surfaceGeometry, type ScreenRequest,
} from '../src/office/scene/interior/prefabs/screens/screenContent';

interface Spec { key: string; liveMs: number }
interface Surface { id: number; paints: number[]; disposed: boolean }

function setup(options: ConstructorParameters<typeof ScreenTextureCache>[1] = {}) {
  let created = 0;
  const surfaces: Surface[] = [];
  const host: TextureHost<Surface, Spec> = {
    create: () => { const surface = { id: ++created, paints: [], disposed: false }; surfaces.push(surface); return surface; },
    paint: (surface, _spec, now) => { surface.paints.push(now); },
    dispose: surface => { surface.disposed = true; },
  };
  const cache = new ScreenTextureCache<Surface, Spec, TextureConsumer<Surface>>(host, { clock: () => 0, ...options });
  const consumer = (visible = true): TextureConsumer<Surface> & { painted: number } => {
    const value = { painted: 0, isVisible: () => visible, onPaint: () => { value.painted++; } };
    return value;
  };
  return { cache, surfaces, consumer };
}
const live = (key: string, liveMs = MIN_LIVE_INTERVAL_MS): Spec => ({ key, liveMs });

describe('screen texture cache', () => {
  it('shares one surface between screens with the same content key', () => {
    const { cache, surfaces } = setup();
    const a = cache.obtain(live('editor|a'), 0);
    const b = cache.obtain(live('editor|a'), 0);
    const c = cache.obtain(live('terminal|b'), 0);
    expect(a).toBe(b);
    expect(c).not.toBe(a);
    expect(surfaces).toHaveLength(2);
    expect(cache.stats().entries).toBe(2);
  });

  it('paints a static surface exactly once, however long it lives', () => {
    const { cache, surfaces, consumer } = setup();
    cache.obtain({ key: 'lock', liveMs: 0 }, 0);
    cache.retain('lock', consumer(), 0);
    for (let now = 0; now < 20_000; now += 16) cache.tick(now);
    expect(surfaces[0]!.paints).toEqual([0]);
  });

  it('repaints live content at most twice per second, even when asked for more', () => {
    const { cache, surfaces, consumer } = setup();
    cache.obtain(live('fast', 50), 0);
    cache.retain('fast', consumer(), 0);
    for (let now = 0; now <= 5000; now += 16) cache.tick(now);
    const paints = surfaces[0]!.paints;
    expect(paints.length).toBeLessThanOrEqual(11);
    expect(paints.length).toBeGreaterThan(8);
    for (let i = 1; i < paints.length; i++) expect(paints[i]! - paints[i - 1]!).toBeGreaterThanOrEqual(MIN_LIVE_INTERVAL_MS);
  });

  it('honours slower intervals such as a once-a-minute clock', () => {
    const { cache, surfaces, consumer } = setup();
    cache.obtain(live('clock', 15_000), 0);
    cache.retain('clock', consumer(), 0);
    for (let now = 0; now <= 31_000; now += 100) cache.tick(now);
    expect(surfaces[0]!.paints).toHaveLength(3);
  });

  it('only repaints surfaces that have a screen in view, and resumes when one appears', () => {
    const { cache, surfaces, consumer } = setup();
    let visible = false;
    cache.obtain(live('hidden'), 0);
    cache.retain('hidden', { isVisible: () => visible }, 0);
    for (let now = 0; now <= 2000; now += 16) cache.tick(now);
    expect(surfaces[0]!.paints).toEqual([0]);
    visible = true;
    for (let now = 2000; now <= 3000; now += 16) cache.tick(now);
    expect(surfaces[0]!.paints.length).toBeGreaterThan(1);
    expect(consumer().painted).toBe(0);
  });

  it('is unreferenced screens that cost nothing: surfaces nobody holds are never repainted', () => {
    const { cache, surfaces } = setup();
    cache.obtain(live('orphan'), 0);
    for (let now = 0; now <= 3000; now += 16) cache.tick(now);
    expect(surfaces[0]!.paints).toEqual([0]);
  });

  it('spreads a burst of due repaints over several frames', () => {
    const { cache, surfaces, consumer } = setup({ budgetPerTick: 2 });
    for (let i = 0; i < 10; i++) { cache.obtain(live(`k${i}`), 0); cache.retain(`k${i}`, consumer(), 0); }
    const perTick: number[] = [];
    for (let now = 500; now < 500 + 16 * 8; now += 16) perTick.push(cache.tick(now));
    expect(perTick.every(count => count <= 2)).toBe(true);
    expect(perTick.reduce((sum, count) => sum + count, 0)).toBe(10);
    expect(surfaces.every(surface => surface.paints.length === 2)).toBe(true);
  });

  it('tells every screen sharing a surface about each repaint', () => {
    const { cache, consumer } = setup();
    const a = consumer(), b = consumer();
    cache.obtain(live('shared'), 0);
    cache.retain('shared', a, 0);
    cache.retain('shared', b, 0);
    expect([a.painted, b.painted]).toEqual([1, 1]);
    cache.tick(MIN_LIVE_INTERVAL_MS);
    expect([a.painted, b.painted]).toEqual([2, 2]);
  });

  it('disposes a surface only after its last screen let go and a grace period passed', () => {
    const { cache, surfaces, consumer } = setup({ graceMs: 1000, clock: () => now });
    let now = 0;
    const first = consumer(), second = consumer();
    cache.obtain(live('k'), 0);
    const releaseFirst = cache.retain('k', first, 0);
    const releaseSecond = cache.retain('k', second, 0);
    releaseFirst();
    now = 5000;
    cache.tick(now);
    expect(surfaces[0]!.disposed).toBe(false);
    releaseSecond();
    now = 5500;
    cache.tick(now);
    expect(surfaces[0]!.disposed).toBe(false);
    // Re-obtaining within the grace period reuses the surface instead of rebuilding it.
    expect(cache.obtain(live('k'), now)).toBe(surfaces[0]);
    now = 6000;
    cache.tick(now);
    expect(surfaces[0]!.disposed).toBe(false);
    now = 6600;
    cache.tick(now);
    expect(surfaces[0]!.disposed).toBe(true);
    expect(cache.has('k')).toBe(false);
    cache.obtain(live('k'), now);
    expect(surfaces).toHaveLength(2);
  });

  it('keeps diagnostics: entry, live and paint counts', () => {
    const { cache, consumer } = setup();
    cache.obtain(live('a'), 0);
    cache.obtain({ key: 'b', liveMs: 0 }, 0);
    cache.retain('a', consumer(), 0);
    expect(cache.stats()).toMatchObject({ entries: 2, liveEntries: 1, referencedEntries: 1, consumers: 1, totalPaints: 2 });
    expect(cache.paintCounts()).toEqual({ a: 1, b: 1 });
    cache.clear();
    expect(cache.stats().entries).toBe(0);
  });
});

describe('screen texture cache with real content keys', () => {
  const surface = (request: Partial<ScreenRequest>, phase: number, w = 0.68, h = 0.4) =>
    buildSurfaceSpec(resolveScreenContent({ device: 'monitor', lightsOn: false, night: true, ...request }), surfaceGeometry(w, h), { language: 'en', phase });

  it('never collapses the displays of one desk, or a desk and its neighbour, into one surface', () => {
    const { cache, surfaces } = setup();
    const deskA = [surface({ slot: 1, slots: 2 }, 0), surface({ slot: 2, slots: 2 }, 0)];
    const deskB = [surface({ slot: 1, slots: 2 }, 1), surface({ slot: 2, slots: 2 }, 1)];
    const laptopDesk = [surface({ slot: 1, slots: 2 }, 2, 0.62, 0.37), surface({ device: 'laptop', slot: 2, slots: 2 }, 2, 0.48, 0.29)];
    for (const spec of [...deskA, ...deskB, ...laptopDesk]) cache.obtain(spec);
    expect(surfaces).toHaveLength(6);
    // Identical seats still share: a second desk with the same phase reuses desk A's two surfaces.
    for (const spec of [surface({ slot: 1, slots: 2 }, 0), surface({ slot: 2, slots: 2 }, 0)]) cache.obtain(spec);
    expect(surfaces).toHaveLength(6);
  });
});
