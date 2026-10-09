import { useEffect, useMemo, useRef } from "react";
import { useFrame } from "@react-three/fiber";
import type { Group} from "three";
import { CanvasTexture, MathUtils, SRGBColorSpace, Vector3 } from "three";
import { F1_EMERGENCY_EXIT } from "../../floor1Layout";
import { isMovingOccupantNear, setDoorPortal } from "../../occupants/movingOccupants";
import { doorOpenAmount } from "./OpenDoor";

import { useInteriorText } from "../../FurnishedFloorContext";

const DOOR_ID = "floor-1.exterior.emergency-exit";
const HEIGHT = 2.55;
const OPEN_ANGLE = -Math.PI / 2;

/** West rear-corridor exit, with the same automatic portal contract as OpenDoor. */
export function F1EmergencyExit() {
  const t = useInteriorText();
  const frame = useRef<Group>(null);
  const leaf = useRef<Group>(null);
  const holdOpenUntil = useRef(0);
  const worldPosition = useRef(new Vector3());
  const worldNormal = useRef(new Vector3());
  const width = F1_EMERGENCY_EXIT.width;
  const leafWidth = width + 0.04;
  const sign = useMemo(() => {
    const canvas = document.createElement("canvas");
    canvas.width = 768;
    canvas.height = 160;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      ctx.fillStyle = "#087d54";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.strokeStyle = "#ffffff";
      ctx.lineWidth = 7;
      ctx.strokeRect(10, 10, 748, 140);
      ctx.fillStyle = "#ffffff";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.font = "bold 58px Arial, sans-serif";
      ctx.fillText(t("EMERGENCY EXIT"), 384, 63);
      ctx.font = "bold 30px Arial, sans-serif";
      ctx.fillText(t("PUSH TO OPEN"), 384, 117);
    }
    const texture = new CanvasTexture(canvas);
    texture.colorSpace = SRGBColorSpace;
    return texture;
  }, [t]);
  useEffect(() => () => sign.dispose(), [sign]);

  useFrame(({ clock }, delta) => {
    if (!frame.current || !leaf.current) return;
    frame.current.getWorldPosition(worldPosition.current);
    frame.current.getWorldDirection(worldNormal.current);
    const { x, y, z } = worldPosition.current;
    const yaw = Math.atan2(worldNormal.current.x, worldNormal.current.z);
    if (isMovingOccupantNear(x, y, z, width / 2, yaw)) {
      holdOpenUntil.current = clock.elapsedTime + 1;
    }
    leaf.current.rotation.y = MathUtils.damp(
      leaf.current.rotation.y,
      clock.elapsedTime < holdOpenUntil.current ? OPEN_ANGLE : 0,
      9,
      delta
    );
    setDoorPortal(DOOR_ID, {
      floor: 1,
      roomId: "exterior",
      role: "emergency-exit",
      center: [x, y, z],
      yaw,
      clearWidth: width,
      openAmount: doorOpenAmount(leaf.current.rotation.y, OPEN_ANGLE)
    });
  });
  useEffect(() => () => setDoorPortal(DOOR_ID, null), []);
  useEffect(() => () => sign.dispose(), [sign]);

  return (
    <group ref={frame} name="office-passable-door" userData={{ officePassable: true, emergencyExit: true }}
      position={F1_EMERGENCY_EXIT.center} rotation={[0, -Math.PI / 2, 0]}>
      {[-1, 1].map(side => (
        <mesh key={side} castShadow position={[side * (width / 2 + 0.04), HEIGHT / 2, 0]}>
          <boxGeometry args={[0.08, HEIGHT + 0.12, 0.2]} />
          <meshStandardMaterial color="#d8e3dd" metalness={0.45} roughness={0.35} />
        </mesh>
      ))}
      <mesh castShadow position={[0, HEIGHT + 0.04, 0]}>
        <boxGeometry args={[width + 0.16, 0.08, 0.2]} />
        <meshStandardMaterial color="#d8e3dd" metalness={0.45} roughness={0.35} />
      </mesh>
      {/* Flat landing spans the facade setback and joins the campus paver ring. */}
      <mesh receiveShadow position={[0, 0.01, 0.55]}>
        <boxGeometry args={[width, 0.02, 1.1]} />
        <meshStandardMaterial color="#bcb7aa" roughness={0.92} />
      </mesh>
      {/* Local +Z faces west; the negative swing moves the leaf outdoors. */}
      <group ref={leaf} name="f1-emergency-exit-leaf" userData={{ officeDynamic: true }} position={[-width / 2 - 0.04, 0, 0]}>
        <mesh castShadow position={[leafWidth / 2, HEIGHT / 2, 0]}>
          <boxGeometry args={[leafWidth, HEIGHT, 0.06]} />
          <meshStandardMaterial color="#16765b" roughness={0.62} metalness={0.18} />
        </mesh>
        <mesh position={[width / 2, 0.17, -0.041]}>
          <boxGeometry args={[width - 0.12, 0.28, 0.025]} />
          <meshStandardMaterial color="#9bacaa" metalness={0.75} roughness={0.28} />
        </mesh>
        {/* Panic bar remains attached to the interior face of the moving leaf. */}
        {[0.18, width - 0.18].map(x => (
          <mesh key={x} castShadow position={[x, 1.08, -0.09]}>
            <boxGeometry args={[0.08, 0.15, 0.12]} />
            <meshStandardMaterial color="#c7d3cc" metalness={0.75} roughness={0.25} />
          </mesh>
        ))}
        <mesh castShadow position={[width / 2, 1.08, -0.15]}>
          <boxGeometry args={[width - 0.3, 0.07, 0.055]} />
          <meshStandardMaterial color="#e8ede8" metalness={0.7} roughness={0.24} />
        </mesh>
      </group>
      {[-1, 1].map(side => (
        <mesh key={side} userData={{ officeDynamic: true }} position={[0, 2.91, side > 0 ? 0.28 : -0.13]} rotation={[0, side > 0 ? 0 : Math.PI, 0]}>
          <planeGeometry args={[1.8, 0.375]} />
          <meshBasicMaterial map={sign} toneMapped={false} />
        </mesh>
      ))}
    </group>
  );
}
