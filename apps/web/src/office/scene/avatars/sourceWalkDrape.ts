import type { Mesh } from 'three';

export const WALK_DRAPE_MORPH = 'ExtaliaWalkDrape';
export interface WalkDrapeBinding { mesh: Mesh; target: number }

/** These targets belong to fitted source cloth, independently of seated/body morphs. */
export function walkDrapeBindings(meshes: readonly Mesh[]): WalkDrapeBinding[] {
  return meshes.flatMap(mesh => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const target = mesh.morphTargetDictionary?.[WALK_DRAPE_MORPH];
    const position = mesh.geometry.getAttribute('position');
    const morph = target === undefined ? undefined : mesh.geometry.morphAttributes.position?.[target];
    return materials.some(material => material.name.startsWith('Original'))
      && target !== undefined && Number.isInteger(target) && target >= 0
      && target < (mesh.morphTargetInfluences?.length ?? 0)
      && !Object.entries(mesh.morphTargetDictionary ?? {}).some(([name, index]) => name !== WALK_DRAPE_MORPH && index === target)
      && position && morph?.itemSize === 3 && morph.count === position.count
      ? [{ mesh, target }] : [];
  });
}

/** Blend out the walking envelope as the separately fitted seated drape takes over. */
export function applyWalkDrape(bindings: readonly WalkDrapeBinding[], walk: number, sit: number): void {
  const walking = Number.isFinite(walk) ? Math.max(0, Math.min(1, walk)) : 0;
  const seated = Number.isFinite(sit) ? Math.max(0, Math.min(1, sit)) : 0;
  for (const { mesh, target } of bindings) if (mesh.morphTargetInfluences) {
    mesh.morphTargetInfluences[target] = walking * (1 - seated);
  }
}
