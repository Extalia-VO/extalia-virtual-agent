import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  OWNED_DATA_SNAPSHOT_SECTIONS,
  canonicalSnapshotJson,
  normalizeOwnedDataSnapshotSelection,
  snapshotManifestDigestInput,
  type ApplyOwnedDataRestoreInput,
  type OwnedDataBackupSummary,
  type OwnedDataRestoreApplyResult,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotEntry,
  type OwnedDataSnapshotExportResult,
  type OwnedDataSnapshotSelection,
  type RollbackOwnedDataRestoreResult,
} from '@extalia/core';
import { createAgentHost } from '@extalia/host';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { run, type CliHost } from '../src/cli';
import { MAX_SNAPSHOT_FILE_BYTES, parseLoopbackSnapshotBridgeUrl, runSnapshot } from '../src/snapshot';

function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

function buildSnapshotResult(
  entriesInput: Array<Pick<OwnedDataSnapshotEntry, 'section' | 'id' | 'payload'>> = [
    {
      section: 'settings',
      id: 'profile',
      payload: { language: 'en', theme: 'dark' },
    },
    {
      section: 'workspaces',
      id: 'ws-alpha',
      payload: { id: 'ws-alpha', name: 'Alpha Workspace', runtime: 'native' },
    },
  ],
  selectionInput: OwnedDataSnapshotSelection = {
    sections: [...OWNED_DATA_SNAPSHOT_SECTIONS],
  },
  omittedSecretFields = 1,
): OwnedDataSnapshotExportResult {
  const selection = normalizeOwnedDataSnapshotSelection(selectionInput);
  const entries: OwnedDataSnapshotEntry[] = entriesInput.map(item => ({
    section: item.section,
    id: item.id,
    payload: item.payload,
    sha256: sha256(canonicalSnapshotJson(item.payload)),
  }));
  const manifestHeader = {
    format: OWNED_DATA_SNAPSHOT_FORMAT,
    schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
    selection,
  } as const;
  const bundle: OwnedDataSnapshotBundle = {
    manifest: {
      ...manifestHeader,
      provenance: {
        appVersion: '0.0.0-test',
        exportedAt: '2026-11-28T14:00:00.000Z',
        format: OWNED_DATA_SNAPSHOT_FORMAT,
        schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
        hostKind: 'bridge',
      },
      entryCount: entries.length,
      manifestSha256: sha256(snapshotManifestDigestInput(manifestHeader, entries)),
      secretCanaryChecked: true,
    },
    entries,
  };
  const bundleJson = JSON.stringify(bundle, null, 2);
  return {
    bundle,
    bundleJson,
    sha256: sha256(bundleJson),
    byteLength: Buffer.byteLength(bundleJson, 'utf8'),
    omittedSecretFields,
  };
}

