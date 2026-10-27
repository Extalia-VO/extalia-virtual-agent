import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import { BufferGeometry, CanvasTexture, DoubleSide, ExtrudeGeometry, type InstancedMesh, Object3D, RepeatWrapping, SRGBColorSpace } from "three";
import { mergeGeometries, mergeVertices } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { cutPath, offsetPolyline, pointsAlong, roundCorners, sweepBand, thickPolyline, type PathCut, type Plan } from "./facadeSweep";
import { facadeFrames, facadeFrameShape, FACADE_PAVILION_EDGE } from "./facadeElevation";
import { GLASS_ELEVATORS } from "./prefabs/architecture/elevatorController";
import { CAMPUS_ENTRY_LAYOUT, OFFICE_BUILDING } from "./layout";
import { useSolarEnvironment } from "./Environment";
import { F1_EMERGENCY_EXIT, F3_TERRACE } from "./floor1Layout";
import { MAINTENANCE_STAIR_LAYOUT } from "./prefabs/architecture/RoofMaintenanceStair";
import {
  CanopyDownlightFixture,
  WallSconceFixture
} from "./prefabs/architecture/LightFixtureGeometries";

/**
 * The envelope is a visual skin around the existing 42 x 30 m, three-level
 * office. The six facade ribbons are subdivisions of those real levels; they
 * do not add floors, stairs, or collision surfaces to the interior.
 */
const WIDTH_SCALE = OFFICE_BUILDING.width / 42;
const DEPTH_SCALE = OFFICE_BUILDING.depth / 30;
const HALF_W = 21;
const LIFT_PORTAL_CENTERS = GLASS_ELEVATORS.map(({ z }) => z / DEPTH_SCALE).sort((a, b) => a - b);
const LIFT_PORTAL_HALF = 1.08 / DEPTH_SCALE;
const HALF_D = 15;
// F3 steps back to expose an open-air deck above the full-depth F2 footprint.
const F3_REAR_Z = F3_TERRACE.north / DEPTH_SCALE;
const LEVEL_H = 6.4;
const BUILDING_H = LEVEL_H * 3;
const BAND_H = LEVEL_H / 2;
const FRONT_Z = CAMPUS_ENTRY_LAYOUT.shellFrontZ / DEPTH_SCALE;
const ENTRANCE_HALF = (CAMPUS_ENTRY_LAYOUT.shellOpeningWidth / 2 + 0.34) / WIDTH_SCALE;
// The envelope mirrors X only; Z uses the authored-to-world depth scale.
// The rough opening includes both 8 cm jambs around the 1.8 m clear doorway.
const EMERGENCY_PORTAL_Z = F1_EMERGENCY_EXIT.center[2] / DEPTH_SCALE;
const EMERGENCY_PORTAL_HALF = (F1_EMERGENCY_EXIT.width / 2 + 0.1) / DEPTH_SCALE;

const SILVER_EDGE = "#aebec8";
const DARK_FRAME = "#425360";
const WARM_LIGHT = "#ffe0a7";

type Span = [number, number];

function BlueGlass({
  position,
  size,
  rotationY = 0,
  night: _night,
  corner = false
}: {
  position: [number, number, number];
  size: [number, number];
  rotationY?: number;
  night: number;
  corner?: boolean;
}) {
  // Occupied floors read as lit windows after dark; switched-off lights leave the glass dark.
  const { state } = useSolarEnvironment();
  const windowGlow = state.factors.interiorLightFactor * (1 - state.factors.daylightFactor);
  return (
    <mesh position={position} rotation={[0, rotationY, 0]} userData={{ officeMaterialDynamic: `facade-glass:${corner ? "corner" : "band"}` }}>
      <planeGeometry args={size} />
      <meshPhysicalMaterial
        emissive="#ffd29c"
        emissiveIntensity={windowGlow * 0.16}
        color={corner ? "#87abc0" : "#6b94ae"}
        roughness={0.16}
        metalness={0}
        clearcoat={0.45}
        clearcoatRoughness={0.1}
        transparent
        opacity={(corner ? 0.38 : 0.4) + state.factors.daylightFactor * (corner ? 0.27 : 0.32)}
        // Alpha glazing avoids a second full-scene transmission render in overview.
        transmission={0}
        ior={1.46}
        depthWrite={false}
        side={DoubleSide}
      />
    </mesh>
  );
}

