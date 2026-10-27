/** Device dimensions in metres. Placement origins are the bottom of the feet/deck. */
export const MONITOR = Object.freeze({
  width: 0.54,
  aspect: 16 / 9,
  bezel: 0.025,
  depth: 0.035,
  clearance: 0.105,
  baseWidth: 0.24,
  baseHeight: 0.018,
  baseDepth: 0.17,
});

export function monitorPanelY(height: number): number {
  return MONITOR.clearance + (height + MONITOR.bezel) / 2;
}

/** Equal-sized displays join at their front bezel edges, with one small, consistent gap. */
export function monitorBankLayout(count: 2 | 3, width: number, origin: readonly [number, number, number] = [0, 0, 0], yaw = 0) {
  const angle = .12, gap = .008, outer = width + MONITOR.bezel, front = MONITOR.depth / 2;
  const c = Math.cos(angle), s = Math.sin(angle);
  const dx = count === 2 ? (outer * c + 2 * front * s + gap) / 2 : outer * (1 + c) / 2 + front * s + gap;
  const dz = count === 2 ? 0 : outer * s / 2 + front * (1 - c);
  const local: [number, number, number][] = count === 2 ? [[-dx, 0, angle], [dx, 0, -angle]] : [[-dx, dz, angle], [0, 0, 0], [dx, dz, -angle]];
  return local.map(([x, z, turn]) => ({
    position: [origin[0] + x * Math.cos(yaw) + z * Math.sin(yaw), origin[1], origin[2] - x * Math.sin(yaw) + z * Math.cos(yaw)] as [number, number, number],
    rotationY: yaw + turn, width, height: width / MONITOR.aspect,
  }));
}

export const LAPTOP = Object.freeze({
  width: 0.36,
  depth: 0.25,
  deckHeight: 0.018,
  lidHeight: 0.225,
  lidDepth: 0.018,
  tilt: -0.22,
  hingeZ: -0.11,
  screenWidth: 0.332,
  screenHeight: 0.332 * 9 / 16,
  bezel: 0.016,
  screenOffset: 0.014,
});

/** The lid's lower edge meets the hinge, even when the tilt changes. */
export const LAPTOP_LID_CENTER = [0,
  LAPTOP.deckHeight + Math.cos(LAPTOP.tilt) * LAPTOP.lidHeight / 2,
  LAPTOP.hingeZ + Math.sin(LAPTOP.tilt) * LAPTOP.lidHeight / 2,
] as const;

/** A point in the deck frame, expressed in the tilted screen frame. */
export function inLaptopScreenFrame(x: number, y: number, z: number): [number, number, number] {
  const dy = y - LAPTOP_LID_CENTER[1], dz = z - LAPTOP_LID_CENTER[2];
  const c = Math.cos(LAPTOP.tilt), s = Math.sin(LAPTOP.tilt);
  return [x, c * dy + s * dz, -s * dy + c * dz - LAPTOP.screenOffset];
}
