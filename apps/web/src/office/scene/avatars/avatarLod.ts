/**
 * Level of detail for a character, from how tall it appears on screen. Every
 * tier draws the same mesh (no swap, no change of shape): smaller figures pose
 * less often and, when tiny, stop casting shadows. Pure apart from the camera
 * read; allocation-free per frame.
 */
import type { Camera, Object3D } from 'three';
import { Vector3 } from 'three';

export type LodTier = 0 | 1 | 2;

/** On-screen height (pixels) below which a figure drops to the next tier; hysteresis avoids flicker. */
export const LOD_PIXELS: readonly [number, number] = [150, 60];
const HYSTERESIS = 1.15;
/** Pose every n-th frame per tier. */
export const LOD_POSE_INTERVAL: Readonly<Record<LodTier, number>> = { 0: 1, 1: 2, 2: 3 };
/** Nominal standing height used to size the figure on screen (metres). */
const FIGURE_HEIGHT = 1.7;

const scratch = new Vector3();

/** Approximate on-screen height in pixels of a standing figure at `object`. */
export function screenHeightPixels(object: Object3D, camera: Camera, viewportHeight: number): number {
  const ortho = camera as Camera & { isOrthographicCamera?: boolean; top?: number; bottom?: number; zoom?: number };
  if (ortho.isOrthographicCamera) return FIGURE_HEIGHT * (ortho.zoom ?? 1) * viewportHeight / Math.max(1e-6, (ortho.top ?? 1) - (ortho.bottom ?? -1));
  const perspective = camera as Camera & { fov?: number };
  const distance = scratch.setFromMatrixPosition(object.matrixWorld).distanceTo(camera.position);
  const focal = viewportHeight / (2 * Math.tan(((perspective.fov ?? 50) * Math.PI / 180) / 2));
  return FIGURE_HEIGHT * focal / Math.max(0.1, distance);
}

/** Next tier from the on-screen height, with hysteresis around each threshold. */
export function lodTier(pixels: number, previous: LodTier): LodTier {
  const [near, far] = LOD_PIXELS;
  const up = (threshold: number, tier: LodTier) => previous > tier ? threshold * HYSTERESIS : threshold;
  if (pixels >= up(near, 0)) return 0;
  if (pixels >= up(far, 1)) return 1;
  return 2;
}

export interface LodState { tier: LodTier; frame: number; pending: number }
export const createLodState = (): LodState => ({ tier: 0, frame: 0, pending: 0 });

/**
 * Advance one rendered frame. Returns the time step to pose with this frame
 * (the frames skipped since, accumulated), or null to keep the last pose.
 */
export function lodStep(state: LodState, tier: LodTier, delta: number): number | null {
  state.tier = tier;
  state.pending += delta;
  state.frame = (state.frame + 1) % 60;
  if (state.frame % LOD_POSE_INTERVAL[tier] !== 0) return null;
  const step = state.pending;
  state.pending = 0;
  return step;
}

/** Shadow casting off for every mesh under `root`, or back to each mesh's own setting (tier changes only). */
export function setCastShadows(root: Object3D, cast: boolean): void {
  root.traverse(child => {
    if (!(child as Object3D & { isMesh?: boolean }).isMesh) return;
    if (!cast) { child.userData.lodCastShadow ??= child.castShadow; child.castShadow = false; }
    else if (child.userData.lodCastShadow !== undefined) { child.castShadow = child.userData.lodCastShadow as boolean; delete child.userData.lodCastShadow; }
  });
}

/** How far a seated, leaning or reaching pose moves the body below its standing bind pose (model units, ~metres). */
const POSE_DROP = 0.6;

/**
 * Skinned meshes are culled by a bounding sphere computed once in the standing
 * bind pose; seated, the head sits ~0.5 m lower and hair was culled in close-ups.
 * Widen each sphere downward so it holds both the standing and the seated pose.
 */
export function widenSkinnedBounds(root: Object3D): void {
  root.traverse(child => {
    const mesh = child as Object3D & { isSkinnedMesh?: boolean; computeBoundingSphere?: () => void; boundingSphere?: { center: Vector3; radius: number } | null };
    if (!mesh.isSkinnedMesh || !mesh.computeBoundingSphere) return;
    mesh.computeBoundingSphere();
    if (!mesh.boundingSphere) return;
    mesh.boundingSphere.center.y -= POSE_DROP / 2;
    mesh.boundingSphere.radius += POSE_DROP / 2 + 0.1;
  });
}
