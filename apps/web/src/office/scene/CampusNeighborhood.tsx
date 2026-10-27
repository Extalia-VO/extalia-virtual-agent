import { useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh} from "three";
import { Color, Matrix4 } from "three";
import { CampusSkyline } from "./CampusSkyline";
import { CivicForecourtPark } from "./CivicForecourtPark";
import { CampusParking } from "./CampusParking";
import { CampusTraffic } from "./CampusTraffic";
import { FRONT_APPROACH } from "./campusSiteLayout";

type Slab = { x: number; y: number; z: number; width: number; height: number; depth: number; tone: string };

// Neighborhood ground sits just above the skyline ground (-0.8) and below the
// campus lawn block (bottom -0.68). Roads lie flush on it.
const PLANE_Y = -0.72;
const ROAD_TOP = FRONT_APPROACH.roadTop;
const ROAD_THICK = 0.03;
const ROAD_TONE = "#3b4248";
const DASH_TONE = "#e6e1d2";

// The west parking entrance meets the former front carriageway at z=-28.5.
// One ramp links the plinth top (-0.23) to the city avenue; unused stubs stay removed.
const CAMPUS_ROAD_Z = 28.5;
const CAMPUS_ROAD_END_X = 52;
const CAMPUS_ROAD_TOP = -0.23;
const CAMPUS_ROAD_WIDTH = 8;

// City-grid streets (CampusSkyline: BLOCK 24, offset 12) that the neighborhood
// connects into. Each line continues past the plane edge as a skyline street.
const AVENUE_X = 60;
const RING_X = 108;
const RING_SOUTH_Z = FRONT_APPROACH.roadCenterZ;
const RING_NORTH_Z = 108;
const CROSS_Z = 84;
const STREET = FRONT_APPROACH.roadWidth;

type Run = { axis: "x" | "z"; at: number; from: number; to: number; width: number };

/** Every street segment drawn on the neighborhood plane. */
const RUNS: readonly Run[] = [
  // Outer ring aligned with skyline streets; extends past the plane edge.
  { axis: "z", at: -RING_X, from: RING_SOUTH_Z - STREET / 2, to: 126, width: STREET },
  { axis: "z", at: RING_X, from: RING_SOUTH_Z - STREET / 2, to: 126, width: STREET },
  { axis: "x", at: RING_SOUTH_Z, from: -112, to: 112, width: STREET },
  { axis: "x", at: RING_NORTH_Z, from: -112, to: 112, width: STREET },
  // Avenues flanking the campus, tying the campus roads to the ring.
  { axis: "z", at: -AVENUE_X, from: RING_SOUTH_Z, to: RING_NORTH_Z, width: STREET },
  { axis: "z", at: AVENUE_X, from: RING_SOUTH_Z, to: RING_NORTH_Z, width: STREET },
  { axis: "x", at: CROSS_Z, from: -RING_X, to: RING_X, width: STREET },
];

const CROSS_LINES_X = [-RING_X, -AVENUE_X, AVENUE_X, RING_X];
const CROSS_LINES_Z = [RING_SOUTH_Z, CROSS_Z, RING_NORTH_Z];

function roadSlab(run: Run): Slab {
  const length = run.to - run.from;
  const mid = (run.from + run.to) / 2;
  const y = ROAD_TOP - ROAD_THICK / 2;
  return run.axis === "x"
    ? { x: mid, y, z: run.at, width: length, height: ROAD_THICK, depth: run.width, tone: ROAD_TONE }
    : { x: run.at, y, z: mid, width: run.width, height: ROAD_THICK, depth: length, tone: ROAD_TONE };
}

/** Dashed centre line, broken through every junction. */
function centreDashes(run: Run): Slab[] {
  const dashes: Slab[] = [];
  const junctions = run.axis === "x" ? CROSS_LINES_X : CROSS_LINES_Z;
  for (let s = run.from + 3; s <= run.to - 3; s += 6) {
    if (junctions.some((j) => Math.abs(j - s) < 6)) continue;
    const y = ROAD_TOP + 0.004;
    dashes.push(run.axis === "x"
      ? { x: s, y, z: run.at, width: 2.6, height: 0.008, depth: 0.14, tone: DASH_TONE }
      : { x: run.at, y, z: s, width: 0.14, height: 0.008, depth: 2.6, tone: DASH_TONE });
  }
  return dashes;
}

