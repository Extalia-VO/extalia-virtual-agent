import { SceneLabel } from "./interior/SceneLabel";
import { useFurnishedFloorState } from "./interior/FurnishedFloorContext";
import { RoomShell } from "./interior/RoomShell";
import { ExecutiveRoomInterior } from "./interior/prefabs/interiors/ExecutiveRoomInterior";
import { ModernMeetingRoom } from "./interior/prefabs/interiors/ModernMeetingRoom";
import {
  DualMonitorDesk,
  LaptopDesk
} from "./interior/prefabs/workstations/SingleWorkstation";
import { WallDisplay } from "./interior/prefabs/props/WallDisplay";
import { Whiteboard } from "./interior/prefabs/props/Whiteboard";
import { Plant } from "./interior/prefabs/props/Plant";
import {
  Bookshelf,
  CoffeeTable,
  ConsoleTable,
  DisplayCabinet
} from "./interior/prefabs/furniture/TablesAndStorage";
import { ArmChair } from "./interior/prefabs/furniture/Sofa";
import { FloorFinish } from "./interior/prefabs/finishes/FloorFinish";
import { AreaRug, PendantLight, WallArt } from "./interior/prefabs/props/OfficeDecor";
import { CirculationLighting } from "./interior/prefabs/architecture/CirculationLighting";
import { StairLandingDecor } from "./interior/prefabs/architecture/StairLandingDecor";
import { CornerLampFixture, WallSconceFixture, StandLampFixture, DeskLampFixture } from "./interior/prefabs/architecture/LightFixtureGeometries";
import { StairwellFloorPlate } from "./interior/prefabs/architecture/StairwellFloorPlate";
import { useFloorVisible } from "./interior/FloorVisibilityContext";
import { EXECUTIVE_OFFICE_BLUEPRINT } from "./interior/spatialBlueprints";
import { roomById } from "./interior/worldRegistry";
import {
  executiveScreens,
  meetingScreen,
  missionControlScreen,
  screenForLocation
} from "./interior/screenData";

