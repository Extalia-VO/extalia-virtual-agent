/**
 * Geometry for the continuous facade envelope: a band profile swept along a
 * plan path with rounded corners, so spandrels, glazing and caps wrap the
 * building without seams, and openings are cut out of the path instead of
 * leaving loose panels. UVs are in metres (u along the path, v up), so the
 * diamond cladding pattern runs on around corners. Pure apart from three's
 * BufferGeometry/Shape; plan coordinates are (x, z) in metres.
 */
import { BufferGeometry, Float32BufferAttribute, Shape, Vector2 } from 'three';

export type Plan = readonly [number, number];

/** Replace each interior corner of a polyline with a circular arc of `radius`. */
export function roundCorners(points: readonly Plan[], radius: number, segments = 6): Plan[] {
  if (points.length < 3 || radius <= 0) return points.map(p => [p[0], p[1]]);
  const out: Plan[] = [[points[0]![0], points[0]![1]]];
  for (let i = 1; i < points.length - 1; i++) {
    const [px, pz] = points[i - 1]!, [cx, cz] = points[i]!, [nx, nz] = points[i + 1]!;
    const inLen = Math.hypot(cx - px, cz - pz), outLen = Math.hypot(nx - cx, nz - cz);
    const ix = (cx - px) / inLen, iz = (cz - pz) / inLen, ox = (nx - cx) / outLen, oz = (nz - cz) / outLen;
    const turn = Math.acos(Math.max(-1, Math.min(1, ix * ox + iz * oz)));
    if (turn < 1e-3) { out.push([cx, cz]); continue; }
    // Tangent length for this radius, limited so arcs never overrun half a segment.
    const r = Math.min(radius, Math.tan((Math.PI - turn) / 2) * Math.min(inLen, outLen) / 2);
    const cut = r / Math.tan((Math.PI - turn) / 2);
    const ax = cx - ix * cut, az = cz - iz * cut, bx = cx + ox * cut, bz = cz + oz * cut;
    // Arc centre: offset from the start point perpendicular to the incoming direction, towards the turn.
    const cross = ix * oz - iz * ox;
    const sx = -iz * Math.sign(cross), sz = ix * Math.sign(cross);
    const ccx = ax + sx * r, ccz = az + sz * r;
    const start = Math.atan2(az - ccz, ax - ccx), end = Math.atan2(bz - ccz, bx - ccx);
    let sweep = end - start;
    while (sweep > Math.PI) sweep -= 2 * Math.PI;
    while (sweep < -Math.PI) sweep += 2 * Math.PI;
    for (let s = 0; s <= segments; s++) {
      const a = start + sweep * (s / segments);
      out.push([ccx + Math.cos(a) * r, ccz + Math.sin(a) * r]);
    }
  }
  const last = points[points.length - 1]!;
  out.push([last[0], last[1]]);
  return out;
}

/** An opening along a straight run of the path: points on the line `axis = at` with the other coordinate in [from, to]. */
export interface PathCut { readonly axis: 'x' | 'z'; readonly at: number; readonly from: number; readonly to: number }

/** Split a polyline into the pieces left after removing the cut openings (cuts lie on straight runs). */
export function cutPath(points: readonly Plan[], cuts: readonly PathCut[], eps = 1e-3): Plan[][] {
  const pieces: Plan[][] = [];
  let current: Plan[] = [points[0]!];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    // Parameter intervals of this segment that fall inside a cut.
    const gaps: [number, number][] = [];
    for (const cut of cuts) {
      const onLine = cut.axis === 'x'
        ? Math.abs(a[0] - cut.at) < eps && Math.abs(b[0] - cut.at) < eps
        : Math.abs(a[1] - cut.at) < eps && Math.abs(b[1] - cut.at) < eps;
      if (!onLine) continue;
      const s0 = cut.axis === 'x' ? a[1] : a[0], s1 = cut.axis === 'x' ? b[1] : b[0];
      if (Math.abs(s1 - s0) < eps) continue;
      const t0 = (cut.from - s0) / (s1 - s0), t1 = (cut.to - s0) / (s1 - s0);
      const lo = Math.max(0, Math.min(t0, t1)), hi = Math.min(1, Math.max(t0, t1));
      if (hi > lo) gaps.push([lo, hi]);
    }
    gaps.sort((g, h) => g[0] - h[0]);
    let t = 0;
    const at = (u: number): Plan => [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u];
    for (const [lo, hi] of gaps) {
      if (lo > t) current.push(at(lo));
      if (current.length > 1) pieces.push(current);
      current = [at(hi)];
      t = Math.max(t, hi);
    }
    current.push(b);
  }
  if (current.length > 1) pieces.push(current);
  return pieces.filter(piece => pathLength(piece) > 0.05);
}

