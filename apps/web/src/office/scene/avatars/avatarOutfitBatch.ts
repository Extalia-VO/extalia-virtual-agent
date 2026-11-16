import { MeshStandardMaterial, type BufferAttribute, type BufferGeometry, type Material, type SkinnedMesh } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** The fitted-outfit exporter labels a material's primitive/source slot P<n>S<n>.
 * Only those suffixes are interchangeable: OriginalTop and OriginalBottom still
 * select different palette/coverage zones. Unknown artist names stay separate. */
export function fittedMaterialSemantic(name: string): string | undefined {
  return /^(Original(?:Top|Bottom|Outer|Accent|Shoes))_P\d+S\d+$/.exec(name)?.[1];
}

// Identically corrected inputs can recur across many instances of one outfit.
// Cache the merged buffers by source identity without retaining an unloaded asset.
type GeometryCache = { next: WeakMap<BufferGeometry, GeometryCache>; merged?: BufferGeometry };
const outfitGeometry: GeometryCache = { next: new WeakMap() };

const ignoredMaterialFields = new Set(['uuid', 'name', 'version', '_listeners']);
const materialFields = (material: Material) => Object.fromEntries(
  Object.entries(material).filter(([key]) => !ignoredMaterialFields.has(key)),
);

function equalValue(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object'
    || Object.getPrototypeOf(a) !== Object.getPrototypeOf(b)) return false;
  // Shared maps keep their complete sampler/image state; different texture
  // objects, shader callbacks and other opaque resources are never substituted.
  if ('isTexture' in a || 'isTexture' in b) return false;
  if (ArrayBuffer.isView(a) || ArrayBuffer.isView(b)) {
    if (!ArrayBuffer.isView(a) || !ArrayBuffer.isView(b) || a.byteLength !== b.byteLength) return false;
    const left = new Uint8Array(a.buffer, a.byteOffset, a.byteLength), right = new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
    return left.every((value, index) => value === right[index]);
  }
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key)
    && equalValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key]));
}

function sameMaterial(a: Material, b: Material): boolean {
  const semantic = fittedMaterialSemantic(a.name);
  if (!(a instanceof MeshStandardMaterial) || !(b instanceof MeshStandardMaterial)
    || a.type !== 'MeshStandardMaterial' || b.type !== 'MeshStandardMaterial'
    || a.transparent || b.transparent
    || !semantic || semantic !== fittedMaterialSemantic(b.name)
    || a.onBeforeCompile !== b.onBeforeCompile || a.customProgramCacheKey !== b.customProgramCacheKey) return false;
  // Compare actual loaded material fields, including extras/userData, extensions,
  // maps, defines, blending, alpha/depth state and all physical material values.
  return equalValue(materialFields(a), materialFields(b));
}

function sameAttribute(a: BufferAttribute, b: BufferAttribute): boolean {
  return !('isInterleavedBufferAttribute' in a) && !('isInterleavedBufferAttribute' in b)
    && !('isInstancedBufferAttribute' in a) && !('isInstancedBufferAttribute' in b)
    && a.itemSize === b.itemSize && a.normalized === b.normalized && a.array.constructor === b.array.constructor
    && a.usage === b.usage && a.gpuType === b.gpuType && a.name === b.name;
}

function sameGeometryLayout(a: BufferGeometry, b: BufferGeometry): boolean {
  if (Boolean(a.index) !== Boolean(b.index) || a.groups.length || b.groups.length
    || a.drawRange.start !== 0 || b.drawRange.start !== 0
    || a.drawRange.count < (a.index?.count ?? a.attributes.position?.count ?? Infinity)
    || b.drawRange.count < (b.index?.count ?? b.attributes.position?.count ?? Infinity)
    || a.morphTargetsRelative !== b.morphTargetsRelative || !equalValue(a.userData, b.userData)) return false;
  const attributes = Object.keys(a.attributes), morphs = Object.keys(a.morphAttributes);
  return attributes.length === Object.keys(b.attributes).length
    && attributes.every(key => b.attributes[key] && sameAttribute(a.attributes[key] as BufferAttribute, b.attributes[key] as BufferAttribute))
    && morphs.length === Object.keys(b.morphAttributes).length
    && morphs.every(key => {
      const left = a.morphAttributes[key as keyof typeof a.morphAttributes], right = b.morphAttributes[key as keyof typeof b.morphAttributes];
      return left && right && left.length === right.length && left.every((attribute, i) => sameAttribute(attribute as BufferAttribute, right[i] as BufferAttribute));
    });
}

