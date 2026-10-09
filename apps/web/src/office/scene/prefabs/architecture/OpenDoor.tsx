import { useRef } from "react";
import type { Group } from "three";
import { StaticCampusBatch } from "../../StaticCampusBatch";
type CampusFloor = 1 | 2 | 3;
export function doorOpenAmount(angle: number, openAngle: number): number {
  return Math.min(1, Math.abs(angle) / Math.max(0.001, Math.abs(openAngle)));
}

export function OpenDoor({
  position = [0, 0, 0],
  rotationY = 0,
  width = 1.0,
  height = 2.55,
  glass = false,
  openAngle: _openAngle = -Math.PI * 0.38,
  floor: _floor,
  roomId: _roomId,
  role: _role
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  glass?: boolean;
  openAngle?: number;
  floor: CampusFloor;
  roomId: string;
  role: string;
}) {
  const frame = useRef<Group>(null);
  const leaf = useRef<Group>(null);
  return (
    <group ref={frame} name="office-passable-door" userData={{ officePassable: true }} position={position} rotation={[0, rotationY, 0]}>
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

      {/* leaf rotates around left hinge */}
      <group ref={leaf} userData={{ officeDynamic: true }} position={[-width / 2, 0, 0]}>
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
      </group>
    </group>
  );
}
