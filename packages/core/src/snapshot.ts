import { assertNoCredentialFields, countSecrets, isCredentialKey, redact } from './privacy.js';
import { decode, entityId, object, oneOf, text, timestamp, type DecodeResult } from './validation.js';

/**
 * Browser-safe contracts, deterministic serialization, and integrity verification
 * for Owned-Data Snapshots & Dry-Run Restore Previews (V2-10 / #48).
 *
 * Zero Node built-ins: safe to import from `@extalia/core`, `@extalia/platform`,
 * `packages/host`, `apps/cli`, and `apps/web`.
 */

export const OWNED_DATA_SNAPSHOT_FORMAT = 'extalia.owned-snapshot.v1';
export const OWNED_DATA_SNAPSHOT_SCHEMA_VERSION = 1 as const;

export const OWNED_DATA_SNAPSHOT_SECTIONS = [
  'settings',
  'workspaces',
  'operatingProfiles',
  'sessions',
  'missions',
  'schedules',
] as const;

export type OwnedDataSnapshotSection = (typeof OWNED_DATA_SNAPSHOT_SECTIONS)[number];

export interface OwnedDataSnapshotSelection {
  sections: OwnedDataSnapshotSection[];
  workspaceIds?: string[];
  sessionIds?: string[];
  missionIds?: string[];
}

export interface OwnedDataSnapshotProvenance {
  appVersion: string;
  exportedAt: string;
  format: typeof OWNED_DATA_SNAPSHOT_FORMAT;
  schemaVersion: typeof OWNED_DATA_SNAPSHOT_SCHEMA_VERSION;
  hostKind?: 'desktop' | 'bridge' | 'cli';
}

export interface OwnedDataSnapshotEntry {
  section: OwnedDataSnapshotSection;
  id: string;
  sha256: string;
  payload: Record<string, unknown>;
}

export interface OwnedDataSnapshotManifest {
  format: typeof OWNED_DATA_SNAPSHOT_FORMAT;
  schemaVersion: typeof OWNED_DATA_SNAPSHOT_SCHEMA_VERSION;
  provenance: OwnedDataSnapshotProvenance;
  selection: OwnedDataSnapshotSelection;
  entryCount: number;
  manifestSha256: string;
  secretCanaryChecked: true;
}

export interface OwnedDataSnapshotBundle {
  manifest: OwnedDataSnapshotManifest;
  entries: OwnedDataSnapshotEntry[];
}

export interface OwnedDataSnapshotExportPreview {
  selection: OwnedDataSnapshotSelection;
  totalEntries: number;
  sectionCounts: Partial<Record<OwnedDataSnapshotSection, number>>;
  estimatedBytes: number;
  excludesSecrets: true;
  excludesVendorSources: true;
  warnings: string[];
}

export interface OwnedDataSnapshotExportResult {
  bundle: OwnedDataSnapshotBundle;
  bundleJson: string;
  sha256: string;
  byteLength: number;
  omittedSecretFields: number;
}

export type OwnedDataRestoreConflictKind =
  | 'id-collision'
  | 'schema-mismatch'
  | 'checksum-mismatch'
  | 'corrupt-archive'
  | 'secret-detected'
  | 'missing-dependency';

export interface OwnedDataRestoreConflict {
  kind: OwnedDataRestoreConflictKind;
  section?: OwnedDataSnapshotSection;
  id?: string;
  detail: string;
}

export interface OwnedDataRestorePreview {
  valid: boolean;
  dryRunOnly: true;
  schemaVersion?: number;
  entryCount: number;
  sectionCounts: Partial<Record<OwnedDataSnapshotSection, number>>;
  wouldAdd: number;
  wouldCollide: number;
  checksumVerified: boolean;
  secretFreeVerified: boolean;
  conflicts: OwnedDataRestoreConflict[];
  warnings: string[];
}

const VALID_SECTION_SET = new Set<string>(OWNED_DATA_SNAPSHOT_SECTIONS);
const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;
const MAX_FILTER_IDS = 500;

