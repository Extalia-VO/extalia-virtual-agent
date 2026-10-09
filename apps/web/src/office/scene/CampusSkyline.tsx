/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type {
  InstancedMesh,
  Matrix4} from "three";
import {
  AdditiveBlending,
  BoxGeometry,
  CircleGeometry,
  Color,
  CylinderGeometry,
  IcosahedronGeometry,
  InstancedBufferAttribute,
  MathUtils,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  PlaneGeometry,
  RingGeometry,
  SphereGeometry,
  type BufferGeometry,
  type Material
} from "three";
import { useSolarEnvironment } from "./Environment";

/*
 * Metropolitan skyline backdrop for the campus overview.
 *
 * Everything here is instanced (about a dozen draw calls in total). The tower
 * facades share one patched MeshStandardMaterial: windows, lit offices,
 * daylight sky reflections and aerial haze are all computed in the shader from
 * world position, so the day/night response costs a few uniform writes per
 * frame. The parent group is passable and collision-free; every instance sits
 * at r >= 100 m, far outside the navigation grid and the forecourt corridor.
 */

const GROUND_Y = -0.8;
const BLOCK = 24;
const STREET_WIDTH = 7;
const CITY_RADIUS = 250;
const TOWER_MIN_RADIUS = 100;
const TOWER_MAX_RADIUS = CITY_RADIUS - 22;
const SHADOW_Y = -0.735;

const GLASS_TONES = ["#8ea5b6", "#a3b6c3", "#7b92a5", "#b6c4cd", "#6d8395", "#9db0b8", "#88a1b0", "#c2ccd3", "#7f97a8", "#5f7688"];
const SLATE_TONES = ["#6a7b88", "#7a8994", "#5d6c78", "#8a959c"];
const STONE_TONES = ["#b9bfc0", "#c7c7c0", "#b4bdc1", "#d0cec5", "#c8cdc9", "#bcc5c6"];
const PODIUM_TONE = "#a4abae";
const MECH_TONE = "#5a636b";
const STREET_TONE = "#3d4348";
const PARK_TONE = "#62805c";
const PLAZA_TONE = "#a9aaa3";
const FOLIAGE_TONES = ["#4f7448", "#5d8452", "#466a42", "#6b8f58"];

const FLOOR = 3.6;
const FIN_TONE = "#d5dbe0";
const MULLION_TONE = "#47515b";
const BALUSTRADE_TONE = "#9fb3be";
const TERRACE_TONES = ["#5d8452", "#6b8f58"];

export type DistrictKind = "tower" | "stepped" | "fins" | "residential";
export type DistrictBuilding = { x: number; z: number; w: number; d: number; h: number; kind: DistrictKind; tone: string };

// Modern district right around the HQ plot (HQ: 46 x 38 m, ~20 m tall).
// Buildings fill the street blocks drawn by CampusNeighborhood: avenues at
// x = ±60, cross streets at z = ±28.5 (continuing the campus carriageways) and
// z = 84, ring on x = ±108 / z = -60 / z = 108. Every envelope (podium, fins,
// balconies included) stays behind the 3 m sidewalks, so side blocks span
// x 66.5..101.5 and the rear block x ±53.5, z 52..77.5.
// Side blocks carry the high-rise massing (36-112 m) that frames the HQ; the
// rear block stays mid-rise, lowest on the overview sight line, so the sky band
// above the HQ remains clear in the default overview.
export const DISTRICT_BUILDINGS: readonly DistrictBuilding[] = [
  // West blocks: front (z -53.5..-35), middle (z ±22), rear (z 35..77.5).
  { x: -84, z: -44, w: 26, d: 16, h: 42, kind: "fins", tone: "#9db0b8" },
  { x: -84, z: 0, w: 26, d: 26, h: 96, kind: "tower", tone: "#7b92a5" },
  { x: -84, z: 45, w: 28, d: 16, h: 58, kind: "stepped", tone: "#b6c4cd" },
  { x: -84, z: 67, w: 26, d: 16, h: 74, kind: "tower", tone: "#88a1b0" },
  // Rear block behind the HQ.
  { x: -40, z: 65, w: 22, d: 20, h: 40, kind: "stepped", tone: "#c2ccd3" },
  { x: -14, z: 65, w: 20, d: 18, h: 30, kind: "residential", tone: "#d0cec5" },
  { x: 10, z: 65, w: 18, d: 18, h: 26, kind: "fins", tone: "#a3b6c3" },
  { x: 36, z: 66, w: 20, d: 18, h: 24, kind: "residential", tone: "#c8cdc9" },
  // East blocks.
  { x: 84, z: -44, w: 26, d: 16, h: 36, kind: "residential", tone: "#bcc5c6" },
  { x: 84, z: 0, w: 28, d: 24, h: 112, kind: "tower", tone: "#6d8395" },
  { x: 84, z: 45, w: 26, d: 16, h: 50, kind: "fins", tone: "#8ea5b6" },
  { x: 84, z: 67, w: 24, d: 16, h: 82, kind: "tower", tone: "#7f97a8" }
];

// Default overview/stack eyes (x, z) and their targets. No tower may stand
// between an eye and the HQ, so the campus always stays in front.
const VIEW_GUARDS = [
  { eye: [-32, -82], target: [0, -3] },
  { eye: [46, 48], target: [0, 0] }
] as const;

// Skyline density peaks. The tallest towers gather here, off the overview
// sight line so they frame the HQ instead of walling off the sky above it.
// Peaks are sized against the enlarged district (36-112 m) so the outer city
// keeps rising toward the horizon instead of reading as a low ring.
const CLUSTERS = [
  { x: 84, z: 150, peak: 74, spread: 60 },
  { x: -110, z: 120, peak: 66, spread: 56 },
  { x: 160, z: 20, peak: 54, spread: 52 },
  { x: -120, z: -110, peak: 48, spread: 54 }
];

const RESERVED_BLOCKS = new Set(["96,144", "-24,120", "0,120", "144,72", "-120,-96", "-168,48"]);

type Box = { x: number; y: number; z: number; w: number; h: number; d: number; yaw: number; tone: string; seed: number };
type Cone = { x: number; y: number; z: number; sx: number; h: number; sz: number; yaw: number };
type Band = { x: number; y: number; z: number; w: number; d: number; yaw: number; warm: boolean };
type Beacon = { x: number; y: number; z: number; phase: number };
type Pad = { x: number; y: number; z: number; r: number };
type Footprint = { x: number; z: number; w: number; d: number; h: number };
type Tree = { x: number; y: number; z: number; s: number; tone: string };
type Pool = { x: number; z: number; r: number; tone: string };
type Tower = { x: number; z: number; yaw: number; seed: number };

