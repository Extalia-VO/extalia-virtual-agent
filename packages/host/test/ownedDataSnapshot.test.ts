import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  canonicalSnapshotJson,
  snapshotManifestDigestInput,
  verifyOwnedDataSnapshotIntegrity,
  type OwnedDataSnapshotBundle,
} from '@extalia/core';
import type { HostMissionRun } from '@extalia/platform';
import { createOwnedDataSnapshotService, MAX_SNAPSHOT_BYTES, sha256Hex } from '../src/ownedDataSnapshot.js';
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

async function snapshotDirectoryHashes(dir: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  async function walk(current: string): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile()) {
        const content = await readFile(full);
        result.set(rel, sha256Bytes(content));
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

async function createTestHost(root: string, name: string, failMissionCalls = false) {
  const dataDirectory = path.join(root, `${name}-data`);
  const homeDirectory = path.join(root, `${name}-home`);
  const projectDirectory = path.join(root, `${name}-project`);
  await mkdir(homeDirectory, { recursive: true });
  await mkdir(projectDirectory, { recursive: true });

  const fetchImpl = mockCompletionFetch({ failMissionCalls });
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
  });
  cleanups.push(async () => {
    await runtime.close();
  });
  return { runtime, host: runtime.host, dataDirectory, homeDirectory, projectDirectory };
}

