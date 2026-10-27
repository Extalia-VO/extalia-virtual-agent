import { Box3, type Mesh, type Object3D } from 'three';
import { FLOOR_HEIGHT, type Point3 } from '../layout';
import { buildingFootprintPolygon } from '../interior/buildingFootprintGeometry';
import type { SeatApproach } from './navGraph';

interface Bounds { minX: number; maxX: number; minZ: number; maxZ: number; minY: number; maxY: number; seatOwner?: Object3D }
const CELL = 2;
const bounds = (box: Box3): Bounds => ({ minX: box.min.x, maxX: box.max.x, minZ: box.min.z, maxZ: box.max.z, minY: box.min.y, maxY: box.max.y });
const key = (x: number, z: number) => `${x}:${z}`;
function cells(box: Bounds, visit: (key: string) => void) {
  for (let x = Math.floor(box.minX / CELL); x <= Math.floor(box.maxX / CELL); x++)
    for (let z = Math.floor(box.minZ / CELL); z <= Math.floor(box.maxZ / CELL); z++) visit(key(x, z));
}
function intersects(a: Readonly<Point3>, b: Readonly<Point3>, box: Bounds, radius: number): boolean {
  let enter = 0, exit = 1;
  for (const [start, end, min, max] of [[a[0], b[0], box.minX - radius, box.maxX + radius], [a[2], b[2], box.minZ - radius, box.maxZ + radius]]) {
    const delta = end! - start!;
    if (Math.abs(delta) < 1e-9) { if (start! < min! || start! > max!) return false; }
    else {
      const t0 = (min! - start!) / delta, t1 = (max! - start!) / delta;
      enter = Math.max(enter, Math.min(t0, t1)); exit = Math.min(exit, Math.max(t0, t1));
      if (enter > exit) return false;
    }
  }
  return true;
}
/** Conservative render-derived occupancy. It approves optional path changes, never replaces exact contacts. */
export class WalkingClearance {
  private readonly solids = new Map<string, Bounds[]>();
  private readonly supports = new Map<string, Bounds[]>();
  private readonly seats = new Map<Object3D, Bounds>();
  private ready = false;
  revision = 0;
  colliderCount = 0;
  clear(): void { this.solids.clear(); this.supports.clear(); this.seats.clear(); this.ready = false; this.colliderCount = 0; this.revision++; }
  rebuild(roots: readonly Object3D[]): void {
    this.clear();
    const box = new Box3();
    const visit = (node: Object3D, owner?: Object3D) => {
      const data = node.userData;
      if (data.officePassable === true || data.officeCollision === false) return;
      // Batched originals are invisible only as a rendering optimization. Hidden templates are not colliders.
      const invisible = !node.visible && data.officeBatchSource !== true;
      if (invisible) return;
      const seatOwner = data.officeSeat === true ? node : owner;
      if (data.officeSeat === true) this.seats.set(node, bounds(new Box3().setFromObject(node)));
      const mesh = node as Mesh;
      if (mesh.isMesh && !('isInstancedMesh' in mesh && mesh.isInstancedMesh)) {
        mesh.geometry.computeBoundingBox();
        if (mesh.geometry.boundingBox) {
          box.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
          if (!box.isEmpty() && [box.min.x, box.min.y, box.min.z, box.max.x, box.max.y, box.max.z].every(Number.isFinite)) {
            const record = bounds(box), level = Math.round(box.max.y / FLOOR_HEIGHT) * FLOOR_HEIGHT;
            if (seatOwner) record.seatOwner = seatOwner;
            if (box.max.y - box.min.y <= .45 && box.max.y >= level - .15 && box.max.y <= level + .24 &&
              box.max.x - box.min.x > .25 && box.max.z - box.min.z > .25) {
              cells(record, cell => { const bucket = this.supports.get(cell) ?? []; bucket.push(record); this.supports.set(cell, bucket); });
            }
            // Ignore the floor finish and overhead details. Each story tests its own body-height interval.
            let solid = false;
            for (let floor = 0; floor < 3; floor++) if (box.max.y > floor * FLOOR_HEIGHT + .3 && box.min.y < floor * FLOOR_HEIGHT + 1.75) solid = true;
            if (solid) { cells(record, cell => { const bucket = this.solids.get(cell) ?? []; bucket.push(record); this.solids.set(cell, bucket); }); this.colliderCount++; }
          }
        }
      }
      for (const child of node.children) visit(child, seatOwner);
    };
    for (const root of roots) {
      root.updateWorldMatrix(true, true);
      // Floor visibility is a view choice, not a change to its physical layout.
      for (const child of root.children) visit(child);
    }
    this.ready = roots.length > 0;
  }
  private inside(x: number, z: number, inset = 0): boolean {
    const polygon = buildingFootprintPolygon('lower');
    return polygon.every((a, i) => { const b = polygon[(i + 1) % polygon.length]!; return (b[0] - a[0]) * (z - a[1]) - (b[1] - a[1]) * (x - a[0]) >= inset * Math.hypot(b[0] - a[0], b[1] - a[1]) - 1e-8; });
  }
  private supported(x: number, y: number, z: number): boolean {
    // The forecourt is ground-level; upper stories must stay on an actual slab, including its stair cutouts.
    if (y < .5) return true;
    return (this.supports.get(key(Math.floor(x / CELL), Math.floor(z / CELL))) ?? []).some(box =>
      box.maxY >= y - .15 && box.maxY <= y + .24 && x >= box.minX && x <= box.maxX && z >= box.minZ && z <= box.maxZ);
  }
  segmentClear = (from: Readonly<Point3>, to: Readonly<Point3>, radius = .28): boolean => {
    return this.segmentClearExcept(from, to, radius);
  };
  /** Only the target cushion may overlap the controlled forward sit/rise lane. */
  seatContactClear = (seat: SeatApproach, from: Readonly<Point3>, to: Readonly<Point3>, radius = .29): boolean => {
    const c = Math.cos(seat.rotationY), s = Math.sin(seat.rotationY);
    for (const point of [from, to]) {
      const dx = point[0] - seat.seat[0], dz = point[2] - seat.seat[2];
      const x = dx * c - dz * s, z = dx * s + dz * c;
      if (Math.abs(x) > .12 || z < -.01 || z > (seat.seatFront ?? .23) + 1.3 || Math.abs(point[1] - seat.seat[1]) > .05) return false;
    }
    let owner: Object3D | undefined, area = Infinity;
    for (const [node, box] of this.seats) {
      if (box.maxY < seat.seat[1] + .25 || box.minY > seat.seat[1] + seat.seatHeight + .1 ||
          seat.seat[0] < box.minX - .02 || seat.seat[0] > box.maxX + .02 || seat.seat[2] < box.minZ - .02 || seat.seat[2] > box.maxZ + .02) continue;
      const size = (box.maxX - box.minX) * (box.maxZ - box.minZ);
      if (size < area) { area = size; owner = node; }
    }
    return Boolean(owner) && this.segmentClearExcept(from, to, radius, owner);
  };
  private segmentClearExcept(from: Readonly<Point3>, to: Readonly<Point3>, radius: number, ignore?: Object3D): boolean {
    if (!this.ready || ![...from, ...to, radius].every(Number.isFinite) || radius < 0 || Math.abs(from[1] - to[1]) > .05) return false;
    const query: Bounds = { minX: Math.min(from[0], to[0]) - radius, maxX: Math.max(from[0], to[0]) + radius,
      minZ: Math.min(from[2], to[2]) - radius, maxZ: Math.max(from[2], to[2]) + radius, minY: from[1] + .3, maxY: from[1] + 1.75 };
    let hit = false;
    const seen = new Set<Bounds>();
    cells(query, cell => { if (hit) return; for (const box of this.solids.get(cell) ?? []) {
      if (seen.has(box) || (ignore && box.seatOwner === ignore)) continue; seen.add(box);
      if (box.maxY > query.minY && box.minY < query.maxY && intersects(from, to, box, radius)) { hit = true; break; }
    } });
    if (hit) return false;
    const keepBuilding = from[1] > .5 || (this.inside(from[0], from[2]) && this.inside(to[0], to[2]));
    const count = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .25));
    for (let i = 0; i <= count; i++) {
      const t = i / count, x = from[0] + (to[0] - from[0]) * t, z = from[2] + (to[2] - from[2]) * t;
      if (keepBuilding && !this.inside(x, z, radius)) return false;
      for (const [dx, dz] of [[0, 0], [radius, 0], [-radius, 0], [0, radius], [0, -radius],
        [radius, radius], [-radius, radius], [radius, -radius], [-radius, -radius]])
        if (!this.supported(x + dx!, from[1], z + dz!)) return false;
    }
    return true;
  }
}
const fields = new WeakMap<object, WalkingClearance>();
export function walkingClearanceFor(owner: object): WalkingClearance {
  let field = fields.get(owner); if (!field) { field = new WalkingClearance(); fields.set(owner, field); } return field;
}
