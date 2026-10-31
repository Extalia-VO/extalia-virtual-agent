import { useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import {
  Box3,
  Color,
  Float32BufferAttribute,
  Vector3,
  type BufferGeometry,
  type Material,
  type Mesh,
  type MeshStandardMaterial,
  type Object3D
} from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import { useSolarEnvironment } from "./Environment";

export const EXTERIOR_MODELS = [
  "exterior-shade-tree",
  "exterior-ornamental-tree",
  "exterior-shrub",
  "exterior-lavender",
  "exterior-garden-planter",
  "exterior-garden-seat",
  "exterior-park-bench",
  "exterior-plinth-bench",
  "exterior-picnic-table",
  "exterior-picnic-bench",
  "exterior-parasol",
  "exterior-patio-table",
  "exterior-patio-chair",
  "exterior-walk-lamp",
  "exterior-bollard-light",
  "exterior-tree-uplight",
  "exterior-wayfinding-pylon",
  "exterior-cafe-kiosk",
  "exterior-cafe-deck",
  "exterior-festoon-mast",
  "exterior-bike-rack",
  "exterior-bicycle",
  "exterior-garden-decor",
  "exterior-columnar-tree",
  "exterior-blossom-tree",
  "exterior-flower-bed",
  "exterior-tropical-cluster",
  "exterior-garden-pond",
  "exterior-garden-pergola",
  "exterior-canopy-cluster",
  "exterior-grass-tuft"
] as const;

export type ExteriorModel = (typeof EXTERIOR_MODELS)[number];

const urls = import.meta.glob<string>("/public-assets/landscape/exterior-landscape.glb", {
  eager: true,
  query: "?url",
  import: "default"
});
const procedural =
  typeof location !== "undefined" &&
  new URLSearchParams(location.search).get("exteriors") === "procedural";

export interface ExteriorInstancedGeometries {
  trunk: BufferGeometry;
  canopy: BufferGeometry;
  bench: BufferGeometry;
  lamp: BufferGeometry;
  lampOptics?: BufferGeometry;
}

let library: ReadonlyMap<string, Object3D> | null = null;
let instancedGeometries: ExteriorInstancedGeometries | null = null;
let displayGeometries: ReadonlyMap<ExteriorModel, BufferGeometry> | null = null;
let requested = false;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};

function mergeModelMeshes(
  root: Object3D,
  predicate?: (mesh: Mesh, materialName: string) => boolean
): BufferGeometry | null {
  root.updateWorldMatrix(true, true);
  const invRoot = root.matrixWorld.clone().invert();
  const shapes: BufferGeometry[] = [];
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as
      | Material
      | undefined;
    const matName = mat?.name ?? "";
    if (predicate && !predicate(mesh, matName)) return;
    const raw = mesh.geometry.clone();
    const shape = raw.index ? raw.toNonIndexed() : raw;
    if (shape !== raw) raw.dispose();
    shape.applyMatrix4(invRoot.clone().multiply(mesh.matrixWorld));
    for (const key of Object.keys(shape.attributes)) {
      if (key !== "position" && key !== "normal") {
        shape.deleteAttribute(key);
      }
    }
    shapes.push(shape);
  });
  if (shapes.length === 0) return null;
  const merged = mergeGeometries(shapes, false);
  shapes.forEach((s) => s.dispose());
  return merged ?? null;
}

