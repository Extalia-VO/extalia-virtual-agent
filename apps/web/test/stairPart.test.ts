import type * as ReactTypes from 'react';
import { Children, isValidElement, type ReactElement, type ReactNode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Scene, type Object3D } from 'three';
import { createStairInstance, createStairLibraryStore, StairPart, STAIR_PART_NOMINAL, stairPartScale, useStairLibrary } from '../src/office/scene/prefabs/architecture/StairPart';
import { Staircase } from '../src/office/scene/prefabs/architecture/Staircase';
import { OFFICE_STAIRCASE } from '../src/office/scene/layout';
import { StaticCampusBatch } from '../src/office/scene/StaticCampusBatch';
import { ModelBatchController } from '../src/office/scene/ModelInstanceBatches';

const state = vi.hoisted(() => ({ assets: null as ReadonlyMap<string, Object3D> | null,
  batchRoot: null as Group | null, layout: undefined as (() => void | (() => void)) | undefined }));
vi.mock('react', async original => ({ ...await original<typeof ReactTypes>(),
  useMemo: (factory: () => unknown) => factory(),
  useContext: () => null,
  useState: () => [0, () => {}],
  useCallback: (callback: unknown) => callback,
  useEffect: () => undefined,
  useSyncExternalStore: () => state.assets,
  useRef: () => ({ current: state.batchRoot }),
  useLayoutEffect: (effect: typeof state.layout) => { state.layout = effect; },
}));
vi.mock('../src/office/scene/Environment', () => ({ useSolarEnvironment: () => ({ state: { factors: { interiorLightFactor: .6, exteriorLightFactor: .7 } } }) }));

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode, expand = false): Element[] {
  const result: Element[] = [];
  Children.forEach(node, child => {
    if (!isValidElement(child)) return;
    const element = child as Element;
    result.push(element);
    const name = typeof element.type === 'function' ? element.type.name : '';
    if (expand && ['StairTreadLighting', 'StairFlightLighting', 'StairUndersideLighting', 'FlightGlassRail', 'LandingGlassRail'].includes(name)) {
      result.push(...elements((element.type as (props: unknown) => ReactNode)(element.props), expand));
    } else result.push(...elements(element.props.children as ReactNode, expand));
  });
  return result;
}
function source() {
  const geometry = new BoxGeometry(1, 1, 1), material = new MeshStandardMaterial({ name: 'Stair oak' });
  const root = new Group(); root.add(new Mesh(geometry, material));
  return { root, geometry, material, dispose: () => { geometry.dispose(); material.dispose(); } };
}

