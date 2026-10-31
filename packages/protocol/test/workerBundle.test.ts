import { describe, expect, it } from 'vitest';
import {
  parseWorkerBundleManifest, workerBundleJsonSchemaDefs, WORKER_BUNDLE_MAX_MANIFEST_BYTES,
  WORKER_BUNDLE_MAX_FILES, WORKER_BUNDLE_MAX_FILE_BYTES, WORKER_BUNDLE_MAX_TOTAL_BYTES,
  type WorkerBundleManifest,
} from '../src/workerBundle.js';
import fixtures from './fixtures/worker/bundles.json' with { type: 'json' };
import { validateJsonSchema } from './jsonSchemaSubset.js';

const sample = (): WorkerBundleManifest => JSON.parse(JSON.stringify(fixtures.cases[0]!.value)) as WorkerBundleManifest;
const invalid = { ok: false, code: 'invalid_manifest' };
const schema = workerBundleJsonSchemaDefs().WorkerBundleManifest!;

describe('health-only worker bundle manifest', () => {
  it.each(fixtures.cases)('$name', testCase => {
    const result = parseWorkerBundleManifest(testCase.value);
    expect(result.ok).toBe(testCase.valid);
    expect(validateJsonSchema(schema, testCase.value)).toBe(testCase.valid || ('schemaGap' in testCase && testCase.schemaGap === true));
    if (!result.ok) expect(result).toEqual(invalid);
  });
  it('publishes byte limits for the independent reader and semantic checks', () => {
    expect([WORKER_BUNDLE_MAX_MANIFEST_BYTES, WORKER_BUNDLE_MAX_FILES, WORKER_BUNDLE_MAX_FILE_BYTES, WORKER_BUNDLE_MAX_TOTAL_BYTES])
      .toEqual([1_048_576, 4_096, 134_217_728, 536_870_912]);
  });
  it('accepts the maximum file count and rejects the next count before item traversal', () => {
    const value = sample();
    const support = { role: 'support' as const, bytes: 0, sha256: '0'.repeat(64) };
    for (let i = 0; i < WORKER_BUNDLE_MAX_FILES - 2; i++) value.files.push({ ...support, path: `support/${String(i).padStart(4, '0')}` });
    value.files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    expect(parseWorkerBundleManifest(value).ok).toBe(true);
    value.files.push({ ...support, path: 'support/extra' });
    Object.defineProperty(value.files, 0, { get: () => { throw new Error('must not traverse oversized files'); } });
    expect(parseWorkerBundleManifest(value)).toEqual(invalid);
  });
  it('bounds operation arrays, strings and object keys without echoing hostile values', () => {
    const value = sample();
    value.operations = new Array(1_000_000) as ['health'];
    Object.defineProperty(value.operations, 0, { get: () => { throw new Error('must not traverse oversized operations'); } });
    expect(parseWorkerBundleManifest(value)).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...sample(), runtime_version: 'x'.repeat(1_000_000) })).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...sample(), ['x'.repeat(1_000_000)]: true })).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...sample(), [Symbol('authority')]: true })).toEqual(invalid);
    const custom = sample(); Object.defineProperty(custom, 'toJSON', { value: () => ({ scanner_ready: true }) });
    expect(parseWorkerBundleManifest(custom)).toEqual(invalid);
  });
  it('accepts only plain JSON objects and leaves accepted claims intact', () => {
    const value = sample();
    const snapshot = JSON.stringify(value);
    const result = parseWorkerBundleManifest(value);
    expect(result).toEqual({ ok: true, manifest: value });
    expect(JSON.stringify(value)).toBe(snapshot);
    expect(parseWorkerBundleManifest(Object.assign(Object.create({ inherited: true }), value))).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...value, target: [] })).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...value, files: [null, value.files[1]] })).toEqual(invalid);
    expect(parseWorkerBundleManifest({ ...value, files: [{ ...value.files[0], bytes: Number.NaN }, value.files[1]] })).toEqual(invalid);
  });
});
