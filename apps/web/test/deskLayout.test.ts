import { describe, expect, it } from 'vitest';
import {
  deskInputPlacement, deskLayout, DEFAULT_DESK_LAYOUT, KEYBOARD_DIMENSIONS, MOUSE_DIMENSIONS, MOUSE_PAD, rotateXZ,
  SINGLE_DESK_SLOTS,
} from '../src/office/scene/interior/deskLayout';
import { deskReachForSeat } from '../src/office/scene/avatars/deskReach';
import { keyboardKeys } from '../src/office/scene/interior/prefabs/props/Keyboard';
import { SINGLE_WORKSTATION_BLUEPRINT } from '../src/office/scene/interior/spatialBlueprints';

const seats = Array.from({ length: 60 }, (_, i) => `qa.station-${i + 1}`);

describe('desk layout', () => {
  it('uses real keyboard and mouse sizes', () => {
    expect(KEYBOARD_DIMENSIONS.compact.width).toBeLessThan(0.34);
    expect(KEYBOARD_DIMENSIONS.full.width).toBeLessThan(0.47);
    expect(MOUSE_DIMENSIONS.length).toBeLessThan(0.13);
    // Every key lies inside its chassis.
    for (const kind of ['compact', 'full'] as const) {
      const { width, depth } = KEYBOARD_DIMENSIONS[kind];
      for (const key of keyboardKeys(kind)) {
        expect(Math.abs(key.x) + (key.width * 0.019) / 2).toBeLessThan(width / 2);
        expect(Math.abs(key.z) + 0.0083).toBeLessThan(depth / 2);
      }
    }
  });

  it('is stable per seat and varies between seats', () => {
    expect(deskLayout('qa.station-3')).toBe(deskLayout('qa.station-3'));
    expect(deskLayout(undefined)).toBe(DEFAULT_DESK_LAYOUT);
    const layouts = seats.map(deskLayout);
    expect(new Set(layouts.map(layout => layout.keyboardKind)).size).toBe(2);
    expect(new Set(layouts.map(layout => layout.mouseSide))).toEqual(new Set([1]));
    expect(new Set(layouts.map(layout => layout.mouseForward.toFixed(4))).size).toBeGreaterThan(30);
    expect(new Set(layouts.map(layout => layout.accessories[0])).size).toBeGreaterThan(3);
    expect(new Set(layouts.map(layout => layout.keyboardOffset[0].toFixed(3))).size).toBeGreaterThan(30);
  });

  it('keeps the mouse close beside the keyboard, its pad clear of the board', () => {
    for (const seat of seats) {
      const layout = deskLayout(seat);
      const input = deskInputPlacement([0, 0.8, 0.245], 0, 0.785, layout);
      const { width } = KEYBOARD_DIMENSIONS[layout.keyboardKind];
      // Mouse centre in the keyboard frame.
      const [mx] = rotateXZ(input.mouse[0] - input.keyboard[0], input.mouse[2] - input.keyboard[2], -input.keyboardYaw);
      const gap = Math.abs(mx) - width / 2 - MOUSE_DIMENSIONS.width / 2;
      expect(gap, seat).toBeGreaterThanOrEqual(0.019);
      expect(gap, seat).toBeLessThanOrEqual(0.051);
      expect(Math.sign(mx)).toBe(layout.mouseSide);
      // The pad's inner edge (with its yaw) stays outside the keyboard.
      const [px] = rotateXZ(input.pad[0] - input.keyboard[0], input.pad[2] - input.keyboard[2], -input.keyboardYaw);
      const reachIn = MOUSE_PAD.width / 2 * Math.cos(layout.mouseYaw) + MOUSE_PAD.depth / 2 * Math.abs(Math.sin(layout.mouseYaw));
      expect(Math.abs(px) - reachIn, seat).toBeGreaterThan(width / 2);
    }
  });

  it('keeps every single-desk item on the desktop', () => {
    const [w, , d] = SINGLE_WORKSTATION_BLUEPRINT.topSize;
    for (const slot of SINGLE_DESK_SLOTS) {
      expect(Math.abs(slot.position[0]) + 0.13).toBeLessThan(w / 2);
      expect(Math.abs(slot.position[1]) + 0.1).toBeLessThan(d / 2);
    }
  });

  it('sends the typing hands to each desk\'s own keyboard and the mouse hand to its side', () => {
    for (const seat of seats.slice(0, 20)) {
      const reach = deskReachForSeat(seat);
      // Facing +Z with +Y up: forward cross up gives right = −X.
      expect(reach.mouseHand, seat).toBe(0);
      expect(reach.mouse[0], seat).toBeLessThan(0);
      expect(Math.hypot(reach.typeWrist[0], reach.typeWrist[2])).toBeLessThan(0.55);
    }
  });
});
