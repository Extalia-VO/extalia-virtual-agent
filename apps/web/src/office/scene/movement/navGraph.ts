/**
 * Authored walking graph of the furnished Office: corridor, doorway and aisle
 * waypoints per floor, the indoor stair lanes and both glass elevators. Seats
 * join the aisle of their own room, so a route never cuts through a room wall;
 * routes use A* from `@extalia/office`.
 */
import { findRoute, type FloorConnector, type NavEdge, type NavGraph, type NavNode, type Waypoint, type WaypointEdge, type WaypointKind } from '@extalia/office';
import { FLOOR_HEIGHT, OFFICE_STAIRCASE, OFFICE_STAIR_LAYOUT, type Point3 } from '../layout';
import { GLASS_ELEVATORS, type ElevatorId } from '../prefabs/architecture/elevatorController';
import { OFFICE_RESOURCES, type SeatStyle, type SpatialResource } from '../interior/resourceRegistry';
import type { NaturalLeg } from './naturalWalking';
import { ENTERTAINMENT_LAYOUT, entertainmentPoint } from '../interior/entertainmentBlueprint';
import { relocateRoomPoint } from '../interior/roomRelocation';
import { FACILITY_NAV_RESOURCE_IDS } from './facilityNpcs';
import { CHAT_SPOT_PAIRS, chatSpotIds, LEISURE_RESOURCE_IDS } from './leisureSpots';

export type OfficeFloor = 1 | 2 | 3;
type Spot = readonly [id: string, x: number, z: number, kind?: WaypointKind];
type Link = readonly [string, string];

interface FloorPlan {
  readonly spots: readonly Spot[];
  /** Two-way links between spots of this floor. */
  readonly links: readonly Link[];
  /** Two-way links inside a room; that room's seats join the nearest one. */
  readonly aisles: Readonly<Record<string, readonly Link[]>>;
}

/** Reference walking pace used to express timed connectors as a distance. */
const REFERENCE_SPEED = 1.3;
/** Stair flights are walked slower than level floor. */
export const STAIR_SPEED_FACTOR = 0.72;
/** Elevator waits, doors and boarding, expressed as walking time. */
const ELEVATOR_BASE_MS = 6500;
const ELEVATOR_MS_PER_FLOOR = 3200;

export const floorId = (floor: OfficeFloor) => `floor-${floor}`;
export const floorY = (floor: OfficeFloor) => (floor - 1) * FLOOR_HEIGHT;
/** Nearest office level of a height. */
export function floorAt(y: number): OfficeFloor {
  return Math.max(1, Math.min(3, Math.round(y / FLOOR_HEIGHT) + 1)) as OfficeFloor;
}

const elevatorSpots = (): Spot[] => GLASS_ELEVATORS.map(lift => [`elevator-${lift.id}`, lift.approachX, lift.z, 'connector'] as const);
const stairHubs: Spot[] = [
  ['stairs-north', OFFICE_STAIR_LAYOUT.floorConnectionX, OFFICE_STAIR_LAYOUT.bridgeNorthZ + OFFICE_STAIR_LAYOUT.landingLaneInset, 'connector'],
  ['stairs-south', OFFICE_STAIR_LAYOUT.floorConnectionX, OFFICE_STAIR_LAYOUT.bridgeSouthZ - OFFICE_STAIR_LAYOUT.landingLaneInset, 'connector'],
];
/** A south-row room entered from the corridor: door, inside, then a back aisle behind its desks. */
function backAisleRoom(room: string, doorX: number, doorZ: number, inward: 1 | -1, backZ: number, aisleX: number, west: number, east: number) {
  const spots: Spot[] = [
    [`${room}-door`, doorX, doorZ, 'door'], [`${room}-inside`, doorX, doorZ + inward * 0.8, 'door'],
    [`${room}-back`, aisleX, backZ, 'approach'], [`${room}-back-west`, west, backZ, 'approach'], [`${room}-back-east`, east, backZ, 'approach'],
  ];
  const aisles: Link[] = [[`${room}-inside`, `${room}-back`], [`${room}-back`, `${room}-back-west`], [`${room}-back`, `${room}-back-east`]];
  return { spots, links: [[`${room}-door`, `${room}-inside`]] as Link[], aisles };
}

const qa = backAisleRoom('qa', 8.3, 11.4, 1, 17.45, 8.2, 5.4, 10.9);
const source = backAisleRoom('source', 0.1, 11.4, 1, 17.45, 0.1, -2.8, 2.9);
const review = backAisleRoom('review', -3.75, 10.6, 1, 17.1, -3.75, -7.4, 0);
const entertainmentArcade = entertainmentPoint(ENTERTAINMENT_LAYOUT.arcades[0], 0);
const entertainmentGameX = relocateRoomPoint('entertainment', [entertainmentArcade[0], 0, entertainmentArcade[1]])[0];
const research = backAisleRoom('research', 5, -9.5, 1, -1.85, 5, 2.4, 7.6);