/** Pedestrian zebra crosswalk stripes & stop bars at key campus/district intersections. */
function buildCrosswalks(): Slab[] {
  const stripes: Slab[] = [];
  const y = ROAD_TOP + 0.005;
  const h = 0.009;
  const stripeLen = 2.4;
  const stripeW = 0.42;

  // 1. Main arrival crosswalk across the front ring road (x = 0, z = RING_SOUTH_Z)
  for (let z = RING_SOUTH_Z - 2.6; z <= RING_SOUTH_Z + 2.6; z += 0.85) {
    stripes.push({ x: 0, y, z, width: 3.4, height: h, depth: stripeW, tone: DASH_TONE });
  }
  for (const dir of [-1, 1]) {
    stripes.push({ x: dir * 3.2, y, z: RING_SOUTH_Z, width: 0.24, height: h, depth: STREET - 0.8, tone: DASH_TONE });
  }

  // 2. Avenue & cross-street intersection crosswalks
  const junctions: [number, number][] = [
    [-AVENUE_X, RING_SOUTH_Z],
    [AVENUE_X, RING_SOUTH_Z],
    [-AVENUE_X, CROSS_Z],
    [AVENUE_X, CROSS_Z]
  ];
  for (const [jx, jz] of junctions) {
    for (const side of [-1, 1]) {
      // North/south crossings across the avenue
      const cz = jz + side * (STREET / 2 + 1.8);
      for (let dx = -2.4; dx <= 2.4; dx += 0.8) {
        stripes.push({ x: jx + dx, y, z: cz, width: stripeW, height: h, depth: stripeLen, tone: DASH_TONE });
      }
      // East/west crossings across the cross street
      const cx = jx + side * (STREET / 2 + 1.8);
      for (let dz = -2.4; dz <= 2.4; dz += 0.8) {
        stripes.push({ x: cx, y, z: jz + dz, width: stripeLen, height: h, depth: stripeW, tone: DASH_TONE });
      }
    }
  }
  return stripes;
}