/** Extract normalized unit geometries from the Blender library for instanced boulevard/park batches. */
export function bakeExteriorInstancedGeometries(
  scene: Object3D
): ExteriorInstancedGeometries | null {
  const shadeTree = scene.getObjectByName("exterior-shade-tree");
  const shrub = scene.getObjectByName("exterior-shrub");
  const parkBench = scene.getObjectByName("exterior-park-bench");
  const walkLamp = scene.getObjectByName("exterior-walk-lamp");
  if (!shadeTree || !shrub || !parkBench || !walkLamp) return null;

  const trunk = mergeModelMeshes(
    shadeTree,
    (mesh, matName) => /bark|trunk|flare|limb/i.test(matName) || /trunk|flare|limb/i.test(mesh.name)
  );
  const canopy = mergeModelMeshes(scene.getObjectByName("exterior-canopy-cluster") ?? shrub);
  const bench = mergeModelMeshes(parkBench);
  const lamp = mergeModelMeshes(walkLamp, (_mesh, name) => !/exterior lamp diffuser/i.test(name));
  const lampOptics = mergeModelMeshes(walkLamp, (_mesh, name) => /exterior lamp diffuser/i.test(name));
  if (!trunk || !canopy || !bench || !lamp) {
    trunk?.dispose();
    canopy?.dispose();
    bench?.dispose();
    lamp?.dispose();
    lampOptics?.dispose();
    return null;
  }

  // Normalize trunk: base at y=0, main fork/shaft normalized to unit height & radius for instanced scaling.
  trunk.computeBoundingBox();
  if (trunk.boundingBox) {
    trunk.translate(0, -trunk.boundingBox.min.y, 0);
  }
  trunk.scale(1 / 0.21, 1 / 3.4, 1 / 0.21);
  trunk.computeBoundingBox();
  trunk.computeBoundingSphere();

  // Normalize canopy: multi-mound botanical cluster centered at origin spanning [-1, 1] on each axis.
  canopy.computeBoundingBox();
  if (canopy.boundingBox) {
    const center = new Vector3();
    const size = new Vector3();
    canopy.boundingBox.getCenter(center);
    canopy.boundingBox.getSize(size);
    canopy.translate(-center.x, -center.y, -center.z);
    canopy.scale(
      size.x > 0 ? 2 / size.x : 1,
      size.y > 0 ? 2 / size.y : 1,
      size.z > 0 ? 2 / size.z : 1
    );
  }
  canopy.computeBoundingBox();
  canopy.computeBoundingSphere();

  // Normalize park bench to match CivicForecourtPark instance transforms (sx=1.4, sy=0.35, sz=0.5, y=+0.16).
  bench.computeBoundingBox();
  if (bench.boundingBox) {
    const box = new Box3().copy(bench.boundingBox);
    bench.translate(0, -box.min.y, 0);
    bench.scale(1 / 1.4, 1 / 0.35, 1 / 0.5);
    bench.translate(0, -0.46, 0);
  }
  bench.computeBoundingBox();
  bench.computeBoundingSphere();

  // Both lamp batches share the full fixture frame, so the night optics remain
  // aligned when Civic/Skyline callers scale the pole to their authored heights.
  const lampBounds = new Box3().setFromObject(walkLamp);
  const lampHeight = Math.max(0.1, lampBounds.max.y - lampBounds.min.y);
  for (const geometry of [lamp, lampOptics]) {
    if (!geometry) continue;
    geometry.translate(0, -lampBounds.min.y, 0);
    geometry.scale(1 / 0.12, 1 / lampHeight, 1 / 0.12);
    geometry.translate(0, -0.5, 0);
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
  }

  return { trunk, canopy, bench, lamp, ...(lampOptics ? { lampOptics } : {}) };
}

/** Opaque foreground botanical parts share one draw per species while retaining Blender material colours. */
export const EXTERIOR_DISPLAY_MODELS = [
  "exterior-columnar-tree", "exterior-blossom-tree", "exterior-flower-bed",
  "exterior-tropical-cluster", "exterior-grass-tuft"
] as const satisfies readonly ExteriorModel[];

export function bakeExteriorDisplayGeometry(root: Object3D): BufferGeometry | null {
  root.updateWorldMatrix(true, true);
  const inverse = root.matrixWorld.clone().invert();
  const shapes: BufferGeometry[] = [];
  const color = new Color();
  root.traverse(node => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const material = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as MeshStandardMaterial;
    // These display parts are opaque botanics, never glass or lit fixture optics.
    const raw = mesh.geometry.clone();
    const shape = raw.index ? raw.toNonIndexed() : raw;
    if (shape !== raw) raw.dispose();
    shape.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
    const count = shape.getAttribute("position").count;
    const colors = new Float32Array(count * 3);
    color.copy(material.color ?? new Color("#ffffff"));
    for (let i = 0; i < count; i++) color.toArray(colors, i * 3);
    for (const attribute of Object.keys(shape.attributes)) {
      if (attribute !== "position" && attribute !== "normal") shape.deleteAttribute(attribute);
    }
    shape.setAttribute("color", new Float32BufferAttribute(colors, 3));
    shapes.push(shape);
  });
  if (!shapes.length) return null;
  const geometry = mergeGeometries(shapes, false);
  shapes.forEach(shape => shape.dispose());
  geometry?.computeBoundingBox();
  geometry?.computeBoundingSphere();
  return geometry;
}

export function useExteriorDisplayGeometries(): ReadonlyMap<ExteriorModel, BufferGeometry> | null {
  const geometries = useSyncExternalStore(subscribe, () => displayGeometries, () => null);
  useEffect(() => { void load(); }, []);
  return geometries;
}

