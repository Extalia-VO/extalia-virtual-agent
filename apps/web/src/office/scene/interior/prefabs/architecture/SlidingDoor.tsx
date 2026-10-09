import { useEffect, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group} from "three";
import { MathUtils, Vector3 } from "three";
import { isMovingOccupantNear, setDoorPortal } from "../../occupants/movingOccupants";
import type { CampusFloor } from "../../worldRegistry";
import { StaticCampusBatch } from "../../../StaticCampusBatch";

export function SlidingDoor({
  position = [0, 0, 0],
  rotationY = 0,
  width = 2.4,
  height = 2.65,
  floor = 1,
  roomId,
  role,
  detectionRadius = 2.5
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  floor?: CampusFloor;
  roomId: string;
  role: string;
  detectionRadius?: number;
}) {
  const frame = useRef<Group>(null);
  const leftLeaf = useRef<Group>(null);
  const rightLeaf = useRef<Group>(null);
  const openFraction = useRef(0);
  const holdOpenUntil = useRef(0);
  const worldPosition = useRef(new Vector3());
  const worldNormal = useRef(new Vector3());

  const doorId = `floor-${floor}.${roomId}.${role}`;
  const halfWidth = width / 2;
  const leafWidth = halfWidth * 0.98;
  const maxSlide = leafWidth * 0.88;

  useFrame(({ clock }, delta) => {
    if (!frame.current || !leftLeaf.current || !rightLeaf.current) return;
    frame.current.getWorldPosition(worldPosition.current);
    frame.current.getWorldDirection(worldNormal.current);

    const { x, y, z } = worldPosition.current;
    const worldRotationY = Math.atan2(worldNormal.current.x, worldNormal.current.z);

    if (isMovingOccupantNear(x, y, z, detectionRadius, worldRotationY)) {
      holdOpenUntil.current = clock.elapsedTime + 1.2;
    }

    const target = clock.elapsedTime < holdOpenUntil.current ? 1 : 0;
    openFraction.current = MathUtils.damp(openFraction.current, target, 7.5, delta);

    // Slide left leaf to the left (-X), right leaf to the right (+X)
    const slideOffset = openFraction.current * maxSlide;
    leftLeaf.current.position.x = -leafWidth / 2 - slideOffset;
    rightLeaf.current.position.x = leafWidth / 2 + slideOffset;

    setDoorPortal(doorId, {
      floor,
      roomId,
      role,
      center: [x, y, z],
      yaw: worldRotationY,
      clearWidth: width,
      openAmount: openFraction.current
    });
  });

  useEffect(() => () => setDoorPortal(doorId, null), [doorId]);

  return (
    <group
      ref={frame}
      name="office-passable-door"
      userData={{ officePassable: true }}
      position={position}
      rotation={[0, rotationY, 0]}
    >
      {/* Top automatic slide operator & track housing */}
      <mesh castShadow position={[0, height + 0.08, 0]}>
        <boxGeometry args={[width * 1.8 + 0.16, 0.16, 0.16]} />
        <meshStandardMaterial color="#2d3748" metalness={0.8} roughness={0.25} />
      </mesh>

      {/* Modern presence motion sensor with status LED */}
      <group position={[0, height + 0.08, 0.09]}>
        <mesh>
          <boxGeometry args={[0.22, 0.06, 0.04]} />
          <meshStandardMaterial color="#1a202c" metalness={0.9} roughness={0.2} />
        </mesh>
        <mesh position={[0, 0, 0.022]}>
          <boxGeometry args={[0.08, 0.015, 0.01]} />
          <meshStandardMaterial color="#00e5ff" emissive="#00e5ff" emissiveIntensity={0.8} />
        </mesh>
      </group>

      {/* Recessed floor guide track */}
      <mesh position={[0, 0.01, 0]}>
        <boxGeometry args={[width * 1.8, 0.02, 0.12]} />
        <meshStandardMaterial color="#4a5568" metalness={0.7} roughness={0.3} />
      </mesh>

      {/* Left side frame jamb */}
      <mesh castShadow position={[-halfWidth - 0.04, height / 2, 0]}>
        <boxGeometry args={[0.08, height + 0.16, 0.14]} />
        <meshStandardMaterial color="#2d3748" metalness={0.75} roughness={0.3} />
      </mesh>

      {/* Right side frame jamb */}
      <mesh castShadow position={[halfWidth + 0.04, height / 2, 0]}>
        <boxGeometry args={[0.08, height + 0.16, 0.14]} />
        <meshStandardMaterial color="#2d3748" metalness={0.75} roughness={0.3} />
      </mesh>

      {/* Left Sliding Door Leaf */}
      <group ref={leftLeaf} userData={{ officeDynamic: true }} position={[-leafWidth / 2, 0, 0]}>
        <StaticCampusBatch followParent>
        {/* Glass panel */}
        <mesh castShadow position={[0, height / 2, 0]}>
          <boxGeometry args={[leafWidth, height, 0.045]} />
          <meshPhysicalMaterial
            color="#c3e8ec"
            transparent
            opacity={0.36}
            transmission={0}
            roughness={0.08}
            metalness={0.1}
            depthWrite={false}
          />
        </mesh>
        {/* Perimeter frame */}
        <mesh position={[0, height - 0.035, 0]}>
          <boxGeometry args={[leafWidth, 0.07, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[leafWidth, 0.08, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[-leafWidth / 2 + 0.03, height / 2, 0]}>
          <boxGeometry args={[0.06, height, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[leafWidth / 2 - 0.03, height / 2, 0]}>
          <boxGeometry args={[0.06, height, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* Safety manifestation stripe */}
        <mesh position={[0, 1.25, 0]}>
          <boxGeometry args={[leafWidth - 0.08, 0.05, 0.048]} />
          <meshStandardMaterial color="#e2e8f0" transparent opacity={0.65} roughness={0.2} />
        </mesh>
        {/* Architectural vertical ladder handle */}
        <group position={[leafWidth / 2 - 0.09, 1.15, 0.045]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.016, 0.016, 0.82, 12]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.15} />
          </mesh>
          {[-0.32, 0.32].map((hy) => (
            <mesh key={`l-mount-${hy}`} position={[-0.03, hy, 0]}>
              <boxGeometry args={[0.06, 0.02, 0.02]} />
              <meshStandardMaterial color="#94a3b8" metalness={0.85} roughness={0.2} />
            </mesh>
          ))}
        </group>
        </StaticCampusBatch>
      </group>

      {/* Right Sliding Door Leaf */}
      <group ref={rightLeaf} userData={{ officeDynamic: true }} position={[leafWidth / 2, 0, 0]}>
        <StaticCampusBatch followParent>
        {/* Glass panel */}
        <mesh castShadow position={[0, height / 2, 0]}>
          <boxGeometry args={[leafWidth, height, 0.045]} />
          <meshPhysicalMaterial
            color="#c3e8ec"
            transparent
            opacity={0.36}
            transmission={0}
            roughness={0.08}
            metalness={0.1}
            depthWrite={false}
          />
        </mesh>
        {/* Perimeter frame */}
        <mesh position={[0, height - 0.035, 0]}>
          <boxGeometry args={[leafWidth, 0.07, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[0, 0.04, 0]}>
          <boxGeometry args={[leafWidth, 0.08, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[-leafWidth / 2 + 0.03, height / 2, 0]}>
          <boxGeometry args={[0.06, height, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        <mesh position={[leafWidth / 2 - 0.03, height / 2, 0]}>
          <boxGeometry args={[0.06, height, 0.06]} />
          <meshStandardMaterial color="#334155" metalness={0.7} roughness={0.3} />
        </mesh>
        {/* Safety manifestation stripe */}
        <mesh position={[0, 1.25, 0]}>
          <boxGeometry args={[leafWidth - 0.08, 0.05, 0.048]} />
          <meshStandardMaterial color="#e2e8f0" transparent opacity={0.65} roughness={0.2} />
        </mesh>
        {/* Architectural vertical ladder handle */}
        <group position={[-leafWidth / 2 + 0.09, 1.15, 0.045]}>
          <mesh castShadow>
            <cylinderGeometry args={[0.016, 0.016, 0.82, 12]} />
            <meshStandardMaterial color="#cbd5e1" metalness={0.9} roughness={0.15} />
          </mesh>
          {[-0.32, 0.32].map((hy) => (
            <mesh key={`r-mount-${hy}`} position={[0.03, hy, 0]}>
              <boxGeometry args={[0.06, 0.02, 0.02]} />
              <meshStandardMaterial color="#94a3b8" metalness={0.85} roughness={0.2} />
            </mesh>
          ))}
        </group>
        </StaticCampusBatch>
      </group>
    </group>
  );
}
