import { FixtureSpotLight } from "./prefabs/architecture/FixtureSpotLight";
import { ceilingMountsForFloor, raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange, type CeilingFloor } from "./prefabs/architecture/ceilingMounting";
import { SceneLabel } from "./SceneLabel";
import { GlassPartition } from "./prefabs/architecture/GlassPartition";
import { OpenDoor } from "./prefabs/architecture/OpenDoor";
import { SlidingDoor } from "./prefabs/architecture/SlidingDoor";
import { SolidWall } from "./prefabs/architecture/SolidWall";
import { WindowWall } from "./prefabs/architecture/WindowWall";
import { FloorFinish, type FloorMaterial } from "./prefabs/finishes/FloorFinish";
import { useFloorVisible } from "./FloorVisibilityContext";
import { roomById } from "./worldRegistry";
import { classifyRoomEnvelope } from "./roomEnvelope";
import { EnvelopeWall } from "./ExteriorEnvelopeContext";
import { useSolarEnvironment } from "../Environment";

type EntrySide = "front" | "back";
type OppositeWall = "solid" | "windows";
/** Entry door mechanism: hinged swing leaf or automatic bi-parting glass slider. */
export type RoomDoorType = "swing" | "sliding";

export function RoomShell({
  roomId,
  label,
  position,
  size,
  entrySide = "front",
  glassEntry = true,
  doorWidth = 1.15,
  doorType = "swing",
  oppositeWall = "solid",
  exteriorDoor = false,
  sideWallHeight = 1.15,
  wallColor = "#f5f3ee",
  floorFinish = "oak",
  children
}: {
  roomId: string;
  label: string;
  position: [number, number, number];
  size: [number, number];
  entrySide?: EntrySide;
  glassEntry?: boolean;
  doorWidth?: number;
  doorType?: RoomDoorType;
  oppositeWall?: OppositeWall;
  exteriorDoor?: boolean;
  sideWallHeight?: number;
  wallColor?: string;
  floorFinish?: FloorMaterial;
  children?: React.ReactNode;
}) {
  const room = roomById(roomId);
  if (!room) throw new Error(`Unknown room for RoomShell: ${roomId}`);
  const [w, d] = size;
  const envelope = classifyRoomEnvelope(room);
  const entryFace = entrySide === "front" ? "south" : "north";
  const oppositeFace = entrySide === "front" ? "north" : "south";
  const floorVisible = useFloorVisible();
  const entryZ = entrySide === "front" ? d / 2 : -d / 2;
  const oppositeZ = -entryZ;
  const entryRotation = entrySide === "front" ? 0 : Math.PI;
  // Front and back entries use opposite hinges; q·π/2 keeps each leaf swinging
  // into the room (local -Z) with a full quarter turn.
  const entryHinge = entrySide === "front" ? "left" : "right";
  const doorOpenAngle = (entrySide === "front" ? 1 : -1) * Math.PI / 2;

  return (
    <group name={`office-room:${roomId}`} position={[room.center[0], position[1], room.center[2]]} userData={{ officeLightZone: size }}>
      <FloorFinish size={size} buildingOrigin={[room.center[0], room.center[2]]} material={floorFinish} border />

      {/* Suppress only facade-facing surfaces; their moving door stays app-owned below. */}
      <EnvelopeWall exterior={envelope[oppositeFace]} name={`${roomId}:${oppositeFace}`}>
        {oppositeWall === "windows" ? (
          exteriorDoor ? (
            <>
              {[-1, 1].map((side) => (
                <WindowWall
                  key={side}
                  width={(w - 1.55) / 2}
                  position={[side * (w + 1.55) / 4, 1.35, oppositeZ]}
                  rotationY={entrySide === "front" ? Math.PI : 0}
                  panels={Math.max(2, Math.round((w - 1.55) / 4.8))}
                />
              ))}
            </>
          ) : (
            <WindowWall
              width={w}
              position={[0, 1.35, oppositeZ]}
              rotationY={entrySide === "front" ? Math.PI : 0}
              panels={Math.max(3, Math.round(w / 2.4))}
            />
          )
        ) : (
          <SolidWall size={[w, 2.7, 0.11]} position={[0, 1.35, oppositeZ]} color={wallColor} />
        )}
        {oppositeWall === "solid" && <mesh castShadow position={[0, 0.16, oppositeZ + (entrySide === "front" ? 0.065 : -0.065)]}>
          <boxGeometry args={[w - 0.16, 0.22, 0.065]} />
          <meshStandardMaterial color="#b9a388" roughness={0.8} />
        </mesh>}
      </EnvelopeWall>
      {oppositeWall === "windows" && exteriorDoor && <OpenDoor
        floor={room.floor}
        roomId={roomId}
        role="exterior"
        position={[0, 0, oppositeZ]}
        rotationY={entrySide === "front" ? Math.PI : 0}
        width={1.35}
        height={2.5}
        glass
        openAngle={-Math.PI / 2}
      />}

      {/* Side wall, skirting and cap share one visibility boundary; internal partitions stay batched. */}
      {([-1, 1] as const).map(side => {
        const face = side === -1 ? "west" : "east";
        return <EnvelopeWall key={side} exterior={envelope[face]} name={`${roomId}:${face}`}>
          <SolidWall size={[0.11, sideWallHeight, d]} position={[side * w / 2, sideWallHeight / 2, 0]} color={wallColor} />
          <mesh castShadow position={[side * (w / 2 - 0.08), 0.16, 0]}>
            <boxGeometry args={[0.055, 0.21, d - 0.12]} />
            <meshStandardMaterial color="#b9a388" roughness={0.78} />
          </mesh>
          <mesh castShadow position={[side * (w / 2 - 0.02), sideWallHeight + 0.015, 0]}>
            <boxGeometry args={[0.17, 0.045, d]} />
            <meshStandardMaterial color="#c3b49d" roughness={0.82} />
          </mesh>
        </EnvelopeWall>;
      })}

      {/* entry wall with a physical doorway gap */}
      <EnvelopeWall exterior={envelope[entryFace]} name={`${roomId}:${entryFace}`}>
        {glassEntry ? (
          <GlassPartition
            width={w}
            height={2.55}
            doorHeight={2.55}
            position={[0, 1.275, entryZ]}
            rotationY={entryRotation}
            doorGap={doorWidth + 0.22}
          />
        ) : (
          <>
            <SolidWall
              size={[(w - doorWidth) / 2, 2.25, 0.10]}
              position={[-(doorWidth / 2 + (w - doorWidth) / 4), 1.125, entryZ]}
              color={wallColor}
            />
            <SolidWall
              size={[(w - doorWidth) / 2, 2.25, 0.10]}
              position={[(doorWidth / 2 + (w - doorWidth) / 4), 1.125, entryZ]}
              color={wallColor}
            />
          </>
        )}
      </EnvelopeWall>

      {/* Both door types register the same `floor-N.roomId.entry` portal for navigation. */}
      {doorType === "sliding" ? (
        <SlidingDoor
          floor={room.floor}
          roomId={roomId}
          role="entry"
          position={[0, 0, entryZ]}
          rotationY={entryRotation}
          width={doorWidth}
          height={glassEntry ? 2.55 : 2.25}
        />
      ) : (
        <OpenDoor
          floor={room.floor}
          roomId={roomId}
          role="entry"
          position={[0, 0, entryZ]}
          rotationY={entryRotation}
          width={doorWidth}
          height={glassEntry ? 2.55 : 2.25}
          glass={glassEntry}
          hinge={entryHinge}
          openAngle={doorOpenAngle}
        />
      )}

      <SceneLabel position={[-w / 2 + 0.6, 2.9, oppositeZ + (entrySide === "front" ? 0.4 : -0.4)]} center style={{ display: floorVisible ? "block" : "none" }}>
        <div className="room-label">{label}</div>
      </SceneLabel>

      {/* Recessed ceiling downlight array: actively illuminates the room and responds dynamically to the solar clock.
          Executive suites mount their own full-room architectural downlight & cove grid via ExecutiveSuiteLighting. */}
      {roomId !== "executive" && roomId !== "executive-studio" && (
        <RoomCeilingDownlights
          floor={room.floor}
          width={w}
          depth={d}
          serverRoom={roomId === "operations"}
          tableLighting={roomId === "meeting-a" || roomId === "meeting-b"}
        />
      )}

      {children}
    </group>
  );
}