function EdgeLight({
  position,
  size,
  night
}: {
  position: [number, number, number];
  size: [number, number, number];
  night: number;
}) {
  return (
    <mesh position={position} userData={{ officeDynamic: true }}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={WARM_LIGHT}
        emissive="#ffc778"
        emissiveIntensity={night * 2}
        toneMapped={false}
      />
    </mesh>
  );
}

function RibbonCap({
  position,
  size,
  night: _night
}: {
  position: [number, number, number];
  size: [number, number, number];
  night: number;
}) {
  return (
    <mesh castShadow receiveShadow position={position} userData={{ officeDynamic: true }}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={SILVER_EDGE}
        metalness={0.62}
        roughness={0.31}
      />
    </mesh>
  );
}

function Mullion({
  position,
  size,
  night: _night
}: {
  position: [number, number, number];
  size: [number, number, number];
  night: number;
}) {
  return (
    <mesh castShadow position={position} userData={{ officeDynamic: true }}>
      <boxGeometry args={size} />
      <meshStandardMaterial
        color={DARK_FRAME}
        metalness={0.55}
        roughness={0.34}
      />
    </mesh>
  );
}

/** Full-height mullions behind the side glazing (cut at the lift portals and the emergency exit). */
function SideMullions({ night }: { night: number }) {
  return (
    <group>
      {[-1, 1].flatMap((side) =>
        Array.from({ length: 10 }, (_, bay) => {
          const z = -15 + bay * 3;
          const spans: Span[] = side > 0 && Math.abs(z - EMERGENCY_PORTAL_Z) < EMERGENCY_PORTAL_HALF + 0.085 / 2
            ? [[2.7, BUILDING_H - 0.06]] as const
            : side < 0 && LIFT_PORTAL_CENTERS.some(center => Math.abs(z - center) < LIFT_PORTAL_HALF)
            ? [[2.95, 6.4], [9.35, 12.8], [15.75, BUILDING_H]] as const
            : [[0.06, BUILDING_H - 0.06]] as const;
          const maxY = z > F3_REAR_Z ? LEVEL_H * 2 : BUILDING_H;
          return spans.filter(([a]) => a < maxY).map(([a, b]) => {
            const top = Math.min(b, maxY);
            return <Mullion key={`${side}-${bay}-${a}`}
              position={[side * (HALF_W + 0.22), (a + top) / 2, z]}
              size={[0.09, top - a, 0.085]} night={night} />;
          });
        })
      )}
    </group>
  );
}

