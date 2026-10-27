import { MeshStandardMaterial } from "three";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import type { SmartScreenData } from "../../screenData";
import { EXECUTIVE_ROOM_LAYOUTS, type ExecutiveRoomId } from "../../roomRedesignLayout";
import { ExecutiveWorkstation } from "../workstations/ExecutiveWorkstation";
import { ArmChair } from "../furniture/Sofa";
import { ExecutiveSuiteLighting } from "../architecture/ExecutiveSuiteLighting";
import { CornerLampFixture, DeskLampFixture, StandLampFixture } from "../architecture/LightFixtureGeometries";
import { AbstractArtwork, AcousticPanel, InteriorBox, ModernCredenza, ModernStorageWall, SculpturalPlanter, ZonedRug } from "./ContemporaryRoomDetails";

const sofaCushion = new RoundedBoxGeometry(0.75, 0.16, 0.82, 2, 0.06);
const sofaBack = new RoundedBoxGeometry(2.64, 0.52, 0.19, 2, 0.065);
const sofaArm = new RoundedBoxGeometry(0.18, 0.35, 0.95, 2, 0.06);
const upholstery = new MeshStandardMaterial({ color: "#d2c8b8", roughness: 0.96 });

/** The cushion tops and transforms come from the same layout used by seated avatars. */
function ModernExecutiveSofa({ layout }: {
  layout: (typeof EXECUTIVE_ROOM_LAYOUTS)[ExecutiveRoomId]["lounge"]["sofa"];
}) {
  return <group position={[...layout.position]} rotation={[0, layout.rotationY, 0]}
    userData={{ officeSeat: true }} dispose={null}>
    <InteriorBox position={[0, 0.10, 0]} size={[layout.size[0] - 0.16, 0.14, layout.size[1] - 0.17]} finish="dark" />
    <InteriorBox position={[0, 0.21, 0]} size={[layout.size[0] - 0.13, 0.18, layout.size[1] - 0.04]} finish="fabric" />
    {layout.seatXs.map(x => <mesh key={x} geometry={sofaCushion} material={upholstery}
      position={[x, layout.seatHeight - 0.08, layout.seatLocalZ]} />)}
    <mesh geometry={sofaBack} material={upholstery} position={[0, 0.63, -0.35]} />
    {[-1, 1].map(side => <mesh key={side} geometry={sofaArm} material={upholstery}
      position={[side * (layout.size[0] / 2 - 0.09), 0.35, 0]} />)}
    <InteriorBox position={[-0.94, 0.57, -0.19]} size={[0.31, 0.24, 0.13]} finish="olive" />
    <InteriorBox position={[0.94, 0.57, -0.19]} size={[0.31, 0.24, 0.13]} finish="clay" />
  </group>;
}

export function ExecutiveRoomInterior({ roomId, screens }: {
  roomId: ExecutiveRoomId;
  screens: readonly [SmartScreenData, SmartScreenData, SmartScreenData];
}) {
  const layout = EXECUTIVE_ROOM_LAYOUTS[roomId];
  const cool = roomId === "executive-studio";
  const [width, depth] = layout.roomSize;
  const lounge = layout.lounge;
  const coffee = lounge.coffeeTable;

  return <group name={`${roomId}-contemporary-interior`}>
    <ZonedRug {...layout.desk.rug} />
    <ExecutiveWorkstation position={layout.desk.position} rotationY={layout.desk.rotationY}
      leaderSeat={layout.desk.leaderSeat} guestSeats={layout.desk.guestSeats}
      screens={screens} includeCabinet plant={false} leaderResourceId={roomId === "executive" ? "executive.leader" : "executive-studio.ceo"} />

    <group position={[...lounge.position]} userData={{ officeSeatStation: true }}>
      <ZonedRug {...lounge.rug} cool={cool} />
      <ModernExecutiveSofa layout={lounge.sofa} />
      {lounge.armchairs.map(chair => <ArmChair key={chair.id} position={[...chair.position]}
        rotationY={chair.rotationY} color={cool ? "#aab9b5" : "#b8b09f"} />)}
      <group position={[...coffee.position]}>
        <InteriorBox position={[0, 0.18, 0]} size={[coffee.size[0] * 0.62, 0.36, coffee.size[1] * 0.63]} finish="walnut" />
        <InteriorBox position={[0, 0.38, 0]} size={[coffee.size[0], 0.065, coffee.size[1]]} finish="stone" />
        <InteriorBox position={[0, 0.34, 0]} size={[coffee.size[0] - 0.08, 0.015, coffee.size[1] - 0.08]} finish="brass" />
        <InteriorBox position={[-0.22, 0.43, 0]} size={[0.34, 0.025, 0.24]} finish="ink" />
      </group>
    </group>

    <ModernCredenza position={layout.credenza.position} rotationY={layout.credenza.rotationY}
      width={layout.credenza.size[0]} depth={layout.credenza.size[1]} />
    <ModernStorageWall position={layout.storage.position} rotationY={layout.storage.rotationY}
      width={layout.storage.size[0]} depth={layout.storage.size[1]} />
    {layout.plants.map((position, i) => <SculpturalPlanter key={i} position={position} />)}

    {/* Both walls frame the zones; the central doorway/arrival lane remains open. */}
    <AcousticPanel position={[-width / 2 + 0.17, 1.43, 0]} rotationY={Math.PI / 2} width={6.5} />
    <AcousticPanel position={[width / 2 - 0.15, 1.43, -2.6]} rotationY={-Math.PI / 2} width={2.7} />
    <AbstractArtwork position={[width / 2 - 0.24, 1.84, -2.6]} rotationY={-Math.PI / 2} width={2.05} cool={cool} />
    <AbstractArtwork position={[layout.credenza.position[0], 1.78, -depth / 2 + 0.14]} width={2.45} cool={cool} />

    <DeskLampFixture position={[...layout.fixtures.deskLamp]} />
    <CornerLampFixture position={[...layout.fixtures.cornerLamp]} />
    <StandLampFixture position={[...layout.fixtures.standLamp]} />
    <ExecutiveSuiteLighting size={layout.roomSize} deskLocal={layout.desk.position} loungeLocal={lounge.position} />
  </group>;
}