interface City {
  facade: Box[];
  solid: Box[];
  cones: Cone[];
  bands: Band[];
  beacons: Beacon[];
  pads: Pad[];
  footprints: Footprint[];
  trees: Tree[];
  pools: Pool[];
}

function mulberry(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(list: readonly T[], value: number): T {
  return list[Math.min(list.length - 1, Math.floor(value * list.length))]!;
}

function blocksView(x: number, z: number, radius: number) {
  for (const { eye, target } of VIEW_GUARDS) {
    const fx = target[0] - eye[0]!;
    const fz = target[1] - eye[1]!;
    const length = Math.hypot(fx, fz);
    const ux = fx / length;
    const uz = fz / length;
    const rx = x - eye[0]!;
    const rz = z - eye[1]!;
    const depth = rx * ux + rz * uz;
    const side = Math.abs(-rx * uz + rz * ux);
    if (depth > -radius && depth < length + 12 && side < 75 + radius) return true;
  }
  return false;
}

/** Perpendicular distance from the default overview sight line, beyond the HQ. */
function overviewAxisOffset(x: number, z: number) {
  const { eye, target } = VIEW_GUARDS[0]!;
  const fx = target[0] - eye[0]!;
  const fz = target[1] - eye[1]!;
  const length = Math.hypot(fx, fz);
  return Math.abs(-(x - eye[0]!) * (fz / length) + (z - eye[1]!) * (fx / length));
}

function overlapsDistrict(x: number, z: number, half: number) {
  return DISTRICT_BUILDINGS.some((m) => Math.abs(m.x - x) < m.w / 2 + half + 6 && Math.abs(m.z - z) < m.d / 2 + half + 6);
}

/** Unit vector from a district building toward the HQ, snapped to the dominant axis. */
function frontAxis(b: DistrictBuilding) {
  const alongX = Math.abs(b.x) > Math.abs(b.z);
  const f = alongX ? -Math.sign(b.x) : -Math.sign(b.z);
  const L = alongX ? b.w : b.d;
  const A = alongX ? b.d : b.w;
  // along > 0 moves toward the HQ-facing facade; across slides along that facade.
  const place = (along: number, len: number, across: number, offset = 0) => alongX
    ? { lx: f * along, lz: offset, w: len, d: across }
    : { lx: offset, lz: f * along, w: across, d: len };
  return { L, A, place };
}

/** Glass curtain tower: stone podium, slim shaft with dark corner mullions, recessed lit crown. */
function curtainTower(city: City, t: Tower, b: DistrictBuilding) {
  const podiumTop = FLOOR * 2;
  const crownBase = b.h - FLOOR * 2;
  tier(city, t, GROUND_Y, b.w + 3, podiumTop - GROUND_Y, b.d + 3, PODIUM_TONE);
  band(city, t, podiumTop - 0.4, b.w + 3.2, b.d + 3.2, true);
  tier(city, t, podiumTop, b.w, crownBase - podiumTop, b.d, b.tone);
  tier(city, t, crownBase, b.w * 0.8, b.h - crownBase, b.d * 0.8, b.tone);
  band(city, t, crownBase - 0.3, b.w + 0.25, b.d + 0.25, false);
  band(city, t, b.h - 0.5, b.w * 0.8 + 0.2, b.d * 0.8 + 0.2, true);
  for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]] as const) {
    solid(city, t, podiumTop, 0.45, crownBase - podiumTop, 0.45, MULLION_TONE, sx * (b.w / 2), sz * (b.d / 2));
  }
  solid(city, t, b.h, b.w * 0.34, 2.2, b.d * 0.34, MECH_TONE);
  beacon(city, t, b.h + 2.5);
  addFootprint(city, t, b.w + 3, b.d + 3, b.h);
}

/** Office slab with deep vertical sun fins, recessed glazed lobby and a roof garden. */
function finnedOffice(city: City, t: Tower, b: DistrictBuilding) {
  const { L, A, place } = frontAxis(b);
  const podiumTop = FLOOR * 1.2;
  tier(city, t, GROUND_Y, b.w - 1.2, podiumTop - GROUND_Y, b.d - 1.2, PODIUM_TONE);
  tier(city, t, podiumTop, b.w, b.h - podiumTop, b.d, b.tone);
  const count = Math.max(3, Math.round(A / 2.4));
  for (let i = 0; i < count; i++) {
    const across = -A / 2 + (i + 0.5) * (A / count);
    for (const side of [1, -1]) {
      const fin = place(side * (L / 2 + 0.3), 0.6, 0.24, across);
      solid(city, t, podiumTop, fin.w, b.h - podiumTop + 0.6, fin.d, FIN_TONE, fin.lx, fin.lz);
    }
  }
  // Dark spandrel reveals every second floor on the flank facades.
  for (let y = podiumTop + FLOOR * 2; y < b.h - 1; y += FLOOR * 2) {
    for (const side of [1, -1]) {
      const reveal = place(0, L * 0.94, 0.12, side * (A / 2 + 0.06));
      solid(city, t, y, reveal.w, 0.3, reveal.d, MULLION_TONE, reveal.lx, reveal.lz);
    }
  }
  const roof = place(0, L - 1.6, A - 1.6);
  solid(city, t, b.h, roof.w, 0.25, roof.d, TERRACE_TONES[1]!, roof.lx, roof.lz);
  solid(city, t, b.h, b.w * 0.3, 2.4, b.d * 0.3, MECH_TONE);
  band(city, t, b.h - 0.5, b.w + 0.3, b.d + 0.3, false);
  addFootprint(city, t, b.w + 1.2, b.d + 1.2, b.h);
}