function InstanceSlabs({ name, slabs }: { name: string; slabs: readonly Slab[] }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const matrix = new Matrix4();
    const color = new Color();
    slabs.forEach((slab, index) => {
      matrix.makeScale(slab.width, slab.height, slab.depth);
      matrix.setPosition(slab.x, slab.y, slab.z);
      mesh.current!.setMatrixAt(index, matrix);
      mesh.current!.setColorAt(index, color.set(slab.tone));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [slabs]);

  return (
    <instancedMesh name={name} ref={mesh} args={[undefined, undefined, slabs.length]} receiveShadow>
      <boxGeometry args={[1, 1, 1]} />
      <meshStandardMaterial color="#ffffff" roughness={0.95} />
    </instancedMesh>
  );
}

/** The single parking access ramp joins the plinth to the west avenue. */
function CampusRoadRamps() {
  const run = AVENUE_X - STREET / 2 - CAMPUS_ROAD_END_X;
  const drop = CAMPUS_ROAD_TOP - ROAD_TOP;
  const length = Math.hypot(run, drop);
  const slope = Math.atan2(drop, run);
  const centreY = (CAMPUS_ROAD_TOP + ROAD_TOP) / 2 - ROAD_THICK;
  return (
    <group name="neighborhood-campus-ramps">
      {[-1].flatMap((side) => [-CAMPUS_ROAD_Z].map((z) => (
        <mesh
          key={`${side}:${z}`}
          receiveShadow
          position={[side * (CAMPUS_ROAD_END_X + run / 2), centreY, z]}
          rotation={[0, 0, -side * slope]}
        >
          <boxGeometry args={[length + 0.4, ROAD_THICK * 2, CAMPUS_ROAD_WIDTH]} />
          <meshStandardMaterial color={ROAD_TONE} roughness={0.95} />
        </mesh>
      )))}
    </group>
  );
}

// City sidewalks: a 3 m footway on the campus side of each flanking avenue and
// along the front ring road, joined to the campus boulevard sidewalks
// (z = ±35, ending at x = ±48) by gentle pedestrian ramps off the plinth edge.
const SIDEWALK_TONE = "#c9c5bb";
const PLAZA_APRON_TONE = "#d3cfc5";
const DISTRICT_LAWN_TONE = "#567850";
const CITY_WALK_TOP = ROAD_TOP + 0.03;
const CITY_WALK_W = 3;
// Matches the Landscape boulevard sidewalk top (WALK_TOP - 0.02 centre + 0.02).
const CAMPUS_WALK_TOP = -0.225;
const PLINTH_EDGE_X = 52;
const WALK_LINK_Z = 35;
const WALK_LINK_W = 4.8;
const AVENUE_INNER_X = AVENUE_X - STREET / 2;
const AVENUE_OUTER_X = AVENUE_X + STREET / 2;
const RING_INNER_X = RING_X - STREET / 2;
const FRONT_EDGE_Z = FRONT_APPROACH.roadEdgeZ;

/** Splits [from, to] around the given gaps so footways never overlap ramps. */
function gapped(from: number, to: number, gaps: [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  let start = from;
  for (const [a, b] of [...gaps].sort((p, q) => p[0] - q[0]!)) {
    if (a > start) out.push([start, Math.min(a, to)]);
    start = Math.max(start, b);
  }
  if (start < to) out.push([start, to]);
  return out;
}

function buildCityWalks(): Slab[] {
  const slabs: Slab[] = [];
  const thick = 0.04;
  const y = CITY_WALK_TOP - thick / 2;
  const x0 = AVENUE_INNER_X - CITY_WALK_W;
  const xOuter = AVENUE_OUTER_X + CITY_WALK_W / 2;
  // One gap per side covering the vehicle ramp (z = ±28.5, 8 m wide) and the
  // adjacent pedestrian ramp (z = ±35), which both cross the footway band.
  const near = CAMPUS_ROAD_Z - CAMPUS_ROAD_WIDTH / 2 - 0.2;
  const far = WALK_LINK_Z + WALK_LINK_W / 2 + 0.2;
  const zGaps: [number, number][] = [[-far, -near], [near, far]] as const;
  for (const side of [-1, 1]) {
    for (const [a, b] of gapped(FRONT_EDGE_Z, CROSS_Z - STREET / 2, zGaps)) {
      slabs.push({ x: side * (x0 + CITY_WALK_W / 2), y, z: (a + b) / 2, width: CITY_WALK_W, height: thick, depth: b - a, tone: SIDEWALK_TONE });
    }
    // Outer avenue footway fronting the west and east district building blocks
    const span = (CROSS_Z - STREET / 2) - FRONT_EDGE_Z;
    slabs.push({ x: side * xOuter, y, z: (FRONT_EDGE_Z + CROSS_Z - STREET / 2) / 2, width: CITY_WALK_W, height: thick, depth: span, tone: SIDEWALK_TONE });
    // District block stone forecourt aprons & green verge strips between avenue and ring road
    const blockMidX = side * ((AVENUE_OUTER_X + CITY_WALK_W + RING_INNER_X) / 2);
    const blockW = RING_INNER_X - (AVENUE_OUTER_X + CITY_WALK_W);
    for (const [bz, bd, planted] of [[-44, 20, false], [0, 32, false], [45, 20, true], [67, 20, false]] as const) {
      slabs.push({ x: blockMidX, y: y - 0.004, z: bz, width: blockW, height: thick, depth: bd, tone: PLAZA_APRON_TONE });
      if (planted) {
        slabs.push({ x: side * (AVENUE_OUTER_X + CITY_WALK_W + 1.2), y: y + 0.008, z: bz, width: 1.8, height: thick, depth: bd - 2, tone: DISTRICT_LAWN_TONE });
      }
    }
    // Green pocket lawn strips between the West/East district towers (z = -25 and z = 25)
    for (const gz of [-24, 24]) {
      slabs.push({ x: blockMidX, y: y + 0.005, z: gz, width: blockW - 2, height: thick, depth: 11, tone: DISTRICT_LAWN_TONE });
    }
  }
  // Rear district block (z = 48..80.5, x = -53.5..53.5): south sidewalk + courtyard aprons + green median
  const rearSpanW = x0 * 2;
  slabs.push({ x: 0, y, z: 48.5, width: rearSpanW, height: thick, depth: CITY_WALK_W, tone: SIDEWALK_TONE });
  slabs.push({ x: 0, y, z: CROSS_Z - STREET / 2 - CITY_WALK_W / 2, width: rearSpanW, height: thick, depth: CITY_WALK_W, tone: SIDEWALK_TONE });
  slabs.push({ x: 0, y: y - 0.004, z: 64.5, width: rearSpanW, height: thick, depth: 29, tone: PLAZA_APRON_TONE });
  for (const gx of [-27, -2, 23]) {
    slabs.push({ x: gx, y: y + 0.006, z: 54, width: 7.5, height: thick, depth: 5.5, tone: DISTRICT_LAWN_TONE });
  }
  // Front ring-road footway, gapped where the arrival walkway ramp lands.
  const fz = FRONT_EDGE_Z + CITY_WALK_W / 2;
  for (const [a, b] of gapped(-x0, x0, [[-(FRONT_APPROACH.width / 2 + 0.8), FRONT_APPROACH.width / 2 + 0.8]] as const)) {
    slabs.push({ x: (a + b) / 2, y, z: fz, width: b - a, height: thick, depth: CITY_WALK_W, tone: SIDEWALK_TONE });
  }
  // Flat link across the plinth rim from the boulevard sidewalk to the plinth edge.
  for (const side of [-1, 1]) {
    for (const z of [-WALK_LINK_Z, WALK_LINK_Z]) {
      slabs.push({ x: side * 50, y: CAMPUS_WALK_TOP - 0.02, z, width: 4, height: 0.04, depth: WALK_LINK_W, tone: SIDEWALK_TONE });
    }
  }
  return slabs;
}

/** Pedestrian ramps from the plinth edge down to the avenue footways. */
function CityWalkRamps() {
  const run = AVENUE_INNER_X - PLINTH_EDGE_X;
  const drop = CAMPUS_WALK_TOP - CITY_WALK_TOP;
  const length = Math.hypot(run, drop);
  const slope = Math.atan2(drop, run);
  const centreY = (CAMPUS_WALK_TOP + CITY_WALK_TOP) / 2 - 0.02;
  return (
    <group name="neighborhood-walk-ramps">
      {[-1, 1].flatMap((side) => [-WALK_LINK_Z, WALK_LINK_Z].map((z) => (
        <mesh key={`${side}:${z}`} receiveShadow position={[side * (PLINTH_EDGE_X + run / 2), centreY, z]} rotation={[0, 0, -side * slope]}>
          <boxGeometry args={[length + 0.2, 0.04, WALK_LINK_W]} />
          <meshStandardMaterial color={SIDEWALK_TONE} roughness={0.92} />
        </mesh>
      )))}
    </group>
  );
}

/**
 * Neighborhood ground and street network. Parking access and pedestrian ramps
 * join the flanking avenues and outer ring, aligned with the skyline grid.
 * District facades, civic park optics and the shared campus lights react at night.
 */
export function CampusNeighborhood() {
  const roads = useMemo(() => RUNS.map(roadSlab), []);
  const dashes = useMemo(() => [...RUNS.flatMap(centreDashes), ...buildCrosswalks()], []);
  const walks = useMemo(() => buildCityWalks(), []);

  return (
    <group name="campus-neighborhood-backdrop" userData={{ officePassable: true, officeCollision: false }}>
      <mesh position={[0, PLANE_Y, 30]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
        <planeGeometry args={[210, 190]} />
        <meshStandardMaterial color="#819088" roughness={1} />
      </mesh>
      <InstanceSlabs name="neighborhood-roads" slabs={roads} />
      <InstanceSlabs name="neighborhood-road-markings" slabs={dashes} />
      <InstanceSlabs name="neighborhood-city-walks" slabs={walks} />
      <CampusRoadRamps />
      <CampusParking />
      <CampusTraffic />
      <CityWalkRamps />

      {/* Front civic park with paved promenades, fountain, grove trees and lighting */}
      <CivicForecourtPark />

      {/* Modern district ring plus the metropolitan skyline, with day/night facade glow. */}
      <CampusSkyline />
    </group>
  );
}
