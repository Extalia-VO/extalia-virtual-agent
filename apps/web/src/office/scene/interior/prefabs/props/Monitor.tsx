import type { SmartScreenData } from "../../screenData";
import { SmartScreen, type ScreenVariant } from "../screens/SmartScreen";

export function Monitor({
  position = [0, 0, 0],
  rotationY = 0,
  width = 0.72,
  height = 0.43,
  resourceId,
  variant = "code",
  data = {
    title: "AVAILABLE",
    subtitle: "Workstation ready",
    status: "STANDBY"
  }
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  resourceId?: string;
  /** Content shown while the seat is occupied. Multi-monitor desks pass distinct variants. */
  variant?: ScreenVariant;
  data?: SmartScreenData;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <SmartScreen data={data} resourceId={resourceId} width={width} height={height} variant={variant} />

      {/* VESA neck, hinge and low-profile weighted base. */}
      <mesh position={[0, -height / 2 - 0.105, -0.012]}>
        <boxGeometry args={[0.055, 0.22, 0.045]} />
        <meshStandardMaterial color="#35434b" metalness={0.72} roughness={0.27} />
      </mesh>
      <mesh position={[0, -height / 2 - 0.22, -0.012]}>
        <cylinderGeometry args={[0.065, 0.075, 0.035, 20]} />
        <meshStandardMaterial color="#45545c" metalness={0.74} roughness={0.26} />
      </mesh>
      <mesh position={[0, -height / 2 - 0.242, 0.008]}>
        <boxGeometry args={[0.29, 0.022, 0.19]} />
        <meshStandardMaterial color="#252f35" metalness={0.62} roughness={0.28} />
      </mesh>
      <mesh position={[0, -height / 2 - 0.23, 0.105]}>
        <boxGeometry args={[0.20, 0.006, 0.006]} />
        <meshStandardMaterial color="#6b9f9a" emissive="#397d78" emissiveIntensity={0.28} roughness={0.4} />
      </mesh>
    </group>
  );
}
