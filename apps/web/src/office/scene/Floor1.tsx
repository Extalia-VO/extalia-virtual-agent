import { FixtureSpotLight } from "./interior/prefabs/architecture/FixtureSpotLight";
import { relocateRoomPoint } from "./interior/roomRelocation";
import { SceneLabel } from "./interior/SceneLabel";
import { useFurnishedFloorState } from "./interior/FurnishedFloorContext";
import { RoomShell } from "./interior/RoomShell";
import { TeamPod4 } from "./interior/prefabs/workstations/TeamPod4";
import {
  DualMonitorDesk,
  LaptopDesk
} from "./interior/prefabs/workstations/SingleWorkstation";
import {
  Bookshelf,
  CoffeeTable,
  StorageCabinet
} from "./interior/prefabs/furniture/TablesAndStorage";
import { Sofa, ArmChair } from "./interior/prefabs/furniture/Sofa";
import { Plant } from "./interior/prefabs/props/Plant";
import { ServerRack } from "./interior/prefabs/props/ServerRack";
import { ServerRoomServiceDetails } from "./interior/prefabs/props/ServerRoomServiceDetails";
import { WallDisplay } from "./interior/prefabs/props/WallDisplay";
import { ReceptionDesk } from "./interior/prefabs/ReceptionDesk";
import { GlassPartition } from "./interior/prefabs/architecture/GlassPartition";
import { OpenDoor } from "./interior/prefabs/architecture/OpenDoor";
import { SlidingDoor } from "./interior/prefabs/architecture/SlidingDoor";
import { WindowWall } from "./interior/prefabs/architecture/WindowWall";
import { Whiteboard } from "./interior/prefabs/props/Whiteboard";
import {
  missionControlScreen,
  screenForLocation
} from "./interior/screenData";
import { PrintCopyStation } from "./interior/prefabs/workspace/PrintCopyStation";
import { TouchdownDesk } from "./interior/prefabs/workspace/TouchdownDesk";
import { FloorFinish } from "./interior/prefabs/finishes/FloorFinish";
import { BartenderBar } from "./interior/prefabs/furniture/BartenderBar";
import { BARTENDER_BAR_BLUEPRINT, LIBRARY_BLUEPRINT, LOUNGE_FURNITURE_BLUEPRINT, RECEPTION_DESK_BLUEPRINT, SERVER_ROOM_BLUEPRINT, TEAM_POD_LAYOUT, TEAM_WORKSPACE_ORIGIN, TEAM_WORKSPACE_TOUCHDOWNS, TEAM_WORKSPACE_LOUNGES } from "./interior/spatialBlueprints";
import { EntertainmentSuite } from "./interior/prefabs/furniture/EntertainmentSuite";
import { AreaRug, PendantLight, WallArt } from "./interior/prefabs/props/OfficeDecor";
import { CornerLampFixture, WallSconceFixture, StandLampFixture, DeskLampFixture } from "./interior/prefabs/architecture/LightFixtureGeometries";
import {
  GrandHaloChandelier,
  GrandFloorMedallion,
  CorridorWayfindingRunner,
  SculpturalDisplayPlinth,
  ArchitecturalGalleryCanvas,
  MonumentalPlanter,
  DiningLinearPendant
} from "./interior/prefabs/architecture/GrandLobbyDecorations";
import { useFloorVisible } from "./interior/FloorVisibilityContext";
import { useSolarEnvironment } from "./Environment";
import { CAMPUS_ENTRY_LAYOUT, OFFICE_STAIR_LAYOUT, OFFICE_BUILDING } from "./layout";
import { roomById } from "./interior/worldRegistry";
import { F1EmergencyExit } from "./interior/prefabs/architecture/EmergencyExit";
import { CirculationLighting } from "./interior/prefabs/architecture/CirculationLighting";
import { StairLandingDecor } from "./interior/prefabs/architecture/StairLandingDecor";
import { ceilingMountsForFloor, ceilingYForFloor, raisedDownlightIntensity, raisedDownlightAngle, raisedDownlightRange } from "./interior/prefabs/architecture/ceilingMounting";

const F1_CEILING_Y = ceilingYForFloor(1);
const F1_CEILING_MOUNTS = ceilingMountsForFloor(1);