const FLOOR_PLANS: Readonly<Record<OfficeFloor, FloorPlan>> = {
  1: {
    spots: [
      ['entry-outside', 0, -22.6, 'spawn'], ['lobby-door', 0, -19, 'door'], ['lobby-inside', 0, -17.4],
      ['lobby-west-gap', -5.1, -16.45], ['lobby-west', -7.9, -15.6], ['lobby-west-south', -7.9, -12],
      ['engineering-north-outside', -5, -11.75, 'door'], ['engineering-north-door', -5, -11, 'door'], ['engineering-north-inside', -5, -10.25, 'door'],
      ['lobby-east', 2.7, -16.3], ['reception-aisle', 2.7, -12.9, 'approach'],
      ['stair-hall-west', 10.5, -17.2], ['stair-hall', 14.6, -17.5], ...stairHubs,
      ['east-hall', 14.6, -5], ['lounge-east', 19.2, -3.6], ...elevatorSpots(),
      ['engineering-east-outside', 11.9, -1.2, 'door'], ['engineering-east-door', 11, -1.2, 'door'], ['engineering-east-inside', 10.2, -1.2, 'door'],
      ['eng-n-w', -12.9, -8.35], ['eng-n-c', -5, -8.35], ['eng-n-e', 2.8, -8.35], ['eng-n-far', 7.8, -8.35],
      ['eng-m-w', -12.9, -1.2], ['eng-m-c', -5, -1.2], ['eng-m-e', 2.8, -1.2],
      ['eng-s-w', -12.9, 6.05], ['eng-s-c', -5, 6.05], ['eng-s-e', 2.8, 6.05], ['eng-s-far', 7.8, 6.05],
      ['engineering-south-inside', -5, 7.85, 'door'], ['engineering-south-door', -5, 8.6, 'door'],
      ['corridor-library', -16.6, 10], ['corridor-operations', -8.1, 10], ['corridor-center', -5, 10], ['corridor-source', 0.1, 10], ['corridor-qa', 8.3, 10],
      ['library-door', -16.6, 11.4, 'door'], ['library-inside', -16.6, 12.2, 'door'], ['library-aisle-north', -15.6, 13], ['library-aisle-south', -15.6, 16.2, 'approach'],
      ['operations-door', -8.1, 11.4, 'door'], ['operations-inside', -8.1, 12.2, 'door'], ['operations-back', -8.1, 17.7, 'approach'], ['operations-back-east', -5.6, 17.7, 'approach'],
      ...source.spots, ...qa.spots,
      // Facility staff only: dead-end lanes behind the bar (east end, under the stair landing) and behind the dining chairs.
      ['bar-east-approach', 24.2, -5, 'approach'], ['bar-east-entry', 24.2, -7.7, 'approach'], ['bar-back', 22.6, -7.7, 'approach'], ['bar-back-west', 19.8, -7.7, 'approach'],
      ['lounge-dining-lane', 18.9, 7.9, 'approach'], ['lounge-dining-east', 23.5, 7.9, 'approach'],
      // v0.0.38 idle life: the entertainment room (TV, arcade, foosball) off the south corridor, and the forecourt garden benches.
      ['corridor-entertainment', 18.7, 10], ['entertainment-door', 18.7, 11.4, 'door'], ['entertainment-inside', 18.7, 12.3, 'door'],
      ['entertainment-east', 19.6, 13.9, 'approach'], ['entertainment-games', entertainmentGameX, 13.9, 'approach'], ['entertainment-south', 19.6, 16, 'approach'], ['entertainment-west', 16.2, 16, 'approach'],
      ['forecourt-west', -7.6, -24.1, 'approach'], ['forecourt-east', 7.6, -24.1, 'approach'],
      ['forecourt-front', 0, -28.5, 'approach'], ['forecourt-front-west', -13, -28.5, 'approach'], ['forecourt-front-east', 13, -28.5, 'approach'],
      // Perimeter promenades stay outside the facade, shafts and planted strips.
      ['outdoor-west-front', -23.2, -21.6, 'approach'], ['outdoor-west-mid', -23.2, 8.5, 'approach'], ['outdoor-west-rear', -23.2, 21.3, 'approach'],
      ['outdoor-east-front', 30, -21.6, 'approach'], ['outdoor-east-mid', 30, 8.5, 'approach'], ['outdoor-east-rear', 30, 21.3, 'approach'],
      ['outdoor-rear-west', -5.2, 21.3, 'approach'], ['outdoor-rear-east', 5.2, 21.3, 'approach'],
      ['outdoor-rear-patio-west', -5.2, 23, 'approach'], ['outdoor-rear-patio-east', 5.2, 23, 'approach'],
      ['outdoor-rear-center-front', 0, 23, 'approach'], ['outdoor-rear-center-back', 0, 27.2, 'approach'],
      ['outdoor-rear-lane-west', -3.2, 28.2, 'approach'], ['outdoor-rear-lane-east', 3.2, 28.2, 'approach'],
      ['outdoor-cafe-entry', -26, -21.6, 'approach'], ['outdoor-cafe-counter', -31.1, -21.6, 'approach'],
      ['outdoor-cafe-front-walk', -24.3, -27.5, 'approach'], ['outdoor-garden-art', -34.2, -27.5, 'approach'],
      ['outdoor-west-seat-lane', -24.2, 8.5, 'approach'], ['outdoor-east-seat-lane', 31.5, 8.5, 'approach'],
    ],
    links: [
      ['entry-outside', 'lobby-door'], ['lobby-door', 'lobby-inside'], ['lobby-inside', 'lobby-west-gap'], ['lobby-west-gap', 'lobby-west'],
      ['lobby-west', 'lobby-west-south'], ['lobby-west-south', 'engineering-north-outside'], ['engineering-north-outside', 'engineering-north-door'],
      ['engineering-north-door', 'engineering-north-inside'], ['lobby-inside', 'lobby-east'], ['lobby-east', 'stair-hall-west'],
      ['stair-hall-west', 'stair-hall'], ['stair-hall', 'stairs-north'], ['stair-hall', 'stairs-south'], ['stairs-north', 'stairs-south'],
      ['stair-hall', 'east-hall'], ['east-hall', 'lounge-east'], ['lounge-east', 'elevator-A'], ['lounge-east', 'elevator-B'],
      ['east-hall', 'engineering-east-outside'], ['engineering-east-outside', 'lounge-east'],
      ['engineering-east-outside', 'engineering-east-door'], ['engineering-east-door', 'engineering-east-inside'],
      ['engineering-south-inside', 'engineering-south-door'], ['engineering-south-door', 'corridor-center'],
      ['corridor-library', 'corridor-operations'], ['corridor-operations', 'corridor-center'], ['corridor-center', 'corridor-source'], ['corridor-source', 'corridor-qa'],
      ['corridor-library', 'library-door'], ['library-door', 'library-inside'], ['corridor-operations', 'operations-door'], ['operations-door', 'operations-inside'],
      ['corridor-source', 'source-door'], ['corridor-qa', 'qa-door'], ...source.links, ...qa.links,
      ['corridor-qa', 'corridor-entertainment'], ['corridor-entertainment', 'entertainment-door'], ['entertainment-door', 'entertainment-inside'],
    ],
    aisles: {
      lobby: [['lobby-east', 'reception-aisle']],
      engineering: [
        ['engineering-north-inside', 'eng-n-c'], ['eng-n-w', 'eng-n-c'], ['eng-n-c', 'eng-n-e'], ['eng-n-e', 'eng-n-far'],
        ['eng-m-w', 'eng-m-c'], ['eng-m-c', 'eng-m-e'], ['eng-m-e', 'engineering-east-inside'],
        ['eng-s-w', 'eng-s-c'], ['eng-s-c', 'eng-s-e'], ['eng-s-e', 'eng-s-far'],
        ['eng-n-w', 'eng-m-w'], ['eng-m-w', 'eng-s-w'], ['eng-n-c', 'eng-m-c'], ['eng-m-c', 'eng-s-c'], ['eng-n-e', 'eng-m-e'], ['eng-m-e', 'eng-s-e'],
        ['eng-s-c', 'engineering-south-inside'],
      ],
      library: [['library-inside', 'library-aisle-north'], ['library-aisle-north', 'library-aisle-south']],
      operations: [['operations-inside', 'operations-back'], ['operations-back', 'operations-back-east']],
      'source-control': source.aisles,
      qa: qa.aisles,
      lounge: [['lounge-east', 'bar-east-approach'], ['bar-east-approach', 'bar-east-entry'], ['bar-east-entry', 'bar-back'], ['bar-back', 'bar-back-west'],
        ['lounge-east', 'lounge-dining-lane'], ['lounge-dining-lane', 'lounge-dining-east']],
      entertainment: [['entertainment-inside', 'entertainment-east'], ['entertainment-east', 'entertainment-games'], ['entertainment-east', 'entertainment-south'], ['entertainment-south', 'entertainment-west']],
      'outdoor-forecourt': [['entry-outside', 'forecourt-west'], ['entry-outside', 'forecourt-east'],
        ['entry-outside', 'forecourt-front'], ['forecourt-front', 'forecourt-front-west'], ['forecourt-front', 'forecourt-front-east']],
      'outdoor-west-garden': [['forecourt-west', 'outdoor-west-front'], ['outdoor-west-front', 'outdoor-west-mid'],
        ['outdoor-west-mid', 'outdoor-west-rear'], ['outdoor-west-mid', 'outdoor-west-seat-lane']],
      'outdoor-east-garden': [['forecourt-east', 'outdoor-east-front'], ['outdoor-east-front', 'outdoor-east-mid'],
        ['outdoor-east-mid', 'outdoor-east-rear'], ['outdoor-east-mid', 'outdoor-east-seat-lane']],
      'outdoor-cafe': [['outdoor-west-front', 'outdoor-cafe-entry'], ['outdoor-cafe-entry', 'outdoor-cafe-counter'],
        ['outdoor-west-front', 'outdoor-cafe-front-walk'], ['outdoor-cafe-front-walk', 'outdoor-garden-art']],
      'outdoor-rear-patio': [['outdoor-west-rear', 'outdoor-rear-west'], ['outdoor-rear-west', 'outdoor-rear-east'],
        ['outdoor-rear-east', 'outdoor-east-rear'], ['outdoor-rear-west', 'outdoor-rear-patio-west'],
        ['outdoor-rear-east', 'outdoor-rear-patio-east'], ['outdoor-rear-patio-west', 'outdoor-rear-center-front'],
        ['outdoor-rear-center-front', 'outdoor-rear-patio-east'], ['outdoor-rear-center-front', 'outdoor-rear-center-back'],
        ['outdoor-rear-lane-west', 'outdoor-rear-center-back'], ['outdoor-rear-center-back', 'outdoor-rear-lane-east']],
    },
  },
  2: {
    spots: [
      ...stairHubs, ['stair-hall', 14.6, -16.6], ['north-hall', 14.6, -8.2], ['east-hall', 14.6, -3], ['lounge-east', 19.2, -3], ...elevatorSpots(),
      ['south-hall', 14.6, 9],
      ['corridor-executive', -12, -8.2], ['corridor-mission', 4, -8.2],
      ['executive-door', -12, -9.8, 'door'], ['executive-inside', -12, -10.6, 'door'], ['executive-back', -12.4, -17.5, 'approach'], ['executive-back-west', -18.4, -17.5, 'approach'],
      ['mission-door', 4, -9.8, 'door'], ['mission-inside', 4, -10.6, 'door'], ['mission-aisle', 4, -11.9, 'approach'],
      ['mission-aisle-west', -1.4, -11.9, 'approach'], ['mission-aisle-east', 9.6, -11.9, 'approach'],
      ['corridor-knowledge', -15.25, 9], ['corridor-review', -3.75, 9], ['corridor-architecture', 8.75, 9],
      // The reading table and armchair close the east side of the desk; approach from the west.
      ['knowledge-door', -15.25, 10.6, 'door'], ['knowledge-inside', -15.25, 11.4, 'door'], ['knowledge-aisle-north', -16.4, 12.2],
      ['knowledge-aisle-south', -16.4, 17.1, 'approach'], ['knowledge-aisle-east', -14.9, 17.1, 'approach'],
      ...review.spots,
      ['architecture-door', 8.75, 10.6, 'door'], ['architecture-inside', 8.75, 11.4, 'door'], ['architecture-back', 8.75, 17.4, 'approach'], ['architecture-back-west', 6, 17.4, 'approach'],
    ],
    links: [
      ['stairs-north', 'stairs-south'], ['stair-hall', 'stairs-north'], ['stair-hall', 'stairs-south'], ['stair-hall', 'north-hall'],
      ['north-hall', 'corridor-mission'], ['corridor-mission', 'corridor-executive'], ['north-hall', 'east-hall'], ['east-hall', 'lounge-east'],
      ['lounge-east', 'elevator-A'], ['lounge-east', 'elevator-B'], ['east-hall', 'south-hall'],
      ['south-hall', 'corridor-architecture'], ['corridor-architecture', 'corridor-review'], ['corridor-review', 'corridor-knowledge'],
      ['corridor-executive', 'executive-door'], ['executive-door', 'executive-inside'], ['corridor-mission', 'mission-door'], ['mission-door', 'mission-inside'],
      ['corridor-knowledge', 'knowledge-door'], ['knowledge-door', 'knowledge-inside'], ['corridor-review', 'review-door'], ...review.links,
      ['corridor-architecture', 'architecture-door'], ['architecture-door', 'architecture-inside'],
    ],
    aisles: {
      executive: [['executive-inside', 'executive-back'], ['executive-back', 'executive-back-west']],
      'mission-control': [['mission-inside', 'mission-aisle'], ['mission-aisle', 'mission-aisle-west'], ['mission-aisle', 'mission-aisle-east']],
      knowledge: [['knowledge-inside', 'knowledge-aisle-north'], ['knowledge-aisle-north', 'knowledge-aisle-south'], ['knowledge-aisle-south', 'knowledge-aisle-east']],
      review: review.aisles,
      architecture: [['architecture-inside', 'architecture-back'], ['architecture-back', 'architecture-back-west']],
    },
  },
  3: {
    spots: [
      ...stairHubs, ['stair-hall', 14.6, -16.6], ['north-hall', 14.6, -11.15], ['east-hall', 14.6, -3], ['lounge-east', 19.2, -3], ...elevatorSpots(),
      ['south-hall', 14.6, 2.1],
      ['corridor-sanctuary', -16, -11.15], ['corridor-flex', -6, -11.15], ['corridor-multi', 1.25, -11.15], ['corridor-research', 5, -11.15],
      ['multi-door', 1.25, -12.8, 'door'], ['multi-inside', 1.25, -13.45, 'door'], ['multi-aisle', 1.25, -15.45, 'approach'],
      ['multi-aisle-west', -5.1, -15.45, 'approach'], ['multi-aisle-east', 7.3, -15.45, 'approach'],
      ['sanctuary-door', -16, -9.5, 'door'], ['sanctuary-inside', -16, -8.7, 'door'], ['sanctuary-aisle-east', -12.1, -7.6],
      ['sanctuary-aisle-southeast', -12.1, -1.8, 'approach'], ['sanctuary-aisle-southwest', -19.6, -1.8, 'approach'],
      ['flex-door', -6, -9.5, 'door'], ['flex-inside', -6, -8.7, 'door'], ['flex-aisle', -6, -7],
      ['flex-aisle-northwest', -9.45, -7, 'approach'], ['flex-aisle-northeast', -2.55, -7, 'approach'],
      ['flex-aisle-southwest', -9.45, -1.6, 'approach'], ['flex-aisle-southeast', -2.55, -1.6, 'approach'],
      ...research.spots,
      ['corridor-studio', -12, 2.1], ['studio-door', -12, 3.7, 'door'], ['studio-inside', -12, 4.5, 'door'], ['studio-aisle-west', -18.4, 4.9, 'approach'],
      // Terrace passage between the studio and fitness rooms, and the fitness entrance aisle (dead-end branches off the south hall).
      ['terrace-hall', 1, 2.1], ['terrace-passage', 1, 11.9], ['terrace-door', 1, 13, 'door'], ['terrace-inside', 1, 13.9, 'door'],
      ['terrace-east', 11, 16.2, 'approach'], ['terrace-far-east', 17, 16.1, 'approach'], ['terrace-west', -9, 16.1, 'approach'], ['terrace-far-west', -15, 16.1, 'approach'],
      ['fitness-hall', 15, 4.4], ['fitness-door', 15, 5.7, 'door'], ['fitness-inside', 15, 6.6, 'door'],
      ['fitness-mid', 15, 9, 'approach'], ['fitness-west', 7.6, 9, 'approach'], ['fitness-east-lane', 23.2, 9.3, 'approach'],
      ['fitness-center', 15, 11.1, 'approach'], ['fitness-east', 20.7, 11.1, 'approach'],
    ],
    links: [
      ['stairs-north', 'stairs-south'], ['stair-hall', 'stairs-north'], ['stair-hall', 'stairs-south'], ['stair-hall', 'north-hall'],
      ['north-hall', 'corridor-research'], ['corridor-research', 'corridor-multi'], ['corridor-multi', 'corridor-flex'], ['corridor-flex', 'corridor-sanctuary'],
      ['north-hall', 'east-hall'], ['east-hall', 'lounge-east'], ['lounge-east', 'elevator-A'], ['lounge-east', 'elevator-B'],
      ['east-hall', 'south-hall'], ['south-hall', 'corridor-studio'],
      ['corridor-multi', 'multi-door'], ['multi-door', 'multi-inside'], ['corridor-sanctuary', 'sanctuary-door'], ['sanctuary-door', 'sanctuary-inside'],
      ['corridor-flex', 'flex-door'], ['flex-door', 'flex-inside'], ['corridor-research', 'research-door'], ...research.links,
      ['corridor-studio', 'studio-door'], ['studio-door', 'studio-inside'],
      ['south-hall', 'terrace-hall'], ['terrace-hall', 'terrace-passage'], ['terrace-passage', 'terrace-door'], ['terrace-door', 'terrace-inside'],
      ['south-hall', 'fitness-hall'], ['fitness-hall', 'fitness-door'], ['fitness-door', 'fitness-inside'],
    ],
    aisles: {
      'multi-engine': [['multi-inside', 'multi-aisle'], ['multi-aisle', 'multi-aisle-west'], ['multi-aisle', 'multi-aisle-east']],
      sanctuary: [['sanctuary-inside', 'sanctuary-aisle-east'], ['sanctuary-aisle-east', 'sanctuary-aisle-southeast'], ['sanctuary-aisle-southeast', 'sanctuary-aisle-southwest']],
      flex: [['flex-inside', 'flex-aisle'], ['flex-aisle', 'flex-aisle-northwest'], ['flex-aisle', 'flex-aisle-northeast'],
        ['flex-aisle-northwest', 'flex-aisle-southwest'], ['flex-aisle-northeast', 'flex-aisle-southeast']],
      research: research.aisles,
      'executive-studio': [['studio-inside', 'studio-aisle-west']],
      'rooftop-terrace': [['terrace-inside', 'terrace-east'], ['terrace-east', 'terrace-far-east'], ['terrace-inside', 'terrace-west'], ['terrace-west', 'terrace-far-west']],
      fitness: [['fitness-inside', 'fitness-mid'], ['fitness-mid', 'fitness-center'], ['fitness-center', 'fitness-east'], ['fitness-mid', 'fitness-west'], ['fitness-mid', 'fitness-east-lane']],
    },
  },
};

