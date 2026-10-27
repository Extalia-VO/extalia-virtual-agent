import type { SmartScreenData } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Laptop } from "../props/Laptop";
import { Keyboard } from "../props/Keyboard";
import { DeskAccessorySet, MouseAndPad } from "../props/DeskAccessories";
import { LaptopStand } from "../props/DeskOrganizers";
import { deskInputPlacement, deskLayout } from "../../deskLayout";
import { SINGLE_WORKSTATION_BLUEPRINT } from "../../spatialBlueprints";
import { SingleDeskStructure } from "../../SingleDeskStructure";
import { monitorBankLayout } from "../props/deviceGeometry";

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

  const top = SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2;
  // This desk's own arrangement: keyboard size and spot, mouse side, organizers.
  const input = deskInputPlacement([0, 0.80, SINGLE_WORKSTATION_BLUEPRINT.keyboardZ], 0, top, deskLayout(data.resourceId));
  const inputs = <>
    <Keyboard position={input.keyboard} rotationY={input.keyboardYaw} kind={input.keyboardKind} />
    <MouseAndPad position={input.pad} rotationY={input.mouseYaw} mouseOnPad={input.mouseOnPad} />
  </>;

  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeatStation: true }}>
      <SingleDeskStructure color={deskColor} />

      {device === "laptop" && (
        <>
          {/* Laptop raised on a stand behind its external keyboard and mouse. */}
          <group position={[0, top, -0.20]}>
            <LaptopStand><Laptop position={[0, 0, 0]} data={data} /></LaptopStand>
          </group>
          {inputs}
          <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />
        </>
      )}

      {device === "all-in-one" && (
        <>
          <Monitor
            position={[0, top, -0.20]}
            width={0.56}
            device="all-in-one"
            data={data}
          />
          {inputs}
          <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />
        </>
      )}

      {device === "dual-monitor" && (
        <>
          {monitorBankLayout(2, .54, [0, top, -.20]).map((monitor, index) => <Monitor key={index} {...monitor} slot={index+1} slots={2} data={data} />)}
          {inputs}
          <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />
        </>
      )}

      {/* Chair remains an independent furniture object. */}
      <OfficeChair
        position={[...SINGLE_WORKSTATION_BLUEPRINT.chairPosition]}
        rotationY={SINGLE_WORKSTATION_BLUEPRINT.chairRotationY}
        resourceId={data.resourceId}
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
