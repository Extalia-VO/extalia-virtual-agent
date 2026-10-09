import { useLayoutEffect, useRef, type ReactNode } from "react";
import type { InstancedMesh, MeshBasicMaterial, MeshStandardMaterial} from "three";
import { Float32BufferAttribute, Group, Matrix4, Mesh, type BufferGeometry, type Material } from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";

/** Batch compatible static scene geometry, preserving exact detail and collision originals. */
export function StaticCampusBatch({ children, followParent = false }: {
  children: ReactNode; followParent?: boolean;
}) {
  const root = useRef<Group>(null);
  useLayoutEffect(() => {
    const parent = root.current;
    if (!parent) return;
    parent.updateWorldMatrix(true, true);
    const inverse = new Matrix4().copy(parent.matrixWorld).invert();
    const buckets = new Map<string, { material: MeshStandardMaterial; meshes: Mesh[]; shapes: BufferGeometry[]; materialDynamic?: string }>();
    parent.traverse(node => {
      const object = node as Mesh;
      if (!object.isMesh || (object as InstancedMesh).isInstancedMesh || !object.visible || Array.isArray(object.material)) return;
      const materialDynamic = typeof object.userData.officeMaterialDynamic === "string"
        ? object.userData.officeMaterialDynamic
        : undefined;
      for (let ancestor = object.parent; ancestor && ancestor !== parent; ancestor = ancestor.parent) {
        if (ancestor.userData.officeDynamic === true) return;
      }
      if (object.userData.officeDynamic === true && !materialDynamic) return;
      const sourceMaterial = object.material as Material;
      const isStandard = (sourceMaterial as MeshStandardMaterial).isMeshStandardMaterial === true;
      const isBasic = (sourceMaterial as MeshBasicMaterial).isMeshBasicMaterial === true;
      // Solar-driven emitters stay live; static emissive and unlit materials can batch safely.
      if ((!isStandard && !isBasic) ||
          object.userData.officeSeat || object.userData.officeSeatStation) return;
      const material = sourceMaterial as MeshStandardMaterial & MeshBasicMaterial;
      const attributes = Object.keys(object.geometry.attributes).filter(name => name !== "color").map(name => { const attr = object.geometry.getAttribute(name); return `${name}:${attr.itemSize}:${attr.normalized}`; }).sort().join(",");
      const physical = material as MeshStandardMaterial & { clearcoat?: number; clearcoatRoughness?: number; ior?: number; sheen?: number };
      const key = [material.type, material.map?.uuid, material.lightMap?.uuid, material.aoMap?.uuid,
        material.specularMap?.uuid, material.alphaMap?.uuid, material.envMap?.uuid,
        material.lightMapIntensity, material.aoMapIntensity,
        materialDynamic, materialDynamic ? [material.color.getHex(), material.vertexColors] : undefined,
        material.userData.officeCeilingSoffit === true,
        material.userData.officeCeilingSampleYOffset,
        material.toneMapped,
        material.side, material.transparent, material.opacity, material.alphaTest, material.depthWrite, material.depthTest,
        material.polygonOffset, material.polygonOffsetFactor, material.polygonOffsetUnits, material.fog,
        isStandard ? [material.emissiveMap?.uuid, material.normalMap?.uuid, material.aoMap?.uuid, material.bumpMap?.uuid,
          material.roughnessMap?.uuid, material.metalnessMap?.uuid, material.bumpScale, material.normalScale.x,
          material.normalScale.y, material.aoMapIntensity, physical.clearcoat, physical.clearcoatRoughness,
          physical.ior, physical.sheen, material.roughness, material.metalness, material.emissive.getHex(),
          material.emissiveIntensity, material.envMapIntensity, material.flatShading] : [material.wireframe,
          material.wireframeLinewidth, material.combine, material.reflectivity, material.refractionRatio],
        object.castShadow, object.receiveShadow, Boolean(object.geometry.index), attributes].join("/");
      const bucket = buckets.get(key) ?? { material, meshes: [], shapes: [], materialDynamic };
      const shape = object.geometry.clone();
      if (materialDynamic) {
        // Keep the original color attributes/material reference so solar prop updates
        // to the first fixture continue to drive the merged surface.
        if (!material.vertexColors) shape.deleteAttribute("color");
      } else {
        // Keep every authored surface color while sharing otherwise identical materials.
        // Three stores material colors in linear space, matching vertex colors.
        const sourceColors = material.vertexColors ? shape.getAttribute("color") : undefined;
        const vertexCount = shape.getAttribute("position").count;
        const colors = new Float32Array(vertexCount * 3);
        for (let i = 0; i < vertexCount; i++) {
          colors[i * 3] = material.color.r * (sourceColors?.getX(i) ?? 1);
          colors[i * 3 + 1] = material.color.g * (sourceColors?.getY(i) ?? 1);
          colors[i * 3 + 2] = material.color.b * (sourceColors?.getZ(i) ?? 1);
        }
        shape.setAttribute("color", new Float32BufferAttribute(colors, 3));
      }
      const transform = new Matrix4().multiplyMatrices(inverse, object.matrixWorld);
      shape.applyMatrix4(transform);
      if (transform.determinant() < 0) {
        // Mirrored facade groups need reversed winding after baking the transform.
        if (!shape.index) shape.setIndex(Array.from({ length: shape.getAttribute("position").count }, (_, i) => i));
        const index = shape.index!;
        for (let i = 0; i < index.count; i += 3) {
          const second = index.getX(i + 1);
          index.setX(i + 1, index.getX(i + 2));
          index.setX(i + 2, second);
        }
      }
      bucket.meshes.push(object);
      bucket.shapes.push(shape);
      buckets.set(key, bucket);
    });
    const batches = new Group();
    const batchMaterials: Material[] = [];
    batches.userData.officePassable = true;
    const hidden: Array<{
      mesh: Mesh;
      matrixAutoUpdate: boolean;
      matrixWorldAutoUpdate: boolean;
      officeBatchSource: unknown;
    }> = [];
    for (const bucket of buckets.values()) {
      if (bucket.shapes.length > 1) {
        const geometry = mergeGeometries(bucket.shapes);
        if (geometry) {
          const material = bucket.materialDynamic ? bucket.material : bucket.material.clone();
          if (!bucket.materialDynamic) {
            material.color.setRGB(1, 1, 1);
            material.vertexColors = true;
            batchMaterials.push(material);
          }
          const mesh = new Mesh(geometry, material);
          mesh.castShadow = bucket.meshes[0]!.castShadow;
          mesh.receiveShadow = bucket.meshes[0]!.receiveShadow;
          batches.add(mesh);
          for (const source of bucket.meshes) {
            hidden.push({
              mesh: source,
              matrixAutoUpdate: source.matrixAutoUpdate,
              matrixWorldAutoUpdate: source.matrixWorldAutoUpdate,
              officeBatchSource: source.userData.officeBatchSource
            });
            source.visible = false;
            source.userData.officeBatchSource = true;
            // Keep collision/source transforms cached without traversing static leaves each frame.
            source.matrixAutoUpdate = false;
            source.matrixWorldAutoUpdate = followParent;
          }
        }
      }
      bucket.shapes.forEach(shape => shape.dispose());
    }
    parent.add(batches);
    batches.updateMatrix();
    batches.updateWorldMatrix(true, true);
    batches.traverse(node => {
      node.matrixAutoUpdate = false;
      node.matrixWorldAutoUpdate = followParent;
    });
    parent.userData.staticBatchStats = { buckets: buckets.size, mergedMeshes: hidden.length, draws: batches.children.length };
    return () => {
      hidden.forEach(({ mesh, matrixAutoUpdate, matrixWorldAutoUpdate, officeBatchSource }) => {
        mesh.visible = true;
        mesh.matrixAutoUpdate = matrixAutoUpdate;
        mesh.matrixWorldAutoUpdate = matrixWorldAutoUpdate;
        if (officeBatchSource === undefined) delete mesh.userData.officeBatchSource;
        else mesh.userData.officeBatchSource = officeBatchSource;
      });
      batches.traverse(object => { if ((object as Mesh).isMesh) (object as Mesh).geometry.dispose(); });
      batchMaterials.forEach(material => material.dispose());
      parent.remove(batches);
    };
  }, [followParent]);
  return <group ref={root} name={followParent ? "moving-assembly-batch" : undefined}>{children}</group>;
}
