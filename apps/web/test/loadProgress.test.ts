import { describe, expect, it } from 'vitest';
import { STAGE_CEILING, buildUrlIndex, categoryOfPath, creepTarget, describeItem, easeStep, humanizeName, loadTarget, stripHash } from '../src/office/loadProgress';

describe('loadTarget', () => {
  it('maps engine to the floor and scene to 20 + 75 x loaded/total', () => {
    expect(loadTarget('engine', 0, 0, 0)).toBe(3);
    expect(loadTarget('scene', 0, 0, 0)).toBe(20);
    expect(loadTarget('scene', 24, 48, 0)).toBeCloseTo(57.5);
    expect(loadTarget('ready', 1, 2, 10)).toBe(100);
  });
  it('never decreases when the total grows and respects ceilings', () => {
    let previous = 0;
    for (const [loaded, total] of [[10, 10], [10, 40], [11, 60], [60, 60]] as const) {
      const next = loadTarget('scene', loaded, total, previous);
      expect(next).toBeGreaterThanOrEqual(previous);
      expect(next).toBeLessThanOrEqual(STAGE_CEILING.scene);
      previous = next;
    }
    expect(loadTarget('engine', 5, 5, 0)).toBeLessThanOrEqual(STAGE_CEILING.engine);
  });
});

describe('creepTarget', () => {
  it('creeps forward but never past the ceiling', () => {
    let value = 20;
    for (let i = 0; i < 20000; i++) { const next = creepTarget('scene', value, 0.1); expect(next).toBeGreaterThanOrEqual(value); value = next; }
    expect(value).toBeLessThanOrEqual(95);
    expect(creepTarget('engine', 20, 1)).toBe(20);
  });
});

describe('easeStep', () => {
  it('reaches the target and never overshoots or moves back', () => {
    let value = 10;
    for (let i = 0; i < 600; i++) { const next = easeStep(value, 50, 1 / 60); expect(next).toBeGreaterThanOrEqual(value); expect(next).toBeLessThanOrEqual(50); value = next; }
    expect(value).toBe(50);
    expect(easeStep(60, 50, 0.016)).toBe(60);
  });
  it('is frame-rate independent enough to land in the same time', () => {
    const run = (fps: number) => { let v = 0; for (let i = 0; i < fps * 3; i++) v = easeStep(v, 40, 1 / fps); return v; };
    expect(run(30)).toBe(40);
    expect(run(144)).toBe(40);
  });
  it('counts through every integer at 60 fps', () => {
    let value = 10; const seen = new Set<number>();
    for (let i = 0; i < 1200; i++) { value = easeStep(value, 50, 1 / 60); seen.add(Math.floor(value)); }
    for (let n = 10; n <= 50; n++) expect(seen.has(n)).toBe(true);
  });
});

describe('naming', () => {
  it('strips hashes and extensions', () => {
    expect(stripHash('/assets/outfit-victorian-bartender-Ab12Cd_3.glb')).toBe('outfit-victorian-bartender');
    expect(stripHash('/public-assets/furniture/office-chair-executive.glb')).toBe('office-chair-executive');
    expect(humanizeName('/assets/outfit-victorian-bartender-Ab12Cd_3.glb')).toBe('Victorian bartender');
    expect(humanizeName('source-linen-shirt.glb')).toBe('Linen shirt');
  });
  it('categorizes dev paths', () => {
    expect(categoryOfPath('/public-assets/avatars/bodies/male/a.glb')).toBe('characters');
    expect(categoryOfPath('/public-assets/avatars/hair/shared/a-detail.glb')).toBe('hair');
    expect(categoryOfPath('/public-assets/avatars/wardrobe/male/top/a.glb')).toBe('clothing');
    expect(categoryOfPath('/public-assets/floors/floor-panel.glb')).toBe('building');
    expect(categoryOfPath('/public-assets/furniture/x.glb')).toBe('furniture');
    expect(categoryOfPath('/public-assets/landscape/x.glb')).toBe('landscape');
    expect(categoryOfPath('/public-assets/vehicles/x.glb')).toBe('vehicles');
    expect(categoryOfPath('/x/tex.png?v=1')).toBe('textures');
  });
  it('maps hashed built urls through the url index', () => {
    const index = buildUrlIndex([{ '/public-assets/avatars/outfits/male/outfit-victorian-bartender.glb': '/assets/outfit-victorian-bartender-Ab12Cd_3.glb' }]);
    expect(describeItem('/assets/outfit-victorian-bartender-Ab12Cd_3.glb', index)).toEqual({ category: 'clothing', name: 'Victorian bartender' });
    expect(describeItem('/assets/outfit-victorian-bartender-Ab12Cd_3.glb?x=1', index)?.category).toBe('clothing');
    expect(describeItem('/public-assets/vehicles/city-bus.glb', index)).toEqual({ category: 'vehicles', name: 'City bus' });
    expect(describeItem('', index)).toBeNull();
  });
});
