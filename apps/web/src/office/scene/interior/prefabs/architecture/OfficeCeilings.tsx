import { FootprintBox, FootprintPlane } from "../../FootprintPatch";
import { BackSide } from "three";
import { roomsOnFloor, type CampusFloor } from "../../worldRegistry";
import { CIRCULATION_LIGHT_ROWS } from "./CirculationLighting";
import { ceilingYForFloor } from "./ceilingMounting";

export function officeCeilingPatches(floor: CampusFloor) {
  // Open-air campus zones share floor 1 but have no slab or ceiling above them.
  const rooms = roomsOnFloor(floor).filter(room => !room.exterior && room.id !== "staircase" && room.id !== "rooftop-terrace")
    .map(room => ({ id: room.id, center: [room.center[0], room.center[2]] as const, size: room.size }));
  return [...rooms, ...CIRCULATION_LIGHT_ROWS[floor].filter(row => row.ceiling !== false)
    .map(row => ({ id: row.id, center: row.center, size: row.size }))];
}

/** One-sided soffits stay visible from inside; overview naturally cuts away their top faces. */
export function OfficeCeilings({ floor }: { floor: CampusFloor }) {
  const ceilingY = ceilingYForFloor(floor);
  return <group name={`office-ceilings-f${floor}`} userData={{ officeCollision: false, officePassable: true }}>
    {officeCeilingPatches(floor).map(patch => <group key={patch.id} name={`ceiling:${patch.id}`}
      position={[patch.center[0], ceilingY, patch.center[1]]}>
      <FootprintPlane name={`ceiling-soffit:${patch.id}`} size={patch.size} buildingOrigin={patch.center} receiveShadow>
        <meshStandardMaterial color="#e5e2db" roughness={0.95} side={BackSide}
          userData={{ officeCeilingSoffit: true, officeCeilingSampleYOffset: 1.9 - ceilingY }} />
      </FootprintPlane>
      {/* A slim perimeter reveal makes the mounting plane readable in the cutaway. */}
      {[-1, 1].map(side => <FootprintBox key={`x-${side}`} position={[side * (patch.size[0] / 2 - 0.02), 0.03, 0]} size={[0.035, 0.06, patch.size[1]]} buildingOrigin={patch.center}>
        <meshStandardMaterial color="#bfc3bc" roughness={0.8} />
      </FootprintBox>)}
      {[-1, 1].map(side => <FootprintBox key={`z-${side}`} position={[0, 0.03, side * (patch.size[1] / 2 - 0.02)]} size={[patch.size[0], 0.06, 0.035]} buildingOrigin={patch.center}>
        <meshStandardMaterial color="#bfc3bc" roughness={0.8} />
      </FootprintBox>)}
    </group>)}
  </group>;
}
