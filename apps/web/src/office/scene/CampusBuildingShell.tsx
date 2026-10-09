/* eslint-disable react-hooks/immutability -- Three.js resources and camera transforms are mutable renderer objects. */
import { drawExtaliaBrand } from "./prefabs/architecture/extaliaBrand";
import { useEffect, useMemo } from "react";
import { CanvasTexture, DoubleSide, SRGBColorSpace } from "three";
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
const TERRACE_PORTAL_X = (OFFICE_BUILDING.centerX - F3_TERRACE.door.center[0]!) / WIDTH_SCALE;
const TERRACE_PORTAL_HALF = (F3_TERRACE.door.width / 2 + 0.12) / WIDTH_SCALE;
const LEVEL_H = 6.4;
const BUILDING_H = LEVEL_H * 3;
const BAND_H = LEVEL_H / 2;
const FRONT_Z = CAMPUS_ENTRY_LAYOUT.shellFrontZ / DEPTH_SCALE;
const ENTRANCE_HALF = (CAMPUS_ENTRY_LAYOUT.shellOpeningWidth / 2 + 0.34) / WIDTH_SCALE;
// The envelope mirrors X only; Z uses the authored-to-world depth scale.
// The rough opening includes both 8 cm jambs around the 1.8 m clear doorway.
const EMERGENCY_PORTAL_Z = F1_EMERGENCY_EXIT.center[2] / DEPTH_SCALE;
const EMERGENCY_PORTAL_HALF = (F1_EMERGENCY_EXIT.width / 2 + 0.1) / DEPTH_SCALE;

const SILVER = "#d7e0e5";
const SILVER_EDGE = "#aebec8";
const DARK_FRAME = "#425360";
const WARM_LIGHT = "#ffe0a7";

type Span = [number, number];

