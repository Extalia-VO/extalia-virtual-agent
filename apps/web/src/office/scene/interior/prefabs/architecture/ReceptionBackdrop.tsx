import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type {
  InstancedMesh} from "three";
import {
  BoxGeometry,
  MeshStandardMaterial,
  Object3D
} from "three";
import { ExtaliaBrand3D } from "./ExtaliaBrand3D";

/**
 * Extalia V2 reception feature wall, echoing the exterior language:
 * vertical oak slats over a charcoal backer, dark metal trim and a backlit
 * blue /> symbol and lowercase Righteous wordmark. The wall face points -Z
 * towards the visitor side, matching the existing ReceptionDesk feature wall.
 *
 * Cost: slats are one InstancedMesh; the shared brand owns its halo and
 * dynamic materials. No lights and no shadow casters are added.
 */
const PANEL_WIDTH = 4.2;
const PANEL_HEIGHT = 2.5;
const SLAT_COUNT = 24;
const SLAT_WIDTH = 0.07;

export function ReceptionBackdrop({
  position = [0, 0, 0],
  interiorFactor = 0
}: {
  position?: [number, number, number];
  interiorFactor?: number;
}) {
  const slatsRef = useRef<InstancedMesh>(null);

  const geometries = useMemo(() => ({
    slat: new BoxGeometry(SLAT_WIDTH, PANEL_HEIGHT - 0.12, 0.045)
  }), []);

  const materials = useMemo(() => ({
    oak: new MeshStandardMaterial({ color: "#a87a4f", roughness: 0.62, metalness: 0.02 }),
    backer: new MeshStandardMaterial({ color: "#16181b", roughness: 0.85, metalness: 0.1 }),
    trim: new MeshStandardMaterial({ color: "#2a2e33", roughness: 0.32, metalness: 0.85 }),
    plaque: new MeshStandardMaterial({ color: "#1c1f23", roughness: 0.4, metalness: 0.7 }),
    led: new MeshStandardMaterial({ color: "#ffe1ad", emissive: "#ffe1ad", emissiveIntensity: 0, roughness: 0.4 })
  }), []);

  const materialRef = useRef(materials);
  useEffect(() => () => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
  }, [geometries, materials]);

  useEffect(() => {
    materialRef.current.led.emissiveIntensity = interiorFactor * 0.65;
  }, [materials, interiorFactor]);

  useLayoutEffect(() => {
    const mesh = slatsRef.current;
    if (!mesh) return;
    const dummy = new Object3D();
    const pitch = PANEL_WIDTH / SLAT_COUNT;
    for (let index = 0; index < SLAT_COUNT; index += 1) {
      dummy.position.set(-PANEL_WIDTH / 2 + pitch * (index + 0.5), 0, 0);
      dummy.updateMatrix();
      mesh.setMatrixAt(index, dummy.matrix);
    }
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, []);

  return (
    // officeDynamic keeps StaticCampusBatch from merging these meshes, so the
    // emissive/halo updates driven by interiorFactor stay live.
    <group position={position} name="reception-backdrop-v2" userData={{ officeDynamic: true }}>
      {/* Charcoal backer hides the legacy printed panel behind the slats. */}
      <mesh position={[0, 0, -0.012]} material={materials.backer} receiveShadow>
        <boxGeometry args={[PANEL_WIDTH + 0.08, PANEL_HEIGHT, 0.02]} />
      </mesh>

      {/* Vertical oak slats (instanced). */}
      <instancedMesh
        ref={slatsRef}
        args={[geometries.slat, materials.oak, SLAT_COUNT]}
        position={[0, 0, -0.045]}
        receiveShadow
      />

      {/* Dark metal perimeter trim. */}
      {[1, -1].map((side) => (
        <mesh key={`h-${side}`} position={[0, side * (PANEL_HEIGHT / 2 + 0.02), -0.05]} material={materials.trim}>
          <boxGeometry args={[PANEL_WIDTH + 0.14, 0.05, 0.09]} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <mesh key={`v-${side}`} position={[side * (PANEL_WIDTH / 2 + 0.045), 0, -0.05]} material={materials.trim}>
          <boxGeometry args={[0.05, PANEL_HEIGHT + 0.09, 0.09]} />
        </mesh>
      ))}

      {/* Floating metal plaque carrying the backlit 3D brand mark. */}
      <group position={[0, 0.32, -0.1]}>
        <mesh material={materials.plaque}>
          <boxGeometry args={[2.7, 0.62, 0.035]} />
        </mesh>
        <ExtaliaBrand3D
          height={0.38}
          depth={0.07}
          lightFactor={interiorFactor}
          position={[0, 0, -0.03]}
          rotationY={Math.PI}
        />
        {/* Linear LED reveal under the plaque. */}
        <mesh position={[0, -0.33, -0.01]} material={materials.led}>
          <boxGeometry args={[2.5, 0.012, 0.012]} />
        </mesh>
      </group>

      {/* Base LED wash grazing the slats from below. */}
      <mesh position={[0, -PANEL_HEIGHT / 2 + 0.06, -0.09]} material={materials.led}>
        <boxGeometry args={[PANEL_WIDTH - 0.1, 0.012, 0.012]} />
      </mesh>
    </group>
  );
}
