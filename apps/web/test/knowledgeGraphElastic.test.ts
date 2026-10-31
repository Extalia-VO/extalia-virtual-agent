import { describe, expect, it } from 'vitest';
import { createSimCore } from '../src/knowledge/vault/simCore';
import { decodeCommand, decodeFrame, encodeInit, SIM_ALPHA_MIN, type SimFrame } from '../src/knowledge/vault/simProtocol';

function harness(stalledClock = false) {
  const frames: SimFrame[] = [];
  const queue: (() => void)[] = [];
  let clock = 0;
  const core = createSimCore({
    // Match worker ownership: the posted buffer is immediately detached from the sender.
    post: ({ message, transfer }) => frames.push(structuredClone(message, { transfer })),
    schedule: run => queue.push(run),
    now: () => stalledClock ? clock : (clock += 0.5),
  });
  const step = (count = 1) => {
    for (let i = 0; i < count && queue.length; i++) {
      if (!stalledClock) clock += 16;
      queue.shift()!();
    }
  };
  const settle = () => {
    let slices = 0;
    while (queue.length && slices++ < 1_000) step();
    expect(queue).toHaveLength(0);
    expect(core.running).toBe(false);
    expect(frames.at(-1)?.running).toBe(false);
    expect(frames.at(-1)?.positions.every(Number.isFinite)).toBe(true);
  };
  const init = (count = 4) => core.handle(encodeInit(count,
    count === 4 ? Uint32Array.from([0, 1, 1, 2, 2, 3]) : new Uint32Array(),
    count === 4 ? Uint32Array.from([1, 2, 2, 1]) : new Uint32Array(count),
  ).message);
  const positions = () => Array.from(frames.at(-1)!.positions);
  init();
  settle();
  return { core, frames, queue, step, settle, init, positions, advance: (ms: number) => { clock += ms; } };
}

const drag = (index = 0, x = 160) => ({ type: 'drag' as const, index, x, y: 80, z: -70 });

describe('vault graph elastic interaction', () => {
  it('lets linked neighbours react, then returns every coordinate exactly and stops', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle(drag());
    h.step(3);
    expect(h.positions().slice(0, 3)).toEqual([160, 80, -70]);
    expect(h.positions().slice(3)).not.toEqual(original.slice(3));
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    expect(h.core.running).toBe(true);
    expect(h.positions()).not.toEqual(original);
    h.settle();
    expect(h.positions()).toEqual(original);
    expect(h.core.alpha).toBe(0);
    const posted = h.frames.length;
    h.step(10);
    expect(h.frames).toHaveLength(posted);
  });

  it('settles in free mode and explicitly restores the snapshot before the latest gesture', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle({ type: 'interaction', returnToLayout: false });
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.settle();
    expect(h.core.alpha).toBeLessThan(SIM_ALPHA_MIN);
    const freeLayout = h.positions();
    expect(freeLayout).not.toEqual(original);
    h.core.handle(drag(2, -120));
    h.step(3);
    h.core.handle({ type: 'release', index: 2 });
    h.settle();
    h.core.handle({ type: 'restore' });
    h.settle();
    expect(h.positions()).toEqual(freeLayout);
  });

  it('lets a return already in progress settle freely when return mode is disabled', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.step(3);
    h.core.handle({ type: 'interaction', returnToLayout: false });
    h.settle();
    expect(h.positions()).not.toEqual(original);
    expect(h.core.alpha).toBeLessThan(SIM_ALPHA_MIN);
    h.core.handle({ type: 'restore' });
    h.settle();
    expect(h.positions()).toEqual(original);
  });

  it('preserves the original snapshot across repeated drags and interrupted returns', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle(drag());
    h.step(3);
    h.core.handle(drag(0, 210));
    h.step(2);
    h.core.handle({ type: 'release', index: 0 });
    h.step(3);
    h.core.handle(drag(1, -180));
    h.step(3);
    // An old pointer-up must not release the current drag.
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    expect(h.positions().slice(3, 6)).toEqual([-180, 80, -70]);
    h.core.handle({ type: 'release', index: 1 });
    h.step(2);
    h.core.handle(drag(3, 110));
    h.step(2);
    h.core.handle({ type: 'release', index: 3 });
    h.settle();
    expect(h.positions()).toEqual(original);
  });

  it('cancels return and clears old pins and snapshots when filtering or reinitializing', () => {
    const h = harness();
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'mask', active: Uint8Array.from([0, 1, 1, 1]) });
    h.settle();
    const filtered = h.positions();
    h.core.handle({ type: 'restore' });
    expect(h.core.running).toBe(false);
    h.core.handle(drag(0)); // Hidden nodes cannot capture a new snapshot.
    h.core.handle(drag(99));
    h.core.handle({ type: 'restore' });
    expect(h.queue).toHaveLength(0);
    expect(h.positions()).toEqual(filtered);
    h.core.handle({ type: 'mask', active: new Uint8Array(4).fill(1) });
    h.settle();
    expect(h.positions().slice(0, 3)).not.toEqual([160, 80, -70]);
    h.core.handle(drag());
    h.step(2);
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    h.init(2);
    h.settle();
    expect(h.positions()).toHaveLength(6);
    const replacement = h.positions();
    h.core.handle({ type: 'restore' });
    expect(h.queue).toHaveLength(0);
    expect(h.positions()).toEqual(replacement);
  });

  it('clears a return snapshot on mask changes, even when node count stays the same', () => {
    const h = harness();
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    h.core.handle({ type: 'mask', active: new Uint8Array(4).fill(1) });
    h.settle();
    h.core.handle({ type: 'restore' });
    expect(h.queue).toHaveLength(0);
    expect(h.core.alpha).toBeLessThan(SIM_ALPHA_MIN);
  });

  it('pauses return progress and resumes without including elapsed background time', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    h.core.handle({ type: 'pause' });
    h.step();
    expect(h.queue).toHaveLength(0);
    const before = h.frames.length;
    h.advance(60_000);
    h.core.handle({ type: 'resume' });
    h.step();
    expect(h.core.running).toBe(true);
    expect(h.frames.length).toBeGreaterThanOrEqual(before);
    h.settle();
    expect(h.positions()).toEqual(original);
    // Reinitialization while paused must not retain the old held node.
    h.core.handle(drag());
    h.step(2);
    h.core.handle({ type: 'pause' });
    h.step();
    h.init(2);
    h.core.handle({ type: 'resume' });
    h.settle();
  });

  it('restores immediately for reduced motion, including changes during a return', () => {
    const h = harness();
    const original = h.positions();
    h.core.handle({ type: 'interaction', returnToLayout: true, reducedMotion: true });
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    expect(h.positions()).toEqual(original);
    expect(h.core.running).toBe(false);
    h.step();
    h.core.handle({ type: 'interaction', returnToLayout: true });
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.step(2);
    h.core.handle({ type: 'interaction', returnToLayout: true, reducedMotion: true });
    expect(h.positions()).toEqual(original);
    h.settle();
  });

  it('yields physics slices and bounds the return even when the host clock stalls', () => {
    const h = harness(true);
    const original = h.positions();
    h.core.handle(drag());
    h.step();
    expect(h.queue).toHaveLength(1);
    h.core.handle({ type: 'release', index: 0 });
    h.settle();
    expect(h.positions()).toEqual(original);
  });
});