/** Corporate volume stepping down toward the HQ with planted terraces behind glass balustrades. */
function terracedOffice(city: City, t: Tower, b: DistrictBuilding) {
  const { L, A, place } = frontAxis(b);
  const spans = [0.46, 0.3, 0.24];
  const depths = [1, 0.7, 0.44];
  const total = b.h - GROUND_Y;
  let y = GROUND_Y;
  spans.forEach((span, i) => {
    const len = L * depths[i]!;
    const th = total * span;
    const centre = -(L - len) / 2;
    const body = place(centre, len, A);
    tier(city, t, y, body.w, th, body.d, b.tone, body.lx, body.lz);
    y += th;
    const [bx, bz] = local(t, body.lx, body.lz);
    city.bands.push({ x: bx, y: y - 0.5, z: bz, w: body.w + 0.2, d: body.d + 0.2, yaw: t.yaw, warm: true });
    const next = depths[i + 1]!;
    if (next === undefined) return;
    const strip = len - L * next;
    const front = centre + len / 2;
    const terrace = place(front - strip / 2, strip - 0.4, A - 0.8);
    solid(city, t, y, terrace.w, 0.22, terrace.d, TERRACE_TONES[i % 2]!, terrace.lx, terrace.lz);
    const rail = place(front - 0.1, 0.08, A - 0.4);
    solid(city, t, y, rail.w, 1.0, rail.d, BALUSTRADE_TONE, rail.lx, rail.lz);
    for (const across of [-A / 3, 0, A / 3]) {
      const spot = place(front - strip / 2, 0, 0, across);
      const [tx, tz] = local(t, spot.lx, spot.lz);
      city.trees.push({ x: tx, y: y + 1.1, z: tz, s: 1.2, tone: FOLIAGE_TONES[(i + 1) % FOLIAGE_TONES.length]! });
    }
  });
  const crown = place(-(L - L * depths[2]!) / 2, L * depths[2]! * 0.5, A * 0.4);
  solid(city, t, y, crown.w, 2.2, crown.d, MECH_TONE, crown.lx, crown.lz);
  addFootprint(city, t, b.w, b.d, b.h);
}

/** Residential slab: cantilevered balconies with glass balustrades, party-wall fins, roof pergola. */
function residentialSlab(city: City, t: Tower, b: DistrictBuilding) {
  const { L, A, place } = frontAxis(b);
  tier(city, t, GROUND_Y, b.w, b.h - GROUND_Y, b.d, b.tone);
  for (let y = FLOOR; y < b.h - 1; y += FLOOR) {
    const slab = place(L / 2 + 0.7, 1.4, A * 0.86);
    solid(city, t, y - 0.09, slab.w, 0.18, slab.d, FIN_TONE, slab.lx, slab.lz);
    const rail = place(L / 2 + 1.36, 0.06, A * 0.86);
    solid(city, t, y + 0.09, rail.w, 0.95, rail.d, BALUSTRADE_TONE, rail.lx, rail.lz);
  }
  for (const offset of [-A * 0.43, -A * 0.14, A * 0.14, A * 0.43]) {
    const fin = place(L / 2 + 0.7, 1.4, 0.22, offset);
    solid(city, t, FLOOR - 0.2, fin.w, b.h - FLOOR, fin.d, FIN_TONE, fin.lx, fin.lz);
  }
  const roof = place(0, L * 0.6, A * 0.6);
  solid(city, t, b.h, roof.w, 0.22, roof.d, TERRACE_TONES[0]!, roof.lx, roof.lz);
  solid(city, t, b.h + 2.4, roof.w, 0.16, roof.d, MULLION_TONE, roof.lx, roof.lz);
  band(city, t, b.h - 0.45, b.w + 0.2, b.d + 0.2, true);
  addFootprint(city, t, b.w + 3, b.d + 3, b.h);
}

const DISTRICT_BUILDERS: Record<DistrictKind, (city: City, t: Tower, b: DistrictBuilding) => void> = {
  tower: curtainTower,
  fins: finnedOffice,
  stepped: terracedOffice,
  residential: residentialSlab
};

function local(t: Tower, lx: number, lz: number): [number, number] {
  const c = Math.cos(t.yaw);
  const s = Math.sin(t.yaw);
  return [t.x + lx * c + lz * s, t.z - lx * s + lz * c];
}

function tier(city: City, t: Tower, y0: number, w: number, h: number, d: number, tone: string, lx = 0, lz = 0) {
  const [x, z] = local(t, lx, lz);
  city.facade.push({ x, y: y0 + h / 2, z, w, h, d, yaw: t.yaw, tone, seed: t.seed });
}

function solid(city: City, t: Tower, y0: number, w: number, h: number, d: number, tone: string, lx = 0, lz = 0) {
  const [x, z] = local(t, lx, lz);
  city.solid.push({ x, y: y0 + h / 2, z, w, h, d, yaw: t.yaw, tone, seed: t.seed });
}

function cone(city: City, t: Tower, y0: number, sx: number, h: number, sz: number) {
  city.cones.push({ x: t.x, y: y0, z: t.z, sx, h, sz, yaw: t.yaw });
}

function band(city: City, t: Tower, y: number, w: number, d: number, warm: boolean) {
  city.bands.push({ x: t.x, y, z: t.z, w, d, yaw: t.yaw, warm });
}

function beacon(city: City, t: Tower, y: number, lx = 0, lz = 0) {
  const [x, z] = local(t, lx, lz);
  city.beacons.push({ x, y, z, phase: (t.seed * 7.31 + lx * 0.4) % (Math.PI * 2) });
}

/** Curtain-wall slab: optional podium, then helipad or mechanical penthouse + mast. */
function glassSlab(city: City, t: Tower, w: number, d: number, h: number, tone: string, rand: () => number) {
  if (rand() < 0.45) tier(city, t, GROUND_Y, Math.min(w + 4, 16.5), 7.8, Math.min(d + 4, 16.5), PODIUM_TONE);
  tier(city, t, GROUND_Y, w, h - GROUND_Y, d, tone);
  if (h > 44 && rand() < 0.34) {
    city.pads.push({ x: t.x, y: h, z: t.z, r: Math.min(w, d) * 0.36 });
  } else {
    solid(city, t, h, w * 0.46, 3.2, d * 0.46, MECH_TONE);
    if (rand() < 0.35) {
      const mast = 8 + rand() * 8;
      cone(city, t, h + 3.2, 0.32, mast, 0.32);
      beacon(city, t, h + 3.2 + mast + 0.2);
    }
  }
  if (rand() < 0.4) band(city, t, h - 1.1, w + 0.25, d + 0.25, false);
  if (h > 44) {
    beacon(city, t, h + 0.4, w / 2 - 0.5, d / 2 - 0.5);
    beacon(city, t, h + 0.4, -w / 2 + 0.5, -d / 2 + 0.5);
  }
}

