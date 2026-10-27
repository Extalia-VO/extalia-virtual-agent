import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { createInteriorInstance, updateInteriorEmission } from '../src/office/scene/interior/InteriorPart';

function fixture() {
  const source = new Group(), geometry = new BoxGeometry(1, 1, 1);
  const shell = new MeshStandardMaterial({ name: 'Powder coated steel', color: '#334455' });
  const upholstery = new MeshStandardMaterial({ name: 'Bench upholstery', color: '#225544' });
  const leather = new MeshStandardMaterial({ name: 'Stool leather', color: '#774433' });
  const lamp = new MeshStandardMaterial({ name: 'Interior lamp diffuser', emissive: '#ffe0aa', emissiveIntensity: .2 });
  const led = new MeshStandardMaterial({ name: 'Server LED green', emissive: '#33dd88', emissiveIntensity: .35 });
  const glass = new MeshStandardMaterial({ name: 'Display glass', transparent: true, opacity: .3, depthWrite: true });
  source.add(new Mesh(geometry, shell), new Mesh(geometry, upholstery), new Mesh(geometry, leather),
    new Mesh(geometry, lamp), new Mesh(geometry, led), new Mesh(geometry, glass),
    new Mesh(geometry, [shell, lamp, led, glass]));
  const originals = [shell, upholstery, leather, lamp, led, glass];
  return { source, geometry, originals, shell, upholstery, leather, lamp, led, glass,
    dispose: () => { geometry.dispose(); originals.forEach(material => material.dispose()); } };
}
const meshAt = (root: Group | ReturnType<typeof createInteriorInstance>['root'], index: number) => root.children[index] as Mesh;


