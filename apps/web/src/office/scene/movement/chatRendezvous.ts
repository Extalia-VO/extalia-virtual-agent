/** Shared, authored places for two idle colleagues to meet without borrowing a desk. */
import type { Point3 } from '../layout';
import { CHAT_SPOT_PAIRS, chatSpotIds, LEISURE_SPOTS } from './leisureSpots';
import { floorAt, type OfficeFloor, type OfficeNavigation, type SeatApproach } from './navGraph';

export interface ChatMeetingPlace {
  readonly id: string;
  readonly floor: OfficeFloor;
  /** Assigned to the first and second participant, respectively. */
  readonly spots: readonly [string, string];
  readonly seated: boolean;
}

const SOCIAL_KINDS = new Set(['lounge', 'tv', 'terrace']);
const SOCIAL_SEAT_STYLES = new Set(['sofa', 'armchair', 'bench']);
const distance = (a: Readonly<Point3>, b: Readonly<Point3>) => Math.hypot(a[0] - b[0], a[2] - b[2]);

/** Reuse navigable furniture and its existing sit/stand choreography, never invent floor targets. */
export function chatMeetingPlaces(navigation: OfficeNavigation): readonly ChatMeetingPlace[] {
  const places: ChatMeetingPlace[] = CHAT_SPOT_PAIRS.flatMap(pair => {
    const spots = chatSpotIds(pair);
    return spots.every(id => navigation.seats.has(id)) ? [{ id: pair.id, floor: pair.floor, spots, seated: false }] : [];
  });
  const seats = LEISURE_SPOTS.flatMap((spot): SeatApproach[] => {
    const seat = navigation.seats.get(spot.id);
    return SOCIAL_KINDS.has(spot.kind) && seat && !seat.standing && SOCIAL_SEAT_STYLES.has(seat.seatStyle ?? '') ? [seat] : [];
  }).sort((a, b) => a.seatId.localeCompare(b.seatId));
  for (let first = 0; first < seats.length; first++) {
    const a = seats[first]!;
    for (let second = first + 1; second < seats.length; second++) {
      const b = seats[second]!;
      const separation = distance(a.seat, b.seat);
      if (a.floor !== b.floor || a.roomId !== b.roomId || separation < .65 || separation > 3
        || distance(a.staging, b.staging) < .58) continue;
      places.push({ id: `chat.seated:${a.seatId}|${b.seatId}`, floor: a.floor, spots: [a.seatId, b.seatId], seated: true });
    }
  }
  return places;
}

/**
 * Minimise the longer approach and the arrival imbalance, instead of sending one
 * participant across the building to a place where the other already waits.
 * A sofa wins over a comparable standing place, but only within four cost units.
 * Costs are checked graph-route costs supplied by the movement owner, not air distances.
 */
export function chooseChatMeeting(places: readonly ChatMeetingPlace[], reserved: ReadonlySet<string>,
  origins: readonly [Readonly<Point3>, Readonly<Point3>], cost: (actorIndex: 0 | 1, seatId: string) => number | null): ChatMeetingPlace | null {
  const floors = origins.map(point => floorAt(point[1]));
  const costs = [new Map<string, number | null>(), new Map<string, number | null>()] as const;
  const costFor = (actor: 0 | 1, seatId: string): number | null => {
    const cache = costs[actor];
    if (!cache.has(seatId)) {
      const measured = cost(actor, seatId);
      cache.set(seatId, measured !== null && Number.isFinite(measured) && measured >= 0 ? measured : null);
    }
    return cache.get(seatId)!;
  };
  let best: { place: ChatMeetingPlace; floorRank: number; score: number; tie: string } | null = null;
  for (const place of places) {
    const [a, b] = place.spots;
    if (a === b || reserved.has(a) || reserved.has(b)) continue;
    for (const spots of [[a, b], [b, a]] as const) {
      const first = costFor(0, spots[0]), second = costFor(1, spots[1]);
      if (first === null || second === null) continue;
      const floorRank = floors.includes(place.floor) ? 0 : 1;
      const score = Math.max(first, second) + .5 * Math.abs(first - second) - (place.seated ? 4 : 0);
      const tie = `${place.id}|${spots[0]}|${spots[1]}`;
      if (!best || floorRank < best.floorRank || (floorRank === best.floorRank
        && (score < best.score - 1e-9 || (Math.abs(score - best.score) <= 1e-9 && tie < best.tie)))) {
        best = { place: { ...place, spots }, floorRank, score, tie };
      }
    }
  }
  return best?.place ?? null;
}
