import type { SmartScreenData } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Keyboard } from "../props/Keyboard";
import { DeskAccessorySet, MouseAndPad } from "../props/DeskAccessories";
import { deskInputPlacement, deskLayout } from "../../deskLayout";
import { SINGLE_WORKSTATION_BLUEPRINT } from "../../spatialBlueprints";
import { SingleDeskStructure } from "../../SingleDeskStructure";

export function TouchdownDesk({
  position = [0, 0, 0],
  rotationY = 0,
  data
}: {
  position?: [number, number, number];
  rotationY?: number;
  data: SmartScreenData;
}) {
  const top = SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2;
  const input = deskInputPlacement([0, 0.80, SINGLE_WORKSTATION_BLUEPRINT.keyboardZ], 0, top, deskLayout(data.resourceId));
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <SingleDeskStructure color="#ad845f" />

      <Monitor
        position={[0, SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2, -0.20]}
        width={0.54}
        data={data}
      />

      <Keyboard position={input.keyboard} rotationY={input.keyboardYaw} kind={input.keyboardKind} />
      <MouseAndPad position={input.pad} rotationY={input.mouseYaw} mouseOnPad={input.mouseOnPad} />
      <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />

      <OfficeChair
        position={[...SINGLE_WORKSTATION_BLUEPRINT.chairPosition]}
        rotationY={SINGLE_WORKSTATION_BLUEPRINT.chairRotationY}
        resourceId={data.resourceId}
      />
    </group>
  );
}
