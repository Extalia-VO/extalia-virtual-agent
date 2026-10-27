import type { SmartScreenData } from "../../screenData";
import { useSolarEnvironment } from "../../../Environment";
import { FixtureSpotLight } from "../architecture/FixtureSpotLight";
import { useStructuralCeiling } from "../architecture/StructuralCeilingContext";
import { OfficeChair } from "../furniture/OfficeChair";
import { WallDisplay } from "../props/WallDisplay";
import { Whiteboard } from "../props/Whiteboard";
import { meetingSeatLayout, type MeetingRoomBlueprint } from "../../spatialBlueprints";

export function MeetingTable({
  length,
  width,
  position = [0, 0, 0]
}: {
  length: number;
  width: number;
  position?: [number, number, number];
}) {
  const { state } = useSolarEnvironment();
  const { mounts } = useStructuralCeiling();
  const lightFactor = state.factors.interiorLightFactor;
  const lampLength = length * 0.86;
  const lampPoints = Math.max(3, Math.ceil(lampLength / 1.8));
  const { bodyY, sourceY } = mounts.meeting;
  const canopyY = mounts.meeting.canopyY - position[1];
  const canopyBottomY = canopyY - 0.045 / 2;
  const bodyTopY = bodyY + 0.08 / 2;
  const suspensionLength = canopyBottomY - bodyTopY;
  const suspensionY = (canopyBottomY + bodyTopY) / 2;

  return (
    <group position={position}>
      {/* Every table carries its own suspended task light, aligned with its long axis. */}
      <group name="meeting-table-linear-light" userData={{ officeCollision: false }}>
        <mesh name="structural-meeting-canopy" position={[0, canopyY, 0]}>
          <boxGeometry args={[lampLength * 0.74, 0.045, 0.1]} />
          <meshStandardMaterial color="#38433f" roughness={0.6} metalness={0.45} />
        </mesh>
        {[-1, 1].map(side => <mesh key={side} position={[side * lampLength * 0.34, suspensionY, 0]}>
          <cylinderGeometry args={[0.008, 0.008, suspensionLength, 6]} />
          <meshStandardMaterial color="#65716a" roughness={0.5} metalness={0.55} />
        </mesh>)}
        <mesh position={[0, bodyY, 0]}>
          <boxGeometry args={[lampLength, 0.08, 0.24]} />
          <meshStandardMaterial color="#38433f" roughness={0.6} metalness={0.45} />
        </mesh>
        <mesh position={[0, bodyY - 0.045, 0]}
          userData={{ officeMaterialDynamic: "meeting-table-linear:interior:#fff1df:factor*2.4" }}>
          <boxGeometry args={[lampLength - 0.08, 0.016, 0.18]} />
          <meshStandardMaterial color="#fff1df" emissive="#fff1df"
            emissiveIntensity={lightFactor * 2.4} roughness={0.25} toneMapped={false} />
        </mesh>
        {Array.from({ length: lampPoints }, (_, i) => {
          const x = lampLength * ((i + 0.5) / lampPoints - 0.5);
          return <FixtureSpotLight key={i} name="meeting-table-task-beam" position={[x, sourceY, 0]}
            aim={[x, 0.81, 0]} color="#fff1df" intensity={lightFactor * 24} distance={4.2} angle={1} />;
        })}
      </group>

      <mesh castShadow receiveShadow position={[0, 0.74, 0]}>
        <boxGeometry args={[length, 0.11, width]} />
        <meshStandardMaterial color="#74604e" roughness={0.74} />
      </mesh>

      <mesh position={[0, 0.804, 0]}>
        <boxGeometry args={[length - 0.12, 0.004, width - 0.12]} />
        <meshStandardMaterial color="#ae8965" roughness={0.67} />
      </mesh>

      {/* Dark reveal under the top and a pair of restrained end supports. */}
      <mesh castShadow position={[0, 0.665, 0]}>
        <boxGeometry args={[length - 0.18, 0.045, width - 0.18]} />
        <meshStandardMaterial color="#4d5551" roughness={0.61} metalness={0.18} />
      </mesh>

      {/* Flush power and cable panel keeps the discussion surface clear. */}
      <mesh position={[0, 0.812, 0]}>
        <boxGeometry args={[Math.min(1.3, length * 0.3), 0.01, 0.18]} />
        <meshStandardMaterial color="#364442" metalness={0.42} roughness={0.42} />
      </mesh>

      {[-0.43, 0.43].map((x) => (
        <mesh key={x} position={[x, 0.819, 0]} rotation={[-Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.035, 12]} />
          <meshStandardMaterial color="#aeb9b2" metalness={0.45} roughness={0.44} />
        </mesh>
      ))}

      <mesh castShadow position={[-length * 0.32, 0.37, 0]}>
        <boxGeometry args={[0.16, 0.74, width * 0.75]} />
        <meshStandardMaterial color="#d2ccc1" roughness={0.88} />
      </mesh>

      <mesh castShadow position={[length * 0.32, 0.37, 0]}>
        <boxGeometry args={[0.16, 0.74, width * 0.75]} />
        <meshStandardMaterial color="#d2ccc1" roughness={0.88} />
      </mesh>
      {[-1, 1].map((side) => (
        <mesh key={`foot-${side}`} castShadow position={[side * length * 0.32, 0.045, 0]}>
          <boxGeometry args={[0.23, 0.045, width * 0.79]} />
          <meshStandardMaterial color="#555e59" metalness={0.25} roughness={0.58} />
        </mesh>
      ))}
    </group>
  );
}

/**
 * Presentation wall is deliberately placed on the LEFT END of the table,
 * not on the glass entrance / door wall.
 *
 * `roomSize` is required so the display can hug the actual room wall.
 */
export function MeetingRoomFurniture({
  position = [0, 0, 0],
  blueprint,
  screenData
}: {
  position?: [number, number, number];
  blueprint: MeetingRoomBlueprint;
  screenData: SmartScreenData;
}) {
  const chairPositions = meetingSeatLayout(blueprint.seats, blueprint.tableLength, blueprint.tableWidth);

  return (
    <group position={position} userData={{ officeSeatStation: true }}>
      <MeetingTable length={blueprint.tableLength} width={blueprint.tableWidth} />

      {chairPositions.map((chair, i) => (
        <OfficeChair key={`chair-${i}`} {...chair} />
      ))}

      {/*
        Dedicated full-height presentation wall.
        It is perpendicular to the glass corridor/door wall.
      */}
      <mesh
        castShadow
        receiveShadow
        position={blueprint.presentationWall.position}
      >
        <boxGeometry args={blueprint.presentationWall.size} />
        <meshStandardMaterial color="#f3f1ec" roughness={0.92} />
      </mesh>

      {/* Screen faces +X into the meeting room. */}
      <WallDisplay
        position={[...blueprint.screen.position]}
        rotationY={blueprint.screen.rotationY}
        width={blueprint.screen.width}
        height={blueprint.screen.height}
        variant="presentation"
        data={screenData}
      />

      {/* Whiteboard shares the presentation wall but stays clear of the TV. */}
      <Whiteboard
        position={[...blueprint.whiteboard.position]}
        rotationY={blueprint.whiteboard.rotationY}
        width={blueprint.whiteboard.width}
      />
    </group>
  );
}