function normalizeFilterIds(raw: unknown, field: string): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error(`${field}: expected an array of identifiers.`);
  if (raw.length > MAX_FILTER_IDS) throw new Error(`${field}: exceeds maximum of ${MAX_FILTER_IDS} items.`);
  const seen = new Set<string>();
  for (let index = 0; index < raw.length; index++) {
    seen.add(entityId(raw[index], `${field}[${index}]`));
  }
  return [...seen].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Validate and canonicalize an export section selection in schema order. */
export function normalizeOwnedDataSnapshotSelection(raw: unknown): OwnedDataSnapshotSelection {
  const input = object(raw, 'selection');
  if (!Array.isArray(input.sections) || input.sections.length === 0) {
    throw new Error('selection.sections: select at least one snapshot section.');
  }
  const seen = new Set<OwnedDataSnapshotSection>();
  for (let index = 0; index < input.sections.length; index++) {
    const item = input.sections[index];
    if (typeof item !== 'string' || !VALID_SECTION_SET.has(item)) {
      throw new Error(`selection.sections[${index}]: unsupported snapshot section.`);
    }
    seen.add(item as OwnedDataSnapshotSection);
  }
  const sections = OWNED_DATA_SNAPSHOT_SECTIONS.filter(section => seen.has(section));
  const workspaceIds = normalizeFilterIds(input.workspaceIds, 'selection.workspaceIds');
  const sessionIds = normalizeFilterIds(input.sessionIds, 'selection.sessionIds');
  const missionIds = normalizeFilterIds(input.missionIds, 'selection.missionIds');
  return {
    sections,
    ...(workspaceIds !== undefined ? { workspaceIds } : {}),
    ...(sessionIds !== undefined ? { sessionIds } : {}),
    ...(missionIds !== undefined ? { missionIds } : {}),
  };
}

/** Deterministic sorted-key JSON serialization for snapshot integrity hashing. */
export function canonicalSnapshotJson(value: unknown): string {
  if (value === null) return 'null';
  const kind = typeof value;
  if (kind === 'string' || kind === 'boolean') return JSON.stringify(value);
  if (kind === 'number') return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  if (kind === 'undefined') return 'null';
  if (Array.isArray(value)) {
    return `[${value.map(item => (item === undefined ? 'null' : canonicalSnapshotJson(item))).join(',')}]`;
  }
  if (kind === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).filter(key => record[key] !== undefined).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalSnapshotJson(record[key])}`).join(',')}}`;
  }
  throw new Error(`Unsupported value type in canonicalSnapshotJson: ${kind}`);
}

/** Canonical digest input covering format, schemaVersion, selection, and entry digests. */
export function snapshotManifestDigestInput(
  manifest: Pick<OwnedDataSnapshotManifest, 'format' | 'schemaVersion' | 'selection'>,
  entries: readonly Pick<OwnedDataSnapshotEntry, 'section' | 'id' | 'sha256'>[],
): string {
  return canonicalSnapshotJson({
    format: manifest.format,
    schemaVersion: manifest.schemaVersion,
    selection: manifest.selection,
    entries: entries.map(entry => ({
      section: entry.section,
      id: entry.id,
      sha256: entry.sha256,
    })),
  });
}

/** Recursively strip structured credential fields and redact string secrets, returning removed count. */
export function sanitizeSnapshotValue(value: unknown): { value: unknown; omittedSecretFields: number } {
  let omittedSecretFields = 0;

  const visit = (current: unknown): unknown => {
    if (current === null || current === undefined) return current;
    if (typeof current === 'string') {
      const secrets = countSecrets(current);
      if (secrets > 0) omittedSecretFields += secrets;
      return redact(current);
    }
    if (typeof current !== 'object') return current;
    if (Array.isArray(current)) {
      return current.map(item => visit(item));
    }
    const input = current as Record<string, unknown>;
    const clean: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(input)) {
      if (isCredentialKey(key)) {
        if (nested !== undefined && nested !== null && nested !== '') {
          omittedSecretFields += 1;
        }
        continue;
      }
      if (nested !== undefined) {
        clean[key] = visit(nested);
      }
    }
    return clean;
  };

  return { value: visit(value), omittedSecretFields };
}

