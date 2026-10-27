import type { SmartScreenData } from "../../screenData";
import { SmartScreen, type ScreenVariant } from "../screens/SmartScreen";

export function WallDisplay({
  position = [0, 0, 0],
  rotationY = 0,
  width = 2.8,
  height = 1.55,
  variant = "agents",
  device = "wall",
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
  /**
   * Board type. "agents" (default) is the office overview with agents online, activity and a clock;
   * "presentation" is a meeting-room screen waiting for a presenter; "media" is an entertainment TV;
   * "monitoring", "diagram", "knowledge" and "signage" suit operations, architecture, library and
   * wellness walls.
   */
  variant?: ScreenVariant;
  device?: "wall" | "tv";
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
      device={device}
    />
  );
}
