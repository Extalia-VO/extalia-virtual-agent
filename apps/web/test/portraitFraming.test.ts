import { Bone, BoxGeometry, Float32BufferAttribute, Group, Mesh, MeshBasicMaterial, Object3D, OrthographicCamera, Skeleton, SkinnedMesh, Uint16BufferAttribute, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import { applyPortraitFraming, measurePortraitFraming, PORTRAIT_EYE_LINE, PORTRAIT_HEAD_HEIGHT } from '../src/office/overlay/portrait3d/framing';

const camera = () => new OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
const fraction = (point: Vector3, view: OrthographicCamera) => {
  const ndc = point.clone().project(view);
  return { x: (ndc.x + 1) / 2, y: (1 - ndc.y) / 2 };
};
function procedural(height = 1.7, headHeight = 0.3) {
  const root = new Group(), body = new Group(), head = new Group(), eyes = new Object3D();
  body.scale.setScalar(height / 1.7); body.position.set(0.4, 0.1, -0.3); root.add(body);
  head.name = 'avatar-head'; head.position.y = 1.55; body.add(head);
  const surface = new Mesh(new BoxGeometry(0.22, headHeight, 0.2), new MeshBasicMaterial());
  surface.name = 'avatar-head-surface'; head.add(surface);
  eyes.name = 'avatar-eyes'; eyes.position.set(0, 0.035, 0.09); head.add(eyes);
  return { root, body, head, surface, eyes };
}
function source(height = 1.7, faceHeight = 0.3) {
  const root = new Group(); root.scale.setScalar(height / 1.85); root.position.set(2, 0.2, -4);
  const hips = new Bone(), head = new Bone(); hips.name = 'hips'; head.name = 'head';
  hips.position.y = 0.9; head.position.y = 0.68; hips.add(head); root.add(hips);
  const skeleton = new Skeleton([hips, head]);
  const skin = (width: number, h: number, depth: number, y: number, z: number, name: string) => {
    const geometry = new BoxGeometry(width, h, depth).translate(0, y, z), count = geometry.getAttribute('position').count;
    geometry.setAttribute('skinIndex', new Uint16BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    geometry.setAttribute('skinWeight', new Float32BufferAttribute(Array.from({ length: count }, () => [1, 0, 0, 0]).flat(), 4));
    const material = new MeshBasicMaterial(); material.name = name;
    const mesh = new SkinnedMesh(geometry, material); root.add(mesh);
    return mesh;
  };
  const surface = skin(0.22, faceHeight, 0.22, 1.7, 0, 'Skin_Head_001');
  const eyes = skin(0.12, 0.03, 0.02, 1.73, 0.085, 'Ga_Eye_001');
  root.updateMatrixWorld(true); surface.bind(skeleton); eyes.bind(skeleton); root.updateMatrixWorld(true);
  return { root, hips, head, surface, eyes };
}

describe('anatomical portrait camera framing', () => {
  it.each([1.45, 1.7, 1.95])('keeps procedural eyes and face height consistent at %s metres', height => {
    const subject = procedural(height), framing = measurePortraitFraming(subject.root)!, view = camera();
    expect(framing).not.toBeNull(); expect(applyPortraitFraming(view, framing)).toBe(true);
    const eye = subject.eyes.getWorldPosition(new Vector3());
    expect(fraction(eye, view).x).toBeCloseTo(0.5); expect(fraction(eye, view).y).toBeCloseTo(PORTRAIT_EYE_LINE);
    const top = subject.head.localToWorld(new Vector3(0, 0.15, 0));
    const bottom = subject.head.localToWorld(new Vector3(0, -0.15, 0));
    expect(fraction(bottom, view).y - fraction(top, view).y).toBeCloseTo(PORTRAIT_HEAD_HEIGHT);
  });

  it.each([1.45, 1.7, 1.95])('measures source-skin anatomy independently of nominal body height at %s metres', height => {
    for (const faceHeight of [0.27, 0.3]) {
      const subject = source(height, faceHeight), framing = measurePortraitFraming(subject.root)!, view = camera();
      expect(framing).not.toBeNull(); expect(framing.anchor).toBe(subject.head);
      expect(framing.headHeight).toBeCloseTo(faceHeight * height / 1.85);
      expect(applyPortraitFraming(view, framing)).toBe(true);
      const eyeWorld = subject.head.localToWorld(framing.localEye.clone());
      expect(fraction(eyeWorld, view).x).toBeCloseTo(0.5);
      expect(fraction(eyeWorld, view).y).toBeCloseTo(PORTRAIT_EYE_LINE);
      expect(view.top * 2).toBeCloseTo(framing.headHeight / PORTRAIT_HEAD_HEIGHT);
    }
  });

  it('ignores oversized hairstyles, clothes and props rather than shrinking the face', () => {
    const subject = procedural(), before = measurePortraitFraming(subject.root)!;
    const hair = new Mesh(new BoxGeometry(4, 5, 3), new MeshBasicMaterial()); hair.name = 'Hair'; hair.position.y = 4;
    subject.head.add(hair);
    const prop = new Mesh(new BoxGeometry(20, 20, 20), new MeshBasicMaterial()); prop.position.set(3, 3, 3); subject.root.add(prop);
    const after = measurePortraitFraming(subject.root)!;
    expect(after.headHeight).toBe(before.headHeight); expect(after.localEye).toEqual(before.localEye);
  });

  it('tracks translated/rotating head anchors without pumping scale or rescanning vertices', () => {
    for (const subject of [procedural(), source()]) {
      const framing = measurePortraitFraming(subject.root)!, view = camera(); applyPortraitFraming(view, framing);
      const span = view.top - view.bottom, read = vi.spyOn(subject.surface, 'getVertexPosition');
      subject.head.position.x += 0.05; subject.head.position.y += 0.08;
      subject.head.rotation.set(0.15, -0.25, 0.05); subject.root.position.add(new Vector3(-3, 2, 5)); subject.root.updateMatrixWorld(true);
      expect(applyPortraitFraming(view, framing)).toBe(true);
      expect(view.top - view.bottom).toBe(span); expect(read).not.toHaveBeenCalled();
      const eyeWorld = framing.localEye.clone().applyMatrix4(subject.head.matrixWorld);
      expect(fraction(eyeWorld, view).x).toBeCloseTo(0.5); expect(fraction(eyeWorld, view).y).toBeCloseTo(PORTRAIT_EYE_LINE);
      read.mockRestore();
    }
  });

  it('does not refit face-expression morphs after calibration', () => {
    const subject = procedural(), framing = measurePortraitFraming(subject.root)!, view = camera(); applyPortraitFraming(view, framing);
    const span = view.top - view.bottom, position = subject.surface.geometry.getAttribute('position');
    subject.surface.geometry.morphTargetsRelative = true;
    subject.surface.geometry.morphAttributes.position = [new Float32BufferAttribute(Array.from({ length: position.count }, () => [0, 0.03, 0]).flat(), 3)];
    subject.surface.updateMorphTargets(); subject.surface.morphTargetInfluences![0] = 1;
    expect(applyPortraitFraming(view, framing)).toBe(true); expect(view.top - view.bottom).toBe(span);
  });

  it('keeps delayed geometry retryable and refuses whole-body-only or missing-eye models', () => {
    const root = new Group(); expect(measurePortraitFraming(root)).toBeNull();
    root.add(new Mesh(new BoxGeometry(1, 2, 1), new MeshBasicMaterial())); expect(measurePortraitFraming(root)).toBeNull();
    const subject = procedural(); subject.head.remove(subject.eyes); expect(measurePortraitFraming(subject.root)).toBeNull();
    subject.head.add(subject.eyes); expect(measurePortraitFraming(subject.root)).not.toBeNull();
  });

  it('invalidates detached or replaced heads and recalibrates their replacement geometry', () => {
    const subject = procedural(), framing = measurePortraitFraming(subject.root)!, view = camera();
    subject.body.remove(subject.head); expect(applyPortraitFraming(view, framing)).toBe(false);
    subject.body.add(subject.head); subject.surface.geometry = new BoxGeometry(0.24, 0.34, 0.22);
    expect(applyPortraitFraming(view, framing)).toBe(false);
    const next = measurePortraitFraming(subject.root)!; expect(next.headHeight).toBeCloseTo(0.34);
    expect(applyPortraitFraming(view, next)).toBe(true);
  });

  it('rejects malformed/nonfinite geometry, zero scales, zero bounds and unrelated eye labels', () => {
    const missing = procedural(); missing.surface.geometry.deleteAttribute('position'); expect(measurePortraitFraming(missing.root)).toBeNull();
    const invalid = procedural(); invalid.surface.geometry.getAttribute('position').setY(0, NaN); expect(measurePortraitFraming(invalid.root)).toBeNull();
    const flat = procedural(); flat.surface.geometry = new BoxGeometry(0.2, 0, 0.2); expect(measurePortraitFraming(flat.root)).toBeNull();
    const zero = procedural(); zero.head.scale.y = 0; expect(measurePortraitFraming(zero.root)).toBeNull();
    const wrongEyes = procedural(); wrongEyes.eyes.position.x = 20; expect(measurePortraitFraming(wrongEyes.root)).toBeNull();
    const brokenSkin = source(); brokenSkin.surface.geometry.deleteAttribute('skinWeight'); expect(measurePortraitFraming(brokenSkin.root)).toBeNull();
  });

  it('uses the requested buffer aspect while leaving model proportions untouched', () => {
    const subject = procedural(), framing = measurePortraitFraming(subject.root)!, view = camera();
    for (const [width, height] of [[192, 224], [224, 224], [96, 144]]) {
      expect(applyPortraitFraming(view, framing, width, height)).toBe(true);
      expect((view.right - view.left) / (view.top - view.bottom)).toBeCloseTo(width! / height!);
      expect(fraction(subject.eyes.getWorldPosition(new Vector3()), view).y).toBeCloseTo(PORTRAIT_EYE_LINE);
    }
    for (const value of [0, -1, NaN, Infinity]) expect(applyPortraitFraming(view, framing, value, 224)).toBe(false);
    expect(subject.head.scale.toArray()).toEqual([1, 1, 1]);
  });
});
