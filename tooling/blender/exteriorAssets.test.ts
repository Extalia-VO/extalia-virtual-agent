import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { beforeAll, describe, expect, it } from "vitest";
import {
  EXTERIOR_MODELS,
  EXTERIOR_DISPLAY_MODELS,
  bakeExteriorDisplayGeometry,
  bakeExteriorInstancedGeometries
} from "../../apps/web/src/office/scene/ExteriorPart";
import { OUTDOOR_FACILITIES_BLUEPRINT as outdoor } from "../../apps/web/src/office/scene/spatialBlueprints";

import { FOREGROUND_BOTANICAL_PLACEMENTS, landscapeClear } from "../../apps/web/src/office/scene/CampusLandscape";

const webRequire = createRequire(new URL("../../apps/web/package.json", import.meta.url));
const { Box3, Raycaster, Vector3 } = await import(webRequire.resolve("three"));
const { GLTFLoader } = await import(webRequire.resolve("three/examples/jsm/loaders/GLTFLoader.js"));
type Scene = Awaited<ReturnType<InstanceType<typeof GLTFLoader>["parseAsync"]>>["scene"];

const localFile = new URL("../../apps/web/local-assets/landscape/exterior-landscape.glb", import.meta.url);
const manifestFile = new URL("../../apps/web/local-assets/landscape/exterior-landscape.manifest.json", import.meta.url);

