import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalSnapshotJson,
  snapshotManifestDigestInput,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotSection,
} from '@extalia/core';
import type { HostMissionRun } from '@extalia/platform';
import { createOwnedDataRestoreService } from '../src/ownedDataRestore.js';
import { sha256Hex } from '../src/ownedDataSnapshot.js';
import { createAgentHost, type AgentHostRuntime } from '../src/service.js';
import { mockModelDiscovery } from './modelDiscoveryFixture.js';

const CANARY_API_KEY = 'sk-proj-canarysecretvalue123456'; // extalia-allow-secret
const CANARY_BEARER_TOKEN = 'Bearer canarybearertoken9876543210'; // extalia-allow-secret
const INJECTED_ARCHIVE_SECRET = 'sk-proj-injectedcanarysecret999999'; // extalia-allow-secret

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function sha256Bytes(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

async function snapshotDirectoryHashes(
  dir: string,
  options: { excludePrefixes?: readonly string[]; excludeSuffixes?: readonly string[] } = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const excludePrefixes = options.excludePrefixes ?? [];
  const excludeSuffixes = options.excludeSuffixes ?? [];

  async function walk(current: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full).split(path.sep).join('/');
      if (excludePrefixes.some(prefix => rel === prefix || rel.startsWith(`${prefix}/`))) continue;
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        if (excludeSuffixes.some(suffix => rel.endsWith(suffix))) continue;
        result.set(rel, sha256Bytes(await readFile(full)));
      }
    }
  }

  await walk(dir);
  return result;
}

function mockCompletionFetch(options: { failMissionCalls?: boolean } = {}) {
  return async (url: string, init?: RequestInit): Promise<Response> => {
    if (url.endsWith('/models')) {
      return Response.json({ data: [{ id: 'mock-model' }] });
    }
    const rawBody = String(init?.body ?? '{}');
    if (options.failMissionCalls && rawBody.includes('Check configuration safely.')) {
      return new Response('Simulated provider failure', { status: 500 });
    }
    const sse = `data: ${JSON.stringify({ choices: [{ delta: { content: 'Acknowledged.' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`;
    return new Response(sse, { headers: { 'content-type': 'text/event-stream' } });
  };
}

