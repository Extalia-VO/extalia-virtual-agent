import type { SmartScreenData } from "../../screenData";
import { SmartScreen, type ScreenVariant } from "../screens/SmartScreen";
import type { DeskPool } from "../screens/screenGlow";
import { MONITOR, monitorPanelY } from "./deviceGeometry";
import { WorkstationPart } from "../../WorkstationPart";

export function Monitor({
  position = [0, 0, 0],
  rotationY = 0,
  width = MONITOR.width,
  height = width / MONITOR.aspect,
  resourceId,
  variant,
  device = "monitor",
  slot = 1,
  slots = 1,
  idleContent,
  data = {
    title: "AVAILABLE",
    subtitle: "Workstation ready",
    status: "STANDBY"
  }
}: {
  /** Bottom of the stand, on the supporting tabletop (not the panel centre). */
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  resourceId?: string;
  /** Only "welcome" (a front-desk screen) changes what the monitor shows; roles come from the slot. */
  variant?: ScreenVariant;
  /** "monitor" is a bare external display; "all-in-one" is a computer with its own desktop and taskbar. */
  device?: "monitor" | "all-in-one";
  /** Role on a multi-monitor desk: 1 = main/editor, 2 = terminal/tests, 3 = docs/browser. */
  slot?: number;
  /** Number of monitors on this desk. */
  slots?: number;
  /** What the screen shows when nobody sits at the desk. */
  idleContent?: "lock" | "welcome";
  data?: SmartScreenData;
}) {
  // Light from the panel lands on the desk in front of it: keyboard, hands and paper pick it up.
  const pool: DeskPool = {
    center: [0, 0.002 - monitorPanelY(height), 0.29],
    width: width * 1.5,
    depth: 0.56
  };
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeDeskDevice: "monitor", resourceId: resourceId ?? data.resourceId, slot }}>
      <SmartScreen position={[0, monitorPanelY(height), 0]} data={data} resourceId={resourceId} width={width} height={height}
        bezel={MONITOR.bezel} depth={MONITOR.depth} variant={variant}
        device={device} slot={slot} slots={slots} idleContent={idleContent} deskPool={pool} housingAsset="monitor-shell" />

      {/* VESA neck, hinge and low-profile weighted base. */}
      <WorkstationPart asset="monitor-stand">
      <mesh position={[0, MONITOR.clearance / 2 + 0.018, -0.012]}>
        <boxGeometry args={[0.045, MONITOR.clearance + 0.018, 0.035]} />
        <meshStandardMaterial color="#35434b" metalness={0.72} roughness={0.27} />
      </mesh>
      <mesh position={[0, 0.027, -0.012]}>
        <cylinderGeometry args={[0.045, 0.055, 0.025, 20]} />
        <meshStandardMaterial color="#45545c" metalness={0.74} roughness={0.26} />
      </mesh>
      <mesh position={[0, MONITOR.baseHeight / 2, 0.008]}>
        <boxGeometry args={[MONITOR.baseWidth, MONITOR.baseHeight, MONITOR.baseDepth]} />
        <meshStandardMaterial color="#252f35" metalness={0.62} roughness={0.28} />
      </mesh>
      <mesh position={[0, MONITOR.baseHeight + 0.002, 0.083]}>
        <boxGeometry args={[0.16, 0.004, 0.004]} />
        <meshStandardMaterial color="#6b9f9a" emissive="#397d78" emissiveIntensity={0.28} roughness={0.4} />
      </mesh>
      </WorkstationPart>
    </group>
  );
}