describe('extalia snapshot CLI', () => {
  let root: string;
  let homeDirectory: string;
  let dataDirectory: string;

  beforeEach(async () => {
    root = mkdtempSync(path.join(tmpdir(), 'extalia-snapshot-cli-'));
    homeDirectory = path.join(root, 'home');
    dataDirectory = path.join(root, 'extalia-data');
    await mkdir(homeDirectory, { recursive: true });
    await mkdir(dataDirectory, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    rmSync(root, { recursive: true, force: true });
  });

  function makeHost(overrides: Partial<CliHost> & { fetch?: typeof fetch; dataDirectory?: string; createAgentHost?: typeof createAgentHost } = {}) {
    const out: string[] = [];
    const err: string[] = [];
    const value: CliHost & { fetch?: typeof fetch; dataDirectory?: string; createAgentHost?: typeof createAgentHost } = {
      version: '0.0.0-test',
      out: line => out.push(line),
      err: line => err.push(line),
      readFile: file => readFile(file, 'utf8'),
      exists: async file => {
        try {
          await stat(file);
          return true;
        } catch {
          return false;
        }
      },
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      env: { EXTALIA_HOME: dataDirectory, EXTALIA_SECRET_STORE: 'memory' },
      homeDirectory,
      dataDirectory,
      start: async () => 0,
      update: async () => 0,
      ...overrides,
    };
    return { value, out, err };
  }

  it('includes snapshot in extalia help and handles snapshot help / invalid usage', async () => {
    const helpIo = makeHost();
    expect(await run(['help'], helpIo.value)).toBe(0);
    expect(helpIo.out.join('\n')).toContain('snapshot <action>');
    expect(helpIo.out.join('\n')).toContain('<export|verify|preview-restore|restore|backups|rollback>');

    for (const args of [
      ['help'],
      ['--help'],
      ['-h'],
      ['export', '--help'],
      ['verify', '-h'],
      ['preview-restore', '--help'],
      ['restore', '--help'],
      ['backups', '-h'],
      ['rollback', '--help'],
    ]) {
      const io = makeHost();
      expect(await runSnapshot(args, io.value)).toBe(0);
      expect(io.out.join('\n')).toContain('Usage: extalia snapshot');
    }

    for (const args of [
      [],
      ['bogus'],
      ['verify'],
      ['preview-restore'],
      ['restore'],
      ['restore', 'snapshot.json', '--on-collision', 'bogus'],
      ['backups', 'unexpected'],
      ['rollback'],
      ['rollback', 'bk-invalid'],
    ]) {
      const io = makeHost();
      expect(await runSnapshot(args, io.value)).toBe(1);
      expect(io.err.length).toBeGreaterThan(0);
    }
  });

  it('refuses non-loopback Bridge URLs fail-closed without calling fetch', async () => {
    expect(parseLoopbackSnapshotBridgeUrl('http://127.0.0.1:4310')?.origin).toBe('http://127.0.0.1:4310');
    expect(parseLoopbackSnapshotBridgeUrl('http://localhost:4310/')?.origin).toBe('http://localhost:4310');
    expect(parseLoopbackSnapshotBridgeUrl('http://[::1]:4310')?.origin).toBe('http://[::1]:4310');
    expect(parseLoopbackSnapshotBridgeUrl('https://evil.example.com')).toBeUndefined();
    expect(parseLoopbackSnapshotBridgeUrl('http://evil.example.com:4310')).toBeUndefined();
    expect(parseLoopbackSnapshotBridgeUrl('https://127.0.0.1:4310')).toBeUndefined();
    expect(parseLoopbackSnapshotBridgeUrl('http://0.0.0.0:4310')).toBeUndefined();
    expect(parseLoopbackSnapshotBridgeUrl('http://user:pass@127.0.0.1:4310')).toBeUndefined();

    const fetchSpy = vi.fn();
    const outFile = path.join(root, 'blocked.json');

    const badArgIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await run(
        ['snapshot', 'export', '--url', 'https://evil.example.com', '--token', 'bridge-secret', '--out', outFile],
        badArgIo.value,
      ),
    ).toBe(1);
    expect(badArgIo.err.join('\n')).toContain('loopback');
    expect(fetchSpy).not.toHaveBeenCalled();

    const badEnvIo = makeHost({
      fetch: fetchSpy as unknown as typeof fetch,
      env: { EXTALIA_HOME: dataDirectory, EXTALIA_BRIDGE_URL: 'https://evil.example.com' },
    });
    expect(await runSnapshot(['preview-restore', outFile, '--token', 'bridge-secret'], badEnvIo.value)).toBe(1);
    expect(badEnvIo.err.join('\n')).toContain('loopback');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('exports via mocked Bridge fetch with 0o600 permissions, overwrite refusal without --force, and --force overwrite', async () => {
    const exportResult = buildSnapshotResult(undefined, {
      sections: ['settings', 'workspaces'],
      workspaceIds: ['ws-alpha'],
    }, 2);

    const fetchSpy = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://[::1]:4310/api/call');
      expect(init?.method).toBe('POST');
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer bridge-token-123');
      const body = JSON.parse(String(init?.body)) as { method: string; args: [OwnedDataSnapshotSelection] };
      expect(body.method).toBe('exportOwnedDataSnapshot');
      expect(body.args[0]).toEqual({
        sections: ['settings', 'workspaces'],
        workspaceIds: ['ws-alpha'],
      });
      return new Response(JSON.stringify({ result: exportResult }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const outFile = path.join(root, 'nested', 'snapshot.json');
    const firstIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        [
          'export',
          '--sections', 'workspaces,settings',
          '--workspace', 'ws-alpha',
          '--url', 'http://[::1]:4310',
          '--token', 'bridge-token-123',
          '--out', outFile,
        ],
        firstIo.value,
      ),
    ).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(firstIo.out.join('\n')).toContain(outFile);
    expect(firstIo.out.join('\n')).toContain(exportResult.sha256);
    expect(firstIo.out.join('\n')).toContain('Omitted secret fields: 2');

    if (process.platform !== 'win32') {
      const info = await stat(outFile);
      expect(info.mode & 0o777).toBe(0o600);
    }
    expect(await readFile(outFile, 'utf8')).toBe(exportResult.bundleJson);

    // Refuses overwrite without --force and leaves existing content untouched.
    await writeFile(outFile, '{"sentinel":true}', 'utf8');
    const refuseIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['export', '--url', 'http://[::1]:4310', '--token', 'bridge-token-123', '--out', outFile],
        refuseIo.value,
      ),
    ).toBe(1);
    expect(refuseIo.err.join('\n')).toContain('--force');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await readFile(outFile, 'utf8')).toBe('{"sentinel":true}');

    // Succeeds with --force and supports --json summary.
    const forceIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        [
          'export',
          '--sections', 'workspaces,settings',
          '--workspace', 'ws-alpha',
          '--url', 'http://[::1]:4310',
          '--token', 'bridge-token-123',
          '--out', outFile,
          '--force',
          '--json',
        ],
        forceIo.value,
      ),
    ).toBe(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const jsonSummary = JSON.parse(forceIo.out.join('\n')) as {
      outFile: string;
      sha256: string;
      entryCount: number;
      omittedSecretFields: number;
    };
    expect(jsonSummary).toMatchObject({
      outFile,
      sha256: exportResult.sha256,
      entryCount: 2,
      omittedSecretFields: 2,
    });
    expect(await readFile(outFile, 'utf8')).toBe(exportResult.bundleJson);
    if (process.platform !== 'win32') {
      const info = await stat(outFile);
      expect(info.mode & 0o777).toBe(0o600);
    }
  });

  it('verifies valid archives offline and exits non-zero on corrupt, tampered, wrong-version, and secret-canary archives', async () => {
    const valid = buildSnapshotResult();
    const validFile = path.join(root, 'valid.json');
    await writeFile(validFile, valid.bundleJson, 'utf8');

    const okIo = makeHost();
    expect(await runSnapshot(['verify', validFile], okIo.value)).toBe(0);
    expect(okIo.out.join('\n')).toContain('Snapshot verified');

    const okJsonIo = makeHost();
    expect(await runSnapshot(['verify', validFile, '--json'], okJsonIo.value)).toBe(0);
    expect(JSON.parse(okJsonIo.out.join('\n'))).toMatchObject({
      ok: true,
      checksumVerified: true,
      secretFreeVerified: true,
      entryCount: 2,
      conflicts: [],
    });

    // Corrupt JSON
    const corruptFile = path.join(root, 'corrupt.json');
    await writeFile(corruptFile, '{broken-json', 'utf8');
    const corruptIo = makeHost();
    expect(await runSnapshot(['verify', corruptFile], corruptIo.value)).toBe(1);
    expect(corruptIo.err.join('\n')).toContain('corrupt-archive');

    // Empty file
    const emptyFile = path.join(root, 'empty.json');
    await writeFile(emptyFile, '', 'utf8');
    const emptyIo = makeHost();
    expect(await runSnapshot(['verify', emptyFile], emptyIo.value)).toBe(1);
    expect(emptyIo.err.join('\n')).toContain('empty');

    // Oversized (> 10 MiB) file
    const bigFile = path.join(root, 'oversized.json');
    await writeFile(bigFile, 'x'.repeat(MAX_SNAPSHOT_FILE_BYTES + 1), 'utf8');
    const bigIo = makeHost();
    expect(await runSnapshot(['verify', bigFile], bigIo.value)).toBe(1);
    expect(bigIo.err.join('\n')).toContain('exceeds maximum size');

    // Tampered payload checksum
    const tampered = structuredClone(valid.bundle);
    tampered.entries[1]!.payload = { ...tampered.entries[1]!.payload, name: 'Tampered' };
    const tamperedFile = path.join(root, 'tampered.json');
    await writeFile(tamperedFile, JSON.stringify(tampered), 'utf8');
    const tamperedIo = makeHost();
    expect(await runSnapshot(['verify', tamperedFile], tamperedIo.value)).toBe(1);
    expect(tamperedIo.err.join('\n')).toContain('checksum-mismatch');

    // Wrong schemaVersion
    const wrongSchema = structuredClone(valid.bundle);
    (wrongSchema.manifest as { schemaVersion: number }).schemaVersion = 99;
    const wrongSchemaFile = path.join(root, 'wrong-schema.json');
    await writeFile(wrongSchemaFile, JSON.stringify(wrongSchema), 'utf8');
    const wrongSchemaIo = makeHost();
    expect(await runSnapshot(['verify', wrongSchemaFile], wrongSchemaIo.value)).toBe(1);
    expect(wrongSchemaIo.err.join('\n')).toContain('schema-mismatch');

    // Injected secret canary
    const withSecret = structuredClone(valid.bundle);
    withSecret.entries[0]!.payload = { note: `leaked ${'ghp'}_1234567890abcdefghij` };
    const secretFile = path.join(root, 'secret-canary.json');
    await writeFile(secretFile, JSON.stringify(withSecret), 'utf8');
    const secretIo = makeHost();
    expect(await runSnapshot(['verify', secretFile], secretIo.value)).toBe(1);
    expect(secretIo.err.join('\n')).toContain('secret-detected');
  });

  it('exports and preview-restores against an isolated temp dataDirectory and handles clean vs collision previews', async () => {
    const projectDirectory = path.join(root, 'ws-existing');
    await mkdir(projectDirectory, { recursive: true });

    const seedRuntime = await createAgentHost({
      kind: 'bridge',
      version: '0.0.0-test',
      dataDirectory,
      homeDirectory,
      importHome: homeDirectory,
      observationIntervalMs: 60_000,
      env: { EXTALIA_SECRET_STORE: 'memory' },
    });
    try {
      const connState = await seedRuntime.host.saveConnection({
        name: 'Snapshot Endpoint',
        preset: 'custom',
        api: 'openai-chat',
        baseUrl: 'https://api.example.com/v1',
        model: 'mock-model',
        credential: { kind: 'stored' },
        features: { memory: 'extalia', skills: 'extalia', history: true },
      }, 'test-canary-secret');
      const connection = connState.connections[0]!;
      await seedRuntime.host.completeSetup('managed');
      await seedRuntime.host.saveWorkspace({
        name: 'Existing Workspace',
        projectLocation: projectDirectory,
        connectionId: connection.id,
        permissions: { fileWrite: 'ask', commands: 'ask' },
      });
    } finally {
      await seedRuntime.close();
    }

    const exportedFile = path.join(root, 'local-export.json');
    const exportIo = makeHost();
    expect(
      await runSnapshot(
        ['export', '--data-dir', dataDirectory, '--out', exportedFile],
        exportIo.value,
      ),
    ).toBe(0);

    // Offline verify passes on the exported archive.
    const verifyIo = makeHost();
    expect(await runSnapshot(['verify', exportedFile], verifyIo.value)).toBe(0);

    // Collision preview against the same dataDirectory exits 1 with valid: false.
    const collisionIo = makeHost();
    expect(
      await runSnapshot(
        ['preview-restore', exportedFile, '--data-dir', dataDirectory, '--json'],
        collisionIo.value,
      ),
    ).toBe(1);
    const collisionPreview = JSON.parse(collisionIo.out.join('\n')) as OwnedDataRestorePreview;
    expect(collisionPreview.dryRunOnly).toBe(true);
    expect(collisionPreview.valid).toBe(false);
    expect(collisionPreview.wouldCollide).toBeGreaterThan(0);
    expect(collisionPreview.conflicts.some(item => item.kind === 'id-collision' && item.section === 'workspaces')).toBe(true);

    // Clean preview against a fresh empty temp dataDirectory exits 0 with valid: true.
    const cleanDataDir = mkdtempSync(path.join(tmpdir(), 'extalia-snapshot-clean-'));
    try {
      const cleanBundle = buildSnapshotResult([
        { section: 'workspaces', id: 'ws-fresh-restore', payload: { id: 'ws-fresh-restore', name: 'Fresh' } },
      ]);
      const cleanFile = path.join(root, 'clean-bundle.json');
      await writeFile(cleanFile, cleanBundle.bundleJson, 'utf8');

      const cleanIo = makeHost({ dataDirectory: cleanDataDir });
      expect(
        await runSnapshot(
          ['preview-restore', cleanFile, '--data-dir', cleanDataDir],
          cleanIo.value,
        ),
      ).toBe(0);
      expect(cleanIo.out.join('\n')).toContain('dryRunOnly=true');
      expect(cleanIo.out.join('\n')).toContain('VALID');
    } finally {
      rmSync(cleanDataDir, { recursive: true, force: true });
    }
  });

  it('supports preview-restore over mocked Bridge fetch for valid and blocked previews', async () => {
    const validBundle = buildSnapshotResult();
    const bundleFile = path.join(root, 'bridge-preview.json');
    await writeFile(bundleFile, validBundle.bundleJson, 'utf8');

    const cleanPreview: OwnedDataRestorePreview = {
      valid: true,
      dryRunOnly: true,
      schemaVersion: 1,
      entryCount: 2,
      sectionCounts: { settings: 1, workspaces: 1 },
      wouldAdd: 2,
      wouldCollide: 0,
      checksumVerified: true,
      secretFreeVerified: true,
      conflicts: [],
      warnings: ['Dry-run only: no files were modified.'],
    };
    const collisionPreview: OwnedDataRestorePreview = {
      ...cleanPreview,
      valid: false,
      wouldAdd: 1,
      wouldCollide: 1,
      conflicts: [{
        kind: 'id-collision',
        section: 'workspaces',
        id: 'ws-alpha',
        detail: 'Workspace ws-alpha already exists.',
      }],
    };

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: cleanPreview }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: collisionPreview }), { status: 200 }));

    const cleanIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['preview-restore', bundleFile, '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        cleanIo.value,
      ),
    ).toBe(0);
    expect(cleanIo.out.join('\n')).toContain('wouldAdd=2, wouldCollide=0');
    expect(cleanIo.out.join('\n')).toContain('Dry-run only: no files were modified.');

    const collisionIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['preview-restore', bundleFile, '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        collisionIo.value,
      ),
    ).toBe(1);
    expect(collisionIo.err.join('\n')).toContain('[id-collision]');
  });

  it('refuses non-loopback Bridge URLs for restore, backups, and rollback without calling fetch', async () => {
    const fetchSpy = vi.fn();
    const validBundle = buildSnapshotResult();
    const bundleFile = path.join(root, 'restore-blocked.json');
    await writeFile(bundleFile, validBundle.bundleJson, 'utf8');

    for (const args of [
      ['restore', bundleFile, '--yes', '--url', 'https://evil.example.com', '--token', 'bridge-tok'],
      ['backups', '--url', 'http://evil.example.com:4310', '--token', 'bridge-tok'],
      ['rollback', 'bk-0123456789ab', '--yes', '--url', 'https://127.0.0.1:4310', '--token', 'bridge-tok'],
    ]) {
      const io = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
      expect(await runSnapshot(args, io.value)).toBe(1);
      expect(io.err.join('\n')).toContain('loopback');
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refuses snapshot restore unless --yes is passed without calling applyOwnedDataRestore', async () => {
    const validBundle = buildSnapshotResult();
    const bundleFile = path.join(root, 'refuse-restore.json');
    await writeFile(bundleFile, validBundle.bundleJson, 'utf8');

    const fetchSpy = vi.fn();
    const applySpy = vi.fn();
    const createHostSpy = vi.fn(async () => ({
      host: {
        applyOwnedDataRestore: applySpy,
      },
      close: async () => undefined,
    })) as unknown as typeof createAgentHost;

    const bridgeHumanIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['restore', bundleFile, '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        bridgeHumanIo.value,
      ),
    ).toBe(1);
    expect(bridgeHumanIo.err.join('\n')).toContain('--yes');
    expect(fetchSpy).not.toHaveBeenCalled();

    const bridgeJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['restore', bundleFile, '--on-collision', 'skip-existing', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok', '--json'],
        bridgeJsonIo.value,
      ),
    ).toBe(1);
    expect(JSON.parse(bridgeJsonIo.out.join('\n'))).toMatchObject({
      ok: false,
      code: 'confirmation-required',
      rolledBack: false,
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const localIo = makeHost({ createAgentHost: createHostSpy });
    expect(
      await runSnapshot(['restore', bundleFile, '--data-dir', dataDirectory], localIo.value),
    ).toBe(1);
    expect(localIo.err.join('\n')).toContain('--yes');
    expect(applySpy).not.toHaveBeenCalled();
    expect(createHostSpy).not.toHaveBeenCalled();
  });

  it('supports restore --yes and --on-collision skip-existing over mocked Bridge fetch', async () => {
    const validBundle = buildSnapshotResult();
    const bundleFile = path.join(root, 'bridge-restore.json');
    await writeFile(bundleFile, validBundle.bundleJson, 'utf8');
    const expectedSha = sha256(validBundle.bundleJson);

    const successFailPolicy: OwnedDataRestoreApplyResult = {
      ok: true,
      backupId: 'bk-abcdef012345',
      bundleSha256: expectedSha,
      appliedCount: 2,
      skippedCount: 0,
      appliedBySection: { settings: 1, workspaces: 1 },
      skippedIds: [],
      vendorSourcesUntouched: true,
      warnings: ['Connection credentials were omitted and must be re-entered.'],
    };
    const successSkipPolicy: OwnedDataRestoreApplyResult = {
      ok: true,
      backupId: 'bk-fedcba987654',
      bundleSha256: expectedSha,
      appliedCount: 1,
      skippedCount: 1,
      appliedBySection: { workspaces: 1 },
      skippedIds: ['settings:profile'],
      vendorSourcesUntouched: true,
      warnings: [],
    };
    const failureResult: OwnedDataRestoreApplyResult = {
      ok: false,
      code: 'id-collision',
      backupId: 'bk-001122334455',
      rolledBack: true,
      conflicts: [{
        kind: 'id-collision',
        section: 'workspaces',
        id: 'ws-alpha',
        detail: 'Workspace ws-alpha already exists.',
      }],
      detail: 'Restore aborted on id-collision.',
    };

    const recordedInputs: ApplyOwnedDataRestoreInput[] = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe('http://127.0.0.1:4310/api/call');
      const body = JSON.parse(String(init?.body)) as { method: string; args: [ApplyOwnedDataRestoreInput] };
      expect(body.method).toBe('applyOwnedDataRestore');
      recordedInputs.push(body.args[0]);
      const index = recordedInputs.length;
      const result = index === 1 ? successFailPolicy : index === 2 ? successSkipPolicy : failureResult;
      return new Response(JSON.stringify({ result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const firstIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['restore', bundleFile, '--yes', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        firstIo.value,
      ),
    ).toBe(0);
    expect(firstIo.out.join('\n')).toContain('bk-abcdef012345');
    expect(firstIo.out.join('\n')).toContain('Applied entries:    2');
    expect(firstIo.out.join('\n')).toContain('Skipped entries:    0');
    expect(firstIo.out.join('\n')).toContain('Connection credentials were omitted');
    expect(recordedInputs[0]).toEqual({
      bundleJson: validBundle.bundleJson,
      expectedBundleSha256: expectedSha,
      conflictPolicy: 'fail-on-collision',
      confirmBackup: true,
    });

    const skipIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(
        [
          'restore',
          bundleFile,
          '--on-collision',
          'skip-existing',
          '--yes',
          '--url',
          'http://127.0.0.1:4310',
          '--token',
          'bridge-tok',
          '--json',
        ],
        skipIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(skipIo.out.join('\n'))).toEqual(successSkipPolicy);
    expect(recordedInputs[1]).toEqual({
      bundleJson: validBundle.bundleJson,
      expectedBundleSha256: expectedSha,
      conflictPolicy: 'skip-existing',
      confirmBackup: true,
    });

    const failIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['restore', bundleFile, '--yes', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        failIo.value,
      ),
    ).toBe(1);
    const failErr = failIo.err.join('\n');
    expect(failErr).toContain('id-collision');
    expect(failErr).toContain('Rolled back: true');
    expect(failErr).toContain('[id-collision]');
  });

  it('lists pre-restore backups via mocked Bridge fetch in human and --json formats', async () => {
    const backups: OwnedDataBackupSummary[] = [
      {
        backupId: 'bk-1234567890ab',
        createdAt: '2026-11-28T15:00:00.000Z',
        reason: 'pre-restore',
        sourceBundleSha256: 'a'.repeat(64),
        fileCount: 4,
      },
    ];

    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: [] }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: backups }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: backups }), { status: 200 }));

    const emptyIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(['backups', '--url', 'http://localhost:4310', '--token', 'bridge-tok'], emptyIo.value),
    ).toBe(0);
    expect(emptyIo.out.join('\n')).toContain('No pre-restore backups found.');

    const humanIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(['backups', '--url', 'http://localhost:4310', '--token', 'bridge-tok'], humanIo.value),
    ).toBe(0);
    const humanText = humanIo.out.join('\n');
    expect(humanText).toContain('bk-1234567890ab');
    expect(humanText).toContain('2026-11-28T15:00:00.000Z');
    expect(humanText).toContain('files=4');
    expect(humanText).toContain('aaaaaaaaaaaa');

    const jsonIo = makeHost({ fetch: fetchMock as unknown as typeof fetch });
    expect(
      await runSnapshot(['backups', '--url', 'http://localhost:4310', '--token', 'bridge-tok', '--json'], jsonIo.value),
    ).toBe(0);
    expect(JSON.parse(jsonIo.out.join('\n'))).toEqual(backups);
  });

  it('refuses rollback without --yes and executes rollback with --yes over mocked Bridge fetch', async () => {
    const fetchSpy = vi.fn();
    const refuseIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['rollback', 'bk-1234567890ab', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        refuseIo.value,
      ),
    ).toBe(1);
    expect(refuseIo.err.join('\n')).toContain('--yes');
    expect(fetchSpy).not.toHaveBeenCalled();

    const refuseJsonIo = makeHost({ fetch: fetchSpy as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['rollback', 'bk-1234567890ab', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok', '--json'],
        refuseJsonIo.value,
      ),
    ).toBe(1);
    expect(JSON.parse(refuseJsonIo.out.join('\n'))).toMatchObject({
      ok: false,
      backupId: 'bk-1234567890ab',
    });
    expect(fetchSpy).not.toHaveBeenCalled();

    const okResult: RollbackOwnedDataRestoreResult = {
      ok: true,
      backupId: 'bk-1234567890ab',
      restoredFiles: 3,
      removedFiles: 1,
      detail: 'Restored pre-restore backup bk-1234567890ab.',
    };
    const failResult: RollbackOwnedDataRestoreResult = {
      ok: false,
      backupId: 'bk-1234567890ab',
      detail: 'Backup bk-1234567890ab not found.',
    };

    const rpcFetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: okResult }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: okResult }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ result: failResult }), { status: 200 }));

    const humanIo = makeHost({ fetch: rpcFetch as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['rollback', 'bk-1234567890ab', '--yes', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        humanIo.value,
      ),
    ).toBe(0);
    expect(humanIo.out.join('\n')).toContain('bk-1234567890ab');
    expect(humanIo.out.join('\n')).toContain('Restored files: 3');
    expect(humanIo.out.join('\n')).toContain('Removed files:  1');

    const jsonIo = makeHost({ fetch: rpcFetch as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['rollback', 'bk-1234567890ab', '--yes', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok', '--json'],
        jsonIo.value,
      ),
    ).toBe(0);
    expect(JSON.parse(jsonIo.out.join('\n'))).toEqual(okResult);

    const failIo = makeHost({ fetch: rpcFetch as unknown as typeof fetch });
    expect(
      await runSnapshot(
        ['rollback', 'bk-1234567890ab', '--yes', '--url', 'http://127.0.0.1:4310', '--token', 'bridge-tok'],
        failIo.value,
      ),
    ).toBe(1);
    expect(failIo.err.join('\n')).toContain('bk-1234567890ab');
  });

  it('restores, lists pre-restore backups, skips collisions, and rolls back against a real temp dataDirectory', async () => {
    const sourceDataDir = mkdtempSync(path.join(tmpdir(), 'extalia-snapshot-src-'));
    const targetDataDir = mkdtempSync(path.join(tmpdir(), 'extalia-snapshot-dst-'));
    const sourceProjectDir = path.join(root, 'source-project');
    const targetProjectDir = path.join(root, 'target-project');
    await mkdir(sourceProjectDir, { recursive: true });
    await mkdir(targetProjectDir, { recursive: true });

    try {
      const sourceRuntime = await createAgentHost({
        kind: 'bridge',
        version: '0.0.0-test',
        dataDirectory: sourceDataDir,
        homeDirectory,
        importHome: homeDirectory,
        observationIntervalMs: 60_000,
        env: { EXTALIA_SECRET_STORE: 'memory' },
      });
      try {
        await sourceRuntime.host.saveProfile({
          displayName: 'Restored Profile Owner',
          preferences: { language: 'id', theme: 'light' },
        });
        const connState = await sourceRuntime.host.saveConnection({
          name: 'Source Endpoint',
          preset: 'custom',
          api: 'openai-chat',
          baseUrl: 'https://api.example.com/v1',
          model: 'mock-model',
          credential: { kind: 'stored' },
          features: { memory: 'extalia', skills: 'extalia', history: true },
        }, 'test-canary-secret');
        await sourceRuntime.host.completeSetup('managed');
        await sourceRuntime.host.saveWorkspace({
          name: 'Restored Source Workspace',
          projectLocation: sourceProjectDir,
          connectionId: connState.connections[0]!.id,
          permissions: { fileWrite: 'ask', commands: 'ask' },
        });
      } finally {
        await sourceRuntime.close();
      }

      const exportedFile = path.join(root, 'real-restore-export.json');
      const exportIo = makeHost({ dataDirectory: sourceDataDir });
      expect(
        await runSnapshot(['export', '--data-dir', sourceDataDir, '--out', exportedFile], exportIo.value),
      ).toBe(0);

      // Fresh target restore with --yes creates a pre-restore backup and restores workspace & profile.
      const restoreIo = makeHost({ dataDirectory: targetDataDir });
      expect(
        await runSnapshot(['restore', exportedFile, '--data-dir', targetDataDir, '--yes', '--json'], restoreIo.value),
      ).toBe(0);
      const restoreResult = JSON.parse(restoreIo.out.join('\n')) as OwnedDataRestoreApplyResult;
      expect(restoreResult.ok).toBe(true);
      if (restoreResult.ok) {
        expect(restoreResult.backupId).toMatch(/^bk-[0-9a-f]{12}$/);
        expect(restoreResult.appliedCount).toBeGreaterThanOrEqual(2);
      }

      const verifyRestored = await createAgentHost({
        kind: 'bridge',
        version: '0.0.0-test',
        dataDirectory: targetDataDir,
        homeDirectory,
        importHome: homeDirectory,
        observationIntervalMs: 60_000,
        env: { EXTALIA_SECRET_STORE: 'memory' },
      });
      try {
        const profile = await verifyRestored.host.getProfile();
        expect(profile.displayName).toBe('Restored Profile Owner');
        const state = await verifyRestored.host.getState();
        expect(state.workspaces.some(ws => ws.name === 'Restored Source Workspace')).toBe(true);
      } finally {
        await verifyRestored.close();
      }

      // Backups command lists the created pre-restore backup.
      const backupsIo = makeHost({ dataDirectory: targetDataDir });
      expect(
        await runSnapshot(['backups', '--data-dir', targetDataDir, '--json'], backupsIo.value),
      ).toBe(0);
      const backupList = JSON.parse(backupsIo.out.join('\n')) as OwnedDataBackupSummary[];
      expect(backupList.length).toBeGreaterThanOrEqual(1);
      const firstBackupId = backupList[0]!.backupId;

      // Re-applying with --on-collision skip-existing plus a new workspace succeeds while skipping colliding entries.
      const exportedBundle = JSON.parse(await readFile(exportedFile, 'utf8')) as OwnedDataSnapshotBundle;
      const baseWorkspace = exportedBundle.entries.find(entry => entry.section === 'workspaces')!;
      const newWorkspaceBundle = buildSnapshotResult([
        ...exportedBundle.entries.map(entry => ({
          section: entry.section,
          id: entry.id,
          payload: entry.payload,
        })),
        {
          section: 'workspaces',
          id: 'ws-skip-extra',
          payload: {
            ...baseWorkspace.payload,
            id: 'ws-skip-extra',
            slug: 'extra-non-colliding-workspace',
            name: 'Extra Non-Colliding Workspace',
            projectLocation: targetProjectDir,
          },
        },
      ]);
      const skipBundleFile = path.join(root, 'skip-collision-bundle.json');
      await writeFile(skipBundleFile, newWorkspaceBundle.bundleJson, 'utf8');

      const skipRestoreIo = makeHost({ dataDirectory: targetDataDir });
      expect(
        await runSnapshot(
          ['restore', skipBundleFile, '--on-collision', 'skip-existing', '--data-dir', targetDataDir, '--yes', '--json'],
          skipRestoreIo.value,
        ),
      ).toBe(0);
      const skipRestoreResult = JSON.parse(skipRestoreIo.out.join('\n')) as OwnedDataRestoreApplyResult;
      expect(skipRestoreResult.ok).toBe(true);
      if (skipRestoreResult.ok) {
        expect(skipRestoreResult.skippedCount).toBeGreaterThanOrEqual(1);
        expect(skipRestoreResult.appliedCount).toBeGreaterThanOrEqual(1);
      }

      // Rollback restores pre-restore state cleanly.
      const rollbackIo = makeHost({ dataDirectory: targetDataDir });
      expect(
        await runSnapshot(['rollback', firstBackupId, '--data-dir', targetDataDir, '--yes', '--json'], rollbackIo.value),
      ).toBe(0);
      const rollbackResult = JSON.parse(rollbackIo.out.join('\n')) as RollbackOwnedDataRestoreResult;
      expect(rollbackResult.ok).toBe(true);
    } finally {
      rmSync(sourceDataDir, { recursive: true, force: true });
      rmSync(targetDataDir, { recursive: true, force: true });
    }
  });
});