/** Corporate monolith with lit setbacks. */
function steppedMonolith(city: City, t: Tower, w: number, d: number, h: number, tone: string) {
  const splits = [0.52, 0.3, 0.18];
  const scales = [1, 0.8, 0.6];
  let y = GROUND_Y;
  const span = h - GROUND_Y;
  splits.forEach((split, index) => {
    const th = span * split;
    const tw = w * scales[index]!;
    const td = d * scales[index]!;
    tier(city, t, y, tw, th, td, tone);
    y += th;
    band(city, t, y - 0.6, tw + 0.2, td + 0.2, true);
  });
  solid(city, t, y, w * 0.34, 3, d * 0.34, MECH_TONE);
  beacon(city, t, y + 3.4);
}

/** Tapered landmark tower capped by a needle or an angled pyramid crown. */
function spireTower(city: City, t: Tower, w: number, d: number, h: number, tone: string, crown: { needle?: number; pyramid?: number }) {
  const splits = [0.62, 0.24, 0.14];
  const scales = [1, 0.82, 0.64];
  let y = GROUND_Y;
  const span = h - GROUND_Y;
  splits.forEach((split, index) => {
    tier(city, t, y, w * scales[index]!, span * split, d * scales[index]!, tone);
    y += span * split;
  });
  const tw = w * scales[2]!;
  const td = d * scales[2]!;
  band(city, t, y - 0.7, tw + 0.25, td + 0.25, true);
  band(city, t, y - 2.6, tw + 0.25, td + 0.25, true);
  let top = y;
  if (crown.pyramid) {
    cone(city, t, y, tw * Math.SQRT1_2, crown.pyramid, td * Math.SQRT1_2);
    top += crown.pyramid;
  } else {
    const needle = crown.needle ?? 12;
    solid(city, t, y, tw * 0.4, 2.4, td * 0.4, MECH_TONE);
    cone(city, t, y + 2.4, 1.0, needle, 1.0);
    top += 2.4 + needle;
  }
  beacon(city, t, top + 0.3);
}

function addFootprint(city: City, t: Tower, w: number, d: number, h: number) {
  city.footprints.push({ x: t.x, z: t.z, w, d, h });
}

function park(city: City, x: number, z: number, rand: () => number) {
  city.solid.push({ x, y: GROUND_Y + 0.035, z, w: BLOCK - STREET_WIDTH, h: 0.05, d: BLOCK - STREET_WIDTH, yaw: 0, tone: PARK_TONE, seed: 0 });
  const count = 6 + Math.floor(rand() * 5);
  for (let i = 0; i < count; i++) {
    const s = 2.2 + rand() * 1.5;
    city.trees.push({ x: x + (rand() - 0.5) * 13, y: GROUND_Y + s * 0.95, z: z + (rand() - 0.5) * 13, s, tone: pick(FOLIAGE_TONES, rand()) });
  }
}

function buildLandmarks(city: City) {
  // Landmarks are the tallest silhouettes (100-150 m), clearly above the
  // 112 m district tower so the skyline steps up away from the HQ.
  const spire: Tower = { x: 96, z: 144, yaw: 0, seed: 11.3 };
  spireTower(city, spire, 16.5, 16.5, 132, "#9cb3c4", { needle: 18 });
  addFootprint(city, spire, 16.5, 16.5, 150);

  // Twin towers joined by a sky bridge.
  for (const x of [-24, 0]) {
    const twin: Tower = { x, z: 120, yaw: 0, seed: 23.7 + x * 0.1 };
    spireTower(city, twin, 14.5, 14.5, 112, "#b0c0ca", { needle: 11 });
    addFootprint(city, twin, 14.5, 14.5, 123);
  }
  tier(city, { x: -12, z: 120, yaw: 0, seed: 29.1 }, 60, 9.5, 5.4, 6, "#5f7688");

  const pyramid: Tower = { x: 144, z: 72, yaw: 0, seed: 37.9 };
  spireTower(city, pyramid, 16.5, 16.5, 92, "#7b92a5", { pyramid: 20 });
  addFootprint(city, pyramid, 16.5, 16.5, 112);

  const monolith: Tower = { x: -120, z: -96, yaw: 0, seed: 41.2 };
  steppedMonolith(city, monolith, 16.5, 15, 104, "#6a7b88");
  addFootprint(city, monolith, 16.5, 15, 107);

  const HELI_TOP = 98;
  const heliTower: Tower = { x: -168, z: 48, yaw: Math.PI / 4, seed: 53.4 };
  tier(city, heliTower, GROUND_Y, 12, HELI_TOP - GROUND_Y, 12, "#88a1b0");
  city.pads.push({ x: heliTower.x, y: HELI_TOP, z: heliTower.z, r: 4.3 });
  band(city, heliTower, HELI_TOP - 1.1, 12.25, 12.25, false);
  for (const [lx, lz] of [[5.5, 5.5], [-5.5, -5.5], [5.5, -5.5], [-5.5, 5.5]] as const) beacon(city, heliTower, HELI_TOP + 0.4, lx, lz);
  addFootprint(city, heliTower, 12, 12, HELI_TOP);
}

