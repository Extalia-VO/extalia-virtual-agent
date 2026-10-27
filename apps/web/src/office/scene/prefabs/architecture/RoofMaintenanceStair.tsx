import { FLOOR_HEIGHT, OFFICE_BUILDING } from "../../layout";
import { LandingRail } from "./Staircase";
import { OpenDoor } from "../../interior/prefabs/architecture/OpenDoor";
import { StaticCampusBatch } from "../../StaticCampusBatch";
import { useSolarEnvironment } from "../../Environment";
import { FixtureSpotLight } from "./FixtureSpotLight";

/** West exterior access keeps the open terrace and its occupied seating bays clear. */
export const MAINTENANCE_STAIR_LAYOUT = Object.freeze({
  x: -22.45,
  width: 1.2,
  lowerY: FLOOR_HEIGHT * 2,
  roofY: 19.33,
  northZ: 6.8,
  southZ: 17.6,
  steps: 36,
  landingWest: -23.05,
  landingEast: -20.3,
  lowerLandingNorth: 17.6,
  lowerLandingSouth: 18.8,
  upperLandingNorth: 5.6,
  upperLandingSouth: 6.8,
  terraceGate: [OFFICE_BUILDING.west + 0.15, FLOOR_HEIGHT * 2, 18.2] as const,
  roofGate: [-21.35, 19.33, 6.2] as const,
  gateWidth: 1.2
});

/** Evaluated Blender landing/tread bounds, converted to app X/Y/Z (Y is elevation). */
export const MODEL_MAINTENANCE_STAIR_LAYOUT = Object.freeze({
  ...MAINTENANCE_STAIR_LAYOUT,
  x: -22.2,
  width: 1.65,
  northZ: 6.95,
  southZ: 13.6,
  landingWest: -23.345,
  landingEast: -20.495,
  lowerLandingNorth: 13.25,
  lowerLandingSouth: 14.95,
  upperLandingNorth: 5.35,
  upperLandingSouth: 7.05,
  terraceGate: [-20.72, FLOOR_HEIGHT * 2, 14.1] as const,
  roofGate: [-21.35, 19.33, 6.2] as const,
});

type AccessLayout = typeof MAINTENANCE_STAIR_LAYOUT | typeof MODEL_MAINTENANCE_STAIR_LAYOUT;

/** Five app-owned fixtures: three along the selected flight and one at each landing. */
export function maintenanceStairLightSources(modelShown: boolean) {
  const s: AccessLayout = modelShown ? MODEL_MAINTENANCE_STAIR_LAYOUT : MAINTENANCE_STAIR_LAYOUT;
  const rise = s.roofY - s.lowerY, run = s.southZ - s.northZ;
  const sources = [0.2, 0.5, 0.8].map(t => ({
    position: [modelShown ? -23.0 : s.x - s.width / 2 + 0.065, s.lowerY + rise * t + 0.92, s.southZ - run * t] as [number, number, number],
    aim: [s.x, s.lowerY + rise * t + 0.04, s.southZ - run * t] as [number, number, number],
    floorY: s.lowerY
  }));
  sources.push({ position: [s.landingEast - 0.16, s.lowerY + 1.02, s.lowerLandingSouth],
    aim: [...s.terraceGate], floorY: s.lowerY });
  sources.push({ position: [(modelShown ? -21.3 : s.landingEast) - 0.16, s.roofY + 1.02, s.upperLandingNorth],
    aim: [...s.roofGate], floorY: Math.floor(s.roofY / FLOOR_HEIGHT) * FLOOR_HEIGHT });
  return sources;
}

export function MaintenanceStairLighting({ modelShown }: { modelShown: boolean }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.exteriorLightFactor;
  const sources = maintenanceStairLightSources(modelShown);
  return <group name="maintenance-stair-lighting" userData={{ officeCollision: false }}>
    {sources.map((source, i) => <group key={i} position={source.position}>
      <mesh><boxGeometry args={[0.13, 0.055, 0.1]} /><meshStandardMaterial color="#5b696a" metalness={0.35} roughness={0.6} /></mesh>
      <mesh position={[0, -0.032, 0]} userData={{ officeMaterialDynamic: "maintenance-stair-lens:exterior:#fff0db:factor*1.2" }}>
        <boxGeometry args={[0.09, 0.012, 0.08]} /><meshStandardMaterial color="#eee5d7" emissive="#fff0db"
          emissiveIntensity={factor * 1.2} toneMapped={false} roughness={0.5} />
      </mesh>
      <FixtureSpotLight name="maintenance-stair-downlight" position={[0, -0.04, 0]}
        aim={[source.aim[0] - source.position[0]!, source.aim[1] - source.position[1]!, source.aim[2] - source.position[2]!]}
        intensity={factor * 8} distance={3.2} angle={1.0} floorY={source.floorY} color="#fff0db" />
    </group>)}
  </group>;
}

