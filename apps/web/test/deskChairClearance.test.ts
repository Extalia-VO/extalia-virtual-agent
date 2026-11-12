import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial } from 'three';
import { isDeskChair } from '../src/office/scene/interior/deskChairs';
import { SINGLE_WORKSTATION_BLUEPRINT, TEAM_POD_SEAT } from '../src/office/scene/interior/spatialBlueprints';
import { TEAM_POD_STRUCTURE_FOOTPRINT } from '../src/office/scene/interior/teamPodDesktopGeometry';
import type { Point3 } from '../src/office/scene/layout';
import { CHAIR_FRONT_APPROACH, GRIP_STAND, chairWalkPath, chairWorld, sittingCentre, smooth01, standPull } from '../src/office/scene/movement/chairChoreography';
import { WalkingClearance } from '../src/office/scene/movement/naturalClearance';
import { officeNavigation, seatStageId, type SeatApproach } from '../src/office/scene/movement/navGraph';

const deskSeats = [...officeNavigation().seats.values()].filter(seat => isDeskChair(seat.seatId));

function choreographyPoints(seat: SeatApproach, side: 1 | -1, samples = 1000): Point3[] {
  const points: Point3[] = [seat.seat, seat.staging,
    ...['grip-walk', 'walk-out', 'walk-sit'].flatMap(beat => chairWalkPath(seat, beat, side))];
  for (let index = 0; index <= samples; index++) {
    const t = index / samples;
    points.push(chairWorld(seat, t, GRIP_STAND[0], 0, GRIP_STAND[1], [0, 0, 0], side),
      chairWorld(seat, standPull(t), 0, 0, CHAIR_FRONT_APPROACH * smooth01((t - .6) / .4), [0, 0, 0], side),
      chairWorld(seat, 1, 0, 0, CHAIR_FRONT_APPROACH * (1 - smooth01(t)), [0, 0, 0], side),
      sittingCentre(seat, t, [0, 0, 0], side));
  }
  return points;
}

function fixture(yaw = 0, y = 0, collider = true) {
  const root = new Group(), chair = new Group(), field = new WalkingClearance();
  root.position.y = y; chair.rotation.y = yaw; chair.userData.officeSeat = true; root.add(chair);
  if (collider) {
    const mesh = new Mesh(new BoxGeometry(.64, 1.3, .64), new MeshBasicMaterial()); mesh.position.set(0, .65, -.02); chair.add(mesh);
  }
  const local = (x: number, z: number): Point3 => [x * Math.cos(yaw) + z * Math.sin(yaw), y, -x * Math.sin(yaw) + z * Math.cos(yaw)];
  const seat: SeatApproach = { seatId: 'example-desk', roomId: 'example-office', floor: y ? 2 : 1, seatStyle: 'office',
    seat: [0, y, 0], staging: local(0, -1.2), rotationY: yaw, seatHeight: .46, sitMs: 850, standMs: 760 };
  const rebuild = () => field.rebuild([root]);
  return { root, chair, field, seat, local, rebuild };
}

function obstacle(root: Group, position: Point3, asChair = false) {
  const group = new Group(); group.position.set(...position); group.userData.officeSeat = asChair;
  const mesh = new Mesh(new BoxGeometry(.4, 1.2, .2), new MeshBasicMaterial()); mesh.position.y = .6;
  group.add(mesh); root.add(group); return group;
}

describe('desk chair authored choreography envelope', () => {
  it('contains both sides of every authored desk stage, walk, stand, pull, lower and scoot', () => {
    const extrema = { count: deskSeats.length, maxX: 0, minZ: 0, maxZ: 0 };
    for (const seat of deskSeats) for (const side of [-1, 1] as const) for (const point of choreographyPoints(seat, side)) {
      const dx = point[0] - seat.seat[0], dz = point[2] - seat.seat[2], c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
      const x = dx * c - dz * s, z = dx * s + dz * c;
      extrema.maxX = Math.max(extrema.maxX, Math.abs(x)); extrema.minZ = Math.min(extrema.minZ, z); extrema.maxZ = Math.max(extrema.maxZ, z);
    }
    expect(extrema.count).toBeGreaterThan(50);
    expect(extrema.maxX).toBeCloseTo(1.5); expect(extrema.minZ).toBeCloseTo(-1.56); expect(extrema.maxZ).toBeCloseTo(0);
  });

  it('admits every authored desk root sample without broadening the fixed envelope', () => {
    const h = workstationContactFixture(); h.rebuild();
    for (const actual of deskSeats) {
      const dx = actual.staging[0] - actual.seat[0], dz = actual.staging[2] - actual.seat[2], c = Math.cos(actual.rotationY), s = Math.sin(actual.rotationY);
      const seat: SeatApproach = { ...actual, seat: [0, 0, 0], rotationY: 0, floor: 1, staging: [dx * c - dz * s, 0, dx * s + dz * c] };
      for (const side of [-1, 1] as const) for (const point of choreographyPoints(seat, side, 20)) {
        expect(h.field.chairMotionClear(seat, point, point)).toBe(true);
      }
    }
  });
});