function DiamondPanel({
  position,
  size,
  rotationY = 0,
  texture,
  night: _night
}: {
  position: [number, number, number];
  size: [number, number];
  rotationY?: number;
  texture: CanvasTexture;
  night: number;
}) {
  return (
    <mesh castShadow receiveShadow position={position} rotation={[0, rotationY, 0]} userData={{ officeDynamic: true }}>
      <planeGeometry args={size} />
      <meshStandardMaterial
        color={SILVER}
        map={texture}
        bumpMap={texture}
        bumpScale={0.025}
        metalness={0.58}
        roughness={0.36}
        side={DoubleSide}
      />
    </mesh>
  );
}

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
  return (
    <mesh position={position} rotation={[0, rotationY, 0]}>
      <planeGeometry args={size} />
      <meshPhysicalMaterial
        color={corner ? "#9fc7da" : "#b1cdd9"}
        roughness={0.12}
        metalness={0}
        clearcoat={0.45}
        clearcoatRoughness={0.1}
        transparent
        opacity={corner ? 0.44 : 0.4}
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
        emissiveIntensity={night * 0.65}
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

function FrontBands({ texture, night }: { texture: CanvasTexture; night: number }) {
  // The east corner belongs to the continuous glass pavilion. The central
  // opening belongs to the atrium and entrance, rather than the ribbon wings.
  const wings: Span[] = [[-HALF_W, -6.25], [6.25, 16.15]] as const;
  return (
    <group>
      {Array.from({ length: 6 }, (_, band) => {
        const y = band * BAND_H;
        const offset = band % 2 === 0 ? 0.21 : 0.42;
        const faceZ = FRONT_Z - offset;
        return (
          <group key={band}>
            {wings.map(([start, end], index) => {
              const center = (start + end) / 2;
              const width = end - start;
              return (
                <group key={index}>
                  <DiamondPanel position={[center, y + 0.52, faceZ]} size={[width, 1.04]} texture={texture} night={night} />
                  <BlueGlass position={[center, y + 1.73, faceZ + 0.015]} size={[width, 1.38]} night={night} />
                  <DiamondPanel position={[center, y + 2.80, faceZ]} size={[width, 0.8]} texture={texture} night={night} />
                  {Array.from({ length: Math.ceil(width / 3) - 1 }, (_, bay) => {
                    const x = start + ((bay + 1) * width) / Math.ceil(width / 3);
                    return <Mullion key={bay} position={[x, y + 1.73, faceZ - 0.03]} size={[0.075, 1.4, 0.11]} night={night} />;
                  })}
                  <RibbonCap position={[center, y + 3.15, faceZ - 0.25]} size={[width + 0.12, 0.16, 0.52]} night={night} />
                  <EdgeLight position={[center, y + 3.055, faceZ - 0.53]} size={[width - 0.08, 0.024, 0.025]} night={night} />
                </group>
              );
            })}
          </group>
        );
      })}
    </group>
  );
}

function SideAndRearBands({ texture, night }: { texture: CanvasTexture; night: number }) {
  return (
    <group>
      {Array.from({ length: 6 }, (_, band) => {
        const y = band * BAND_H;
        const rearZ = band >= 4 ? F3_REAR_Z : HALF_D;
        const terracePortal = band === 4;
        const rearSpans: Span[] = terracePortal
          ? [[-HALF_W, TERRACE_PORTAL_X - TERRACE_PORTAL_HALF],
             [TERRACE_PORTAL_X + TERRACE_PORTAL_HALF, HALF_W]] as const
          : [[-HALF_W, HALF_W]] as const;
        return (
          <group key={band}>
            {/* Upper rear ribbons follow the terrace setback and its real doorway. */}
            {rearSpans.map(([start, end]) => <group key={start}>
              <DiamondPanel position={[(start + end) / 2, y + 0.52, rearZ + 0.15]} size={[end - start, 1.04]} texture={texture} night={night} />
              <BlueGlass position={[(start + end) / 2, y + 1.73, rearZ + 0.16]} size={[end - start, 1.38]} night={night} />
              <DiamondPanel position={[(start + end) / 2, y + 2.80, rearZ + 0.15]} size={[end - start, 0.8]} texture={texture} night={night} />
            </group>)}
            {terracePortal && <DiamondPanel position={[TERRACE_PORTAL_X, y + 2.95, rearZ + 0.15]}
              size={[TERRACE_PORTAL_HALF * 2, 0.5]} texture={texture} night={night} />}
            <RibbonCap position={[0, y + 3.15, rearZ + 0.35]} size={[42.25, 0.16, 0.5]} night={night} />
            <EdgeLight position={[0, y + 3.055, rearZ + 0.62]} size={[42.1, 0.024, 0.025]} night={night} />
            {[-1, 1].map((side) => {
              // Authored elevations are mirrored below: local west is world east.
              // Cut the actual lift portals out of the skin, keeping the upper bands.
              const start = side > 0 ? -7 : -15;
              const end = rearZ;
              const emergencyPortal = side > 0 && band === 0;
              const spans: Span[] = emergencyPortal
                ? [[start, EMERGENCY_PORTAL_Z - EMERGENCY_PORTAL_HALF],
                   [EMERGENCY_PORTAL_Z + EMERGENCY_PORTAL_HALF, end]] as const
                : side < 0 && band % 2 === 0
                ? [[start, LIFT_PORTAL_CENTERS[0]! - LIFT_PORTAL_HALF],
                   ...LIFT_PORTAL_CENTERS.slice(1).map((center, i): Span => [LIFT_PORTAL_CENTERS[i]! + LIFT_PORTAL_HALF, center - LIFT_PORTAL_HALF]),
                   [LIFT_PORTAL_CENTERS.at(-1)! + LIFT_PORTAL_HALF, end]]
                : [[start, end]] as const;
              const x = side * (HALF_W + 0.16);
              return (
                <group key={side} name={emergencyPortal ? "f1-west-emergency-envelope" : undefined}>{spans.map(([a, b]) => {
                  const depth = b - a;
                  const z = (a + b) / 2;
                  return <group key={a}>
                  <DiamondPanel position={[x, y + 0.52, z]} size={[depth, 1.04]} rotationY={Math.PI / 2} texture={texture} night={night} />
                  <BlueGlass position={[x, y + 1.73, z]} size={[depth, 1.38]} rotationY={Math.PI / 2} night={night} />
                  <DiamondPanel position={[x, y + 2.80, z]} size={[depth, 0.8]} rotationY={Math.PI / 2} texture={texture} night={night} />
                  <RibbonCap position={[x + side * 0.2, y + 3.15, z]} size={[0.52, 0.16, depth]} night={night} />
                  <EdgeLight position={[x + side * 0.48, y + 3.055, z]} size={[0.025, 0.024, depth - 0.1]} night={night} />
                  </group>;
                })}
                {emergencyPortal && <>
                  {/* Only F1 is opened; lintel and ribbon remain above the door. */}
                  <DiamondPanel position={[x, 2.95, EMERGENCY_PORTAL_Z]} size={[EMERGENCY_PORTAL_HALF * 2, 0.5]} rotationY={Math.PI / 2} texture={texture} night={night} />
                  <RibbonCap position={[x + side * 0.2, 3.15, EMERGENCY_PORTAL_Z]} size={[0.52, 0.16, EMERGENCY_PORTAL_HALF * 2]} night={night} />
                  <EdgeLight position={[x + side * 0.48, 3.055, EMERGENCY_PORTAL_Z]} size={[0.025, 0.024, EMERGENCY_PORTAL_HALF * 2]} night={night} />
                </>}
                </group>
              );
            })}
          </group>
        );
      })}
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
      <BlueGlass position={[0, 11.6, FRONT_Z - 0.31]} size={[12.3, 15.2]} night={night} corner />
      {Array.from({ length: 5 }, (_, bay) => (
        <Mullion key={bay} position={[-4.92 + bay * 2.46, 11.55, FRONT_Z - 0.37]} size={[0.085, 15.25, 0.11]} night={night} />
      ))}
      {[-6.2, 6.2].map((edge) => (
        <RibbonCap key={edge} position={[edge, BUILDING_H / 2, FRONT_Z - 0.39]} size={[0.23, BUILDING_H, 0.36]} night={night} />
      ))}
      {[6.4, 12.8].map((level) => (
        <Mullion key={level} position={[0, level, FRONT_Z - 0.4]} size={[12.2, 0.1, 0.13]} night={night} />
      ))}
      {/* Glass on both sides of the exact shared ground-floor entrance gap. */}
      {[leftEntry, rightEntry].map(([start, end], index) => (
        <group key={index}>
          <BlueGlass position={[(start + end) / 2, 1.91, FRONT_Z - 0.24]} size={[end - start, 3.7]} night={night} corner />
          <Mullion position={[start, 1.93, FRONT_Z - 0.32]} size={[0.1, 3.8, 0.12]} night={night} />
          <Mullion position={[end, 1.93, FRONT_Z - 0.32]} size={[0.1, 3.8, 0.12]} night={night} />
        </group>
      ))}
      <RibbonCap position={[0, 3.86, FRONT_Z - 0.42]} size={[12.35, 0.23, 0.7]} night={night} />
      <EdgeLight position={[x, 3.72, FRONT_Z - 0.79]} size={[ENTRANCE_HALF * 2, 0.045, 0.035]} night={night} />
      {/* Suspended entrance canopy: its columns stay well outside the route. */}
      <RibbonCap position={[0, 3.68, -16.45]} size={[11.8, 0.28, 2.75]} night={night} />
      <mesh position={[0, 3.51, -16.45]} userData={{ officeDynamic: true }}>
        <boxGeometry args={[11.45, 0.04, 2.5]} />
        <meshStandardMaterial color="#c9a77d" roughness={0.7} />
      </mesh>
      <EdgeLight position={[0, 3.5, -17.83]} size={[11.7, 0.045, 0.05]} night={night} />
      {[-5.35, 5.35].map((column) => (
        <Mullion key={column} position={[column, 1.73, -17.7]} size={[0.14, 3.46, 0.14]} night={night} />
      ))}
      {[-4.25, -3.25, 3.25, 4.25].map((downlight) => (
        <CanopyDownlightFixture key={downlight} position={[downlight, 3.47, -16.45]} diameter={0.2} realLight={Math.abs(downlight) === 3.25} />
      ))}
      {[-3.45, 3.45].map((sconce) => (
        <WallSconceFixture key={sconce} position={[sconce, 2.55, FRONT_Z - 0.15]} rotation={[0, 0, 0]} isExterior />
      ))}
    </group>
  );
}

function AngularBeam({
  from,
  to,
  z,
  width,
  night,
  texture
}: {
  from: [number, number];
  to: [number, number];
  z: number;
  width: number;
  night: number;
  texture: CanvasTexture;
}) {
  const dx = to[0] - from[0]!;
  const dy = to[1] - from[1]!;
  return (
    <group position={[(from[0] + to[0]!) / 2, (from[1] + to[1]!) / 2, z]} rotation={[0, 0, Math.atan2(dy, dx)]}>
      <mesh castShadow userData={{ officeDynamic: true }}>
        <boxGeometry args={[Math.hypot(dx, dy) + 0.16, width, 0.6]} />
        <meshStandardMaterial map={texture} color={SILVER} metalness={0.52} roughness={0.4} />
      </mesh>
      <EdgeLight position={[0, -width / 2 + 0.055, -0.315]} size={[Math.hypot(dx, dy), 0.035, 0.025]} night={night} />
    </group>
  );
}

function SignatureRibbon({ night, texture }: { night: number; texture: CanvasTexture }) {
  const upper: [number, number][] = [[-20.8, 9.4], [-10.9, 9.4], [-4.5, 12.8], [6.2, 12.8]] as const;
  const lower: [number, number][] = [[-20.8, 6.4], [-11.5, 6.4], [-5.8, 3.95], [5.0, 3.95], [12.0, 0.95]] as const;
  return (
    <group>
      {upper.slice(0, -1).map((point, index) => (
        <AngularBeam key={`upper-${index}`} from={point} to={upper[index + 1]!} z={FRONT_Z - 0.91} width={0.9} night={night} texture={texture} />
      ))}
      {lower.slice(0, -1).map((point, index) => (
        <AngularBeam key={`lower-${index}`} from={point} to={lower[index + 1]!} z={FRONT_Z - 1.02} width={0.94} night={night} texture={texture} />
      ))}
    </group>
  );
}

function CornerPavilion({ night }: { night: number }) {
  return (
    <group>
      <BlueGlass position={[18.57, BUILDING_H / 2, FRONT_Z - 0.26]} size={[4.86, BUILDING_H - 0.16]} night={night} corner />
      <BlueGlass position={[HALF_W + 0.25, BUILDING_H / 2, -11.02]} size={[7.9, BUILDING_H - 0.16]} rotationY={Math.PI / 2} night={night} corner />
      {[16.15, 18.55, 20.95].map((x) => (
        <Mullion key={x} position={[x, BUILDING_H / 2, FRONT_Z - 0.34]} size={[0.12, BUILDING_H, 0.18]} night={night} />
      ))}
      {[-15, -12.35, -9.7, -7.08].map((z) => (
        <Mullion key={z} position={[HALF_W + 0.31, BUILDING_H / 2, z]} size={[0.18, BUILDING_H, 0.12]} night={night} />
      ))}
      {[6.4, 12.8].map((y) => (
        <group key={y}>
          <Mullion position={[18.58, y, FRONT_Z - 0.37]} size={[4.9, 0.11, 0.18]} night={night} />
          <Mullion position={[HALF_W + 0.32, y, -11.04]} size={[0.18, 0.11, 8.05]} night={night} />
        </group>
      ))}
    </group>
  );
}

export function RoofEnvelope({ night, texture }: { night: number; texture: CanvasTexture }) {
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
      {[-1, 1].map((side) => (
        <group key={side}>
          <RibbonCap position={[0, 19.65, side < 0 ? -HALF_D - 0.32 : F3_REAR_Z + 0.32]} size={[42.85, 0.72, 0.32]} night={night} />
          <DiamondPanel position={[0, 19.65, side < 0 ? -HALF_D - 0.49 : F3_REAR_Z + 0.49]} size={[42.85, 0.7]} texture={texture} night={night} />
          <EdgeLight position={[0, 20.02, side < 0 ? -HALF_D - 0.5 : F3_REAR_Z + 0.5]} size={[42.6, 0.035, 0.035]} night={night} />
          {/* This roof sits outside the mirrored facade group: negative X is west. */}
          {(side === -1 ? [
            [-HALF_D - 0.425, (MAINTENANCE_STAIR_LAYOUT.upperLandingNorth - 0.08) / DEPTH_SCALE],
            [(MAINTENANCE_STAIR_LAYOUT.upperLandingSouth + 0.08) / DEPTH_SCALE, F3_REAR_Z + 0.425]
          ] as const : [[-HALF_D - 0.425, F3_REAR_Z + 0.425]] as const).map(([north, south]) => {
            const z = (north + south) / 2;
            const length = south - north;
            return <group key={north}>
              <RibbonCap position={[side * 21.32, 19.65, z]} size={[0.32, 0.72, length]} night={night} />
              <DiamondPanel position={[side * 21.49, 19.65, z]} size={[length, 0.7]} rotationY={Math.PI / 2} texture={texture} night={night} />
              <EdgeLight position={[side * 21.5, 20.02, z]} size={[0.035, 0.035, length]} night={night} />
            </group>;
          })}
        </group>
      ))}
    </group>
  );
}

