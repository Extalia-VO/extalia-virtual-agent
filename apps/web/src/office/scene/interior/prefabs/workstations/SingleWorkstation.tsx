import type { SmartScreenData } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Laptop } from "../props/Laptop";
import { Keyboard } from "../props/Keyboard";
import { DeskAccessorySet } from "../props/DeskAccessories";
import { SINGLE_WORKSTATION_BLUEPRINT } from "../../spatialBlueprints";

export type DeskDevice = "laptop" | "all-in-one" | "dual-monitor";

export function SingleWorkstation({
  position = [0, 0, 0],
  rotationY = 0,
  device = "all-in-one",
  deskColor = "#a77e58",
  screenData
}: {
  position?: [number, number, number];
  rotationY?: number;
  device?: DeskDevice;
  deskColor?: string;
  screenData?: SmartScreenData;
}) {
  const data = screenData ?? {
    title: "AVAILABLE",
    subtitle: "Workstation ready",
    status: "STANDBY"
  };

  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
      <mesh castShadow receiveShadow position={[0, SINGLE_WORKSTATION_BLUEPRINT.topY, 0]}>
        <boxGeometry args={SINGLE_WORKSTATION_BLUEPRINT.topSize} />
        <meshStandardMaterial color={deskColor} roughness={0.76} />
      </mesh>
      {SINGLE_WORKSTATION_BLUEPRINT.legXs.map((x) => (
        <mesh key={x} castShadow position={[x, SINGLE_WORKSTATION_BLUEPRINT.legY, 0]}>
          <boxGeometry args={SINGLE_WORKSTATION_BLUEPRINT.legSize} />
          <meshStandardMaterial color="#706359" roughness={0.8} />
        </mesh>
      ))}

      {device === "laptop" && (
        <>
          <Laptop position={[0, 0.82, -0.10]} data={data} />
          <Keyboard position={[0, 0.80, 0.16]} />
          <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />
        </>
      )}

      {device === "all-in-one" && (
        <>
          <Monitor
            position={[0, 1.25, -0.17]}
            width={0.78}
            height={0.46}
            data={data}
          />
          <Keyboard position={[0, 0.80, 0.18]} />
          <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />
        </>
      )}

      {device === "dual-monitor" && (
        <>
          <Monitor
            position={[-0.42, 1.25, -0.18]}
            rotationY={0.08}
            width={0.68}
            height={0.4}
            data={data}
          />
          <Monitor
            position={[0.42, 1.25, -0.18]}
            rotationY={-0.08}
            width={0.68}
            height={0.4}
            variant="chart"
            data={data}
          />
          <Keyboard position={[0, 0.80, 0.2]} />
          <DeskAccessorySet
            topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2}
            cup
            stationery={false}
            resourceId={data.resourceId}
          />
        </>
      )}

      {/* Chair remains an independent furniture object. */}
      <OfficeChair
        position={[...SINGLE_WORKSTATION_BLUEPRINT.chairPosition]}
        rotationY={SINGLE_WORKSTATION_BLUEPRINT.chairRotationY}
      />
    </group>
  );
}

export function LaptopDesk(
  props: Omit<Parameters<typeof SingleWorkstation>[0], "device">
) {
  return <SingleWorkstation {...props} device="laptop" />;
}

export function AllInOneDesk(
  props: Omit<Parameters<typeof SingleWorkstation>[0], "device">
) {
  return <SingleWorkstation {...props} device="all-in-one" />;
}

export function DualMonitorDesk(
  props: Omit<Parameters<typeof SingleWorkstation>[0], "device">
) {
  return <SingleWorkstation {...props} device="dual-monitor" />;
}
