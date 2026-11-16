import { describe, expect, it } from 'vitest';
import { PerspectiveCamera, Vector3 } from 'three';
import { createShelfFlight, shelfFlightPose, SkillShelfMagic } from '../src/skills/skillShelfMagic';

describe('finite shelf magic', () => {
  it('staggers overlapping arrivals and reaches a stable pose even for long shelves', () => {
    expect(new SkillShelfMagic(0).animating).toBe(false);
    const magic = new SkillShelfMagic(100);
    magic.advance(370);
    expect(magic.reveal(0)).toBeCloseTo(.5); expect(magic.reveal(1)).toBeGreaterThan(0); expect(magic.reveal(10)).toBe(0);
    magic.advance(1_700);
    expect(magic.reveal(99)).toBe(1); expect(magic.animating).toBe(false);
  });

  it('preserves flowing arrival poses across different frame-time partitions', () => {
    const whole = new SkillShelfMagic(18), partitioned = new SkillShelfMagic(18);
    whole.advance(1_000);
    for (const delta of [13, 47, 201, 3, 319, 67, 350]) partitioned.advance(delta);
    for (let index = 0; index < 18; index++) expect(partitioned.reveal(index)).toBeCloseTo(whole.reveal(index), 12);
    expect(Array.from({ length: 18 }, (_, index) => whole.reveal(index)).filter(value => value > 0 && value < 1).length).toBeGreaterThan(1);
    whole.advance(1_032); partitioned.advance(1_032);
    expect(whole.reveal(17)).toBe(1); expect(partitioned.reveal(17)).toBe(1);
    expect(whole.animating).toBe(false); expect(partitioned.animating).toBe(false);
  });

  it('samples bounded past flight positions without advancing or restarting the animation clock', () => {
    const magic = new SkillShelfMagic(18), earlier = new SkillShelfMagic(18);
    magic.advance(500); earlier.advance(380);
    expect(magic.reveal(2, 120)).toBe(earlier.reveal(2));
    const current = magic.reveal(2);
    expect(magic.reveal(2, 1_000)).toBe(0); expect(magic.reveal(2, -10)).toBe(current);
    expect(magic.reveal(2)).toBe(current);
    magic.advance(2_000); expect(magic.animating).toBe(false);
    magic.reveal(2, 120); expect(magic.animating).toBe(false);
  });

  it('settles finite hover easing and sparkles while retaining active hover strength', () => {
    const magic = new SkillShelfMagic(2); magic.advance(2_000); magic.setHover(0);
    magic.advance(95); expect(magic.hover(0)).toBeCloseTo(.5);
    magic.setHover(1); expect(magic.hover(0)).toBeCloseTo(.5);
    magic.advance(190); expect(magic.hover(0)).toBe(0); expect(magic.hover(1)).toBe(1);
    expect(magic.animating).toBe(true);
    magic.advance(590); expect(magic.animating).toBe(false); expect(magic.burst).toBe(1);
    magic.setHover(1); expect(magic.animating).toBe(false);
    magic.setHover(null); magic.advance(190);
    expect(magic.hover(1)).toBe(0); expect(magic.animating).toBe(false);
  });

  it('bypasses all decorative movement for reduced motion', () => {
    const magic = new SkillShelfMagic(12); magic.setHover(2); magic.advance(0, true);
    expect(magic.reveal(11)).toBe(1); expect(magic.hover(2)).toBe(0);
    expect(magic.burst).toBe(1); expect(magic.animating).toBe(false);
  });

  it('restores a stationary hover when reduced motion switches off without replaying effects', () => {
    const magic = new SkillShelfMagic(3); magic.setHover(1); magic.advance(95);
    expect(magic.hover(1)).toBeCloseTo(.5);
    magic.advance(0, true);
    expect(magic.hover(1)).toBe(0); expect(magic.animating).toBe(false);
    // The media-query change draws even when no pointermove changes the hovered index.
    magic.advance(0, false);
    expect(magic.hover(1)).toBe(1); expect(magic.reveal(2)).toBe(1);
    expect(magic.burst).toBe(1); expect(magic.animating).toBe(false);
    magic.setHover(1); magic.advance(16);
    expect(magic.hover(1)).toBe(1); expect(magic.animating).toBe(false);
    magic.setHover(null); magic.advance(190);
    expect(magic.hover(1)).toBe(0); expect(magic.animating).toBe(false);
  });
});

describe('projected shelf flights', () => {
  it('starts the entire book outside narrow and wide camera viewports and lands exactly at home', () => {
    for (const aspect of [.45, 2.2]) {
      const camera = new PerspectiveCamera(34, aspect, .1, 50);
      camera.position.set(.25, .8, Math.max(10.4, 8.8 / (2 * Math.tan(34 * Math.PI / 360) * aspect)));
      camera.lookAt(0, 0, 0); camera.updateMatrixWorld();
      for (let index = 0; index < 18; index++) {
        const homeWorld = new Vector3((index % 6 - 2.5) * 1.22, Math.floor(index / 6) * 1.9, 0);
        const home = homeWorld.clone().project(camera);
        const depth = -homeWorld.clone().applyMatrix4(camera.matrixWorldInverse).z;
        const extent = { x: 1.1 * camera.projectionMatrix.elements[0]! / (depth - 1.1), y: 1.1 * camera.projectionMatrix.elements[5]! / (depth - 1.1) };
        const path = createShelfFlight(index, home, extent), start = shelfFlightPose(path, 0);
        expect(Math.abs(start.x) > 1 + extent.x || start.y < -1 - extent.y).toBe(true);
        const origin = new Vector3(start.x, start.y, start.z).unproject(camera);
        // The circumscribed sphere bounds every initial book rotation, not just the book's centre.
        for (const x of [-.63, .63]) for (const y of [-.63, .63]) for (const z of [-.63, .63]) {
          const corner = origin.clone().add(new Vector3(x, y, z)).project(camera);
          expect(Math.abs(corner.x) > 1 || corner.y < -1).toBe(true);
        }
        expect(shelfFlightPose(path, 1)).toEqual({ x: home.x, y: home.y, z: home.z, roll: 0, tilt: 0, scale: 1 });
      }
    }
  });

  it('uses deterministic bounded curves and can rebase at the current position without changing posture', () => {
    const home = { x: .3, y: -.2, z: .98 }, extent = { x: .2, y: .3 };
    const path = createShelfFlight(4, home, extent);
    expect(createShelfFlight(4, home, extent)).toEqual(path);
    for (let sample = 0; sample <= 100; sample++) {
      const pose = shelfFlightPose(path, sample / 100);
      for (const key of ['x', 'y', 'z'] as const) {
        const values = [path.start[key], path.controlA[key], path.controlB[key], path.home[key]];
        expect(pose[key]).toBeGreaterThanOrEqual(Math.min(...values) - 1e-12);
        expect(pose[key]).toBeLessThanOrEqual(Math.max(...values) + 1e-12);
      }
    }
    const current = shelfFlightPose(path, .4), rebased = createShelfFlight(4, home, extent, current);
    expect(shelfFlightPose(rebased, 0, .4)).toEqual(current);
    expect(shelfFlightPose(rebased, 1, 1)).toEqual(shelfFlightPose(path, 1));
  });
});