/** Keep-right stair lanes with the mid landing as a passing bay, one way each. */
function stairLanes(lower: 1 | 2): { up: Waypoint[]; down: Waypoint[] } {
  const y = floorY(lower), half = OFFICE_STAIRCASE.rise / 2, top = y + OFFICE_STAIRCASE.rise;
  const offset = OFFICE_STAIRCASE.width / 2 + OFFICE_STAIRCASE.gap / 2, lane = OFFICE_STAIRCASE.laneOffset;
  const westX = OFFICE_STAIRCASE.x - offset, eastX = OFFICE_STAIRCASE.x + offset;
  const north = OFFICE_STAIR_LAYOUT.northFlightZ, south = OFFICE_STAIR_LAYOUT.southFlightZ;
  const upZ = OFFICE_STAIR_LAYOUT.bridgeNorthZ + OFFICE_STAIR_LAYOUT.landingLaneInset;
  const downZ = OFFICE_STAIR_LAYOUT.bridgeSouthZ - OFFICE_STAIR_LAYOUT.landingLaneInset;
  const upMid = south + OFFICE_STAIRCASE.midLandingUpOffset, downMid = south + OFFICE_STAIRCASE.midLandingDownOffset;
  const node = (id: string, x: number, py: number, z: number): Waypoint => ({ id: `stairs-${lower}-${lower + 1}.${id}`, floorId: floorId(lower), kind: 'connector', position: [x, py, z] });
  return {
    up: [
      node('up-landing', westX + lane, y, upZ), node('up-start', westX + lane, y, north), node('up-turn-in', westX + lane, y + half, south),
      node('up-mid-west', westX + lane, y + half, upMid), node('up-mid-east', eastX - lane, y + half, upMid), node('up-turn-out', eastX - lane, y + half, south),
      node('up-top', eastX - lane, top, north), node('up-exit', eastX - lane, top, downZ),
    ],
    down: [
      node('down-landing', eastX + lane, top, upZ), node('down-start', eastX + lane, top, north), node('down-turn-in', eastX + lane, y + half, south),
      node('down-mid-east', eastX + lane, y + half, downMid), node('down-mid-west', westX - lane, y + half, downMid), node('down-turn-out', westX - lane, y + half, south),
      node('down-bottom', westX - lane, y, north), node('down-exit', westX - lane, y, downZ),
    ],
  };
}