describe('controlled desk-chair static clearance', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('masks only its own chair at yaw %s', yaw => {
    const h = fixture(yaw); h.rebuild();
    expect(h.field.segmentClear(h.seat.seat, h.local(0, -.7), .29)).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.7))).toBe(true);
  });

  it('does not mask a foreign desk, wall, or neighboring chair', () => {
    for (const asChair of [false, true]) {
      const h = fixture(); obstacle(h.root, [.15, 0, -.8], asChair); h.rebuild();
      expect(h.field.chairMotionClear(h.seat, h.local(0, -.4), h.local(0, -1.2))).toBe(false);
    }
    const h = fixture(); obstacle(h.root, [.7, 0, -.8]); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.local(.7, -1.2), h.local(.7, -.4))).toBe(false);
  });

  it('uses ordinary static clearance for instanced-chair anchors without their own collider', () => {
    const h = fixture(0, 0, false); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.7))).toBe(true);
    obstacle(h.root, [.15, 0, -.8]); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -1.2))).toBe(false);
  });

  it('never turns a missing or unrelated owner into authority over another collider', () => {
    const h = fixture(); delete h.chair.userData.officeSeat; h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.7))).toBe(false);
    const other = fixture(); other.chair.position.x = 3; obstacle(other.root, [0, 0, -.4]); other.rebuild();
    expect(other.field.chairMotionClear(other.seat, other.seat.seat, other.local(0, -.7))).toBe(false);
  });

  it('preserves upper-floor support requirements', () => {
    const h = fixture(0, 6.4); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -1.2))).toBe(false);
    const floor = new Mesh(new BoxGeometry(5, .1, 5), new MeshBasicMaterial()); floor.position.y = -.05; h.root.add(floor); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -1.2))).toBe(true);
    h.root.remove(floor); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -1.2))).toBe(false);
  });

  it('rejects unrelated seating, other floors, invalid input and travel outside the authored envelope', () => {
    const h = fixture(); h.rebuild();
    for (const seatStyle of ['meeting', 'guest', 'sofa', 'armchair', 'barstool', 'bench', 'patio', 'none'] as const)
      expect(h.field.chairMotionClear({ ...h.seat, seatStyle }, h.seat.seat, h.local(0, -.7))).toBe(false);
    expect(h.field.chairMotionClear({ ...h.seat, standing: true }, h.seat.seat, h.local(0, -.7))).toBe(false);
    for (const point of [[1.56, 0, -.8], [0, 0, -1.62], [0, 0, .06], [0, 6.4, -.8], [NaN, 0, -.8]] as Point3[])
      expect(h.field.chairMotionClear(h.seat, h.seat.seat, point)).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.7), -1)).toBe(false);
    expect(h.field.chairMotionClear({ ...h.seat, rotationY: NaN }, h.seat.seat, h.local(0, -.7))).toBe(false);
  });
});

describe('flex desk stage geometry regression', () => {
  it('clears the rendered desktop throughout arrival, chair-grip approach and departure for all four desks', () => {
    const navigation = officeNavigation(), seats = deskSeats.filter(seat => seat.seatId.startsWith('flex.station-'));
    expect(seats).toHaveLength(4);
    const root = new Group(), field = new WalkingClearance();
    const floor = new Mesh(new BoxGeometry(40, .1, 40), new MeshBasicMaterial()); floor.position.y = 12.75; root.add(floor);
    for (const seat of seats) {
      const yaw = seat.rotationY - Math.PI, forward = SINGLE_WORKSTATION_BLUEPRINT.chairPosition[2] - .02;
      const top = new Mesh(new BoxGeometry(...SINGLE_WORKSTATION_BLUEPRINT.topSize), new MeshBasicMaterial());
      top.position.set(seat.seat[0] + Math.sin(seat.rotationY) * forward, seat.seat[1] + SINGLE_WORKSTATION_BLUEPRINT.topY,
        seat.seat[2] + Math.cos(seat.rotationY) * forward); top.rotation.y = yaw; root.add(top);
    }
    field.rebuild([root]);
    for (const seat of seats) {
      const c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
      const local = (x: number, z: number): Point3 => [seat.seat[0] + x * c + z * s, seat.seat[1], seat.seat[2] - x * s + z * c];
      const sign = (seat.staging[0] - seat.seat[0]) * c - (seat.staging[2] - seat.seat[2]) * s > 0 ? 1 : -1;
      const grip = chairWalkPath(seat, 'grip-walk', 1)[0]!;
      expect(field.segmentClear(local(sign * 1.05, 0), local(sign * 1.05, 0), .29)).toBe(false);
      // 1.20m clears the endpoint but still clips the corner diagonally.
      expect(field.segmentClear(local(sign * 1.2, 0), local(sign * 1.2, 0), .29)).toBe(true);
      expect(field.segmentClear(local(sign * 1.2, 0), grip, .29)).toBe(false);
      expect(field.segmentClear(seat.staging, seat.staging, .29)).toBe(true);
      expect(field.segmentClear(seat.staging, grip, .29)).toBe(true);
      expect(field.chairMotionClear(seat, seat.staging, grip)).toBe(true);
      expect(field.chairMotionClear(seat, grip, seat.staging)).toBe(true);
      const incoming = navigation.graph.edges.get(seatStageId(seat.seatId))!;
      expect(incoming.length).toBeGreaterThan(0);
      for (const edge of incoming) expect(field.segmentClear(navigation.waypoints.get(edge.to)!.position, seat.staging, .29)).toBe(true);
    }
  });
});

