import { OFFICE_STAIR_LAYOUT, OFFICE_STAIRCASE } from "../../../layout";
import { FloorFinish } from "../finishes/FloorFinish";
import { LandingRail } from "../../../prefabs/architecture/Staircase";

/** Identical upper-floor slab cut-out, arrival bridge and glass edge protection. */
export function StairwellFloorPlate({ topFloor = false }: { topFloor?: boolean }) {
  const s = OFFICE_STAIR_LAYOUT;
  const westWidth = s.westEdge - s.floorWestEdge;
  const westX = (s.floorWestEdge + s.westEdge) / 2;
  const bayWidth = s.eastEdge - s.westEdge;
  const bayX = (s.westEdge + s.eastEdge) / 2;
  const southDepth = s.floorSouthEdge - s.voidSouthZ;
  const southZ = (s.floorSouthEdge + s.voidSouthZ) / 2;
  const bridgeWidth = s.eastEdge - s.bridgeWestEdge;
  const bridgeX = (s.eastEdge + s.bridgeWestEdge) / 2;
  const bridgeDepth = s.bridgeSouthZ - s.bridgeNorthZ;
  const bridgeZ = (s.bridgeNorthZ + s.bridgeSouthZ) / 2;
  const voidDepth = s.voidSouthZ - s.bridgeSouthZ;
  const voidZ = (s.voidSouthZ + s.bridgeSouthZ) / 2;

  const westGuard = s.westEdge + s.guardInset;
  const eastGuard = s.eastEdge - s.guardInset;
  const innerWest = OFFICE_STAIRCASE.x - OFFICE_STAIRCASE.gap / 2;
  const innerEast = OFFICE_STAIRCASE.x + OFFICE_STAIRCASE.gap / 2;
  const closureWest = topFloor ? westGuard : innerWest;

  return (
    <group name="office-stairwell-floor-plate">
      <group position={[0, -0.16, 0]}>
        <mesh receiveShadow position={[westX, 0, 0]}>
          <boxGeometry args={[westWidth, 0.32, s.floorSouthEdge - s.floorNorthEdge]} />
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </mesh>
        <mesh receiveShadow position={[bayX, 0, southZ]}>
          <boxGeometry args={[bayWidth, 0.32, southDepth]} />
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </mesh>
        <mesh receiveShadow position={[bridgeX, 0, bridgeZ]}>
          <boxGeometry args={[bridgeWidth, 0.32, bridgeDepth]} />
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </mesh>
      </group>
      <FloorFinish size={[westWidth - 0.35, s.floorSouthEdge - s.floorNorthEdge - 0.7]} position={[westX + 0.175, 0, 0]} material="stone" thickness={0.06} />
      <FloorFinish size={[bayWidth, southDepth]} position={[bayX, 0, southZ]} material="stone" thickness={0.06} />
      <FloorFinish size={[bridgeWidth, bridgeDepth]} position={[bridgeX, 0, bridgeZ]} material="stone" thickness={0.06} />

      {/* Seal the unused lower-flight opening on F3; only the descending flight remains open. */}
      <LandingRail position={[(closureWest + innerEast) / 2, 0, s.bridgeSouthZ]}
        length={innerEast - closureWest} />
      {/* The entire north bridge is open to the west corridor for two-way flow. */}
      <LandingRail position={[westGuard, 0, voidZ]} length={voidDepth} rotationY={Math.PI / 2} />
      <LandingRail position={[bayX, 0, s.voidSouthZ]} length={eastGuard - westGuard} />
      <LandingRail position={[eastGuard, 0, voidZ]} length={voidDepth} rotationY={Math.PI / 2} />
      <LandingRail position={[bridgeX, 0, s.bridgeNorthZ]} length={bridgeWidth} />
      <LandingRail position={[eastGuard, 0, bridgeZ]} length={bridgeDepth} rotationY={Math.PI / 2} />
    </group>
  );
}
