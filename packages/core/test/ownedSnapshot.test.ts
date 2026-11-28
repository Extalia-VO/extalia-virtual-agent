import { describe, expect, it } from 'vitest';
import {
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  canonicalSnapshotJson,
  decodeOwnedDataSnapshotBundle,
  normalizeApplyOwnedDataRestoreInput,
  normalizeOwnedDataBackupId,
  normalizeOwnedDataSnapshotSelection,
  sanitizeSnapshotValue,
  sha256Utf8Hex,
  snapshotManifestDigestInput,
  verifyOwnedDataSnapshotIntegrity,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotEntry,
} from '../src/snapshot.js';

const sha256 = sha256Utf8Hex;

function buildValidBundle(): OwnedDataSnapshotBundle {
  const selection = normalizeOwnedDataSnapshotSelection({
    sections: ['schedules', 'settings', 'workspaces'],
    workspaceIds: ['ws-b', 'ws-a'],
  });
  const entries: OwnedDataSnapshotEntry[] = [
    {
      section: 'settings',
      id: 'profile',
      payload: { language: 'en', theme: 'dark', workflow: 'managed' },
      sha256: '',
    },
    {
      section: 'workspaces',
      id: 'ws-a',
      payload: { id: 'ws-a', name: 'Workspace A', runtime: 'native' },
      sha256: '',
    },
  ];
  for (const entry of entries) {
    entry.sha256 = sha256(canonicalSnapshotJson(entry.payload));
  }
  const manifestHeader = {
    format: OWNED_DATA_SNAPSHOT_FORMAT,
    schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
    selection,
  } as const;
  return {
    manifest: {
      ...manifestHeader,
      provenance: {
        appVersion: '0.4.367',
        exportedAt: '2026-11-28T14:00:00.000Z',
        format: OWNED_DATA_SNAPSHOT_FORMAT,
        schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
        hostKind: 'desktop',
      },
      entryCount: entries.length,
      manifestSha256: sha256(snapshotManifestDigestInput(manifestHeader, entries)),
      secretCanaryChecked: true,
    },
    entries,
  };
}