async function seedOwnedHostState(ctx: Awaited<ReturnType<typeof createTestHost>>) {
  const { host, runtime, projectDirectory, homeDirectory } = ctx;

  // Synthetic external vendor file that must never be modified or read by snapshot ops.
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
    enabled: false,
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

function resignBundle(bundle: OwnedDataSnapshotBundle): string {
  for (const entry of bundle.entries) {
    entry.sha256 = sha256Hex(canonicalSnapshotJson(entry.payload));
  }
  bundle.manifest.entryCount = bundle.entries.length;
  bundle.manifest.manifestSha256 = sha256Hex(snapshotManifestDigestInput(bundle.manifest, bundle.entries));
  return JSON.stringify(bundle, null, 2);
}

describe('Host owned-data snapshot export & dry-run restore preview (AR-20, AR-28)', () => {
  it('AR-20: previews and exports owned data without leaking secrets or touching external vendor files', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-snapshot-ar20-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const ctx = await createTestHost(root, 'source', true);
    const seeded = await seedOwnedHostState(ctx);

    const preview = await ctx.host.previewOwnedDataExport!({
      sections: ['schedules', 'missions', 'sessions', 'operatingProfiles', 'workspaces', 'settings'],
    });
    expect(preview.selection.sections).toEqual([
      'settings',
      'workspaces',
      'operatingProfiles',
      'sessions',
      'missions',
      'schedules',
    ]);
    expect(preview.excludesSecrets).toBe(true);
    expect(preview.excludesVendorSources).toBe(true);
    expect(preview.sectionCounts).toEqual({
      settings: 1,
      workspaces: 1,
      operatingProfiles: 1,
      sessions: 1,
      missions: 1,
      schedules: 1,
    });
    expect(preview.totalEntries).toBe(6);
    expect(preview.estimatedBytes).toBeGreaterThan(0);
    expect(preview.warnings.some(warning => /unverified/i.test(warning))).toBe(true);

    const exported = await ctx.host.exportOwnedDataSnapshot!({
      sections: ['schedules', 'missions', 'sessions', 'operatingProfiles', 'workspaces', 'settings'],
    });
    expect(exported.omittedSecretFields).toBeGreaterThanOrEqual(2);
    expect(exported.byteLength).toBe(Buffer.byteLength(exported.bundleJson, 'utf8'));
    expect(exported.sha256).toBe(sha256Hex(exported.bundleJson));
    expect(exported.bundleJson).not.toContain(CANARY_API_KEY);
    expect(exported.bundleJson).not.toContain(CANARY_BEARER_TOKEN);
    expect(exported.bundleJson).not.toContain('canarysecretvalue');
    expect(exported.bundleJson).not.toContain('canarybearertoken');
    expect(exported.bundleJson).not.toContain('"credential"');

    // Verify integrity of exported JSON.
    const verified = verifyOwnedDataSnapshotIntegrity(exported.bundleJson, sha256Hex);
    expect(verified.ok).toBe(true);
    expect(verified.checksumVerified).toBe(true);
    expect(verified.secretFreeVerified).toBe(true);

    // Settings descriptor retains non-secret fields only.
    const settingsEntry = exported.bundle.entries.find(entry => entry.section === 'settings');
    expect(settingsEntry?.id).toBe('profile');
    const connections = settingsEntry?.payload.connections as Record<string, unknown>[];
    expect(connections).toHaveLength(1);
    expect(connections[0]).toMatchObject({
      id: seeded.connection.id,
      name: 'Primary Endpoint',
      api: 'openai-chat',
      url: 'https://api.example.com/v1',
      model: 'mock-model',
    });
    expect(connections[0]).not.toHaveProperty('credential');

    // Session messages redact Bearer tokens cleanly.
    const sessionEntry = exported.bundle.entries.find(entry => entry.section === 'sessions');
    expect(JSON.stringify(sessionEntry?.payload.messages)).toContain('[redacted]');

    // Unverified / failed mission preserves explicit state and verification status.
    const missionEntry = exported.bundle.entries.find(entry => entry.section === 'missions');
    expect(missionEntry?.payload.state).toBe('failed');
    const missionTasks = missionEntry?.payload.tasks as { state: string; verification?: string }[];
    expect(missionTasks[0]?.state).toBe('failed');
    expect(missionTasks[0]?.verification).not.toBe('verified');

    // Re-exporting unchanged state yields identical entry and manifest digests.
    const exportedAgain = await ctx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'missions', 'schedules'],
    });
    expect(exportedAgain.bundle.manifest.manifestSha256).toBe(exported.bundle.manifest.manifestSha256);
    expect(exportedAgain.bundle.entries.map(entry => entry.sha256)).toEqual(
      exported.bundle.entries.map(entry => entry.sha256),
    );

    // Filtered export respects workspaceIds / sessionIds / missionIds.
    const filtered = await ctx.host.exportOwnedDataSnapshot!({
      sections: ['workspaces', 'sessions', 'missions'],
      workspaceIds: ['ws-nonexistent'],
    });
    expect(filtered.bundle.entries).toEqual([]);

    // Preview restore on fresh empty host leaves external vendor file completely untouched.
    const freshCtx = await createTestHost(root, 'fresh-for-vendor-check');
    const restorePreview = await freshCtx.host.previewOwnedDataRestore!(exported.bundleJson);
    expect(restorePreview.valid).toBe(true);

    const vendorHashAfter = sha256Bytes(await readFile(seeded.vendorFile));
    expect(vendorHashAfter).toBe(seeded.vendorHashBefore);
  });

  it('handles unreadable session message logs gracefully without crashing', async () => {
    const service = createOwnedDataSnapshotService({
      appVersion: '0.4.367-test',
      hostKind: 'bridge',
      now: () => '2026-11-28T12:00:00.000Z',
      getProfile: async () => ({
        schema: 'extalia.profile.v1',
        preferences: {},
        updatedAt: new Date(0).toISOString(),
      }),
      getHostSettings: () => ({
        workflow: 'managed',
        setupComplete: false,
        profile: { id: 'default', name: 'Personal' },
        connections: [],
        workspaces: [],
      }),
      listOperatingProfiles: () => [],
      listSessions: async () => [{
        id: 's_unreadable1',
        workspaceId: null,
        connectionId: 'conn_1',
        title: 'Corrupt log session',
        createdAt: '2026-11-28T10:00:00.000Z',
        lastActiveAt: '2026-11-28T10:00:00.000Z',
      }],
      readSessionMessages: async () => {
        throw new Error('EACCES: unreadable message log');
      },
      listMissions: () => [],
      listSchedules: async () => ({ revision: 'rev-1', schedules: [] }),
    });

    const preview = await service.previewExport({ sections: ['sessions'] });
    expect(preview.totalEntries).toBe(1);
    expect(preview.warnings).toContain('Session "s_unreadable1" message log was unreadable and omitted from the snapshot.');

    const exported = await service.exportSnapshot({ sections: ['sessions'] });
    expect(exported.bundle.entries[0]?.payload.messages).toEqual([]);
  });

  it('AR-28: rejects corrupt, tampered, unsupported schema, secret-injected, oversized, colliding, and missing-dependency archives while succeeding cleanly on a fresh host without touching disk', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'extalia-snapshot-ar28-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));

    const sourceCtx = await createTestHost(root, 'source', true);
    await seedOwnedHostState(sourceCtx);

    const exported = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['settings', 'workspaces', 'operatingProfiles', 'sessions', 'missions', 'schedules'],
    });

    // 1. Clean non-colliding dry-run restore preview against a fresh empty host.
    const freshCtx = await createTestHost(root, 'fresh');
    const dataHashesBefore = await snapshotDirectoryHashes(freshCtx.dataDirectory);

    const cleanPreview = await freshCtx.host.previewOwnedDataRestore!(exported.bundleJson);
    expect(cleanPreview.valid).toBe(true);
    expect(cleanPreview.dryRunOnly).toBe(true);
    expect(cleanPreview.schemaVersion).toBe(OWNED_DATA_SNAPSHOT_SCHEMA_VERSION);
    expect(cleanPreview.checksumVerified).toBe(true);
    expect(cleanPreview.secretFreeVerified).toBe(true);
    expect(cleanPreview.wouldAdd).toBe(6);
    expect(cleanPreview.wouldCollide).toBe(0);
    expect(cleanPreview.conflicts).toEqual([]);
    expect(cleanPreview.sectionCounts).toEqual({
      settings: 1,
      workspaces: 1,
      operatingProfiles: 1,
      sessions: 1,
      missions: 1,
      schedules: 1,
    });

    // 2. Corrupt JSON.
    const corruptPreview = await freshCtx.host.previewOwnedDataRestore!('{not-valid-json');
    expect(corruptPreview.valid).toBe(false);
    expect(corruptPreview.dryRunOnly).toBe(true);
    expect(corruptPreview.conflicts[0]?.kind).toBe('corrupt-archive');

    // 3. Tampered entry checksum.
    const tamperedBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    const wsEntry = tamperedBundle.entries.find(entry => entry.section === 'workspaces')!;
    wsEntry.payload.name = 'Tampered Name';
    const tamperedPreview = await freshCtx.host.previewOwnedDataRestore!(JSON.stringify(tamperedBundle));
    expect(tamperedPreview.valid).toBe(false);
    expect(tamperedPreview.checksumVerified).toBe(false);
    expect(tamperedPreview.conflicts.some(conflict => conflict.kind === 'checksum-mismatch')).toBe(true);

    // 4. Unsupported future schemaVersion.
    const futureBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    (futureBundle.manifest as { schemaVersion: number }).schemaVersion = 99;
    const futurePreview = await freshCtx.host.previewOwnedDataRestore!(JSON.stringify(futureBundle));
    expect(futurePreview.valid).toBe(false);
    expect(futurePreview.schemaVersion).toBe(99);
    expect(futurePreview.conflicts[0]?.kind).toBe('schema-mismatch');

    // 5. Secret canary injected into archive.
    const secretBundle = JSON.parse(exported.bundleJson) as OwnedDataSnapshotBundle;
    secretBundle.entries[0]!.payload.leakedNote = INJECTED_ARCHIVE_SECRET;
    const secretPreview = await freshCtx.host.previewOwnedDataRestore!(resignBundle(secretBundle));
    expect(secretPreview.valid).toBe(false);
    expect(secretPreview.secretFreeVerified).toBe(false);
    expect(secretPreview.conflicts[0]?.kind).toBe('secret-detected');

    // 6. Oversized archive (> MAX_SNAPSHOT_BYTES).
    const oversized = 'x'.repeat(MAX_SNAPSHOT_BYTES + 128);
    const oversizedPreview = await freshCtx.host.previewOwnedDataRestore!(oversized);
    expect(oversizedPreview.valid).toBe(false);
    expect(oversizedPreview.dryRunOnly).toBe(true);
    expect(oversizedPreview.conflicts[0]?.kind).toBe('corrupt-archive');
    expect(oversizedPreview.conflicts[0]?.detail).toContain(String(MAX_SNAPSHOT_BYTES));

    // 7. ID collisions against live host store.
    const collisionPreview = await sourceCtx.host.previewOwnedDataRestore!(exported.bundleJson);
    expect(collisionPreview.valid).toBe(false);
    expect(collisionPreview.wouldCollide).toBe(6);
    expect(collisionPreview.wouldAdd).toBe(0);
    expect(collisionPreview.warnings.some(warning => /profile preferences already exist/i.test(warning))).toBe(true);
    const collisionSections = collisionPreview.conflicts
      .filter(conflict => conflict.kind === 'id-collision')
      .map(conflict => conflict.section);
    expect(collisionSections).toEqual(expect.arrayContaining([
      'workspaces',
      'operatingProfiles',
      'sessions',
      'missions',
      'schedules',
    ]));

    // 8. Missing dependency when sessions/missions/schedules reference an absent workspaceId.
    const partialExport = await sourceCtx.host.exportOwnedDataSnapshot!({
      sections: ['sessions', 'missions', 'schedules'],
    });
    expect(partialExport.bundle.manifest.format).toBe(OWNED_DATA_SNAPSHOT_FORMAT);
    const missingDepPreview = await freshCtx.host.previewOwnedDataRestore!(partialExport.bundleJson);
    expect(missingDepPreview.valid).toBe(false);
    const missingDeps = missingDepPreview.conflicts.filter(conflict => conflict.kind === 'missing-dependency');
    expect(missingDeps).toHaveLength(3);
    expect(missingDeps.map(item => item.section).sort()).toEqual(['missions', 'schedules', 'sessions']);

    // Verify fresh host dataDirectory files & hashes remained completely untouched after all dry-run previews.
    const dataHashesAfter = await snapshotDirectoryHashes(freshCtx.dataDirectory);
    expect([...dataHashesAfter.entries()]).toEqual([...dataHashesBefore.entries()]);
  });
});
