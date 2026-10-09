import { useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh} from "three";
import { Color, DoubleSide, Object3D } from "three";
import { OFFICE_BUILDING } from "../../layout";
import { GLASS_ELEVATORS } from "./elevatorController";

// Keep the complete shaft collars and their wraparound promenade unobstructed.
const liftNorth = Math.min(...GLASS_ELEVATORS.map(lift => lift.z - lift.shaftDepth / 2 - 0.15));
const liftSouth = Math.max(...GLASS_ELEVATORS.map(lift => lift.z + lift.shaftDepth / 2 + 0.15));
export const ELEVATOR_GARDEN_BOUNDS = {
  west: OFFICE_BUILDING.east + 0.35,
  east: OFFICE_BUILDING.east + 2.15,
  beds: [
    { north: OFFICE_BUILDING.north + 1.7, south: liftNorth - 2.35 },
    { north: liftSouth + 2.35, south: OFFICE_BUILDING.south - 1.7 }
  ],
  maxHeight: 1.05
} as const;

type Instance = {
  position: [number, number, number];
  scale: [number, number, number];
  rotation?: [number, number, number];
  color: string;
};

function GardenInstances({ instances, kind }: { instances: Instance[]; kind: "leaf" | "shrub" | "pebble" }) {
  const mesh = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    if (!mesh.current) return;
    const transform = new Object3D(), color = new Color();
    instances.forEach((instance, index) => {
      transform.position.set(...instance.position);
      transform.scale.set(...instance.scale);
      transform.rotation.set(...(instance.rotation ?? [0, 0, 0]));
      transform.updateMatrix();
      mesh.current!.setMatrixAt(index, transform.matrix);
      mesh.current!.setColorAt(index, color.set(instance.color));
    });
    mesh.current.instanceMatrix.needsUpdate = true;
    if (mesh.current.instanceColor) mesh.current.instanceColor.needsUpdate = true;
    mesh.current.computeBoundingSphere();
  }, [instances]);
  return (
    <instancedMesh ref={mesh} args={[undefined, undefined, instances.length]} castShadow receiveShadow>
      {kind === "leaf" ? <coneGeometry args={[1, 1, 3]} /> : <icosahedronGeometry args={[1, kind === "shrub" ? 1 : 0]} />}
      <meshStandardMaterial color="#ffffff" roughness={0.98} flatShading side={kind === "leaf" ? DoubleSide : undefined} />
    </instancedMesh>
  );
}

/** Low planting flanks the elevators; the central landing apron stays open. */
export function ElevatorGarden() {
  const plants = useMemo(() => {
    const shrubs: Instance[] = [], leaves: Instance[] = [], pebbles: Instance[] = [];
    const b = ELEVATOR_GARDEN_BOUNDS;
    b.beds.forEach((bed, bedIndex) => {
      const rows = Math.floor((bed.south - bed.north) / 1.1);
      for (let row = 0; row < rows; row++) {
        const z = bed.north + 0.6 + row * (bed.south - bed.north - 1.2) / Math.max(1, rows - 1);
        const variation = Math.sin(row * 2.7 + bedIndex) * 0.04;
        // Soft clipped shrubs form a lower layer in front of the grass tufts.
        ([[0, 0, 0], [-0.15, -0.09, -0.12], [0.15, -0.06, 0.13]] as const).forEach(([dx, dy, dz], i) => {
          shrubs.push({ position: [b.west + 1.02 + dx, 0.43 + dy + variation, z + dz],
            scale: [0.33, 0.3 + variation, 0.36], color: ["#54765a", "#6c865c", "#78966a"][i]! });
        });
        // Narrow, leaning blades preserve a clear view of the moving glass cabins.
        for (let blade = 0; blade < 8; blade++) {
          const angle = blade * Math.PI / 4 + row * 0.31;
          const length = 0.57 + (blade % 3) * 0.085 + variation;
          leaves.push({ position: [b.west + 0.45 + Math.cos(angle) * 0.075,
            0.1 + length / 2, z + Math.sin(angle) * 0.085],
            scale: [0.047, length, 0.018], rotation: [Math.sin(angle) * 0.2, angle, Math.cos(angle) * 0.21],
            color: ["#87946a", "#a4ac7b", "#667e59"][blade % 3]! });
        }
        for (let stone = 0; stone < 4; stone++) {
          pebbles.push({ position: [b.east - 0.2 + Math.sin(row + stone) * 0.055, 0.115,
            z - 0.35 + stone * 0.22], scale: [0.085, 0.035, 0.075],
            rotation: [0, row + stone * 0.8, 0], color: stone % 2 ? "#b6b4a5" : "#91958b" });
        }
      }
    });
    return { shrubs, leaves, pebbles };
  }, []);
  const b = ELEVATOR_GARDEN_BOUNDS;
  return (
    <group name="elevator-side-garden">
      {b.beds.map((bed, index) => {
        const length = bed.south - bed.north;
        const center: [number, number, number] = [(b.west + b.east) / 2, 0, (bed.north + bed.south) / 2];
        return <group key={index} name={`elevator-garden-bed-${index}`} position={center}>
          <mesh castShadow receiveShadow position={[0, -0.09, 0]}>
            <boxGeometry args={[b.east - b.west, 0.3, length]} />
            <meshStandardMaterial color="#7c8785" roughness={0.94} />
          </mesh>
          <mesh receiveShadow position={[0, 0.079, 0]}>
            <boxGeometry args={[b.east - b.west - 0.16, 0.028, length - 0.16]} />
            <meshStandardMaterial color="#454b3e" roughness={1} />
          </mesh>
          <mesh receiveShadow position={[b.east - center[0]! - 0.2, 0.096, 0]}>
            <boxGeometry args={[0.26, 0.008, length - 0.22]} />
            <meshStandardMaterial color="#888b79" roughness={1} />
          </mesh>
        </group>;
      })}
      <GardenInstances instances={plants.shrubs} kind="shrub" />
      <GardenInstances instances={plants.leaves} kind="leaf" />
      <GardenInstances instances={plants.pebbles} kind="pebble" />
    </group>
  );
}