async function waitUntilIdle(runtime: AgentHostRuntime): Promise<void> {
  for (let i = 0; i < 300 && runtime.isBusy(); i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(runtime.isBusy()).toBe(false);
}

async function createTestHost(
  root: string,
  name: string,
  opts: {
    failMissionCalls?: boolean;
    onBeforeOwnedDataRestoreSection?: (section: OwnedDataSnapshotSection) => void | Promise<void>;
  } = {},
) {
  const dataDirectory = path.join(root, `${name}-data`);
  const homeDirectory = path.join(root, `${name}-home`);
  const projectDirectory = path.join(root, `${name}-project`);
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const fetchImpl = mockCompletionFetch({ failMissionCalls: opts.failMissionCalls });
  const runtime = await createAgentHost({
    kind: 'bridge',
    version: '0.4.367-test',
    dataDirectory,
    homeDirectory,
    importHome: homeDirectory,
    observationIntervalMs: 60_000,
    env: {
      EXTALIA_SECRET_STORE: 'memory',
      PATH: process.env.PATH,
      EXTALIA_HERMES_BIN: path.join(root, 'not-installed'),
    },
    fetch: fetchImpl,
    modelDiscovery: mockModelDiscovery(fetchImpl),
    ...(opts.onBeforeOwnedDataRestoreSection
      ? { onBeforeOwnedDataRestoreSection: opts.onBeforeOwnedDataRestoreSection }
      : {}),
  });
  let closed = false;
  const closeOnce = async () => {
    if (closed) return;
    closed = true;
    await runtime.close();
  };
  cleanups.push(closeOnce);
  return { runtime, host: runtime.host, dataDirectory, homeDirectory, projectDirectory, closeOnce };
}

async function seedOwnedHostState(ctx: Awaited<ReturnType<typeof createTestHost>>, scheduleEnabled = true) {
  const { host, runtime, projectDirectory, homeDirectory } = ctx;

  // Synthetic external vendor file that must never be modified or read by restore ops.
  const vendorFile = path.join(homeDirectory, '.codex', 'sessions', 'sample.jsonl');
  await mkdir(path.dirname(vendorFile), { recursive: true });
  await writeFile(vendorFile, '{"type":"session_meta","id":"vendor-sample"}\n', 'utf8');
  const vendorHashBefore = sha256Bytes(await readFile(vendorFile));

  await host.saveProfile({
    displayName: 'Workspace Owner',
    preferences: { language: 'en', theme: 'dark', material: 'glass', font: 'inter', landingPage: 'office' },
  });

  const connState = await host.saveConnection({
    name: 'Primary Endpoint',
    preset: 'custom',
    api: 'openai-chat',
    baseUrl: 'https://api.example.com/v1',
    model: 'mock-model',
    credential: { kind: 'stored' },
    features: { memory: 'extalia', skills: 'extalia', history: true },
  }, CANARY_API_KEY);
  const connection = connState.connections[0]!;

  await host.completeSetup('managed');

  const operatingProfile = await host.saveOperatingProfile!({
    name: 'Strict Reviewer',
    purpose: 'Careful verification',
    personality: 'Concise and factual',
    defaults: {
      connectionId: connection.id,
      model: 'mock-model',
    },
  });

  const wsState = await host.saveWorkspace({
    name: 'Owned Project',
    projectLocation: projectDirectory,
    connectionId: connection.id,
    permissions: { fileWrite: 'ask', commands: 'ask' },
  });
  const workspace = wsState.workspaces[0]!;
  await host.setWorkspaceOperatingProfile!(workspace.id, { profileId: operatingProfile.id });

  const session = await host.createSession(workspace.id);
  await host.sendPrompt(session.id, `Please verify config using ${CANARY_BEARER_TOKEN}`);
  await waitUntilIdle(runtime);

  const mission = await host.startNativeMission(session.id, {
    title: 'Unverified verification mission',
    maxConcurrency: 1,
    tasks: [
      {
        id: 'inspect',
        title: 'Inspect config',
        instructions: 'Check configuration safely.',
        connectionId: connection.id,
        model: 'mock-model',
        dependsOn: [],
      },
    ],
  });
  let settledMission: HostMissionRun | undefined;
  for (let i = 0; i < 300; i++) {
    const current = await host.nativeMissionRun(session.id, mission.id);
    if (current.state !== 'running') {
      settledMission = current;
      break;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  await waitUntilIdle(runtime);
  expect(settledMission).toBeDefined();
  expect(settledMission!.state).toBe('failed');

  const scheduleCatalog = await host.saveSchedule!({
    workspaceId: workspace.id,
    name: 'Nightly Check',
    prompt: 'Summarize workspace status.',
    enabled: scheduleEnabled,
    trigger: { kind: 'interval', intervalMinutes: 60 },
    sessionTarget: { mode: 'create-and-reuse' },
    assignment: { teamMode: 'workspace' },
    missedPolicy: 'skip',
  });
  const schedule = scheduleCatalog.schedules[0]!;

  return {
    vendorFile,
    vendorHashBefore,
    connection,
    operatingProfile,
    workspace,
    session,
    mission: settledMission!,
    schedule,
  };
}

function resignBundle(bundle: OwnedDataSnapshotBundle): { bundleJson: string; sha256: string } {
  for (const entry of bundle.entries) {
    entry.sha256 = sha256Hex(canonicalSnapshotJson(entry.payload));
  }
  bundle.manifest.entryCount = bundle.entries.length;
  bundle.manifest.manifestSha256 = sha256Hex(snapshotManifestDigestInput(bundle.manifest, bundle.entries));
  const bundleJson = JSON.stringify(bundle, null, 2);
  return { bundleJson, sha256: sha256Hex(bundleJson) };
}

describe('Host owned-data portable restore & atomic rollback (V2-18, FR-037, AR-28, REL-010)', () => {
  it('AR-28 preflight refusals create zero backups and change zero file hashes in dataDirectory', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-restore-preflight-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', { failMissionCalls: true });
    await seedOwnedHostState(sourceCtx);

    const exported = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'missions', 'schedules'],
    });

    const freshCtx = await createTestHost(root, 'fresh');
    const hashesBefore = await snapshotDirectoryHashes(freshCtx.dataDirectory);

    // 1. confirmation-required
    const noConfirm = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: false,
    });
    expect(noConfirm.ok).toBe(false);
    if (!noConfirm.ok) {
      expect(noConfirm.code).toBe('confirmation-required');
      expect(noConfirm.rolledBack).toBe(false);
    }

    // 2. digest-mismatch
    const digestMismatch = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: '0'.repeat(64),
      confirmBackup: true,
    });
    expect(digestMismatch.ok).toBe(false);
    if (!digestMismatch.ok) {
      expect(digestMismatch.code).toBe('digest-mismatch');
      expect(digestMismatch.rolledBack).toBe(false);
    }

    // 3. corrupt-archive
    const corruptJson = '{not-valid-json';
    const corrupt = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: corruptJson,
      expectedBundleSha256: sha256Hex(corruptJson),
      confirmBackup: true,
    });
    expect(corrupt.ok).toBe(false);
    if (!corrupt.ok) {
      expect(corrupt.code).toBe('corrupt-archive');
      expect(corrupt.rolledBack).toBe(false);
    }

    // 4. checksum-mismatch
    const tamperedBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    const wsEntry = tamperedBundle.entries.find(entry => entry.section === 'workspaces')!;
    wsEntry.payload.name = 'Tampered Name';
    const tamperedJson = JSON.stringify(tamperedBundle);
    const checksumMismatch = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: tamperedJson,
      expectedBundleSha256: sha256Hex(tamperedJson),
      confirmBackup: true,
    });
    expect(checksumMismatch.ok).toBe(false);
    if (!checksumMismatch.ok) {
      expect(checksumMismatch.code).toBe('checksum-mismatch');
      expect(checksumMismatch.rolledBack).toBe(false);
    }

    // 5. secret-detected
    const secretBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    secretBundle.entries[0]!.payload.leakedNote = INJECTED_ARCHIVE_SECRET;
    const resignedSecret = resignBundle(secretBundle);
    const secretDetected = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: resignedSecret.bundleJson,
      expectedBundleSha256: resignedSecret.sha256,
      confirmBackup: true,
    });
    expect(secretDetected.ok).toBe(false);
    if (!secretDetected.ok) {
      expect(secretDetected.code).toBe('secret-detected');
      expect(secretDetected.rolledBack).toBe(false);
    }

    // 6. schema-mismatch
    const futureBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    (futureBundle.manifest as { schemaVersion: number }).schemaVersion = 99;
    const futureJson = JSON.stringify(futureBundle);
    const schemaMismatch = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: futureJson,
      expectedBundleSha256: sha256Hex(futureJson),
      confirmBackup: true,
    });
    expect(schemaMismatch.ok).toBe(false);
    if (!schemaMismatch.ok) {
      expect(schemaMismatch.code).toBe('schema-mismatch');
      expect(schemaMismatch.rolledBack).toBe(false);
    }

    // 7. missing-dependency
    const partialExport = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['sessions', 'schedules'],
    });
    const missingDep = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: partialExport.bundleJson,
      expectedBundleSha256: partialExport.sha256,
      confirmBackup: true,
    });
    expect(missingDep.ok).toBe(false);
    if (!missingDep.ok) {
      expect(missingDep.code).toBe('missing-dependency');
      expect(missingDep.rolledBack).toBe(false);
    }

    // 8. id-collision under default fail-on-collision policy against sourceCtx
    const sourceHashesBefore = await snapshotDirectoryHashes(sourceCtx.dataDirectory);
    const collision = await sourceCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: true,
    });
    expect(collision.ok).toBe(false);
    if (!collision.ok) {
      expect(collision.code).toBe('id-collision');
      expect(collision.rolledBack).toBe(false);
    }
    expect(await sourceCtx.host.listOwnedDataBackups!()).toEqual([]);
    const sourceHashesAfter = await snapshotDirectoryHashes(sourceCtx.dataDirectory);
    expect([...sourceHashesAfter.entries()]).toEqual([...sourceHashesBefore.entries()]);

    // 9. host-busy unit check creates zero backups
    const busyRestore = createOwnedDataRestoreService({
      appVersion: '0.4.367-test',
      dataDirectory: freshCtx.dataDirectory,
      isBusy: () => true,
      previewRestore: async () => {
        throw new Error('should not preview when busy');
      },
      restoreOperatingProfile: async () => undefined,
      restoreWorkspace: async () => undefined,
      restoreSession: async () => undefined,
      restoreSchedule: async () => undefined,
      restoreSettings: async () => ({ applied: false }),
      reloadAfterRollback: async () => undefined,
    });
    const busyResult = await busyRestore.applyRestore({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: true,
    });
    expect(busyResult.ok).toBe(false);
    if (!busyResult.ok) {
      expect(busyResult.code).toBe('host-busy');
      expect(busyResult.rolledBack).toBe(false);
    }

    // Fresh host still has zero backups and zero modified files.
    expect(await freshCtx.host.listOwnedDataBackups!()).toEqual([]);
    const backupsStat = await lstat(path.join(freshCtx.dataDirectory, 'backups')).catch(() => undefined);
    expect(backupsStat).toBeUndefined();
    const hashesAfter = await snapshotDirectoryHashes(freshCtx.dataDirectory);
    expect([...hashesAfter.entries()]).toEqual([...hashesBefore.entries()]);
  });

  it('restores into a fresh host with original IDs, disabled schedules, 0o600 backups, restart persistence, and untouched vendor files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-restore-fresh-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', { failMissionCalls: true });
    const seeded = await seedOwnedHostState(sourceCtx, true);
    expect(seeded.schedule.enabled).toBe(true);

    const exported = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'missions', 'schedules'],
    });

    const freshCtx = await createTestHost(root, 'fresh');
    const applyResult = await freshCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: true,
    });

    expect(applyResult.ok).toBe(true);
    if (!applyResult.ok) return;

    expect(applyResult.bundleSha256).toBe(exported.sha256);
    expect(applyResult.vendorSourcesUntouched).toBe(true);
    expect(applyResult.appliedBySection).toEqual({
      operatingProfiles: 1,
      workspaces: 1,
      sessions: 1,
      schedules: 1,
      settings: 1,
    });
    expect(applyResult.appliedCount).toBe(5);
    expect(applyResult.skippedCount).toBe(1);
    expect(applyResult.skippedIds).toEqual([seeded.mission.id]);
    expect(applyResult.warnings.some(warning => /enabled: false/i.test(warning))).toBe(true);
    expect(applyResult.warnings.some(warning => /mission/i.test(warning))).toBe(true);

    // Verify in-memory & disk state immediately after restore.
    const profilesAfter = await freshCtx.host.listOperatingProfiles!();
    expect(profilesAfter.map(item => item.id)).toEqual([seeded.operatingProfile.id]);

    const stateAfter = await freshCtx.host.getState();
    expect(stateAfter.workspaces.map(item => item.id)).toEqual([seeded.workspace.id]);
    expect(stateAfter.sessions.map(item => item.id)).toEqual([seeded.session.id]);

    const userProfileAfter = await freshCtx.host.getProfile();
    expect(userProfileAfter.displayName).toBe('Workspace Owner');
    expect(userProfileAfter.preferences.theme).toBe('dark');

    const scheduleCatalogAfter = await freshCtx.host.listSchedules!();
    expect(scheduleCatalogAfter.schedules).toHaveLength(1);
    expect(scheduleCatalogAfter.schedules[0]!.id).toBe(seeded.schedule.id);
    expect(scheduleCatalogAfter.schedules[0]!.enabled).toBe(false);
    expect(scheduleCatalogAfter.schedules[0]!.state).toBe('paused');

    // Missions are never fabricated on restore.
    expect(await freshCtx.host.listNativeMissions(seeded.session.id)).toEqual([]);

    // Redacted session messages are preserved on disk.
    const restoredMessagesRaw = await readFile(
      path.join(freshCtx.dataDirectory, 'sessions', `${seeded.session.id}.messages.json`),
      'utf8',
    );
    expect(restoredMessagesRaw).toContain('[redacted]');
    expect(restoredMessagesRaw).not.toContain(CANARY_BEARER_TOKEN);

    // Pre-restore backup exists with 0o600 file mode & 0o700 dir mode.
    const backups = await freshCtx.host.listOwnedDataBackups!();
    expect(backups).toHaveLength(1);
    expect(backups[0]!.backupId).toBe(applyResult.backupId);
    expect(backups[0]!.sourceBundleSha256).toBe(exported.sha256);
    if (process.platform !== 'win32') {
      const backupDirStat = await lstat(path.join(freshCtx.dataDirectory, 'backups', 'restore', applyResult.backupId));
      expect(backupDirStat.mode & 0o777).toBe(0o700);
      const manifestStat = await lstat(
        path.join(freshCtx.dataDirectory, 'backups', 'restore', applyResult.backupId, 'backup.json'),
      );
      expect(manifestStat.mode & 0o777).toBe(0o600);
    }

    // External vendor file remains untouched.
    const vendorHashAfter = sha256Bytes(await readFile(seeded.vendorFile));
    expect(vendorHashAfter).toBe(seeded.vendorHashBefore);

    // Close and reopen the host to verify persistence across restart.
    await freshCtx.closeOnce();
    const reopenedFetch = mockCompletionFetch();
    const reopenedRuntime = await createAgentHost({
      kind: 'bridge',
      version: '0.4.367-test',
      dataDirectory: freshCtx.dataDirectory,
      homeDirectory: freshCtx.homeDirectory,
      importHome: freshCtx.homeDirectory,
      observationIntervalMs: 60_000,
      env: {
        EXTALIA_SECRET_STORE: 'memory',
        PATH: process.env.PATH,
        EXTALIA_HERMES_BIN: path.join(root, 'not-installed'),
      },
      fetch: reopenedFetch,
      modelDiscovery: mockModelDiscovery(reopenedFetch),
    });
    cleanups.push(() => reopenedRuntime.close());

    expect((await reopenedRuntime.host.listOperatingProfiles!()).map(item => item.id)).toEqual([seeded.operatingProfile.id]);
    const reopenedState = await reopenedRuntime.host.getState();
    expect(reopenedState.workspaces.map(item => item.id)).toEqual([seeded.workspace.id]);
    expect(reopenedState.sessions.map(item => item.id)).toEqual([seeded.session.id]);
    const reopenedSchedules = await reopenedRuntime.host.listSchedules!();
    expect(reopenedSchedules.schedules).toHaveLength(1);
    expect(reopenedSchedules.schedules[0]!.id).toBe(seeded.schedule.id);
    expect(reopenedSchedules.schedules[0]!.enabled).toBe(false);
  });

  it('skip-existing preserves colliding entries while adding new non-colliding entries', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-restore-skip-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', { failMissionCalls: true });
    const seeded = await seedOwnedHostState(sourceCtx, false);

    // Add a second operating profile, workspace, session, and schedule on sourceCtx.
    const extraOp = await sourceCtx.host.saveOperatingProfile!({
      name: 'Extra Reviewer',
      purpose: 'Secondary profile',
      defaults: { connectionId: seeded.connection.id, model: 'mock-model' },
    });
    const extraProjectDir = path.join(root, 'extra-project');
    await mkdir(extraProjectDir, { recursive: true });
    const wsAfterExtra = await sourceCtx.host.saveWorkspace({
      name: 'Extra Project',
      projectLocation: extraProjectDir,
      connectionId: seeded.connection.id,
      permissions: { fileWrite: 'ask', commands: 'ask' },
    });
    const extraWorkspace = wsAfterExtra.workspaces.find(w => w.id !== seeded.workspace.id)!;
    const extraSession = await sourceCtx.host.createSession(extraWorkspace.id);
    const extraScheduleCatalog = await sourceCtx.host.saveSchedule!({
      workspaceId: extraWorkspace.id,
      name: 'Extra Schedule',
      prompt: 'Check extra project.',
      enabled: true,
      trigger: { kind: 'interval', intervalMinutes: 30 },
      sessionTarget: { mode: 'create-and-reuse' },
      assignment: { teamMode: 'workspace' },
      missedPolicy: 'skip',
    });
    const extraSchedule = extraScheduleCatalog.schedules.find(s => s.workspaceId === extraWorkspace.id)!;

    // Export full bundle from sourceCtx (contains original + extra items).
    const fullExport = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'schedules'],
    });

    // Target host already has the original items (from a partial export of the original items).
    const targetCtx = await createTestHost(root, 'target');
    const partialBundle = JSON.parse(fullExport.bundleJson) as OwnedDataSnapshotBundle;
    partialBundle.entries = partialBundle.entries.filter(
      entry => entry.id !== extraOp.id
        && entry.id !== extraWorkspace.id
        && entry.id !== extraSession.id
        && entry.id !== extraSchedule.id,
    );
    const resignedPartial = resignBundle(partialBundle);

    const firstApply = await targetCtx.host.applyOwnedDataRestore!({
      bundleJson: resignedPartial.bundleJson,
      expectedBundleSha256: resignedPartial.sha256,
      confirmBackup: true,
    });
    expect(firstApply.ok).toBe(true);

    // Mutate targetCtx's display name so settings also exists & collides cleanly.
    await targetCtx.host.saveProfile({ displayName: 'Target Host Custom Name' });

    // Apply full bundle with skip-existing: colliding entries are skipped, new entries are added.
    const secondApply = await targetCtx.host.applyOwnedDataRestore!({
      bundleJson: fullExport.bundleJson,
      expectedBundleSha256: fullExport.sha256,
      conflictPolicy: 'skip-existing',
      confirmBackup: true,
    });
    expect(secondApply.ok).toBe(true);
    if (!secondApply.ok) return;

    expect(secondApply.appliedBySection).toEqual({
      operatingProfiles: 1,
      workspaces: 1,
      sessions: 1,
      schedules: 1,
    });
    expect(secondApply.appliedCount).toBe(4);
    expect(secondApply.skippedCount).toBe(5);
    expect(secondApply.skippedIds).toEqual(expect.arrayContaining([
      seeded.operatingProfile.id,
      seeded.workspace.id,
      seeded.session.id,
      seeded.schedule.id,
      'profile',
    ]));

    // Colliding profile display name was preserved, and both original & new entities exist.
    expect((await targetCtx.host.getProfile()).displayName).toBe('Target Host Custom Name');
    expect((await targetCtx.host.listOperatingProfiles!()).map(p => p.id).sort()).toEqual(
      [seeded.operatingProfile.id, extraOp.id].sort(),
    );
    const state = await targetCtx.host.getState();
    expect(state.workspaces.map(w => w.id).sort()).toEqual([seeded.workspace.id, extraWorkspace.id].sort());
    expect(state.sessions.map(s => s.id).sort()).toEqual([seeded.session.id, extraSession.id].sort());
    const schedules = (await targetCtx.host.listSchedules!()).schedules;
    expect(schedules.map(s => s.id).sort()).toEqual([seeded.schedule.id, extraSchedule.id].sort());
    expect(schedules.find(s => s.id === extraSchedule.id)!.enabled).toBe(false);
  });

  it('fault-injection mid-restore triggers automatic atomic rollback restoring pre-restore hashes byte-for-byte', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-restore-fault-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', { failMissionCalls: true });
    await seedOwnedHostState(sourceCtx, true);
    const exported = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'schedules'],
    });

    const faultCtx = await createTestHost(root, 'fault', {
      onBeforeOwnedDataRestoreSection: section => {
        if (section === 'sessions') {
          throw new Error('Injected fault before sessions write');
        }
      },
    });
    const hashesBefore = await snapshotDirectoryHashes(faultCtx.dataDirectory, {
      excludePrefixes: ['backups'],
      excludeSuffixes: ['-wal', '-shm'],
    });

    const result = await faultCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: true,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('write-failed-rolled-back');
      expect(result.rolledBack).toBe(true);
      expect(result.backupId).toMatch(/^bk-[0-9a-f]{12}$/);
    }

    // In-memory host state must be clean (operatingProfiles and workspaces rolled back).
    expect(await faultCtx.host.listOperatingProfiles!()).toEqual([]);
    const stateAfter = await faultCtx.host.getState();
    expect(stateAfter.workspaces).toEqual([]);
    expect(stateAfter.sessions).toEqual([]);
    expect((await faultCtx.host.listSchedules!()).schedules).toEqual([]);

    // Pre-restore files on disk must match byte-for-byte SHA-256.
    const hashesAfter = await snapshotDirectoryHashes(faultCtx.dataDirectory, {
      excludePrefixes: ['backups'],
      excludeSuffixes: ['-wal', '-shm'],
    });
    expect([...hashesAfter.entries()]).toEqual([...hashesBefore.entries()]);
  });

  it('explicit rollbackOwnedDataRestore restores pre-restore dataDirectory state cleanly across restart', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-restore-rollback-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', { failMissionCalls: true });
    const seeded = await seedOwnedHostState(sourceCtx, true);
    const exported = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'schedules'],
    });

    const targetCtx = await createTestHost(root, 'target');
    // Seed an existing local profile preference before restore so rollback restores it too.
    await targetCtx.host.saveProfile({ displayName: 'Before Restore User' });
    const hashesBefore = await snapshotDirectoryHashes(targetCtx.dataDirectory, {
      excludePrefixes: ['backups'],
      excludeSuffixes: ['-wal', '-shm'],
    });

    const applied = await targetCtx.host.applyOwnedDataRestore!({
      bundleJson: exported.bundleJson,
      expectedBundleSha256: exported.sha256,
      confirmBackup: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) return;

    // Verify restored state is live before rollback.
    expect((await targetCtx.host.listOperatingProfiles!()).map(p => p.id)).toEqual([seeded.operatingProfile.id]);
    expect((await targetCtx.host.getState()).workspaces.map(w => w.id)).toEqual([seeded.workspace.id]);
    expect((await targetCtx.host.listSchedules!()).schedules.map(s => s.id)).toEqual([seeded.schedule.id]);

    // Roll back explicitly via backupId.
    const rollbackResult = await targetCtx.host.rollbackOwnedDataRestore!(applied.backupId);
    expect(rollbackResult.ok).toBe(true);
    if (rollbackResult.ok) {
      expect(rollbackResult.backupId).toBe(applied.backupId);
      expect(rollbackResult.restoredFiles).toBeGreaterThanOrEqual(1);
      expect(rollbackResult.removedFiles).toBeGreaterThanOrEqual(1);
    }

    // Immediate in-memory check.
    expect((await targetCtx.host.getProfile()).displayName).toBe('Before Restore User');
    expect(await targetCtx.host.listOperatingProfiles!()).toEqual([]);
    const stateAfterRollback = await targetCtx.host.getState();
    expect(stateAfterRollback.workspaces).toEqual([]);
    expect(stateAfterRollback.sessions).toEqual([]);
    expect((await targetCtx.host.listSchedules!()).schedules).toEqual([]);

    // File hashes match pre-restore state byte-for-byte.
    const hashesAfter = await snapshotDirectoryHashes(targetCtx.dataDirectory, {
      excludePrefixes: ['backups'],
      excludeSuffixes: ['-wal', '-shm'],
    });
    expect([...hashesAfter.entries()]).toEqual([...hashesBefore.entries()]);

    // Close and reopen host to confirm rollback durability across restart.
    await targetCtx.closeOnce();
    const reopenedFetch = mockCompletionFetch();
    const reopened = await createAgentHost({
      kind: 'bridge',
      version: '0.4.367-test',
      dataDirectory: targetCtx.dataDirectory,
      homeDirectory: targetCtx.homeDirectory,
      importHome: targetCtx.homeDirectory,
      observationIntervalMs: 60_000,
      env: {
        EXTALIA_SECRET_STORE: 'memory',
        PATH: process.env.PATH,
        EXTALIA_HERMES_BIN: path.join(root, 'not-installed'),
      },
      fetch: reopenedFetch,
      modelDiscovery: mockModelDiscovery(reopenedFetch),
    });
    cleanups.push(() => reopened.close());

    expect((await reopened.host.getProfile()).displayName).toBe('Before Restore User');
    expect(await reopened.host.listOperatingProfiles!()).toEqual([]);
    const reopenedState = await reopened.host.getState();
    expect(reopenedState.workspaces).toEqual([]);
    expect(reopenedState.sessions).toEqual([]);
    expect((await reopened.host.listSchedules!()).schedules).toEqual([]);

    // Invalid backupId or missing backup refuses cleanly.
    const badId = await reopened.host.rollbackOwnedDataRestore!('bad-id');
    expect(badId.ok).toBe(false);
    const missingBackup = await reopened.host.rollbackOwnedDataRestore!('bk-000000000000');
    expect(missingBackup.ok).toBe(false);
  });
});