describe.skipIf(!existsSync(localFile))("actual local Blender exterior landscape library", () => {
  let scene: Scene;
  const asset = (name: string) => {
    const root = scene.getObjectByName(name);
    if (!root) throw new Error(`Missing exterior asset ${name}`);
    return root;
  };
  const bounds = (name: string) => new Box3().setFromObject(asset(name));
  const ray = (name: string, origin: [number, number, number], direction: [number, number, number]) =>
    new Raycaster(new Vector3(...origin), new Vector3(...direction)).intersectObject(asset(name), true);

  beforeAll(async () => {
    scene = (await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(localFile)).buffer, "")).scene;
    scene.updateWorldMatrix(true, true);
  });

  it("exports every exterior model at its contract origin and matches measured manifest bounds", () => {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    expect(Object.keys(manifest.groups).sort()).toEqual([...EXTERIOR_MODELS].sort());
    let triangles = 0;
    for (const name of EXTERIOR_MODELS) {
      const root = asset(name);
      const box = bounds(name);
      const expected = manifest.groups[name];
      expect(root.position.length(), name).toBeLessThan(1e-6);
      expect(root.scale.toArray(), name).toEqual([1, 1, 1]);
      let partTriangles = 0;
      root.traverse((node: Scene) => {
        if ("geometry" in node) {
          partTriangles += (node.geometry.index?.count ?? node.geometry.getAttribute("position").count) / 3;
        }
      });
      expect(partTriangles, name).toBe(expected.triangles);
      triangles += partTriangles;
      for (const [i, axis] of ["x", "y", "z"].entries()) {
        expect(box.min[axis], `${name} min ${axis}`).toBeCloseTo(expected.min[i], 5);
        expect(box.max[axis], `${name} max ${axis}`).toBeCloseTo(expected.max[i], 5);
      }
    }
    expect(triangles).toBe(manifest.triangles);
    expect(triangles).toBeLessThanOrEqual(120_000);
  });

  it("preserves exact avatar seating contact heights across all outdoor benches, planters, picnic and patio chairs", () => {
    expect(ray("exterior-plinth-bench", [0, 1, 0.07], [0, -1, 0])[0]?.point.y).toBeCloseTo(outdoor.plinthSeatHeight, 3);
    expect(ray("exterior-park-bench", [0, 1, outdoor.parkSeatCenterZ], [0, -1, 0])[0]?.point.y).toBeCloseTo(outdoor.parkSeatHeight, 3);
    expect(ray("exterior-garden-seat", [0, 1, 0], [0, -1, 0])[0]?.point.y).toBeCloseTo(outdoor.gardenSeatHeight, 3);
    expect(ray("exterior-picnic-bench", [0, 1, 0.075], [0, -1, 0])[0]?.point.y).toBeCloseTo(outdoor.picnicSeatHeight, 3);
    expect(ray("exterior-patio-chair", [0, 1, 0.05], [0, -1, 0])[0]?.point.y).toBeCloseTo(outdoor.patioSeatHeight, 3);

    // Picnic table frame stays inside the bench seat lines (|z| <= 0.48) so seatContactClear is never obstructed.
    expect(bounds("exterior-picnic-table").max.z).toBeLessThan(0.5);
    expect(bounds("exterior-picnic-table").min.z).toBeGreaterThan(-0.5);
  });

  it("keeps the cafe deck passable, the cafe kiosk customer & sign planes clear, and luminaires equipped with diffusers", () => {
    // Cafe deck top must stay <= 0.04 m so WalkingClearance never flags it as a solid obstacle (box.max.y > 0.3).
    expect(bounds("exterior-cafe-deck").max.y).toBeLessThanOrEqual(0.04);

    // Cafe kiosk stays behind z = 1.255 so the runtime CAMPUS CAFE sign at z = 1.26 and customer point at z = 1.9 are clear.
    expect(bounds("exterior-cafe-kiosk").max.z).toBeLessThanOrEqual(1.255);
    expect(ray("exterior-cafe-kiosk", [0, 2.16, 2], [0, 0, -1])[0]?.point.z).toBeLessThan(1.255);

    // Wayfinding pylon keeps z = 0.085 clear across the directory window around [0, 1.1, 0.085].
    expect(ray("exterior-wayfinding-pylon", [0, 1.1, 1], [0, 0, -1])[0]?.point.z).toBeLessThan(0.082);

    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    for (const lighted of [
      "exterior-walk-lamp",
      "exterior-bollard-light",
      "exterior-tree-uplight",
      "exterior-wayfinding-pylon",
      "exterior-cafe-kiosk",
      "exterior-festoon-mast",
      "exterior-parasol",
      "exterior-patio-table",
      "exterior-garden-decor"
    ]) {
      expect(manifest.groups[lighted].materials, lighted).toContain("Exterior lamp diffuser");
    }
    expect(manifest.groups["exterior-bicycle"].materials).toContain("Bicycle frame paint");
    expect(manifest.groups["exterior-garden-pond"].materials).toContain("Exterior lamp diffuser");
    expect(manifest.groups["exterior-garden-pergola"].materials).toContain("Exterior lamp diffuser");
    // The centre of the pergola remains open to the rear bench and its front approach.
    for (const x of [-.8, 0, .8]) {
      expect(ray("exterior-garden-pergola", [x, 1.7, -2], [0, 0, 1])).toHaveLength(0);
    }
  });

  it("keeps repeated crowns bounded and retains botanical colours in single-draw display geometry", () => {
    const manifest = JSON.parse(readFileSync(manifestFile, "utf8"));
    expect(manifest.groups["exterior-canopy-cluster"].triangles).toBeLessThanOrEqual(400);
    expect(manifest.groups["exterior-grass-tuft"].triangles).toBeLessThanOrEqual(24);
    for (const name of EXTERIOR_DISPLAY_MODELS) {
      const geometry = bakeExteriorDisplayGeometry(asset(name));
      expect(geometry, name).not.toBeNull();
      try {
        const positions = geometry!.getAttribute("position"), colors = geometry!.getAttribute("color");
        expect(geometry!.groups, name).toHaveLength(0);
        expect(colors.count, name).toBe(positions.count);
        expect(positions.count / 3, name).toBe(manifest.groups[name].triangles);
        const palette = new Set<string>();
        for (let i = 0; i < colors.count; i++) palette.add(`${colors.getX(i).toFixed(3)}:${colors.getY(i).toFixed(3)}:${colors.getZ(i).toFixed(3)}`);
        expect(palette.size, name).toBeGreaterThanOrEqual(name === "exterior-grass-tuft" ? 1 : 3);
        expect(geometry!.boundingBox!.min.y, name).toBeCloseTo(bounds(name).min.y, 5);
        expect(geometry!.boundingBox!.max.y, name).toBeCloseTo(bounds(name).max.y, 5);
      } finally { geometry?.dispose(); }
    }
  });

  it("bakes normalized unit geometries for instanced boulevard trees, park benches, and pedestrian lamps", () => {
    const instanced = bakeExteriorInstancedGeometries(scene);
    expect(instanced).not.toBeNull();
    try {
      expect(instanced!.trunk.getAttribute("position").count).toBeGreaterThan(100);
      expect(instanced!.trunk.boundingBox!.min.y).toBeCloseTo(0, 3);
      expect(instanced!.trunk.boundingBox!.max.y).toBeGreaterThan(1);

      expect(instanced!.canopy.getAttribute("position").count).toBeGreaterThan(200);
      expect(instanced!.canopy.boundingBox!.min.x).toBeCloseTo(-1, 3);
      expect(instanced!.canopy.boundingBox!.max.x).toBeCloseTo(1, 3);
      expect(instanced!.canopy.boundingBox!.min.y).toBeCloseTo(-1, 3);
      expect(instanced!.canopy.boundingBox!.max.y).toBeCloseTo(1, 3);

      expect(instanced!.bench.getAttribute("position").count).toBeGreaterThan(100);
      expect(instanced!.lamp.getAttribute("position").count).toBeGreaterThan(100);
      expect(instanced!.lamp.boundingBox!.min.y).toBeCloseTo(-0.5, 3);
      expect(instanced!.lamp.boundingBox!.max.y).toBeCloseTo(0.5, 3);
      expect(instanced!.lampOptics).toBeDefined();
      expect(instanced!.lampOptics!.boundingBox!.min.y).toBeGreaterThan(.3);
      expect(instanced!.lampOptics!.boundingBox!.max.y).toBeLessThan(.5);
    } finally {
      instanced?.trunk.dispose();
      instanced?.canopy.dispose();
      instanced?.bench.dispose();
      instanced?.lamp.dispose();
      instanced?.lampOptics?.dispose();
    }
  });
});

describe("foreground landscape site separation", () => {
  it("keeps tree footprints outside the arrival lane, building and west mobility court", () => {
    expect(landscapeClear(0, -30, 1)).toBe(false);
    expect(landscapeClear(0, 0, 1)).toBe(false);
    expect(landscapeClear(-42, 0, 1)).toBe(false);
    expect(landscapeClear(-34, 19, 1)).toBe(false);
    expect(landscapeClear(35, 12, 1)).toBe(true);
    for (const [x, z] of [...FOREGROUND_BOTANICAL_PLACEMENTS.flowers, ...FOREGROUND_BOTANICAL_PLACEMENTS.tropical]) {
      expect(landscapeClear(x, z, .7), `${x}, ${z}`).toBe(true);
    }
  });
});
