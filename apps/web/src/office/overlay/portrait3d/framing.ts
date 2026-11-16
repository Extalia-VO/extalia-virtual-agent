import { Box3, Vector3, type Matrix4, type BufferGeometry, type Mesh, type Object3D, type OrthographicCamera, type SkinnedMesh } from 'three';

/** Fractions of the rendered portrait, independent of stature, hairstyle or tile size. */
export const PORTRAIT_EYE_LINE = 0.42;
export const PORTRAIT_HEAD_HEIGHT = 0.48;
const MAX_HEAD_VERTICES = 20_000;

/** One calibration per mounted head. Only the scratch vector changes during painting. */
export interface PortraitFraming {
  readonly root: Object3D;
  readonly anchor: Object3D;
  readonly surface: Mesh;
  readonly geometry: BufferGeometry;
  readonly localEye: Vector3;
  readonly headHeight: number;
  readonly scratch: Vector3;
}

function descendantOf(object: Object3D, ancestor: Object3D): boolean {
  let current: Object3D | null = object;
  while (current) {
    if (current === ancestor) return true;
    current = current.parent;
  }
  return false;
}

function namedMaterial(mesh: Mesh, pattern: RegExp): boolean {
  return !Array.isArray(mesh.material) && pattern.test(mesh.material.name);
}

function finite(point: Vector3): boolean {
  return Number.isFinite(point.x) && Number.isFinite(point.y) && Number.isFinite(point.z);
}

function headAnchor(surface: Mesh): Object3D | undefined {
  if ((surface as SkinnedMesh).isSkinnedMesh) return (surface as SkinnedMesh).skeleton?.bones.find(bone => bone.name === 'head');
  let parent = surface.parent;
  while (parent) {
    if (parent.name === 'avatar-head') return parent;
    parent = parent.parent;
  }
  return undefined;
}

/** Posed vertices are measured in the head's local frame, never whole-body/hair bounds. */
function extendHeadBounds(mesh: Mesh, inverse: Matrix4, bounds: Box3, point: Vector3): boolean {
  const position = mesh.geometry.getAttribute('position');
  if (!position || !position.count || position.count > MAX_HEAD_VERTICES) return false;
  try {
    for (let vertex = 0; vertex < position.count; vertex++) {
      mesh.getVertexPosition(vertex, point).applyMatrix4(mesh.matrixWorld).applyMatrix4(inverse);
      if (!finite(point)) return false;
      bounds.expandByPoint(point);
    }
  } catch { return false; } // A malformed/imported skin cannot break the shared renderer.
  return true;
}

/**
 * Call after the avatar's pose/world matrices are current. A suspended/unsupported
 * head returns null and can be retried after its real geometry has mounted.
 */
export function measurePortraitFraming(root: Object3D): PortraitFraming | null {
  root.updateWorldMatrix(true, true);
  const surfaces: Mesh[] = [];
  root.traverse(object => {
    const mesh = object as Mesh;
    if (mesh.isMesh && (mesh.name === 'avatar-head-surface' || namedMaterial(mesh, /^Skin_Head/))) surfaces.push(mesh);
  });
  for (const surface of surfaces) {
    const anchor = headAnchor(surface);
    if (!anchor || !descendantOf(anchor, root)) continue;
    const determinant = anchor.matrixWorld.determinant();
    if (!Number.isFinite(determinant) || Math.abs(determinant) < 1e-12) continue;
    const inverse = anchor.matrixWorld.clone().invert(), point = new Vector3(), bounds = new Box3();
    if (!extendHeadBounds(surface, inverse, bounds, point)) continue;
    const scale = anchor.getWorldScale(new Vector3());
    const headHeight = (bounds.max.y - bounds.min.y) * Math.abs(scale.y);
    if (!Number.isFinite(headHeight) || headHeight < 0.02 || headHeight > 1) continue;

    let localEye: Vector3 | undefined;
    const eyeBounds = new Box3();
    let invalidEyes = false;
    root.traverse(object => {
      if (object.name === 'avatar-eyes' && descendantOf(object, anchor)) {
        localEye = object.getWorldPosition(new Vector3()).applyMatrix4(inverse);
        return;
      }
      const mesh = object as SkinnedMesh;
      if (!mesh.isMesh || !namedMaterial(mesh, /^Ga_Eye/)) return;
      const sameHead = mesh.isSkinnedMesh ? mesh.skeleton?.bones.some(bone => bone === anchor) : descendantOf(mesh, anchor);
      if (sameHead && !extendHeadBounds(mesh, inverse, eyeBounds, point)) invalidEyes = true;
    });
    if (!localEye && !eyeBounds.isEmpty() && !invalidEyes) localEye = eyeBounds.getCenter(new Vector3());
    if (!localEye || !finite(localEye)) continue;
    // A wrongly labelled accessory must not become a camera landmark.
    if (localEye.x < bounds.min.x || localEye.x > bounds.max.x || localEye.y < bounds.min.y || localEye.y > bounds.max.y
      || localEye.z < bounds.min.z || localEye.z > bounds.max.z) continue;
    return { root, anchor, surface, geometry: surface.geometry, localEye, headHeight, scratch: new Vector3() };
  }
  return null;
}

/**
 * Track the calibrated eye anchor without refitting animated bounds. Returning
 * false asks the owner to measure a replacement/fallback head before painting.
 */
export function applyPortraitFraming(camera: OrthographicCamera, framing: PortraitFraming, width = 192, height = 224): boolean {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0
    || !descendantOf(framing.anchor, framing.root) || !descendantOf(framing.surface, framing.root)
    || framing.surface.geometry !== framing.geometry) return false;
  framing.anchor.updateWorldMatrix(true, false);
  const eye = framing.scratch.copy(framing.localEye).applyMatrix4(framing.anchor.matrixWorld);
  if (!finite(eye)) return false;
  const viewHeight = framing.headHeight / PORTRAIT_HEAD_HEIGHT;
  const halfHeight = viewHeight / 2, halfWidth = halfHeight * width / height;
  if (camera.top !== halfHeight || camera.bottom !== -halfHeight || camera.left !== -halfWidth || camera.right !== halfWidth || camera.zoom !== 1) {
    camera.top = halfHeight; camera.bottom = -halfHeight; camera.left = -halfWidth; camera.right = halfWidth; camera.zoom = 1;
    camera.updateProjectionMatrix();
  }
  const centerY = eye.y + (PORTRAIT_EYE_LINE - 0.5) * viewHeight;
  camera.position.set(eye.x, centerY, eye.z + 3);
  camera.lookAt(eye.x, centerY, eye.z);
  camera.updateMatrixWorld(true);
  return true;
}
