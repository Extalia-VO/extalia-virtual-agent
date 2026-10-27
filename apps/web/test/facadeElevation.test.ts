import { describe, expect, it } from 'vitest';
import { BufferGeometry, DoubleSide, Mesh, MeshBasicMaterial, Raycaster, ShapeGeometry, Vector3 } from 'three';
import { facadeFrameShape, facadeFrames, FACADE_COURSE_HEIGHT } from '../src/office/scene/facadeElevation';
import { CAMPUS_ENTRY_LAYOUT, OFFICE_BUILDING } from '../src/office/scene/layout';
import { buildFacadeEnvelope } from '../src/office/scene/CampusBuildingShell';

const xScale = OFFICE_BUILDING.width / 42;
const authoredHalfWidth = (OFFICE_BUILDING.width / 2) / xScale;
const raycaster = new Raycaster();
const material = new MeshBasicMaterial({ side: DoubleSide });

function area(points: readonly (readonly [number, number])[]) {
  let signed = 0;
  for (let i = 0; i < points.length; i++) {
    const a = points[i]!, b = points[(i + 1) % points.length]!;
    signed += a[0] * b[1] - b[0] * a[1];
  }
  return signed / 2;
}

function intersectAt(mesh: Mesh, x: number, y: number) {
  mesh.updateMatrixWorld(true);
  raycaster.set(new Vector3(x, y, 1), new Vector3(0, 0, -1));
  return raycaster.intersectObject(mesh, false);
}

function distanceToLine(point: readonly [number, number], a: readonly [number, number], b: readonly [number, number]) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  return Math.abs(dx * (a[1] - point[1]) - (a[0] - point[0]) * dy) / Math.hypot(dx, dy);
}

