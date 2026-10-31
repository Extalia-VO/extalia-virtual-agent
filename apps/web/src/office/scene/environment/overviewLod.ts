import type { Material, Mesh, Object3D } from 'three';

/**
 * Campus-overview level of detail (pure helpers, unit-tested). In the whole-campus view the camera is
 * far away (about 11 px per metre at the default zoom), so non-emissive parts whose bounding sphere is
 * under a couple of pixels add draw calls without adding a visible pixel. They are moved to a layer the
 * camera does not render (which also keeps them out of the shadow pass) and restored as soon as the
 * view changes or the camera zooms in. Emissive, unlit and tone-mapping-exempt parts (lamp lenses,
 * LEDs, screens, glows) always stay, so the night picture keeps every light point.
 */

/** Layer used for culled detail: never enabled on the camera or the raycaster. */
export const OVERVIEW_CULLED_LAYER = 30;

/** Bounding-sphere radius in CSS pixels below which overview detail is culled, per render budget level. */
export const OVERVIEW_CULL_RADIUS_PX: readonly number[] = [1.75, 1.75, 2.25, 3];

/** Development/benchmark switches for A/B measurements (`__EXTALIA_BENCH__.flags`). */
export const overviewFlags = { detailCull: true, interiorShadows: false, interiorLiveLights: false };

/** Campus zoom (CSS px per metre) below which the interior live light pools leave the light set, with hysteresis. */
export const OVERVIEW_ZOOM_ENTER = 18;
export const OVERVIEW_ZOOM_EXIT = 22;
/** Whether the campus camera is at overview distance (default building view: 9–11 px/m; close-ups: 30+). */
export function campusOverviewZoom(pixelsPerMetreNow: number, wasOverview: boolean): boolean {
  return pixelsPerMetreNow < (wasOverview ? OVERVIEW_ZOOM_EXIT : OVERVIEW_ZOOM_ENTER);
}

let campusOverview = false;
/**
 * At campus overview distance the baked fixture and screen irradiance already shows every light pool;
 * the live spot-light pools (6 fixture beams, 8 screen spills) only add sub-pixel specular detail there,
 * yet every lit fragment of the campus paid for 14 extra lights. They leave the light set while the
 * campus camera is zoomed out and return when it zooms in for a close-up. Each light set compiles its
 * shader variants once and is cached afterwards (campus and floor views already had different sets).
 */
export function setCampusOverview(active: boolean): void { campusOverview = active; }
export function isCampusOverview(): boolean { return campusOverview && !overviewFlags.interiorLiveLights; }

/** Projected size of one metre in CSS pixels for an orthographic or perspective camera. */
export function pixelsPerMetre(camera: { isOrthographicCamera?: boolean; zoom: number; top?: number; bottom?: number; fov?: number },
  viewportHeight: number, distance: number): number {
  if (camera.isOrthographicCamera) return camera.zoom * viewportHeight / Math.max(1e-6, (camera.top ?? 1) - (camera.bottom ?? -1));
  const fov = ((camera.fov ?? 50) * Math.PI) / 180;
  return distance > 0 ? viewportHeight / (2 * distance * Math.tan(fov / 2)) : Infinity;
}

type LitMaterial = Material & { emissive?: { r: number; g: number; b: number }; emissiveIntensity?: number; emissiveMap?: unknown;
  toneMapped?: boolean; isMeshBasicMaterial?: boolean; colorWrite?: boolean };

/** Whether a material can be dropped at a distance: lit by the scene, not glowing, actually drawn. */
export function cullableMaterial(material: Material | Material[]): boolean {
  const list = Array.isArray(material) ? material : [material];
  return list.every(candidate => {
    const lit = candidate as LitMaterial;
    if (!lit.visible || lit.colorWrite === false || lit.isMeshBasicMaterial || lit.toneMapped === false) return false;
    if (lit.emissiveMap) return false;
    const emissive = lit.emissive;
    return !emissive || (lit.emissiveIntensity ?? 1) <= 0 || emissive.r + emissive.g + emissive.b <= 1e-3;
  });
}

/** True for meshes that are worth testing at all: drawn on the default layer and not a batch source. */
export function overviewCandidate(mesh: Mesh): boolean {
  return mesh.isMesh === true && !(mesh as Mesh & { isInstancedMesh?: boolean }).isInstancedMesh && mesh.visible &&
    mesh.userData.officeBatchSource !== true && mesh.userData.officePick !== true && cullableMaterial(mesh.material);
}

/** Every ancestor visible (the mesh would be drawn if its layer allowed it). */
export function shownInHierarchy(object: Object3D): boolean {
  for (let node: Object3D | null = object; node; node = node.parent) if (!node.visible) return false;
  return true;
}
