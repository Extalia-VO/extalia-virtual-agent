import type { SmartScreenData } from "../../screenData";
import { OfficeChair } from "../furniture/OfficeChair";
import { Monitor } from "../props/Monitor";
import { Keyboard } from "../props/Keyboard";
import { DeskAccessorySet } from "../props/DeskAccessories";
import { SINGLE_WORKSTATION_BLUEPRINT } from "../../spatialBlueprints";

export function TouchdownDesk({
  position = [0, 0, 0],
  rotationY = 0,
  data
}: {
  position?: [number, number, number];
  rotationY?: number;
  data: SmartScreenData;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]}>
      <mesh receiveShadow position={[0, SINGLE_WORKSTATION_BLUEPRINT.topY, 0]}>
        <boxGeometry args={SINGLE_WORKSTATION_BLUEPRINT.topSize} />
        <meshStandardMaterial color="#ad845f" roughness={0.78} />
      </mesh>

      {SINGLE_WORKSTATION_BLUEPRINT.legXs.map((x) => (
        <mesh key={x} position={[x, SINGLE_WORKSTATION_BLUEPRINT.legY, 0]}>
          <boxGeometry args={SINGLE_WORKSTATION_BLUEPRINT.legSize} />
          <meshStandardMaterial color="#6d625a" roughness={0.8} />
        </mesh>
      ))}

      <Monitor
        position={[0, 1.22, -0.14]}
        width={0.72}
        height={0.42}
        data={data}
      />

      <Keyboard position={[0, 0.80, 0.18]} />
      <DeskAccessorySet topY={SINGLE_WORKSTATION_BLUEPRINT.topY + SINGLE_WORKSTATION_BLUEPRINT.topSize[1] / 2} resourceId={data.resourceId} />

      <OfficeChair
        position={[...SINGLE_WORKSTATION_BLUEPRINT.chairPosition]}
        rotationY={SINGLE_WORKSTATION_BLUEPRINT.chairRotationY}
      />
    </group>
  );
}