describe('perforated facade elevation', () => {
  const frames = facadeFrames(authoredHalfWidth, xScale);

  it('builds six bounded, non-degenerate courses with consistently wound frame geometry', () => {
    expect(new Set(frames.map(frame => frame.course))).toEqual(new Set([0, 1, 2, 3, 4, 5]));
    expect(FACADE_COURSE_HEIGHT * 6).toBeCloseTo(19.2, 10);
    for (const frame of frames) {
      const bounds = frame.outline;
      // At the final course the short frame tapers exactly to its pavilion
      // boundary, so the duplicate tip is intentionally removed.
      expect(bounds.length).toBeGreaterThanOrEqual(3);
      expect(bounds.length).toBeLessThanOrEqual(4);
      expect(Math.abs(area(bounds))).toBeGreaterThan(0.1);
      const sign = Math.sign(area(bounds));
      expect(sign).toBe(frame.side === 'long' ? 1 : -1);
      for (const [x, y] of [...frame.outline, ...frame.window, ...frame.edge]) {
        expect(Number.isFinite(x) && Number.isFinite(y)).toBe(true);
        expect(x).toBeGreaterThanOrEqual(-OFFICE_BUILDING.width / 2);
        expect(x).toBeLessThanOrEqual(OFFICE_BUILDING.width / 2);
        expect(y).toBeGreaterThanOrEqual(0);
        expect(y).toBeLessThanOrEqual(FACADE_COURSE_HEIGHT * 6);
      }

      const geometry = new ShapeGeometry(facadeFrameShape(frame));
      const positions = geometry.getAttribute('position');
      const normals = geometry.getAttribute('normal');
      expect(positions.count).toBeGreaterThan(0);
      for (let i = 0; i < positions.count; i++) {
        expect(Number.isFinite(positions.getX(i)) && Number.isFinite(positions.getY(i)) && Number.isFinite(positions.getZ(i))).toBe(true);
        expect(normals.getZ(i)).toBeGreaterThan(0.99);
      }
      geometry.dispose();
    }
  });

  it('keeps every real window hole clear while the adjacent silver frame remains solid', () => {
    const perforated = frames.filter(frame => frame.window.length === 4);
    expect(perforated.length).toBeGreaterThan(4);
    for (const frame of perforated) {
      const geometry = new ShapeGeometry(facadeFrameShape(frame));
      const mesh = new Mesh(geometry, material);
      const hole = [
        frame.window.reduce((sum, p) => sum + p[0], 0) / frame.window.length,
        frame.window.reduce((sum, p) => sum + p[1], 0) / frame.window.length,
      ];
      expect(intersectAt(mesh, hole[0]!, hole[1]!)).toHaveLength(0);

      const jambX = (frame.outline[0]![0] + frame.window[0]![0]) / 2;
      const jambY = (frame.window[0]![1] + frame.window[3]![1]) / 2;
      expect(intersectAt(mesh, jambX, jambY).length).toBeGreaterThan(0);
      geometry.dispose();
    }
  });

  it('leaves the real centered ground-floor entrance open in the authoring frame', () => {
    const entranceX = OFFICE_BUILDING.centerX - CAMPUS_ENTRY_LAYOUT.centerX;
    const entranceY = 1.8;
    for (const frame of frames) {
      const geometry = new ShapeGeometry(facadeFrameShape(frame));
      const mesh = new Mesh(geometry, material);
      expect(intersectAt(mesh, entranceX, entranceY), `${frame.side} course ${frame.course}`).toHaveLength(0);
      geometry.dispose();
    }
  });

  it('joins each diagonal jamb at the shared course datum without self-crossing', () => {
    let sharedBoundaries = 0;
    for (const side of ['long', 'short'] as const) {
      for (let course = 0; course < 5; course++) {
        const lower = frames.find(frame => frame.side === side && frame.course === course);
        const upper = frames.find(frame => frame.side === side && frame.course === course + 1);
        if (!lower || !upper) continue;
        const datum = (course + 1) * FACADE_COURSE_HEIGHT;
        const lowerAtDatum = lower.outline.filter(point => Math.abs(point[1] - datum) < 1e-8);
        const upperAtDatum = upper.outline.filter(point => Math.abs(point[1] - datum) < 1e-8);
        const lowerTip = lowerAtDatum.reduce((best, point) => side === 'long' ? (point[0] > best[0] ? point : best) : (point[0] < best[0] ? point : best));
        const upperTip = upperAtDatum.reduce((best, point) => side === 'long' ? (point[0] > best[0] ? point : best) : (point[0] < best[0] ? point : best));
        expect(Math.hypot(lowerTip[0] - upperTip[0], lowerTip[1] - upperTip[1])).toBeLessThan(1e-8);
        sharedBoundaries++;
      }
    }
    expect(sharedBoundaries).toBeGreaterThanOrEqual(8);

    for (const frame of frames.filter(candidate => candidate.window.length === 4)) {
      const [bottomTip, topTip] = [frame.outline[1]!, frame.outline[2]!];
      expect(distanceToLine(frame.window[1]!, bottomTip, topTip)).toBeCloseTo(0.64, 6);
      expect(distanceToLine(frame.window[2]!, bottomTip, topTip)).toBeCloseTo(0.64, 6);
      expect(Math.sign(area(frame.window))).toBe(Math.sign(area(frame.outline)));
    }
  });

  it('assembles finite indexed facade meshes and preserves the front entrance glass opening', () => {
    const envelope = buildFacadeEnvelope();
    try {
      for (const [name, geometry] of Object.entries(envelope).filter((entry): entry is [string, BufferGeometry] => entry[1] instanceof BufferGeometry)) {
        const positions = geometry.getAttribute('position');
        const normals = geometry.getAttribute('normal');
        expect(positions, `${name} positions`).toBeDefined();
        expect(normals, `${name} normals`).toBeDefined();
        expect(positions.count).toBeGreaterThan(0);
        for (let i = 0; i < positions.count; i++) {
          expect(Number.isFinite(positions.getX(i)) && Number.isFinite(positions.getY(i)) && Number.isFinite(positions.getZ(i))).toBe(true);
          expect(Number.isFinite(normals.getX(i)) && Number.isFinite(normals.getY(i)) && Number.isFinite(normals.getZ(i))).toBe(true);
        }
        const indices = geometry.getIndex();
        expect(indices).toBeDefined();
        for (let i = 0; i < indices!.count; i++) {
          expect(Number.isInteger(indices!.getX(i))).toBe(true);
          expect(indices!.getX(i)).toBeGreaterThanOrEqual(0);
          expect(indices!.getX(i)).toBeLessThan(positions.count);
        }
      }

      const entranceX = OFFICE_BUILDING.centerX - CAMPUS_ENTRY_LAYOUT.centerX;
      const glass = new Mesh(envelope.glass, material);
      raycaster.set(new Vector3(entranceX, 1.8, CAMPUS_ENTRY_LAYOUT.shellFrontZ - 1), new Vector3(0, 0, 1));
      const firstGlass = raycaster.intersectObject(glass, false)[0];
      // A rear curtain may be seen through the lobby, but the facade plane is open.
      expect(firstGlass).toBeDefined();
      expect(firstGlass!.point.z).toBeGreaterThan(CAMPUS_ENTRY_LAYOUT.lobbyDoorZ - 1);
    } finally {
      for (const value of Object.values(envelope)) if (value instanceof BufferGeometry) value.dispose();
    }
  });
});
