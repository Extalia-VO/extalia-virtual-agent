import type { FurnishedFloorState } from "../../FurnishedFloorContext";
import type { SmartScreenData } from "../../screenData";
import { screenForLocation } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Laptop } from "../props/Laptop";
import { Keyboard } from "../props/Keyboard";
import { MouseAndPad } from "../props/DeskAccessories";
import { DeskAccessorySlots, LaptopStand } from "../props/DeskOrganizers";
import { deskInputPlacement, deskLayout, POD_DESK_SLOTS } from "../../deskLayout";
import { TEAM_POD_SEAT, TEAM_POD_STATIONS } from "../../spatialBlueprints";
import { TEAM_POD_DESKTOP } from "../../teamPodDesktopGeometry";
import { TeamPodDesktop } from "../../TeamPodDesktop";
import { monitorBankLayout } from "../props/deviceGeometry";

type DeviceVariant =
  | "dual-monitor"
  | "all-in-one"
  | "monitor-laptop"
  | "laptop";

type StationDefinition = typeof TEAM_POD_STATIONS[number];

function DeviceSet({
  variant,
  data
}: {
  variant: DeviceVariant;
  data: SmartScreenData;
}) {
  // Generic station is the SE quadrant.
  // A 45° screen yaw faces the diagonal SE chair.
  const diagonalFacing = Math.PI / 4;
  const top = TEAM_POD_DESKTOP.top;

  // This station's own arrangement: keyboard size and spot, mouse side.
  const input = deskInputPlacement(TEAM_POD_SEAT.keyboardPosition, diagonalFacing, top, deskLayout(data.resourceId));
  const inputs = <>
    <Keyboard position={input.keyboard} rotationY={input.keyboardYaw} kind={input.keyboardKind} />
    <MouseAndPad position={input.pad} rotationY={input.mouseYaw} mouseOnPad={input.mouseOnPad} />
  </>;

  switch (variant) {
    case "dual-monitor":
      return (
        <>
          {monitorBankLayout(2, .50, [.52, top, .52], diagonalFacing).map((monitor, index) => <Monitor key={index} {...monitor} slot={index+1} slots={2} data={data} />)}

          {inputs}
        </>
      );

    case "all-in-one":
      return (
        <>
          <Monitor
            position={[0.48, top, 0.48]}
            rotationY={diagonalFacing}
            width={0.56}
            device="all-in-one"
            data={data}
          />

          {inputs}
        </>
      );

    case "monitor-laptop":
      return (
        <>
          <Monitor
            position={[0.42, top, 0.46]}
            rotationY={diagonalFacing + 0.08}
            width={0.52}
            slot={1}
            slots={2}
            data={data}
          />

          <group position={[0.88, top, 0.235]} rotation={[0, diagonalFacing - 0.15, 0]}>
            <LaptopStand><Laptop position={[0, 0, 0]} slot={2} slots={2} data={data} /></LaptopStand>
          </group>

          {inputs}
        </>
      );

    case "laptop":
      return (
        <>
          {/* Laptop raised on a stand behind its external keyboard and mouse. */}
          <group position={[0.48, top, 0.48]} rotation={[0, diagonalFacing, 0]}>
            <LaptopStand><Laptop position={[0, 0, 0]} data={data} /></LaptopStand>
          </group>
          {inputs}
        </>
      );
  }
}

function QuadrantStation({
  station,
  data
}: {
  station: StationDefinition;
  data: SmartScreenData;
}) {
  return (
    <group rotation={[0, station.rotationY, 0]} userData={{ officeSeatStation: true }}>
      <DeviceSet
        variant={station.variant}
        data={data}
      />
      <DeskAccessorySlots layout={deskLayout(data.resourceId)} slots={POD_DESK_SLOTS} topY={TEAM_POD_DESKTOP.top} />

      <OfficeChair
        position={[TEAM_POD_SEAT.chairPosition[0], 0, TEAM_POD_SEAT.chairPosition[1]]}
        rotationY={TEAM_POD_SEAT.chairRotationY}
        resourceId={data.resourceId}
      />

    </group>
  );
}

export function TeamPod4({
  podId,
  floorState,
  position = [0, 0, 0],
  rotationY = 0
}: {
  podId: string;
  floorState: FurnishedFloorState;
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <TeamPodDesktop />
      {TEAM_POD_STATIONS.map((station: StationDefinition) => {
        const data = screenForLocation(
          floorState,
          `floor-1.team-workspace.${podId}.${station.id}`
        );

        return (
          <QuadrantStation
            key={station.id}
            station={station}
            data={data}
          />
        );
      })}

    </group>
  );
}
