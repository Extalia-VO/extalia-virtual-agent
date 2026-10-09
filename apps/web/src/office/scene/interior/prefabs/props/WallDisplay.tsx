import type { SmartScreenData } from "../../screenData";
import { SmartScreen, type ScreenVariant } from "../screens/SmartScreen";

export function WallDisplay({
  position = [0, 0, 0],
  rotationY = 0,
  width = 2.8,
  height = 1.55,
  variant = "status",
  data = {
    title: "EXTALIA VIRTUAL OFFICE",
    subtitle: "Display ready",
    status: "STANDBY"
  }
}: {
  position?: [number, number, number];
  rotationY?: number;
  width?: number;
  height?: number;
  /** "presentation" for meeting rooms, "media" for entertainment TVs. */
  variant?: ScreenVariant;
  data?: SmartScreenData;
}) {
  return (
    <SmartScreen
      data={data}
      position={position}
      rotationY={rotationY}
      width={width}
      height={height}
      variant={variant}
    />
  );
}