function AtriumAndEntrance({ night }: { night: number }) {
  const x = (OFFICE_BUILDING.centerX - CAMPUS_ENTRY_LAYOUT.centerX) / WIDTH_SCALE;
  const leftEntry: Span = [-6.15, x - ENTRANCE_HALF];
  const rightEntry: Span = [x + ENTRANCE_HALF, 6.15];
  return (
    <group>
      {/* A single full-height glass bay reveals the actual three levels. */}
      {Array.from({ length: 5 }, (_, bay) => (
        <Mullion key={bay} position={[-4.92 + bay * 2.46, 11.55, FRONT_Z - 0.12]} size={[0.085, 15.25, 0.11]} night={night} />
      ))}
      {[6.4, 12.8].map((level) => (
        <Mullion key={level} position={[0, level, FRONT_Z - 0.14]} size={[12.2, 0.1, 0.13]} night={night} />
      ))}
      {/* Glass on both sides of the exact shared ground-floor entrance gap. */}
      {[leftEntry, rightEntry].map(([start, end], index) => (
        <group key={index}>
          <Mullion position={[start, 1.93, FRONT_Z - 0.14]} size={[0.1, 3.8, 0.12]} night={night} />
          <Mullion position={[end, 1.93, FRONT_Z - 0.14]} size={[0.1, 3.8, 0.12]} night={night} />
        </group>
      ))}
      <RibbonCap position={[x, 3.86, FRONT_Z - 0.42]} size={[12.35, 0.23, 0.7]} night={night} />
      <EdgeLight position={[x, 3.72, FRONT_Z - 0.79]} size={[ENTRANCE_HALF * 2, 0.045, 0.035]} night={night} />
      {/* Suspended entrance canopy: its columns stay well outside the route. */}
      <RibbonCap position={[x, 3.68, -16.45]} size={[11.8, 0.28, 2.75]} night={night} />
      <mesh position={[x, 3.51, -16.45]} userData={{ officeDynamic: true }}>
        <boxGeometry args={[11.45, 0.04, 2.5]} />
        <meshStandardMaterial color="#c9a77d" roughness={0.7} />
      </mesh>
      <EdgeLight position={[x, 3.5, -17.83]} size={[11.7, 0.045, 0.05]} night={night} />
      {[-5.35, 5.35].map((column) => (
        <Mullion key={column} position={[x + column, 1.73, -17.7]} size={[0.14, 3.46, 0.14]} night={night} />
      ))}
      {[-4.25, -3.25, 3.25, 4.25].map((downlight) => (
        <CanopyDownlightFixture key={downlight} position={[x + downlight, 3.47, -16.45]} diameter={0.2} realLight={Math.abs(downlight) === 3.25} />
      ))}
      {[-3.45, 3.45].map((sconce) => (
        <WallSconceFixture key={sconce} position={[x + sconce, 2.55, FRONT_Z - 0.15]} rotation={[0, 0, 0]} isExterior />
      ))}
    </group>
  );
}

function CornerPavilion({ night }: { night: number }) {
  return (
    <group>
      <BlueGlass position={[(FACADE_PAVILION_EDGE + HALF_W) / 2, BUILDING_H / 2, FRONT_Z - 0.12]} size={[HALF_W - FACADE_PAVILION_EDGE, BUILDING_H - 0.16]} night={night} corner />
      <BlueGlass position={[HALF_W + 0.25, BUILDING_H / 2, -11.02]} size={[7.9, BUILDING_H - 0.16]} rotationY={Math.PI / 2} night={night} corner />
      {[FACADE_PAVILION_EDGE, 17.6, 20.95].map((x) => (
        <Mullion key={x} position={[x, BUILDING_H / 2, FRONT_Z - 0.18]} size={[0.085, BUILDING_H, 0.14]} night={night} />
      ))}
      {[-15, -12.35, -9.7, -7.08].map((z) => (
        <Mullion key={z} position={[HALF_W + 0.31, BUILDING_H / 2, z]} size={[0.18, BUILDING_H, 0.12]} night={night} />
      ))}
      {[6.4, 12.8].map((y) => (
        <group key={y}>
          <Mullion position={[(FACADE_PAVILION_EDGE + HALF_W) / 2, y, FRONT_Z - 0.18]} size={[HALF_W - FACADE_PAVILION_EDGE, 0.08, 0.14]} night={night} />
          <Mullion position={[HALF_W + 0.32, y, -11.04]} size={[0.18, 0.11, 8.05]} night={night} />
        </group>
      ))}
    </group>
  );
}

