import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { DISTRICT_BUILDINGS } from "../../apps/web/src/office/scene/CampusSkyline";
import { bakeDistrictModelBatch } from "../../apps/web/src/office/scene/districtBuildingModels";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { Box3, BufferGeometry, Group, Mesh, Raycaster, Vector3 } = await import(webRequire.resolve("three"));
const { GLTFLoader } = await import(webRequire.resolve("three/examples/jsm/loaders/GLTFLoader.js"));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>["parseAsync"]>>["scene"];

const localFile = new URL("../../apps/web/local-assets/landscape/district-buildings.glb", import.meta.url);
const manifestFile = new URL("../../apps/web/local-assets/landscape/district-buildings.manifest.json", import.meta.url);
const materialName = (object: unknown) => {
  if (!(object instanceof Mesh)) return undefined;
  return Array.isArray(object.material) ? object.material[0]?.name : object.material.name;
};

describe.skipIf(!existsSync(localFile))("actual local Blender surrounding district buildings library", () => {
  let scene: Scene;
  const asset = (name: string) => {
    const root = scene.getObjectByName(name);
    if (!root) throw new Error(`Missing district building asset ${name}`);
    return root;
  };
  const bounds = (name: string) => new Box3().setFromObject(asset(name));

  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, "")).scene;
    scene.updateWorldMatrix(true, true);
  });

  it("exports all 12 district buildings at origin within the 35k triangle budget", () => {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    expect(Object.keys(manifest.groups)).toHaveLength(DISTRICT_BUILDINGS.length);
    let triangles = 0;
    for (let i = 0; i < DISTRICT_BUILDINGS.length; i++) {
      const name = `district-${i}`;
      const spec = DISTRICT_BUILDINGS[i]!;
      const root = asset(name);
      const box = bounds(name);
      const expected = manifest.groups[name];
      expect(root.position.length(), name).toBeLessThan(1e-6);
      expect(root.scale.toArray(), name).toEqual([1, 1, 1]);
      let partTriangles = 0;
      root.traverse((node: Scene) => {
        if ("geometry" in node) {
          partTriangles += (node.geometry.index?.count ?? node.geometry.getAttribute("position").count) / 3;
          expect(node.geometry.getAttribute("color"), `${name} vertex colors`).toBeDefined();
        }
      });
      expect(partTriangles, name).toBe(expected.triangles);
      triangles += partTriangles;
      expect(box.min.y, `${name} ground contact`).toBeCloseTo(-0.8, 2);
      expect(box.max.y, `${name} height`).toBeGreaterThanOrEqual(spec.h);
    }
    expect(triangles).toBe(manifest.triangles);
    expect(triangles).toBeLessThanOrEqual(35_000);
  });

  it("adds real overview-facing window relief and recessed lobby glazing to every nearby building", () => {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    for (let i = 0; i < DISTRICT_BUILDINGS.length; i++) {
      const name = `district-${i}`;
      const detail = manifest.groups[name];
      expect(detail.detailed_elevations, name).toEqual(["west", "south"]);
      expect(detail.facade_detail.mullions, name).toBeGreaterThan(8);
      expect(detail.facade_detail.transoms, name).toBeGreaterThan(8);
      expect(detail.facade_detail.lobby_panels, name).toBe(1);
    }
    // Test exported geometry, not just the manifest: a physical mullion projects
    // in front of the glass while a neighbouring pane remains recessed.
    const root = asset("district-1");
    const ray = new Raycaster(new Vector3(-30, 20, 0), new Vector3(1, 0, 0));
    const hits = ray.intersectObject(root, true);
    const solid = hits.find(hit => materialName(hit.object) === "District architectural solid");
    const glass = hits.find(hit => materialName(hit.object) === "District facade glazing");
    expect(solid).toBeDefined();
    expect(glass).toBeDefined();
    expect(solid!.distance).toBeLessThan(glass!.distance - .1);
    const paneRay = new Raycaster(new Vector3(-30, 20, 1.55), new Vector3(1, 0, 0));
    expect(materialName(paneRay.intersectObject(root, true)[0]!.object)).toBe("District facade glazing");
  });

  it("bakes all 12 buildings into 4 world-space role geometries with per-building window-shader seeds", () => {
    const batch = bakeDistrictModelBatch(scene);
    expect(batch).not.toBeNull();
    try {
      expect(batch!.facade.getAttribute("aSeed")).toBeDefined();
      expect(batch!.facade.getAttribute("color")).toBeDefined();
      expect(batch!.solid.getAttribute("color")).toBeDefined();
      expect(batch!.crown.getAttribute("color")).toBeDefined();
      expect(batch!.foliage.getAttribute("color")).toBeDefined();

      const seedAttr = batch!.facade.getAttribute("aSeed");
      const uniqueSeeds = new Set<number>();
      for (let i = 0; i < seedAttr.count; i++) {
        uniqueSeeds.add(Math.round(seedAttr.getX(i) * 10) / 10);
      }
      expect(uniqueSeeds.size).toBe(DISTRICT_BUILDINGS.length);
    } finally {
      batch?.facade.dispose();
      batch?.solid.dispose();
      batch?.crown.dispose();
      batch?.foliage.dispose();
    }
  });

  it("rejects an incomplete library without modifying its source or retaining partial batches", () => {
    const incomplete = new Group();
    incomplete.add(asset("district-0").clone(true));
    const sourceShape = (incomplete.children[0]!.children[0]! as InstanceType<typeof Mesh>).geometry;
    const sourcePositions = sourceShape.getAttribute("position").array.slice();
    const dispose = vi.spyOn(BufferGeometry.prototype, "dispose");
    try {
      expect(bakeDistrictModelBatch(incomplete)).toBeNull();
      expect(dispose.mock.calls.length).toBeGreaterThanOrEqual(incomplete.children[0]!.children.length);
      expect(sourceShape.getAttribute("position").array).toEqual(sourcePositions);
      expect(dispose.mock.contexts).not.toContain(sourceShape);
    } finally {
      dispose.mockRestore();
    }
  });
});
