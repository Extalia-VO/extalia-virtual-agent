import { useEffect, useMemo, type ReactNode } from "react";
import { BufferGeometry, Float32BufferAttribute } from "three";
import { StaticCampusBatch } from "../StaticCampusBatch";
import { useExteriorEnvelopeActive } from "./ExteriorEnvelopeContext";
import { useStructuralCeiling } from "./prefabs/architecture/StructuralCeilingContext";
import { clipBuildingRectangle, createBuildingFootprintGeometry, isInsideBuildingFootprint, type BuildingFootprintProfile } from "./buildingFootprintGeometry";

type PatchProps = {
  position?: [number, number, number];
  /** Building coordinates of the parent group; floor height does not affect the footprint. */
  buildingOrigin?: readonly [number, number];
  profile?: BuildingFootprintProfile;
  children: ReactNode;
  name?: string;
  receiveShadow?: boolean;
};

function usePatch(width: number, depth: number, position: readonly number[], origin: readonly number[], explicit?: BuildingFootprintProfile) {
  const active = useExteriorEnvelopeActive();
  const { floor } = useStructuralCeiling();
  const profile = explicit ?? (floor === 3 ? "upper" : "lower");
  const x = origin[0]! + position[0]!, z = origin[1]! + position[2]!;
  const affected = ![-1, 1].every(sx => [-1, 1].every(sz =>
    isInsideBuildingFootprint(x + sx * width / 2, z + sz * depth / 2, profile)));
  return { active, affected, profile, x, z };
}

/** Isolate only perimeter patches from the floor-wide immutable batch. */
function PatchBoundary({ active, profile, children }: { active: boolean; profile: BuildingFootprintProfile; children: ReactNode }) {
  return <group name="building-footprint-patch" userData={{ officeDynamic: true, officeFootprintPatch: true, officeFootprintProfile: profile, officeFootprintRounded: active }}>
    <StaticCampusBatch key={active ? "rounded" : "rectangular"}>{children}</StaticCampusBatch>
  </group>;
}

export function FootprintBox({ size, position = [0, 0, 0], buildingOrigin = [0, 0], profile: explicit, children, name, receiveShadow = false, unitGeometry }: PatchProps & { size: readonly [number, number, number]; unitGeometry?: BufferGeometry | null }) {
  const [width, height, depth] = size;
  const { active, affected, profile, x, z } = usePatch(width, depth, position, buildingOrigin, explicit);
  const geometry = useMemo(() => active && affected ? createBuildingFootprintGeometry({ size: [width, depth], origin: [x, z], thickness: height, profile }) : null,
    [active, affected, width, depth, height, x, z, profile]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const rectangular = <mesh name={name} position={position} receiveShadow={receiveShadow}
    {...(unitGeometry ? { scale: [width, height, depth] as const } : {})}>
    {unitGeometry ? <primitive object={unitGeometry} attach="geometry" /> : <boxGeometry args={[width, height, depth]} />}{children}
  </mesh>;
  if (!affected) return rectangular;
  return <PatchBoundary active={active} profile={profile}>
    {active ? geometry && <mesh name={name} position={[position[0], position[1] - height / 2, position[2]]} geometry={geometry} receiveShadow={receiveShadow}>{children}</mesh> : rectangular}
  </PatchBoundary>;
}

export function FootprintPlane({ size, position = [0, 0, 0], buildingOrigin = [0, 0], profile: explicit, children, name, receiveShadow = false }: PatchProps & { size: readonly [number, number] }) {
  const [width, depth] = size;
  const { active, affected, profile, x, z } = usePatch(width, depth, position, buildingOrigin, explicit);
  const geometry = useMemo(() => {
    if (!active || !affected) return null;
    const polygon = clipBuildingRectangle({ size: [width, depth], origin: [x, z], profile });
    if (polygon.length < 3) return null;
    // The clipped polygon is convex and CCW in XZ; reverse each fan triangle for +Y normals.
    const positions: number[] = [], normals: number[] = [], uvs: number[] = [];
    for (let i = 1; i < polygon.length - 1; i++) {
      for (const [px, pz] of [polygon[0]!, polygon[i + 1]!, polygon[i]!]) {
        positions.push(px, 0, pz); normals.push(0, 1, 0);
        uvs.push(0.5 + px / width, 0.5 - pz / depth);
      }
    }
    return new BufferGeometry().setAttribute("position", new Float32BufferAttribute(positions, 3))
      .setAttribute("normal", new Float32BufferAttribute(normals, 3)).setAttribute("uv", new Float32BufferAttribute(uvs, 2));
  }, [active, affected, width, depth, x, z, profile]);
  useEffect(() => () => geometry?.dispose(), [geometry]);
  const rectangular = <mesh name={name} position={position} rotation={[-Math.PI / 2, 0, 0]} receiveShadow={receiveShadow}>
    <planeGeometry args={[width, depth]} />{children}
  </mesh>;
  if (!affected) return rectangular;
  return <PatchBoundary active={active} profile={profile}>
    {active ? geometry && <mesh name={name} position={position} geometry={geometry} receiveShadow={receiveShadow}>{children}</mesh> : rectangular}
  </PatchBoundary>;
}
