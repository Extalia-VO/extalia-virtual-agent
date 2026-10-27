import { Float32BufferAttribute, Matrix4, type BufferGeometry, type Group, type Mesh, type MeshStandardMaterial } from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

/** Bake one chair into a vertex-colored instance, retaining Blender's smooth normals. */
export function mergeChair(root: Group): BufferGeometry | null {
  root.updateWorldMatrix(true, true);
  const inverse = new Matrix4().copy(root.matrixWorld).invert();
  const parts: BufferGeometry[] = [];
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const source = mesh.geometry;
    const shape = source.index ? source.toNonIndexed() : source.clone();
    // Exporters may add UVs/tangents to only some parts. Every merged part has the same schema.
    for (const attribute of Object.keys(shape.attributes)) {
      if (attribute !== 'position' && attribute !== 'normal') shape.deleteAttribute(attribute);
    }
    if (!shape.hasAttribute('normal')) shape.computeVertexNormals();
    shape.applyMatrix4(new Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    const count = shape.getAttribute('position').count;
    const colors = new Float32Array(count * 3);
    const paint = (start: number, end: number, materialIndex: number) => {
      const color = (materials[materialIndex] as MeshStandardMaterial | undefined)?.color;
      for (let i = start; i < Math.min(end, count); i++) {
        colors[i * 3] = color?.r ?? 1;
        colors[i * 3 + 1] = color?.g ?? 1;
        colors[i * 3 + 2] = color?.b ?? 1;
      }
    };
    paint(0, count, 0);
    if (Array.isArray(mesh.material)) for (const group of source.groups) paint(group.start, group.start + group.count, group.materialIndex ?? 0);
    shape.setAttribute('color', new Float32BufferAttribute(colors, 3));
    shape.clearGroups();
    parts.push(shape);
  });
  const merged = parts.length ? mergeGeometries(parts) : null;
  for (const part of parts) part.dispose();
  merged?.computeBoundingBox();
  merged?.computeBoundingSphere();
  return merged;
}