function workstationContactFixture(yaw = 0, y = 0) {
  const h = fixture(yaw, y, false); h.root.remove(h.chair);
  const station = new Group(); station.userData.officeSeatStation = true; h.root.add(station);
  h.chair.position.set(-Math.sin(yaw) * .02, 0, -Math.cos(yaw) * .02); station.add(h.chair);
  const top = new Mesh(new BoxGeometry(...SINGLE_WORKSTATION_BLUEPRINT.topSize), new MeshBasicMaterial());
  top.position.set(Math.sin(yaw) * .62, SINGLE_WORKSTATION_BLUEPRINT.topY, Math.cos(yaw) * .62);
  top.rotation.y = yaw; station.add(top);
  return { ...h, station, top };
}

describe('owned workstation seated contact apron', () => {
  it.each([0, Math.PI / 2, Math.PI, -Math.PI / 2])('allows exact authored stand and reverse scoot contact at yaw %s', yaw => {
    const h = workstationContactFixture(yaw); h.rebuild();
    expect(h.field.segmentClear(h.seat.seat, h.seat.seat, .29)).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.seat.seat)).toBe(true);
    for (const side of [-1, 1] as const) {
      let previous = h.seat.seat;
      for (let sample = 0; sample <= 100; sample++) {
        const t = sample / 100, point = chairWorld(h.seat, standPull(t), 0, 0, CHAIR_FRONT_APPROACH * smooth01((t - .6) / .4), [0, 0, 0], side);
        expect(h.field.chairMotionClear(h.seat, previous, point)).toBe(true); previous = point;
      }
      for (let sample = 0; sample <= 100; sample++) {
        const point = sittingCentre(h.seat, sample / 100, [0, 0, 0], side);
        expect(h.field.chairMotionClear(h.seat, point, point)).toBe(true);
        if (sample) {
          const earlier = sittingCentre(h.seat, (sample - 1) / 100, [0, 0, 0], side);
          expect(h.field.chairMotionClear(h.seat, point, earlier)).toBe(true);
        }
      }
      for (const beat of ['walk-sit', 'walk-out']) {
        const points = chairWalkPath(h.seat, beat, side);
        if (beat === 'walk-out') points.unshift(chairWorld(h.seat, 1, 0, 0, CHAIR_FRONT_APPROACH, [0, 0, 0], side));
        for (let i = 1; i < points.length; i++) expect(h.field.chairMotionClear(h.seat, points[i - 1]!, points[i]!)).toBe(true);
      }
    }
  });

  it('never extends own tabletop contact into lateral cuts, forward walking, foreign furniture or chair legs', () => {
    const h = workstationContactFixture(); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(.2, 0))).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, .1))).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, .6))).toBe(false);
    const foreign = new Group(); foreign.userData.officeSeatStation = true; foreign.add(h.top.clone()); h.root.add(foreign); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.1))).toBe(false);
    h.root.remove(foreign);
    const leg = new Mesh(new BoxGeometry(.05, .8, .05), new MeshBasicMaterial()); leg.position.set(.25, .4, -.05); h.station.add(leg); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.1))).toBe(false);
  });

  it('requires the exact seat anchor and facing, without relaxing unsupported floors', () => {
    const h = workstationContactFixture(); h.chair.position.x += .1; h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.1))).toBe(false);
    h.chair.position.x -= .1; h.chair.rotation.y = Math.PI; h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.1))).toBe(false);
    const upper = workstationContactFixture(0, 6.4); upper.rebuild();
    expect(upper.field.chairMotionClear(upper.seat, upper.seat.seat, upper.local(0, -.1))).toBe(false);
    const floor = new Mesh(new BoxGeometry(4, .1, 4), new MeshBasicMaterial()); floor.position.y = -.05; upper.root.add(floor); upper.rebuild();
    expect(upper.field.chairMotionClear(upper.seat, upper.seat.seat, upper.local(0, -.1))).toBe(true);
  });

  it('permits measured thin own input contact but keeps foreign inputs and forward travel solid', () => {
    const h = workstationContactFixture();
    const input = new Mesh(new BoxGeometry(.16, .028, .16), new MeshBasicMaterial()); input.position.set(.21, .82, .21); h.station.add(input); h.rebuild();
    expect(h.field.segmentClear(h.seat.seat, h.seat.seat, .18)).toBe(false);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.seat.seat)).toBe(true);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, [.21, 0, .21])).toBe(false);
    const foreign = input.clone(); h.root.add(foreign); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.seat.seat)).toBe(false);
  });

  it('retains full body clearance outside the apron during a complete preflight leg', () => {
    const h = workstationContactFixture();
    const misplacedInput = new Mesh(new BoxGeometry(.08, .028, .12), new MeshBasicMaterial()); misplacedInput.position.set(.2, .82, -.6); h.station.add(misplacedInput); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.local(0, -1.2), h.seat.seat)).toBe(false);
    h.station.remove(misplacedInput); h.rebuild();
    expect(h.field.chairMotionClear(h.seat, h.local(0, -.5), h.seat.seat)).toBe(true);
    expect(h.field.chairMotionClear(h.seat, h.seat.seat, h.local(0, -.5))).toBe(true);
  });

  it('pairs a shared pod tabletop only with its own sibling station and preserves its solid outline', () => {
    const root = new Group(), pod = new Group(), station = new Group(), anchor = new Group(), surface = new Group(), field = new WalkingClearance();
    station.userData.officeSeatStation = true; anchor.userData.officeSeat = true;
    anchor.position.set(TEAM_POD_SEAT.chairPosition[0], 0, TEAM_POD_SEAT.chairPosition[1]); anchor.rotation.y = TEAM_POD_SEAT.chairRotationY;
    surface.userData = { teamPodAuthored: false, officeCollisionFootprint: TEAM_POD_STRUCTURE_FOOTPRINT };
    pod.add(surface, station); station.add(anchor); root.add(pod); root.updateWorldMatrix(true, true);
    const keyboard = new Mesh(new BoxGeometry(.3061, .028, .309), new MeshBasicMaterial()); keyboard.position.set(.7881, .82, .7748); station.add(keyboard);
    const yaw = TEAM_POD_SEAT.chairRotationY, seat: SeatApproach = { ...fixture().seat,
      seat: [anchor.position.x + Math.sin(yaw) * .02, 0, anchor.position.z + Math.cos(yaw) * .02], rotationY: yaw };
    field.rebuild([root]); expect(field.segmentClear(seat.seat, seat.seat, .29)).toBe(false);
    expect(field.segmentClear(seat.seat, seat.seat, .18)).toBe(false);
    expect(field.chairMotionClear(seat, seat.seat, seat.seat)).toBe(true);
    for (const side of [-1, 1] as const) {
      let previous = seat.seat;
      for (let sample = 0; sample <= 100; sample++) {
        const t = sample / 100, next = chairWorld(seat, standPull(t), 0, 0, CHAIR_FRONT_APPROACH * smooth01((t - .6) / .4), [0, 0, 0], side);
        expect(field.chairMotionClear(seat, previous, next), `side=${side} t=${t} from=${previous} to=${next}`).toBe(true); previous = next;
      }
      for (const beat of ['walk-sit', 'walk-out']) {
        const points = chairWalkPath(seat, beat, side);
        if (beat === 'walk-out') points.unshift(chairWorld(seat, 1, 0, 0, CHAIR_FRONT_APPROACH, [0, 0, 0], side));
        for (let i = 1; i < points.length; i++) {
          const from = points[i - 1]!, to = points[i]!;
          expect(field.chairMotionClear(seat, from, to), `side=${side} beat=${beat} leg=${i}`).toBe(true);
        }
      }
    }
    expect(field.chairMotionClear(seat, seat.seat, [0, 0, 0])).toBe(false);
    const foreign = new Group(); foreign.add(surface.clone()); root.add(foreign); field.rebuild([root]);
    expect(field.chairMotionClear(seat, seat.seat, seat.seat)).toBe(false);
  });
});
