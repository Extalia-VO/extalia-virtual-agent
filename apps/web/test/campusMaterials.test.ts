import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Color, DoubleSide, FrontSide, Group, Material, Mesh, MeshPhysicalMaterial, MeshStandardMaterial } from 'three';
import { createLiveModel, roleOf, updateLiveModelLighting, type GlassRole } from '../src/office/scene/campusModels';

const roles: readonly [GlassRole, number][] = [['facade_glass', 0.42], ['elevator_shaft_glass', 0.14], ['balustrade_glass', 0.18]];

function sceneWith(materials: Material[]) {
  const root = new Group();
  const geometry = new BoxGeometry();
  for (const material of materials) root.add(new Mesh(geometry, material));
  return { root, geometry };
}

function pane(root: Group, index: number): MeshPhysicalMaterial {
  return (root.children[index] as Mesh).material as MeshPhysicalMaterial;
}

describe('authored campus glazing', () => {
  it('preserves linear colors, alpha and culling by explicit role without adding shaft or railing glow', () => {
    const sources = roles.map(([role, opacity]) => {
      const material = new MeshPhysicalMaterial({ color: new Color(0.16, 0.22, 0.27), opacity, roughness: 0.12, metalness: 0, ior: 1.5, side: FrontSide });
      material.name = 'Exported pane';
      material.userData.extalia_material_role = role;
      expect(roleOf(material)).toBe('glass');
      return material;
    });
    const { root, geometry } = sceneWith(sources);
    const model = createLiveModel(root);
    try {
      for (const [index, [, opacity]] of roles.entries()) {
        const glass = pane(model.root, index);
        expect(glass.color.toArray()).toEqual([0.16, 0.22, 0.27]);
        expect(glass.opacity).toBe(opacity);
        expect(glass.side).toBe(FrontSide);
        expect(glass.roughness).toBe(0.12);
        expect(glass.metalness).toBe(0);
        expect(glass.ior).toBe(1.5);
        expect(glass.clearcoat).toBe(0);
        expect(glass.transmission).toBe(0);
        expect(glass.depthWrite).toBe(false);
        expect(glass.transparent).toBe(true);
        expect(glass.emissiveIntensity).toBe(0);
        expect((model.root.children[index] as Mesh).castShadow).toBe(false);
      }
      updateLiveModelLighting(model, 1, 1);
      expect(pane(model.root, 0).emissiveIntensity).toBe(0.16);
      for (const index of [1, 2]) {
        expect(pane(model.root, index).emissiveIntensity).toBe(0);
        expect(pane(model.root, index).emissive.getHex()).toBe(0);
      }
      updateLiveModelLighting(model, 0, 0);
      expect(pane(model.root, 0).emissiveIntensity).toBe(0);
      expect(sources[0]!.emissiveIntensity).toBe(1);
    } finally {
      model.owned.forEach(material => material.dispose());
      sources.forEach(material => material.dispose());
      geometry.dispose();
    }
  });

  it('recognizes V14 names without extras and retains authored transparent and opaque endpoints', () => {
    const sources = ['Glass - facade neutral bluegrey', 'Glass - elevator clear bluegrey', 'Glass - balustrade clear bluegrey']
      .map((name, index) => Object.assign(new MeshStandardMaterial({ opacity: [0, 0.14, 1][index], side: FrontSide, color: new Color(0.16, 0.22, 0.27), roughness: 0.12 }), { name }));
    const { root, geometry } = sceneWith(sources);
    const model = createLiveModel(root);
    try {
      expect([0, 1, 2].map(index => pane(model.root, index).opacity)).toEqual([0, 0.14, 1]);
      expect(model.facadeGlass).toEqual([pane(model.root, 0)]);
    } finally {
      model.owned.forEach(material => material.dispose());
      sources.forEach(material => material.dispose());
      geometry.dispose();
    }
  });

  it('keeps legacy defaults, classifies shaft/railing names and shares replacements without owning source resources', () => {
    const facade = Object.assign(new MeshStandardMaterial(), { name: 'Glass.001' });
    const shaft = Object.assign(new MeshStandardMaterial({ transparent: true, opacity: 0.24 }), { name: 'Review - elevator shaft glass' });
    const railing = Object.assign(new MeshStandardMaterial({ transparent: true, opacity: 0.27 }), { name: 'Review - laminated balustrade glass' });
    const accent = Object.assign(new MeshStandardMaterial(), { name: 'Accent.001' });
    const solid = Object.assign(new MeshStandardMaterial(), { name: 'Cladding' });
    const sources = [facade, shaft, railing, accent, solid];
    const { root, geometry } = sceneWith([facade, facade, shaft, railing, accent, accent, solid]);
    const sourceDispose = sources.map(material => vi.spyOn(material, 'dispose'));
    const model = createLiveModel(root);
    const disposed = model.owned.map(material => vi.spyOn(material, 'dispose'));
    try {
      expect(pane(model.root, 0)).toBe(pane(model.root, 1));
      expect(pane(model.root, 4)).toBe(pane(model.root, 5));
      expect(pane(model.root, 6)).toBe(solid);
      expect(model.owned).toHaveLength(4);
      expect(pane(root, 0)).toBe(facade);
      expect(pane(model.root, 0).opacity).toBe(0.42);
      expect(pane(model.root, 0).side).toBe(DoubleSide);
      expect(pane(model.root, 0).color.getHexString()).toBe('a9c6d4');
      updateLiveModelLighting(model, 1, 1);
      expect(pane(model.root, 2).emissiveIntensity).toBe(0);
      expect(pane(model.root, 3).emissiveIntensity).toBe(0);
      expect(pane(model.root, 4).emissiveIntensity).toBe(0.65);
      model.owned.forEach(material => material.dispose());
      expect(disposed.every(spy => spy.mock.calls.length === 1)).toBe(true);
      expect(sourceDispose.every(spy => spy.mock.calls.length === 0)).toBe(true);
    } finally {
      sources.forEach(material => material.dispose());
      geometry.dispose();
    }
  });

  it('keeps live panes and accents outside static batches while preserving static solids and source metadata', () => {
    const glass = Object.assign(new MeshStandardMaterial({ transparent: true, opacity: .3 }), { name: 'Glass facade' });
    const accent = Object.assign(new MeshStandardMaterial(), { name: 'Accent warm edge' });
    const solid = Object.assign(new MeshStandardMaterial(), { name: 'Frame' });
    const { root, geometry } = sceneWith([glass, accent, solid, solid]);
    root.children[3]!.userData.officeDynamic = true;
    const model = createLiveModel(root);
    try {
      expect(model.root.children[0]!.userData.officeDynamic).toBe(true);
      expect(model.root.children[1]!.userData.officeDynamic).toBe(true);
      expect(model.root.children[2]!.userData.officeDynamic).toBeUndefined();
      expect(model.root.children[3]!.userData.officeDynamic).toBe(true);
      expect(root.children[0]!.userData.officeDynamic).toBeUndefined();
      expect(root.children[1]!.userData.officeDynamic).toBeUndefined();
      const paneMaterial = pane(model.root, 0), accentMaterial = pane(model.root, 1);
      updateLiveModelLighting(model, 1, 1);
      expect(pane(model.root, 0)).toBe(paneMaterial);
      expect(pane(model.root, 1)).toBe(accentMaterial);
      expect(paneMaterial.emissiveIntensity).toBe(.16);
      expect(accentMaterial.emissiveIntensity).toBe(.65);
    } finally {
      model.owned.forEach(material => material.dispose());
      glass.dispose(); accent.dispose(); solid.dispose(); geometry.dispose();
    }
  });

  it('uses neutral glass defaults for explicitly tagged generic materials', () => {
    const source = new Material();
    source.userData.extalia_material_role = 'elevator_shaft_glass';
    source.opacity = 0.14;
    const { root, geometry } = sceneWith([source]);
    const model = createLiveModel(root);
    try {
      const glass = pane(model.root, 0);
      expect(glass.color.toArray()).toEqual([0.16, 0.22, 0.27]);
      expect(glass.roughness).toBe(0.12);
      expect(glass.metalness).toBe(0);
      expect(glass.ior).toBe(1.5);
      expect(glass.opacity).toBe(0.14);
      expect(glass.side).toBe(FrontSide);
    } finally {
      model.owned.forEach(material => material.dispose());
      source.dispose(); geometry.dispose();
    }
  });
});