export function Floor2() {
  const floorState = useFurnishedFloorState();
  const floorVisible = useFloorVisible();
  const executiveData = executiveScreens(floorState);
  const missionSize = roomById("mission-control")!.size;
  const architectureSize = roomById("architecture")!.size;
  const reviewSize = roomById("review")!.size;

  return (
    <group>
      <CirculationLighting floor={2} />
      <StairLandingDecor floor={2} />
      <StairwellFloorPlate />

      <SceneLabel position={[-20, 0.3, -8.2]} center={false} style={{ display: floorVisible ? "block" : "none" }}>
        <div className="floor-label">
          <strong>F2</strong>
          <span>Leadership, Collaboration & Knowledge</span>
        </div>
      </SceneLabel>

      {/* 1. North Wing (Facing Front Exterior): Executive / CEO & Mission Control */}
      {/* The registry defines every shell; interactive furniture keeps its room-local anchors. */}
      <RoomShell
        roomId="executive"
        label="Executive / CEO Office"
        position={[EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[0], 0, EXECUTIVE_OFFICE_BLUEPRINT.roomCenter[1]]}
        size={roomById("executive")!.size}
        entrySide="front"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <ExecutiveRoomInterior roomId="executive" screens={executiveData} />
      </RoomShell>

      {/* Mission Control: four desks fit within the narrower east wing. */}
      <RoomShell
        roomId="mission-control"
        label="Mission Control"
        position={[4, 0, -14.4]}
        size={roomById("mission-control")!.size}
        entrySide="front"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <WallDisplay
          position={[0, 1.9, -missionSize[1] / 2 + 0.08]}
          width={6.4}
          height={2.0}
          data={missionControlScreen(floorState)}
        />

        <DualMonitorDesk
          position={[-4.7, 0, 0.45]}
          screenData={screenForLocation(
            floorState,
            "floor-2.mission-control.station-1"
          )}
        />
        <DualMonitorDesk
          position={[-1.6, 0, 0.45]}
          screenData={screenForLocation(
            floorState,
            "floor-2.mission-control.station-2"
          )}
        />
        <DualMonitorDesk
          position={[1.6, 0, 0.45]}
          screenData={screenForLocation(
            floorState,
            "floor-2.mission-control.station-3"
          )}
        />
        <LaptopDesk position={[4.7, 0, 0.45]}
          screenData={screenForLocation(floorState, "floor-2.mission-control.station-4")} />
        <Plant position={[missionSize[0] / 2 - 0.9, 0, missionSize[1] / 2 - 0.9]} />
        <CornerLampFixture position={[-missionSize[0] / 2 + 0.8, 0, -missionSize[1] / 2 + 0.7]} />
        <CornerLampFixture position={[missionSize[0] / 2 - 0.8, 0, -missionSize[1] / 2 + 0.7]} />
      </RoomShell>

      <FloorFinish size={[32, 3.2]} position={[-5, 0, -8.2]} material="stone" />

      <SceneLabel position={[-5, 0.12, -8.2]} center style={{ display: floorVisible ? "block" : "none" }}>
        <div className="corridor-label">
          Executive / Collaboration Corridor
        </div>
      </SceneLabel>

      {/* Strategy occupies the rear suite between Review and Archive. */}
      <RoomShell
        roomId="architecture"
        label="Architecture / Strategy"
        position={[8.75, 0, 14.8]}
        size={roomById("architecture")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <LaptopDesk position={[-1.8, 0, 0.5]}
          screenData={screenForLocation(floorState, "floor-2.architecture.laptop")} />

        <Whiteboard
          position={[2.2, 1.8, architectureSize[1] / 2 - 0.08]}
          rotationY={Math.PI}
          width={2.4}
        />

        <WallDisplay
          position={[-1.8, 1.8, architectureSize[1] / 2 - 0.08]}
          rotationY={Math.PI}
          width={2.2}
          height={1.2}
          variant="diagram"
          data={{
            title: "ARCHITECTURE",
            subtitle: "Strategy / design",
            status: "READY"
          }}
        />
        <AreaRug position={[-1.8, 0, 0.5]} width={5.2} depth={4.2} color="#d5c7b2" borderColor="#b09e83" />
        <Plant position={[-architectureSize[0] / 2 + 0.9, 0, architectureSize[1] / 2 - 0.9]} />
        <Plant position={[architectureSize[0] / 2 - 0.9, 0, architectureSize[1] / 2 - 0.9]} />
        <StandLampFixture position={[architectureSize[0] / 2 - 1.8, 0, -architectureSize[1] / 2 + 1]} />
      </RoomShell>

      {/* Middle wing: both meeting suites preserve their existing ten/fourteen seats. */}
      <RoomShell
        roomId="meeting-a"
        label="Meeting Room A"
        position={[-13, 0, 0.4]}
        size={roomById("meeting-a")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <ModernMeetingRoom roomId="meeting-a" screenData={meetingScreen(floorState, "meeting-a")} />
      </RoomShell>

      {/* Archive occupies the rear-east suite with a clear central access aisle. */}
      <RoomShell
        roomId="archive"
        label="Archive"
        position={[20.25, 0, 14.8]}
        size={roomById("archive")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        {/* Keep the doorway-to-window aisle clear. Display and shelf fronts face inward
            flush against the west and east walls. */}
        <Bookshelf
          position={[-4.46, 0, -2.1]}
          rotationY={Math.PI / 2}
          width={2.4}
        />
        <DisplayCabinet
          position={[-4.44, 0, 1.35]}
          rotationY={Math.PI / 2}
          width={3.8}
        />
        <ConsoleTable position={[4.48, 0, -2.1]} rotationY={-Math.PI / 2} width={2.0} />
        <DisplayCabinet
          position={[4.44, 0, 1.35]}
          rotationY={-Math.PI / 2}
          width={3.8}
        />
        <AreaRug position={[0, 0, 0.2]} width={5.2} depth={6.2} color="#d2c5b0" borderColor="#9e8d74" />
        <Plant position={[4.05, 0, -3.55]} />
        <Plant position={[-4.05, 0, 3.55]} />
        {/* Archive lighting: corner stand lamps + pendant over central aisle */}
        <StandLampFixture position={[-4.05, 0, -3.55]} />
        <StandLampFixture position={[4.05, 0, 3.55]} />
        <PendantLight position={[0, 2.85, 0.2]} drop={0.65} />
      </RoomShell>

      <FloorFinish size={[46, 3.2]} position={[2, 0, 9]} material="stone" />

      {/* Rear row: Knowledge, Review, Strategy, and Archive share the full-width corridor. */}
      <RoomShell
        roomId="knowledge"
        label="Knowledge Room"
        position={[-15.25, 0, 14.8]}
        size={roomById("knowledge")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <Bookshelf
          position={[-5.43, 0, -1.5]}
          rotationY={Math.PI / 2}
          width={2.5}
        />
        <Bookshelf
          position={[-5.43, 0, 1.55]}
          rotationY={Math.PI / 2}
          width={2.5}
        />
        <LaptopDesk position={[0.5, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-2.knowledge.laptop")} />
        <AreaRug position={[2.8, 0, 2.2]} width={3.6} depth={2.5} color="#cbbfa8" />
        <ArmChair position={[3.2, 0, 2.3]} rotationY={Math.PI} color="#a8b6a9" />
        <CoffeeTable position={[1.8, 0, 2.2]} />
        {/* Knowledge room lighting: desk lamp + stand lamp by reading chair */}
        <DeskLampFixture position={[0.5 - 0.45, 0.74, 0.35]} />
        <StandLampFixture position={[5.05, 0, 3.4]} />
      </RoomShell>

      {/* Review workstations keep their existing local seat anchors. */}
      <RoomShell
        roomId="review"
        label="Review / Security"
        position={[-3.75, 0, 14.8]}
        size={roomById("review")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        floorFinish="carpet"
      >
        <DualMonitorDesk
          position={[-2.8, 0, 0.2]}
          screenData={screenForLocation(
            floorState,
            "floor-2.review-security.station-1"
          )}
        />

        <DualMonitorDesk
          position={[2.8, 0, 0.2]}
          screenData={screenForLocation(
            floorState,
            "floor-2.review-security.station-2"
          )}
        />
        <WallArt position={[0, 1.7, reviewSize[1] / 2 - 0.08]} rotationY={Math.PI} width={1.8} height={0.82} accentColor="#597b79" />
        {/* Review / Security lighting: desk lamps + wall sconce */}
        <DeskLampFixture position={[-2.8 - 0.55, 0.74, 0.35]} />
        <DeskLampFixture position={[2.8 + 0.55, 0.74, 0.35]} />
        <WallSconceFixture position={[0, 1.8, reviewSize[1] / 2 - 0.08]} rotation={[0, Math.PI, 0]} />
      </RoomShell>

      {/* Meeting Room B occupies the east middle suite. */}
      <RoomShell
        roomId="meeting-b"
        label="Meeting Room B"
        position={[3, 0, 0.4]}
        size={roomById("meeting-b")!.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <ModernMeetingRoom roomId="meeting-b" screenData={meetingScreen(floorState, "meeting-b")} />
      </RoomShell>
    </group>
  );
}