export function RoofEnvelope() {
  const roofCenterZ = (-HALF_D + F3_REAR_Z) / 2;
  const roofDepth = F3_REAR_Z + HALF_D;
  return (
    <group name="extalia-setback-roof">
      <mesh castShadow receiveShadow position={[0, 19.13, roofCenterZ]} userData={{ officeDynamic: true }}>
        <boxGeometry args={[42.75, 0.28, roofDepth + 0.75]} />
        <meshStandardMaterial color="#b7c4ca" roughness={0.65} metalness={0.34} />
      </mesh>
      <mesh receiveShadow position={[0, 19.3, roofCenterZ]} userData={{ officeDynamic: true }}>
        <boxGeometry args={[41.9, 0.035, roofDepth - 0.1]} />
        <meshStandardMaterial color="#b1bdc3" roughness={0.82} />
      </mesh>
    </group>
  );
}

function CampusBrandSigns({ night }: { night: number }) {
  return (
    <group>
      {/* Entrance fascia: the brand lettering on it is extruded geometry (ExtaliaSignage.tsx), like the roof sign. */}
      <group position={[(CAMPUS_ENTRY_LAYOUT.centerX - OFFICE_BUILDING.centerX) / WIDTH_SCALE, 3.98, -17.91]}>
        <mesh castShadow>
          <boxGeometry args={[6.4, 0.7, 0.12]} />
          <meshStandardMaterial color="#263944" roughness={0.38} metalness={0.5} />
        </mesh>
        <EdgeLight position={[0, -0.36, -0.065]} size={[6.3, 0.035, 0.03]} night={night} />
      </group>
    </group>
  );
}

// ── Continuous envelope (world metres, mirrored like the authored facade) ──

const WORLD_X = HALF_W * WIDTH_SCALE;
const WORLD_FRONT = CAMPUS_ENTRY_LAYOUT.shellFrontZ;
const WORLD_REAR = HALF_D * DEPTH_SCALE;
const PAVILION_X = FACADE_PAVILION_EDGE * WIDTH_SCALE;
const PAVILION_SIDE_Z = -7 * DEPTH_SCALE;
/** Bands wrap the corners on this radius instead of meeting as separate panels. */
const CORNER_RADIUS = 1.2;
/** Alternate bands stand a little further out, the stepped rhythm of the cladding. */
const BAND_OFFSETS = [0.3, 0.42] as const;
const SPANDREL_DEPTH = 0.34;
/** One cladding texture tile: 2 m along the facade by 1 m up (UVs are metres). */
const CLADDING_TILE: Plan = [2, 1];

/** Side/rear wrap joined to the front frames at the rounded corner tangent. */
function bandPaths(band: number, offset: number): Plan[][] {
  const rear = (band >= 4 ? F3_TERRACE.north : WORLD_REAR) + offset;
  const front = WORLD_FRONT - offset, side = WORLD_X + offset;
  return [
    roundCorners([[-side + 2.4, front], [-side, front], [-side, rear], [side, rear], [side, PAVILION_SIDE_Z]], CORNER_RADIUS, 8),
  ];
}

/** Real openings through the lower half of a band: lift portals, the F1 emergency exit, the terrace door. */
function bandCuts(band: number, offset: number): PathCut[] {
  const side = WORLD_X + offset;
  const cuts: PathCut[] = [];
  if (band % 2 === 0) for (const { z } of GLASS_ELEVATORS) cuts.push({ axis: 'x', at: -side, from: z - 1.08, to: z + 1.08 });
  if (band === 0) {
    const half = F1_EMERGENCY_EXIT.width / 2 + 0.1;
    cuts.push({ axis: 'x', at: side, from: F1_EMERGENCY_EXIT.center[2] - half, to: F1_EMERGENCY_EXIT.center[2] + half });
  }
  if (band === 4) {
    const x = OFFICE_BUILDING.centerX - F3_TERRACE.door.center[0]!, half = F3_TERRACE.door.width / 2 + 0.12;
    cuts.push({ axis: 'z', at: F3_TERRACE.north + offset, from: x - half, to: x + half });
  }
  return cuts;
}

interface EnvelopeGeometry {
  spandrel: BufferGeometry; cap: BufferGeometry; glow: BufferGeometry; glass: BufferGeometry;
  mullions: { at: Plan; angle: number; y: number }[];
}