export interface SeatApproach {
  readonly seatId: string;
  readonly roomId: string;
  readonly floor: OfficeFloor;
  /** Avatar root while seated. */
  readonly seat: Point3;
  readonly rotationY: number;
  readonly seatHeight: number;
  /** Fixed upholstered/outdoor seats use front entry rather than desk-chair handling. */
  readonly seatStyle?: SeatStyle;
  /** Cushion front edge, in metres forward from the character root. */
  readonly seatFront?: number;
  /** Standing point beside or behind the chair where sitting starts and standing ends. */
  readonly staging: Point3;
  readonly sitMs: number;
  readonly standMs: number;
  /** A standing interaction point (no chair): arriving only turns to face it. */
  readonly standing?: boolean;
}

/** Same chair-local transform the resource registry authors for each seat. */
export function seatApproach(resource: SpatialResource): SeatApproach {
  const { position: p, rotationY: yaw, interaction } = resource;
  let staging: Point3 = [p[0], p[1], p[2]];
  if (interaction.approachOffset) {
    const [ox, oz] = interaction.approachOffset, c = Math.cos(yaw), s = Math.sin(yaw);
    staging = [p[0] + ox * c + oz * s, p[1], p[2] - ox * s + oz * c];
  } else if (interaction.approachSide !== 'none' && interaction.approachDistance > 0) {
    const sign = interaction.approachSide === 'front' ? 1 : -1;
    staging = [p[0] + sign * Math.sin(yaw) * interaction.approachDistance, p[1], p[2] + sign * Math.cos(yaw) * interaction.approachDistance];
  }
  if (interaction.seatStyle === 'none') {
    return { seatId: resource.id, roomId: resource.roomId, floor: resource.floor, seat: [p[0], p[1], p[2]], rotationY: yaw,
      seatHeight: 0, staging, sitMs: 600, standMs: 1, standing: true };
  }
  return {
    seatId: resource.id, roomId: resource.roomId, floor: resource.floor, seat: [p[0], p[1], p[2]], rotationY: yaw,
    seatStyle: interaction.seatStyle,
    seatHeight: interaction.seatHeight, ...(interaction.seatFront !== undefined ? { seatFront: interaction.seatFront } : {}), staging, sitMs: interaction.sitDurationMs || 850, standMs: interaction.standDurationMs || 760,
  };
}

