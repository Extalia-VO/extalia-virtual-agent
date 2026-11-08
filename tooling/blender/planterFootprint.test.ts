import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import catalog from '../../apps/web/src/office/scene/campusGreenery.json';
import { floorPlanterScale, planterModelHeight, PLANTER_BOUNDS } from '../../apps/web/src/office/scene/interior/planterLayout';
import { POD_DESK_SLOTS, SINGLE_DESK_SLOTS } from '../../apps/web/src/office/scene/interior/deskLayout';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { Matrix4, Quaternion, Vector3 } = await import(webRequire.resolve('three'));
const plants = catalog.greenery.filter(entry => entry.kind === 'plant');

/** Decode shipped vertex positions independently of the rounded greenery catalog dimensions. */
function shippedPositions(id: string): InstanceType<typeof Vector3>[] {
  const raw = readFileSync(new URL(`../../apps/web/public-assets/greenery/${id}.glb`, import.meta.url));
  const jsonLength = raw.readUInt32LE(12), binary = 28 + jsonLength;
  type Node = { mesh?: number; matrix?: number[]; translation?: number[]; rotation?: number[]; scale?: number[]; children?: number[] };
  const doc = JSON.parse(raw.subarray(20, 20 + jsonLength).toString()) as {
    nodes: Node[]; meshes: { primitives: { attributes: { POSITION: number } }[] }[];
    scenes: { nodes: number[] }[]; scene?: number;
    accessors: { bufferView: number; byteOffset?: number; componentType: number; type: string; count: number }[];
    bufferViews: { byteOffset?: number; byteStride?: number }[];
  };
  const points: InstanceType<typeof Vector3>[] = [];
  const visit = (index: number, parent: InstanceType<typeof Matrix4>) => {
    const node = doc.nodes[index]!;
    const local = node.matrix ? new Matrix4().fromArray(node.matrix) : new Matrix4().compose(
      new Vector3().fromArray(node.translation ?? [0, 0, 0]),
      new Quaternion().fromArray(node.rotation ?? [0, 0, 0, 1]),
      new Vector3().fromArray(node.scale ?? [1, 1, 1]));
    const matrix = parent.clone().multiply(local);
    if (node.mesh !== undefined) for (const primitive of doc.meshes[node.mesh]!.primitives) {
      const accessor = doc.accessors[primitive.attributes.POSITION]!, view = doc.bufferViews[accessor.bufferView]!;
      expect(accessor.componentType).toBe(5126); expect(accessor.type).toBe('VEC3');
      const start = binary + (view.byteOffset ?? 0) + (accessor.byteOffset ?? 0), stride = view.byteStride ?? 12;
      for (let vertex = 0; vertex < accessor.count; vertex++) {
        const at = start + vertex * stride;
        points.push(new Vector3(raw.readFloatLE(at), raw.readFloatLE(at + 4), raw.readFloatLE(at + 8)).applyMatrix4(matrix));
      }
    }
    for (const child of node.children ?? []) visit(child, matrix);
  };
  for (const root of doc.scenes[doc.scene ?? 0]!.nodes) visit(root, new Matrix4());
  return points;
}

describe('published decorative planter silhouettes', () => {
  it('contains the actual offset crowns at arbitrary yaws and at the terrace parent scale', () => {
    const yaws = [...Array.from({ length: 32 }, (_, i) => i * Math.PI / 16), ...SINGLE_DESK_SLOTS.map(slot => slot.yaw), ...POD_DESK_SLOTS.map(slot => slot.yaw)];
    for (const model of plants) {
      const vertices = shippedPositions(model.id);
      expect(vertices.length).toBeGreaterThan(100);
      for (const role of ['desk', 'floor', 'sculptural'] as const) for (const yaw of yaws) {
        const parent = role === 'floor' ? floorPlanterScale(1.55) : 1;
        const scale = planterModelHeight(model.id, role, yaw) / model.height * parent;
        const halfWidth = PLANTER_BOUNDS[role].width * parent / 2, maxHeight = PLANTER_BOUNDS[role].height * parent;
        const c = Math.cos(yaw), s = Math.sin(yaw);
        let furthest = 0, tallest = 0, radius = 0;
        for (const point of vertices) {
          furthest = Math.max(furthest, Math.abs(point.x * c + point.z * s) * scale, Math.abs(-point.x * s + point.z * c) * scale);
          tallest = Math.max(tallest, point.y * scale);
          radius = Math.max(radius, Math.hypot(point.x, point.z) * scale);
        }
        expect(furthest, `${model.id}/${role}/${yaw}`).toBeLessThanOrEqual(halfWidth + 1e-8);
        expect(radius, `${model.id}/${role}/${yaw}`).toBeLessThanOrEqual(halfWidth + 1e-8);
        expect(tallest, `${model.id}/${role}/${yaw}`).toBeLessThanOrEqual(maxHeight + 1e-8);
      }
    }
  });

});
