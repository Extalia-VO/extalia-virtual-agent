/** Immutable health-only bundle description. Claims here do not authenticate an
 * installed artifact or authorize a process launch. The reader must bound the
 * original manifest bytes and verify its independently trusted digest first.
 */
import type { JsonSchema } from './jsonSchema.js';
import { array, enumeration, literal, number, object, rule } from './rules.js';

/** Raw-byte limit for readers, before decoding/parsing the manifest. */
export const WORKER_BUNDLE_MAX_MANIFEST_BYTES = 1_048_576;
export const WORKER_BUNDLE_MAX_FILES = 4_096;
export const WORKER_BUNDLE_MAX_FILE_BYTES = 134_217_728;
export const WORKER_BUNDLE_MAX_TOTAL_BYTES = 536_870_912;

export interface WorkerBundleTarget { os: 'linux' | 'macos' | 'windows'; arch: 'x86_64' | 'aarch64' }
export interface WorkerBundleFile { path: string; role: 'interpreter' | 'entry_script' | 'support'; bytes: number; sha256: string }
export interface WorkerBundleManifest {
  schema_version: 1;
  target: WorkerBundleTarget;
  runtime_version: string;
  worker_version: string;
  operations: ['health'];
  interpreter: string;
  entry_script: string;
  files: WorkerBundleFile[];
}

// Keep the workerProtocol v1 ASCII version grammar, including strict end-of-input.
const VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,127}$(?![\s\S])/;
const SHA256 = /^[0-9a-f]{64}$(?![\s\S])/;
// Every component is portable across supported targets. Windows device stems are
// forbidden even with extensions; other leading-dot names remain valid.
const DEVICE = '(?:[cC][oO][nN]|[pP][rR][nN]|[aA][uU][xX]|[nN][uU][lL]|[cC][oO][mM][0-9]|[lL][pP][tT][0-9])';
const COMPONENT = `(?!(?:\\.|\\.\\.)(?:/|$))(?!${DEVICE}(?:\\.|/|$))(?![A-Za-z0-9_.-]*\\.(?:/|$))[A-Za-z0-9_.-]{1,64}`;
const PATH = new RegExp(`^${COMPONENT}(?:/${COMPONENT}){0,15}$(?![\\s\\S])`);
const boundedString = (max: number, pattern: RegExp) => rule((value, _path, errors) => {
  if (typeof value !== 'string' || value.length < 1 || value.length > max || !pattern.test(value)) errors.push('invalid bundle string');
}, { type: 'string', minLength: 1, maxLength: max, pattern: pattern.source });
const path = boundedString(512, PATH);
const version = boundedString(128, VERSION);
const file = object({
  path,
  role: enumeration(['interpreter', 'entry_script', 'support']),
  bytes: number(0, true, WORKER_BUNDLE_MAX_FILE_BYTES),
  sha256: boundedString(64, SHA256),
});
const manifest = object({
  schema_version: literal(1),
  target: object({ os: enumeration(['linux', 'macos', 'windows']), arch: enumeration(['x86_64', 'aarch64']) }),
  runtime_version: version,
  worker_version: version,
  operations: array(literal('health'), true, 1, 1),
  interpreter: path,
  entry_script: path,
  files: array(file, false, 2, WORKER_BUNDLE_MAX_FILES),
});

/** Bound JSON object traversal before schema rules allocate field-error strings.
 * Inputs are decoded JSON values, not application objects with getters/proxies.
 */
function boundedObject(value: unknown, max: number): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  let count = 0;
  for (const key in value) if (Object.hasOwn(value, key)) {
    if (++count > max || key.length > 32) return false;
  }
  return true;
}
const shortString = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max;
const invalid = (): { ok: false; code: 'invalid_manifest' } => ({ ok: false, code: 'invalid_manifest' });

/** Validate JSON claims only: no filesystem access, hashing, installation or launch. */
export function parseWorkerBundleManifest(value: unknown): { ok: true; manifest: WorkerBundleManifest } | { ok: false; code: 'invalid_manifest' } {
  if (!boundedObject(value, 8) || !boundedObject(value.target, 2)
    || !shortString(value.target.os, 7) || !shortString(value.target.arch, 7)
    || !shortString(value.runtime_version, 128) || !shortString(value.worker_version, 128)
    || !shortString(value.interpreter, 512) || !shortString(value.entry_script, 512)
    || !Array.isArray(value.operations) || value.operations.length !== 1 || value.operations[0] !== 'health'
    || !Array.isArray(value.files) || value.files.length < 2 || value.files.length > WORKER_BUNDLE_MAX_FILES) return invalid();
  // Check every collection and string bound before running rules or semantic sets.
  for (const item of value.files) {
    if (!boundedObject(item, 4) || !shortString(item.path, 512) || !shortString(item.role, 12) || !shortString(item.sha256, 64)) return invalid();
  }
  const errors: string[] = [];
  manifest.check(value, 'manifest', errors);
  if (errors.length) return invalid();
  const result = value as unknown as WorkerBundleManifest;
  if (result.interpreter === result.entry_script) return invalid();
  const names = new Set<string>();
  const directories = new Map<string, string>();
  let previous = '';
  let total = 0;
  let interpreters = 0;
  let scripts = 0;
  for (const item of result.files) {
    if (item.path <= previous) return invalid();
    previous = item.path;
    const folded = item.path.toLowerCase();
    if (names.has(folded) || directories.has(folded)) return invalid();
    const components = item.path.split('/');
    let prefix = '';
    for (let i = 0; i < components.length - 1; i++) {
      prefix += (i ? '/' : '') + components[i]!;
      const foldedPrefix = prefix.toLowerCase();
      const spelling = directories.get(foldedPrefix);
      if (names.has(foldedPrefix) || (spelling !== undefined && spelling !== prefix)) return invalid();
      directories.set(foldedPrefix, prefix);
    }
    names.add(folded);
    total += item.bytes;
    if (total > WORKER_BUNDLE_MAX_TOTAL_BYTES) return invalid();
    if (item.role === 'interpreter') {
      if (++interpreters > 1 || item.path !== result.interpreter || item.bytes < 1) return invalid();
    } else if (item.role === 'entry_script') {
      if (++scripts > 1 || item.path !== result.entry_script || item.bytes < 1) return invalid();
    }
  }
  return interpreters === 1 && scripts === 1 ? { ok: true, manifest: result } : invalid();
}

/** Structural schema; ordering, path collisions, role references and byte totals
 * are semantic validator checks, marked schemaGap in the shared fixture corpus.
 */
export function workerBundleJsonSchemaDefs(): Record<string, JsonSchema> {
  return { WorkerBundleManifest: manifest.schema };
}