/** Recessed ceiling panel downlights that provide authentic localized architectural lighting. */
function RoomCeilingDownlights({ floor, width, depth, serverRoom = false, tableLighting = false }: {
  floor: CeilingFloor; width: number; depth: number; serverRoom?: boolean; tableLighting?: boolean;
}) {
  const { state } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  // Padam total saat lampu mati (interiorFactor = 0), dan menyala terang benderang saat hidup
  const emissiveIntensity = interiorFactor === 0 ? 0 : 0.4 + interiorFactor * (serverRoom ? 3.0 : 4.0);
  const fixtureColor = serverRoom ? "#d6f2ff" : "#fff1df";
  const { anchorY, sourceY } = ceilingMountsForFloor(floor).room;

  // Every fixture contributes cached illumination. Rooms use clean orthogonal
  // rectangular grids (4×2 for extra-wide labs/studios, 3×2 for wide suites,
  // 2×2 for standard rooms) so downlights never collide with central pendants
  // or linear meeting-table fixtures.
  const positions: [number, number, number][] = [];
  if (width >= 18 && depth >= 6) {
    const zOffset = depth * 0.26;
    for (const xFactor of [-0.36, -0.12, 0.12, 0.36]) {
      positions.push([width * xFactor, anchorY, -zOffset]);
      positions.push([width * xFactor, anchorY, zOffset]);
    }
  } else if (width >= 12 && depth >= 6) {
    const zOffset = tableLighting ? depth * 0.3 : depth * 0.25;
    for (const xFactor of [-0.3, 0, 0.3]) {
      positions.push([width * xFactor, anchorY, -zOffset]);
      positions.push([width * xFactor, anchorY, zOffset]);
    }
  } else if (width > 6.0 && depth > 6.0) {
    // 4 fixtures in 2×2 grid
    positions.push([-width * 0.25, anchorY, -depth * 0.25]);
    positions.push([width * 0.25, anchorY, -depth * 0.25]);
    positions.push([-width * 0.25, anchorY, depth * 0.25]);
    positions.push([width * 0.25, anchorY, depth * 0.25]);
  } else if (width > 6.0) {
    // 2 fixtures along width
    positions.push([-width * 0.25, anchorY, 0]);
    positions.push([width * 0.25, anchorY, 0]);
  } else if (depth > 6.0) {
    // 2 fixtures along depth
    positions.push([0, anchorY, -depth * 0.25]);
    positions.push([0, anchorY, depth * 0.25]);
  } else {
    // 1 central fixture
    positions.push([0, anchorY, 0]);
  }


  return (
    <group>
      {positions.map(([lx, ly, lz], idx) => (
        <group key={idx} position={[lx, ly, lz]}>
          {/* Recessed ceiling bezel */}
          <mesh name="structural-room-housing" position={[0, 0.02, 0]}>
            <boxGeometry args={[0.38, 0.04, 0.38]} />
            <meshStandardMaterial color="#0f172a" metalness={0.8} roughness={0.3} />
          </mesh>
          {/* Emissive diffuser panel */}
          <mesh position={[0, 0.005, 0]} userData={{ officeMaterialDynamic: serverRoom ? "room-downlight:server:interior:0.4+factor*3" : "room-downlight:office:interior:0.4+factor*4" }}>
            <boxGeometry args={[0.3, 0.015, 0.3]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive={fixtureColor}
              emissiveIntensity={emissiveIntensity}
              roughness={0.15}
              toneMapped={false}
            />
          </mesh>
          <FixtureSpotLight name="room-ceiling-beam" position={[0, sourceY - anchorY, 0]}
            aim={[0, -anchorY, 0]} intensity={raisedDownlightIntensity(interiorFactor * 96, 2.675, sourceY, 0, 6)}
            color={fixtureColor} distance={raisedDownlightRange(6, 2.675, sourceY)}
            angle={raisedDownlightAngle(1.1, 2.675, sourceY)} />
        </group>
      ))}
    </group>
  );
}