/** Procedural static structure only; gates and fixtures belong to the app in either mode. */
export function RoofMaintenanceStairStructure() {
  const s = MAINTENANCE_STAIR_LAYOUT;
  const rise = s.roofY - s.lowerY;
  const run = s.southZ - s.northZ;
  const tread = run / s.steps;
  const angle = Math.atan2(rise, run);
  const slopeLength = Math.hypot(rise, run);
  const westGuard = s.landingWest + 0.04;
  const stairEast = s.x + s.width / 2 - 0.04;
  const landingEast = s.landingEast;
  return <group name="roof-maintenance-stair-structure" userData={{ officeMaintenanceAccess: true }}>
    {[-1, 1].map(side => <group key={side}>
      <mesh castShadow position={[s.x + side * (s.width / 2 - 0.07), s.lowerY + rise / 2 - 0.17, (s.northZ + s.southZ) / 2]} rotation={[angle, 0, 0]}>
        <boxGeometry args={[0.1, 0.25, slopeLength]} /><meshStandardMaterial color="#45575b" metalness={0.72} roughness={0.38} />
      </mesh>
      {[0.55, 1.12].map(height => <mesh key={height} castShadow
        position={[s.x + side * (s.width / 2 - 0.04), s.lowerY + rise / 2 + height, (s.northZ + s.southZ) / 2]} rotation={[angle, 0, 0]}>
        <boxGeometry args={[0.045, 0.045, slopeLength]} /><meshStandardMaterial color="#b3c2c2" metalness={0.78} roughness={0.28} />
      </mesh>)}
      {Array.from({ length: 13 }, (_, i) => {
        const t = i / 12;
        return <mesh key={i} castShadow position={[s.x + side * (s.width / 2 - 0.04), s.lowerY + rise * t + 0.56, s.southZ - run * t]}>
          <boxGeometry args={[0.04, 1.12, 0.04]} /><meshStandardMaterial color="#71868b" metalness={0.66} roughness={0.4} />
        </mesh>;
      })}
    </group>)}
    {Array.from({ length: s.steps }, (_, i) => <group key={i}
      position={[s.x, s.lowerY + rise * (i + 1) / s.steps, s.southZ - tread * (i + 0.5)]}>
      <mesh castShadow receiveShadow position={[0, -0.035, 0]}><boxGeometry args={[s.width, 0.07, tread + 0.015]} /><meshStandardMaterial color="#8c9e9f" metalness={0.65} roughness={0.65} /></mesh>
      <mesh position={[0, 0.004, tread / 2 - 0.02]}><boxGeometry args={[s.width - 0.05, 0.01, 0.035]} /><meshStandardMaterial color="#d7c99b" roughness={0.78} /></mesh>
    </group>)}
    {[
      { y: s.lowerY, north: s.lowerLandingNorth, south: s.lowerLandingSouth },
      { y: s.roofY, north: s.upperLandingNorth, south: s.upperLandingSouth }
    ].map((landing, i) => {
      const depth = landing.south - landing.north;
      const closedZ = i === 0 ? landing.south : landing.north;
      const flightZ = i === 0 ? landing.north : landing.south;
      return <group key={i} name={i === 0 ? "terrace-maintenance-landing" : "roof-maintenance-landing"}>
        <mesh castShadow receiveShadow position={[(s.landingWest + s.landingEast) / 2, landing.y - 0.065, (landing.north + landing.south) / 2]}>
          <boxGeometry args={[s.landingEast - s.landingWest, 0.13, depth]} /><meshStandardMaterial color="#788e8c" metalness={0.55} roughness={0.75} />
        </mesh>
        <LandingRail position={[(westGuard + landingEast) / 2, landing.y, closedZ]} length={landingEast - westGuard} exterior />
        <LandingRail position={[westGuard, landing.y, (landing.north + landing.south) / 2]} length={depth} rotationY={Math.PI / 2} exterior />
        <LandingRail position={[(stairEast + landingEast) / 2, landing.y, flightZ]} length={landingEast - stairEast} exterior />
      </group>;
    })}
    {/* Outer landing column and mid-flight support remain outside the facade. */}
    {[{ z: 18.4, height: s.lowerY }, { z: 12.2, height: s.lowerY + rise / 2 }].map(({ z, height }) =>
      <mesh key={z} castShadow position={[westGuard + 0.12, height / 2, z]}><boxGeometry args={[0.16, height, 0.16]} /><meshStandardMaterial color="#53666a" metalness={0.68} roughness={0.42} /></mesh>)}
  </group>;
}

/** Model readiness replaces static meshes only, preserving both traffic-driven gates and fixtures. */
export function RoofMaintenanceStair({ modelShown = false }: { modelShown?: boolean }) {
  const s: AccessLayout = modelShown ? MODEL_MAINTENANCE_STAIR_LAYOUT : MAINTENANCE_STAIR_LAYOUT;
  return <group name="roof-maintenance-stair" userData={{ officeMaintenanceAccess: true }}>
    {!modelShown && <StaticCampusBatch><RoofMaintenanceStairStructure /></StaticCampusBatch>}
    <MaintenanceStairLighting key={modelShown ? "model" : "fallback"} modelShown={modelShown} />
    <OpenDoor position={[...s.terraceGate]} rotationY={Math.PI / 2} width={s.gateWidth} height={1.12}
      floor={3} roomId="roof-maintenance" role="terrace-gate" glass />
    <OpenDoor position={[...s.roofGate]} rotationY={Math.PI / 2} width={s.gateWidth} height={1.12}
      floor={3} roomId="roof-maintenance" role="roof-gate" glass />
  </group>;
}
