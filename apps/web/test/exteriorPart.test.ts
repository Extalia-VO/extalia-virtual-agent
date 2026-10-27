import { describe, expect, it, vi } from "vitest";
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from "three";
import { createExteriorInstance, updateExteriorEmission } from "../src/office/scene/ExteriorPart";

function fixture() {
  const source = new Group();
  const geometry = new BoxGeometry(1, 1, 1);
  const frame = new MeshStandardMaterial({ name: "Architectural slate metal", color: "#43525b" });
  const canopy = new MeshStandardMaterial({ name: "Exterior parasol canvas", color: "#e6e1d3" });
  const bike = new MeshStandardMaterial({ name: "Bicycle frame paint", color: "#3f6f7a" });
  const lamp = new MeshStandardMaterial({
    name: "Exterior lamp diffuser",
    emissive: "#ffc978",
    emissiveIntensity: 0.35
  });
  const glass = new MeshStandardMaterial({
    name: "Cafe display glass",
    transparent: true,
    opacity: 0.35,
    depthWrite: true
  });
  source.add(
    new Mesh(geometry, frame),
    new Mesh(geometry, canopy),
    new Mesh(geometry, bike),
    new Mesh(geometry, lamp),
    new Mesh(geometry, glass),
    new Mesh(geometry, [frame, canopy, lamp])
  );
  const originals = [frame, canopy, bike, lamp, glass];
  return {
    source,
    geometry,
    originals,
    frame,
    canopy,
    bike,
    lamp,
    glass,
    dispose: () => {
      geometry.dispose();
      originals.forEach((m) => m.dispose());
    }
  };
}

const meshAt = (root: Group | ReturnType<typeof createExteriorInstance>["root"], index: number) =>
  root.children[index] as Mesh;

describe("exterior Blender part material ownership and solar emission", () => {
  it("shares immutable geometry and frame materials while isolating per-instance canopy/bike tints, lamps and glass", () => {
    const f = fixture();
    const a = createExteriorInstance(f.source, "#d9d3c4");
    const b = createExteriorInstance(f.source, "#8a5b46");
    const untinted = createExteriorInstance(f.source);
    try {
      for (const instance of [a, b, untinted]) {
        expect(instance.root).not.toBe(f.source);
        instance.root.children.forEach((mesh, index) => {
          expect(mesh).not.toBe(f.source.children[index]);
          expect((mesh as Mesh).geometry).toBe(f.geometry);
          expect((mesh as Mesh).receiveShadow).toBe(true);
        });
        expect(meshAt(instance.root, 0).material).toBe(f.frame);
        expect(meshAt(instance.root, 0).castShadow).toBe(true);
        expect(meshAt(instance.root, 4).castShadow).toBe(false);
        expect((meshAt(instance.root, 4).material as MeshStandardMaterial).depthWrite).toBe(false);
        expect(instance.lamps).toHaveLength(1);
      }
      expect((meshAt(a.root, 1).material as MeshStandardMaterial).color.getHexString()).toBe("d9d3c4");
      expect((meshAt(a.root, 2).material as MeshStandardMaterial).color.getHexString()).toBe("d9d3c4");
      expect((meshAt(b.root, 1).material as MeshStandardMaterial).color.getHexString()).toBe("8a5b46");
      expect((meshAt(b.root, 2).material as MeshStandardMaterial).color.getHexString()).toBe("8a5b46");
      expect(meshAt(untinted.root, 1).material).toBe(f.canopy);
      expect(meshAt(untinted.root, 2).material).toBe(f.bike);
      expect(a.lamps[0]).not.toBe(b.lamps[0]);
      expect(a.lamps[0]).not.toBe(f.lamp);
      expect(a.owned).toHaveLength(4);
      expect(untinted.owned).toHaveLength(2);
      expect(f.canopy.color.getHexString()).toBe("e6e1d3");
      expect(f.bike.color.getHexString()).toBe("3f6f7a");

      const spies = f.originals.map((m) => vi.spyOn(m, "dispose"));
      a.owned.forEach((m) => m.dispose());
      expect(spies.every((spy) => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      [...a.owned, ...b.owned, ...untinted.owned].forEach((m) => m.dispose());
      f.dispose();
    }
  });

  it("updates exterior lamp diffuser emission from the solar exteriorLightFactor without mutating other instances", () => {
    const f = fixture();
    const a = createExteriorInstance(f.source);
    const b = createExteriorInstance(f.source);
    try {
      updateExteriorEmission(a, 0);
      expect(a.lamps[0]!.emissiveIntensity).toBe(0);
      for (const factor of [0.25, 0.7, 1]) {
        updateExteriorEmission(a, factor);
        expect(a.lamps[0]!.emissiveIntensity).toBeCloseTo(0.45 + factor * 3.2);
      }
      expect(b.lamps[0]!.emissiveIntensity).toBe(0.35);
      expect(f.lamp.emissiveIntensity).toBe(0.35);
    } finally {
      [...a.owned, ...b.owned].forEach((m) => m.dispose());
      f.dispose();
    }
  });
});
