import { afterEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshBasicMaterial, MeshStandardMaterial, OrthographicCamera, PerspectiveCamera } from 'three';
import {
  campusOverviewZoom, cullableMaterial, isCampusOverview, OVERVIEW_CULL_RADIUS_PX, overviewCandidate, overviewFlags, pixelsPerMetre, setCampusOverview, shownInHierarchy,
} from '../src/office/scene/environment/overviewLod';
import { RENDER_BUDGET_LEVELS } from '../src/office/scene/environment/renderBudget';

describe('campus overview level of detail', () => {
  afterEach(() => { setCampusOverview(false); overviewFlags.interiorLiveLights = false; });

  it('measures pixels per metre for the orthographic office camera and a perspective camera', () => {
    const ortho = new OrthographicCamera(-800, 800, 500, -500);
    ortho.zoom = 11;
    expect(pixelsPerMetre(ortho, 1000, 100)).toBeCloseTo(11);
    const perspective = new PerspectiveCamera(90);
    expect(pixelsPerMetre(perspective, 1000, 10)).toBeCloseTo(50);
  });

  it('keeps emissive, unlit and tone-mapping-exempt parts so night light points stay', () => {
    expect(cullableMaterial(new MeshStandardMaterial({ color: '#888' }))).toBe(true);
    expect(cullableMaterial(new MeshStandardMaterial({ emissive: '#ffcc88', emissiveIntensity: 1 }))).toBe(false);
    expect(cullableMaterial(new MeshStandardMaterial({ emissive: '#ffcc88', emissiveIntensity: 0 }))).toBe(true);
    expect(cullableMaterial(new MeshStandardMaterial({ toneMapped: false }))).toBe(false);
    expect(cullableMaterial(new MeshBasicMaterial())).toBe(false);
    expect(cullableMaterial([new MeshStandardMaterial(), new MeshStandardMaterial({ emissive: '#fff' })])).toBe(false);
  });

  it('only considers visible meshes that are not batch sources or pick targets', () => {
    const mesh = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    expect(overviewCandidate(mesh)).toBe(true);
    mesh.userData.officeBatchSource = true;
    expect(overviewCandidate(mesh)).toBe(false);
    const hidden = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    hidden.visible = false;
    expect(overviewCandidate(hidden)).toBe(false);
    const parent = new Group();
    const child = new Mesh(new BoxGeometry(), new MeshStandardMaterial());
    parent.add(child);
    expect(shownInHierarchy(child)).toBe(true);
    parent.visible = false;
    expect(shownInHierarchy(child)).toBe(false);
  });

  it('defines a cull radius for every render budget level, never shrinking as the budget drops', () => {
    expect(OVERVIEW_CULL_RADIUS_PX).toHaveLength(RENDER_BUDGET_LEVELS.length);
    for (let i = 1; i < OVERVIEW_CULL_RADIUS_PX.length; i++) expect(OVERVIEW_CULL_RADIUS_PX[i]!).toBeGreaterThanOrEqual(OVERVIEW_CULL_RADIUS_PX[i - 1]!);
  });

  it('treats the campus camera as overview while zoomed out, with hysteresis', () => {
    expect(campusOverviewZoom(11, false)).toBe(true);
    expect(campusOverviewZoom(20, false)).toBe(false);
    expect(campusOverviewZoom(20, true)).toBe(true);
    expect(campusOverviewZoom(32, true)).toBe(false);
  });

  it('drops the interior live light pools only in the campus view', () => {
    expect(isCampusOverview()).toBe(false);
    setCampusOverview(true);
    expect(isCampusOverview()).toBe(true);
    overviewFlags.interiorLiveLights = true;
    expect(isCampusOverview()).toBe(false);
  });
});
