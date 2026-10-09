import { useMemo, useRef, type MutableRefObject } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group, Mesh, MeshStandardMaterial } from "three";
import { useResourceVisualState } from "../../FurnishedFloorContext";
import { getNearbyMovingOccupantsSnapshot, type MovingOccupantSnapshot } from "../../occupants/movingOccupants";
import { resourceById } from "../../resourceRegistry";
import { FITNESS_BLUEPRINT } from "../../spatialBlueprints";
import { StaticScreenLight } from "../screens/StaticScreenLight";

type EquipmentProps = { position?: [number, number, number]; rotationY?: number; resourceId?: string };
const STEEL = { color: "#313c40", metalness: 0.72, roughness: 0.3 };
const UPHOLSTERY = { color: "#253b39", roughness: 0.88 };

/** Equipment starts after its assigned user reaches the actual interaction target. */
export function fitnessStationInUse(resourceId: string | undefined, occupants: MovingOccupantSnapshot[]) {
  const target = resourceId ? resourceById(resourceId)?.position : undefined;
  return Boolean(target && occupants.some(o => o.motion !== "walk" && o.motion !== "stairs_up" && o.motion !== "stairs_down" &&
    Math.abs(o.position[1] - target[1]) < 0.35 && Math.hypot(o.position[0] - target[0], o.position[2] - target[2]) < 0.35 &&
    Math.hypot(o.target[0] - target[0], o.target[2] - target[2]) < 0.35));
}
function useFitnessUsage(resourceId?: string) {
  const status = useResourceVisualState(resourceId);
  const target = useMemo(() => resourceId ? resourceById(resourceId)?.position : undefined, [resourceId]);
  const active = useRef(false);
  const nextProbe = useRef(0);
  useFrame(({ clock }) => {
    if (clock.elapsedTime < nextProbe.current) return;
    nextProbe.current = clock.elapsedTime + 0.2;
    active.current = Boolean(target && status === "OCCUPIED" &&
      fitnessStationInUse(resourceId, getNearbyMovingOccupantsSnapshot(resourceId ?? "", target)));
  });
  return active;
}
function StationStatus({ active, position }: { active: MutableRefObject<boolean>; position: [number, number, number] }) {
  const lens = useRef<Mesh>(null);
  useFrame(() => { if (lens.current) (lens.current.material as MeshStandardMaterial).emissiveIntensity = active.current ? 2 : 0.12; });
  return <mesh ref={lens} position={position} userData={{ officeDynamic: true }}><boxGeometry args={[0.12, 0.024, 0.025]} /><meshStandardMaterial color="#72d7bc" emissive="#72d7bc" emissiveIntensity={0.12} toneMapped={false} /></mesh>;
}

/** Low walkable running deck, silver rails, moving belt and active console. */
export function Treadmill({ position = [0, 0, 0], rotationY = 0, resourceId }: EquipmentProps) {
  const active = useFitnessUsage(resourceId);
  const belt = useRef<Group>(null);
  useFrame(({ clock }) => { belt.current?.children.forEach((stripe, i) => { if (active.current) stripe.position.z = ((i * 0.18 + clock.elapsedTime * 1.6) % 1.44) - 0.72; }); });
  return <group name={resourceId} position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
    <mesh position={[0, 0.1, 0]} receiveShadow><boxGeometry args={[1.4, 0.03, 1.95]} /><meshStandardMaterial {...STEEL} /></mesh>
    <mesh position={[0, FITNESS_BLUEPRINT.treadmillDeckHeight - 0.006, 0]} receiveShadow><boxGeometry args={[1.08, 0.012, 1.78]} /><meshStandardMaterial color="#171f22" roughness={0.94} /></mesh>
    <group ref={belt} userData={{ officeDynamic: true, officeCollision: false }}>{Array.from({ length: 8 }, (_, i) => <mesh key={i} position={[0, FITNESS_BLUEPRINT.treadmillDeckHeight + 0.001, i * 0.18 - 0.72]}><boxGeometry args={[0.75, 0.003, 0.01]} /><meshStandardMaterial color="#455354" roughness={0.9} /></mesh>)}</group>
    {[-1, 1].map(side => <group key={side}>
      <mesh castShadow position={[side * 0.64, 0.59, -0.68]} rotation={[-0.13, 0, 0]}><boxGeometry args={[0.055, 1.1, 0.06]} /><meshStandardMaterial color="#a7b5b5" metalness={0.82} roughness={0.24} /></mesh>
      <mesh castShadow position={[side * 0.64, 0.93, -0.12]}><boxGeometry args={[0.048, 0.055, 0.85]} /><meshStandardMaterial color="#273536" roughness={0.78} /></mesh>
    </group>)}
    <group position={[0, 1.08, -0.65]} rotation={[-0.48, 0, 0]}>
      <mesh castShadow><boxGeometry args={[0.81, 0.29, 0.08]} /><meshStandardMaterial {...STEEL} /></mesh>
      <mesh position={[0, 0.015, 0.046]}><boxGeometry args={[0.47, 0.17, 0.008]} /><meshStandardMaterial color="#183c43" emissive="#287b88" emissiveIntensity={0.45} /></mesh>
      <StaticScreenLight position={[0, 0.015, 0.05]} width={0.47} height={0.17} color="#287b88" luminance={0.074} />
      <StationStatus active={active} position={[0.27, -0.08, 0.048]} />
    </group>
  </group>;
}

