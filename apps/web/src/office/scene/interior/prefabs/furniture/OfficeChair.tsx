import { useLayoutEffect, useRef, useState } from "react";
import { Matrix4, type Group, type Object3D } from "three";
import { deskChairRegistry, isDeskChair } from "../../deskChairs";
import { GUEST_CHAIR_SEAT_BLUEPRINT, OFFICE_CHAIR_SEAT_BLUEPRINT } from "../../furnitureSeatBlueprint";
import { OFFICE_CHAIR_MODEL_MATERIAL, useOfficeChairModel } from "../../chairModels";

/**
 * The seated person faces local +Z. The floor and seat anchors are shared by every workstation.
 * With the `resourceId` of a workstation the chair is drawn by `DeskChairInstances` (one instanced
 * mesh per floor), so it can slide out when its agent stands up or sits down.
 */
export function OfficeChair({
  position = [0, 0, 0],
  rotationY = 0,
  highBack = false,
  color = "#516368",
  resourceId
}: {
  position?: [number, number, number];
  rotationY?: number;
  highBack?: boolean;
  color?: string;
  /** Workstation resource whose agent uses this chair. */
  resourceId?: string | undefined;
}) {
  const anchor = useRef<Group>(null);
  const movable = isDeskChair(resourceId) && color === (highBack ? EXECUTIVE_CHAIR_COLOR : TASK_CHAIR_COLOR);
  const [fallback, setFallback] = useState(false);
  useLayoutEffect(() => {
    const group = anchor.current;
    if (!movable || !group || !resourceId) return;
    // Register the transform relative to its furnished floor; outside a floor it draws itself.
    let floorGroup: Object3D | null = group.parent;
    while (floorGroup && !/^furnished-floor-[123]$/.test(floorGroup.name)) floorGroup = floorGroup.parent;
    if (!floorGroup) { setFallback(true); return; }
    floorGroup.updateWorldMatrix(true, false);
    group.updateWorldMatrix(true, false);
    const matrix = new Matrix4().copy(floorGroup.matrixWorld).invert().multiply(group.matrixWorld);
    const floor = Number(floorGroup.name.slice(-1)) as 1 | 2 | 3;
    return deskChairRegistry.register({ resourceId, floor, variant: highBack ? "executive" : "task", matrix });
  }, [movable, resourceId, highBack]);
  if (movable && !fallback) return <group ref={anchor} position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }} />;
  // Keep the loading backup out of floor-wide static batches: it must disappear when the GLB arrives.
  return <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true, officeDynamic: true }}>
    <OfficeChairMeshes highBack={highBack} color={color} />
  </group>;
}

export const TASK_CHAIR_COLOR = "#516368";
export const EXECUTIVE_CHAIR_COLOR = "#d8d0c1";

/** The chair's meshes around its own origin (shared by the static and instanced chairs). */
export function OfficeChairMeshes({ highBack = false, color = TASK_CHAIR_COLOR }: { highBack?: boolean; color?: string }) {
  const geometry = useOfficeChairModel(highBack ? 'executive' : 'task');
  const authoredColor = highBack ? EXECUTIVE_CHAIR_COLOR : TASK_CHAIR_COLOR;
  if (geometry && color === authoredColor) return <mesh name={`blender-office-chair-${highBack ? 'executive' : 'task'}`} geometry={geometry} material={OFFICE_CHAIR_MODEL_MATERIAL} dispose={null} userData={{ officeInstanceable: true }} castShadow receiveShadow />;
  return <ProceduralOfficeChairMeshes highBack={highBack} color={color} />;
}