/** Count entries per snapshot section. */
export function summarizeSnapshotSectionCounts(
  entries: readonly Pick<OwnedDataSnapshotEntry, 'section'>[],
): Partial<Record<OwnedDataSnapshotSection, number>> {
  const counts: Partial<Record<OwnedDataSnapshotSection, number>> = {};
  for (const entry of entries) {
    counts[entry.section] = (counts[entry.section] ?? 0) + 1;
  }
  return counts;
}

const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
] as const;

const SHA256_INIT = [
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
  0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
] as const;

function rotr(value: number, bits: number): number {
  return (value >>> bits) | (value << (32 - bits));
}

function utf8Encode(input: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    let code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x1_0000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x1_0000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(0xf0 | (code >> 18), 0x80 | ((code >> 12) & 0x3f), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    }
  }
  return new Uint8Array(bytes);
}

/** Pure UTF-8 SHA-256 hex digest with zero Node built-ins (browser & edge safe). */
export function sha256Utf8Hex(input: string): string {
  const utf8 = utf8Encode(input);
  const bitLen = utf8.length * 8;
  const paddedLen = Math.ceil((utf8.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLen);
  bytes.set(utf8);
  bytes[utf8.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLen - 8, Math.floor(bitLen / 0x1_0000_0000), false);
  view.setUint32(paddedLen - 4, bitLen >>> 0, false);

  const hash: number[] = [...SHA256_INIT];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < paddedLen; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(w[i - 15]!, 7) ^ rotr(w[i - 15]!, 18) ^ (w[i - 15]! >>> 3);
      const s1 = rotr(w[i - 2]!, 17) ^ rotr(w[i - 2]!, 19) ^ (w[i - 2]! >>> 10);
      w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
    }
    let [a, b, c, d, e, f, g, h] = hash as [number, number, number, number, number, number, number, number];
    for (let i = 0; i < 64; i++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[i]! + w[i]!) >>> 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g; g = f; f = e; e = (d + temp1) >>> 0;
      d = c; c = b; b = a; a = (temp1 + temp2) >>> 0;
    }
    hash[0] = (hash[0]! + a) >>> 0;
    hash[1] = (hash[1]! + b) >>> 0;
    hash[2] = (hash[2]! + c) >>> 0;
    hash[3] = (hash[3]! + d) >>> 0;
    hash[4] = (hash[4]! + e) >>> 0;
    hash[5] = (hash[5]! + f) >>> 0;
    hash[6] = (hash[6]! + g) >>> 0;
    hash[7] = (hash[7]! + h) >>> 0;
  }
  return hash.map(word => word.toString(16).padStart(8, '0')).join('');
}

function sha256Digest(value: unknown, field: string): string {
  const result = text(value, field, { singleLine: true, max: 64 });
  if (!SHA256_HEX_PATTERN.test(result)) {
    throw new Error(`${field}: expected lowercase 64-char sha256 hex digest.`);
  }
  return result;
}

