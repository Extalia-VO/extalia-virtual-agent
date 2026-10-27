import { describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { createWorkstationInstance, updateWorkstationLampMaterials } from '../src/office/scene/interior/WorkstationPart';
import { deskLayout, FULL_ALPHA_OFFSET, KEYBOARD_DIMENSIONS, KEY_PITCH, MOUSE_DIMENSIONS, MOUSE_PAD } from '../src/office/scene/interior/deskLayout';
import { SINGLE_WORKSTATION_BLUEPRINT as SINGLE } from '../src/office/scene/interior/spatialBlueprints';
import { MONITOR } from '../src/office/scene/interior/prefabs/props/deviceGeometry';
import PROFILE from '../src/office/scene/interior/workstationAssetProfile.json';

describe('workstation model ownership and shared dimensions', () => {
  it('keeps Blender authoring dimensions aligned with the actual semantic device frames', () => {
    expect(SINGLE.topY + SINGLE.topSize[1]/2).toBe(PROFILE.desk.top);
    expect(SINGLE.topSize[0]).toBe(PROFILE.desk.width);
    expect(PROFILE.monitor.width).toBe(MONITOR.width);
    expect(PROFILE.monitor.height).toBe(MONITOR.width / MONITOR.aspect);
    expect(PROFILE.monitor.bezel).toBe(MONITOR.bezel);
    expect(PROFILE.keyboard.fullAlphaOffset).toBeCloseTo(FULL_ALPHA_OFFSET, 12);
    expect(PROFILE.keyboard.pitch).toBe(KEY_PITCH);
    expect(PROFILE.keyboard.compactWidth).toBe(KEYBOARD_DIMENSIONS.compact.width);
    expect(PROFILE.keyboard.fullWidth).toBe(KEYBOARD_DIMENSIONS.full.width);
    expect(PROFILE.mouse.height).toBe(MOUSE_DIMENSIONS.height);
    expect(PROFILE.pad.thickness).toBe(MOUSE_PAD.thickness);
  });

  it('shares immutable geometry but isolates customized wood and solar lamp materials', () => {
    const source = new Group(), geometry = new BoxGeometry(1,1,1);
    const wood = new MeshStandardMaterial({ name: 'Honey oak', color: '#a77e58' });
    const diffuser = new MeshStandardMaterial({ name: 'Desk lamp diffuser', emissive: '#ffcc84', emissiveIntensity: .25 });
    source.add(new Mesh(geometry, wood), new Mesh(geometry, diffuser));
    const a = createWorkstationInstance(source, '#abcdef'), b = createWorkstationInstance(source);
    expect((a.root.children[0] as Mesh).geometry).toBe(geometry);
    expect((a.root.children[0] as Mesh).material).not.toBe(wood);
    expect((b.root.children[0] as Mesh).material).toBe(wood);
    expect(wood.color.getHexString()).toBe('a77e58');
    updateWorkstationLampMaterials(a.lamps, 1);
    expect(a.lamps[0]!.emissiveIntensity).toBeCloseTo(3.1);
    expect(b.lamps[0]!.emissiveIntensity).toBe(.25);
    expect(diffuser.emissiveIntensity).toBe(.25);
    updateWorkstationLampMaterials(a.lamps, 0);
    expect(a.lamps[0]!.emissiveIntensity).toBe(0);
    for (const material of [...a.owned,...b.owned]) material.dispose();
    geometry.dispose(); wood.dispose(); diffuser.dispose();
  });

  it('uses shelves, flowers and lamps in deterministic real desk arrangements', () => {
    const kinds = new Set(Array.from({length:100}, (_,i) => deskLayout(`desk-${i}`).accessories).flat());
    for (const kind of ['desk-shelf','flower-vase','ornament-lamp','books'] as const) expect(kinds.has(kind)).toBe(true);
  });
});

