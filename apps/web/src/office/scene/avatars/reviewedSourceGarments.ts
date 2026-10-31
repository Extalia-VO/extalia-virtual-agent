import { CHARACTER_OUTFIT_MODEL } from '@extalia/core';

type UrlMap = Readonly<Record<string, string>>;
const CHECKS = ['rest', 'walk', 'sit', 'reach', 'sourceAppearance'] as const;
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
const sha256 = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Resolve only publisher-reviewed local garments; authoring files and drafts are never a catalog. */
export function reviewedSourceGarments(manifest: unknown, files: UrlMap): { outfits: UrlMap; pieces: UrlMap } {
  const outfits: Record<string, string> = {}, pieces: Record<string, string> = {};
  const document = object(manifest);
  if (document?.schemaVersion !== 1 || document.exporter !== 'tooling/blender/fit-source-garments.py'
    || !Array.isArray(document.garments) || document.garments.length > 1000) return { outfits, pieces };
  const seen = new Set<string>(), conflicts = new Set<string>();
  for (const value of document.garments) {
    const row = object(value);
    if (!row || row.localOnly !== true || row.license !== 'LicenseRef-Sketchfab-Standard' && row.license !== 'CC-BY-4.0') continue;
    const source = object(row.source), budgets = object(row.budgets);
    // The publisher verifies actual bytes; the browser accepts only complete, bounded receipts.
    if (!sha256(row.sha256) || !sha256(row.fittedSHA256) || !sha256(row.materialGraphSHA256) || !sha256(source?.sha256)
      || !positiveInteger(row.triangles) || !positiveInteger(row.bytes)
      || !positiveInteger(budgets?.triangles) || !positiveInteger(budgets?.bytes)
      || row.triangles > budgets.triangles || row.bytes > budgets.bytes) continue;
    const { id, group, mode, path } = row, checks = object(row.fitChecks);
    if (typeof id !== 'string' || id.length > 64 || !CHARACTER_OUTFIT_MODEL.test(id) || id === 'none'
      || group !== 'male' && group !== 'female'
      || mode !== 'outfit' && mode !== 'top' && mode !== 'bottom' && mode !== 'outer'
      || !CHECKS.every(check => checks?.[check] === true)) continue;
    const filename = mode === 'outfit' ? `outfit-${id}` : id;
    if (filename.length > 64 || !CHARACTER_OUTFIT_MODEL.test(filename)) continue;
    const expected = mode === 'outfit' ? `avatars/outfits/${group}/${filename}.glb` : `avatars/wardrobe/${group}/${mode}/${filename}.glb`;
    if (path !== expected) continue;
    const key = `/local-assets/${expected}`, url = files[key];
    if (typeof url !== 'string' || !url) continue;
    if (seen.has(key)) { conflicts.add(key); continue; }
    seen.add(key);
    (mode === 'outfit' ? outfits : pieces)[key] = url;
  }
  for (const key of conflicts) { delete outfits[key]; delete pieces[key]; }
  return { outfits, pieces };
}