function merged(parts: BufferGeometry[]): BufferGeometry {
  // Sweeps are indexed; Three's extruded perforated frames are not. Normalize
  // only those frames so one batched surface can contain both authoring forms.
  const prepared = parts.map(part => part.index ? part : mergeVertices(part));
  const geometry = mergeGeometries(prepared, false);
  for (const part of new Set([...parts, ...prepared])) part.dispose();
  if (!geometry) throw new Error("Incompatible facade geometry attributes");
  return geometry;
}

/** Every band of the six facade ribbons as continuous swept solids (built once). */
export function buildFacadeEnvelope(): EnvelopeGeometry {
  const spandrel: BufferGeometry[] = [], cap: BufferGeometry[] = [], glow: BufferGeometry[] = [], glass: BufferGeometry[] = [];
  const mullions: EnvelopeGeometry['mullions'] = [];
  for (let band = 0; band < 6; band++) {
    const y = band * BAND_H, offset = BAND_OFFSETS[band % 2]!;
    const cuts = bandCuts(band, offset), glassCuts = bandCuts(band, offset - 0.16);
    for (const path of bandPaths(band, offset)) {
      // The lower spandrel and the glazing open at the portals; the upper spandrel and cap run on above them.
      for (const piece of cutPath(path, cuts)) spandrel.push(sweepBand(piece, y, y + 1.04, SPANDREL_DEPTH));
      spandrel.push(sweepBand(path, y + 2.42, y + 3.06, SPANDREL_DEPTH));
    }
    for (const path of bandPaths(band, offset + 0.2)) cap.push(sweepBand(path, y + 3.06, y + 3.22, 0.62));
    for (const path of bandPaths(band, offset + 0.17)) glow.push(sweepBand(path, y + 3.025, y + 3.06, 0.03));
    for (const path of bandPaths(band, offset - 0.16)) {
      for (const piece of cutPath(path, glassCuts)) {
        glass.push(sweepBand(piece, y + 1.04, y + 2.42, 0.02));
        for (const point of pointsAlong(piece, 3)) mullions.push({ ...point, y: y + 1.73 });
      }
    }
  }
  // The front is made from perforated elevation frames: their diagonal ends
  // form the glazed atrium, rather than floating in front of opaque bands.
  for (const frame of facadeFrames(WORLD_X, WIDTH_SCALE)) {
    const offset = BAND_OFFSETS[frame.course % 2]!;
    const z = WORLD_FRONT - offset;
    const face = new ExtrudeGeometry(facadeFrameShape(frame), {
      depth: SPANDREL_DEPTH, bevelEnabled: true, bevelThickness: 0.018,
      bevelSize: 0.018, bevelSegments: 1, curveSegments: 1,
    });
    face.translate(0, 0, z);
    spandrel.push(face);
    const edge = offsetPolyline(frame.edge, frame.side === 'long' ? 0.05 : -0.05);
    const trim = new ExtrudeGeometry(thickPolyline(edge, 0.075), { depth: 0.055, bevelEnabled: false });
    trim.translate(0, 0, z - 0.035); cap.push(trim);
    const light = new ExtrudeGeometry(thickPolyline(edge, 0.04), { depth: 0.012, bevelEnabled: false });
    light.translate(0, 0, z - 0.049); glow.push(light);
    if (frame.window.length) {
      const xs = frame.window.map(p => p[0]);
      for (const point of pointsAlong([[Math.min(...xs), WORLD_FRONT - 0.19], [Math.max(...xs), WORLD_FRONT - 0.19]], 3.5)) {
        mullions.push({ ...point, y: frame.course * BAND_H + 1.71 });
      }
    }
  }
  // One recessed curtain behind the front frames, with a real ground-level
  // entrance opening. The interior's actual doorway/arrival route stays clear.
  const frontGlass = [[-WORLD_X - BAND_OFFSETS[0] + 2.4, WORLD_FRONT - 0.14],
    [PAVILION_X, WORLD_FRONT - 0.14]] as Plan[];
  const entranceX = OFFICE_BUILDING.centerX - CAMPUS_ENTRY_LAYOUT.centerX;
  const halfEntry = CAMPUS_ENTRY_LAYOUT.shellOpeningWidth / 2 + 0.34;
  for (const piece of cutPath(frontGlass, [{ axis: 'z', at: WORLD_FRONT - 0.14,
    from: entranceX - halfEntry, to: entranceX + halfEntry }])) {
    glass.push(sweepBand(piece, 0.02, 4.1, 0.02));
  }
  glass.push(sweepBand(frontGlass, 4.1, BUILDING_H, 0.02));
  return { spandrel: merged(spandrel), cap: merged(cap), glow: merged(glow), glass: merged(glass), mullions };
}