describe('Owned-data snapshot contracts and integrity', () => {
  it('canonicalizes selection order and produces deterministic key-sorted JSON', () => {
    const selection = normalizeOwnedDataSnapshotSelection({
      sections: ['schedules', 'settings', 'settings', 'workspaces'],
      workspaceIds: ['ws-2', 'ws-1', 'ws-1'],
    });
    expect(selection).toEqual({
      sections: ['settings', 'workspaces', 'schedules'],
      workspaceIds: ['ws-1', 'ws-2'],
    });
    const a = canonicalSnapshotJson({ b: 2, a: { y: 1, x: undefined, z: 3 } });
    const b = canonicalSnapshotJson({ a: { z: 3, y: 1 }, b: 2 });
    expect(a).toBe(b);
    expect(a).toBe('{"a":{"y":1,"z":3},"b":2}');
    expect(sha256('abc')).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('decodes and verifies a valid owned-data snapshot bundle', () => {
    const bundle = buildValidBundle();
    const decoded = decodeOwnedDataSnapshotBundle(bundle);
    expect(decoded.ok).toBe(true);

    const verified = verifyOwnedDataSnapshotIntegrity(JSON.stringify(bundle), sha256);
    expect(verified.ok).toBe(true);
    expect(verified.checksumVerified).toBe(true);
    expect(verified.secretFreeVerified).toBe(true);
    expect(verified.conflicts).toEqual([]);
  });

  it('rejects tampered entry payload with checksum-mismatch', () => {
    const bundle = buildValidBundle();
    bundle.entries[1]!.payload = { ...bundle.entries[1]!.payload, name: 'Tampered Workspace' };

    const verified = verifyOwnedDataSnapshotIntegrity(bundle, sha256);
    expect(verified.ok).toBe(false);
    expect(verified.checksumVerified).toBe(false);
    expect(verified.conflicts.some(item => item.kind === 'checksum-mismatch' && item.id === 'ws-a')).toBe(true);
  });

  it('rejects tampered manifest digest with checksum-mismatch', () => {
    const bundle = buildValidBundle();
    bundle.manifest.manifestSha256 = '0'.repeat(64);

    const verified = verifyOwnedDataSnapshotIntegrity(bundle, sha256);
    expect(verified.ok).toBe(false);
    expect(verified.checksumVerified).toBe(false);
    expect(verified.conflicts.some(item => item.kind === 'checksum-mismatch')).toBe(true);
  });

  it('rejects secret keys and secret canary patterns', () => {
    const withKey = buildValidBundle();
    withKey.entries[0]!.payload = { apiKey: 'plain-canary' };
    const keyResult = verifyOwnedDataSnapshotIntegrity(withKey, sha256);
    expect(keyResult.ok).toBe(false);
    expect(keyResult.secretFreeVerified).toBe(false);
    expect(keyResult.conflicts[0]?.kind).toBe('secret-detected');

    const syntheticToken = ['ghp', '1234567890abcdefghij'].join('_');
    const withToken = buildValidBundle();
    withToken.entries[0]!.payload = { note: `leaked ${syntheticToken}` };
    const tokenResult = verifyOwnedDataSnapshotIntegrity(withToken, sha256);
    expect(tokenResult.ok).toBe(false);
    expect(tokenResult.secretFreeVerified).toBe(false);
    expect(tokenResult.conflicts[0]?.kind).toBe('secret-detected');
  });

  it('strips structured credentials and redacts secrets cleanly', () => {
    const sanitized = sanitizeSnapshotValue({
      name: 'ok',
      apiKey: 'secret-value-ignored',
      nested: { note: 'Bearer abcdefghijklmnopqrstuvwx', secret: 'xyz' },
    });
    expect(sanitized.omittedSecretFields).toBe(3);
    expect(sanitized.value).toEqual({
      name: 'ok',
      nested: { note: '[redacted]' },
    });
  });

  it('refuses unsupported schema versions, duplicate entries, and corrupt JSON', () => {
    const wrongSchema = buildValidBundle();
    (wrongSchema.manifest as { schemaVersion: number }).schemaVersion = 99;
    const schemaCheck = verifyOwnedDataSnapshotIntegrity(wrongSchema, sha256);
    expect(schemaCheck.ok).toBe(false);
    expect(schemaCheck.schemaVersion).toBe(99);
    expect(schemaCheck.conflicts[0]?.kind).toBe('schema-mismatch');

    const duplicate = buildValidBundle();
    duplicate.entries.push({ ...duplicate.entries[0]! });
    duplicate.manifest.entryCount = duplicate.entries.length;
    const dupCheck = verifyOwnedDataSnapshotIntegrity(duplicate, sha256);
    expect(dupCheck.ok).toBe(false);
    expect(dupCheck.conflicts[0]?.kind).toBe('id-collision');

    const corrupt = verifyOwnedDataSnapshotIntegrity('{not-json', sha256);
    expect(corrupt.ok).toBe(false);
    expect(corrupt.conflicts[0]?.kind).toBe('corrupt-archive');
  });

  it('validates restore apply inputs and pre-restore backup identifiers', () => {
    const valid = normalizeApplyOwnedDataRestoreInput({
      bundleJson: '{"ok":true}',
      expectedBundleSha256: 'A'.repeat(64),
      confirmBackup: true,
    });
    expect(valid.conflictPolicy).toBe('fail-on-collision');
    expect(valid.expectedBundleSha256).toBe('a'.repeat(64));
    expect(valid.confirmBackup).toBe(true);

    expect(() => normalizeApplyOwnedDataRestoreInput({
      bundleJson: '{"ok":true}',
      expectedBundleSha256: 'short',
      confirmBackup: true,
    })).toThrow();
    expect(() => normalizeApplyOwnedDataRestoreInput({
      bundleJson: '{"ok":true}',
      expectedBundleSha256: 'a'.repeat(64),
      conflictPolicy: 'overwrite',
      confirmBackup: true,
    })).toThrow();
    expect(() => normalizeApplyOwnedDataRestoreInput({
      bundleJson: '{"ok":true}',
      expectedBundleSha256: 'a'.repeat(64),
      confirmBackup: 'yes',
    })).toThrow();

    expect(normalizeOwnedDataBackupId('bk-0123456789ab')).toBe('bk-0123456789ab');
    expect(() => normalizeOwnedDataBackupId('bk-../etc')).toThrow();
    expect(() => normalizeOwnedDataBackupId('bk-xyz')).toThrow();
  });
});