function compatible(a: SkinnedMesh, b: SkinnedMesh): boolean {
  return a.parent === b.parent && a.name === b.name && !a.children.length && !b.children.length
    && !Array.isArray(a.material) && !Array.isArray(b.material)
    && sameMaterial(a.material, b.material) && a.skeleton === b.skeleton
    && a.bindMode === b.bindMode && a.bindMatrix.equals(b.bindMatrix) && a.bindMatrixInverse.equals(b.bindMatrixInverse)
    && a.matrix.equals(b.matrix) && a.matrixAutoUpdate === b.matrixAutoUpdate && a.matrixWorldAutoUpdate === b.matrixWorldAutoUpdate
    && a.visible === b.visible && a.castShadow === b.castShadow && a.receiveShadow === b.receiveShadow
    && a.renderOrder === b.renderOrder && a.frustumCulled === b.frustumCulled && a.layers.mask === b.layers.mask
    && a.onBeforeRender === b.onBeforeRender && a.onAfterRender === b.onAfterRender
    && a.onBeforeShadow === b.onBeforeShadow && a.onAfterShadow === b.onAfterShadow
    && a.customDepthMaterial === b.customDepthMaterial && a.customDistanceMaterial === b.customDistanceMaterial
    && equalValue(a.userData, b.userData) && equalValue(a.morphTargetDictionary, b.morphTargetDictionary)
    && equalValue(a.morphTargetInfluences, b.morphTargetInfluences) && sameGeometryLayout(a.geometry, b.geometry);
}

/** Only freshly attached, clone-owned fitted outfit meshes may enter here.
 * Source library meshes/body/face are deliberately outside this API's scope.
 * The immutable merged buffers are shared like the original library geometry.
 * Each avatar keeps its own meshes, materials, skeleton and morph controls. */
export function batchFittedOutfitMeshes(meshes: readonly SkinnedMesh[]): SkinnedMesh[] {
  const groups: SkinnedMesh[][] = [];
  for (const mesh of meshes) {
    const group = groups.find(items => compatible(items[0]!, mesh));
    if (group) group.push(mesh); else groups.push([mesh]);
  }
  const merged: SkinnedMesh[] = [];
  for (const group of groups) {
    if (group.length < 2) continue;
    const first = group[0]!, inputs = group.map(mesh => mesh.geometry);
    let cache = outfitGeometry;
    for (const input of inputs) {
      let child = cache.next.get(input);
      if (!child) { child = { next: new WeakMap() }; cache.next.set(input, child); }
      cache = child;
    }
    let geometry = cache.merged;
    if (!geometry) {
      geometry = mergeGeometries(inputs, false) ?? undefined;
      if (!geometry) continue;
      geometry.name = first.geometry.name;
      geometry.userData = structuredClone(first.geometry.userData);
      for (const [name, attribute] of Object.entries(geometry.attributes)) {
        const original = first.geometry.attributes[name] as BufferAttribute;
        attribute.name = original.name;
        (attribute as BufferAttribute).setUsage(original.usage);
        (attribute as BufferAttribute).gpuType = original.gpuType;
      }
      geometry.computeBoundingBox(); geometry.computeBoundingSphere();
      cache.merged = geometry;
    }
    first.geometry = geometry;
    const retainedMaterial = first.material;
    const releasedMaterials = new Set<Material>();
    for (const mesh of group.slice(1)) {
      mesh.removeFromParent();
      // Per-instance cloned materials have no remaining users. Their maps stay
      // library-owned; Material.dispose does not release those textures.
      if (!Array.isArray(mesh.material) && mesh.material !== retainedMaterial && !releasedMaterials.has(mesh.material)) {
        mesh.material.dispose(); releasedMaterials.add(mesh.material);
      }
    }
    merged.push(first);
  }
  return merged;
}