describe('stair library lifecycle and fallback', () => {
  it('deduplicates asynchronous loading, accepts only the whole contract, and unsubscribes cleanly', async () => {
    const scene = new Group(), f = source();
    for (const name of Object.keys(STAIR_PART_NOMINAL)) {
      const group = new Group(); group.name = name; group.add(new Mesh(f.geometry, f.material)); scene.add(group);
    }
    let resolve!: (scene: Group) => void;
    const loader = vi.fn(() => new Promise<Group>(done => { resolve = done; }));
    const store = createStairLibraryStore('/local-stairs.glb', loader);
    const listener = vi.fn(), removed = vi.fn(), unsubscribe = store.subscribe(removed);
    store.subscribe(listener);
    const a = store.load(), b = store.load();
    expect(a).toBe(b); expect(loader).toHaveBeenCalledTimes(1); expect(store.getSnapshot()).toBeNull();
    unsubscribe(); resolve(scene); await a;
    expect(listener).toHaveBeenCalledTimes(1); expect(removed).not.toHaveBeenCalled();
    expect(store.getSnapshot()?.size).toBe(6);
    await store.load(); expect(loader).toHaveBeenCalledTimes(1); f.dispose();
  });

  it('retains fallback for missing and failed assets and disposes incomplete library resources once', async () => {
    const missing = vi.fn(); await createStairLibraryStore(undefined, missing).load(); expect(missing).not.toHaveBeenCalled();
    const failedLoader = vi.fn(async () => { throw new Error('404'); });
    const failed = createStairLibraryStore('/missing.glb', failedLoader);
    await failed.load(); await failed.load(); expect(failed.getSnapshot()).toBeNull(); expect(failedLoader).toHaveBeenCalledTimes(1);
    const f = source(); f.root.add(new Mesh(f.geometry, f.material));
    const geometryDispose = vi.spyOn(f.geometry, 'dispose'), materialDispose = vi.spyOn(f.material, 'dispose');
    const incomplete = createStairLibraryStore('/incomplete.glb', async () => f.root);
    await incomplete.load(); expect(incomplete.getSnapshot()).toBeNull();
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('rejects all six named but empty roots and releases rejected scene resources', async () => {
    const f = source(), scene = new Group();
    // Unrelated geometry must not make empty contract modules look complete.
    scene.add(new Mesh(f.geometry, f.material));
    for (const name of Object.keys(STAIR_PART_NOMINAL)) { const group = new Group(); group.name = name; scene.add(group); }
    const geometryDispose = vi.spyOn(f.geometry, 'dispose'), materialDispose = vi.spyOn(f.material, 'dispose');
    const store = createStairLibraryStore('/empty-roots.glb', async () => scene);
    await store.load(); expect(store.getSnapshot()).toBeNull();
    expect(geometryDispose).toHaveBeenCalledTimes(1); expect(materialDispose).toHaveBeenCalledTimes(1);
  });

  it('shares loaded geometry and opaque materials while keeping instance transforms independent', () => {
    const f = source();
    try {
      const a = createStairInstance(f.root), b = createStairInstance(f.root);
      for (const root of [a, b]) {
        const mesh = root.children[0] as Mesh;
        expect(mesh.geometry).toBe(f.geometry); expect(mesh.material).toBe(f.material);
        expect(mesh.userData.officeInstanceable).toBe(true); expect(mesh.castShadow).toBe(true);
      }
      a.position.x = 10; expect(b.position.x).toBe(0); expect(f.root.position.x).toBe(0);
      expect((f.root.children[0] as Mesh).castShadow).toBe(false);
      state.assets = new Map([['stair-tread', f.root]]);
      const tree = StairPart({ model: 'stair-tread', dimensions: [5.9, .09, 5.3 / 9], children: 'fallback' });
      const rendered = elements(tree);
      expect(tree.props.userData).toMatchObject({ interiorAuthored: true });
      expect(tree.props.userData.officeDynamic).not.toBe(true);
      expect(rendered.find(element => element.type === 'primitive')?.props.dispose).toBeNull();
      expect(rendered.some(element => element.type === StaticCampusBatch)).toBe(false);
      expect(rendered.some(element => JSON.stringify(element.props.scale) === '[2,1,2]')).toBe(true);
    } finally { state.assets = null; f.dispose(); }
  });

  it('batches authored opaque modules across dynamic parents without owning library resources', () => {
    const f = source(), scene = new Scene(), controller = new ModelBatchController(scene);
    const geometryDispose = vi.spyOn(f.geometry, 'dispose'), materialDispose = vi.spyOn(f.material, 'dispose');
    try {
      for (const x of [-2, 2]) {
        const wrapper = new Group(); wrapper.userData.officeDynamic = true;
        wrapper.position.x = x; wrapper.add(createStairInstance(f.root)); scene.add(wrapper);
      }
      scene.updateMatrixWorld(true); controller.update(0);
      expect(scene.userData.modelInstanceBatchStats).toMatchObject({ batches: 1, sources: 2, visibleInstances: 2 });
      controller.dispose();
      expect(geometryDispose).not.toHaveBeenCalled(); expect(materialDispose).not.toHaveBeenCalled();
    } finally { controller.dispose(); f.dispose(); }
  });

  it('exposes shared library readiness and keeps fallback in the parent batch', () => {
    expect(useStairLibrary()).toBeNull();
    const tree = StairPart({ model: 'stair-tread', children: 'complete-fallback' });
    expect(tree.props.userData).toMatchObject({ interiorAuthored: false });
    expect(tree.props.userData.officeDynamic).not.toBe(true);
    expect(tree.props.children).toBe('complete-fallback');
    expect(elements(tree).some(element => element.type === StaticCampusBatch)).toBe(false);
    const f = source(), wrapper = new Group(), floor = new Group();
    const a = new Mesh(f.geometry, f.material), b = new Mesh(f.geometry, f.material);
    wrapper.userData.officeDynamic = false; wrapper.add(a, b); floor.add(wrapper);
    const batch = () => { state.batchRoot = floor; StaticCampusBatch({ children: null }); return state.layout?.(); };
    let cleanup = batch();
    try {
      expect(floor.userData.staticBatchStats.mergedMeshes).toBe(2);
      expect(a.visible).toBe(false);
      // A parent revision cleans the previous bake after the model-ready render.
      wrapper.remove(a, b); wrapper.userData.officeDynamic = true;
      const instance = createStairInstance(f.root); wrapper.add(instance);
      if (typeof cleanup === 'function') cleanup();
      expect(a.visible).toBe(true); expect(a.userData.officeBatchSource).toBeUndefined();
      cleanup = batch();
      expect(floor.userData.staticBatchStats.mergedMeshes).toBe(0);
      expect((instance.children[0] as Mesh).visible).toBe(true);
      expect(floor.children.filter(child => child !== wrapper).every(child => child.children.length === 0)).toBe(true);
      state.assets = new Map([['stair-tread', f.root]]);
      expect(useStairLibrary()).toBe(state.assets);
    } finally {
      if (typeof cleanup === 'function') cleanup();
      f.dispose(); state.batchRoot = null; state.assets = null;
    }
  });
});

describe('stair geometry and app-owned behavior', () => {
  it('scales by nominal semantics rather than decorative bounds', () => {
    expect(stairPartScale('stair-tread', [2.95, .09, 5.3 / 18])).toEqual([1, 1, 1]);
    expect(stairPartScale('stair-landing', [6.4, .13, 2.6])).toEqual([6.4, 1, 2.6]);
    expect(stairPartScale('stair-stringer', [.12, .24, 6.2])).toEqual([1, 1, 6.2]);
  });

  it('keeps both flights, their exact contact heights, landing and lighting contract', () => {
    const tree = elements(Staircase({}), true);
    const treads = tree.filter(element => /^stair-flight-[12]-tread-\d+$/.test(String(element.props.name)));
    expect(treads).toHaveLength(36);
    const { rise, width, gap, runPerFlight: run, stepsPerFlight: steps } = OFFICE_STAIRCASE;
    for (const [flight, direction] of [[1, 1], [2, -1]]) for (let i = 0; i < steps; i++) {
      const tread = treads.find(element => element.props.name === `stair-flight-${flight}-tread-${i+1}`)!;
      expect(tread.props.position).toEqual([-direction!*(width+gap)/2, (flight === 1 ? 0 : rise/2)+rise/2/steps*(i+1), direction!*(-run/2+run/steps*(i+.5))]);
    }
    expect(tree.filter(element => element.type === StairPart && element.props.model === 'stair-tread')).toHaveLength(36);
    expect(tree.filter(element => element.type === StairPart && element.props.model === 'stair-stringer')).toHaveLength(4);
    expect(tree.filter(element => element.type === StairPart && element.props.model === 'stair-landing')).toHaveLength(3);
    const dynamic = tree.filter(element => (element.props.userData as { officeMaterialDynamic?: string })?.officeMaterialDynamic);
    expect(dynamic.length).toBeGreaterThan(60);
    expect(dynamic.every(element => (element.props.userData as { officeMaterialDynamic: string }).officeMaterialDynamic === 'stair-led:interior:#fff0db:factor*1.5')).toBe(true);
    const downlights = tree.filter(element => typeof element.type === 'function' && element.type.name === 'FixtureSpotLight');
    expect(downlights).toHaveLength(127);
    const stripLighting = tree.find(element => element.props.name === 'stair-tread-strip-spill')!;
    expect(elements(stripLighting).some(element => element.type === 'mesh' || element.type === 'spotLight')).toBe(false);
    const stripSources = downlights.filter(element => element.props.bakedOnly);
    expect(stripSources).toHaveLength(108);
    for (const source of stripSources) {
      expect(source.props.intensity).toBeCloseTo(.7 * .6);
      expect(source.props.floorY).toBe(0);
    }
    const upperTree = elements(Staircase({ position: [0, 6.4, 0] }), true);
    const upperStripSources = upperTree.filter(element => element.props.bakedOnly);
    expect(upperStripSources).toHaveLength(108);
    expect(upperStripSources.every(element => element.props.floorY === 6.4)).toBe(true);
    expect(downlights.filter(element => !element.props.bakedOnly)).toHaveLength(19);
    // Each sloped pane retains vertical front/rear ends instead of rotated guard boxes.
    upperTree.filter(element => element.props.geometry).forEach(element => (element.props.geometry as BoxGeometry).dispose());
    const panes = tree.filter(element => element.props.geometry).map(element => element.props.geometry as BoxGeometry);
    expect(panes).toHaveLength(20);
    for (const pane of panes) {
      const vertices = pane.getAttribute('position');
      const zs = new Set(Array.from({ length: vertices.count }, (_, i) => vertices.getZ(i).toFixed(5)));
      expect(zs.size).toBe(2);
      pane.dispose();
    }
  });
});