async function load() {
  const url = procedural ? undefined : urls["/public-assets/landscape/exterior-landscape.glb"];
  if (!url || requested) return;
  requested = true;
  try {
    const gltf = await new GLTFLoader().loadAsync(url);
    library = new Map(
      EXTERIOR_MODELS.flatMap((name) => {
        const node = gltf.scene.getObjectByName(name);
        return node ? [[name, node] as const] : [];
      })
    );
    instancedGeometries = bakeExteriorInstancedGeometries(gltf.scene);
    displayGeometries = new Map(EXTERIOR_DISPLAY_MODELS.flatMap(name => {
      const root = gltf.scene.getObjectByName(name);
      const geometry = root ? bakeExteriorDisplayGeometry(root) : null;
      return geometry ? [[name, geometry] as const] : [];
    }));
  } catch {
    /* A missing local library keeps the complete procedural exterior landscape and furniture. */
  }
  listeners.forEach((listener) => listener());
}

/** Shared Blender unit geometries for instanced boulevard, park, and skyline foliage/furniture batches. */
export function useExteriorInstancedGeometries(): ExteriorInstancedGeometries | null {
  const batch = useSyncExternalStore(subscribe, () => instancedGeometries, () => null);
  useEffect(() => {
    void load();
  }, []);
  return batch;
}

export interface ExteriorInstance {
  root: Object3D;
  owned: Material[];
  lamps: MeshStandardMaterial[];
}

/** Share immutable Blender geometry and materials while isolating per-instance tint and lamp emission. */
export function createExteriorInstance(source: Object3D, canopyColor?: string): ExteriorInstance {
  const root = source.clone(true);
  const owned: Material[] = [];
  const lamps: MeshStandardMaterial[] = [];
  const swaps = new Map<Material, Material>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const replace = (material: Material) => {
      const cached = swaps.get(material);
      if (cached) return cached;
      const lamp = /exterior lamp diffuser/i.test(material.name);
      const tint =
        canopyColor !== undefined && /parasol canvas|bicycle frame/i.test(material.name);
      const glass = material.transparent;
      if (!lamp && !tint && !glass) return material;
      const copy = material.clone() as MeshStandardMaterial;
      if (tint) copy.color.set(canopyColor);
      if (glass) copy.depthWrite = false;
      if (lamp) lamps.push(copy);
      swaps.set(material, copy);
      owned.push(copy);
      return copy;
    };
    mesh.material = Array.isArray(mesh.material)
      ? mesh.material.map(replace)
      : replace(mesh.material);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    mesh.castShadow = !materials.every((m) => m.transparent);
    mesh.receiveShadow = true;
  });
  return { root, owned, lamps };
}

export function updateExteriorEmission(
  instance: Pick<ExteriorInstance, "lamps">,
  factor: number
): void {
  const intensity = factor > 0.02 ? 0.45 + factor * 3.2 : 0;
  for (const lamp of instance.lamps) {
    lamp.emissiveIntensity = intensity;
  }
}

function ExteriorEmission({ instance }: { instance: ExteriorInstance }) {
  const { state } = useSolarEnvironment();
  const factor = state.factors.exteriorLightFactor;
  useEffect(() => {
    updateExteriorEmission(instance, factor);
  }, [instance, factor]);
  return null;
}

/** Named Blender exterior part with a complete procedural fallback. */
export function ExteriorPart({
  model,
  children,
  position,
  modelScale,
  canopyColor
}: {
  model: ExteriorModel;
  children?: ReactNode;
  position?: readonly [number, number, number];
  modelScale?: readonly [number, number, number];
  canopyColor?: string;
}) {
  const assets = useSyncExternalStore(subscribe, () => library, () => null);
  useEffect(() => {
    void load();
  }, []);
  const source = assets?.get(model);
  const instance = useMemo(
    () => (source ? createExteriorInstance(source, canopyColor) : null),
    [source, canopyColor]
  );
  useEffect(
    () => () => {
      instance?.owned.forEach((material) => material.dispose());
    },
    [instance]
  );
  return (
    <group
      name={`exterior-part-${model}`}
      position={position ? [...position] : [0, 0, 0]}
      userData={{ officeDynamic: true, exteriorModel: model, exteriorAuthored: !!instance }}
    >
      {instance ? (
        <>
          <group scale={modelScale ? [...modelScale] : [1, 1, 1]}>
            <primitive object={instance.root} dispose={null} />
          </group>
          {instance.lamps.length > 0 && <ExteriorEmission instance={instance} />}
        </>
      ) : (
        children
      )}
    </group>
  );
}
