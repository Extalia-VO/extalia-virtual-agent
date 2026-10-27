import type { Group, Material, Mesh, Object3D } from 'three';

interface FadeEntry {
  readonly mesh: Mesh;
  readonly original: Material | Material[];
  readonly faded: Material | Material[];
}
interface FadeState { opacity: number; entries: FadeEntry[] }

const KEY = 'extaliaFade';
const each = (material: Material | Material[], visit: (material: Material, index: number) => void) => {
  if (Array.isArray(material)) material.forEach(visit); else visit(material, 0);
};

/**
 * Fade a character group in or out (arrivals and departures at their portals).
 * Materials are often shared between characters, so the first fade gives the
 * group's meshes their own dissolving copies; at full opacity the originals
 * come back and the copies are disposed. Only runs for the short fade itself.
 */
export function applyCharacterOpacity(group: Group, opacity: number): void {
  const data = group.userData as { [KEY]?: FadeState };
  let state = data[KEY];
  if (opacity >= 1) {
    if (!state) return;
    for (const entry of state.entries) {
      // Keep whatever the renderer attached since (a re-mounted material).
      if (entry.mesh.material === entry.faded) entry.mesh.material = entry.original;
      each(entry.faded, material => material.dispose());
    }
    delete data[KEY];
    return;
  }
  if (!state) {
    state = { opacity: -1, entries: [] };
    group.traverse((object: Object3D) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      const original = mesh.material;
      const copy = (material: Material) => {
        const clone = material.clone();
        clone.userData = { ...clone.userData, [KEY]: material.opacity };
        // Opaque parts dissolve with hashed alpha: depth stays intact, so no inner layer shows through
        // (plain blending draws a dark silhouette of the body under the clothes). See-through parts keep blending.
        if (!material.transparent) clone.alphaHash = true;
        return clone;
      };
      const faded = Array.isArray(original) ? original.map(copy) : copy(original);
      mesh.material = faded;
      state!.entries.push({ mesh, original, faded });
    });
    data[KEY] = state;
  }
  if (Math.abs(state.opacity - opacity) < 1e-3) return;
  state.opacity = opacity;
  for (const entry of state.entries) each(entry.faded, material => {
    material.opacity = (material.userData[KEY] as number) * opacity;
  });
}