describe('elastic simulation command validation', () => {
  it('accepts interaction preferences and restore while rejecting malformed and nonfinite input', () => {
    expect(decodeCommand({ type: 'interaction', returnToLayout: true })).toEqual({ type: 'interaction', returnToLayout: true });
    expect(decodeCommand({ type: 'interaction', returnToLayout: false, reducedMotion: true })).toEqual({ type: 'interaction', returnToLayout: false, reducedMotion: true });
    expect(decodeCommand({ type: 'restore' })).toEqual({ type: 'restore' });
    for (const malformed of [
      { type: 'interaction' }, { type: 'interaction', returnToLayout: 1 },
      { type: 'interaction', returnToLayout: true, reducedMotion: 'true' },
      { ...drag(), x: Infinity }, { ...drag(), z: NaN }, { ...drag(), y: Number.MAX_VALUE },
      { ...drag(), index: Number.MAX_SAFE_INTEGER + 1 }, { type: 'release', index: NaN },
      { type: 'init', count: 1, degree: new Uint32Array(1), edges: new Uint32Array(), seed: Float32Array.from([0, Infinity, 0]) },
      { type: 'init', count: 1, degree: new Uint32Array(1), edges: new Uint32Array(), seed: Float32Array.from([0, NaN, 0]) },
      { type: 'init', count: 1, degree: new Uint32Array(1), edges: new Uint32Array(), seed: Float32Array.from([Infinity, Infinity, Infinity]) },
    ]) expect(decodeCommand(malformed)).toBeNull();
    expect(decodeFrame({ type: 'positions', positions: Float32Array.from([0, NaN, 0]), alpha: 0, running: false }, 1)).toBeNull();
  });

  it('keeps all-NaN triples as the intentional new-note seed on a graph refresh', () => {
    const h = harness();
    const seed = Float32Array.from([15, -10, 20, NaN, NaN, NaN]);
    const command = decodeCommand(encodeInit(2, Uint32Array.from([0, 1]), Uint32Array.from([1, 1]), seed).message);
    expect(command).not.toBeNull();
    h.core.handle(command!);
    expect(h.frames.at(-1)!.positions.every(Number.isFinite)).toBe(true);
    expect(h.positions().slice(0, 3)).toEqual([15, -10, 20]);
    h.settle();
    h.core.handle(drag());
    h.step(3);
    h.core.handle({ type: 'release', index: 0 });
    h.settle();
  });
});
