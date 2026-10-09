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
import { FixtureSpotLight } from "./FixtureSpotLight";
import { useStructuralCeiling } from "./StructuralCeilingContext";
import { raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";

/** A compact, shielded post casts a finite pool without covering the open sky. */
function TerraceLantern({ position, aim, factor, name }: {
  position: [number, number, number];
  aim: [number, number, number];
  factor: number;
  name: string;
}) {
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
      intensity={factor * 14} distance={5.3} angle={1.2} color="#ffdfb3" />
  </group>;
}

/** Open terrace above the F2 roof slab, with an unobstructed entrance and skyline. */
export function RooftopTerrace() {
  const t = F3_TERRACE;
  const { ceilingY } = useStructuralCeiling();
  const entryAnchorY = ceilingY - 0.05;
  const entrySourceY = entryAnchorY - 0.059;
  const { state } = useSolarEnvironment();
  const lightFactor = state.factors.exteriorLightFactor;
  const floorVisible = useFloorVisible();
  const westGuard = t.west + t.guardInset;
  const eastGuard = t.east - t.guardInset;
  const rearGuard = t.south - t.guardInset;
  const sideLength = rearGuard - t.north;
  return (
    <group name="office-room:rooftop-terrace">
      <FloorFinish size={[...t.size]} position={[t.center[0], 0, t.center[1]]} material="oak" thickness={0.045} />
      {/* The only entrance is the glazed opening between the CEO and wellness rooms. */}
      <GlassPartition width={t.entryEast - t.entryWest} height={2.85}
        position={[t.door.center[0], 1.425, t.north]} doorGap={t.door.width + 0.22}
        doorHeight={t.door.height + 0.16} />
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
          intensity={lightFactor * raisedDownlightIntensity(20, 2.761, entrySourceY, 0.08, 4.2)}
          distance={raisedDownlightRange(4.2, 2.761, entrySourceY, 0.08)}
          angle={raisedDownlightAngle(0.85, 2.761, entrySourceY, 0.08)} color="#ffdfb3" />
      </group>
      <LandingRail position={[(westGuard + eastGuard) / 2, 0, rearGuard]}
        length={eastGuard - westGuard} exterior />
      <LandingRail position={[eastGuard, 0, (t.north + rearGuard) / 2]}
        length={sideLength} rotationY={Math.PI / 2} exterior />
      {/* Service gate connects the deck to the exterior maintenance stair. */}
      <LandingRail position={[westGuard, 0, (t.north + MAINTENANCE_STAIR_LAYOUT.lowerLandingNorth - 0.08) / 2]}
        length={MAINTENANCE_STAIR_LAYOUT.lowerLandingNorth - 0.08 - t.north}
        rotationY={Math.PI / 2} exterior />
      {t.sofas.map(sofa => <Sofa key={sofa.id} position={[...sofa.position]}
        rotationY={sofa.rotationY} color="#72877c" />)}
      {t.armchairs.map(chair => <ArmChair key={chair.id} position={[...chair.position]}
        rotationY={chair.rotationY} color="#c7bb9f" />)}
      {t.tables.map(position => <CoffeeTable key={position[0]} position={[...position]} />)}
      {t.planters.map(position => <Plant key={`${position[0]}-${position[2]}`}
        position={[...position]} scale={1.55} />)}
      {/* Small posts stay behind seats, away from the entrance and front seat approaches. */}
      {t.armchairs.map(chair => <TerraceLantern key={chair.id} name={chair.id}
        position={[chair.position[0], 0, rearGuard - 0.45]}
        aim={[chair.position[0], 0.15, chair.position[2] - 1.1]} factor={lightFactor} />)}
      {t.sofas.map((sofa, index) => <TerraceLantern key={sofa.id} name={sofa.id}
        position={[sofa.position[0] + (index === 0 ? -1.6 : 1.6), 0, t.north + 0.65]}
        aim={[sofa.position[0], 0.35, sofa.position[2] + 1.1]} factor={lightFactor} />)}
      <SceneLabel position={[t.door.center[0], 3.08, t.north - 0.18]} center
        style={{ display: floorVisible ? "block" : "none" }}>
        <div className="room-label">Open Air Relaxation Terrace</div>
      </SceneLabel>
    </group>
  );
}
