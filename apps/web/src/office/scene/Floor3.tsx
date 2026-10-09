import { roomById } from "./interior/worldRegistry";
import { F3_LAYOUT } from "./interior/floor1Layout";
import { SceneLabel } from "./interior/SceneLabel";
import { useFurnishedFloorState } from "./interior/FurnishedFloorContext";
import { screenForLocation } from "./interior/screenData";
import { useFloorVisible } from "./interior/FloorVisibilityContext";
import { RoomShell } from "./interior/RoomShell";
import { FloorFinish } from "./interior/prefabs/finishes/FloorFinish";
import {
  AllInOneDesk,
  LaptopDesk
} from "./interior/prefabs/workstations/SingleWorkstation";
import { ExecutiveRoomInterior } from "./interior/prefabs/interiors/ExecutiveRoomInterior";
import { EXECUTIVE_STUDIO_BLUEPRINT } from "./interior/spatialBlueprints";
import { WallDisplay } from "./interior/prefabs/props/WallDisplay";
import { Whiteboard } from "./interior/prefabs/props/Whiteboard";
import { Plant } from "./interior/prefabs/props/Plant";
import { AreaRug, PendantLight, WallArt } from "./interior/prefabs/props/OfficeDecor";
import { WallSconceFixture, StandLampFixture, DeskLampFixture } from "./interior/prefabs/architecture/LightFixtureGeometries";
import { Bookshelf, CoffeeTable, DisplayCabinet } from "./interior/prefabs/furniture/TablesAndStorage";
import { ArmChair, Sofa } from "./interior/prefabs/furniture/Sofa";
import { DumbbellRack, ExerciseBike, FitnessStorage, StrengthSeat, Treadmill, YogaMat } from "./interior/prefabs/furniture/GymEquipment";
import { FITNESS_BLUEPRINT } from "./interior/spatialBlueprints";
import { StairwellFloorPlate } from "./interior/prefabs/architecture/StairwellFloorPlate";
import { CirculationLighting } from "./interior/prefabs/architecture/CirculationLighting";
import { StairLandingDecor } from "./interior/prefabs/architecture/StairLandingDecor";
import { RooftopTerrace } from "./interior/prefabs/architecture/RooftopTerrace";

const engineBayXs = [-4.8, -1.8, 1.8, 4.8];
const engineBayZs = [-1.35, 1.25];