export function Floor1() {
  const floorState = useFurnishedFloorState();
  const floorVisible = useFloorVisible();
  const requiredRoom = (id: string) => {
    const room = roomById(id);
    if (!room) throw new Error(`Floor 1 room ${id} is required`);
    return room;
  };
  const lobby = requiredRoom("lobby");
  const engineering = requiredRoom("engineering");
  const lounge = requiredRoom("lounge");
  const library = requiredRoom("library");
  const operations = requiredRoom("operations");
  const sourceControl = requiredRoom("source-control");
  const qa = requiredRoom("qa");
  const entertainment = requiredRoom("entertainment");
  const [teamWidth, teamDepth] = engineering.size;

  const lobbyWest = lobby.center[0] - lobby.size[0] / 2;
  const lobbyEast = lobby.center[0] + lobby.size[0] / 2;
  const lobbyDoorWest = CAMPUS_ENTRY_LAYOUT.centerX - CAMPUS_ENTRY_LAYOUT.lobbyDoorWidth / 2;
  const lobbyDoorEast = CAMPUS_ENTRY_LAYOUT.centerX + CAMPUS_ENTRY_LAYOUT.lobbyDoorWidth / 2;
  const lobbyLeftWindowWidth = lobbyDoorWest - lobbyWest;
  const lobbyRightWindowWidth = lobbyEast - lobbyDoorEast;

  const sharedTeamDisplay = {
    ...missionControlScreen(floorState),
    title: "TEAM WORKSPACE",
    subtitle: "Active tasks / workforce"
  };

  return (
    <group>
      <CirculationLighting floor={1} />
      <StairLandingDecor floor={1} />
      <F1EmergencyExit />
      <mesh receiveShadow position={[OFFICE_BUILDING.centerX, -0.16, 0]}>
        <boxGeometry args={[OFFICE_BUILDING.width, 0.32, OFFICE_BUILDING.depth]} />
        <meshStandardMaterial color="#cdbb9f" roughness={0.96} />
      </mesh>
      <FloorFinish size={[OFFICE_BUILDING.width - 0.7, OFFICE_BUILDING.depth - 0.7]} position={[OFFICE_BUILDING.centerX, 0, 0]} material="stone" thickness={0.06} />

      <SceneLabel position={[-19.5, 0.3, -13.7]} center={false} style={{ display: floorVisible ? "block" : "none" }}>
        <div className="floor-label">
          <strong>F1</strong>
          <span>Workforce & Shared Facilities</span>
        </div>
      </SceneLabel>

      {/* Grand Lobby & Main Arrival Corridor (Unified Open Concept):
          Spans full width from west corner (x=-19.5) to east stair circulation (x=11.0),
          depth 6.7m (z from -14.45 to -7.75) merging the former front lobby and main corridor */}
      <group position={lobby.center} userData={{ officeLightZone: lobby.size }}>
        <FloorFinish size={lobby.size} material="stone" border />

        <SceneLabel position={[0, 2.85, 0]} center style={{ display: floorVisible ? "block" : "none" }}>
          <div className="room-label">Lobby / Grand Arrival</div>
        </SceneLabel>

        {/* Lobby glazing and sliding door share their world coordinates with the campus shell and route. */}
        <group position={[0, 0, CAMPUS_ENTRY_LAYOUT.lobbyDoorZ - lobby.center[2]]}>
          <WindowWall
            width={lobbyLeftWindowWidth}
            position={[(lobbyWest + lobbyDoorWest) / 2 - lobby.center[0], 1.35, 0]}
            rotationY={Math.PI}
            panels={Math.max(1, Math.round(lobbyLeftWindowWidth / 4.5))}
          />
          <WindowWall
            width={lobbyRightWindowWidth}
            position={[(lobbyDoorEast + lobbyEast) / 2 - lobby.center[0], 1.35, 0]}
            rotationY={Math.PI}
            panels={Math.max(1, Math.round(lobbyRightWindowWidth / 4.5))}
          />
          <SlidingDoor
            floor={1}
            roomId="lobby"
            role="exterior"
            position={[CAMPUS_ENTRY_LAYOUT.centerX - lobby.center[0], 0, 0]}
            rotationY={Math.PI}
            width={CAMPUS_ENTRY_LAYOUT.lobbyDoorWidth}
            height={2.65}
          />
        </group>

        {/* Dinding samping barat exterior gedung (x = -15.25, kedalaman penuh 6.7m) */}
        <WindowWall
          width={lobby.size[1]}
          position={[-lobby.size[0] / 2, 1.35, 0]}
          rotationY={Math.PI / 2}
          panels={3}
        />

        {/* 1. Guest Lounge Waiting Area (Sisi Barat) */}
        <group position={[-9.5, 0, 0.75]}>
          <AreaRug position={[0, 0.105, 0]} width={7.0} depth={3.6} color="#d7cbb8" borderColor="#b8a892" />
          <Sofa
            position={[-0.6, 0, 0.6]}
            rotationY={Math.PI}
            color="#c6b9a8"
          />
          <ArmChair
            position={[2.4, 0, 0.6]}
            rotationY={Math.PI}
            color="#8fa394"
          />
          <ArmChair
            position={[-2.8, 0, -0.4]}
            rotationY={Math.PI * 0.65}
            color="#8fa394"
          />
          <CoffeeTable position={[0.6, 0, -0.3]} />
          <Plant position={[-3.6, 0, 1.2]} />
          <Plant position={[3.2, 0, -1.2]} />
          {/* Architectural decorative corner lamps in the waiting lounge */}
          <CornerLampFixture position={[-4.4, 0, -1.4]} />
          <CornerLampFixture position={[4.0, 0, -0.6]} />
        </group>

        {/* Reception is on the east side of the arrival hall so it does not close
            the west-side opening into the Engineering workspace. The central door
            axis and the east-west lobby route remain clear. */}
        <ReceptionDesk
          position={[
            RECEPTION_DESK_BLUEPRINT.worldPosition[0] - (-4.25),
            0,
            RECEPTION_DESK_BLUEPRINT.worldPosition[1] - (-11.1)
          ]}
          rotationY={RECEPTION_DESK_BLUEPRINT.rotationY}
        />
        {/* Wall sconce on reception divider wall */}
        <WallSconceFixture position={[
          RECEPTION_DESK_BLUEPRINT.worldPosition[0] - (-4.25) - 2.25,
          1.8,
          RECEPTION_DESK_BLUEPRINT.worldPosition[1] - (-11.1)
        ]} />

        {/* Dinding pembatas dalam di belakang meja resepsionis dihilangkan sesuai permintaan agar lobby plong dan terbuka */}

        <Plant position={[-14.0, 0, 2.2]} />
        <Plant position={[14.0, 0, 2.2]} />

        {/* Grand Marble Medallion at Center of Arrival Court */}
        <GrandFloorMedallion position={[0, 0.015, 0]} radius={2.2} />

        {/* Flanking Monumental Planters at Entrance Portico */}
        <MonumentalPlanter position={[-4 - lobby.center[0], 0, -2.9]} scale={0.88} />
        <MonumentalPlanter position={[4 - lobby.center[0], 0, -2.9]} scale={0.88} />

        {/* Architectural Gallery Artwork on Lobby West & North Perimeter Walls */}
        <ArchitecturalGalleryCanvas
          position={[-lobby.size[0] / 2 + 0.1, 1.55, 0.6]}
          rotationY={Math.PI / 2}
          width={2.8}
          height={1.4}
          artTone="warm-amber"
        />
        <ArchitecturalGalleryCanvas
          position={[7.5, 1.55, -lobby.size[1] / 2 + 0.07]}
          rotationY={0}
          width={2.4}
          height={1.3}
          artTone="ocean"
        />

        <LobbyCeilingLights />
      </group>

      {/* East Corridor / Stair Arrival Plaza connecting to stairs and Open Lounge */}
      <group position={[15.25, 0, lobby.center[2]]}>
        <FloorFinish size={[OFFICE_STAIR_LAYOUT.eastEdge - 11, lobby.size[1]]} position={[(OFFICE_STAIR_LAYOUT.eastEdge + 11) / 2 - 15.25, 0.025, 0]} material="stone" />

        {/* Chandelier over the Stair Arrival Plaza */}
        <GrandHaloChandelier position={[-2.5, F1_CEILING_Y, -0.7]} outerRadius={0.85} innerRadius={0.55} drop={F1_CEILING_Y - 2.65} />

        {/* Monumental Sculptural Display Plinth along north corridor wall */}
        <SculpturalDisplayPlinth position={[-3.65, 0, -lobby.size[1] / 2 + 0.65]} rotationY={0.2} sculptureColor="#d4af37" />

        {/* Architectural Gallery Canvas on North Wall of Stair Corridor */}
        <ArchitecturalGalleryCanvas position={[-2.4, 1.55, -lobby.size[1] / 2 + 0.07]} rotationY={0} width={2.6} height={1.35} artTone="emerald" />

        {/* Monumental Planters framing the transition to the stairs */}
        <MonumentalPlanter position={[-1.15, 0, -lobby.size[1] / 2 + 0.65]} scale={0.5} potColor="#1c2128" />
      </group>

      {/* Grand Wayfinding Runner guiding visitors from the Lobby Main Door across to the Staircase */}
      <CorridorWayfindingRunner start={[0, lobby.center[2] - 1]} end={[13.5, lobby.center[2] - 1]} width={2.2} />

      {/* Large Team Workspace: digeser/diluaskan ke barat hingga dinding kantor x=-19.5 (lebar 27.0m, x in [-19.5, 7.5]) */}
      <group position={relocateRoomPoint("engineering", [TEAM_WORKSPACE_ORIGIN[0], 0, TEAM_WORKSPACE_ORIGIN[1]])} userData={{ officeLightZone: engineering.size }}>
        <FloorFinish size={engineering.size} position={[0, 0.01, 0]} material="oak" border />
        <TeamWorkspaceCeilingLights />

        {/* 1. West perimeter: Window wall to the outside campus (pas di sudut luar kantor x=-19.5) */}
        <WindowWall
          width={teamDepth}
          position={[-teamWidth / 2, 1.35, 0]}
          rotationY={Math.PI / 2}
          panels={5}
        />

        {/* 2. North perimeter (facing Main Corridor): Glazed partition with doorway access */}
        <GlassPartition
          width={teamWidth}
          position={[0, 1.275, -teamDepth / 2]}
          rotationY={Math.PI}
          doorGap={1.8}
        />
        <OpenDoor
          floor={1}
          roomId="engineering"
          role="north"
          position={[0, 0, -teamDepth / 2]}
          rotationY={Math.PI}
          width={1.6}
          height={2.55}
          glass
          openAngle={Math.PI * 0.38}
        />

        {/* 3. East perimeter (facing Open Lounge & Pantry): Glazed partition closing the room */}
        <GlassPartition
          width={teamDepth}
          position={[teamWidth / 2, 1.275, 0]}
          rotationY={-Math.PI / 2}
          doorGap={1.8}
        />
        <OpenDoor
          floor={1}
          roomId="engineering"
          role="east"
          position={[teamWidth / 2, 0, 0]}
          rotationY={-Math.PI / 2}
          width={1.6}
          height={2.55}
          glass
          openAngle={-Math.PI * 0.38}
        />

        {/* 4. South perimeter (facing Source Control Lab & Operations / Server): Glazed partition with doorway access */}
        <GlassPartition
          width={teamWidth}
          position={[0, 1.275, teamDepth / 2]}
          rotationY={0}
          doorGap={1.8}
        />
        <OpenDoor
          floor={1}
          roomId="engineering"
          role="south"
          position={[0, 0, teamDepth / 2]}
          rotationY={0}
          width={1.6}
          height={2.55}
          glass
          openAngle={-Math.PI * 0.38}
        />

        <SceneLabel position={[-11.8, 2.95, -teamDepth / 2 + 0.7]} center style={{ display: floorVisible ? "block" : "none" }}>
          <div className="room-label">
            Large Team Workspace · 4 Pods / 16 seats
          </div>
        </SceneLabel>

        {/*
          Central 16-seat work zone.
          Four separated pods retain sixteen workstations and clear
          north/south and east/west circulation aisles.
        */}
        {TEAM_POD_LAYOUT.map((pod) => <TeamPod4
          key={pod.id}
          podId={pod.id}
          floorState={floorState}
          position={[pod.position[0], 0, pod.position[1]]}
          rotationY={pod.rotationY}
        />)}

        {/* Informal collaboration corner */}
        <AreaRug position={[-12.0, 0.105, 4.3]} width={4.0} depth={3.1} color="#c6d0c3" borderColor="#9daa9f" />
        <Sofa
          position={[...TEAM_WORKSPACE_LOUNGES.westSofa.position]}
          rotationY={Math.PI / 2}
          color="#aeb8ac"
        />
        <ArmChair
          position={[...TEAM_WORKSPACE_LOUNGES.westChair.position]}
          rotationY={-Math.PI / 2}
          color="#d3aa78"
        />
        <CoffeeTable
          position={[-10.5, 0, 4.6]}
          rotationY={Math.PI / 2}
        />
        <Plant position={[-14.5, 0, 7.9]} scale={1.08} />

        {/* Team task/progress wall: Flush against the west window wall (x = -13.43, wall at -13.5) */}
        <WallDisplay
          position={[-teamWidth / 2 + 0.07, 1.82, -4.3]}
          rotationY={Math.PI / 2}
          width={2.75}
          height={1.50}
          data={sharedTeamDisplay}
        />
        {/* Accent warm standing lamp in the informal collaboration corner */}
        <StandLampFixture position={[-14.7, 0, 5.9]} lightColor="#ffbe76" />

        {/* Shared facilities strictly aligned FLUSH against the north and east perimeter walls,
            leaving the middle area completely open for central decorative furniture / lounge setup. */}
        <TouchdownDesk
          position={[
            TEAM_WORKSPACE_TOUCHDOWNS[1]!.position[0],
            0,
            TEAM_WORKSPACE_TOUCHDOWNS[1]!.position[1]
          ]}
          rotationY={TEAM_WORKSPACE_TOUCHDOWNS[1]!.rotationY}
          data={screenForLocation(floorState, TEAM_WORKSPACE_TOUCHDOWNS[1]!.location)}
        />
        <DeskLampFixture
          position={[TEAM_WORKSPACE_TOUCHDOWNS[1]!.position[0] - 0.55, 0.74, TEAM_WORKSPACE_TOUCHDOWNS[1]!.position[1] - 0.2]}
          rotationY={Math.PI}
          lightColor="#fff0d4"
        />

        {/* Print/copy station mounted flush against the north glass partition (z = -5.35, glass at -5.75) */}
        <PrintCopyStation
          position={[8.7, 0, -teamDepth / 2 + 0.45]}
        />

        {/* Storage cabinet, bookshelf, and task whiteboard flush against the east glazed partition (x = 13.5) */}
        <Whiteboard
          position={[teamWidth / 2 - 0.06, 1.82, -6.6]}
          rotationY={-Math.PI / 2}
          width={2.2}
        />

        <StorageCabinet
          position={[teamWidth / 2 - 0.26, 0, -3.9]}
          rotationY={-Math.PI / 2}
          width={2.2}
        />

        <Bookshelf
          position={[teamWidth / 2 - 0.22, 0, 4.5]}
          rotationY={-Math.PI / 2}
          width={2.2}
          height={2.15}
          doubleSided
        />

        {/* Touchdown desk 1 flush against the south glass partition (z = 5.35, glass at 5.75) */}
        <TouchdownDesk
          position={[
            TEAM_WORKSPACE_TOUCHDOWNS[0]!.position[0],
            0,
            TEAM_WORKSPACE_TOUCHDOWNS[0]!.position[1]
          ]}
          rotationY={TEAM_WORKSPACE_TOUCHDOWNS[0]!.rotationY}
          data={screenForLocation(floorState, TEAM_WORKSPACE_TOUCHDOWNS[0]!.location)}
        />
        <DeskLampFixture
          position={[TEAM_WORKSPACE_TOUCHDOWNS[0]!.position[0] - 0.55, 0.74, TEAM_WORKSPACE_TOUCHDOWNS[0]!.position[1] + 0.2]}
          rotationY={0}
          lightColor="#fff0d4"
        />

        <Plant position={[15.3, 0, 8.8]} />

        {/* ============================================================ */}
        {/* DECORATIVE FURNITURE ZONE IN THE MIDDLE OF EAST WING         */}
        {/* Karpet dekoratif, round coffee table, armchairs, dan tanaman */}
        {/* ============================================================ */}
        <AreaRug
          position={[12.0, 0.105, 5.7]}
          width={3.2}
          depth={3.2}
          color="#d8dfd5"
          borderColor="#b5c4b1"
        />
        <CoffeeTable
          position={[12.0, 0, 5.7]}
          rotationY={Math.PI / 2}
        />
        <ArmChair
          position={[...TEAM_WORKSPACE_LOUNGES.eastChairs[0].position]}
          rotationY={Math.PI / 2}
          color="#cf8e59"
        />
        <ArmChair
          position={[...TEAM_WORKSPACE_LOUNGES.eastChairs[1].position]}
          rotationY={-Math.PI / 2}
          color="#527874"
        />
        <Plant position={[12.0, 0, 3.8]} scale={0.95} />
        {/* Floor stand lamp in the east breakout lounge */}
        <StandLampFixture position={[10.0, 0, 8.2]} lightColor="#ffbe76" />
      </group>

      {/* Open Lounge & Pantry on the stair side (East wing, x ~ 14.2, z ~ -0.9) - Terbuka tanpa sekat dinding tertutup */}
      <group position={relocateRoomPoint("lounge", [BARTENDER_BAR_BLUEPRINT.loungeOrigin[0], 0, BARTENDER_BAR_BLUEPRINT.loungeOrigin[1]])}>
        <FloorFinish size={lounge.size} material="tile" border />

        <SceneLabel position={[0, 2.9, -lounge.size[1] / 2 + 0.6]} center style={{ display: floorVisible ? "block" : "none" }}>
          <div className="room-label">Open Lounge & Pantry</div>
        </SceneLabel>

        {/* ============================================================ */}
        {/* 1. Bartender & Beverage Bar (Di alcove bawah tangga / bawah bordes tengah) */}
        {/* ============================================================ */}
        <BartenderBar />

        {/* ============================================================ */}
        {/* 2. Cozy Reading & Tea Lounge Seating Zone                    */}
        {/* Sofa nyaman dan armchairs untuk membawa makanan/minum atau membaca */}
        {/* ============================================================ */}
        <group position={[...LOUNGE_FURNITURE_BLUEPRINT.readingOrigin]}>
          <AreaRug position={[0, 0.105, 0]} width={4.6} depth={3.8} color="#cbbfac" borderColor="#a99983" />
          <PendantLight position={[0, 2.85, 0]} drop={0.65} />
          {/* Decorative standing floor lamp beside the sofa */}
          <StandLampFixture position={[-1.8, 0, 1.4]} />
          {/* Sofa utama menghadap ke arah bar & area sirkulasi */}
          <Sofa
            position={[...LOUNGE_FURNITURE_BLUEPRINT.sofa.position]}
            rotationY={Math.PI / 2}
            color="#8fa394"
          />
          {/* Armchairs santai menghadap meja kopi */}
          <ArmChair
            position={[...LOUNGE_FURNITURE_BLUEPRINT.armchairs[0].position]}
            rotationY={-Math.PI / 2}
            color="#d6a766"
          />
          <ArmChair
            position={[...LOUNGE_FURNITURE_BLUEPRINT.armchairs[1].position]}
            rotationY={-Math.PI / 2}
            color="#c6b9a8"
          />
          {/* Shift the table toward the armchairs, leaving knee clearance in front of the sofa. */}
          <CoffeeTable position={[0.35, 0, -2.0]} />
        </group>

        {/* ============================================================ */}
        {/* 3. Casual High-top Dining / Work Table                       */}
        {/* ============================================================ */}
        <mesh castShadow position={[...LOUNGE_FURNITURE_BLUEPRINT.diningTable]}>
          <boxGeometry args={[4.2, 1.04, 1.4]} />
          <meshStandardMaterial color="#bda588" roughness={0.75} />
        </mesh>
        {/* Suspended Modern Linear Brass Pendant Light over High-top Table */}
        <DiningLinearPendant position={[LOUNGE_FURNITURE_BLUEPRINT.diningTable[0], 2.85, LOUNGE_FURNITURE_BLUEPRINT.diningTable[2]]} length={3.8} />

        <ArmChair position={[...LOUNGE_FURNITURE_BLUEPRINT.diningChairs[0]]} rotationY={Math.PI} color="#8fa394" />
        <ArmChair position={[...LOUNGE_FURNITURE_BLUEPRINT.diningChairs[1]]} rotationY={Math.PI} color="#8fa394" />
        <ArmChair position={[...LOUNGE_FURNITURE_BLUEPRINT.diningChairs[2]]} rotationY={Math.PI} color="#8fa394" />

        {/* Atmospheric Wall Sconces & Modern Art on West Partition */}
        <WallSconceFixture position={[-lounge.size[0] / 2 + 0.08, 1.8, -3.8]} rotation={[0, Math.PI / 2, 0]} />
        <WallSconceFixture position={[-lounge.size[0] / 2 + 0.08, 1.8, 3.8]} rotation={[0, Math.PI / 2, 0]} />
        <ArchitecturalGalleryCanvas
          position={[-lounge.size[0] / 2 + 0.08, 1.6, 6.8]}
          rotationY={Math.PI / 2}
          width={2.2}
          height={1.2}
          artTone="warm-amber"
        />

        {/* Warm Ambient Stand Lamps in the lounge corners */}
        <StandLampFixture position={[-5.8, 0, 7.9]} />
        <StandLampFixture position={[...LOUNGE_FURNITURE_BLUEPRINT.diningCornerLamp]} />
      </group>

      <FloorFinish size={[46, 2.8]} position={[2, 0.06, 10]} material="stone" thickness={0.025} />

      {/* Continuous South Wall Suite: Library -> Operations -> Source Control -> QA -> Entertainment */}
      {/* 1. Library / Skills: three searchable bookcases, a research terminal, and a quiet reading lounge. */}
      <RoomShell
        roomId="library"
        label="Library / Skills"
        position={library.center}
        size={library.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        {LIBRARY_BLUEPRINT.shelves.map((shelf, index) => (
          <Bookshelf key={`shelf-${index}`}
            position={[shelf.position[0], shelf.position[1], shelf.position[2]]}
            rotationY={shelf.rotationY}
            width={shelf.width}
            height={2.35}
          />
        ))}
        <LaptopDesk position={[LIBRARY_BLUEPRINT.deskPosition[0], LIBRARY_BLUEPRINT.deskPosition[1], LIBRARY_BLUEPRINT.deskPosition[2]]}
          screenData={screenForLocation(floorState, "floor-1.library.laptop")} />
        <AreaRug position={[LIBRARY_BLUEPRINT.rugPosition[0], LIBRARY_BLUEPRINT.rugPosition[1], LIBRARY_BLUEPRINT.rugPosition[2]]}
          width={4.4} depth={3.0} color="#b9b9a8" borderColor="#837d70" />
        <Sofa position={[LIBRARY_BLUEPRINT.sofaPosition[0], LIBRARY_BLUEPRINT.sofaPosition[1], LIBRARY_BLUEPRINT.sofaPosition[2]]}
          rotationY={LIBRARY_BLUEPRINT.sofaRotationY} color="#728b82" />
        <CoffeeTable position={[LIBRARY_BLUEPRINT.coffeeTablePosition[0], LIBRARY_BLUEPRINT.coffeeTablePosition[1], LIBRARY_BLUEPRINT.coffeeTablePosition[2]]} />
        <Plant position={[LIBRARY_BLUEPRINT.plantPosition[0], LIBRARY_BLUEPRINT.plantPosition[1], LIBRARY_BLUEPRINT.plantPosition[2]]} scale={0.82} />
        <StandLampFixture position={[LIBRARY_BLUEPRINT.lampPosition[0], LIBRARY_BLUEPRINT.lampPosition[1], LIBRARY_BLUEPRINT.lampPosition[2]]} />
        <PendantLight position={[1.15, 2.72, 1.75]} drop={0.62} color="#c7ab82" />
        <WallArt position={[library.size[0] / 2 - 0.07, 1.55, -2.75]} rotationY={-Math.PI / 2}
          width={1.15} height={0.78} frameColor="#655e53" groundColor="#e7e2d6" accentColor="#607d73" />
      </RoomShell>

      {/* 2. Operations / Server: raised access floor, rack aisle, cooling, and live status board. */}
      <RoomShell
        roomId="operations"
        label="Operations / Server"
        position={operations.center}
        size={operations.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        wallColor="#e3e8e7"
        floorFinish="raised"
      >
        <WallSconceFixture position={[-operations.size[0] / 2 + 0.08, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} lightColor="#a7e4ed" />
        {SERVER_ROOM_BLUEPRINT.rackPositions.map((position, index) => (
          <ServerRack
            key={`operations-rack-${index + 1}`}
            position={[position[0], position[1], position[2]]}
            rotationY={SERVER_ROOM_BLUEPRINT.rackRotationY}
          />
        ))}
        <DualMonitorDesk
          position={[SERVER_ROOM_BLUEPRINT.deskPosition[0], SERVER_ROOM_BLUEPRINT.deskPosition[1], SERVER_ROOM_BLUEPRINT.deskPosition[2]]}
          deskColor="#52636a"
          screenData={screenForLocation(floorState, "floor-1.operations")}
        />
        <ServerRoomServiceDetails data={screenForLocation(floorState, "floor-1.operations")} />
        {/* Desk lamp on the operations console */}
        <DeskLampFixture
          position={[SERVER_ROOM_BLUEPRINT.deskPosition[0] - 0.55, 0.74, SERVER_ROOM_BLUEPRINT.deskPosition[2] + 0.15]}
          lightColor="#a7e4ed"
        />
      </RoomShell>

      {/* 3. Source Control Lab (x = -0.8, w = 7.6, range: -4.6 to 3.0 - dempet dinding dengan Operations) */}
      <RoomShell
        roomId="source-control"
        label="Source Control Lab"
        position={sourceControl.center}
        size={sourceControl.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        floorFinish="carpet"
      >
        <DualMonitorDesk
          position={[-1.7, 0, 0.2]}
          screenData={screenForLocation(
            floorState,
            "floor-1.source-control.commit"
          )}
        />
        <LaptopDesk position={[1.65, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-1.source-control.laptop")} />
        <WallDisplay
          position={[0, 1.72, sourceControl.size[1] / 2 - 0.08]}
          rotationY={Math.PI}
          width={2.3}
          height={1.2}
          data={missionControlScreen(floorState)}
        />
        <Whiteboard
          position={[-2.2, 1.75, -sourceControl.size[1] / 2 + 0.08]}
          width={2.0}
        />
        <WallArt position={[2.0, 1.75, -sourceControl.size[1] / 2 + 0.08]} width={0.95} height={0.75} />
        {/* Source Control lighting: desk lamps + wall sconce */}
        <DeskLampFixture position={[-1.7 - 0.55, 0.74, 0.35]} />
        <DeskLampFixture position={[1.65 - 0.45, 0.74, 0.35]} />
        <WallSconceFixture position={[-sourceControl.size[0] / 2 + 0.08, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} />
      </RoomShell>

      {/* 4. QA / Test Lab (x = 6.8, w = 7.6, range: 3.0 to 10.6 - dempet dinding dengan Source Control) */}
      <RoomShell
        roomId="qa"
        label="QA / Test Lab"
        position={qa.center}
        size={qa.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <DualMonitorDesk
          position={[-1.7, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-1.qa.station-1")}
        />
        <DualMonitorDesk
          position={[1.5, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-1.qa.station-2")}
        />
        <WallDisplay
          position={[0, 1.7, qa.size[1] / 2 - 0.08]}
          rotationY={Math.PI}
          width={2.25}
          height={1.15}
          data={missionControlScreen(floorState)}
        />
        <StorageCabinet
          position={[-2.8, 0, -2.4]}
          width={1.6}
        />
        {/* QA Lab lighting: desk lamps + stand lamp near storage */}
        <DeskLampFixture position={[-1.7 - 0.55, 0.74, 0.35]} />
        <DeskLampFixture position={[1.5 + 0.55, 0.74, 0.35]} />
        <StandLampFixture position={[-2.8, 0, -1.0]} />
      </RoomShell>

      {/* 5. Entertainment (x = 15.0, w = 8.8, range: 10.6 to 19.4 - dempet dinding dengan QA Lab) */}
      <RoomShell
        roomId="entertainment"
        label="Entertainment"
        position={entertainment.center}
        size={entertainment.size}
        entrySide="back"
        doorWidth={1.6}
        glassEntry={false}
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <EntertainmentSuite />
        <CornerLampFixture position={[-3.6, 0, -2.6]} />
      </RoomShell>
    </group>
  );
}

/**
 * Ceiling-mounted architectural lighting grid for Large Team Workspace.
 * Ruang kerja engineering/large team: ruangan paling luas dan paling banyak lampu,
 * memberikan pencahayaan task komersial ber-CRI tinggi yang merata dan sedikit lebih terang.
 */
function TeamWorkspaceCeilingLights() {
  const { state } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  // Large team workspace memiliki illuminance sedikit lebih tinggi untuk produktivitas engineering
  const emissiveIntensity = interiorFactor === 0 ? 0 : 0.5 + interiorFactor * 4.5;

  // Grid 25 flush troffers (5 columns × 5 rows).
  const xCols = [-12.8, -6.4, 0.0, 6.4, 12.8];
  const zRows = [-7.4, -3.7, 0.0, 3.7, 7.4];
  const troffers: [number, number, number][] = [];
  for (const x of xCols) {
    for (const z of zRows) {
      troffers.push([x, F1_CEILING_MOUNTS.troffer.anchorY, z]);
    }
  }
  // All troffers contribute to cached fixture lighting, with a bounded live beam pool.

  // 4 Armature Halo Akustik melingkar khusus tepat di atas titik tengah masing-masing 4 Pod
  const podHaloPositions: [number, number, number][] = TEAM_POD_LAYOUT.map((pod) =>
    [pod.position[0], 2.82, pod.position[1]]);

  // Perimeter wall task downlights (west wall display, east whiteboard, east bookshelf)
  const wallTaskLights: [number, number, number][] = [
    [-15.85, F1_CEILING_Y - 0.03, -4.3], // West Wall Display task wash
    [15.85, F1_CEILING_Y - 0.03, -6.6],   // East Whiteboard task wash
    [15.85, F1_CEILING_Y - 0.03, 4.5]     // East Bookshelf task wash
  ];

  return (
    <group>
      {/* 1. Main grid: LED troffer housings flush against the ceiling. */}
      {troffers.map(([tx, ty, tz], i) => (
        <group key={`troffer-${i}`} position={[tx, ty, tz]}>
          {/* Sasis atas & tulang punggung aluminium hitam */}
          <mesh name="structural-troffer-housing" position={[0, 0.025, 0]} castShadow>
            <boxGeometry args={[2.7, 0.03, 0.5]} />
            <meshStandardMaterial color="#1e293b" metalness={0.8} roughness={0.3} />
          </mesh>

          {/* Luminous diffuser akrilik berpendar terang (tampak jelas dari atas & sudut isometrik) */}
          <mesh position={[0, 0.01, 0]} userData={{ officeMaterialDynamic: "team-troffer:interior:(0|0.5+factor*4.5)*1.35" }}>
            <boxGeometry args={[2.62, 0.045, 0.48]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#fffef5"
              emissiveIntensity={emissiveIntensity * 1.35}
              roughness={0.1}
              toneMapped={false}
            />
          </mesh>

          <FixtureSpotLight name="team-workspace-troffer" position={[0, -0.025, 0]}
            aim={[0, -F1_CEILING_MOUNTS.troffer.anchorY, 0]}
            intensity={interiorFactor * raisedDownlightIntensity(70, 2.825, F1_CEILING_MOUNTS.troffer.sourceY, 0, 8)}
            color="#fff1df" distance={raisedDownlightRange(8, 2.825, F1_CEILING_MOUNTS.troffer.sourceY)}
            angle={raisedDownlightAngle(1.1, 2.825, F1_CEILING_MOUNTS.troffer.sourceY)} />
        </group>
      ))}

      {/* 2. 4 Armature Halo Akustik Melingkar tepat di atas masing-masing Pod */}
      {podHaloPositions.map(([hx, hy, hz], pi) => (
        <group key={`pod-halo-${pi}`} position={[hx, hy, hz]}>
          {/* Batang suspensi 3 titik yang terlihat jelas */}
          {[0, (2 * Math.PI) / 3, (4 * Math.PI) / 3].map((angle, wi) => (
            <group key={wi}>
              <mesh
                position={[Math.cos(angle) * 1.15, (F1_CEILING_Y - hy) / 2, Math.sin(angle) * 1.15]}
              >
                <cylinderGeometry args={[0.012, 0.012, F1_CEILING_Y - hy, 8]} />
                <meshStandardMaterial color="#0f172a" metalness={0.9} />
              </mesh>
              <mesh name="structural-pod-halo-canopy"
                position={[Math.cos(angle) * 1.15, F1_CEILING_Y - hy - 0.02, Math.sin(angle) * 1.15]}
              >
                <cylinderGeometry args={[0.02, 0.02, 0.04, 12]} />
                <meshStandardMaterial color="#cfa45d" metalness={0.9} roughness={0.2} />
              </mesh>
            </group>
          ))}

          {/* Ring sasis akustik abu-abu gelap */}
          <mesh rotation={[Math.PI / 2, 0, 0]}>
            <torusGeometry args={[1.25, 0.04, 16, 32]} />
            <meshStandardMaterial color="#334155" roughness={0.7} />
          </mesh>

          {/* Ring LED berpendar putih hangat lembut */}
          <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, -0.01, 0]} userData={{ officeMaterialDynamic: "team-pod-halo:interior:(0|0.5+factor*4.5)*1.3" }}>
            <torusGeometry args={[1.18, 0.028, 16, 32]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#fff7e6"
              emissiveIntensity={emissiveIntensity * 1.3}
              toneMapped={false}
            />
          </mesh>

        </group>
      ))}

      {/* 3. Perimeter Task Wall Washers */}
      {wallTaskLights.map(([wx, wy, wz], wi) => (
        <group key={`wall-task-${wi}`} position={[wx, wy, wz]}>
          <mesh name="structural-wall-washer" position={[0, 0, 0]}>
            <boxGeometry args={[0.5, 0.06, 0.16]} />
            <meshStandardMaterial color="#0f172a" metalness={0.8} />
          </mesh>
          <mesh position={[0, -0.025, 0]} userData={{ officeMaterialDynamic: "team-wall-task:interior:(0|0.5+factor*4.5)*1.1" }}>
            <boxGeometry args={[0.44, 0.025, 0.12]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#ffedd5"
              emissiveIntensity={emissiveIntensity * 1.1}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}

    </group>
  );
}

/** Grand Lobby & Arrival Hall Ceiling Lighting with Monumental Halo Chandelier and architectural downlights. */
function LobbyCeilingLights() {
  const { state } = useSolarEnvironment();
  const interiorFactor = state.factors.interiorLightFactor;
  const emissiveIntensity = interiorFactor === 0 ? 0 : 0.5 + interiorFactor * 4.3;

  const downlightXs = [-12.5, -9.5, -6.5, -3.5, 3.5, 6.5, 9.5, 12.5];

  return (
    <group>
      {/* Central Monumental Grand Halo Chandelier in Grand Arrival Hall */}
      <GrandHaloChandelier position={[0, F1_CEILING_Y, 0]} outerRadius={1.8} innerRadius={1.15} drop={F1_CEILING_Y - 2.7} />

      {/* Recessed Architectural Downlight Grid spanning the entire 30m lobby */}
      {downlightXs.map((lx) => (
        <group key={`lobby-downlight-${lx}`} position={[lx, F1_CEILING_MOUNTS.lobby.anchorY, 0]}>
          <mesh name="structural-lobby-housing" position={[0, 0.02, 0]}>
            <cylinderGeometry args={[0.22, 0.22, 0.04, 16]} />
            <meshStandardMaterial color="#0f172a" metalness={0.8} />
          </mesh>
          <FixtureSpotLight name="lobby-ceiling-downlight" position={[0, -0.025, 0]}
            aim={[0, -F1_CEILING_MOUNTS.lobby.anchorY, 0]}
            intensity={interiorFactor * raisedDownlightIntensity(24, 2.825, F1_CEILING_MOUNTS.lobby.sourceY, 0, 6)}
            color="#fff1df" distance={raisedDownlightRange(6, 2.825, F1_CEILING_MOUNTS.lobby.sourceY)}
            angle={raisedDownlightAngle(1.1, 2.825, F1_CEILING_MOUNTS.lobby.sourceY)} />
          <mesh position={[0, -0.002, 0]} rotation={[-Math.PI / 2, 0, 0]}
            userData={{ officeMaterialDynamic: "lobby-downlight:interior:(0|0.5+factor*4.3)" }}>
            <circleGeometry args={[0.18, 16]} />
            <meshStandardMaterial
              color="#ffffff"
              emissive="#ffdfb8"
              emissiveIntensity={emissiveIntensity}
              toneMapped={false}
            />
          </mesh>
        </group>
      ))}
    </group>
  );
}
