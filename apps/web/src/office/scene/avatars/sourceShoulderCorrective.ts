import { Matrix4, Vector3, type Mesh, type Object3D } from 'three';

interface ShoulderTarget { mesh: Mesh; index: number; degrees: number }
export interface ShoulderCorrectiveBinding {
  chest: Object3D;
  upper: Object3D;
  elbow: Object3D;
  restDirection: Vector3;
  targets: ShoulderTarget[];
}
type BoneLookup = ReadonlyMap<string, { bone: Object3D }>;
const radiansToDegrees = 180 / Math.PI;

/** Optional authored shoulder banks; unrelated body/facial targets stay independent. */
export function shoulderCorrectiveBindings(meshes: readonly Mesh[], bones: BoneLookup): ShoulderCorrectiveBinding[] {
  const chest = bones.get('chest')?.bone;
  if (!chest) return [];
  chest.updateWorldMatrix(true, false);
  if (!Number.isFinite(chest.matrixWorld.determinant()) || Math.abs(chest.matrixWorld.determinant()) < 1e-12) return [];
  const inverse = chest.matrixWorld.clone().invert(), bindings: ShoulderCorrectiveBinding[] = [];
  for (const side of ['Left', 'Right'] as const) {
    const prefix = side.toLowerCase(), upper = bones.get(`${prefix}UpperArm`)?.bone, elbow = bones.get(`${prefix}LowerArm`)?.bone;
    if (!upper || !elbow) continue;
    const restDirection = elbow.getWorldPosition(new Vector3()).sub(upper.getWorldPosition(new Vector3()));
    if (!restDirection.toArray().every(Number.isFinite) || restDirection.lengthSq() < 1e-12) continue;
    restDirection.transformDirection(inverse);
    for (const mesh of meshes) {
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      if (!materials.some(material => material.name.startsWith('Original'))) continue;
      const position = mesh.geometry.getAttribute('position'), targets: ShoulderTarget[] = [];
      const aliases = Object.entries(mesh.morphTargetDictionary ?? {}).filter(([name]) => /^ExtaliaShoulder(?:Left|Right)_/.test(name));
      for (const [name, index] of Object.entries(mesh.morphTargetDictionary ?? {})) {
        const match = new RegExp(`^ExtaliaShoulder${side}_(\\d+(?:\\.\\d+)?)$`).exec(name);
        const degrees = Number(match?.[1]), attribute = mesh.geometry.morphAttributes.position?.[index];
        if (!match || !Number.isFinite(degrees) || degrees < 30 || degrees > 180 || !Number.isInteger(index) || index < 0
          || index >= (mesh.morphTargetInfluences?.length ?? 0) || !position || !attribute || attribute.itemSize !== 3 || attribute.count !== position.count) continue;
        if (aliases.filter(([, other]) => other === index).length !== 1) continue;
        targets.push({ mesh, index, degrees });
      }
      targets.sort((a, b) => a.degrees - b.degrees);
      if (!targets.length || new Set(targets.map(target => target.index)).size !== targets.length
        || new Set(targets.map(target => target.degrees)).size !== targets.length) continue;
      bindings.push({ chest, upper, elbow, restDirection: restDirection.clone(), targets });
    }
  }
  return bindings;
}

const inverseChest = new Matrix4(), direction = new Vector3(), upperPosition = new Vector3();

/** Measure the completed arm solve in the chest frame, cancelling root scale/rotation. */
export function applyShoulderCorrectives(bindings: readonly ShoulderCorrectiveBinding[]): void {
  for (const binding of bindings) {
    const { chest, upper, elbow, targets, restDirection } = binding;
    for (const target of targets) target.mesh.morphTargetInfluences![target.index] = 0;
    chest.updateWorldMatrix(true, false);
    if (!Number.isFinite(chest.matrixWorld.determinant()) || Math.abs(chest.matrixWorld.determinant()) < 1e-12) continue;
    elbow.getWorldPosition(direction).sub(upper.getWorldPosition(upperPosition));
    if (direction.lengthSq() < 1e-12) continue;
    direction.transformDirection(inverseChest.copy(chest.matrixWorld).invert());
    const degrees = Math.acos(Math.max(-1, Math.min(1, direction.dot(restDirection)))) * radiansToDegrees;
    if (!Number.isFinite(degrees)) continue;
    let previous: ShoulderTarget | undefined;
    let previousAngle = targets[0]!.degrees === 30 ? 20 : 30;
    if (degrees <= previousAngle) continue;
    let interpolated = false;
    for (const target of targets) {
      if (degrees <= target.degrees) {
        const blend = Math.max(0, Math.min(1, (degrees - previousAngle) / (target.degrees - previousAngle)));
        if (previous) previous.mesh.morphTargetInfluences![previous.index] = 1 - blend;
        target.mesh.morphTargetInfluences![target.index] = blend;
        interpolated = true;
        break;
      }
      previous = target; previousAngle = target.degrees;
    }
    if (!interpolated) targets.at(-1)!.mesh.morphTargetInfluences![targets.at(-1)!.index] = 1;
  }
}