export function pathLength(points: readonly Plan[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += Math.hypot(points[i]![0] - points[i - 1]![0], points[i]![1] - points[i - 1]![1]);
  return length;
}

/** Points every `spacing` metres along the straight runs of a path (for mullions), with their run direction. */
export function pointsAlong(points: readonly Plan[], spacing: number, margin = 0.4): { at: Plan; angle: number }[] {
  const out: { at: Plan; angle: number }[] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (length < spacing) continue;
    const count = Math.floor((length - 2 * margin) / spacing);
    for (let k = 1; k <= count; k++) {
      const u = (margin + (k * (length - 2 * margin)) / (count + 1)) / length;
      out.push({ at: [a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u], angle: Math.atan2(b[1] - a[1], b[0] - a[0]) });
    }
  }
  return out;
}

/**
 * Sweep a rectangular profile along a plan path: `outward` (the side facing away
 * from `centre`) is the face, `thickness` goes inward, from `y0` to `y1`. Returns
 * one geometry with face, back, top, bottom and end caps; u = metres along the
 * path, v = metres up (top/bottom: across), so a metre-tiled texture runs on.
 */
export function sweepBand(path: readonly Plan[], y0: number, y1: number, thickness: number, centre: Plan = [0, 0]): BufferGeometry {
  const n = path.length;
  const outer: Plan[] = [], inner: Plan[] = [], along: number[] = [];
  let s = 0;
  for (let i = 0; i < n; i++) {
    const p = path[i]!, prev = path[Math.max(0, i - 1)]!, next = path[Math.min(n - 1, i + 1)]!;
    let tx = next[0] - prev[0], tz = next[1] - prev[1];
    const tl = Math.hypot(tx, tz) || 1; tx /= tl; tz /= tl;
    let nx = tz, nz = -tx;
    if (nx * (p[0] - centre[0]) + nz * (p[1] - centre[1]) < 0) { nx = -nx; nz = -nz; }
    // Keep the band's thickness constant through gentle arcs (miter scale).
    if (i > 0 && i < n - 1) {
      const ax = p[0] - prev[0], az = p[1] - prev[1], al = Math.hypot(ax, az) || 1;
      const sn = Math.abs((ax / al) * nz - (az / al) * nx);
      const miter = 1 / Math.max(0.5, sn);
      nx *= miter; nz *= miter;
    }
    if (i > 0) s += Math.hypot(p[0] - path[i - 1]![0], p[1] - path[i - 1]![1]);
    outer.push([p[0], p[1]]);
    inner.push([p[0] - nx * thickness, p[1] - nz * thickness]);
    along.push(s);
  }
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  const centroid = (corner: Plan) => [corner[0] - centre[0], corner[1] - centre[1]] as const;
  // A strip of quads between two point rows; the winding is chosen so the face normal points along `want`.
  const strip = (rowA: [number, number, number][], rowB: [number, number, number][], uvA: [number, number][], uvB: [number, number][],
    want: (i: number) => [number, number, number]) => {
    const base = positions.length / 3;
    for (let i = 0; i < rowA.length; i++) { positions.push(...rowA[i]!); uvs.push(...uvA[i]!); }
    for (let i = 0; i < rowB.length; i++) { positions.push(...rowB[i]!); uvs.push(...uvB[i]!); }
    const m = rowA.length;
    for (let i = 0; i < m - 1; i++) {
      const a = base + i, b = base + i + 1, c = base + m + i, d = base + m + i + 1;
      const pa = rowA[i]!, pb = rowA[i + 1]!, pc = rowB[i]!;
      const e1 = [pb[0] - pa[0], pb[1] - pa[1], pb[2] - pa[2]], e2 = [pc[0] - pa[0], pc[1] - pa[1], pc[2] - pa[2]];
      const nrm = [e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!];
      const w = want(i);
      if (nrm[0]! * w[0] + nrm[1]! * w[1] + nrm[2]! * w[2] >= 0) indices.push(a, b, c, b, d, c);
      else indices.push(a, c, b, b, c, d);
    }
  };
  const normalAt = (i: number): [number, number] => {
    const a = outer[Math.min(i, n - 2)]!, b = outer[Math.min(i + 1, n - 1)]!;
    let nx = b[1] - a[1], nz = -(b[0] - a[0]);
    const [cx, cz] = centroid(a);
    if (nx * cx + nz * cz < 0) { nx = -nx; nz = -nz; }
    return [nx, nz];
  };
  const row = (pts: Plan[], y: number) => pts.map(p => [p[0], y, p[1]] as [number, number, number]);
  const uvRow = (v: number) => along.map(u => [u, v] as [number, number]);
  // Face, back, top and bottom.
  strip(row(outer, y0), row(outer, y1), uvRow(y0), uvRow(y1), i => { const [x, z] = normalAt(i); return [x, 0, z]; });
  strip(row(inner, y0), row(inner, y1), uvRow(y0), uvRow(y1), i => { const [x, z] = normalAt(i); return [-x, 0, -z]; });
  strip(row(outer, y1), row(inner, y1), uvRow(0), uvRow(thickness), () => [0, 1, 0]);
  strip(row(outer, y0), row(inner, y0), uvRow(0), uvRow(thickness), () => [0, -1, 0]);
  // End caps.
  for (const end of [0, n - 1]) {
    const o = outer[end]!, q = inner[end]!;
    const other = path[end === 0 ? 1 : n - 2]!;
    const away: [number, number, number] = [path[end]![0] - other[0], 0, path[end]![1] - other[1]];
    strip([[o[0], y0, o[1]], [q[0], y0, q[1]]], [[o[0], y1, o[1]], [q[0], y1, q[1]]], [[0, y0], [thickness, y0]], [[0, y1], [thickness, y1]], () => away);
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('uv', new Float32BufferAttribute(uvs, 2));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  geometry.computeBoundingSphere();
  return geometry;
}

/**
 * Outline of a polyline of constant `width` (in its own x-y plane) with mitred
 * joints, as a Shape to extrude: one clean solid for a stepped ribbon instead of
 * overlapping boxes.
 */
export function thickPolyline(points: readonly Plan[], width: number, miterLimit = 3): Shape {
  const half = width / 2;
  const left: Vector2[] = [], right: Vector2[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i]!, prev = points[Math.max(0, i - 1)]!, next = points[Math.min(points.length - 1, i + 1)]!;
    const d1 = new Vector2(p[0] - prev[0], p[1] - prev[1]), d2 = new Vector2(next[0] - p[0], next[1] - p[1]);
    if (i === 0) d1.copy(d2);
    if (i === points.length - 1) d2.copy(d1);
    d1.normalize(); d2.normalize();
    const tangent = d1.clone().add(d2).normalize();
    const normal = new Vector2(-tangent.y, tangent.x);
    const scale = Math.min(miterLimit, 1 / Math.max(1e-3, normal.dot(new Vector2(-d1.y, d1.x))));
    left.push(new Vector2(p[0], p[1]).addScaledVector(normal, half * scale));
    right.push(new Vector2(p[0], p[1]).addScaledVector(normal, -half * scale));
  }
  return new Shape([...left, ...right.reverse()]);
}

/** A polyline moved sideways by `distance` (positive: to its left in its own plane), with mitred joints. */
export function offsetPolyline(points: readonly Plan[], distance: number, miterLimit = 3): Plan[] {
  return points.map((p, i) => {
    const prev = points[Math.max(0, i - 1)]!, next = points[Math.min(points.length - 1, i + 1)]!;
    const d1 = new Vector2(p[0] - prev[0], p[1] - prev[1]), d2 = new Vector2(next[0] - p[0], next[1] - p[1]);
    if (i === 0) d1.copy(d2);
    if (i === points.length - 1) d2.copy(d1);
    d1.normalize(); d2.normalize();
    const tangent = d1.clone().add(d2).normalize();
    const normal = new Vector2(-tangent.y, tangent.x);
    const scale = Math.min(miterLimit, 1 / Math.max(1e-3, normal.dot(new Vector2(-d1.y, d1.x))));
    return [p[0] + normal.x * distance * scale, p[1] + normal.y * distance * scale] as Plan;
  });
}