/** A continuous roof parapet around the setback roof, open where the maintenance stair lands. */
function buildParapet(): { band: BufferGeometry; cap: BufferGeometry; glow: BufferGeometry } {
  const ring = (offset: number) => {
    const front = -WORLD_REAR - offset, rear = F3_TERRACE.north + offset, side = WORLD_X + offset;
    return roundCorners([[0, front], [side, front], [side, rear], [-side, rear], [-side, front], [0, front]], CORNER_RADIUS, 8);
  };
  const stair = (offset: number): PathCut[] => [{ axis: 'x', at: -(WORLD_X + offset),
    from: MAINTENANCE_STAIR_LAYOUT.upperLandingNorth - 0.08, to: MAINTENANCE_STAIR_LAYOUT.upperLandingSouth + 0.08 }];
  return {
    band: merged(cutPath(ring(0.55), stair(0.55)).map(piece => sweepBand(piece, 19.29, 20.0, 0.3))),
    cap: merged(cutPath(ring(0.62), stair(0.62)).map(piece => sweepBand(piece, 20.0, 20.1, 0.44))),
    glow: merged(cutPath(ring(0.6), stair(0.6)).map(piece => sweepBand(piece, 19.97, 20.0, 0.03))),
  };
}

/** Tileable diamond cladding, 2 m by 1 m per tile (256 px per metre), for metre-based UVs. */
function createCladdingTexture(): CanvasTexture {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 256;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.fillStyle = "#cbd4dc";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    // Alternate panels carry a faint tone shift, the anodised panel variation of the material sample.
    for (let row = 0; row < 8; row++) for (let col = 0; col < 16; col++) {
      if ((row * 7 + col * 3) % 5 !== 0) continue;
      ctx.fillStyle = "rgba(160,178,190,0.10)";
      ctx.beginPath();
      const cx = col * 32 + (row % 2 ? 16 : 0), cy = row * 32 + 16;
      ctx.moveTo(cx, cy - 32); ctx.lineTo(cx + 32, cy); ctx.lineTo(cx, cy + 32); ctx.lineTo(cx - 32, cy); ctx.closePath(); ctx.fill();
    }
    ctx.strokeStyle = "#b2bfc8";
    ctx.lineWidth = 1.0;
    for (let x = -256; x <= 768; x += 64) {
      ctx.beginPath();
      ctx.moveTo(x, 0); ctx.lineTo(x + 256, 256);
      ctx.moveTo(x + 256, 0); ctx.lineTo(x, 256);
      ctx.stroke();
    }
  }
  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = texture.wrapT = RepeatWrapping;
  texture.repeat.set(1 / CLADDING_TILE[0], 1 / CLADDING_TILE[1]);
  texture.anisotropy = 8;
  return texture;
}

