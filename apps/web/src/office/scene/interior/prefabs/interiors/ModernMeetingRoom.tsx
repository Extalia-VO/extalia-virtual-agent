import type { SmartScreenData } from "../../screenData";
import { MEETING_ROOM_LAYOUTS, type MeetingRoomId } from "../../roomRedesignLayout";
import { MeetingRoomFurniture } from "../meeting/MeetingFurniture";
import { StandLampFixture, WallSconceFixture } from "../architecture/LightFixtureGeometries";
import { AbstractArtwork, AcousticPanel, ModernCredenza, SculpturalPlanter, ZonedRug } from "./ContemporaryRoomDetails";

/** Table, chairs, screen and whiteboard share the registry's furniture-local blueprint. */
export function ModernMeetingRoom({ roomId, screenData }: {
  roomId: MeetingRoomId; screenData: SmartScreenData;
}) {
  const layout = MEETING_ROOM_LAYOUTS[roomId];
  const cool = roomId === "meeting-b";
  const [width] = layout.roomSize;
  const presentationX = layout.furnitureLocal[0] + layout.presentationWall.position[0] + 0.085;

  return <group name={`${roomId}-contemporary-interior`}>
    <ZonedRug {...layout.rug} cool={cool} />
    <MeetingRoomFurniture position={[layout.furnitureLocal[0], 0, layout.furnitureLocal[1]]}
      blueprint={layout} screenData={screenData} />

    {/* Presentation-wall ribs stop short of both the display controls and whiteboard. */}
    <AcousticPanel position={[presentationX, 1.4, -4.75]} rotationY={Math.PI / 2} width={2.65} />
    <AcousticPanel position={[presentationX, 1.4, 5.25]} rotationY={Math.PI / 2} width={2.45} />

    {/* Shallow acoustic islands add a finished side wall without occupying chair aisles. */}
    <AcousticPanel position={[width / 2 - 0.18, 1.45, -2.75]} rotationY={-Math.PI / 2} width={2.3} height={2.35} />
    <AbstractArtwork position={[width / 2 - 0.27, 1.68, -2.75]} rotationY={-Math.PI / 2} width={1.85} cool={cool} />
    <ModernCredenza position={layout.credenza.position} rotationY={layout.credenza.rotationY}
      width={layout.credenza.size[0]} depth={layout.credenza.size[1]} />
    {layout.planters.map((position, i) => <SculpturalPlanter key={i} position={position} />)}

    <WallSconceFixture position={[-width / 2 + 0.19, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} />
    <WallSconceFixture position={[width / 2 - 0.19, 1.8, 0]} rotation={[0, -Math.PI / 2, 0]} />
    <StandLampFixture position={[...layout.fixtures.standLamp]} />
  </group>;
}