describe('interior Blender part material ownership', () => {
  it('shares immutable geometry and shell materials while isolating per-instance tint, glass, lamps and LEDs', () => {
    const f = fixture();
    const a = createInteriorInstance(f.source, '#abcdef'), b = createInteriorInstance(f.source, '#fedcba'), untinted = createInteriorInstance(f.source);
    try {
      for (const instance of [a, b, untinted]) {
        expect(instance.root).not.toBe(f.source);
        instance.root.children.forEach((mesh, index) => {
          expect(mesh).not.toBe(f.source.children[index]);
          expect((mesh as Mesh).geometry).toBe(f.geometry);
        });
        expect(meshAt(instance.root, 0).material).toBe(f.shell);
        expect(new Set(instance.owned).size).toBe(instance.owned.length);
        expect(instance.lamps).toHaveLength(1); expect(instance.leds).toHaveLength(1);
      }
      expect((meshAt(a.root, 1).material as MeshStandardMaterial).color.getHexString()).toBe('abcdef');
      expect((meshAt(b.root, 1).material as MeshStandardMaterial).color.getHexString()).toBe('fedcba');
      expect((meshAt(a.root, 2).material as MeshStandardMaterial).color.getHexString()).toBe('abcdef');
      expect(meshAt(untinted.root, 1).material).toBe(f.upholstery);
      expect(meshAt(untinted.root, 2).material).toBe(f.leather);
      expect(a.lamps[0]).not.toBe(b.lamps[0]); expect(a.lamps[0]).not.toBe(f.lamp);
      expect(a.leds[0]).not.toBe(b.leds[0]); expect(a.leds[0]).not.toBe(f.led);
      const multi = meshAt(a.root, 6).material as MeshStandardMaterial[];
      expect(multi).toEqual([f.shell, a.lamps[0], a.leds[0], meshAt(a.root, 5).material]);
      expect(meshAt(a.root, 6).material).not.toBe(meshAt(f.source, 6).material);
      expect(a.owned).toHaveLength(5); expect(untinted.owned).toHaveLength(3);
      expect(f.upholstery.color.getHexString()).toBe('225544'); expect(f.leather.color.getHexString()).toBe('774433');
      expect(f.lamp.emissiveIntensity).toBe(.2); expect(f.led.emissiveIntensity).toBe(.35);
    } finally { [...a.owned, ...b.owned, ...untinted.owned].forEach(material => material.dispose()); f.dispose(); }
  });

  it('keeps glass transparent without depth writes or solid shadows and leaves source flags and transforms untouched', () => {
    const f = fixture(); f.source.position.set(1, 2, 3); meshAt(f.source, 5).position.z = .4;
    const instance = createInteriorInstance(f.source);
    try {
      const glass = meshAt(instance.root, 5), mixed = meshAt(instance.root, 6);
      expect(glass.material).not.toBe(f.glass);
      expect((glass.material as MeshStandardMaterial).transparent).toBe(true);
      expect((glass.material as MeshStandardMaterial).opacity).toBe(.3);
      expect((glass.material as MeshStandardMaterial).depthWrite).toBe(false);
      expect(glass.castShadow).toBe(false); expect(glass.receiveShadow).toBe(true);
      expect(mixed.castShadow).toBe(true); expect(meshAt(instance.root, 0).castShadow).toBe(true);
      expect(f.glass.depthWrite).toBe(true);
      expect(meshAt(f.source, 0).castShadow).toBe(false); expect(meshAt(f.source, 5).receiveShadow).toBe(false);
      instance.root.position.x = 99; glass.position.z = 10;
      expect(f.source.position.toArray()).toEqual([1, 2, 3]); expect(meshAt(f.source, 5).position.z).toBe(.4);
      const sourceDispose = f.originals.map(material => vi.spyOn(material, 'dispose'));
      const geometryDispose = vi.spyOn(f.geometry, 'dispose');
      instance.owned.forEach(material => material.dispose());
      expect(sourceDispose.every(spy => spy.mock.calls.length === 0)).toBe(true); expect(geometryDispose).not.toHaveBeenCalled();
    } finally { f.dispose(); }
  });

  it('follows the solar light factor while keeping server status LEDs alive and other instances unchanged', () => {
    const f = fixture(), a = createInteriorInstance(f.source), b = createInteriorInstance(f.source);
    try {
      updateInteriorEmission(a, 0, 0, false);
      expect(a.lamps[0]!.emissiveIntensity).toBe(0);
      expect(a.leds[0]!.emissiveIntensity).toBeGreaterThan(.8);
      for (const factor of [.3, 1]) {
        updateInteriorEmission(a, factor, 0, false);
        expect(a.lamps[0]!.emissiveIntensity).toBeCloseTo(.5 + factor * 3.5);
      }
      updateInteriorEmission(a, .05, 1, false); expect(a.lamps[0]!.emissiveIntensity).toBe(0);
      expect(b.lamps[0]!.emissiveIntensity).toBe(.2); expect(b.leds[0]!.emissiveIntensity).toBe(.35);
      expect(f.lamp.emissiveIntensity).toBe(.2); expect(f.led.emissiveIntensity).toBe(.35);
    } finally { [...a.owned, ...b.owned].forEach(material => material.dispose()); f.dispose(); }
  });

  it('varies LED phases smoothly per instance and holds them static for reduced motion', () => {
    const lamp = new MeshStandardMaterial(), first = new MeshStandardMaterial(), second = new MeshStandardMaterial();
    const instance = { lamps: [lamp], leds: [first, second] };
    try {
      updateInteriorEmission(instance, 1, 0, false, 0); const initial = first.emissiveIntensity;
      updateInteriorEmission(instance, 1, .1, false, 0);
      expect(Math.abs(first.emissiveIntensity - initial)).toBeLessThan(.1);
      expect(first.emissiveIntensity).not.toBeCloseTo(second.emissiveIntensity, 6);
      const previous = first.emissiveIntensity;
      updateInteriorEmission(instance, 1, .1, false, Math.PI);
      expect(first.emissiveIntensity).not.toBeCloseTo(previous, 6);
      for (const time of [0, .5, 1, 10, 100]) {
        updateInteriorEmission(instance, 0, time, false);
        for (const led of instance.leds) expect(led.emissiveIntensity).toBeGreaterThanOrEqual(.85);
        for (const led of instance.leds) expect(led.emissiveIntensity).toBeLessThanOrEqual(1.3);
        updateInteriorEmission(instance, 0, time, true, time);
        expect(first.emissiveIntensity).toBe(1.1); expect(second.emissiveIntensity).toBe(1.1);
        expect(lamp.emissiveIntensity).toBe(0);
      }
    } finally { lamp.dispose(); first.dispose(); second.dispose(); }
  });
});