function buildStreets(city: City) {
  // Exclude the expanded campus, front civic park/plaza AND the forecourt park
  // zone in front of the building from city grid streets. The southern boundary
  // extends to -144 so no asphalt grid lines cut through the park corridor that
  // stretches from the campus front down to the outer ring.
  const PARK_MIN_X = -106;
  const PARK_MAX_X = 106;
  const PARK_MIN_Z = -144;
  const PARK_MAX_Z = 126;

  for (let k = -11; k <= 10; k++) {
    const offset = k * BLOCK + BLOCK / 2;
    if (Math.abs(offset) >= CITY_RADIUS - 4) continue;
    const half = Math.sqrt(CITY_RADIUS * CITY_RADIUS - offset * offset) - 2;

    // North-South street (runs along Z at x = offset)
    if (offset < PARK_MIN_X || offset > PARK_MAX_X) {
      // Entire street is outside park bounds
      city.solid.push({ x: offset, y: GROUND_Y + 0.02, z: 0, w: STREET_WIDTH, h: 0.03, d: half * 2, yaw: 0, tone: STREET_TONE, seed: 0 });
    } else {
      // Split street so it stops before entering the park/plaza area
      const northStart = Math.max(PARK_MAX_Z, -half);
      const northEnd = half;
      if (northEnd > northStart) {
        const len = northEnd - northStart;
        city.solid.push({ x: offset, y: GROUND_Y + 0.02, z: northStart + len / 2, w: STREET_WIDTH, h: 0.03, d: len, yaw: 0, tone: STREET_TONE, seed: 0 });
      }
      const southStart = -half;
      const southEnd = Math.min(PARK_MIN_Z, half);
      if (southEnd > southStart) {
        const len = southEnd - southStart;
        city.solid.push({ x: offset, y: GROUND_Y + 0.02, z: southStart + len / 2, w: STREET_WIDTH, h: 0.03, d: len, yaw: 0, tone: STREET_TONE, seed: 0 });
      }
    }

    // East-West street (runs along X at z = offset)
    if (offset < PARK_MIN_Z || offset > PARK_MAX_Z) {
      // Entire street is outside park bounds
      city.solid.push({ x: 0, y: GROUND_Y + 0.02, z: offset, w: half * 2, h: 0.03, d: STREET_WIDTH, yaw: 0, tone: STREET_TONE, seed: 0 });
    } else {
      // Split street so it stops before entering the park/plaza area
      const eastStart = Math.max(PARK_MAX_X, -half);
      const eastEnd = half;
      if (eastEnd > eastStart) {
        const len = eastEnd - eastStart;
        city.solid.push({ x: eastStart + len / 2, y: GROUND_Y + 0.02, z: offset, w: len, h: 0.03, d: STREET_WIDTH, yaw: 0, tone: STREET_TONE, seed: 0 });
      }
      const westStart = -half;
      const westEnd = Math.min(PARK_MIN_X, half);
      if (westEnd > westStart) {
        const len = westEnd - westStart;
        city.solid.push({ x: westStart + len / 2, y: GROUND_Y + 0.02, z: offset, w: len, h: 0.03, d: STREET_WIDTH, yaw: 0, tone: STREET_TONE, seed: 0 });
      }
    }

    // Street-light pools every 12 m, outside the campus lawn.
    for (let along = -half + 6; along < half - 4; along += 12) {
      for (const [x, z] of [[offset, along], [along, offset]] as const) {
        const r = Math.hypot(x, z);
        const insideCampus = Math.abs(x) < 106 && z > -70 && z < 126;
        if (r < 96 || insideCampus) continue;
        const intersection = Math.abs(((along - BLOCK / 2) % BLOCK + BLOCK) % BLOCK) < 1;
        city.pools.push({ x, z, r: intersection ? 6.5 : 5, tone: intersection ? "#ffe2bf" : "#ffa95c" });
      }
    }
  }
}

function buildCity(): City {
  const city: City = { facade: [], solid: [], cones: [], bands: [], beacons: [], pads: [], footprints: [], trees: [], pools: [] };

  DISTRICT_BUILDINGS.forEach((b, index) => {
    DISTRICT_BUILDERS[b.kind]!(city, { x: b.x, z: b.z, yaw: 0, seed: 101 + index * 3.7 }, b);
  });

  buildLandmarks(city);

  for (let gx = -10; gx <= 10; gx++) {
    for (let gz = -10; gz <= 10; gz++) {
      const cx = gx * BLOCK;
      const cz = gz * BLOCK;
      const r = Math.hypot(cx, cz);
      if (r < TOWER_MIN_RADIUS || r > TOWER_MAX_RADIUS || RESERVED_BLOCKS.has(`${cx},${cz}`)) continue;
      if (blocksView(cx, cz, 12) || overlapsDistrict(cx, cz, 9)) continue;
      const rand = mulberry((gx + 37) * 7919 + (gz + 53) * 104729);
      if (rand() < 0.3) {
        // Parks and plazas punch sky gaps between towers.
        if (rand() < 0.6) park(city, cx, cz, rand);
        else city.solid.push({ x: cx, y: GROUND_Y + 0.03, z: cz, w: BLOCK - STREET_WIDTH, h: 0.04, d: BLOCK - STREET_WIDTH, yaw: 0, tone: PLAZA_TONE, seed: 0 });
        continue;
      }

      const influence = Math.max(...CLUSTERS.map((c) => c.peak * Math.exp(-((cx - c.x) ** 2 + (cz - c.z) ** 2) / (2 * c.spread * c.spread))));
      // Base 46 m (~13 floors) so even the plainest block towers over the
      // 20 m HQ; cluster influence lifts the peaks past 120 m.
      let h = 46 + influence + rand() * 18;
      // Keep the band directly above the HQ open in the default overview.
      if (overviewAxisOffset(cx, cz) < 28 && cz > 0) h = Math.min(h, 35 + rand() * 9);
      const roll = rand();
      // Fill the 17 m buildable block (BLOCK - STREET_WIDTH) almost edge to edge.
      let w = 12.5 + rand() * 4;
      let d = 12.5 + rand() * 4;
      let yaw = 0;
      const turn = rand();
      if (turn < 0.22) {
        w = Math.min(w, 11.5);
        d = Math.min(d, 11.5);
        yaw = Math.PI / 4;
      } else if (turn < 0.38) {
        w = Math.min(w, 13.5);
        d = Math.min(d, 13.5);
        yaw = 0.18;
      }
      const reach = yaw === Math.PI / 4 ? Math.max(w, d) * Math.SQRT2 : Math.max(w, d) * (yaw ? 1.18 : 1);
      const slack = Math.max(0, (BLOCK - STREET_WIDTH - reach) / 2);
      const t: Tower = { x: cx + (rand() * 2 - 1) * slack, z: cz + (rand() * 2 - 1) * slack, yaw, seed: rand() * 97 };

      if (roll < 0.2) {
        // Mid-rise 22-40 m; podium stays inside the buildable block.
        const mid = 22 + rand() * 18;
        const pw = Math.min(w + 2, BLOCK - STREET_WIDTH - 0.5);
        const pd = Math.min(d + 2, BLOCK - STREET_WIDTH - 0.5);
        tier(city, t, GROUND_Y, pw, mid - GROUND_Y, pd, pick(STONE_TONES, rand()));
        if (rand() < 0.5) solid(city, t, mid, w * 0.4, 2.4, d * 0.4, MECH_TONE);
        addFootprint(city, t, pw, pd, mid);
      } else if (h > 86) {
        spireTower(city, t, w, d, h, pick(GLASS_TONES, rand()), rand() < 0.3 ? { pyramid: 10 + rand() * 6 } : { needle: 8 + rand() * 9 });
        addFootprint(city, t, w, d, h + 8);
      } else if (roll < 0.62) {
        glassSlab(city, t, w, d, h, pick(GLASS_TONES, rand()), rand);
        addFootprint(city, t, w, d, h);
      } else {
        steppedMonolith(city, t, w, d, h, pick(SLATE_TONES, rand()));
        addFootprint(city, t, w, d, h);
      }
    }
  }

  // Fill empty grid cells in front of the building (z < -60) with parks.
  // These cells sit inside TOWER_MIN_RADIUS so the main tower loop above
  // skips them, leaving bare ground crossed only by (now-removed) grid streets.
  // Turning them into parks creates a unified green forecourt corridor.
  for (let gx = -4; gx <= 4; gx++) {
    for (let gz = -6; gz <= -3; gz++) {
      const cx = gx * BLOCK;
      const cz = gz * BLOCK;
      const r = Math.hypot(cx, cz);
      // Only target cells that would otherwise be empty: inside the tower
      // minimum radius, or view-blocked / reserved cells that got no content.
      if (r > TOWER_MAX_RADIUS) continue;
      // Skip cells that already received a district building or a tower.
      if (overlapsDistrict(cx, cz, 9)) continue;
      if (RESERVED_BLOCKS.has(`${cx},${cz}`)) continue;
      // Skip cells outside the city disc.
      if (r > CITY_RADIUS - 4) continue;
      // If a tower was already placed here by the main loop, skip.
      if (r >= TOWER_MIN_RADIUS && !blocksView(cx, cz, 12)) continue;
      const rand = mulberry((gx + 37) * 7919 + (gz + 53) * 104729);
      park(city, cx, cz, rand);
    }
  }

  buildStreets(city);
  return city;
}