function ContinuousEnvelope({ night }: { night: number }) {
  const parts = useMemo(() => ({ envelope: buildFacadeEnvelope(), parapet: buildParapet() }), []);
  const cladding = useMemo(() => createCladdingTexture(), []);
  const mullions = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = mullions.current;
    if (!mesh) return;
    const transform = new Object3D();
    parts.envelope.mullions.forEach(({ at, angle, y }, index) => {
      transform.position.set(at[0], y, at[1]);
      transform.rotation.set(0, -angle, 0);
      transform.updateMatrix();
      mesh.setMatrixAt(index, transform.matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
  }, [parts]);
  useEffect(() => () => {
    cladding.dispose();
    for (const group of Object.values(parts)) for (const value of Object.values(group)) if (value instanceof BufferGeometry) value.dispose();
  }, [parts, cladding]);
  const { state } = useSolarEnvironment();
  const windowGlow = state.factors.interiorLightFactor * (1 - state.factors.daylightFactor);
  // Light anodised aluminium (the reference material palette): low metalness keeps it silver rather than dark under the sky light.
  const cladMaterial = <meshStandardMaterial color="#e5eaee" map={cladding} bumpMap={cladding} bumpScale={0.006} metalness={0.22} roughness={0.46} emissive="#728292" emissiveIntensity={night * 0.14} />;
  const capMaterial = <meshStandardMaterial color={SILVER_EDGE} metalness={0.62} roughness={0.31} />;
  const glowMaterial = <meshStandardMaterial color={WARM_LIGHT} emissive="#ffc778" emissiveIntensity={night * 2} toneMapped={false} />;
  return (
    <group name="extalia-continuous-envelope">
      <group scale={[-1, 1, 1]}>
        <mesh name="facade-spandrels" geometry={parts.envelope.spandrel} castShadow receiveShadow userData={{ officeMaterialDynamic: "facade-cladding" }}>{cladMaterial}</mesh>
        <mesh name="facade-caps" geometry={parts.envelope.cap} castShadow receiveShadow>{capMaterial}</mesh>
        <mesh name="facade-cap-lights" geometry={parts.envelope.glow} userData={{ officeDynamic: true }}>{glowMaterial}</mesh>
        <mesh name="facade-band-glass" geometry={parts.envelope.glass} userData={{ officeMaterialDynamic: "facade-glass:band" }}>
          <meshPhysicalMaterial emissive="#ffd29c" emissiveIntensity={windowGlow * 0.16} color="#6b94ae" roughness={0.16} metalness={0}
            clearcoat={0.45} clearcoatRoughness={0.1} transparent opacity={0.4 + state.factors.daylightFactor * 0.32} transmission={0} ior={1.46} depthWrite={false} side={DoubleSide} />
        </mesh>
        <instancedMesh ref={mullions} args={[undefined, undefined, parts.envelope.mullions.length]} castShadow userData={{ officeDynamic: true }}>
          <boxGeometry args={[0.075, 1.4, 0.11]} />
          <meshStandardMaterial color={DARK_FRAME} metalness={0.55} roughness={0.34} />
        </instancedMesh>
      </group>
      <mesh name="roof-parapet" geometry={parts.parapet.band} castShadow receiveShadow userData={{ officeMaterialDynamic: "facade-cladding" }}>{cladMaterial}</mesh>
      <mesh name="roof-parapet-cap" geometry={parts.parapet.cap} castShadow receiveShadow>{capMaterial}</mesh>
      <mesh name="roof-parapet-light" geometry={parts.parapet.glow} userData={{ officeDynamic: true }}>{glowMaterial}</mesh>
    </group>
  );
}

export function CampusBuildingShell() {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  return (
    <group>
      <group position={[OFFICE_BUILDING.centerX, 0, 0]} scale={[WIDTH_SCALE, 1, DEPTH_SCALE]}>
        <group scale={[-1, 1, 1]}>
          <SideMullions night={night} />
          <AtriumAndEntrance night={night} />
          <CornerPavilion night={night} />
        </group>
        <RoofEnvelope />
        <CampusBrandSigns night={night} />
      </group>
      <group position={[OFFICE_BUILDING.centerX, 0, 0]}>
        <ContinuousEnvelope night={night} />
      </group>
    </group>
  );
}
