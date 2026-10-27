import type { SmartScreenData } from "../../screenData";
import { SmartScreen } from "../screens/SmartScreen";
import type { DeskPool } from "../screens/screenGlow";

import { LAPTOP, LAPTOP_LID_CENTER, inLaptopScreenFrame } from "./deviceGeometry";
import { WorkstationPart } from "../../WorkstationPart";

// Keep the glow on the physical keyboard deck in the tilted screen's frame.
const DECK_POOL: DeskPool = {
  center: inLaptopScreenFrame(0, LAPTOP.deckHeight + 0.002, 0.025),
  rotationX: -LAPTOP.tilt, width: LAPTOP.width, depth: LAPTOP.depth,
};

export function Laptop({
  position = [0, 0, 0],
  rotationY = 0,
  slot = 1,
  slots = 1,
  data = { title: "AVAILABLE", subtitle: "Workstation ready", status: "STANDBY" }
}: {
  /** Bottom of the deck, on the supporting tabletop. */
  position?: [number, number, number];
  rotationY?: number;
  /** Role when the laptop sits next to a monitor: 1 = main/editor, 2 = terminal/tests, 3 = docs. */
  slot?: number;
  /** Number of screens on this desk, laptop included. */
  slots?: number;
  data?: SmartScreenData;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeDeskDevice: "laptop", resourceId: data.resourceId, slot }}>
      <WorkstationPart asset="laptop-deck"><mesh position={[0, LAPTOP.deckHeight / 2, 0]}>
        <boxGeometry args={[LAPTOP.width, LAPTOP.deckHeight, LAPTOP.depth]} />
        <meshStandardMaterial color="#aeb5ba" metalness={0.55} roughness={0.35} />
      </mesh></WorkstationPart>
      <group position={[...LAPTOP_LID_CENTER]} rotation={[LAPTOP.tilt, 0, 0]}>
        <WorkstationPart asset="laptop-lid"><mesh>
          <boxGeometry args={[LAPTOP.width, LAPTOP.lidHeight, LAPTOP.lidDepth]} />
          <meshStandardMaterial color="#111a20" metalness={0.28} roughness={0.24} />
        </mesh></WorkstationPart>
        <group position={[0, 0, LAPTOP.screenOffset]}>
          <SmartScreen data={data} width={LAPTOP.screenWidth} height={LAPTOP.screenHeight} bezel={LAPTOP.bezel} depth={0.01}
            device="laptop" slot={slot} slots={slots} deskPool={DECK_POOL} frame={false} />
        </group>
      </group>
    </group>
  );
}
