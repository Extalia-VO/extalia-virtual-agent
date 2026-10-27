import { useEffect, useSyncExternalStore } from "react";
import {
  Float32BufferAttribute,
  Matrix4,
  type BufferGeometry,
  type Material,
  type Mesh,
  type Object3D,
  type Texture
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { DISTRICT_BUILDINGS } from "./CampusSkyline";

export interface DistrictModelBatch {
  facade: BufferGeometry;
  solid: BufferGeometry;
  crown: BufferGeometry;
  foliage: BufferGeometry;
}

const urls = import.meta.glob<string>("/local-assets/landscape/district-buildings.glb", {
  eager: true,
  query: "?url",
  import: "default"
});
const forceProcedural =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("district") === "procedural";

let cached: DistrictModelBatch | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function normalizeColorAttribute(geometry: BufferGeometry, fallbackR = 1, fallbackG = 1, fallbackB = 1) {
  const count = geometry.getAttribute("position").count;
  const source = geometry.getAttribute("color");
  const rgb = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    rgb[i * 3] = source ? source.getX(i) : fallbackR;
    rgb[i * 3 + 1] = source ? source.getY(i) : fallbackG;
    rgb[i * 3 + 2] = source ? source.getZ(i) : fallbackB;
  }
  geometry.setAttribute("color", new Float32BufferAttribute(rgb, 3));
}

/** Bake all 12 Blender-authored surrounding district buildings into 4 world-space role geometries. */
export function bakeDistrictModelBatch(scene: Object3D): DistrictModelBatch | null {
  scene.updateWorldMatrix(true, true);
  const facadeShapes: BufferGeometry[] = [];
  const solidShapes: BufferGeometry[] = [];
  const crownShapes: BufferGeometry[] = [];
  const foliageShapes: BufferGeometry[] = [];
  const offset = new Matrix4();
  const releaseShapes = () => {
    [...facadeShapes, ...solidShapes, ...crownShapes, ...foliageShapes].forEach((geometry) => geometry.dispose());
  };

  for (let index = 0; index < DISTRICT_BUILDINGS.length; index++) {
    const spec = DISTRICT_BUILDINGS[index]!;
    const root = scene.getObjectByName(`district-${index}`);
    if (!root) {
      releaseShapes();
      return null;
    }
    const seed = 101 + index * 3.7;
    offset.makeTranslation(spec.x, 0, spec.z);

    root.traverse((node) => {
      const mesh = node as Mesh;
      if (!mesh.isMesh) return;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as Material & {
        color?: { r: number; g: number; b: number };
      };
      const name = mat?.name ?? "";
      const shape = mesh.geometry.clone();
      shape.applyMatrix4(mesh.matrixWorld);
      shape.applyMatrix4(offset);
      shape.deleteAttribute("uv");
      shape.deleteAttribute("tangent");
      normalizeColorAttribute(shape, mat?.color?.r ?? 1, mat?.color?.g ?? 1, mat?.color?.b ?? 1);

      const count = shape.getAttribute("position").count;
      if (/facade glazing/i.test(name)) {
        const seeds = new Float32Array(count);
        seeds.fill(seed);
        shape.setAttribute("aSeed", new Float32BufferAttribute(seeds, 1));
        facadeShapes.push(shape);
      } else if (/crown light/i.test(name)) {
        crownShapes.push(shape);
      } else if (/terrace foliage/i.test(name)) {
        foliageShapes.push(shape);
      } else {
        solidShapes.push(shape);
      }
    });
  }

  if (!facadeShapes.length || !solidShapes.length || !crownShapes.length) {
    releaseShapes();
    return null;
  }

  const facade = mergeGeometries(facadeShapes, false);
  const solid = mergeGeometries(solidShapes, false);
  const crown = mergeGeometries(crownShapes, false);
  const foliage = foliageShapes.length ? mergeGeometries(foliageShapes, false) : null;
  releaseShapes();

  if (!facade || !solid || !crown || !foliage) {
    facade?.dispose();
    solid?.dispose();
    crown?.dispose();
    foliage?.dispose();
    return null;
  }

  for (const geometry of [facade, solid, crown, foliage]) {
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }
  return { facade, solid, crown, foliage };
}

function disposeImportedScene(scene: Object3D): void {
  const geometries = new Set<BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  scene.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      materials.add(material);
      for (const value of Object.values(material)) {
        if (value && typeof value === "object" && (value as Texture).isTexture) {
          textures.add(value as Texture);
        }
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}

async function load(): Promise<void> {
  if (requested) return;
  requested = true;
  const url = forceProcedural ? undefined : urls["/local-assets/landscape/district-buildings.glb"];
  if (!url) return;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    try {
      cached = bakeDistrictModelBatch(gltf.scene);
    } finally {
      disposeImportedScene(gltf.scene);
    }
  } catch {
    cached = null;
  } finally {
    listeners.forEach((listener) => listener());
  }
}

/** Shared renderer-lifetime district batch; null falls back to procedural district instancing. */
export function useDistrictBuildingModels(): DistrictModelBatch | null {
  const batch = useSyncExternalStore(subscribe, () => cached, () => null);
  useEffect(() => {
    void load();
  }, []);
  return batch;
}