type SkyUniforms = {
  uNight: { value: number };
  uDay: { value: number };
  uHazeStrength: { value: number };
  uHaze: { value: Color };
  uSkyTint: { value: Color };
};

const SKY_FRAGMENT_PARS = /* glsl */ `
uniform float uNight;
uniform float uDay;
uniform float uHazeStrength;
uniform vec3 uHaze;
uniform vec3 uSkyTint;
varying vec3 vSkyWorld;
varying vec3 vSkyNormal;
float skyHash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}
`;

const SKY_WORLD_VERTEX = /* glsl */ `
vec4 skyWorld = vec4(position, 1.0);
vec3 skyNormal = normal;
#ifdef USE_INSTANCING
  skyWorld = instanceMatrix * skyWorld;
  skyNormal = mat3(instanceMatrix) * skyNormal;
#endif
skyWorld = modelMatrix * skyWorld;
vSkyWorld = skyWorld.xyz;
vSkyNormal = normalize(mat3(modelMatrix) * skyNormal);
`;

// Curtain-wall grid: 3.1 m bays x 3.6 m floors in world space, so every tier
// of a tower lines up. Day mixes a sky reflection into the glass; night darkens
// the glass and lights a hashed subset of offices plus whole occupied floors.
const FACADE_COLOR = /* glsl */ `
float skyWall = 1.0 - step(0.55, abs(vSkyNormal.y));
vec2 skyTangent = normalize(vec2(-vSkyNormal.z, vSkyNormal.x) + vec2(1e-4, 0.0));
vec2 skyGrid = vec2(dot(vSkyWorld.xz, skyTangent) / 3.1, (vSkyWorld.y + 0.8) / 3.6);
vec2 skyCell = floor(skyGrid);
vec2 skyLocal = fract(skyGrid);
float skyPane = step(0.12, skyLocal.x) * step(skyLocal.x, 0.88) * step(0.18, skyLocal.y) * step(skyLocal.y, 0.84);
float skyGlass = skyWall * skyPane;
float skyHeight = clamp(vSkyWorld.y / 140.0, 0.0, 1.0);
vec3 skyReflect = mix(diffuseColor.rgb, uSkyTint, 0.28 + 0.42 * skyHeight);
diffuseColor.rgb = mix(diffuseColor.rgb * 0.68, skyReflect, skyGlass);
diffuseColor.rgb *= mix(1.0, 0.38, uNight * skyGlass);
`;

const FACADE_EMISSIVE = /* glsl */ `
float skyTower = skyHash(vec2(vSeed, 3.17));
float skyFloor = skyHash(vec2(skyCell.y, vSeed * 17.0));
float skyBay = skyHash(skyCell + vSeed * 31.7);
float skySuite = skyHash(vec2(floor(skyCell.x / 4.0), skyCell.y) + vSeed * 7.3);
float skyLit = step(0.5 + 0.28 * skyTower, skyBay * 0.5 + skyFloor * 0.3 + skySuite * 0.35);
skyLit = max(skyLit, 1.0 - step(0.5, skyCell.y));
vec3 skyLamp = mix(vec3(1.0, 0.76, 0.46), vec3(0.8, 0.9, 1.0), step(0.7, skyHash(skyCell.yx + vSeed * 3.3)));
float skyDim = 0.55 + 0.45 * skyHash(skyCell * 1.7 + vSeed);
totalEmissiveRadiance += skyLamp * (skyLit * skyGlass * skyDim * uNight * 1.7);
totalEmissiveRadiance += uSkyTint * (skyGlass * uDay * 0.07 * (0.5 + skyHeight));
`;

// Aerial perspective: distant masses fade toward the live sky colour, which
// turns the skyline into soft silhouettes at night.
const SKY_HAZE = /* glsl */ `
float skyHazeAmount = clamp((length(vSkyWorld.xz) - 80.0) / 230.0, 0.0, 0.82) * uHazeStrength;
skyHazeAmount *= 1.0 - 0.3 * clamp(vSkyWorld.y / 120.0, 0.0, 1.0);
gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, skyHazeAmount);
`;

