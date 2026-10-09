import { FixtureSpotLight } from "./FixtureSpotLight";
import { useEffect, useLayoutEffect, useMemo, useRef } from "react";
import type { InstancedMesh} from "three";
import { CylinderGeometry, MeshStandardMaterial, Object3D } from "three";
import { useSolarEnvironment } from "../../../Environment";
import { raisedDownlightAngle, raisedDownlightIntensity, raisedDownlightRange } from "./ceilingMounting";
import { useStructuralCeiling } from "./StructuralCeilingContext";

/**
 * Fixture-local executive lighting: visible cove strips and two ceiling beams
 * aimed at desk/lounge surfaces. No painted light pools or room-wide fill.
 */
export function ExecutiveSuiteLighting({
  size,
  deskLocal,
  loungeLocal = [2.8, 0, 0.1]
}: {
  size: readonly [number, number];
  deskLocal: readonly [number, number, number];
  loungeLocal?: readonly [number, number, number];
}) {
  const { state } = useSolarEnvironment();
  const { ceilingY, mounts } = useStructuralCeiling();
  const { trimY, lensY, sourceY } = mounts.executive;
  const coveY = ceilingY - 0.009;
  const interior = state.factors.interiorLightFactor;
  const [width, depth] = size;
  const trimsRef = useRef<InstancedMesh>(null);
  const lensesRef = useRef<InstancedMesh>(null);

  // Downlight grid: 1.8 m pitch, inset 0.9 m from the walls.
  const downlights = useMemo(() => {
    const points: [number, number][] = [];
    const cols = Math.max(2, Math.floor((width - 1.8) / 1.8) + 1);
    const rows = Math.max(2, Math.floor((depth - 1.8) / 1.8) + 1);
    const spanX = (cols - 1) * 1.8;
    const spanZ = (rows - 1) * 1.8;
    for (let c = 0; c < cols; c += 1) {
      for (let r = 0; r < rows; r += 1) points.push([-spanX / 2 + c * 1.8, -spanZ / 2 + r * 1.8]);
    }
    return points;
  }, [width, depth]);

  const geometries = useMemo(() => ({
    trim: new CylinderGeometry(0.085, 0.085, 0.02, 16),
    lens: new CylinderGeometry(0.06, 0.06, 0.012, 16)
  }), []);
  const materials = useMemo(() => ({
    trim: new MeshStandardMaterial({ color: "#2b2b2b", roughness: 0.6 }),
    lens: new MeshStandardMaterial({ color: "#fff3df", emissive: "#fff3df", emissiveIntensity: 0, roughness: 0.3 }),
    cove: new MeshStandardMaterial({ color: "#ffd9a0", emissive: "#ffd9a0", emissiveIntensity: 0, roughness: 0.3 }),
  }), []);
  const materialRef = useRef(materials);
  useEffect(() => () => {
    Object.values(geometries).forEach((geometry) => geometry.dispose());
    Object.values(materials).forEach((material) => material.dispose());
  }, [geometries, materials]);

  useEffect(() => {
    materialRef.current.lens.emissiveIntensity = interior * 0.8;
    materialRef.current.cove.emissiveIntensity = interior * 0.6;
  }, [materials, interior]);

  useLayoutEffect(() => {
    const dummy = new Object3D();
    for (const [mesh, y] of [[trimsRef.current, trimY], [lensesRef.current, lensY]] as const) {
      if (!mesh) continue;
      downlights.forEach(([x, z], index) => {
        dummy.position.set(x, y, z);
        dummy.updateMatrix();
        mesh.setMatrixAt(index, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    }
  }, [downlights, trimY, lensY]);

  const insetW = width - 0.16;
  const insetD = depth - 0.16;

  return (
    <group name="executive-suite-lighting" userData={{ officeDynamic: true }}>
      {/* Perimeter cove strips. */}
      {[1, -1].map((side) => (
        <mesh name="structural-cove-strip" key={`cz-${side}`} position={[0, coveY, side * (insetD / 2)]} material={materials.cove}>
          <boxGeometry args={[insetW, 0.018, 0.03]} />
        </mesh>
      ))}
      {[1, -1].map((side) => (
        <mesh name="structural-cove-strip" key={`cx-${side}`} position={[side * (insetW / 2), coveY, 0]} material={materials.cove}>
          <boxGeometry args={[0.03, 0.018, insetD]} />
        </mesh>
      ))}
      {/* Architectural downlights (instanced trims + lenses). */}
      <instancedMesh name="structural-executive-trims" ref={trimsRef} args={[geometries.trim, materials.trim, downlights.length]} />
      <instancedMesh ref={lensesRef} args={[geometries.lens, materials.lens, downlights.length]} />

      {/* Every installed lens contributes to the cache without increasing GPU beam slots. */}
      {downlights.map(([x, z], index) => <FixtureSpotLight key={`grid-${index}`} name="executive-grid-downlight"
        position={[x, sourceY, z]} aim={[x, 0.05, z]} color="#fff1df"
        intensity={raisedDownlightIntensity(interior * 4, 2.51, sourceY, 0.05, 4.5)}
        distance={raisedDownlightRange(4.5, 2.51, sourceY, 0.05)}
        angle={raisedDownlightAngle(1, 2.51, sourceY, 0.05)} />)}
      {/* Dedicated task focus also follows the desk/lounge zone. */}
      {[deskLocal, loungeLocal].map((point, index) => {
        const [x, z] = downlights.reduce((nearest, candidate) =>
          Math.hypot(candidate[0] - point[0], candidate[1] - point[2]) < Math.hypot(nearest[0] - point[0], nearest[1] - point[2]) ? candidate : nearest);
        const targetY = index === 0 ? 0.77 : 0;
        return <FixtureSpotLight key={index} name="executive-ceiling-downlight" position={[x, sourceY, z]}
          aim={[point[0], targetY, point[2]]} color="#ffe2b8"
          intensity={raisedDownlightIntensity(interior * 16, 2.51, sourceY, targetY, 5)}
          distance={raisedDownlightRange(5, 2.51, sourceY, targetY)}
          angle={raisedDownlightAngle(0.8, 2.51, sourceY, targetY)} />;
      })}
    </group>
  );
}