/** Belt-driven cycle with a real saddle and pedals that rotate during use. */
export function ExerciseBike({ position = [0, 0, 0], rotationY = 0, resourceId }: EquipmentProps) {
  const active = useFitnessUsage(resourceId);
  const pedals = useRef<Group>(null);
  useFrame((_, delta) => { if (active.current && pedals.current) pedals.current.rotation.x += delta * 6; });
  return <group name={resourceId} position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
    {[-0.45, 0.45].map(z => <mesh key={z} castShadow position={[0, 0.06, z]}><boxGeometry args={[0.62, 0.1, 0.12]} /><meshStandardMaterial {...STEEL} /></mesh>)}
    <mesh castShadow position={[0, 0.39, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.32, 0.32, 0.22, 24]} /><meshStandardMaterial {...STEEL} /></mesh>
    <group ref={pedals} position={[0, 0.38, 0]} userData={{ officeDynamic: true }}>{[-1, 1].map(side => <group key={side} position={[side * 0.2, 0, 0]}>
      <mesh position={[0, side * 0.09, 0]}><boxGeometry args={[0.035, 0.18, 0.035]} /><meshStandardMaterial color="#b9c7c4" metalness={0.82} /></mesh>
      <mesh position={[side * 0.07, side * 0.18, 0]}><boxGeometry args={[0.17, 0.035, 0.13]} /><meshStandardMaterial color="#172222" /></mesh>
    </group>)}</group>
    <mesh castShadow position={[0, 0.66, 0.25]}><boxGeometry args={[0.05, 0.4, 0.06]} /><meshStandardMaterial color="#a5b4b1" metalness={0.8} /></mesh>
    <group position={[0, 0, FITNESS_BLUEPRINT.bikeSeat[1]]} userData={{ officeSeat: true }}><mesh castShadow position={[0, FITNESS_BLUEPRINT.bikeSeatHeight - 0.04, 0]}><boxGeometry args={[0.3, 0.08, 0.32]} /><meshStandardMaterial {...UPHOLSTERY} /></mesh></group>
    <mesh castShadow position={[0, 0.78, -0.34]} rotation={[-0.2, 0, 0]}><boxGeometry args={[0.055, 0.65, 0.055]} /><meshStandardMaterial {...STEEL} /></mesh>
    <mesh castShadow position={[0, 1.08, -0.4]}><boxGeometry args={[0.57, 0.06, 0.14]} /><meshStandardMaterial {...UPHOLSTERY} /></mesh>
    <StationStatus active={active} position={[0, 1.13, -0.32]} />
  </group>;
}
function Dumbbell({ position, scale = 1 }: { position: [number, number, number]; scale?: number }) {
  return <group position={position} scale={scale}><mesh rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.025, 0.025, 0.3, 10]} /><meshStandardMaterial color="#b9c5c3" metalness={0.86} roughness={0.2} /></mesh>
    {[-0.15, 0.15].map(x => <mesh key={x} position={[x, 0, 0]} rotation={[0, 0, Math.PI / 2]}><cylinderGeometry args={[0.11, 0.11, 0.085, 8]} /><meshStandardMaterial color="#253033" roughness={0.72} /></mesh>)}
  </group>;
}
export function DumbbellRack({ position = [0, 0, 0], rotationY = 0, width = 2.4, resourceId }: EquipmentProps & { width?: number }) {
  const active = useFitnessUsage(resourceId);
  return <group name={resourceId} position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
    {[-1, 1].map(side => <mesh key={side} castShadow position={[side * (width / 2 - 0.1), 0.46, 0]}><boxGeometry args={[0.075, 0.92, 0.55]} /><meshStandardMaterial {...STEEL} /></mesh>)}
    {[0.42, 0.79].map((y, level) => <group key={y}><mesh castShadow position={[0, y, 0]}><boxGeometry args={[width, 0.05, 0.4]} /><meshStandardMaterial {...STEEL} /></mesh>{[-0.38, -0.19, 0, 0.19, 0.38].map(x => <Dumbbell key={x} position={[x * width, y + 0.14, 0]} scale={level ? 1 : 0.85} />)}</group>)}
    <StationStatus active={active} position={[0, 0.3, 0.29]} />
  </group>;
}
/** Upright bench and cable row share a clear lateral seat approach. */
export function StrengthSeat({ position = [0, 0, 0], rotationY = 0, resourceId, cable = false }: EquipmentProps & { cable?: boolean }) {
  const active = useFitnessUsage(resourceId);
  const handle = useRef<Group>(null);
  const stack = useRef<Group>(null);
  useFrame(({ clock }) => { const pull = active.current ? (Math.sin(clock.elapsedTime * 2.4) + 1) / 2 : 0; if (handle.current) handle.current.position.z = FITNESS_BLUEPRINT.cableHandle[2] - pull * 0.3; if (stack.current) stack.current.position.y = pull * 0.16; });
  return <group name={resourceId} position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
    <mesh castShadow position={[0, 0.1, 0]}><boxGeometry args={[0.95, 0.12, 1.05]} /><meshStandardMaterial {...STEEL} /></mesh>
    <mesh castShadow position={[0, 0.29, 0]}><boxGeometry args={[0.08, 0.38, 0.09]} /><meshStandardMaterial {...STEEL} /></mesh>
    <group userData={{ officeSeat: true }}><mesh castShadow position={[0, FITNESS_BLUEPRINT.strengthSeatHeight - 0.06, 0]}><boxGeometry args={[0.6, 0.12, 0.56]} /><meshStandardMaterial {...UPHOLSTERY} /></mesh>
      {!cable && <mesh castShadow position={[0, 0.87, -0.37]} rotation={[-0.07, 0, 0]}><boxGeometry args={[0.58, 0.7, 0.1]} /><meshStandardMaterial {...UPHOLSTERY} /></mesh>}
    </group>
    {cable && <>
      {[-0.48, 0.48].map(x => <mesh key={x} castShadow position={[x, 1.05, 1.05]}><boxGeometry args={[0.07, 2, 0.07]} /><meshStandardMaterial {...STEEL} /></mesh>)}
      <mesh castShadow position={[0, 2.02, 1.05]}><boxGeometry args={[1.03, 0.08, 0.1]} /><meshStandardMaterial {...STEEL} /></mesh>
      <group ref={stack} userData={{ officeDynamic: true }}>{Array.from({ length: 7 }, (_, i) => <mesh key={i} position={[0, 0.35 + i * 0.085, 1.05]}><boxGeometry args={[0.62, 0.065, 0.25]} /><meshStandardMaterial color="#455251" metalness={0.55} roughness={0.45} /></mesh>)}</group>
      <mesh position={[0, 1.18, 1.05]}><cylinderGeometry args={[0.012, 0.012, 1.45, 8]} /><meshStandardMaterial color="#c6cfca" metalness={0.7} /></mesh>
      <group ref={handle} position={[...FITNESS_BLUEPRINT.cableHandle]} userData={{ officeDynamic: true }}><mesh><boxGeometry args={[0.55, 0.045, 0.05]} /><meshStandardMaterial color="#bccac5" metalness={0.8} /></mesh>{[-0.23, 0.23].map(x => <mesh key={x} position={[x, 0, -0.04]}><boxGeometry args={[0.075, 0.08, 0.1]} /><meshStandardMaterial {...UPHOLSTERY} /></mesh>)}</group>
    </>}
    <StationStatus active={active} position={[0.32, 0.28, -0.3]} />
  </group>;
}
export function YogaMat({ position = [0, 0, 0], rotationY = 0, color = "#6d8e81", resourceId }: EquipmentProps & { color?: string }) {
  const active = useFitnessUsage(resourceId);
  return <group name={resourceId} position={position} rotation={[0, rotationY, 0]}><mesh position={[0, FITNESS_BLUEPRINT.matSurfaceHeight - 0.009, 0]} receiveShadow><boxGeometry args={[0.95, 0.018, 1.95]} /><meshStandardMaterial color={color} roughness={0.96} /></mesh>{[-0.26, 0, 0.26].map(x => <mesh key={x} position={[x, FITNESS_BLUEPRINT.matSurfaceHeight + 0.001, 0]}><boxGeometry args={[0.012, 0.002, 1.75]} /><meshStandardMaterial color="#cbd8cd" roughness={0.94} /></mesh>)}<StationStatus active={active} position={[0, FITNESS_BLUEPRINT.matSurfaceHeight + 0.002, -0.88]} /></group>;
}
export function FitnessStorage({ position = [0, 0, 0] }: EquipmentProps) {
  return <group position={position}><mesh castShadow position={[0, 0.48, 0]}><boxGeometry args={[1.55, 0.95, 0.48]} /><meshStandardMaterial color="#768c80" roughness={0.75} /></mesh>{[-0.45, 0, 0.45].map(x => <mesh key={x} position={[x, 0.54, 0.25]}><boxGeometry args={[0.3, 0.58, 0.018]} /><meshStandardMaterial color="#d6dfd1" roughness={0.82} /></mesh>)}{[-0.46, -0.15, 0.16, 0.47].map(x => <mesh key={x} position={[x, 1.03, 0]}><boxGeometry args={[0.24, 0.13, 0.32]} /><meshStandardMaterial color="#ddd8cd" roughness={1} /></mesh>)}</group>;
}