/** Decode and structurally validate an Owned-Data Snapshot bundle (including secret checks). */
export function decodeOwnedDataSnapshotBundle(raw: unknown): DecodeResult<OwnedDataSnapshotBundle> {
  return decode(() => {
    assertNoCredentialFields(raw);
    const root = object(raw, 'bundle');
    const manifestObj = object(root.manifest, 'manifest');
    if (manifestObj.format !== OWNED_DATA_SNAPSHOT_FORMAT) {
      throw new Error(`manifest.format: expected ${OWNED_DATA_SNAPSHOT_FORMAT}.`);
    }
    if (manifestObj.schemaVersion !== OWNED_DATA_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`manifest.schemaVersion: expected ${OWNED_DATA_SNAPSHOT_SCHEMA_VERSION}.`);
    }
    if (manifestObj.secretCanaryChecked !== true) {
      throw new Error('manifest.secretCanaryChecked: must be true.');
    }

    const provObj = object(manifestObj.provenance, 'manifest.provenance');
    if (provObj.format !== OWNED_DATA_SNAPSHOT_FORMAT) {
      throw new Error(`manifest.provenance.format: expected ${OWNED_DATA_SNAPSHOT_FORMAT}.`);
    }
    if (provObj.schemaVersion !== OWNED_DATA_SNAPSHOT_SCHEMA_VERSION) {
      throw new Error(`manifest.provenance.schemaVersion: expected ${OWNED_DATA_SNAPSHOT_SCHEMA_VERSION}.`);
    }
    const provenance: OwnedDataSnapshotProvenance = {
      appVersion: text(provObj.appVersion, 'manifest.provenance.appVersion', { singleLine: true, max: 64 }).trim(),
      exportedAt: timestamp(provObj.exportedAt, 'manifest.provenance.exportedAt'),
      format: OWNED_DATA_SNAPSHOT_FORMAT,
      schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
      ...(provObj.hostKind !== undefined
        ? { hostKind: oneOf(provObj.hostKind, ['desktop', 'bridge', 'cli'] as const, 'manifest.provenance.hostKind') }
        : {}),
    };

    const selection = normalizeOwnedDataSnapshotSelection(manifestObj.selection);
    if (!Array.isArray(root.entries)) {
      throw new Error('entries: expected an array.');
    }
    if (manifestObj.entryCount !== root.entries.length) {
      throw new Error(`manifest.entryCount: expected ${root.entries.length}.`);
    }

    const manifestSha256 = sha256Digest(manifestObj.manifestSha256, 'manifest.manifestSha256');
    const seenKeys = new Set<string>();
    const entries: OwnedDataSnapshotEntry[] = root.entries.map((item, index) => {
      const entryObj = object(item, `entries[${index}]`);
      const section = oneOf(entryObj.section, OWNED_DATA_SNAPSHOT_SECTIONS, `entries[${index}].section`);
      const id = entityId(entryObj.id, `entries[${index}].id`);
      const key = `${section}:${id}`;
      if (seenKeys.has(key)) {
        throw new Error(`entries[${index}]: duplicate snapshot entry (${key}).`);
      }
      seenKeys.add(key);
      const sha256 = sha256Digest(entryObj.sha256, `entries[${index}].sha256`);
      const payload = object(entryObj.payload, `entries[${index}].payload`);
      return { section, id, sha256, payload };
    });

    const serializedEntries = canonicalSnapshotJson(entries);
    if (countSecrets(serializedEntries) > 0 || countSecrets(canonicalSnapshotJson(provenance)) > 0) {
      throw new Error('Snapshot bundle contains disallowed secret patterns.');
    }

    return {
      manifest: {
        format: OWNED_DATA_SNAPSHOT_FORMAT,
        schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
        provenance,
        selection,
        entryCount: entries.length,
        manifestSha256,
        secretCanaryChecked: true,
      },
      entries,
    };
  });
}

function findSecretPatternMatch(value: unknown, section?: OwnedDataSnapshotSection, id?: string): OwnedDataRestoreConflict | undefined {
  const queue: unknown[] = [value];
  while (queue.length > 0) {
    const item = queue.pop();
    if (typeof item === 'string') {
      if (countSecrets(item) > 0) {
        return {
          kind: 'secret-detected',
          ...(section ? { section } : {}),
          ...(id ? { id } : {}),
          detail: 'Disallowed credential or secret pattern detected in snapshot content.',
        };
      }
      continue;
    }
    if (!item || typeof item !== 'object') continue;
    for (const [key, nested] of Object.entries(item)) {
      if (isCredentialKey(key)) {
        return {
          kind: 'secret-detected',
          ...(section ? { section } : {}),
          ...(id ? { id } : {}),
          detail: `Disallowed credential field "${key}" detected in snapshot archive.`,
        };
      }
      queue.push(nested);
    }
  }
  return undefined;
}

/**
 * Pure offline verifier usable by Host, CLI, and mock transports.
 * Distinguishes corrupt archives, schema mismatches, secret detections, duplicate keys,
 * and SHA-256 entry/manifest mismatches.
 */
