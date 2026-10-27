import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import type { SeatApproach } from '../src/office/scene/movement/navGraph';

const seat: SeatApproach = { seatId: 'sofa', roomId: 'room', floor: 1, seat: [0, 0, 0], rotationY: 0,
  seatHeight: .43, seatFront: .235, seatStyle: 'sofa', staging: [0, 0, 1.05], sitMs: 1000, standMs: 900 };
function box(size: [number, number, number], position: [number, number, number]) {
  const mesh = new Mesh(new BoxGeometry(...size), new MeshBasicMaterial()); mesh.position.set(...position); return mesh;
}
function fixture() {
  const root = new Group(), sofa = new Group(), field = new WalkingClearance();
  sofa.userData.officeSeat = true;
  sofa.add(box([2.2, .2, .67], [0, .33, 0]), box([2.2, .5, .12], [0, .65, -.4]));
  root.add(sofa); field.rebuild([root]);
  return { root, sofa, field };
}

describe('target-seat contact clearance', () => {
  it('permits target cushion contact only within the narrow front lane', () => {
    const { field } = fixture();
    expect(field.segmentClear([0, 0, .7], [0, 0, .335], .29)).toBe(false);
    expect(field.seatContactClear(seat, [0, 0, .7], seat.seat)).toBe(true);
    expect(field.seatContactClear(seat, seat.seat, [0, 0, .7])).toBe(true);
    expect(field.seatContactClear(seat, [0, 0, -.3], seat.seat)).toBe(false);
    expect(field.seatContactClear(seat, [.4, 0, .4], seat.seat)).toBe(false);
    expect(field.seatContactClear({ ...seat, seat: [3, 0, 0] }, [3, 0, .6], [3, 0, 0])).toBe(false);
  });

  it('keeps tables and neighboring chairs solid during both sit and rise', () => {
    for (const taggedSeat of [false, true]) {
      const { root, field } = fixture(), obstacle = new Group();
      obstacle.userData.officeSeat = taggedSeat;
      obstacle.add(box([.4, .7, .07], [0, .35, .45])); root.add(obstacle); field.rebuild([root]);
      expect(field.seatContactClear(seat, [0, 0, .7], seat.seat)).toBe(false);
      expect(field.seatContactClear(seat, seat.seat, [0, 0, .7])).toBe(false);
      root.remove(obstacle); field.rebuild([root]);
      expect(field.seatContactClear(seat, [0, 0, .7], seat.seat)).toBe(true);
    }
  });

  it('still requires upper-floor support while contacting a seat', () => {
    const { root, sofa, field } = fixture(); sofa.position.y = 6.4;
    const upper = { ...seat, floor: 2 as const, seat: [0, 6.4, 0] as [number, number, number] };
    field.rebuild([root]);
    expect(field.seatContactClear(upper, [0, 6.4, .7], upper.seat)).toBe(false);
    root.add(box([4, .1, 4], [0, 6.35, 0])); field.rebuild([root]);
    expect(field.seatContactClear(upper, [0, 6.4, .7], upper.seat)).toBe(true);
  });
});
