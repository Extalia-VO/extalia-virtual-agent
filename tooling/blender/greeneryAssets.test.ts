import { existsSync, readFileSync, statSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import CATALOG from '../../apps/web/src/office/scene/campusGreenery.json';
import { licensedGreenery, pickGreenery, placementHash, type GreeneryEntry } from '../../apps/web/src/office/scene/greenery';

const source = JSON.parse(readFileSync(new URL('./campus-greenery.json', import.meta.url), 'utf8')) as {
  notices: Record<string, unknown>; greenery: { id: string; kind: string; license: string; notice: string }[];
};
const models = JSON.parse(readFileSync(new URL('../../apps/web/public-assets/models.json', import.meta.url), 'utf8')) as {
  models: { path: string; bytes: number; license: string; provenance: { exporter?: string } }[];
};
const runtime = CATALOG.greenery as GreeneryEntry[];
const file = (id: string) => new URL(`../../apps/web/public-assets/greenery/${id}.glb`, import.meta.url);

describe('campus greenery assets', () => {
  it('publishes every catalog entry once, under 1 MiB, with its licence and exporter', () => {
    expect(runtime.map(entry => entry.id)).toEqual(source.greenery.map(entry => entry.id));
    for (const entry of source.greenery) {
      expect(entry.id.startsWith(`${entry.kind}-`)).toBe(true);
      expect(source.notices[entry.notice]).toBeDefined();
      expect(existsSync(file(entry.id))).toBe(true);
      expect(statSync(file(entry.id)).size).toBeLessThanOrEqual(1_048_576);
      const record = models.models.find(model => model.path === `greenery/${entry.id}.glb`);
      expect(record?.license).toBe(entry.license);
      expect(record?.provenance.exporter).toBe('tooling/blender/prepare-greenery.py');
    }
  });

  it('keeps realistic sizes and triangle budgets per kind', () => {
    for (const entry of runtime) {
      const [low, high, budget] = entry.kind === 'tree' ? [2, 12, 16_000] : entry.kind === 'garden' ? [.2, 1.5, 8_000] : [.4, 1, 6_000];
      expect(entry.height).toBeGreaterThanOrEqual(low);
      expect(entry.height).toBeLessThanOrEqual(high);
      expect(entry.triangles).toBeLessThanOrEqual(budget);
    }
  });

  it('keeps confirmed greenery and leaves unverified candidates to procedural fallbacks under the commercial-assets switch', () => {
    const all = () => true;
    expect(licensedGreenery(runtime, false, all)).toHaveLength(runtime.length);
    expect(licensedGreenery(runtime, true, all)).toEqual(runtime);
    const candidate = { ...runtime[0]!, id: 'plant-unverified-candidate', licenseUnverified: true };
    expect(licensedGreenery([...runtime, candidate], true, all)).toEqual(runtime);
    expect(licensedGreenery([...runtime, candidate], false, all)).toHaveLength(runtime.length + 1);
  });

  it('picks variants deterministically from the placement', () => {
    const pool = ['a', 'b', 'c'];
    expect(pickGreenery(pool, 3.2, -7.5)).toBe(pickGreenery(pool, 3.2, -7.5));
    expect(pickGreenery([], 1, 1)).toBeUndefined();
    const picks = new Set(Array.from({ length: 30 }, (_, i) => pickGreenery(pool, i * 2.1, i * -1.3)));
    expect(picks.size).toBe(3);
    expect(placementHash(1, 2)).not.toBe(placementHash(2, 1));
  });
});
