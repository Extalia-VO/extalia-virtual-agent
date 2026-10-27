import { Path, Shape, Vector2 } from 'three';
import type { Plan } from './facadeSweep';

export interface FacadeFrame {
  readonly course: number;
  readonly side: 'long' | 'short';
  readonly outline: readonly Plan[];
  readonly window: readonly Plan[];
  /** Bottom edge and diagonal jamb, before its small inward light offset. */
  readonly edge: readonly Plan[];
}

// Shared boundary points make the diagonal jambs join at each course datum.
// Coordinates are in the original 42 m elevation; the real footprint scales X.
const LONG_TIPS = [-9.8, -4.7, -10.8, -3.3, 4.6, 14.2, 14.2] as const;
const SHORT_TIPS = [11.8, 6.2, 11.8, 8.2, 8.2, 14.2, 14.2] as const;
export const FACADE_COURSE_HEIGHT = 3.2;
export const FACADE_PAVILION_EDGE = 14.2;

/** Solid silver frames with real horizontal window holes and diagonal jambs. */
export function facadeFrames(halfWidth: number, xScale: number): FacadeFrame[] {
  const frames: FacadeFrame[] = [];
  const pavilion = FACADE_PAVILION_EDGE * xScale;
  for (let course = 0; course < 6; course++) {
    const y0 = course * FACADE_COURSE_HEIGHT, y1 = y0 + FACADE_COURSE_HEIGHT;
    // Join the straight tangent of the rounded wrap, without a panel behind the holes.
    const outer = -halfWidth - (course % 2 ? 0.42 : 0.3) + 2.4;
    for (const side of ['long', 'short'] as const) {
      const start = side === 'long' ? outer : pavilion;
      const sign = side === 'long' ? 1 : -1;
      const tips = side === 'long' ? LONG_TIPS : SHORT_TIPS;
      const w0 = Math.max(0, sign * (tips[course]! * xScale - start));
      const w1 = Math.max(0, sign * (tips[course + 1]! * xScale - start));
      if (Math.max(w0, w1) < 0.1) continue;
      const point = (u: number, y: number): Plan => [start + sign * u, y];
      const outline = [point(0, y0), point(w0, y0), point(w1, y1), point(0, y1)]
        .filter((p, i, all) => i === 0 || Math.hypot(p[0] - all[i - 1]![0], p[1] - all[i - 1]![1]) > 1e-6);
      // Constant normal thickness on the sloping jamb, rather than a vanishing
      // horizontal inset on a shallow diagonal.
      const jamb = 0.64 * Math.hypot(1, (w1 - w0) / FACADE_COURSE_HEIGHT);
      const endAt = (y: number) => w0 + (w1 - w0) * (y - y0) / FACADE_COURSE_HEIGHT - jamb;
      const low = y0 + 0.98, high = y1 - 0.74;
      const window: Plan[] = Math.min(endAt(low), endAt(high)) > 1.15
        ? [point(0.64, low), point(endAt(low), low), point(endAt(high), high), point(0.64, high)] : [];
      frames.push({ course, side, outline, window,
        edge: [point(0.04, y0 + 0.05), point(Math.max(0.04, w0 - 0.08), y0 + 0.05),
          point(Math.max(0.04, w1 - 0.08), y1 - 0.05)] });
    }
  }
  return frames;
}

export function facadeFrameShape(frame: FacadeFrame): Shape {
  const shape = new Shape(frame.outline.map(([x, y]) => new Vector2(x, y)));
  if (frame.window.length) {
    const hole = new Path();
    frame.window.forEach(([x, y], i) => i === 0 ? hole.moveTo(x, y) : hole.lineTo(x, y));
    hole.closePath();
    shape.holes.push(hole);
  }
  return shape;
}
