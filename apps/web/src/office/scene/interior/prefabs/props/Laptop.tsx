import type { SmartScreenData } from "../../screenData";
import { SmartScreen, type ScreenVariant } from "../screens/SmartScreen";

export function Laptop({
  position = [0, 0, 0],
  rotationY = 0,
  variant = "chart",
  data = { title: "AVAILABLE", subtitle: "Workstation ready", status: "STANDBY" }
}: {
  position?: [number, number, number];
  rotationY?: number;
  /** Content shown while the seat is occupied. */
  variant?: ScreenVariant;
  data?: SmartScreenData;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh position={[0, 0.02, 0]}>
        <boxGeometry args={[0.55, 0.035, 0.38]} />
        <meshStandardMaterial color="#aeb5ba" metalness={0.55} roughness={0.35} />
      </mesh>
      <mesh position={[0, 0.24, -0.17]} rotation={[-0.22, 0, 0]}>
        <boxGeometry args={[0.55, 0.36, 0.025]} />
        <meshStandardMaterial color="#111a20" metalness={0.28} roughness={0.24} />
      </mesh>
      <group position={[0, 0.24, -0.153]} rotation={[-0.22, 0, 0]}>
        <SmartScreen data={data} width={0.48} height={0.29} bezel={0.025} depth={0.012} variant={variant} />
      </group>
    </group>
  );
}