/** Lightweight backup for clean checkouts without the local Blender assets. */
export function ProceduralOfficeChairMeshes({ highBack = false, color = TASK_CHAIR_COLOR }: { highBack?: boolean; color?: string }) {
  const backHeight = highBack ? OFFICE_CHAIR_SEAT_BLUEPRINT.executiveBackHeight : OFFICE_CHAIR_SEAT_BLUEPRINT.taskBackHeight;
  const backCenterY = OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight + backHeight / 2;
  const armCenterX = (OFFICE_CHAIR_SEAT_BLUEPRINT.armOuterWidth - OFFICE_CHAIR_SEAT_BLUEPRINT.armPadSize[0]) / 2;
  const spokeLength = OFFICE_CHAIR_SEAT_BLUEPRINT.baseDiameter / 2 - 0.04;
  const frame = "#303b3c";
  const metal = "#77817f";

  return (
    <>
      {/* Upholstered seat, piped edge and a thin under-seat shell. */}
      <mesh castShadow position={OFFICE_CHAIR_SEAT_BLUEPRINT.frameCenter}>
        <boxGeometry args={OFFICE_CHAIR_SEAT_BLUEPRINT.frameSize} />
        <meshStandardMaterial color={frame} roughness={0.68} />
      </mesh>
      <mesh castShadow position={OFFICE_CHAIR_SEAT_BLUEPRINT.cushionCenter}>
        <boxGeometry args={OFFICE_CHAIR_SEAT_BLUEPRINT.cushionSize} />
        <meshStandardMaterial color={color} roughness={0.92} />
      </mesh>
      <mesh position={[0, 0.435, OFFICE_CHAIR_SEAT_BLUEPRINT.cushionCenter[2] + OFFICE_CHAIR_SEAT_BLUEPRINT.cushionSize[2] / 2 + 0.004]}>
        <boxGeometry args={[0.44, 0.025, 0.012]} />
        <meshStandardMaterial color="#83928d" roughness={0.78} />
      </mesh>

      {/* Slim surround makes the upholstered back read as a separate, contoured part. */}
      <mesh castShadow position={[0, backCenterY, OFFICE_CHAIR_SEAT_BLUEPRINT.backZ]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.53, backHeight, OFFICE_CHAIR_SEAT_BLUEPRINT.backThickness]} />
        <meshStandardMaterial color={frame} roughness={0.7} />
      </mesh>
      <mesh castShadow position={[0, backCenterY, -0.198]} rotation={[-0.08, 0, 0]}>
        <boxGeometry args={[0.46, backHeight - 0.08, 0.035]} />
        <meshStandardMaterial color={color} roughness={0.96} />
      </mesh>
      <mesh position={[0, OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight + 0.20, -0.188]}>
        <boxGeometry args={[0.4, 0.09, 0.025]} />
        <meshStandardMaterial color="#697b78" roughness={0.95} />
      </mesh>
      {highBack && (
        <mesh castShadow position={[0, OFFICE_CHAIR_SEAT_BLUEPRINT.cushionHeight + backHeight - 0.055, -0.195]}>
          <boxGeometry args={[0.34, 0.10, 0.06]} />
          <meshStandardMaterial color={color} roughness={0.94} />
        </mesh>
      )}

      {[-armCenterX, armCenterX].map((x) => (
        <group key={x}>
          <mesh castShadow position={[x, 0.55, -0.06]}>
            <boxGeometry args={[0.035, 0.22, 0.04]} />
            <meshStandardMaterial color={metal} metalness={0.53} roughness={0.39} />
          </mesh>
          <mesh castShadow position={[x, OFFICE_CHAIR_SEAT_BLUEPRINT.armPadTop - OFFICE_CHAIR_SEAT_BLUEPRINT.armPadSize[1] / 2, OFFICE_CHAIR_SEAT_BLUEPRINT.armPadZ]}>
            <boxGeometry args={OFFICE_CHAIR_SEAT_BLUEPRINT.armPadSize} />
            <meshStandardMaterial color={frame} roughness={0.67} />
          </mesh>
        </group>
      ))}

      <mesh castShadow position={[0, 0.24, 0]}>
        <cylinderGeometry args={[0.04, 0.04, 0.33, 12]} />
        <meshStandardMaterial color={metal} metalness={0.62} roughness={0.37} />
      </mesh>
      <mesh castShadow position={[0, 0.33, 0]}>
        <cylinderGeometry args={[0.14, 0.11, 0.05, 16]} />
        <meshStandardMaterial color={frame} roughness={0.6} />
      </mesh>
      {Array.from({ length: 5 }).map((_, i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh castShadow position={[0, 0.075, spokeLength / 2]}>
            <boxGeometry args={[0.05, 0.04, spokeLength]} />
            <meshStandardMaterial color={frame} metalness={0.32} roughness={0.46} />
          </mesh>
          <mesh castShadow position={[0, 0.04, spokeLength]}>
            <cylinderGeometry args={[0.04, 0.04, 0.05, 10]} />
            <meshStandardMaterial color="#242b2d" roughness={0.58} />
          </mesh>
        </group>
      ))}
    </>
  );
}

export function ExecutiveChair(
  props: Omit<Parameters<typeof OfficeChair>[0], "highBack">
) {
  return <OfficeChair {...props} highBack color={EXECUTIVE_CHAIR_COLOR} />;
}

export function GuestChair({
  position = [0, 0, 0],
  rotationY = 0
}: {
  position?: [number, number, number];
  rotationY?: number;
}) {
  return (
    <group position={position} rotation={[0, rotationY, 0]} userData={{ officeSeat: true }}>
      <mesh castShadow position={[0, 0.355, 0]}>
        <boxGeometry args={[0.56, 0.06, 0.52]} />
        <meshStandardMaterial color="#62584e" roughness={0.78} />
      </mesh>
      <mesh castShadow position={GUEST_CHAIR_SEAT_BLUEPRINT.cushionCenter}>
        <boxGeometry args={GUEST_CHAIR_SEAT_BLUEPRINT.cushionSize} />
        <meshStandardMaterial color="#d5c8b5" roughness={0.93} />
      </mesh>
      <mesh castShadow position={[0, 0.77, -0.23]} rotation={[-0.09, 0, 0]}>
        <boxGeometry args={[0.55, 0.65, 0.1]} />
        <meshStandardMaterial color="#d5c8b5" roughness={0.93} />
      </mesh>
      <mesh position={[0, 0.74, -0.175]}>
        <boxGeometry args={[0.46, 0.015, 0.006]} />
        <meshStandardMaterial color="#ad9d8c" roughness={0.94} />
      </mesh>
      {[-0.22, 0.22].flatMap((x) =>
        [-0.20, 0.20].map((z) => (
          <mesh key={`${x}-${z}`} castShadow position={[x, 0.175, z]}>
            <cylinderGeometry args={[0.024, 0.028, 0.35, 8]} />
            <meshStandardMaterial color="#515f5e" metalness={0.4} roughness={0.47} />
          </mesh>
        ))
      )}
    </group>
  );
}