export function verifyOwnedDataSnapshotIntegrity(
  rawOrText: unknown,
  sha256Hex: (input: string) => string,
): {
  ok: boolean;
  bundle?: OwnedDataSnapshotBundle;
  schemaVersion?: number;
  checksumVerified: boolean;
  secretFreeVerified: boolean;
  conflicts: OwnedDataRestoreConflict[];
} {
  let parsed: unknown = rawOrText;
  if (typeof rawOrText === 'string') {
    if (!rawOrText.trim()) {
      return {
        ok: false,
        checksumVerified: false,
        secretFreeVerified: false,
        conflicts: [{ kind: 'corrupt-archive', detail: 'Snapshot archive text is empty.' }],
      };
    }
    try {
      parsed = JSON.parse(rawOrText);
    } catch (error) {
      return {
        ok: false,
        checksumVerified: false,
        secretFreeVerified: false,
        conflicts: [{
          kind: 'corrupt-archive',
          detail: error instanceof Error ? `Invalid JSON archive: ${error.message}` : 'Invalid JSON archive.',
        }],
      };
    }
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      checksumVerified: false,
      secretFreeVerified: false,
      conflicts: [{ kind: 'corrupt-archive', detail: 'Snapshot root must be a JSON object.' }],
    };
  }

  const rootRecord = parsed as Record<string, unknown>;
  const rawManifest = rootRecord.manifest && typeof rootRecord.manifest === 'object' && !Array.isArray(rootRecord.manifest)
    ? (rootRecord.manifest as Record<string, unknown>)
    : undefined;
  const rawSchemaVersion = typeof rawManifest?.schemaVersion === 'number' ? rawManifest.schemaVersion : undefined;

  const secretConflict = findSecretPatternMatch(parsed);
  if (secretConflict) {
    return {
      ok: false,
      ...(rawSchemaVersion !== undefined ? { schemaVersion: rawSchemaVersion } : {}),
      checksumVerified: false,
      secretFreeVerified: false,
      conflicts: [secretConflict],
    };
  }

  if (rawManifest && (rawManifest.format !== OWNED_DATA_SNAPSHOT_FORMAT || rawManifest.schemaVersion !== OWNED_DATA_SNAPSHOT_SCHEMA_VERSION)) {
    return {
      ok: false,
      ...(rawSchemaVersion !== undefined ? { schemaVersion: rawSchemaVersion } : {}),
      checksumVerified: false,
      secretFreeVerified: true,
      conflicts: [{
        kind: 'schema-mismatch',
        detail: `Unsupported snapshot format (${String(rawManifest.format)}) or schemaVersion (${String(rawManifest.schemaVersion)}). Expected ${OWNED_DATA_SNAPSHOT_FORMAT} v${OWNED_DATA_SNAPSHOT_SCHEMA_VERSION}.`,
      }],
    };
  }

  const decoded = decodeOwnedDataSnapshotBundle(parsed);
  if (!decoded.ok) {
    const first = decoded.errors[0] ?? 'Snapshot archive structure is invalid.';
    const kind: OwnedDataRestoreConflictKind = first.includes('duplicate snapshot entry')
      ? 'id-collision'
      : first.includes('secret') || first.includes('credentials')
        ? 'secret-detected'
        : first.includes('schemaVersion') || first.includes('format')
          ? 'schema-mismatch'
          : 'corrupt-archive';
    return {
      ok: false,
      ...(rawSchemaVersion !== undefined ? { schemaVersion: rawSchemaVersion } : {}),
      checksumVerified: false,
      secretFreeVerified: kind !== 'secret-detected',
      conflicts: [{ kind, detail: first }],
    };
  }

  const bundle = decoded.value;
  const conflicts: OwnedDataRestoreConflict[] = [];
  let checksumVerified = true;

  for (const entry of bundle.entries) {
    const actualSha = sha256Hex(canonicalSnapshotJson(entry.payload));
    if (actualSha !== entry.sha256) {
      checksumVerified = false;
      conflicts.push({
        kind: 'checksum-mismatch',
        section: entry.section,
        id: entry.id,
        detail: `Entry checksum mismatch for ${entry.section}:${entry.id}.`,
      });
    }
  }

  const expectedManifestSha = sha256Hex(snapshotManifestDigestInput(bundle.manifest, bundle.entries));
  if (expectedManifestSha !== bundle.manifest.manifestSha256) {
    checksumVerified = false;
    conflicts.push({
      kind: 'checksum-mismatch',
      detail: 'Manifest SHA-256 digest does not match entries.',
    });
  }

  return {
    ok: conflicts.length === 0,
    bundle,
    schemaVersion: bundle.manifest.schemaVersion,
    checksumVerified,
    secretFreeVerified: true,
    conflicts,
  };
}

