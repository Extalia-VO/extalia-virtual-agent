import { describe, expect, it } from 'vitest';
import type { Point3 } from '../src/office/scene/layout';
import { chatMeetingPlaces, chooseChatMeeting, type ChatMeetingPlace } from '../src/office/scene/movement/chatRendezvous';
import { CHAT_SPOT_PAIRS, chatSpotIds, LEISURE_SPOTS } from '../src/office/scene/movement/leisureSpots';
import { officeNavigation, type OfficeFloor } from '../src/office/scene/movement/navGraph';
import { FACILITY_NAV_RESOURCE_IDS } from '../src/office/scene/movement/facilityNpcs';

const origins: readonly [Point3, Point3] = [[-10, 0, 0], [10, 0, 0]];
const place = (id: string, seated = false, floor: OfficeFloor = 1): ChatMeetingPlace => ({ id, floor, spots: [`${id}.a`, `${id}.b`], seated });

describe('chat rendezvous choice', () => {
  it('prefers a balanced common approach over a shorter but lopsided total journey', () => {
    const choices = [place('near-one'), place('middle')];
    const costs = new Map([['near-one.a', [1, 10]], ['near-one.b', [1, 10]], ['middle.a', [7, 7]], ['middle.b', [7, 7]]]);
    expect(chooseChatMeeting(choices, new Set(), origins, (actor, seat) => costs.get(seat)![actor]!)?.id).toBe('middle');
  });

  it('assigns the two spots to minimise approaches in either participant order', () => {
    const choices = [place('middle')];
    const cost = (actor: 0 | 1, seat: string) => seat.endsWith('.a') ? [10, 2][actor]! : [2, 10][actor]!;
    expect(chooseChatMeeting(choices, new Set(), origins, cost)?.spots).toEqual(['middle.b', 'middle.a']);
    expect(chooseChatMeeting(choices, new Set(), origins, (actor, seat) => cost(actor === 0 ? 1 : 0, seat))?.spots).toEqual(['middle.a', 'middle.b']);
  });

  it('prefers sofa seating only when the checked route cost is comparable', () => {
    const choices = [place('standing'), place('sofa', true)];
    const choose = (sofaCost: number) => chooseChatMeeting(choices, new Set(), origins, (_, seat) => seat.startsWith('sofa') ? sofaCost : 8);
    expect(choose(11)?.id).toBe('sofa');
    expect(choose(13)?.id).toBe('standing');
  });

  it('keeps both colleagues on their shared floor, or either participant floor when split', () => {
    const choices = [place('f2', false, 2), place('f3', false, 3), place('f1')];
    expect(chooseChatMeeting(choices, new Set(), origins, (_, seat) => seat.startsWith('f1') ? 50 : 1)?.floor).toBe(1);
    const split: readonly [Point3, Point3] = [[0, 0, 0], [0, 100, 0]];
    expect(chooseChatMeeting(choices, new Set(), split, (_, seat) => seat.startsWith('f3') ? 3 : seat.startsWith('f1') ? 8 : 1)?.floor).toBe(3);
  });

  it('rejects occupied spots and unreachable or invalid routes without reusing a single seat', () => {
    const choices = [place('occupied'), place('unreachable'), place('invalid'), place('fallback')];
    const reserved = new Set(['occupied.a']);
    for (const invalid of [NaN, Infinity, -1]) {
      const result = chooseChatMeeting(choices, reserved, origins, (actor, seat) => {
        if (seat.startsWith('unreachable') && actor === 1) return null;
        if (seat.startsWith('invalid')) return invalid;
        return seat.startsWith('fallback') ? 30 : 1;
      });
      expect(result?.id).toBe('fallback');
    }
    expect(chooseChatMeeting([{ ...place('same'), spots: ['one', 'one'] }], new Set(), origins, () => 1)).toBeNull();
    expect(chooseChatMeeting(choices, new Set(choices.flatMap(entry => entry.spots)), origins, () => 1)).toBeNull();
  });

  it('caches route costs across overlapping seat pairs and keeps ties stable under input reordering', () => {
    const choices = [place('z'), place('a'), { ...place('shared'), spots: ['a.a', 'z.b'] as const }];
    const calls = new Map<string, number>();
    const cost = (actor: 0 | 1, seat: string) => { const key = `${actor}:${seat}`; calls.set(key, (calls.get(key) ?? 0) + 1); return 5; };
    expect(chooseChatMeeting(choices, new Set(), origins, cost)?.id).toBe('a');
    expect([...calls.values()].every(count => count === 1)).toBe(true);
    expect(chooseChatMeeting([...choices].reverse(), new Set(), origins, () => 5)?.id).toBe('a');
  });
});

describe('authored conversation places', () => {
  const navigation = officeNavigation();

  it('includes real sofa pairs and standing pairs without desks, staff stations or crossed rooms', () => {
    const places = chatMeetingPlaces(navigation);
    expect(places.filter(entry => !entry.seated).map(entry => entry.spots)).toEqual(CHAT_SPOT_PAIRS.map(chatSpotIds));
    expect(new Set(places.map(entry => entry.floor))).toEqual(new Set([1, 2, 3]));
    const seated = places.filter(entry => entry.seated);
    expect(seated.length).toBeGreaterThan(0);
    const eligible = new Set(LEISURE_SPOTS.filter(spot => ['lounge', 'tv', 'terrace'].includes(spot.kind)).map(spot => spot.id));
    for (const entry of seated) {
      const [a, b] = entry.spots.map(id => navigation.seats.get(id)!);
      expect(a!.roomId).toBe(b!.roomId);
      expect(a!.floor).toBe(b!.floor);
      expect(a!.floor).toBe(entry.floor);
      expect(Math.hypot(a!.seat[0] - b!.seat[0], a!.seat[2] - b!.seat[2])).toBeGreaterThanOrEqual(.65);
      expect(Math.hypot(a!.seat[0] - b!.seat[0], a!.seat[2] - b!.seat[2])).toBeLessThanOrEqual(3);
      expect(Math.hypot(a!.staging[0] - b!.staging[0], a!.staging[2] - b!.staging[2])).toBeGreaterThanOrEqual(.58);
      for (const id of entry.spots) {
        expect(eligible.has(id)).toBe(true);
        expect(FACILITY_NAV_RESOURCE_IDS.has(id)).toBe(false);
        expect(navigation.seats.get(id)?.standing).not.toBe(true);
        expect(['sofa', 'armchair', 'bench']).toContain(navigation.seats.get(id)?.seatStyle);
      }
    }
  });

  it('omits a standing pair when either authored navigation seat is absent', () => {
    const seats = new Map(navigation.seats);
    const missing = chatSpotIds(CHAT_SPOT_PAIRS[0]!)[0];
    seats.delete(missing);
    expect(chatMeetingPlaces({ ...navigation, seats }).some(entry => entry.spots.includes(missing))).toBe(false);
  });
});