export type EdgeKind = 'walk' | 'stairs' | 'elevator';
export interface OfficeNavigation {
  readonly graph: NavGraph;
  readonly waypoints: ReadonlyMap<string, Waypoint>;
  readonly edges: readonly WaypointEdge[];
  readonly connectors: readonly FloorConnector[];
  /** Walk edges authored inside rooms, by room id. */
  readonly aisles: ReadonlyMap<string, readonly WaypointEdge[]>;
  readonly seats: ReadonlyMap<string, SeatApproach>;
  /** `from|to` → elevator id for cab rides. */
  readonly elevatorEdges: ReadonlyMap<string, ElevatorId>;
  readonly entryId: string;
}

const distance3 = (a: Point3, b: Point3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const seatStageId = (seatId: string) => `seat:${seatId}:stage`;
const seatAttachId = (seatId: string) => `seat:${seatId}:aisle`;

/** Nearest point of segment ab to p in plan view, with its parameter along ab. */
function projectOnSegment(p: Point3, a: Point3, b: Point3): { point: Point3; t: number; distance: number } {
  const dx = b[0] - a[0], dz = b[2] - a[2], length2 = dx * dx + dz * dz;
  const t = length2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[2] - a[2]) * dz) / length2)) : 0;
  const point: Point3 = [a[0] + dx * t, a[1], a[2] + dz * t];
  return { point, t, distance: Math.hypot(point[0] - p[0], point[2] - p[2]) };
}

