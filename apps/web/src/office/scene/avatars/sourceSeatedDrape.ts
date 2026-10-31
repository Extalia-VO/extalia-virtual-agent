import type { Mesh } from 'three';

export const SEATED_DRAPE_MORPH = 'ExtaliaSeatedDrape';
export const SEATED_DRAPE_TALL_MORPH = 'ExtaliaSeatedDrapeTall';
export const SEATED_DRAPE_SHORT_MORPH = 'ExtaliaSeatedDrapeShort';
export interface SeatedDrapeBinding { mesh: Mesh; target: number; tallTarget?: number; shortTarget?: number }

/** A new SkinnedMesh otherwise loses the names assigned by GLTFLoader's targetNames. */
export function copyFittedMorphTargets(source: Mesh, target: Mesh): void {
  if (source.morphTargetDictionary) target.morphTargetDictionary = { ...source.morphTargetDictionary };
  if (source.morphTargetInfluences) target.morphTargetInfluences = [...source.morphTargetInfluences];
}

/** Only source-cloth correctives participate; body/facial morphs stay independent. */
export function seatedDrapeBindings(meshes: readonly Mesh[]): SeatedDrapeBinding[] {
  return meshes.flatMap(mesh => {
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const target = mesh.morphTargetDictionary?.[SEATED_DRAPE_MORPH];
    const tall = mesh.morphTargetDictionary?.[SEATED_DRAPE_TALL_MORPH];
    const tallTarget = tall !== undefined && tall !== target && Number.isInteger(tall) && tall >= 0
      && tall < (mesh.morphTargetInfluences?.length ?? 0) && mesh.geometry.morphAttributes.position?.[tall] ? tall : undefined;
    const short = mesh.morphTargetDictionary?.[SEATED_DRAPE_SHORT_MORPH];
    const shortTarget = short !== undefined && short !== target && short !== tallTarget && Number.isInteger(short) && short >= 0
      && short < (mesh.morphTargetInfluences?.length ?? 0) && mesh.geometry.morphAttributes.position?.[short] ? short : undefined;
    return materials.some(material => material.name.startsWith('Original'))
      && target !== undefined && Number.isInteger(target) && target >= 0
      && target < (mesh.morphTargetInfluences?.length ?? 0)
      && mesh.geometry.morphAttributes.position?.[target]
      ? [{ mesh, target, ...(tallTarget !== undefined ? { tallTarget } : {}), ...(shortTarget !== undefined ? { shortTarget } : {}) }] : [];
  });
}

/** The corrective is zero while standing/walking and follows the existing seated blend. */
export function applySeatedDrape(bindings: readonly SeatedDrapeBinding[], sit: number, heightMeters = 1.7): void {
  const influence = Number.isFinite(sit) ? Math.max(0, Math.min(1, sit)) : 0;
  const tall = Number.isFinite(heightMeters) ? Math.max(0, Math.min(1, (heightMeters - 1.7) / .25)) : 0;
  const short = Number.isFinite(heightMeters) ? Math.max(0, Math.min(1, (1.7 - heightMeters) / .25)) : 0;
  for (const { mesh, target, tallTarget, shortTarget } of bindings) if (mesh.morphTargetInfluences) {
    mesh.morphTargetInfluences[target] = influence * (1 - (tallTarget === undefined ? 0 : tall) - (shortTarget === undefined ? 0 : short));
    if (tallTarget !== undefined) mesh.morphTargetInfluences[tallTarget] = influence * tall;
    if (shortTarget !== undefined) mesh.morphTargetInfluences[shortTarget] = influence * short;
  }
}