/** Intelligence floor: north and south rooms open onto two clear cross-floor corridors. */
export function Floor3() {
  const floorState = useFurnishedFloorState();
  const floorVisible = useFloorVisible();
  const roomSize = (id: string): [number, number] => {
    const room = roomById(id);
    if (!room) throw new Error(`Missing F3 room: ${id}`);
    return room.size;
  };
  const northCorridorDepth = F3_LAYOUT.sanctuary.north - F3_LAYOUT["multi-engine"].south;
  const southCorridorDepth = F3_LAYOUT["executive-studio"].north - F3_LAYOUT.flex.south;

  return (
    <group>
      <CirculationLighting floor={3} />
      <StairLandingDecor floor={3} />
      <StairwellFloorPlate topFloor />

      <SceneLabel position={[-17.5, 0.3, -11.7]} center={false} style={{ display: floorVisible ? "block" : "none" }}>
        <div className="floor-label">
          <strong>F3</strong>
          <span>Intelligence &amp; Multi-Engine</span>
        </div>
      </SceneLabel>

      {/* Rooftop Lounge: North-West room (formerly Executive Studio), x in [-19.0, -8.5], width 10.5 */}
      <RoomShell
        roomId="sky-lounge"
        label="Sky Lounge / Rooftop"
        position={[-13.75, 0, -9.0]}
        size={roomSize("sky-lounge")} 
        doorWidth={1.6}
        entrySide="front"
        glassEntry
        oppositeWall="windows"
        floorFinish="tile"
      >
        <AreaRug position={[0, 0.015, -0.6]} width={7.2} depth={4.4} color="#cbd5cb" borderColor="#869588" />
        <Sofa position={[-1.75, 0, -1.0]} rotationY={Math.PI} color="#52655b" />
        <ArmChair position={[1.75, 0, -1.0]} rotationY={Math.PI} color="#857a70" />
        <CoffeeTable position={[0, 0, -0.2]} />
        <PendantLight position={[0, 2.9, -0.2]} drop={0.65} />
        <DisplayCabinet position={[3.8, 0, 0.2]} rotationY={-Math.PI / 2} width={2.2} />
        <StandLampFixture position={[-4.2, 0, -1.8]} />
        <WallSconceFixture position={[-4.8, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} />
        <Plant position={[-4.2, 0, 1.8]} />
        <Plant position={[4.0, 0, -2.0]} />
      </RoomShell>

      {/* Multi-Engine Lab: x in [-8.5, 11.0], width 19.5 - rapat dinding dengan the executive studio, menyisakan koridor tangga selebar 3.6m di sisi timur */}
      <RoomShell
        roomId="multi-engine"
        label="Multi-Engine Lab"
        position={[1.25, 0, -9]}
        size={roomSize("multi-engine")} 
        doorWidth={1.6}
        entrySide="front"
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <StandLampFixture position={[-8.8, 0, -2.2]} />
        <StandLampFixture position={[8.8, 0, -2.2]} />
        <WallSconceFixture position={[-4.0, 1.8, -3.0]} />
        <WallSconceFixture position={[4.0, 1.8, -3.0]} />
        <WallDisplay
          position={[0, 1.85, -3.03]}
          width={4.2}
          height={1.35}
          data={{
            title: "MULTI-ENGINE LAB",
            subtitle: "Flexible specialist bays"
          }}
        />
        {engineBayZs.flatMap((z, row) =>
          engineBayXs.map((x, column) => (
            <AllInOneDesk
              key={`engine-${row}-${column}`}
              position={[x, 0, z]}
              screenData={screenForLocation(
                floorState,
                `floor-3.multi-engine.station-${row * 4 + column + 1}`
              )}
            />
          ))
        )}
        <Plant position={[-8.5, 0, 1.9]} />
        <Plant position={[8.5, 0, 1.9]} />
      </RoomShell>

      <FloorFinish size={[39.6, northCorridorDepth]} position={[-1.2, 0.06, (F3_LAYOUT.sanctuary.north + F3_LAYOUT["multi-engine"].south) / 2]} material="stone" thickness={0.025} />
      <SceneLabel position={[-1.1, 0.12, (F3_LAYOUT.sanctuary.north + F3_LAYOUT["multi-engine"].south) / 2]} center style={{ display: floorVisible ? "block" : "none" }}>
        <div className="corridor-label">Studio / Lab Corridor</div>
      </SceneLabel>

      {/* Knowledge Sanctuary: x in [-19.0, -9.0], width 10.0 */}
      <RoomShell
        roomId="sanctuary"
        label="Knowledge Sanctuary"
        position={[-14.0, 0, -0.8]}
        size={roomSize("sanctuary")} 
        doorWidth={1.6}
        entrySide="back"
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <Bookshelf position={[-4.25, 0, -1.7]} rotationY={Math.PI / 2} width={2.5} />
        <Bookshelf position={[-4.25, 0, 1.45]} rotationY={Math.PI / 2} width={2.5} />
        <WallDisplay
          position={[0, 1.8, 4.42]}
          rotationY={Math.PI}
          width={2.8}
          height={1.15}
          data={{ title: "KNOWLEDGE", subtitle: "Shared knowledge" }}
        />
        {[-2.5, 0, 2.5].map((x, index) => (
          <AllInOneDesk
            key={x}
            position={[x, 0, 0.35]}
            screenData={screenForLocation(floorState, `floor-3.knowledge.terminal-${index + 1}`)}
          />
        ))}
        {/* Knowledge Sanctuary lighting: desk lamps on terminals + wall sconce near bookshelves */}
        <DeskLampFixture position={[-2.5 - 0.45, 0.74, 0.5]} />
        <DeskLampFixture position={[0 - 0.45, 0.74, 0.5]} />
        <DeskLampFixture position={[2.5 - 0.45, 0.74, 0.5]} />
        <WallSconceFixture position={[-4.25 + 0.08, 1.8, 0]} rotation={[0, Math.PI / 2, 0]} />
      </RoomShell>

      {/* General / Flex Work: x in [-9.0, 1.0], width 10.0 - rapat dinding dengan Sanctuary */}
      <RoomShell
        roomId="flex"
        label="General / Flex Work"
        position={[-4.0, 0, -0.8]}
        size={roomSize("flex")} 
        doorWidth={1.6}
        entrySide="back"
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        {[-2.2, 2.2].flatMap((x, column) =>
          [-1.5, 1.25].map((z, row) => (
            <AllInOneDesk
              key={`flex-${column}-${row}`}
              position={[x, 0, z]}
              screenData={screenForLocation(floorState, `floor-3.flex.station-${column * 2 + row + 1}`)}
            />
          ))
        )}
        <WallArt position={[0, 1.75, 4.92]} rotationY={Math.PI} width={1.4} height={0.85} accentColor="#718c86" />
        {/* Flex Work lighting: pendant + stand lamp for ambient coverage */}
        <PendantLight position={[0, 2.9, 0]} drop={0.65} />
        <StandLampFixture position={[-4.2, 0, -1.8]} />
      </RoomShell>

      {/* Research Area: x in [-1.0, 11.0], width 12.0 - directly adjoining Flex Work, with the east circulation bay clear */}
      <RoomShell
        roomId="research"
        label="Research Area"
        position={[6.0, 0, -0.8]}
        size={roomSize("research")} 
        doorWidth={1.6}
        entrySide="back"
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <Bookshelf position={[-4.1, 0, 1.55]} rotationY={Math.PI / 2} width={2.55} />
        <Bookshelf position={[4.1, 0, 1.55]} rotationY={-Math.PI / 2} width={2.55} />
        <LaptopDesk position={[-2.0, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-3.research.laptop-1")} />
        <LaptopDesk position={[2.0, 0, 0.2]}
          screenData={screenForLocation(floorState, "floor-3.research.laptop-2")} />
        <Whiteboard position={[0, 1.75, 4.92]} rotationY={Math.PI} width={2.65} />
        <Plant position={[4.1, 0, -2.65]} />
        {/* Research lighting: desk lamps + stand lamp by whiteboard */}
        <DeskLampFixture position={[-2.0 - 0.45, 0.74, 0.35]} />
        <DeskLampFixture position={[2.0 + 0.45, 0.74, 0.35]} />
        <StandLampFixture position={[-4.1, 0, -1.5]} />
      </RoomShell>

      <FloorFinish size={[46, southCorridorDepth]} position={[2, 0.06, (F3_LAYOUT.flex.south + F3_LAYOUT["executive-studio"].north) / 2]} material="stone" thickness={0.025} />
      <SceneLabel position={[-1.1, 0.12, (F3_LAYOUT.flex.south + F3_LAYOUT["executive-studio"].north) / 2]} center style={{ display: floorVisible ? "block" : "none" }}>
        <div className="corridor-label">Research / Terrace Corridor</div>
      </SceneLabel>

      {/* Rear offices share the terrace edge; CEO depth is 9.3 m and Fitness remains 7.3 m. */}
      {/* Executive Studio: x in [-21, -3], width 18 m. */}
      <RoomShell
        roomId="executive-studio"
        label="Executive Studio"
        position={[EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[0], 0, EXECUTIVE_STUDIO_BLUEPRINT.roomCenter[1]]}
        size={roomSize("executive-studio")} 
        doorWidth={1.6}
        entrySide="back"
        glassEntry
        oppositeWall="windows"
        floorFinish="oak"
      >
        <ExecutiveRoomInterior
          roomId="executive-studio"
          screens={[
            screenForLocation(floorState, "floor-3.executive-studio"),
            screenForLocation(floorState, "floor-3.executive-studio"),
            screenForLocation(floorState, "floor-3.executive-studio")
          ]}
        />
      </RoomShell>

      {/* Fitness retains its 20 × 7.3 m footprint, with a clear 3.2 m entrance aisle. */}
      <RoomShell
        roomId="fitness"
        label="Fitness / Wellness"
        position={[9.0, 0, 8.45]}
        size={roomSize("fitness")} 
        doorWidth={FITNESS_BLUEPRINT.mainAisleWidth}
        doorType="sliding"
        entrySide="back"
        glassEntry
        oppositeWall="windows"
        floorFinish="carpet"
      >
        <AreaRug position={[-5.6, 0.07, 0]} width={7.6} depth={6.45} color="#3c5352" borderColor="#607d71" />
        <AreaRug position={[5.7, 0.07, 0]} width={7.6} depth={6.45} color="#475b60" borderColor="#819b91" />
        <FloorFinish size={[FITNESS_BLUEPRINT.mainAisleWidth, 7.1]} position={[0, 0.07, 0]} material="stone" thickness={0.02} />
        {FITNESS_BLUEPRINT.treadmills.map(station => <Treadmill key={station.id} resourceId={station.id}
          position={[...station.position]} rotationY={station.rotationY} />)}
        {FITNESS_BLUEPRINT.bikes.map(station => <ExerciseBike key={station.id} resourceId={station.id}
          position={[...station.position]} rotationY={station.rotationY} />)}
        <DumbbellRack resourceId={FITNESS_BLUEPRINT.dumbbellRack.id}
          position={[...FITNESS_BLUEPRINT.dumbbellRack.position]} rotationY={FITNESS_BLUEPRINT.dumbbellRack.rotationY}
          width={FITNESS_BLUEPRINT.dumbbellRack.width} />
        {FITNESS_BLUEPRINT.yogaMats.map(station => <YogaMat key={station.id} resourceId={station.id}
          position={[...station.position]} color={station.color} />)}
        <StrengthSeat resourceId={FITNESS_BLUEPRINT.weightBench.id}
          position={[...FITNESS_BLUEPRINT.weightBench.position]} rotationY={FITNESS_BLUEPRINT.weightBench.rotationY} />
        <StrengthSeat resourceId={FITNESS_BLUEPRINT.cableRow.id} cable
          position={[...FITNESS_BLUEPRINT.cableRow.position]} rotationY={FITNESS_BLUEPRINT.cableRow.rotationY} />
        <AreaRug position={[FITNESS_BLUEPRINT.freeweights.target[0], 0.08, FITNESS_BLUEPRINT.freeweights.target[1]]}
          width={1.1} depth={1.6} color="#789183" borderColor="#bad0be" />
        <FitnessStorage position={[...FITNESS_BLUEPRINT.storagePosition]} />
        <WallDisplay position={[0, 1.8, 3.58]} rotationY={Math.PI} width={2.5} height={0.85}
          data={{ title: "WELLNESS STUDIO", subtitle: "Cardio · Strength · Recovery" }} />
        <PendantLight position={[-5.6, 2.9, 0]} drop={0.65} color="#d8e6dd" />
        <PendantLight position={[5.7, 2.9, 0]} drop={0.65} color="#d8e6dd" />
      </RoomShell>
      <RooftopTerrace />
    </group>
  );
}