function buildNavigation(): OfficeNavigation {
  const waypoints = new Map<string, Waypoint>();
  const edges: WaypointEdge[] = [];
  const aisles = new Map<string, WaypointEdge[]>();
  const add = (waypoint: Waypoint) => {
    if (waypoints.has(waypoint.id)) throw new Error(`Duplicate office waypoint ${waypoint.id}`);
    waypoints.set(waypoint.id, waypoint);
  };
  for (const floor of [1, 2, 3] as const) {
    const plan = FLOOR_PLANS[floor];
    const id = (spot: string) => `f${floor}.${spot}`;
    for (const [spot, x, z, kind = 'corridor'] of plan.spots) add({ id: id(spot), floorId: floorId(floor), kind, position: [x, floorY(floor), z] });
    for (const [a, b] of plan.links) edges.push({ from: id(a), to: id(b) });
    for (const [room, links] of Object.entries(plan.aisles)) {
      const list = links.map(([a, b]) => ({ from: id(a), to: id(b) }));
      aisles.set(room, [...(aisles.get(room) ?? []), ...list]);
      edges.push(...list);
    }
  }
  const connectors: FloorConnector[] = [];
  for (const lower of [1, 2] as const) {
    const lanes = stairLanes(lower);
    for (const [direction, lane, from, to] of [['up', lanes.up, lower, lower + 1], ['down', lanes.down, lower + 1, lower]] as const) {
      lane.forEach(add);
      const chain = [`f${from}.stairs-north`, ...lane.map(node => node.id), `f${to}.stairs-south`];
      for (let i = 1; i < chain.length; i++) edges.push({ from: chain[i - 1]!, to: chain[i]!, bidirectional: false });
      connectors.push({ id: `stairs-${lower}-${lower + 1}-${direction}`, kind: 'stairs', waypoints: chain, traversalMs: 0 });
    }
  }
  const elevatorEdges = new Map<string, ElevatorId>();
  for (const lift of GLASS_ELEVATORS) {
    const stops = [1, 2, 3].map(floor => `f${floor}.elevator-${lift.id}`);
    connectors.push({ id: `elevator-${lift.id}`, kind: 'elevator', waypoints: stops, traversalMs: ELEVATOR_MS_PER_FLOOR });
    for (const a of stops) for (const b of stops) if (a !== b) elevatorEdges.set(`${a}|${b}`, lift.id);
  }
  for (const edge of edges) if (!waypoints.has(edge.from) || !waypoints.has(edge.to)) throw new Error(`Office edge ${edge.from} → ${edge.to} has an unknown end`);

  // Seats join the nearest aisle of their own room; aisle edges are split at each join.
  // Workstations plus the few facility-staff stations and break spots.
  const seats = new Map<string, SeatApproach>();
  const splits = new Map<WaypointEdge, { t: number; id: string }[]>();
  for (const resource of OFFICE_RESOURCES) {
    if (resource.kind !== 'workstation' && !FACILITY_NAV_RESOURCE_IDS.has(resource.id) && !LEISURE_RESOURCE_IDS.has(resource.id)) continue;
    const seat = seatApproach(resource);
    const candidates = (aisles.get(seat.roomId) ?? []).filter(edge => waypoints.get(edge.from)!.floorId === floorId(seat.floor));
    if (!candidates.length) throw new Error(`Seat ${seat.seatId} has no aisle in ${seat.roomId}`);
    let best: { edge: WaypointEdge; t: number; point: Point3; distance: number } | undefined;
    for (const edge of candidates) {
      const projection = projectOnSegment(seat.staging, waypoints.get(edge.from)!.position as Point3, waypoints.get(edge.to)!.position as Point3);
      if (!best || projection.distance < best.distance - 1e-9) best = { edge, ...projection };
    }
    seats.set(seat.seatId, seat);
    add({ id: seatStageId(seat.seatId), floorId: floorId(seat.floor), kind: 'approach', position: seat.staging });
    add({ id: seatAttachId(seat.seatId), floorId: floorId(seat.floor), kind: 'approach', position: best!.point });
    edges.push({ from: seatAttachId(seat.seatId), to: seatStageId(seat.seatId) });
    const list = splits.get(best!.edge) ?? [];
    list.push({ t: best!.t, id: seatAttachId(seat.seatId) });
    splits.set(best!.edge, list);
  }
  // Chat spots: standing places in open floor, reached straight from their hall waypoint, facing each other.
  for (const pair of CHAT_SPOT_PAIRS) {
    const y = floorY(pair.floor), attach = `f${pair.floor}.${pair.attach}`;
    if (!waypoints.has(attach)) throw new Error(`Chat spot ${pair.id} attaches to unknown waypoint ${attach}`);
    const [aId, bId] = chatSpotIds(pair);
    const facing = Math.atan2(pair.b[0] - pair.a[0], pair.b[1] - pair.a[1]);
    for (const [id, [x, z], yaw] of [[aId, pair.a, facing], [bId, pair.b, facing + Math.PI]] as const) {
      const seat: SeatApproach = { seatId: id, roomId: 'chat', floor: pair.floor, seat: [x, y, z], rotationY: yaw, seatHeight: 0, staging: [x, y, z], sitMs: 500, standMs: 1, standing: true };
      seats.set(id, seat);
      add({ id: seatStageId(id), floorId: floorId(pair.floor), kind: 'approach', position: seat.staging });
      edges.push({ from: attach, to: seatStageId(id) });
    }
  }
  const walkEdges = edges.flatMap((edge): WaypointEdge[] => {
    const joins = splits.get(edge);
    if (!joins) return [edge];
    const chain = [edge.from, ...joins.sort((a, b) => a.t - b.t || a.id.localeCompare(b.id)).map(join => join.id), edge.to];
    return chain.slice(1).map((to, index) => ({ from: chain[index]!, to }));
  });

  const nodes = new Map<string, NavNode>();
  const adjacency = new Map<string, NavEdge[]>();
  for (const waypoint of waypoints.values()) {
    nodes.set(waypoint.id, { id: waypoint.id, floorId: waypoint.floorId, pos: { x: waypoint.position[0], y: waypoint.position[2] } });
    adjacency.set(waypoint.id, []);
  }
  const link = (from: string, to: string, cost: number) => {
    const list = adjacency.get(from)!;
    if (!list.some(edge => edge.to === to)) list.push({ to, cost });
  };
  for (const edge of walkEdges) {
    const a = waypoints.get(edge.from)!.position as Point3, b = waypoints.get(edge.to)!.position as Point3;
    const cost = distance3(a, b) / (Math.abs(a[1] - b[1]) > 1e-6 ? STAIR_SPEED_FACTOR : 1);
    link(edge.from, edge.to, cost);
    if (edge.bidirectional !== false) link(edge.to, edge.from, cost);
  }
  for (const [key] of elevatorEdges) {
    const [from, to] = key.split('|') as [string, string];
    const floors = Math.abs(waypoints.get(from)!.position[1] - waypoints.get(to)!.position[1]) / FLOOR_HEIGHT;
    link(from, to, (ELEVATOR_BASE_MS + ELEVATOR_MS_PER_FLOOR * floors) / 1000 * REFERENCE_SPEED);
  }
  const sorted = new Map<string, readonly NavEdge[]>();
  for (const [id, list] of adjacency) sorted.set(id, [...list].sort((a, b) => a.to.localeCompare(b.to)));
  return {
    graph: { nodes, edges: sorted }, waypoints, edges: walkEdges, connectors, aisles, seats, elevatorEdges, entryId: 'f1.entry-outside',
  };
}

