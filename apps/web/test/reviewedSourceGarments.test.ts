import { describe, expect, it } from 'vitest';
import { reviewedSourceGarments } from '../src/office/scene/avatars/reviewedSourceGarments';

const checks = { rest: true, walk: true, sit: true, reach: true, sourceAppearance: true };
const hash = 'a'.repeat(64);
const top = { id: 'reviewed-shirt', group: 'male', mode: 'top', path: 'avatars/wardrobe/male/top/reviewed-shirt.glb', localOnly: true, license: 'LicenseRef-Sketchfab-Standard', fitChecks: checks,
  sha256: hash, fittedSHA256: hash, materialGraphSHA256: hash, source: { path: 'male/shirt.glb', sha256: hash }, triangles: 5000, bytes: 10000, budgets: { triangles: 6000, bytes: 20000 } };
const outfit = { ...top, id: 'reviewed-suit', group: 'female', mode: 'outfit', path: 'avatars/outfits/female/outfit-reviewed-suit.glb' };
const manifest = (garments: unknown[]) => ({ schemaVersion: 1, exporter: 'tooling/blender/fit-source-garments.py', garments });
const files = {
  '/local-assets/avatars/wardrobe/male/top/reviewed-shirt.glb': 'shirt.glb',
  '/local-assets/avatars/outfits/female/outfit-reviewed-suit.glb': 'suit.glb',
  '/local-assets/avatars/wardrobe/female/top/reviewed-shirt.glb': 'unreviewed-other-body.glb',
  '/local-assets/avatars/wardrobe/male/top/incomplete-inner.glb': 'unreviewed-draft.glb',
  '/local-assets/avatars/all-garment-review/fitted/male/reviewed-shirt.glb': 'authoring.glb',
};

describe('reviewed local-only source garment catalog', () => {
  it('accepts exact reviewed existing body/slot/id paths, including the full-set filename prefix', () => {
    expect(reviewedSourceGarments(manifest([top, outfit]), files)).toEqual({
      outfits: { '/local-assets/avatars/outfits/female/outfit-reviewed-suit.glb': 'suit.glb' },
      pieces: { '/local-assets/avatars/wardrobe/male/top/reviewed-shirt.glb': 'shirt.glb' },
    });
    expect(reviewedSourceGarments(manifest([top]), {})).toEqual({ outfits: {}, pieces: {} });
  });

  it('ignores missing, malformed, stale or unapproved manifests without widening raw local files', () => {
    for (const value of [undefined, null, [], {}, { ...manifest([top]), schemaVersion: 2 }, { ...manifest([top]), exporter: 'another-tool' }, { ...manifest([top]), garments: {} }]) {
      expect(reviewedSourceGarments(value, files)).toEqual({ outfits: {}, pieces: {} });
    }
    for (const row of [null, [], {}, { ...top, localOnly: 'true' }, { ...top, localOnly: false }, { ...top, license: 'unknown' }, { ...top, fitChecks: { ...checks, sourceAppearance: false } }, { ...top, fitChecks: { ...checks, sit: 'true' } }]) {
      expect(reviewedSourceGarments(manifest([row]), files)).toEqual({ outfits: {}, pieces: {} });
    }
  });

  it('requires hash receipts and per-file budgets for both reviewed Standard and local CC-BY garments', () => {
    expect(Object.keys(reviewedSourceGarments(manifest([{ ...top, license: 'CC-BY-4.0' }]), files).pieces)).toHaveLength(1);
    for (const row of [{ ...top, sha256: undefined }, { ...top, fittedSHA256: 'not-a-hash' }, { ...top, source: {} }, { ...top, materialGraphSHA256: '' },
      { ...top, triangles: 6001 }, { ...top, bytes: 20001 }, { ...top, budgets: undefined }, { ...top, triangles: NaN }, { ...top, bytes: -1 }]) {
      expect(reviewedSourceGarments(manifest([row]), files)).toEqual({ outfits: {}, pieces: {} });
    }
  });

  it('rejects path traversal, body/slot/id mismatch, invalid ids and authoring paths', () => {
    for (const row of [
      { ...top, id: '../reviewed-shirt' }, { ...top, id: 'Review-Shirt' }, { ...top, id: 'none' },
      { ...top, group: 'shared' }, { ...top, group: 'female' }, { ...top, mode: 'outfit' }, { ...top, mode: 'hat' },
      { ...top, path: '/local-assets/avatars/wardrobe/male/top/reviewed-shirt.glb' },
      { ...top, path: 'avatars/wardrobe/male/top/../top/reviewed-shirt.glb' },
      { ...top, path: 'avatars/wardrobe/male/top/%72eviewed-shirt.glb' },
      { ...top, path: 'avatars/all-garment-review/fitted/male/reviewed-shirt.glb' },
      { ...outfit, path: 'avatars/outfits/female/reviewed-suit.glb' },
    ]) expect(reviewedSourceGarments(manifest([row]), files)).toEqual({ outfits: {}, pieces: {} });
  });

  it('fails closed on duplicated receipt paths and accepts independent valid entries', () => {
    expect(reviewedSourceGarments(manifest([top, top, outfit]), files)).toEqual({
      outfits: { '/local-assets/avatars/outfits/female/outfit-reviewed-suit.glb': 'suit.glb' }, pieces: {},
    });
  });
});
