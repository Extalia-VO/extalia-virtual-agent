import { deskLayout, MOUSE_CENTRE_Y, MOUSE_DIMENSIONS, MOUSE_PAD, SINGLE_DESK_SLOTS } from "../../deskLayout";
import { DeskAccessorySlots } from "./DeskOrganizers";
import { useCoffeeCupHeldAtDesk } from "../../FurnishedFloorContext";
import { WorkstationPart } from "../../WorkstationPart";

/** A real-size mouse on its pad; `position` is the pad resting on the desk, the mouse at `mouseOnPad` on it. */
export function MouseAndPad({
  position = [0, 0, 0],
  rotationY = 0,
  mouseOnPad = [0, 0]
}: {
  position?: readonly [number, number, number];
  rotationY?: number;
  mouseOnPad?: readonly [number, number];
}) {
  const { width, height, length } = MOUSE_DIMENSIONS;
  const top = MOUSE_PAD.thickness;
  return (
    <group position={[...position]} rotation={[0, rotationY, 0]} userData={{ officeDeskInput: "mouse-pad" }}>
      {/* Stitched cloth pad. */}
      <WorkstationPart asset="mouse-pad">
      <mesh receiveShadow position={[0, top / 2, 0]}>
        <boxGeometry args={[MOUSE_PAD.width, top, MOUSE_PAD.depth]} />
        <meshStandardMaterial color="#222b30" roughness={0.88} />
      </mesh>
      <mesh position={[0, top + 0.0005, 0]}>
        <boxGeometry args={[MOUSE_PAD.width - 0.012, 0.001, MOUSE_PAD.depth - 0.012]} />
        <meshStandardMaterial color="#34464b" roughness={0.76} />
      </mesh>
      </WorkstationPart>
      <group position={[mouseOnPad[0], MOUSE_CENTRE_Y, mouseOnPad[1]]} userData={{ officeDeskInput: "mouse" }}>
        <WorkstationPart asset="mouse">
        <mesh receiveShadow scale={[width / 2, height / 2, length / 2]}>
          <sphereGeometry args={[1, 20, 14]} />
          <meshStandardMaterial color="#3c484e" metalness={0.28} roughness={0.34} />
        </mesh>
        {/* Split buttons, seam and scroll wheel. */}
        {[-1, 1].map(side => <mesh key={side} position={[side * width * 0.2, height * 0.42, -length * 0.26]} rotation={[-0.12, 0, 0]}>
          <boxGeometry args={[width * 0.34, 0.002, length * 0.32]} />
          <meshStandardMaterial color="#637177" roughness={0.42} />
        </mesh>)}
        <mesh position={[0, height * 0.46, -length * 0.22]}>
          <boxGeometry args={[0.005, 0.006, 0.016]} />
          <meshStandardMaterial color="#8cc7bd" emissive="#367b71" emissiveIntensity={0.35} />
        </mesh>
        </WorkstationPart>
      </group>
    </group>
  );
}

/**
 * The desk's personal items: the coffee cup at the front left (lifted by its
 * sitter while sipping) and the desk's own organizers, cabinet and decor in
 * its slots (see deskLayout). The keyboard and mouse are placed by the desk.
 */
export function DeskAccessorySet({
  topY = 0.785,
  cup = true,
  resourceId
}: {
  topY?: number;
  cup?: boolean;
  resourceId?: string | undefined;
}) {
  const cupHeld = useCoffeeCupHeldAtDesk(resourceId);
  return (
    <group>
      {cup && !cupHeld && (
        <group position={[-0.60, topY, 0.18]} userData={{ officeDynamic: true }}>
          <mesh receiveShadow position={[0, 0.055, 0]}>
            <cylinderGeometry args={[0.05, 0.046, 0.11, 20]} />
            <meshStandardMaterial color="#ddd6ca" roughness={0.28} />
          </mesh>
          <mesh position={[0, 0.108, 0]}>
            <torusGeometry args={[0.046, 0.006, 8, 20]} />
            <meshStandardMaterial color="#f1ece3" roughness={0.27} />
          </mesh>
          <mesh position={[0, 0.105, 0]}>
            <cylinderGeometry args={[0.039, 0.039, 0.003, 20]} />
            <meshStandardMaterial color="#76533b" roughness={0.26} />
          </mesh>
          <mesh position={[0.052, 0.06, 0]}>
            <torusGeometry args={[0.031, 0.007, 8, 16]} />
            <meshStandardMaterial color="#ddd6ca" roughness={0.32} />
          </mesh>
          <mesh position={[0, 0.014, 0]}>
            <cylinderGeometry args={[0.049, 0.046, 0.012, 20]} />
            <meshStandardMaterial color="#b8afa2" roughness={0.38} />
          </mesh>
        </group>
      )}
      <DeskAccessorySlots layout={deskLayout(resourceId)} slots={SINGLE_DESK_SLOTS} topY={topY} />
    </group>
  );
}
