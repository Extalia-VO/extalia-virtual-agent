import type { BufferGeometry, Material, Mesh, Object3D, Skeleton, SkinnedMesh } from 'three';

const ownedGeometry = new WeakMap<Object3D, Set<BufferGeometry>>();

/** Register only fresh, uncached geometry created for this particular clone. */
export function ownAvatarCloneGeometry(root: Object3D, geometry: BufferGeometry): void {
  let geometries = ownedGeometry.get(root);
  if (!geometries) { geometries = new Set(); ownedGeometry.set(root, geometries); }
  geometries.add(geometry);
}

/**
 * Body/hair clones own their materials and skeletons, including outfit bindings.
 * Geometry and material maps can belong to the shared asset caches. Geometry
 * is released only when explicitly registered as private to this clone.
 */
export function disposeAvatarClone(root: Object3D): void {
  const materials = new Set<Material>(), skeletons = new Set<Skeleton>(), geometries = new Set<BufferGeometry>();
  const privateGeometry = ownedGeometry.get(root);
  root.traverse(child => {
    const mesh = child as Mesh;
    if (!mesh.isMesh) return;
    if (privateGeometry?.has(mesh.geometry)) geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) materials.add(material);
    const skin = child as SkinnedMesh;
    if (skin.isSkinnedMesh && skin.skeleton) skeletons.add(skin.skeleton);
  });
  for (const material of materials) material.dispose();
  for (const geometry of geometries) geometry.dispose();
  // A lining can share its body's skeleton. Dispose each instance once per
  // cleanup, but permit a later cleanup after StrictMode recreates its texture.
  for (const skeleton of skeletons) skeleton.dispose();
}