function patchSkylineMaterial<T extends MeshStandardMaterial | MeshBasicMaterial>(material: T, uniforms: SkyUniforms, facade: boolean): T {
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = shader.vertexShader
      .replace("#include <common>", `#include <common>\n${facade ? "attribute float aSeed;\nvarying float vSeed;\n" : ""}varying vec3 vSkyWorld;\nvarying vec3 vSkyNormal;`)
      .replace("#include <begin_vertex>", `#include <begin_vertex>\n${SKY_WORLD_VERTEX}${facade ? "vSeed = aSeed;\n" : ""}`);
    let fragment = shader.fragmentShader
      .replace("#include <common>", `#include <common>\n${SKY_FRAGMENT_PARS}${facade ? "varying float vSeed;\n" : ""}`)
      .replace("#include <opaque_fragment>", `#include <opaque_fragment>\n${SKY_HAZE}`);
    if (facade) {
      fragment = fragment
        .replace("#include <color_fragment>", `#include <color_fragment>\n${FACADE_COLOR}`)
        .replace("#include <roughnessmap_fragment>", "#include <roughnessmap_fragment>\nroughnessFactor = mix(roughnessFactor, 0.16, skyGlass);")
        .replace("#include <emissivemap_fragment>", `#include <emissivemap_fragment>\n${FACADE_EMISSIVE}`);
    }
    shader.fragmentShader = fragment;
  };
  material.customProgramCacheKey = () => (facade ? "campus-skyline-facade" : "campus-skyline-haze");
  return material;
}

const scratch = new Object3D();
function composeMatrix(x: number, y: number, z: number, sx: number, sy: number, sz: number, yaw = 0) {
  scratch.position.set(x, y, z);
  scratch.rotation.set(0, yaw, 0);
  scratch.scale.set(sx, sy, sz);
  scratch.updateMatrix();
  return scratch.matrix.clone();
}

type InstanceSet = { matrices: Matrix4[]; colors?: Color[] };

function SkylineInstances({ name, geometry, material, set, meshRef, frustumCulled = true }: {
  name: string;
  geometry: BufferGeometry;
  material: Material;
  set: InstanceSet;
  meshRef?: { current: InstancedMesh | null };
  frustumCulled?: boolean;
}) {
  const ownRef = useRef<InstancedMesh>(null);
  const ref = meshRef ?? ownRef;
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    set.matrices.forEach((matrix, index) => mesh.setMatrixAt(index, matrix));
    set.colors?.forEach((color, index) => mesh.setColorAt(index, color));
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [ref, set]);
  if (set.matrices.length === 0) return null;
  return (
    <instancedMesh
      ref={ref}
      name={name}
      args={[geometry, material, set.matrices.length]}
      castShadow={false}
      receiveShadow={false}
      frustumCulled={frustumCulled}
    />
  );
}

const DAY_SKY = new Color("#d4e4f0");
const BEACON_RED = new Color("#ff3322");
const tempColor = new Color();
const shadowDummy = new Object3D();

function windowGlow(factors: { nightFactor: number; exteriorLightFactor: number; twilightFactor: number }) {
  return Math.max(factors.nightFactor, factors.exteriorLightFactor * 0.9, factors.twilightFactor * 0.55);
}

