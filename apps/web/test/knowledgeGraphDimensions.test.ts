import { describe, expect, it } from 'vitest';
import { createSimCore } from '../src/knowledge/vault/simCore';
import { decodeCommand, encodeInit, type SimFrame } from '../src/knowledge/vault/simProtocol';

function harness() {
  const frames: SimFrame[] = [];
  const queue: (() => void)[] = [];
  let clock = 0;
  const core = createSimCore({
    post: ({ message, transfer }) => frames.push(structuredClone(message, { transfer })),
    schedule: run => queue.push(run),
    now: () => (clock += 0.5),
  });
  const step = (count = 1) => {
    for (let i = 0; i < count && queue.length; i++) { clock += 16; queue.shift()!(); }
  };
  const settle = () => {
    let slices = 0;
    while (queue.length && slices++ < 1_000) step();
    expect(queue).toHaveLength(0);
    expect(core.running).toBe(false);
  };
  const latest = () => frames.at(-1)!.positions;
  return { core, frames, queue, step, settle, latest };
}

const init = (count: number, edges: number[], degree: number[], dimensions?: 2 | 3, groups?: number[], seed?: number[]) =>
  encodeInit(count, Uint32Array.from(edges), Uint32Array.from(degree), seed ? Float32Array.from(seed) : undefined, dimensions, groups ? Uint32Array.from(groups) : undefined);

describe('knowledge graph dimensions and community force', () => {
  it('copies and transfers optional groups and validates dimensions and group length', () => {
    const groups = Uint32Array.from([1, 2]);
    const encoded = encodeInit(2, Uint32Array.from([0, 1]), Uint32Array.from([1, 1]), undefined, 2, groups);
    expect(encoded.message).toMatchObject({ dimensions: 2, groups: Uint32Array.from([1, 2]) });
    expect((encoded.message as { groups: Uint32Array }).groups).not.toBe(groups);
    expect(encoded.transfer).toHaveLength(3);
    expect(decodeCommand(encoded.message)).toMatchObject({ dimensions: 2, groups: Uint32Array.from([1, 2]) });
    expect(decodeCommand({ type: 'dimensions', value: 2 })).toEqual({ type: 'dimensions', value: 2 });
    for (const invalid of [
      { type: 'dimensions', value: 0 }, { type: 'dimensions', value: 4 },
      { ...encoded.message, dimensions: 4 }, { ...encoded.message, groups: Uint32Array.from([1]) },
      { ...encoded.message, groups: Float32Array.from([1, 2]) },
    ]) expect(decodeCommand(invalid)).toBeNull();
  });

  it('keeps every z coordinate zero in 2D through drag, release, and return settle', () => {
    const h = harness();
    h.core.handle(init(3, [0, 1, 1, 2], [1, 2, 1], 2).message);
    h.settle();
    expect(Array.from(h.latest()).filter((_, at) => at % 3 === 2)).toEqual([0, 0, 0]);
    const origin = Array.from(h.latest());
    h.core.handle({ type: 'drag', index: 1, x: 100, y: -30, z: 900 });
    h.step(3);
    expect(Array.from(h.latest()).filter((_, at) => at % 3 === 2)).toEqual([0, 0, 0]);
    h.core.handle({ type: 'release', index: 1 });
    h.settle();
    expect(Array.from(h.latest())).toEqual(origin);
  });

  it('switches 2D to 3D and back while preserving indexed x/y positions and finite frames', () => {
    const h = harness();
    h.core.handle(init(3, [0, 1, 1, 2], [1, 2, 1], 2, [1, 1, 2]).message);
    h.settle();
    const before = Array.from(h.latest());
    h.core.handle({ type: 'dimensions', value: 3 });
    const threeD = Array.from(h.latest());
    expect(threeD.every(Number.isFinite)).toBe(true);
    expect(threeD.filter((_, at) => at % 3 === 2).some(value => value !== 0)).toBe(true);
    expect(threeD.filter((_, at) => at % 3 !== 2)).toEqual(before.filter((_, at) => at % 3 !== 2));
    h.settle();
    const beforeReturn = Array.from(h.latest());
    h.core.handle({ type: 'dimensions', value: 2 });
    const twoD = Array.from(h.latest());
    expect(twoD.every(Number.isFinite)).toBe(true);
    expect(twoD.filter((_, at) => at % 3 === 2)).toEqual([0, 0, 0]);
    expect(twoD.filter((_, at) => at % 3 !== 2)).toEqual(beforeReturn.filter((_, at) => at % 3 !== 2));
    h.settle();
  });

  it('settles with supplied groups while preserving their actual graph link', () => {
    const run = (edges: number[]) => {
      const h = harness();
      h.core.handle(init(2, edges, edges.length ? [1, 1] : [0, 0], 2, [1, 2], [-20, 0, 0, 20, 0, 0]).message);
      h.settle();
      return Array.from(h.latest());
    };
    const linked = run([0, 1]);
    const unlinked = run([]);
    expect(linked.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(linked[0]! - linked[3]!, linked[1]! - linked[4]!)).not.toBeCloseTo(Math.hypot(unlinked[0]! - unlinked[3]!, unlinked[1]! - unlinked[4]!), 1);
  });
});
