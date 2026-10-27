import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group} from "three";
import { Vector3 } from "three";
import { setDoorPortal } from "../../occupants/movingOccupants";
import { doorTraffic } from "../../doorTrafficRegistry";
import type { CampusFloor } from "../../worldRegistry";
import { StaticCampusBatch } from "../../../StaticCampusBatch";
import { ArchitecturePart } from "../../ArchitecturePart";
import PROFILE from "../../architectureAssetProfile.json";

export function OpenDoor({
  position = [0, 0, 0],
  rotationY = 0,
  width = 1.0,
  height = 2.55,
  glass = false,
  openAngle = -Math.PI / 2,
  hinge = "left",
  floor,
  roomId,
  role
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  glass?: boolean;
  openAngle?: number;
  hinge?: "left" | "right";
  floor: CampusFloor;
  roomId: string;
  role: string;
}) {
  const frame = useRef<Group>(null);
  const leaf = useRef<Group>(null);
  const doorId = `floor-${floor}.${roomId}.${role}`;
  const worldPosition = useRef(new Vector3());
  const worldNormal = useRef(new Vector3());
  const frameProfile = PROFILE.models["architecture-hinged-frame"];
  const leafProfile = PROFILE.models[glass ? "architecture-hinged-glass-leaf" : "architecture-hinged-wood-leaf"];

  // A reserved operator drives the swing, including the released portion after a short handle tug.
  useFrame(() => {
    if (!frame.current || !leaf.current) return;
    frame.current.getWorldPosition(worldPosition.current);
    frame.current.getWorldDirection(worldNormal.current);
    const { x, y, z } = worldPosition.current;
    const worldRotationY = Math.atan2(worldNormal.current.x, worldNormal.current.z);
    const amount = doorTraffic.amount(doorId);
    leaf.current.rotation.y = amount * openAngle;
    setDoorPortal(doorId, {
      floor,
      roomId,
      role,
      center: [x, y, z],
      yaw: worldRotationY,
      clearWidth: width,
      openAmount: amount,
      height,
      openAngle,
      hinge,
      sliding: false
    });
  });

  useEffect(() => () => setDoorPortal(doorId, null), [doorId]);

  return (
    <group ref={frame} name="office-passable-door" userData={{ officePassable: true }} position={position} rotation={[0, rotationY, 0]}>
      {/* Authored jamb hardware follows the hinge; procedural frame dimensions stay unchanged. */}
      <ArchitecturePart model="architecture-hinged-frame" modelScale={[(hinge === "left" ? 1 : -1) * width / frameProfile.width, height / frameProfile.height, 1]}>
        {/* frame */}
        <mesh castShadow position={[-width / 2 - 0.04, height / 2, 0]}>
          <boxGeometry args={[0.08, height + 0.12, 0.10]} />
          <meshStandardMaterial color="#465158" metalness={0.45} roughness={0.35} />
        </mesh>
        <mesh castShadow position={[width / 2 + 0.04, height / 2, 0]}>
          <boxGeometry args={[0.08, height + 0.12, 0.10]} />
          <meshStandardMaterial color="#465158" metalness={0.45} roughness={0.35} />
        </mesh>
        <mesh castShadow position={[0, height + 0.04, 0]}>
          <boxGeometry args={[width + 0.16, 0.08, 0.10]} />
          <meshStandardMaterial color="#465158" metalness={0.45} roughness={0.35} />
        </mesh>

      </ArchitecturePart>

      {/* Mirroring the full leaf group keeps its details aligned with either jamb hinge. */}
      <group ref={leaf} userData={{ officeDynamic: true }} position={[hinge === "left" ? -width / 2 : width / 2, 0, 0]} scale={[hinge === "left" ? 1 : -1, 1, 1]}>
        <ArchitecturePart model={glass ? "architecture-hinged-glass-leaf" : "architecture-hinged-wood-leaf"} modelScale={[width / leafProfile.width, height / leafProfile.height, 1]}>
          <StaticCampusBatch followParent>
          <mesh castShadow position={[width / 2, height / 2, 0]}>
            <boxGeometry args={[width, height, 0.055]} />
            {glass ? (
              <meshPhysicalMaterial
                color="#c3dfe0"
                transparent
                opacity={0.35}
                transmission={0}
                roughness={0.12}
                depthWrite={false}
              />
            ) : (
              <meshStandardMaterial color="#b19778" roughness={0.75} />
            )}
          </mesh>
          {glass && <>
            {[0.05, height - 0.05].map((y) => <mesh key={`leaf-horizontal-${y}`} castShadow position={[width / 2, y, 0.04]}>
              <boxGeometry args={[width, 0.09, 0.085]} />
              <meshStandardMaterial color="#526468" metalness={0.47} roughness={0.35} />
            </mesh>)}
            {[0.04, width - 0.04].map((x) => <mesh key={`leaf-vertical-${x}`} castShadow position={[x, height / 2, 0.04]}>
              <boxGeometry args={[0.08, height, 0.085]} />
              <meshStandardMaterial color="#526468" metalness={0.47} roughness={0.35} />
            </mesh>)}
            <mesh position={[width / 2, 0.18, 0.055]}>
              <boxGeometry args={[width - 0.12, 0.24, 0.02]} />
              <meshStandardMaterial color="#819493" roughness={0.52} />
            </mesh>
          </>}
          {[-0.1, 0.1].map((z) => <group key={z} position={[width * 0.82, height * 0.5, z]}>
            <mesh castShadow><cylinderGeometry args={[0.035, 0.035, 0.06, 12]} /><meshStandardMaterial color="#c0b293" metalness={0.65} roughness={0.28} /></mesh>
            <mesh castShadow position={[-0.07, 0, 0]}><boxGeometry args={[0.15, 0.026, 0.035]} /><meshStandardMaterial color="#c0b293" metalness={0.65} roughness={0.28} /></mesh>
          </group>)}
          </StaticCampusBatch>
        </ArchitecturePart>
      </group>
    </group>
  );
}
