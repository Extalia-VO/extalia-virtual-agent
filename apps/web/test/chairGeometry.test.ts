import { describe, expect, it } from 'vitest';
import { BoxGeometry, Color, Group, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { mergeChair } from '../src/office/scene/interior/chairGeometry';

describe('Blender chair geometry batching', () => {
  it('bakes child transforms in chair space, keeping the floor origin and shared source buffers intact', () => {
    const root = new Group();
    root.position.set(3, 2, -4);
    root.rotation.y = .7;
    const shape = new BoxGeometry(.5, .11, .46);
    const chair = new Mesh(shape, new MeshStandardMaterial({ color: '#516368' }));
    chair.position.set(0, .405, .015);
    root.add(chair);
    const before = Array.from(shape.getAttribute('position').array);
    const merged = mergeChair(root)!;
    expect(merged.boundingBox!.min.x).toBeCloseTo(-.25, 6);
    expect(merged.boundingBox!.min.y).toBeCloseTo(.35, 6);
    expect(merged.boundingBox!.min.z).toBeCloseTo(-.215, 6);
    expect(merged.boundingBox!.max.y).toBeCloseTo(.46, 6);
    expect(merged.boundingBox!.max.z).toBeCloseTo(.245, 6);
    expect(Array.from(shape.getAttribute('position').array)).toEqual(before);
    expect(merged.getAttribute('color').count).toBe(merged.getAttribute('position').count);
    merged.dispose(); shape.dispose(); (chair.material as MeshStandardMaterial).dispose();
  });

  it('keeps authored smooth normals and all material regions while accepting mixed export attributes', () => {
    const root = new Group();
    const shape = new BoxGeometry(1, 1, 1);
    shape.setAttribute('tangent', shape.getAttribute('normal').clone());
    const red = new MeshStandardMaterial({ color: '#ff0000' });
    const blue = new MeshStandardMaterial({ color: '#0000ff' });
    const normal = new Vector3(.2, .8, .4).normalize();
    const normals = shape.getAttribute('normal');
    for (let i = 0; i < normals.count; i++) normals.setXYZ(i, normal.x, normal.y, normal.z);
    root.add(new Mesh(shape, [red, blue, red, blue, red, blue]));
    const other = new BoxGeometry(.2, .2, .2).toNonIndexed();
    other.deleteAttribute('uv');
    root.add(new Mesh(other, blue));
    const merged = mergeChair(root)!;
    expect(Object.keys(merged.attributes).sort()).toEqual(['color', 'normal', 'position']);
    expect(merged.getAttribute('normal').getX(0)).toBeCloseTo(normal.x, 6);
    const colors = merged.getAttribute('color');
    expect(new Color().fromBufferAttribute(colors, 0).getHex()).toBe(0xff0000);
    expect(new Color().fromBufferAttribute(colors, 6).getHex()).toBe(0x0000ff);
    expect(merged.groups).toHaveLength(0);
    merged.dispose(); shape.dispose(); other.dispose(); red.dispose(); blue.dispose();
  });

  it('returns no geometry for an absent model so procedural chairs remain available', () => {
    expect(mergeChair(new Group())).toBeNull();
  });
});
