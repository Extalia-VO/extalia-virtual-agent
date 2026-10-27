import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, FrontSide, Group, Mesh, MeshStandardMaterial } from 'three';
import { ARCHITECTURE_MODELS, ArchitectureMaterialPool, collectArchitectureModels, createArchitectureInstance } from '../src/office/scene/interior/ArchitecturePart';

function fixture() {
  const source = new Group(), geometry = new BoxGeometry(1, 2.55, .055);
  const metal = new MeshStandardMaterial({ name: 'Architecture aluminium', color: '#465158' });
  const paint = new MeshStandardMaterial({ name: 'Architecture wall paint', color: '#f7f5f0' });
  const glass = new MeshStandardMaterial({ name: 'Architecture glazing', transparent: true, opacity: .35, depthWrite: true });
  const stripe = new MeshStandardMaterial({ name: 'Architecture safety band', transparent: true, opacity: .65 });
  const sensor = new MeshStandardMaterial({ name: 'Architecture sensor LED', emissive: '#22ddbb', emissiveIntensity: .35 });
  source.add(...[metal, paint, glass, stripe, sensor].map(material => new Mesh(geometry, material)));
  source.children[0]!.position.set(.5, 1.275, 0);
  const pool = new ArchitectureMaterialPool();
  return { source, geometry, metal, paint, glass, stripe, sensor, pool,
    cleanup: () => { geometry.dispose(); [metal, paint, glass, stripe, sensor].forEach(material => material.dispose()); } };
}
const materialAt = (root: ReturnType<typeof createArchitectureInstance>['root'], index: number) => (root.children[index] as Mesh).material as MeshStandardMaterial;

describe('Blender architecture loading and shared material ownership', () => {
  it('accepts complete named libraries and rejects missing, empty and non-finite geometry', () => {
    const scene = new Group(), geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial();
    try {
      expect(collectArchitectureModels(scene)).toBeNull();
      for (const name of ARCHITECTURE_MODELS) {
        const root = new Group(); root.name = name; scene.add(root);
        root.add(new Mesh(geometry, material));
      }
      const result = collectArchitectureModels(scene)!;
      expect([...result.keys()]).toEqual(ARCHITECTURE_MODELS);
      expect(result.get(ARCHITECTURE_MODELS[0])).toBe(scene.children[0]);
      const root = scene.children[0]!;
      const mesh = root.children[0]!; root.remove(mesh);
      expect(collectArchitectureModels(scene)).toBeNull();
      root.add(mesh); geometry.getAttribute('position').setX(0, Number.NaN);
      expect(collectArchitectureModels(scene)).toBeNull();
    } finally { geometry.dispose(); material.dispose(); }
  });

  it('shares geometry and equal paint/glass variants without mutating source materials or transforms', async () => {
    const f = fixture();
    const a = createArchitectureInstance(f.source, '#abcdef', f.pool), b = createArchitectureInstance(f.source, '#ABCDEF', f.pool);
    a.retain(); b.retain();
    try {
      expect(a.root).not.toBe(f.source);
      expect((a.root.children[0] as Mesh).geometry).toBe(f.geometry);
      expect(materialAt(a.root, 0)).toBe(f.metal);
      expect(materialAt(a.root, 1)).toBe(materialAt(b.root, 1));
      expect(materialAt(a.root, 1).color.getHexString()).toBe('abcdef');
      expect(f.paint.color.getHexString()).toBe('f7f5f0');
      const glass = materialAt(a.root, 2);
      expect(glass).toBe(materialAt(b.root, 2)); expect(glass).not.toBe(f.glass);
      expect(glass.opacity).toBe(.2); expect(glass.depthWrite).toBe(false);
      expect(glass.side).toBe(FrontSide); expect(glass.forceSinglePass).toBe(true);
      expect(f.glass.opacity).toBe(.35); expect(f.glass.depthWrite).toBe(true);
      expect((a.root.children[2] as Mesh).castShadow).toBe(false);
      expect((a.root.children[0] as Mesh).castShadow).toBe(true);
      expect(materialAt(a.root, 3).opacity).toBe(.65);
      expect(materialAt(a.root, 3).depthWrite).toBe(false);
      expect(materialAt(a.root, 4)).toBe(f.sensor);
      a.root.children[0]!.position.x = 99;
      expect(f.source.children[0]!.position.toArray()).toEqual([.5, 1.275, 0]);
    } finally { a.dispose(); b.dispose(); await Promise.resolve(); f.cleanup(); }
  });

  it('disposes a shared variant only after its last user leaves and never disposes borrowed resources', async () => {
    const f = fixture(), sourceDisposal = vi.spyOn(f.paint, 'dispose'), geometryDisposal = vi.spyOn(f.geometry, 'dispose');
    const a = createArchitectureInstance(f.source, '#334455', f.pool), b = createArchitectureInstance(f.source, '#334455', f.pool);
    a.retain(); b.retain();
    const variant = materialAt(a.root, 1), disposal = vi.spyOn(variant, 'dispose');
    try {
      a.dispose(); a.dispose(); await Promise.resolve();
      expect(disposal).not.toHaveBeenCalled();
      expect(materialAt(b.root, 1)).toBe(variant);
      b.dispose(); await Promise.resolve();
      expect(disposal).toHaveBeenCalledTimes(1);
      expect(sourceDisposal).not.toHaveBeenCalled(); expect(geometryDisposal).not.toHaveBeenCalled();
    } finally { a.dispose(); b.dispose(); await Promise.resolve(); f.cleanup(); }
  });

  it('retains pooled identity through Strict Mode effect replay and isolates different room paints', async () => {
    const f = fixture(), a = createArchitectureInstance(f.source, '#112233', f.pool), b = createArchitectureInstance(f.source, '#aabbcc', f.pool);
    a.retain(); b.retain();
    const paint = materialAt(a.root, 1), disposal = vi.spyOn(paint, 'dispose');
    try {
      a.dispose(); a.retain(); await Promise.resolve();
      expect(disposal).not.toHaveBeenCalled();
      expect(materialAt(a.root, 1)).not.toBe(materialAt(b.root, 1));
      expect(materialAt(a.root, 2)).toBe(materialAt(b.root, 2));
      a.dispose(); await Promise.resolve(); expect(disposal).toHaveBeenCalledTimes(1);
    } finally { a.dispose(); b.dispose(); await Promise.resolve(); f.cleanup(); }
  });
});