function CampusBrandSigns({ night }: { night: number }) {
  const canvas = useMemo(() => document.createElement("canvas"), []);
  const texture = useMemo(() => {
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    return result;
  }, [canvas]);

  useEffect(() => {
    canvas.width = 1024;
    canvas.height = 208;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawExtaliaBrand(ctx, { centerX: 512, centerY: 104, height: 140, maxWidth: 940 });
    texture.needsUpdate = true;
  }, [canvas, texture]);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <group>
      {/* Entrance fascia retains its texture; the roof brand is extruded geometry. */}
      <group position={[(CAMPUS_ENTRY_LAYOUT.centerX - OFFICE_BUILDING.centerX) / WIDTH_SCALE, 3.98, -17.91]}>
        <mesh castShadow>
          <boxGeometry args={[6.4, 0.7, 0.12]} />
          <meshStandardMaterial color="#263944" roughness={0.38} metalness={0.5} />
        </mesh>
        <mesh position={[0, 0, -0.071]} rotation={[0, Math.PI, 0]} userData={{ officeDynamic: true }}>
          <planeGeometry args={[3.05, 0.62]} />
          <meshStandardMaterial map={texture} emissiveMap={texture} emissive="#ffffff" emissiveIntensity={night * 0.65} roughness={0.35} transparent alphaTest={0.04} depthWrite={false} />
        </mesh>
        <EdgeLight position={[0, -0.36, -0.065]} size={[6.3, 0.035, 0.03]} night={night} />
      </group>
    </group>
  );
}

export function CampusBuildingShell() {
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  const texture = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 1024;
    canvas.height = 128;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#e5ecf0";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#a8b8c3";
      ctx.lineWidth = 1.2;
      for (let x = -128; x < 1152; x += 64) {
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x + 64, 128);
        ctx.moveTo(x + 64, 0);
        ctx.lineTo(x, 128);
        ctx.stroke();
      }
    }
    const result = new CanvasTexture(canvas);
    result.colorSpace = SRGBColorSpace;
    result.anisotropy = 4;
    return result;
  }, []);
  useEffect(() => () => texture.dispose(), [texture]);

  return (
    <group position={[OFFICE_BUILDING.centerX, 0, 0]} scale={[WIDTH_SCALE, 1, DEPTH_SCALE]}>
      <group scale={[-1, 1, 1]}>
        <FrontBands texture={texture} night={night} />
        <SideAndRearBands texture={texture} night={night} />
        <AtriumAndEntrance night={night} />
        <CornerPavilion night={night} />
        <SignatureRibbon texture={texture} night={night} />
      </group>
      <RoofEnvelope night={night} texture={texture} />
      <CampusBrandSigns night={night} />
    </group>
  );
}
