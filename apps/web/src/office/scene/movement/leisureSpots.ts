/**
 * Places an idle character can spend time at: real furniture and equipment
 * from the resource registry (fitness, TV and games, the terrace, lounges, the
 * pantry, the forecourt garden) and a few open-floor spots where two idle
 * characters stop to chat. Never a workstation and never a spot facility staff
 * use, so a wandering character can't take someone's desk or a staff station.
 */
import type { ActivityClip } from '../avatars/activityPose';
import { OFFICE_RESOURCES, type SpatialResource } from '../interior/resourceRegistry';
import { FACILITY_NAV_RESOURCE_IDS } from './facilityNpcs';

export type LeisureKind = 'chat' | 'fitness' | 'tv' | 'game' | 'terrace' | 'lounge' | 'pantry' | 'garden' | 'cafe';

export interface LeisureSpotDefinition {
  /** Resource id (furniture) or chat spot id. */
  readonly id: string;
  readonly kind: LeisureKind;
  readonly floor: 1 | 2 | 3;
  /** What the character does there. */
  readonly clip: ActivityClip;
}

/** Furniture each kind uses, by resource id; staff spots are filtered out below. */
const RESOURCE_KINDS: readonly (readonly [LeisureKind, RegExp])[] = [
  ['fitness', /^fitness\.(treadmill-\d|bike-\d|dumbbell-rack|freeweights|weight-bench|cable-row|yoga-mat-\d)$/],
  ['tv', /^entertainment\.(sofa-\d|armchair)$/],
  ['game', /^entertainment\.(arcade|foosball-1|console-[12])$/],
  ['terrace', /^rooftop-terrace\.(sofa-(west|east)-\d|armchair-\d)$/],
  ['lounge', /^(engineering\.lounge-\d|library\.sofa-\d)$/],
  ['pantry', /^lounge\.(barstool-\d|dining-\d)$/],
  ['cafe', /^outdoor\.cafe(?:-table-\d\.seat-\d|-counter)$/],
  ['garden', /^outdoor\.(?:forecourt-(?:west|east)|arrival-(?:west|east)|(?:west|east|rear)-bench|patio-(?:west|east))\.seat-\d$/],
  ['garden', /^outdoor\.garden-art$/],
];

function clipFor(resource: SpatialResource, kind: LeisureKind): ActivityClip {
  if (resource.kind === 'display-station') return 'look-around';
  switch (resource.activity) {
    case 'fitness-cardio': return 'jog';
    case 'fitness-cycle': return 'cycle';
    case 'fitness-strength': return 'lift';
    case 'fitness-seated-strength': return resource.id === 'fitness.cable-row' ? 'cable-row' : 'bench-curl';
    case 'fitness-stretch': return 'yoga';
    case 'gaming': return resource.id.includes('.console-') ? 'console-play' : 'arcade';
    case 'recreation': return 'foosball';
    case 'watching': return 'watch-tv';
    case 'coffee': return 'look-around';
    default: return kind === 'pantry' || kind === 'cafe' ? 'sip' : 'lounge';
  }
}

/** Standing chat places in open floor, in facing pairs (`a` faces `b`). */
export interface ChatSpotPair {
  readonly id: string;
  readonly floor: 1 | 2 | 3;
  /** Waypoint (floor-local name, e.g. `east-hall`) both spots are reached from. */
  readonly attach: string;
  readonly a: readonly [x: number, z: number];
  readonly b: readonly [x: number, z: number];
}

export const CHAT_SPOT_PAIRS: readonly ChatSpotPair[] = Object.freeze([
  { id: 'chat.f1-lounge-hall', floor: 1, attach: 'east-hall', a: [16.2, -7.2], b: [17.2, -7.2] },
  { id: 'chat.f3-terrace', floor: 3, attach: 'terrace-inside', a: [3.6, 15.4], b: [4.6, 15.4] },
  { id: 'chat.f3-south-hall', floor: 3, attach: 'south-hall', a: [17.6, 2.1], b: [18.6, 2.1] },
]);

/** Chat spot ids of a pair. */
export const chatSpotIds = (pair: ChatSpotPair) => [`${pair.id}.a`, `${pair.id}.b`] as const;

export const LEISURE_SPOTS: readonly LeisureSpotDefinition[] = Object.freeze([
  ...OFFICE_RESOURCES.flatMap((resource): LeisureSpotDefinition[] => {
    if (resource.kind === 'workstation' || FACILITY_NAV_RESOURCE_IDS.has(resource.id)) return [];
    const kind = RESOURCE_KINDS.find(([, pattern]) => pattern.test(resource.id))?.[0];
    return kind ? [{ id: resource.id, kind, floor: resource.floor, clip: clipFor(resource, kind) }] : [];
  }),
  ...CHAT_SPOT_PAIRS.flatMap(pair => chatSpotIds(pair).map((id, index) => ({ id, kind: 'chat' as const, floor: pair.floor, clip: (index ? 'chat-listen' : 'chat-talk') as ActivityClip }))),
]);

/** Furniture resources the walking graph must reach for idle characters. */
export const LEISURE_RESOURCE_IDS: ReadonlySet<string> = new Set(LEISURE_SPOTS.filter(spot => spot.kind !== 'chat').map(spot => spot.id));
