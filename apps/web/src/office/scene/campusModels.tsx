import { Component, useEffect, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { useGLTF } from "@react-three/drei";
import { Color, DoubleSide, MeshPhysicalMaterial, MeshStandardMaterial, type Group, type Material, type Mesh, type Object3D } from "three";
import { useSolarEnvironment } from "./Environment";

/**
 * Campus models exported from Blender (tooling/blender/export-building-shell.py). They are
 * shared public assets in `apps/web/public-assets/building/`, already in world coordinates.
 * Each part falls back to its three.js version when its file is
 * absent or fails to load; `?building=threejs` forces every backup.
 */
export type CampusModelName = "extalia-shell" | "roof-utilities" | "roof-stair" | "elevators" | "terrace";

const urls = import.meta.glob<string>("/public-assets/building/*.glb", { eager: true, query: "?url", import: "default" });
const forceThreeJs = typeof location !== "undefined" && new URLSearchParams(location.search).get("building") === "threejs";

export function campusModelUrl(name: CampusModelName): string | undefined {
  return forceThreeJs ? undefined : urls[`/public-assets/building/${name}.glb`];
}
for (const name of ["extalia-shell", "roof-utilities", "roof-stair", "elevators", "terrace"] as const) {
  const url = campusModelUrl(name);
  if (url) useGLTF.preload(url, false, false);
}

// ── Load status, so a three.js part can step aside only once its model is really on screen ──
type Status = "absent" | "loading" | "ready" | "failed";
const status = new Map<CampusModelName, Status>();
const listeners = new Set<() => void>();
function setStatus(name: CampusModelName, next: Status) {
  if (status.get(name) === next) return;
  status.set(name, next);
  listeners.forEach(listener => listener());
}
export function useCampusModelReady(name: CampusModelName): boolean {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener); },
    () => status.get(name) === "ready",
  );
}

export class ModelBoundary extends Component<{ name: CampusModelName; fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override componentDidCatch() { setStatus(this.props.name, "failed"); }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

// ── Live materials: glass and accent lines follow the app's day/night state ──
export type MaterialRole = "glass" | "accent" | "solid";
export type GlassRole = "facade_glass" | "elevator_shaft_glass" | "balustrade_glass";

function authoredGlassRole(material: Material): GlassRole | undefined {
  const role: unknown = material.userData.extalia_material_role;
  if (role === "facade_glass" || role === "elevator_shaft_glass" || role === "balustrade_glass") return role;
  const name = material.name.toLowerCase();
  if (name.startsWith("glass - facade neutral bluegrey")) return "facade_glass";
  if (name.startsWith("glass - elevator clear bluegrey")) return "elevator_shaft_glass";
  if (name.startsWith("glass - balustrade clear bluegrey")) return "balustrade_glass";
  return undefined;
}

export function roleOf(material: Material): MaterialRole {
  const name = material.name.toLowerCase();
  if (authoredGlassRole(material) || material.transparent || name.startsWith("glass") || name.includes("curtain") || name.includes("glass")) return "glass";
  if (name.startsWith("accent")) return "accent";
  return "solid";
}

export interface LiveModel { root: Group; facadeGlass: MeshPhysicalMaterial[]; accents: MeshStandardMaterial[]; owned: Material[] }

export function updateLiveModelLighting(model: LiveModel, night: number, windowGlow: number): void {
  for (const pane of model.facadeGlass) pane.emissiveIntensity = windowGlow * 0.16;
  for (const line of model.accents) line.emissiveIntensity = night * 0.65;
}

/** Clone object transforms, sharing geometry and each source material's single replacement. */
export function createLiveModel(scene: Group): LiveModel {
  const root = scene.clone(true);
  const facadeGlass: MeshPhysicalMaterial[] = [], accents: MeshStandardMaterial[] = [], owned: Material[] = [];
  const replacements = new Map<Material, Material>();
  const swap = (material: Material): Material => {
    const cached = replacements.get(material);
    if (cached) return cached;
    const role = roleOf(material);
    if (role === "glass") {
      const authored = authoredGlassRole(material);
      const glassRole = authored ?? (/balustrade/i.test(material.name) ? "balustrade_glass"
        : /elevator|shaft/i.test(material.name) ? "elevator_shaft_glass" : "facade_glass");
      const source = material as MeshStandardMaterial;
      // Explicit exported roles retain linear color, alpha and face culling, including clear shaft panes.
      // Older exports keep the previous blue glazing defaults, without lighting outdoor/shaft glass.
      const opacity = authored ? material.opacity
        : material.opacity < 1 ? Math.min(0.5, Math.max(0.16, material.opacity)) : 0.42;
      const pane = new MeshPhysicalMaterial({ name: material.name,
        color: authored ? source.color ?? new Color(0.16, 0.22, 0.27) : "#a9c6d4",
        roughness: authored ? source.roughness ?? 0.12 : 0.1,
        metalness: authored ? source.metalness ?? 0 : 0,
        ior: authored && material instanceof MeshPhysicalMaterial ? material.ior : 1.5,
        clearcoat: authored ? 0 : 0.45, clearcoatRoughness: 0.1,
        transparent: true, opacity, depthWrite: false, side: authored ? material.side : DoubleSide,
        emissive: glassRole === "facade_glass" ? "#ffd29c" : "#000000", emissiveIntensity: 0 });
      pane.userData = { ...material.userData };
      if (glassRole === "facade_glass") facadeGlass.push(pane);
      owned.push(pane); replacements.set(material, pane);
      return pane;
    }
    if (role === "accent") {
      const line = new MeshStandardMaterial({ name: material.name, color: "#ffe0a7", emissive: "#ffc778", toneMapped: false });
      accents.push(line); owned.push(line); replacements.set(material, line);
      return line;
    }
    return material;
  };
  root.traverse((node: Object3D) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(swap) : swap(mesh.material);
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    const glazed = materials.every(m => roleOf(m) === "glass");
    // Static batches may merge the opaque shell after the model loads. Glass
    // keeps object sorting and accents keep their live day/night material refs.
    if (materials.some(material => roleOf(material) !== "solid")) mesh.userData.officeDynamic = true;
    mesh.castShadow = !glazed;
    mesh.receiveShadow = true;
    mesh.userData.officeCollision = false;
  });
  return { root, facadeGlass, accents, owned };
}

/** A cloned model with the app's glass (blue alpha glazing, night window glow) and accent lines (glow at dusk). */
export function useLiveModel(name: CampusModelName, url: string): LiveModel {
  const { scene } = useGLTF(url, false, false);
  const { state } = useSolarEnvironment();
  const night = state.factors.exteriorLightFactor;
  const windowGlow = state.factors.interiorLightFactor * (1 - state.factors.daylightFactor);
  const model = useMemo(() => createLiveModel(scene), [scene]);
  useEffect(() => updateLiveModelLighting(model, night, windowGlow), [model, night, windowGlow]);
  useEffect(() => {
    setStatus(name, "ready");
    return () => {
      setStatus(name, "absent");
      for (const material of model.owned) material.dispose();
    };
  }, [name, model]);
  return model;
}