export const OWNED_DATA_RESTORE_CONFLICT_POLICIES = ['fail-on-collision', 'skip-existing'] as const;
export type OwnedDataRestoreConflictPolicy = (typeof OWNED_DATA_RESTORE_CONFLICT_POLICIES)[number];

export interface OwnedDataBackupFileEntry {
  relativePath: string;
  sha256: string;
  byteLength: number;
  existed: boolean;
}

export interface OwnedDataBackupManifest {
  format: 'extalia.restore-backup.v1';
  backupId: string;
  createdAt: string;
  reason: 'pre-restore';
  sourceBundleSha256: string;
  appVersion: string;
  files: OwnedDataBackupFileEntry[];
}

export interface OwnedDataBackupSummary {
  backupId: string;
  createdAt: string;
  reason: 'pre-restore';
  sourceBundleSha256: string;
  fileCount: number;
}

export interface ApplyOwnedDataRestoreInput {
  bundleJson: string;
  expectedBundleSha256: string;
  conflictPolicy?: OwnedDataRestoreConflictPolicy;
  confirmBackup: boolean;
}

export type OwnedDataRestoreApplyErrorCode =
  | 'corrupt-archive'
  | 'schema-mismatch'
  | 'checksum-mismatch'
  | 'secret-detected'
  | 'id-collision'
  | 'missing-dependency'
  | 'digest-mismatch'
  | 'confirmation-required'
  | 'host-busy'
  | 'write-failed-rolled-back'
  | 'rollback-incomplete';

export type OwnedDataRestoreApplyResult =
  | {
      ok: true;
      backupId: string;
      bundleSha256: string;
      appliedCount: number;
      skippedCount: number;
      appliedBySection: Partial<Record<OwnedDataSnapshotSection, number>>;
      skippedIds: string[];
      vendorSourcesUntouched: true;
      warnings: string[];
    }
  | {
      ok: false;
      code: OwnedDataRestoreApplyErrorCode;
      backupId?: string;
      rolledBack: boolean;
      conflicts: OwnedDataRestoreConflict[];
      detail: string;
    };

export type RollbackOwnedDataRestoreResult =
  | {
      ok: true;
      backupId: string;
      restoredFiles: number;
      removedFiles: number;
      detail: string;
    }
  | {
      ok: false;
      backupId: string;
      detail: string;
    };

const BACKUP_ID_PATTERN = /^bk-[0-9a-f]{12}$/;

/** Validate and normalize an ApplyOwnedDataRestoreInput payload cleanly without touching disk. */
export function normalizeApplyOwnedDataRestoreInput(
  raw: unknown,
): Required<Pick<ApplyOwnedDataRestoreInput, 'bundleJson' | 'expectedBundleSha256' | 'conflictPolicy' | 'confirmBackup'>> {
  const input = object(raw, 'restoreInput');
  const bundleJson = text(input.bundleJson, 'restoreInput.bundleJson', { max: 20_000_000 });
  const expectedBundleSha256 = sha256Digest(
    typeof input.expectedBundleSha256 === 'string' ? input.expectedBundleSha256.trim().toLowerCase() : input.expectedBundleSha256,
    'restoreInput.expectedBundleSha256',
  );
  const conflictPolicy = input.conflictPolicy === undefined
    ? 'fail-on-collision'
    : oneOf(input.conflictPolicy, OWNED_DATA_RESTORE_CONFLICT_POLICIES, 'restoreInput.conflictPolicy');
  if (typeof input.confirmBackup !== 'boolean') {
    throw new Error('restoreInput.confirmBackup: expected a boolean.');
  }
  return {
    bundleJson,
    expectedBundleSha256,
    conflictPolicy,
    confirmBackup: input.confirmBackup,
  };
}

/** Validate an Owned-Data pre-restore backup identifier (`bk-<12 lowercase hex chars>`). */
export function normalizeOwnedDataBackupId(raw: unknown): string {
  const value = text(raw, 'backupId', { singleLine: true, max: 32 }).trim();
  if (!BACKUP_ID_PATTERN.test(value)) {
    throw new Error('backupId: expected format bk-<12 lowercase hex chars>.');
  }
  return value;
}
