import { OrthographicCamera, PerspectiveCamera, Vector3, type Camera, type Object3D } from 'three';

/**
 * The camera the screen runtime currently renders with. `ScreenIllumination` refreshes it every
 * frame; screens use it to decide whether a repaint or a light is worth spending.
 */
let view: { camera: Camera; viewportHeight: number } | null = null;
export function setScreenView(camera: Camera, viewportHeight: number): void {
  view = { camera, viewportHeight };
}

const position = new Vector3();
const projected = new Vector3();
const scale = new Vector3();

/**
 * On-screen height in pixels of a panel `panelHeight` metres tall, or 0 when the panel is hidden
 * (any ancestor invisible, e.g. another floor), behind the camera or outside the view.
 */
export function projectedPanelHeight(group: Object3D, panelHeight: number, margin = 1.1): number {
  if (!view) return 0;
  for (let ancestor: Object3D | null = group; ancestor; ancestor = ancestor.parent) {
    if (!ancestor.visible) return 0;
  }
  const { camera, viewportHeight } = view;
  group.getWorldPosition(position);
  projected.copy(position).project(camera);
  if (projected.z < -1 || projected.z > 1 || Math.abs(projected.x) > margin || Math.abs(projected.y) > margin) return 0;
  group.getWorldScale(scale);
  if (camera instanceof OrthographicCamera) {
    return panelHeight * scale.y * camera.zoom * viewportHeight / Math.max(1e-6, camera.top - camera.bottom);
  }
  if (camera instanceof PerspectiveCamera) {
    const distance = camera.position.distanceTo(position);
    return distance > 0 ? panelHeight * scale.y * viewportHeight / (2 * distance * Math.tan(camera.fov * Math.PI / 360)) : 0;
  }
  return 0;
}

/** Text/cursors cannot be read in tiny overview panels. Keep their most recent
 * picture and photometry, but spend live canvas paints only at a useful size.
 * Light spill continues to use projectedPanelHeight independently.
 */
export const MIN_ANIMATED_SCREEN_HEIGHT = 18;
export function shouldAnimateScreen(group: Object3D, panelHeight: number): boolean {
  return projectedPanelHeight(group, panelHeight) >= MIN_ANIMATED_SCREEN_HEIGHT;
}
