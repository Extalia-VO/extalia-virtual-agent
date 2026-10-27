import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as ReactTypes from 'react';
import { createElement, type ReactElement } from 'react';
import { BackSide, BoxGeometry, Group, Mesh, MeshStandardMaterial, type BufferGeometry } from 'three';
import { FootprintBox, FootprintPlane } from '../src/office/scene/interior/FootprintPatch';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';

const state = vi.hoisted(() => ({ active: true, floor: 1, root: null as Group | null, effect: undefined as (() => void | (() => void)) | undefined }));
vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof ReactTypes>(),
  useMemo: (factory: () => unknown) => factory(),
  useEffect: () => {},
  useRef: () => ({ current: state.root }),
  useState: () => [0, () => {}],
  useCallback: (callback: unknown) => callback,
  useLayoutEffect: (effect: () => void | (() => void)) => { state.effect = effect; },
}));
vi.mock('../src/office/scene/interior/ExteriorEnvelopeContext', () => ({ useExteriorEnvelopeActive: () => state.active }));
vi.mock('../src/office/scene/interior/prefabs/architecture/StructuralCeilingContext', () => ({ useStructuralCeiling: () => ({ floor: state.floor }) }));

type Element = ReactElement<{
  children: Element | Element[] | null;
  userData?: Record<string, unknown>;
  geometry?: BufferGeometry;
  position?: number[];
  args?: number[];
}>;
function child(element: Element) { return element.props.children as Element; }
function boundary(element: Element) {
  return (element.type as (props: Element["props"]) => Element)(element.props);
}
function patch(element: Element): Element { return child(boundary(element)).props.children as Element; }

describe('rounded floor patch integration', () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => { cleanups.reverse().forEach(fn => fn()); cleanups.length = 0; state.active = true; state.floor = 1; });

  it('uses world offsets for nested room finishes and preserves interior patches', () => {
    const interior = FootprintBox({ size: [5, .08, 5], buildingOrigin: [2, 0], children: null });
    expect(interior.type).toBe('mesh');
    const edge = FootprintBox({ size: [3.7, .08, 3.7], buildingOrigin: [-19.15, -17.205], position: [0, .04, 0], children: null }) as Element;
    const mesh = patch(edge);
    expect(mesh.props.position).toEqual([0, 0, 0]);
    const positions = mesh.props.geometry!.getAttribute('position');
    let corner = false;
    for (let i = 0; i < positions.count; i++) {
      if (positions.getX(i) < -1 && positions.getZ(i) < -1) corner = true;
      expect(Math.hypot(Math.min(0, positions.getX(i)), Math.min(0, positions.getZ(i)))).toBeLessThanOrEqual(1.78001);
    }
    expect(corner).toBe(true);
    mesh.props.geometry!.dispose();
  });

  it('keeps the full terrace footprint while F3 room surfaces use the setback', () => {
    state.floor = 3;
    const terrace = patch(FootprintBox({ size: [46, .045, 6], position: [2, .0225, 16], profile: 'lower', children: null }) as Element);
    expect(terrace.props.geometry).toBeTruthy();
    expect(child(boundary(FootprintBox({ size: [46, .08, 6], position: [2, .04, 16], children: null }) as Element)).props.children).toBeNull();
    terrace.props.geometry!.dispose();
  });

  it('keeps soffit normals upward so BackSide still renders the underside', () => {
    const material = createElement("meshStandardMaterial", { side: BackSide, userData: { officeCeilingSoffit: true } });
    const plane = patch(FootprintPlane({ size: [46, 38], position: [2, 0, 0], children: material }) as Element);
    const geometry = plane.props.geometry!;
    const p = geometry.getAttribute('position');
    for (let i = 0; i < p.count; i += 3) {
      const ax = p.getX(i + 1) - p.getX(i), az = p.getZ(i + 1) - p.getZ(i);
      const bx = p.getX(i + 2) - p.getX(i), bz = p.getZ(i + 2) - p.getZ(i);
      expect(az * bx - ax * bz).toBeGreaterThan(0);
    }
    expect(plane.props.children).toBe(material);
    geometry.dispose();
  });

  it('excludes toggled patches from immutable parent batches and remounts their own batch', () => {
    const options = { size: [46, .32, 38] as const, position: [2, -.16, 0] as [number, number, number], children: null };
    const rounded = boundary(FootprintBox(options) as Element);
    expect(rounded.props.userData!.officeDynamic).toBe(true);
    expect(child(rounded).key).toBe('rounded');
    state.active = false;
    const square = boundary(FootprintBox(options) as Element);
    expect(child(square).key).toBe('rectangular');
    expect((child(child(square)).props.children as Element[])[0]!.props.args).toEqual([46, .32, 38]);
    const root = new Group(), isolated = new Group();
    isolated.userData = rounded.props.userData!;
    root.add(isolated);
    const geometry = new BoxGeometry(46, .32, 38), material = new MeshStandardMaterial();
    isolated.add(new Mesh(geometry, material), new Mesh(geometry, material));
    state.root = root; StaticCampusBatch({ children: null });
    const cleanup = state.effect?.(); if (cleanup) cleanups.push(cleanup);
    expect(root.userData.staticBatchStats.mergedMeshes).toBe(0);
    cleanups.push(() => { geometry.dispose(); material.dispose(); (child(rounded).props.children as Element).props.geometry?.dispose(); });
  });
});
