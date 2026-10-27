import { OFFICE_STAIR_LAYOUT, OFFICE_STAIRCASE } from "../../../layout";
import { FootprintBox } from "../../FootprintPatch";
import { FloorFinish } from "../finishes/FloorFinish";
import { LandingRail } from "../../../prefabs/architecture/Staircase";
import { FLOOR_FINISH_DEPTH, FLOOR_SLAB_CENTER_Y, FLOOR_SLAB_THICKNESS, FLOOR_UNDERLAY_TOP_Y } from "../../floorElevation";

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
      <group position={[0, FLOOR_SLAB_CENTER_Y, 0]}>
        <FootprintBox name="office-floor-slab" profile="lower" receiveShadow position={[westX, 0, 0]} size={[westWidth, FLOOR_SLAB_THICKNESS, s.floorSouthEdge - s.floorNorthEdge]}>
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </FootprintBox>
        <FootprintBox name="office-floor-slab" profile="lower" receiveShadow position={[bayX, 0, southZ]} size={[bayWidth, FLOOR_SLAB_THICKNESS, southDepth]}>
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </FootprintBox>
        <FootprintBox name="office-floor-slab" profile="lower" receiveShadow position={[bridgeX, 0, bridgeZ]} size={[bridgeWidth, FLOOR_SLAB_THICKNESS, bridgeDepth]}>
          <meshStandardMaterial color="#c4cbd0" roughness={0.96} />
        </FootprintBox>
      </group>
      <FloorFinish profile="lower" size={[westWidth - 0.35, s.floorSouthEdge - s.floorNorthEdge - 0.7]} position={[westX + 0.175, FLOOR_UNDERLAY_TOP_Y, 0]} material="stone" thickness={FLOOR_FINISH_DEPTH} />
      <FloorFinish profile="lower" size={[bayWidth, southDepth]} position={[bayX, FLOOR_UNDERLAY_TOP_Y, southZ]} material="stone" thickness={FLOOR_FINISH_DEPTH} />
      <FloorFinish profile="lower" size={[bridgeWidth, bridgeDepth]} position={[bridgeX, 0, bridgeZ]} material="stone" thickness={FLOOR_FINISH_DEPTH} />

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