let cached: OfficeNavigation | undefined;
/** Built once on first use; the authored data never changes at runtime. */
export function officeNavigation(): OfficeNavigation {
  cached ??= buildNavigation();
  return cached;
}

/** One leg of a route; `node` is the waypoint reached at its end. */
export type RouteStep =
  | { readonly kind: 'walk'; readonly node: string; readonly to: Point3; readonly stairs: boolean; readonly natural?: NaturalLeg }
  | { readonly kind: 'elevator'; readonly node: string; readonly elevatorId: ElevatorId; readonly from: OfficeFloor; readonly to: OfficeFloor; readonly exit: Point3 };

/** A* over the authored graph between two waypoint ids; null when unreachable. */
export function planRoute(fromId: string, toId: string, navigation = officeNavigation()): { steps: RouteStep[]; nodeIds: readonly string[]; cost: number } | null {
  const route = findRoute(navigation.graph, fromId, toId);
  if (!route) return null;
  const steps: RouteStep[] = [];
  for (let i = 1; i < route.nodeIds.length; i++) {
    const from = route.nodeIds[i - 1]!, to = route.nodeIds[i]!;
    const a = navigation.waypoints.get(from)!.position as Point3, b = navigation.waypoints.get(to)!.position as Point3;
    const elevatorId = navigation.elevatorEdges.get(`${from}|${to}`);
    if (elevatorId) steps.push({ kind: 'elevator', node: to, elevatorId, from: floorAt(a[1]), to: floorAt(b[1]), exit: [b[0], b[1], b[2]] });
    else steps.push({ kind: 'walk', node: to, to: [b[0], b[1], b[2]], stairs: Math.abs(a[1] - b[1]) > 1e-6 });
  }
  return { steps, nodeIds: route.nodeIds, cost: route.cost };
}

/**
 * Same trip with the other glass elevator: both cabs share their landing hall,
 * so riders can be spread over A and B without changing the rest of the route.
 */
export function withElevator(steps: readonly RouteStep[], elevatorId: ElevatorId, navigation = officeNavigation()): RouteStep[] {
  return steps.map((step, index) => {
    const next = steps[index + 1];
    if (step.kind === 'elevator') {
      const node = `f${step.to}.elevator-${elevatorId}`, exit = navigation.waypoints.get(node)!.position;
      return { ...step, elevatorId, node, exit: [exit[0], exit[1], exit[2]] };
    }
    if (next?.kind === 'elevator' && step.node.endsWith(`.elevator-${next.elevatorId}`)) {
      const node = `f${next.from}.elevator-${elevatorId}`, to = navigation.waypoints.get(node)!.position;
      return { ...step, node, to: [to[0], to[1], to[2]] };
    }
    return step;
  });
}

/** Waypoint position by id. */
export function waypointPosition(id: string, navigation = officeNavigation()): Point3 | undefined {
  const position = navigation.waypoints.get(id)?.position;
  return position ? [position[0], position[1], position[2]] : undefined;
}