/** Instanced, day/night reactive skyline. Mounted inside the passable neighborhood group. */
export function CampusSkyline() {
  const { state, reducedMotion } = useSolarEnvironment();
  const solar = useRef(state);
  useEffect(() => { solar.current = state; }, [state]);

  const city = useMemo(() => buildCity(), []);

  const uniforms = useMemo<SkyUniforms>(() => {
    return {
      uNight: { value: 0 },
      uDay: { value: 1 },
      uHazeStrength: { value: 0.6 },
      uHaze: { value: new Color("#b9c8d4") },
      uSkyTint: { value: DAY_SKY.clone() }
    };
  }, []);

  const materials = useMemo(() => ({
    facade: patchSkylineMaterial(new MeshStandardMaterial({ color: "#ffffff", roughness: 0.42, metalness: 0.12 }), uniforms, true),
    solid: patchSkylineMaterial(new MeshStandardMaterial({ color: "#ffffff", roughness: 0.88 }), uniforms, false),
    metal: patchSkylineMaterial(new MeshStandardMaterial({ color: "#c3cbd2", roughness: 0.32, metalness: 0.5 }), uniforms, false),
    ground: patchSkylineMaterial(new MeshStandardMaterial({ color: "#737b7c", roughness: 1 }), uniforms, false),
    foliage: patchSkylineMaterial(new MeshStandardMaterial({ color: "#ffffff", roughness: 0.95, flatShading: true }), uniforms, false),
    pad: patchSkylineMaterial(new MeshStandardMaterial({ color: "#3b4249", roughness: 0.8 }), uniforms, false),
    crown: patchSkylineMaterial(new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }), uniforms, false),
    padRing: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    beacon: new MeshBasicMaterial({ color: "#ffffff", toneMapped: false }),
    pools: new MeshBasicMaterial({ color: "#ffffff", transparent: true, opacity: 0, blending: AdditiveBlending, depthWrite: false, toneMapped: false }),
    shadow: new MeshBasicMaterial({
      color: "#16202a", transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2
    })
  }), [uniforms]);

  const geometries = useMemo(() => {
    const facade = new BoxGeometry(1, 1, 1);
    facade.setAttribute("aSeed", new InstancedBufferAttribute(Float32Array.from(city.facade, (part) => part.seed), 1));
    const spire = new CylinderGeometry(0, 1, 1, 4, 1);
    spire.rotateY(Math.PI / 4);
    spire.translate(0, 0.5, 0);
    const shadow = new PlaneGeometry(1, 1);
    shadow.rotateX(-Math.PI / 2);
    shadow.translate(0, 0, 0.5);
    const pool = new CircleGeometry(1, 20);
    pool.rotateX(-Math.PI / 2);
    const ring = new RingGeometry(0.8, 0.94, 28);
    ring.rotateX(-Math.PI / 2);
    const ground = new CircleGeometry(CITY_RADIUS, 72);
    ground.rotateX(-Math.PI / 2);
    return {
      facade,
      box: new BoxGeometry(1, 1, 1),
      band: new BoxGeometry(1, 1, 1),
      spire,
      beacon: new SphereGeometry(0.45, 8, 6),
      pad: new CylinderGeometry(1, 1, 0.16, 20),
      ring,
      tree: new IcosahedronGeometry(1, 1),
      pool,
      shadow,
      ground
    };
  }, [city]);

  useEffect(() => () => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
  }, [geometries, materials]);

  const sets = useMemo(() => {
    const boxes = (list: Box[]): InstanceSet => ({
      matrices: list.map((b) => composeMatrix(b.x, b.y, b.z, b.w, b.h, b.d, b.yaw)),
      colors: list.map((b) => new Color(b.tone))
    });
    return {
      facade: boxes(city.facade),
      solid: boxes(city.solid),
      spires: { matrices: city.cones.map((c) => composeMatrix(c.x, c.y, c.z, c.sx, c.h, c.sz, c.yaw)) },
      bands: {
        matrices: city.bands.map((b) => composeMatrix(b.x, b.y, b.z, b.w, 0.7, b.d, b.yaw)),
        colors: city.bands.map((b) => new Color(b.warm ? "#ffd49a" : "#d6ecff"))
      },
      beacons: {
        matrices: city.beacons.map((b) => composeMatrix(b.x, b.y, b.z, 1, 1, 1)),
        colors: city.beacons.map(() => BEACON_RED.clone())
      },
      pads: { matrices: city.pads.map((p) => composeMatrix(p.x, p.y + 0.08, p.z, p.r, 1, p.r)) },
      rings: { matrices: city.pads.map((p) => composeMatrix(p.x, p.y + 0.17, p.z, p.r, 1, p.r)) },
      trees: {
        matrices: city.trees.map((t) => composeMatrix(t.x, t.y, t.z, t.s, t.s * 0.9, t.s)),
        colors: city.trees.map((t) => new Color(t.tone))
      },
      pools: {
        matrices: city.pools.map((p) => composeMatrix(p.x, GROUND_Y + 0.06, p.z, p.r, 1, p.r)),
        colors: city.pools.map((p) => new Color(p.tone))
      },
      shadows: { matrices: city.footprints.map(() => composeMatrix(0, SHADOW_Y, 0, 0, 1, 0)) }
    };
  }, [city]);

  const beaconRef = useRef<InstancedMesh>(null);
  const shadowRef = useRef<InstancedMesh>(null);
  const lastSun = useRef<[number, number, number]>([Number.NaN, 0, 0]);

  useFrame((root, delta) => {
    const { factors, position } = solar.current;
    const k = 1 - Math.exp(-Math.min(delta, 0.1) * 2.5);
    uniforms.uNight.value += (windowGlow(factors) - uniforms.uNight.value) * k;
    uniforms.uDay.value += (factors.daylightFactor - uniforms.uDay.value) * k;
    const night = uniforms.uNight.value;
    const background = root.scene.background;
    if (background instanceof Color) uniforms.uHaze.value.lerp(background, k);
    uniforms.uSkyTint.value.copy(DAY_SKY).lerp(uniforms.uHaze.value, 0.45);
    uniforms.uHazeStrength.value = MathUtils.lerp(0.7, 0.42, night);

    materials.crown.color.setScalar(MathUtils.lerp(0.58, 1.75, night));
    materials.padRing.color.setRGB(MathUtils.lerp(0.55, 1.1, night), MathUtils.lerp(0.6, 1.6, night), MathUtils.lerp(0.5, 0.9, night));
    materials.pools.opacity = 0.55 * night;
    materials.pools.visible = night > 0.02;

    const beacons = beaconRef.current;
    if (beacons) {
      const time = reducedMotion ? 0 : root.clock.elapsedTime;
      city.beacons.forEach((b, index) => {
        const pulse = Math.pow(0.5 + 0.5 * Math.sin(time * 2.2 + b.phase), 8);
        beacons.setColorAt(index, tempColor.copy(BEACON_RED).multiplyScalar(MathUtils.lerp(0.5, 0.35 + 2.6 * pulse, night)));
      });
      if (beacons.instanceColor) beacons.instanceColor.needsUpdate = true;
    }

    // Projected ground shadows follow the live sun; rebuilt only when it moves.
    const shadows = shadowRef.current;
    const sun = position.sunDirection;
    const elevation = position.elevation;
    materials.shadow.opacity = 0.2 * factors.daylightFactor * MathUtils.clamp((elevation - 2) / 10, 0, 1);
    if (!shadows) return;
    shadows.visible = materials.shadow.opacity > 0.005;
    const last = lastSun.current;
    if (!shadows.visible || (Math.abs(last[0] - sun[0]!) < 0.002 && Math.abs(last[1] - sun[1]!) < 0.002 && Math.abs(last[2] - sun[2]!) < 0.002)) return;
    lastSun.current = [sun[0]!, sun[1]!, sun[2]!];
    const horizontal = Math.hypot(sun[0]!, sun[2]!) || 1;
    const yaw = Math.atan2(-sun[0]! / horizontal, -sun[2]! / horizontal);
    const slope = 1 / Math.max(Math.tan(MathUtils.degToRad(Math.max(elevation, 1))), 0.05);
    city.footprints.forEach((f, index) => {
      shadowDummy.position.set(f.x, SHADOW_Y, f.z);
      shadowDummy.rotation.set(0, yaw, 0);
      shadowDummy.scale.set((f.w + f.d) / 2, 1, Math.min(f.h * slope, f.h * 2.4));
      shadowDummy.updateMatrix();
      shadows.setMatrixAt(index, shadowDummy.matrix);
    });
    shadows.instanceMatrix.needsUpdate = true;
  });

  return (
    <group name="campus-skyline" userData={{ officeCollision: false }}>
      <mesh name="city-ground" geometry={geometries.ground} material={materials.ground} position={[0, GROUND_Y, 0]} />
      <SkylineInstances name="skyline-facades" geometry={geometries.facade} material={materials.facade} set={sets.facade} />
      <SkylineInstances name="skyline-solids" geometry={geometries.box} material={materials.solid} set={sets.solid} />
      <SkylineInstances name="skyline-spires" geometry={geometries.spire} material={materials.metal} set={sets.spires} />
      <SkylineInstances name="skyline-crowns" geometry={geometries.band} material={materials.crown} set={sets.bands} />
      <SkylineInstances name="skyline-helipads" geometry={geometries.pad} material={materials.pad} set={sets.pads} />
      <SkylineInstances name="skyline-helipad-lights" geometry={geometries.ring} material={materials.padRing} set={sets.rings} />
      <SkylineInstances name="skyline-beacons" geometry={geometries.beacon} material={materials.beacon} set={sets.beacons} meshRef={beaconRef} />
      <SkylineInstances name="skyline-park-trees" geometry={geometries.tree} material={materials.foliage} set={sets.trees} />
      {/* Instanced street glow pools removed per user directive (no circular light pools at night) */}
      <SkylineInstances name="skyline-ground-shadows" geometry={geometries.shadow} material={materials.shadow} set={sets.shadows} meshRef={shadowRef} frustumCulled={false} />
    </group>
  );
}
