import { describe, expect, it } from 'vitest';
import { Group, Mesh, PerspectiveCamera } from 'three';
import { createLodState, lodStep, lodTier, screenHeightPixels, setCastShadows } from '../src/office/scene/avatars/avatarLod';
import { HUMANOID_HEAD_ELONGATION, createHumanoidRigProfile } from '../src/office/scene/avatars/rig';

describe('avatar level of detail', () => {
  it('picks tiers from on-screen height with hysteresis', () => {
    expect(lodTier(400, 0)).toBe(0);
    expect(lodTier(100, 0)).toBe(1);
    expect(lodTier(30, 1)).toBe(2);
    // Just above a threshold, a figure coming back up stays in the cheaper tier until it clears the margin.
    expect(lodTier(155, 1)).toBe(1);
    expect(lodTier(180, 1)).toBe(0);
    expect(lodTier(62, 2)).toBe(2);
  });

  it('poses every frame near, and accumulates skipped time further away', () => {
    const near = createLodState();
    expect(lodStep(near, 0, 0.016)).toBeCloseTo(0.016, 6);
    const far = createLodState();
    const steps = [0, 1, 2, 3, 4, 5].map(() => lodStep(far, 2, 0.01));
    expect(steps.filter(step => step !== null)).toHaveLength(2);
    expect(steps.reduce<number>((sum, step) => sum + (step ?? 0), 0)).toBeCloseTo(0.06, 6);
  });

  it('measures a nearer figure as taller on screen', () => {
    const camera = new PerspectiveCamera(40, 1, 0.1, 100);
    camera.position.set(0, 1.6, 10);
    const figure = new Group();
    figure.updateMatrixWorld();
    const far = screenHeightPixels(figure, camera, 900);
    camera.position.set(0, 1.6, 3);
    expect(screenHeightPixels(figure, camera, 900)).toBeGreaterThan(far * 2.5);
  });

  it('drops shadows and restores each mesh to its own setting', () => {
    const root = new Group();
    const casting = new Mesh(); casting.castShadow = true;
    const plain = new Mesh(); plain.castShadow = false;
    root.add(casting, plain);
    setCastShadows(root, false);
    expect(casting.castShadow).toBe(false);
    setCastShadows(root, true);
    expect(casting.castShadow).toBe(true);
    expect(plain.castShadow).toBe(false);
  });
});

describe('procedural body proportions', () => {
  it('match the detailed models: a head about an eighth of the height, legs a little over half', () => {
    const p = createHumanoidRigProfile('proportion-check').proportions;
    const head = 2 * p.headRadius * HUMANOID_HEAD_ELONGATION;
    const height = p.standingHipHeight + p.headHeight + p.headRadius * HUMANOID_HEAD_ELONGATION;
    expect(head / height).toBeGreaterThan(0.115);
    expect(head / height).toBeLessThan(0.14);
    expect(p.standingHipHeight / height).toBeGreaterThan(0.52);
    expect(p.standingHipHeight / height).toBeLessThan(0.6);
    expect((p.upperArmLength + p.forearmLength) / height).toBeGreaterThan(0.26);
    expect((p.upperArmLength + p.forearmLength) / height).toBeLessThan(0.31);
  });

  it('stands about 1.67 m tall at the nominal scale', () => {
    const rig = createHumanoidRigProfile('height-check', { scale: undefined });
    const p = rig.proportions;
    const metres = (p.standingHipHeight + p.headHeight + p.headRadius * HUMANOID_HEAD_ELONGATION) * rig.scale[1];
    expect(metres).toBeGreaterThan(1.55);
    expect(metres).toBeLessThan(1.8);
  });
});
