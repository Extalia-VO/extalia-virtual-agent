import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";
import { ARMCHAIR_SEAT_BLUEPRINT, SOFA_SEAT_BLUEPRINT } from "../../furnitureSeatBlueprint";

/** Shared, low-detail upholstery geometry keeps repeated lounge furniture inexpensive. */
const sofaBase = new RoundedBoxGeometry(2.08, 0.2, 0.83, 2, 0.07);
const sofaSeat = new RoundedBoxGeometry(...SOFA_SEAT_BLUEPRINT.cushionSize, 3, 0.1);
const sofaBack = new RoundedBoxGeometry(2.06, 0.68, 0.2, 3, 0.095);
const sofaBackCushion = new RoundedBoxGeometry(0.91, 0.46, 0.19, 3, 0.085);
const sofaArm = new RoundedBoxGeometry(0.2, 0.43, 0.84, 3, 0.095);

const chairBase = new RoundedBoxGeometry(0.84, 0.21, 0.82, 2, 0.07);
const chairSeat = new RoundedBoxGeometry(...ARMCHAIR_SEAT_BLUEPRINT.cushionSize, 3, 0.1);
const chairBack = new RoundedBoxGeometry(0.8, 0.7, 0.19, 3, 0.09);
const chairBackCushion = new RoundedBoxGeometry(0.64, 0.45, 0.17, 3, 0.08);
const chairArm = new RoundedBoxGeometry(0.14, 0.39, 0.76, 3, 0.065);

/** Both seats face local +Z; the backrest is at local -Z. */
export function Sofa({
  position = [0, 0, 0],
  rotationY = 0,
  color = "#b9b6a8"
}: {
  position?: [number, number, number];
  rotationY?: number;
  color?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} dispose={null} userData={{ officeSeat: true }}>
      <mesh castShadow geometry={sofaBase} position={[0, 0.26, -0.02]}>
        <meshStandardMaterial color="#625c57" roughness={0.84} />
      </mesh>
      {SOFA_SEAT_BLUEPRINT.seatCenters.map(({ x, y, z }) => (
        <mesh key={`seat-${x}`} castShadow geometry={sofaSeat} position={[x, y, z]}>
          <meshStandardMaterial color={color} roughness={0.95} />
        </mesh>
      ))}
      <mesh castShadow geometry={sofaBack} position={[0, 0.77, -0.35]} rotation={[-0.06, 0, 0]}>
        <meshStandardMaterial color={color} roughness={0.94} />
      </mesh>
      {[-0.49, 0.49].map((x) => (
        <mesh key={`back-${x}`} castShadow geometry={sofaBackCushion} position={[x, 0.82, -0.215]} rotation={[-0.075, 0, 0]}>
          <meshStandardMaterial color={color} roughness={0.98} />
        </mesh>
      ))}
      {[-0.99, 0.99].map((x) => (
        <mesh key={`arm-${x}`} castShadow geometry={sofaArm} position={[x, 0.55, -0.015]}>
          <meshStandardMaterial color={color} roughness={0.94} />
        </mesh>
      ))}
      {[-0.83, 0.83].flatMap((x) => [-0.3, 0.3].map((z) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, 0.08, z]}>
          <cylinderGeometry args={[0.045, 0.05, 0.16, 8]} />
          <meshStandardMaterial color="#4b4b49" metalness={0.35} roughness={0.58} />
        </mesh>
      )))}
    </group>
  );
}

export function ArmChair({
  position = [0, 0, 0],
  rotationY = 0,
  color = "#d3a46c"
}: {
  position?: [number, number, number];
  rotationY?: number;
  color?: string;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} dispose={null} userData={{ officeSeat: true }}>
      <mesh castShadow geometry={chairBase} position={[0, 0.28, 0]}>
        <meshStandardMaterial color="#625c57" roughness={0.84} />
      </mesh>
      <mesh castShadow geometry={chairSeat} position={[
        ARMCHAIR_SEAT_BLUEPRINT.seatCenter.x,
        ARMCHAIR_SEAT_BLUEPRINT.seatCenter.y,
        ARMCHAIR_SEAT_BLUEPRINT.seatCenter.z
      ]}>
        <meshStandardMaterial color={color} roughness={0.95} />
      </mesh>
      <mesh castShadow geometry={chairBack} position={[0, 0.82, -0.325]} rotation={[-0.07, 0, 0]}>
        <meshStandardMaterial color={color} roughness={0.94} />
      </mesh>
      <mesh castShadow geometry={chairBackCushion} position={[0, 0.82, -0.205]} rotation={[-0.075, 0, 0]}>
        <meshStandardMaterial color={color} roughness={0.98} />
      </mesh>
      {[-0.36, 0.36].map((x) => (
        <mesh key={`arm-${x}`} castShadow geometry={chairArm} position={[x, 0.57, 0]}>
          <meshStandardMaterial color={color} roughness={0.94} />
        </mesh>
      ))}
      {[-0.28, 0.28].flatMap((x) => [-0.29, 0.29].map((z) => (
        <mesh key={`${x}-${z}`} castShadow position={[x, 0.09, z]}>
          <cylinderGeometry args={[0.035, 0.04, 0.18, 8]} />
          <meshStandardMaterial color="#4b4b49" metalness={0.35} roughness={0.58} />
        </mesh>
      )))}
    </group>
  );
}
