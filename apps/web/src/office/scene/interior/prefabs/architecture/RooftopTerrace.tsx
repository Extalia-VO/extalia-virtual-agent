import { F3_TERRACE } from "../../floor1Layout";
import { useSolarEnvironment } from "../../../Environment";
import { SceneLabel } from "../../SceneLabel";
import { useFloorVisible } from "../../FloorVisibilityContext";
import { FloorFinish } from "../finishes/FloorFinish";
import { ArmChair, Sofa } from "../furniture/Sofa";
import { CoffeeTable } from "../furniture/TablesAndStorage";
import { Plant } from "../props/Plant";
import { GlassPartition } from "./GlassPartition";
import { SlidingDoor } from "./SlidingDoor";
import { LandingRail } from "../../../prefabs/architecture/Staircase";
import { MAINTENANCE_STAIR_LAYOUT } from "../../../prefabs/architecture/RoofMaintenanceStair";
import { useCampusModelReady } from "../../../campusModels";
import { StaticCampusBatch } from "../../../StaticCampusBatch";
import { EnvelopeWall } from "../../ExteriorEnvelopeContext";
import { FixtureSpotLight } from "./FixtureSpotLight";
import { useStructuralCeiling } from "./StructuralCeilingContext";
import { raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";

type TerraceLanternFixture = {
  name: string; position: [number, number, number]; aim: [number, number, number];
  intensity: number; distance: number; angle: number;
};

/** Seat pools and shielded walking-edge posts share one layout, including the bake's regression probes. */
export const TERRACE_LANTERN_FIXTURES: readonly TerraceLanternFixture[] = [
  ...F3_TERRACE.armchairs.map(chair => ({ name: chair.id,
    position: [chair.position[0], 0, F3_TERRACE.south - F3_TERRACE.guardInset - 0.45] as [number, number, number],
    aim: [chair.position[0], 0.15, chair.position[2] - 1.1] as [number, number, number],
    intensity: 14, distance: 6.8, angle: 1.35 })),
  ...F3_TERRACE.sofas.map((sofa, index) => ({ name: sofa.id,
    position: [sofa.position[0] + (index === 0 ? -1.6 : 1.6), 0, F3_TERRACE.north + 0.65] as [number, number, number],
    aim: [sofa.position[0], 0.35, sofa.position[2] + 1.1] as [number, number, number],
    intensity: 14, distance: 6.8, angle: 1.35 })),
  // Beside planters and the walking edges; no post occupies the straight entrance lane (-0.5..2.5).
  ...[
    { name: "west-entry-path", x: -19, z: 15.95 },
    { name: "west-planter-path", x: -5.7, z: 18.45 },
    { name: "central-path", x: -1.3, z: 18.45 },
    { name: "east-planter-path", x: 6.3, z: 18.45 },
    { name: "west-front-path", x: -6, z: 13.55 },
    { name: "entry-side-path", x: -1.3, z: 13.55 },
    { name: "east-front-path", x: 7, z: 13.55 },
    { name: "west-seat-approach", x: -14.8, z: 13.55 },
    { name: "east-seat-approach", x: 18.3, z: 13.55 },
    { name: "east-entry-path", x: 22.8, z: 16.05 }
  ].map(({ name, x, z }) => ({ name, position: [x, 0, z] as [number, number, number],
    aim: [x, 0.08, z] as [number, number, number], intensity: 24, distance: 6.8, angle: 1.35 }))
];

export function terraceEntryFixture(ceilingY: number) {
  const sourceY = ceilingY - 0.05 - 0.059;
  return { position: [F3_TERRACE.door.center[0], sourceY, F3_TERRACE.north + 0.2] as [number, number, number],
    aim: [F3_TERRACE.door.center[0], 0.08, F3_TERRACE.north + 2.4] as [number, number, number],
    intensity: raisedDownlightIntensity(20, 2.761, sourceY, 0.08, 4.2),
    distance: raisedDownlightRange(4.2, 2.761, sourceY, 0.08),
    angle: raisedDownlightAngle(0.85, 2.761, sourceY, 0.08) };
}

/** A compact, shielded post casts a finite pool without covering the open sky. */
function TerraceLantern({ position, aim, factor, name, intensity, distance, angle }: TerraceLanternFixture & { factor: number }) {
  return <group position={position} name={`terrace-lantern:${name}`}>
    <mesh position={[0, 0.025, 0]}>
      <cylinderGeometry args={[0.11, 0.12, 0.05, 10]} />
      <meshStandardMaterial color="#35413c" roughness={0.65} metalness={0.35} />
    </mesh>
    <mesh position={[0, 1.12, 0]}>
      <cylinderGeometry args={[0.035, 0.045, 2.2, 8]} />
      <meshStandardMaterial color="#35413c" roughness={0.65} metalness={0.35} />
    </mesh>
    <mesh position={[0, 2.27, 0]}>
      <cylinderGeometry args={[0.19, 0.19, 0.08, 12]} />
      <meshStandardMaterial color="#35413c" roughness={0.65} metalness={0.35} />
    </mesh>
    <mesh position={[0, 2.222, 0]}
      userData={{ officeMaterialDynamic: "terrace-lantern:exterior:#ffdfb3:factor*1.3" }}>
      <cylinderGeometry args={[0.145, 0.145, 0.016, 12]} />
      <meshStandardMaterial color="#f3e4cd" emissive="#ffdfb3"
        emissiveIntensity={factor * 1.3} roughness={0.35} toneMapped={false} />
    </mesh>
    <FixtureSpotLight name={`terrace-${name}-beam`} position={[0, 2.209, 0]}
      aim={[aim[0] - position[0], aim[1] - position[1], aim[2] - position[2]]}
      intensity={factor * intensity} distance={distance} angle={angle} color="#ffdfb3" />
  </group>;
}

/** Open terrace above the F2 roof slab, with an unobstructed entrance and skyline. */
export function RooftopTerrace() {
  const t = F3_TERRACE;
  const { ceilingY } = useStructuralCeiling();
  const entryAnchorY = ceilingY - 0.05;
  const entry = terraceEntryFixture(ceilingY);
  const { state } = useSolarEnvironment();
  const lightFactor = state.factors.exteriorLightFactor;
  const floorVisible = useFloorVisible();
  // The Blender balustrade (terrace.glb) replaces these rails once it is on screen, opening onto its stair landing.
  const guardFromModel = useCampusModelReady("terrace");
  const westGuard = t.west + t.guardInset;
  const eastGuard = t.east - t.guardInset;
  const rearGuard = t.south - t.guardInset;
  const sideLength = rearGuard - t.north;
  return (
    <group name="office-room:rooftop-terrace">
      <FloorFinish profile="lower" size={[...t.size]} position={[t.center[0], 0, t.center[1]]} material="oak" thickness={0.045} />
      {/* The only entrance is the glazed opening between the CEO and wellness rooms. */}
      <EnvelopeWall exterior name="terrace:entry"><GlassPartition width={t.entryEast - t.entryWest} height={2.85}
        position={[t.door.center[0], 1.425, t.north]} doorGap={t.door.width + 0.22}
        doorHeight={t.door.height + 0.16} /></EnvelopeWall>
      <SlidingDoor position={[...t.door.center]} width={t.door.width} height={t.door.height}
        floor={3} roomId="rooftop-terrace" role="entry" />
      {/* The entry downlight mounts beneath the structural roof overhang. */}
      <group name="terrace-roof-entry-light" position={[t.door.center[0], entryAnchorY, t.north]}
        userData={{ officeCollision: false }}>
        <mesh name="structural-terrace-entry-mount" position={[0, 0, 0.095]}>
          <boxGeometry args={[1.16, 0.1, 0.025]} />
          <meshStandardMaterial color="#35413c" roughness={0.65} metalness={0.35} />
        </mesh>
        <mesh position={[0, 0, 0.2]}>
          <boxGeometry args={[1.1, 0.08, 0.2]} />
          <meshStandardMaterial color="#35413c" roughness={0.65} metalness={0.35} />
        </mesh>
        <mesh position={[0, -0.047, 0.2]}
          userData={{ officeMaterialDynamic: "terrace-entry:exterior:#ffdfb3:factor*1.8" }}>
          <boxGeometry args={[1.02, 0.014, 0.14]} />
          <meshStandardMaterial color="#f3e4cd" emissive="#ffdfb3"
            emissiveIntensity={lightFactor * 1.8} roughness={0.3} toneMapped={false} />
        </mesh>
        <FixtureSpotLight name="terrace-door-entry-beam" position={[0, -0.059, 0.2]}
          aim={[0, 0.08 - entryAnchorY, 2.4]}
          intensity={lightFactor * entry.intensity} distance={entry.distance} angle={entry.angle} color="#ffdfb3" />
      </group>
      {/* Keep the replaceable guard out of the floor-wide batch; its own batch unmounts with it. */}
      {!guardFromModel && <group name="terrace-procedural-guard" userData={{ officeDynamic: true }}><StaticCampusBatch>
        <LandingRail position={[(westGuard + eastGuard) / 2, 0, rearGuard]}
          length={eastGuard - westGuard} exterior />
        <LandingRail position={[eastGuard, 0, (t.north + rearGuard) / 2]}
          length={sideLength} rotationY={Math.PI / 2} exterior />
        {/* Service gate connects the deck to the exterior maintenance stair. */}
        <LandingRail position={[westGuard, 0, (t.north + MAINTENANCE_STAIR_LAYOUT.lowerLandingNorth - 0.08) / 2]}
          length={MAINTENANCE_STAIR_LAYOUT.lowerLandingNorth - 0.08 - t.north}
          rotationY={Math.PI / 2} exterior />
      </StaticCampusBatch></group>}
      {t.sofas.map(sofa => <Sofa key={sofa.id} position={[...sofa.position]}
        rotationY={sofa.rotationY} color="#72877c" />)}
      {t.armchairs.map(chair => <ArmChair key={chair.id} position={[...chair.position]}
        rotationY={chair.rotationY} color="#c7bb9f" />)}
      {t.tables.map(position => <CoffeeTable key={position[0]} position={[...position]} />)}
      {t.planters.map(position => <Plant key={`${position[0]}-${position[2]}`}
        position={[...position]} scale={1.55} />)}
      {TERRACE_LANTERN_FIXTURES.map(fixture => <TerraceLantern key={fixture.name} {...fixture} factor={lightFactor} />)}
      <SceneLabel position={[t.door.center[0], 3.08, t.north - 0.18]} center
        style={{ display: floorVisible ? "block" : "none" }}>
        <div className="room-label">Open Air Relaxation Terrace</div>
      </SceneLabel>
    </group>
  );
}
