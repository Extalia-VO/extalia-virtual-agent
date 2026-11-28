import type * as React from 'react';
import {
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  OWNED_DATA_SNAPSHOT_SECTIONS,
  canonicalSnapshotJson,
  normalizeOwnedDataSnapshotSelection,
  sha256Utf8Hex,
  snapshotManifestDigestInput,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotEntry,
} from '@extalia/core';
import type {
  AgentHostApi,
  OwnedDataBackupSummary,
  OwnedDataRestoreApplyResult,
  OwnedDataRestorePreview,
  OwnedDataSnapshotExportPreview,
  OwnedDataSnapshotExportResult,
  RollbackOwnedDataRestoreResult,
} from '@extalia/platform';
import { createElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMockPlatform } from '../src/host/mockHost';
import { MESSAGES } from '../src/i18n';
import { SettingsPage } from '../src/pages/SettingsPage';
import { OwnedSnapshotCard, OwnedSnapshotView } from '../src/pages/settings/OwnedSnapshotCard';
import { DEFAULT_PREFERENCES } from '../src/preferences';
import { MessagesContext } from '../src/ui/messages';

const hooks = vi.hoisted(() => ({
  enabled: false,
  index: 0,
  values: [] as unknown[],
  pending: [] as (() => void)[],
}));

vi.mock('react', async original => {
  const actual = await original<typeof React>();
  return {
    ...actual,
    useId: () => {
      if (!hooks.enabled) return actual.useId();
      hooks.index++;
      return 'owned-snapshot-test';
    },
    useRef: (initial: unknown) => {
      if (!hooks.enabled) return actual.useRef(initial);
      const index = hooks.index++;
      return hooks.values[index] ??= { current: initial };
    },
    useState: (initial: unknown) => {
      if (!hooks.enabled) return actual.useState(initial);
      const index = hooks.index++;
      if (!(index in hooks.values)) {
        hooks.values[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      }
      return [
        hooks.values[index],
        (next: unknown) => {
          hooks.values[index] = typeof next === 'function'
            ? (next as (current: unknown) => unknown)(hooks.values[index])
            : next;
        },
      ];
    },
    useEffect: (effect: () => void | (() => void), deps?: unknown[]) => {
      if (!hooks.enabled) return actual.useEffect(effect, deps);
      const index = hooks.index++;
      const slot = hooks.values[index] as { deps?: unknown[]; cleanup?: () => void } | undefined;
      const unchanged = slot?.deps && deps && slot.deps.length === deps.length
        && slot.deps.every((value, at) => Object.is(value, deps[at]));
      if (unchanged) return;
      hooks.pending.push(() => {
        slot?.cleanup?.();
        const cleanup = effect();
        hooks.values[index] = { deps, cleanup: cleanup || undefined };
      });
    },
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}

function textContent(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textContent).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textContent(node.props.children);
  return '';
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

function buildCleanBundleJson(entriesInput: Array<Pick<OwnedDataSnapshotEntry, 'section' | 'id' | 'payload'>>): string {
  const sections = [...new Set(entriesInput.map(item => item.section))];
  const selection = normalizeOwnedDataSnapshotSelection({ sections });
  const entries: OwnedDataSnapshotEntry[] = entriesInput.map(item => ({
    section: item.section,
    id: item.id,
    payload: item.payload,
    sha256: sha256Utf8Hex(canonicalSnapshotJson(item.payload)),
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
        appVersion: '0.4.367',
        exportedAt: '2026-11-28T14:00:00.000Z',
        format: OWNED_DATA_SNAPSHOT_FORMAT,
        schemaVersion: OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
        hostKind: 'desktop',
      },
      entryCount: entries.length,
      manifestSha256: sha256Utf8Hex(snapshotManifestDigestInput(manifestHeader, entries)),
      secretCanaryChecked: true,
    },
    entries,
  };
  return JSON.stringify(bundle, null, 2);
}

beforeEach(() => {
  hooks.enabled = false;
  hooks.index = 0;
  hooks.values = [];
  hooks.pending = [];
});

afterEach(() => {
  hooks.enabled = false;
});

describe('Owned-Data Snapshot Settings UI & Mock Host', () => {
  it('renders EN and ID copy symmetrically including all 6 sections, export summary, and restore conflict kinds', () => {
    const sampleExportPreview: OwnedDataSnapshotExportPreview = {
      selection: { sections: [...OWNED_DATA_SNAPSHOT_SECTIONS] },
      totalEntries: 7,
      sectionCounts: { settings: 1, workspaces: 2, sessions: 2, schedules: 2 },
      estimatedBytes: 4096,
      excludesSecrets: true,
      excludesVendorSources: true,
      warnings: [],
    };
    const sampleExportResult: OwnedDataSnapshotExportResult = {
      bundle: JSON.parse(buildCleanBundleJson([{ section: 'settings', id: 'profile', payload: { theme: 'dark' } }])) as OwnedDataSnapshotBundle,
      bundleJson: '{}',
      sha256: 'a'.repeat(64),
      byteLength: 512,
      omittedSecretFields: 2,
    };
    const sampleRestorePreview: OwnedDataRestorePreview = {
      valid: false,
      dryRunOnly: true,
      schemaVersion: 1,
      entryCount: 3,
      sectionCounts: { workspaces: 1, schedules: 2 },
      wouldAdd: 1,
      wouldCollide: 1,
      checksumVerified: false,
      secretFreeVerified: false,
      conflicts: [
        { kind: 'id-collision', section: 'workspaces', id: 'ws-1', detail: 'Already exists' },
        { kind: 'checksum-mismatch', section: 'schedules', id: 'sch-1', detail: 'Digest mismatch' },
        { kind: 'secret-detected', detail: 'Secret field detected' },
        { kind: 'missing-dependency', section: 'schedules', id: 'sch-2', detail: 'Missing ws-missing' },
      ],
      warnings: [],
    };

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const m = t.ownedSnapshot;
      const html = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(OwnedSnapshotView, {
            t,
            sections: [...OWNED_DATA_SNAPSHOT_SECTIONS],
            exportPreview: sampleExportPreview,
            exportResult: sampleExportResult,
            archiveText: '{}',
            restorePreview: sampleRestorePreview,
          }),
        ),
      );
      const plain = html.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");

      expect(plain).toContain(m.title);
      expect(plain).toContain(m.lead);
      expect(plain).toContain(m.notice);
      for (const section of OWNED_DATA_SNAPSHOT_SECTIONS) {
        expect(plain).toContain(m.sections[section]);
      }
      expect(plain).toContain(m.export.totalEntries(7));
      expect(plain).toContain(m.export.excludesNote);
      expect(plain).toContain(sampleExportResult.sha256);
      expect(plain).toContain(m.export.downloadButton);
      expect(plain).toContain(m.restore.dryRunNotice);
      expect(plain).toContain(m.restore.fileLabel);
      expect(plain).toContain(m.restore.blockedBadge);
      expect(plain).toContain(m.restore.checksumFailed);
      expect(plain).toContain(m.restore.secretDetected);
      expect(plain).toContain(m.restore.conflictHeaders.kind);
      expect(plain).toContain(m.restore.conflictHeaders.detail);
      expect(plain).toContain(m.restore.conflictKinds['id-collision']);
      expect(plain).toContain(m.restore.conflictKinds['checksum-mismatch']);
      expect(plain).toContain(m.restore.conflictKinds['secret-detected']);
      expect(plain).toContain(m.restore.conflictKinds['missing-dependency']);
    }
  });

  it('renders EN and ID apply restore controls, receipt/error notices, and pre-restore backups/rollback UI symmetrically', () => {
    const eligiblePreview: OwnedDataRestorePreview = {
      valid: true,
      dryRunOnly: true,
      schemaVersion: 1,
      entryCount: 2,
      sectionCounts: { workspaces: 1, schedules: 1 },
      wouldAdd: 2,
      wouldCollide: 0,
      checksumVerified: true,
      secretFreeVerified: true,
      conflicts: [],
      warnings: [],
    };
    const sampleReceipt: OwnedDataRestoreApplyResult = {
      ok: true,
      backupId: 'bk-0123456789ab',
      bundleSha256: 'b'.repeat(64),
      appliedCount: 2,
      skippedCount: 1,
      appliedBySection: { workspaces: 1, schedules: 1 },
      skippedIds: ['ws-existing'],
      vendorSourcesUntouched: true,
      warnings: ['Skipped 1 colliding record(s).'],
    };
    const sampleRolledBackFailure: OwnedDataRestoreApplyResult = {
      ok: false,
      code: 'write-failed-rolled-back',
      backupId: 'bk-fedcba987654',
      rolledBack: true,
      conflicts: [],
      detail: 'Simulated disk error during apply.',
    };
    const sampleBackups: OwnedDataBackupSummary[] = [
      {
        backupId: 'bk-0123456789ab',
        createdAt: '2026-11-28T15:00:00.000Z',
        reason: 'pre-restore',
        sourceBundleSha256: 'c'.repeat(64),
        fileCount: 7,
      },
    ];
    const sampleRollbackSuccess: RollbackOwnedDataRestoreResult = {
      ok: true,
      backupId: 'bk-0123456789ab',
      restoredFiles: 7,
      removedFiles: 2,
      detail: 'Restored 7 checkpoint record(s) and removed 2 post-restore record(s).',
    };

    for (const language of ['en', 'id'] as const) {
      const t = MESSAGES[language];
      const m = t.ownedSnapshot;

      const htmlWithReceipt = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(OwnedSnapshotView, {
            t,
            sections: [...OWNED_DATA_SNAPSHOT_SECTIONS],
            exportPreview: null,
            exportResult: null,
            archiveText: '{}',
            restorePreview: eligiblePreview,
            canApplyRestore: true,
            conflictPolicy: 'skip-existing',
            confirmBackup: true,
            applyResult: sampleReceipt,
            backupsSupported: true,
            rollbackSupported: true,
            backups: sampleBackups,
            confirmingRollbackId: 'bk-0123456789ab',
            rollbackResult: sampleRollbackSuccess,
          }),
        ),
      );
      const plain = htmlWithReceipt.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
      expect(plain).toContain(m.restore.policyLabel);
      expect(plain).toContain(m.restore.policies['fail-on-collision']);
      expect(plain).toContain(m.restore.policies['skip-existing']);
      expect(plain).toContain(m.restore.confirmBackupLabel);
      expect(plain).toContain(m.restore.applyButton);
      expect(plain).toContain(m.restore.applyReceiptHeading);
      expect(plain).toContain('bk-0123456789ab');
      expect(plain).toContain('Skipped 1 colliding record(s).');
      expect(plain).toContain(m.backups.heading);
      expect(plain).toContain(m.backups.confirmPrompt);
      expect(plain).toContain(m.backups.confirmRollbackButton);
      expect(plain).toContain(m.backups.cancelRollbackButton);
      expect(plain).toContain(m.backups.rollbackSuccess('bk-0123456789ab', 7, 2));
      expect(plain).toContain('c'.repeat(64));

      const htmlWithErrorAndEmpty = renderToStaticMarkup(
        createElement(
          MessagesContext.Provider,
          { value: t },
          createElement(OwnedSnapshotView, {
            t,
            sections: [...OWNED_DATA_SNAPSHOT_SECTIONS],
            exportPreview: null,
            exportResult: null,
            archiveText: '{}',
            restorePreview: eligiblePreview,
            canApplyRestore: true,
            applyResult: sampleRolledBackFailure,
            backupsSupported: true,
            rollbackSupported: true,
            backups: [],
          }),
        ),
      );
      const plainError = htmlWithErrorAndEmpty.replace(/&amp;/g, '&').replace(/&#x27;/g, "'");
      expect(plainError).toContain(m.restore.applyFailedHeading);
      expect(plainError).toContain(m.restore.errorCodes['write-failed-rolled-back']!);
      expect(plainError).toContain(m.restore.rolledBackNotice);
      expect(plainError).toContain(m.backups.empty);
    }
  });

  it('enforces mockHost AR-28 preflight refusals, clean apply, skip-existing, and backup rollback', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop' });
    const agents = platform.capabilities.agents!;
    const initialState = await agents.getState();
    const initialSchedules = await agents.listSchedules!();
    const initialProfiles = await agents.listOperatingProfiles!();

    const cleanBundleJson = buildCleanBundleJson([
      {
        section: 'workspaces',
        id: 'ws-restored-1',
        payload: { id: 'ws-restored-1', name: 'Restored Workspace' },
      },
      {
        section: 'operatingProfiles',
        id: 'op-restored-1',
        payload: {
          id: 'op-restored-1',
          name: 'Restored Operator',
          revision: 1,
          defaults: { effort: 'high' },
        },
      },
      {
        section: 'sessions',
        id: 'sess-restored-1',
        payload: { id: 'sess-restored-1', workspaceId: 'ws-restored-1', title: 'Restored Session' },
      },
      {
        section: 'schedules',
        id: 'sch-restored-1',
        payload: { id: 'sch-restored-1', workspaceId: 'ws-restored-1', name: 'Restored Schedule' },
      },
    ]);
    const cleanSha = sha256Utf8Hex(cleanBundleJson);

    // 1. Refuses without confirmation
    const unconfirmed = await agents.applyOwnedDataRestore!({
      bundleJson: cleanBundleJson,
      expectedBundleSha256: cleanSha,
      conflictPolicy: 'fail-on-collision',
      confirmBackup: false,
    });
    expect(unconfirmed.ok).toBe(false);
    if (!unconfirmed.ok) {
      expect(unconfirmed.code).toBe('confirmation-required');
      expect(unconfirmed.rolledBack).toBe(false);
    }

    // 2. Refuses on digest mismatch
    const digestMismatch = await agents.applyOwnedDataRestore!({
      bundleJson: cleanBundleJson,
      expectedBundleSha256: '0'.repeat(64),
      conflictPolicy: 'fail-on-collision',
      confirmBackup: true,
    });
    expect(digestMismatch.ok).toBe(false);
    if (!digestMismatch.ok) {
      expect(digestMismatch.code).toBe('digest-mismatch');
    }

    // 3. Refuses on id-collision when policy is fail-on-collision
    const existingWsId = initialState.workspaces[0]!.id;
    const collidingBundleJson = buildCleanBundleJson([
      { section: 'workspaces', id: existingWsId, payload: { id: existingWsId, name: 'Duplicate Workspace' } },
      { section: 'workspaces', id: 'ws-new-from-skip', payload: { id: 'ws-new-from-skip', name: 'Added Via Skip' } },
    ]);
    const collidingSha = sha256Utf8Hex(collidingBundleJson);

    const collisionRefusal = await agents.applyOwnedDataRestore!({
      bundleJson: collidingBundleJson,
      expectedBundleSha256: collidingSha,
      conflictPolicy: 'fail-on-collision',
      confirmBackup: true,
    });
    expect(collisionRefusal.ok).toBe(false);
    if (!collisionRefusal.ok) {
      expect(collisionRefusal.code).toBe('id-collision');
      expect(collisionRefusal.conflicts.some(c => c.kind === 'id-collision' && c.id === existingWsId)).toBe(true);
    }
    expect(await agents.listOwnedDataBackups!()).toEqual([]);

    // 4. Clean apply creates pre-restore backup and mutates workspaces, operatingProfiles, sessions, schedules
    const applied = await agents.applyOwnedDataRestore!({
      bundleJson: cleanBundleJson,
      expectedBundleSha256: cleanSha,
      conflictPolicy: 'fail-on-collision',
      confirmBackup: true,
    });
    expect(applied.ok).toBe(true);
    if (!applied.ok) throw new Error('Expected clean apply to succeed');
    expect(applied.backupId).toMatch(/^bk-[0-9a-f]{12}$/);
    expect(applied.appliedCount).toBe(4);
    expect(applied.skippedCount).toBe(0);
    expect(applied.vendorSourcesUntouched).toBe(true);

    const stateAfterApply = await agents.getState();
    expect(stateAfterApply.workspaces.some(w => w.id === 'ws-restored-1')).toBe(true);
    expect(stateAfterApply.sessions.some(s => s.id === 'sess-restored-1')).toBe(true);
    expect((await agents.listOperatingProfiles!()).some(p => p.id === 'op-restored-1')).toBe(true);
    expect((await agents.listSchedules!()).schedules.some(s => s.id === 'sch-restored-1')).toBe(true);

    const backupsAfterClean = await agents.listOwnedDataBackups!();
    expect(backupsAfterClean).toHaveLength(1);
    expect(backupsAfterClean[0]?.backupId).toBe(applied.backupId);
    expect(backupsAfterClean[0]?.sourceBundleSha256).toBe(cleanSha);

    // 5. skip-existing skips colliding IDs and applies new IDs
    const skippedApply = await agents.applyOwnedDataRestore!({
      bundleJson: collidingBundleJson,
      expectedBundleSha256: collidingSha,
      conflictPolicy: 'skip-existing',
      confirmBackup: true,
    });
    expect(skippedApply.ok).toBe(true);
    if (!skippedApply.ok) throw new Error('Expected skip-existing apply to succeed');
    expect(skippedApply.appliedCount).toBe(1);
    expect(skippedApply.skippedCount).toBe(1);
    expect(skippedApply.skippedIds).toEqual([existingWsId]);
    expect((await agents.getState()).workspaces.some(w => w.id === 'ws-new-from-skip')).toBe(true);
    expect(await agents.listOwnedDataBackups!()).toHaveLength(2);

    // 6. Unknown backupId returns ok: false
    const missingRollback = await agents.rollbackOwnedDataRestore!('bk-ffffffffffff');
    expect(missingRollback.ok).toBe(false);

    // 7. Rollback to first pre-restore backup restores initial state cleanly
    const rolledBack = await agents.rollbackOwnedDataRestore!(applied.backupId);
    expect(rolledBack.ok).toBe(true);
    if (rolledBack.ok) {
      expect(rolledBack.backupId).toBe(applied.backupId);
      expect(rolledBack.removedFiles).toBeGreaterThanOrEqual(4);
    }

    const stateAfterRollback = await agents.getState();
    expect(stateAfterRollback.workspaces).toEqual(initialState.workspaces);
    expect(stateAfterRollback.sessions).toEqual(initialState.sessions);
    expect((await agents.listOperatingProfiles!())).toEqual(initialProfiles);
    expect((await agents.listSchedules!()).schedules).toEqual(initialSchedules.schedules);
  });

  it('supports mockHost export preview, export, and strictly read-only dry-run restore preview', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop' });
    const agents = platform.capabilities.agents!;
    const initialState = await agents.getState();

    const preview = await agents.previewOwnedDataExport!({ sections: ['settings', 'workspaces', 'schedules'] });
    expect(preview.totalEntries).toBeGreaterThanOrEqual(4);
    expect(preview.excludesSecrets).toBe(true);
    expect(preview.excludesVendorSources).toBe(true);
    expect(preview.estimatedBytes).toBeGreaterThan(0);

    const exported = await agents.exportOwnedDataSnapshot!({ sections: ['settings', 'workspaces', 'schedules'] });
    expect(exported.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(exported.byteLength).toBeGreaterThan(0);
    expect(exported.bundle.manifest.format).toBe(OWNED_DATA_SNAPSHOT_FORMAT);

    // Clean archive with fresh IDs passes
    const cleanJson = buildCleanBundleJson([
      { section: 'workspaces', id: 'ws-brand-new', payload: { id: 'ws-brand-new', name: 'Fresh App' } },
      { section: 'schedules', id: 'sch-brand-new', payload: { id: 'sch-brand-new', workspaceId: 'ws-brand-new', name: 'Check' } },
    ]);
    const cleanPreview = await agents.previewOwnedDataRestore!(cleanJson);
    expect(cleanPreview.valid).toBe(true);
    expect(cleanPreview.dryRunOnly).toBe(true);
    expect(cleanPreview.wouldAdd).toBe(2);
    expect(cleanPreview.wouldCollide).toBe(0);
    expect(cleanPreview.checksumVerified).toBe(true);
    expect(cleanPreview.secretFreeVerified).toBe(true);
    expect(cleanPreview.conflicts).toEqual([]);

    // Exporting existing workspaces + schedules and previewing restore reports id-collision without mutating state
    const collisionPreview = await agents.previewOwnedDataRestore!(exported.bundleJson);
    expect(collisionPreview.valid).toBe(false);
    expect(collisionPreview.dryRunOnly).toBe(true);
    expect(collisionPreview.wouldCollide).toBeGreaterThan(0);
    expect(collisionPreview.conflicts.some(item => item.kind === 'id-collision')).toBe(true);

    // Missing workspace dependency check
    const missingDepJson = buildCleanBundleJson([
      { section: 'schedules', id: 'sch-orphan', payload: { id: 'sch-orphan', workspaceId: 'ws-does-not-exist', name: 'Orphan' } },
    ]);
    const missingDepPreview = await agents.previewOwnedDataRestore!(missingDepJson);
    expect(missingDepPreview.valid).toBe(false);
    expect(missingDepPreview.conflicts.some(item => item.kind === 'missing-dependency' && item.id === 'sch-orphan')).toBe(true);

    // Tampered payload & secret detection
    const tampered = JSON.parse(cleanJson) as OwnedDataSnapshotBundle;
    tampered.entries[0]!.payload = { id: 'ws-brand-new', name: 'Tampered' };
    const tamperedPreview = await agents.previewOwnedDataRestore!(JSON.stringify(tampered));
    expect(tamperedPreview.valid).toBe(false);
    expect(tamperedPreview.checksumVerified).toBe(false);
    expect(tamperedPreview.conflicts.some(item => item.kind === 'checksum-mismatch')).toBe(true);

    const withSecret = JSON.parse(cleanJson) as OwnedDataSnapshotBundle;
    withSecret.entries[0]!.payload = { id: 'ws-brand-new', apiKey: 'demo-secret-canary' };
    const secretPreview = await agents.previewOwnedDataRestore!(JSON.stringify(withSecret));
    expect(secretPreview.valid).toBe(false);
    expect(secretPreview.secretFreeVerified).toBe(false);
    expect(secretPreview.conflicts[0]?.kind).toBe('secret-detected');

    // State remains completely unchanged after all dry-run checks
    expect(await agents.getState()).toEqual(initialState);
  });

  it('drives OwnedSnapshotCard section toggles, export, and clean vs blocked restore preview', async () => {
    hooks.enabled = true;
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop' });
    const agents = platform.capabilities.agents!;
    let pendingOp: Promise<unknown> = Promise.resolve();
    const track = <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) =>
      vi.fn((...args: Args) => {
        const promise = fn(...args);
        pendingOp = promise;
        return promise;
      });
    const previewSpy = track(agents.previewOwnedDataExport!.bind(agents));
    const exportSpy = track(agents.exportOwnedDataSnapshot!.bind(agents));
    const restoreSpy = track(agents.previewOwnedDataRestore!.bind(agents));
    agents.previewOwnedDataExport = previewSpy;
    agents.exportOwnedDataSnapshot = exportSpy;
    agents.previewOwnedDataRestore = restoreSpy;
    const t = MESSAGES.en;

    const draw = () => {
      hooks.index = 0;
      const viewEl = OwnedSnapshotCard({ t, agents }) as ReactElement<Parameters<typeof OwnedSnapshotView>[0]>;
      const rendered = OwnedSnapshotView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };

    const waitOp = async () => {
      await flushMicrotasks();
      await pendingOp;
      await flushMicrotasks();
    };

    draw();
    await waitOp();
    let tree = draw();

    expect(previewSpy).toHaveBeenCalledWith({ sections: [...OWNED_DATA_SNAPSHOT_SECTIONS] });
    expect(textContent(tree)).toContain(t.ownedSnapshot.export.excludesNote);

    // Toggle off 'workspaces' checkbox -> updates preview summary
    const checkboxes = elements(tree).filter(el => el.type === 'input' && el.props.type === 'checkbox');
    expect(checkboxes).toHaveLength(6);
    const workspacesIndex = OWNED_DATA_SNAPSHOT_SECTIONS.indexOf('workspaces');
    (checkboxes[workspacesIndex]!.props.onChange as () => void)();
    draw();
    await waitOp();
    tree = draw();

    expect(previewSpy).toHaveBeenLastCalledWith({
      sections: OWNED_DATA_SNAPSHOT_SECTIONS.filter(item => item !== 'workspaces'),
    });

    // Click Export -> displays SHA-256, byte size, omitted secrets, and Download JSON button
    const exportBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.export.button))!;
    (exportBtn.props.onClick as () => void)();
    await waitOp();
    tree = draw();
    const exportedText = textContent(tree);
    expect(exportedText).toContain(t.ownedSnapshot.export.resultHeading);
    expect(exportedText).toContain(t.ownedSnapshot.export.digestLabel);
    expect(exportedText).toContain(t.ownedSnapshot.export.downloadButton);
    expect(exportedText).toMatch(/[0-9a-f]{64}/);

    // Paste clean archive -> Valid badge & no conflicts
    const cleanArchive = buildCleanBundleJson([
      { section: 'workspaces', id: 'ws-clean-ui', payload: { id: 'ws-clean-ui', name: 'Clean UI Workspace' } },
    ]);
    const textarea = elements(tree).find(el => el.type === 'textarea')!;
    (textarea.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: cleanArchive } });
    tree = draw();

    const previewRestoreBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.restore.previewButton))!;
    (previewRestoreBtn.props.onClick as () => void)();
    await waitOp();
    tree = draw();
    expect(textContent(tree)).toContain(t.ownedSnapshot.restore.validBadge);
    expect(textContent(tree)).toContain(t.ownedSnapshot.restore.noConflicts);

    // Paste tampered archive -> Blocked badge & conflict row
    const tampered = JSON.parse(cleanArchive) as OwnedDataSnapshotBundle;
    tampered.entries[0]!.payload = { id: 'ws-clean-ui', name: 'Tampered' };
    const textareaAfter = elements(tree).find(el => el.type === 'textarea')!;
    (textareaAfter.props.onChange as (event: { target: { value: string } }) => void)({
      target: { value: JSON.stringify(tampered) },
    });
    tree = draw();
    const previewRestoreBtn2 = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.restore.previewButton))!;
    (previewRestoreBtn2.props.onClick as () => void)();
    await waitOp();
    tree = draw();
    const blockedText = textContent(tree);
    expect(blockedText).toContain(t.ownedSnapshot.restore.blockedBadge);
    expect(blockedText).toContain(t.ownedSnapshot.restore.conflictKinds['checksum-mismatch']);
    expect(blockedText).toContain('ws-clean-ui');
  });

  it('drives interactive confirm-checkbox gating, collision policy switch, apply receipt, backup refresh, and confirmed rollback', async () => {
    hooks.enabled = true;
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop' });
    const agents = platform.capabilities.agents!;
    const initialState = await agents.getState();
    const existingWsId = initialState.workspaces[0]!.id;

    let pendingOp: Promise<unknown> = Promise.resolve();
    const track = <Args extends unknown[], R>(fn: (...args: Args) => Promise<R>) =>
      vi.fn((...args: Args) => {
        const promise = fn(...args);
        pendingOp = promise;
        return promise;
      });
    const previewSpy = track(agents.previewOwnedDataExport!.bind(agents));
    const restorePreviewSpy = track(agents.previewOwnedDataRestore!.bind(agents));
    const applySpy = track(agents.applyOwnedDataRestore!.bind(agents));
    const listBackupsSpy = track(agents.listOwnedDataBackups!.bind(agents));
    const rollbackSpy = track(agents.rollbackOwnedDataRestore!.bind(agents));
    agents.previewOwnedDataExport = previewSpy;
    agents.previewOwnedDataRestore = restorePreviewSpy;
    agents.applyOwnedDataRestore = applySpy;
    agents.listOwnedDataBackups = listBackupsSpy;
    agents.rollbackOwnedDataRestore = rollbackSpy;

    const t = MESSAGES.en;
    const draw = () => {
      hooks.index = 0;
      const viewEl = OwnedSnapshotCard({ t, agents }) as ReactElement<Parameters<typeof OwnedSnapshotView>[0]>;
      const rendered = OwnedSnapshotView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };
    const waitOp = async () => {
      await flushMicrotasks();
      await pendingOp;
      await flushMicrotasks();
    };

    draw();
    await waitOp();
    let tree = draw();
    expect(listBackupsSpy).toHaveBeenCalled();
    expect(textContent(tree)).toContain(t.ownedSnapshot.backups.empty);

    // Paste colliding archive with 1 existing + 1 new workspace
    const collidingArchive = buildCleanBundleJson([
      { section: 'workspaces', id: existingWsId, payload: { id: existingWsId, name: 'Existing' } },
      { section: 'workspaces', id: 'ws-ui-added', payload: { id: 'ws-ui-added', name: 'Added From UI' } },
    ]);
    const textarea = elements(tree).find(el => el.type === 'textarea')!;
    (textarea.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: collidingArchive } });
    tree = draw();

    const previewBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.restore.previewButton))!;
    (previewBtn.props.onClick as () => void)();
    await waitOp();
    tree = draw();

    // Apply button is initially disabled (collision under fail-on-collision + unchecked confirmBackup)
    const findApplyBtn = (node: ReactNode) =>
      elements(node).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.restore.applyButton))!;
    expect(findApplyBtn(tree).props.disabled).toBe(true);
    expect(textContent(tree)).toContain(t.ownedSnapshot.restore.collisionBlockedHint);

    // Switch conflict policy to skip-existing -> still disabled until confirmBackup is checked
    const policySelect = elements(tree).find(el => el.type === 'select')!;
    (policySelect.props.onChange as (event: { target: { value: string } }) => void)({ target: { value: 'skip-existing' } });
    tree = draw();
    expect(findApplyBtn(tree).props.disabled).toBe(true);

    // Check confirmBackup -> Apply button becomes enabled
    const allCheckboxes = elements(tree).filter(el => el.type === 'input' && el.props.type === 'checkbox');
    const confirmCheckbox = allCheckboxes.at(-1)!;
    (confirmCheckbox.props.onChange as (event: { target: { checked: boolean } }) => void)({ target: { checked: true } });
    tree = draw();
    expect(findApplyBtn(tree).props.disabled).toBe(false);

    // Click Apply restore -> shows receipt & refreshes backups
    (findApplyBtn(tree).props.onClick as () => void)();
    await waitOp();
    await waitOp();
    tree = draw();

    expect(applySpy).toHaveBeenCalledWith({
      bundleJson: collidingArchive,
      expectedBundleSha256: sha256Utf8Hex(collidingArchive),
      conflictPolicy: 'skip-existing',
      confirmBackup: true,
    });
    const afterApplyText = textContent(tree);
    expect(afterApplyText).toContain(t.ownedSnapshot.restore.applyReceiptHeading);
    expect(afterApplyText).toMatch(/bk-[0-9a-f]{12}/);
    expect((await agents.getState()).workspaces.some(w => w.id === 'ws-ui-added')).toBe(true);

    // Click Rollback -> opens inline Confirm/Cancel prompt -> Confirm rollback -> restores state
    const rollbackBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.backups.rollbackButton))!;
    (rollbackBtn.props.onClick as () => void)();
    tree = draw();
    expect(textContent(tree)).toContain(t.ownedSnapshot.backups.confirmPrompt);

    const confirmRollbackBtn = elements(tree).find(el => el.type === 'button' && textContent(el).includes(t.ownedSnapshot.backups.confirmRollbackButton))!;
    (confirmRollbackBtn.props.onClick as () => void)();
    await waitOp();
    await waitOp();
    tree = draw();

    expect(rollbackSpy).toHaveBeenCalledOnce();
    const afterRollbackText = textContent(tree);
    expect(afterRollbackText).toContain('Rolled back bk-');
    expect((await agents.getState()).workspaces.some(w => w.id === 'ws-ui-added')).toBe(false);
  });

  it('drops stale async preview responses when newer requests supersede them', async () => {
    hooks.enabled = true;
    const platform = createMockPlatform({ seed: 'ready', host: 'desktop' });
    const baseAgents = platform.capabilities.agents!;

    let resolveFirst!: (value: OwnedDataSnapshotExportPreview) => void;
    let resolveSecond!: (value: OwnedDataSnapshotExportPreview) => void;
    let call = 0;

    const agents: AgentHostApi = {
      ...baseAgents,
      previewOwnedDataExport: vi.fn(() => new Promise<OwnedDataSnapshotExportPreview>(resolve => {
        call += 1;
        if (call === 1) resolveFirst = resolve;
        else resolveSecond = resolve;
      })),
    };

    const draw = () => {
      hooks.index = 0;
      const viewEl = OwnedSnapshotCard({ t: MESSAGES.en, agents }) as ReactElement<Parameters<typeof OwnedSnapshotView>[0]>;
      const rendered = OwnedSnapshotView(viewEl.props);
      for (const effect of hooks.pending.splice(0)) effect();
      return rendered;
    };

    let tree = draw();
    const checkboxes = elements(tree).filter(el => el.type === 'input' && el.props.type === 'checkbox');
    (checkboxes[0]!.props.onChange as () => void)();
    draw();

    // Resolve newer request first (totalEntries: 2, estimatedBytes: 222)
    resolveSecond({
      selection: { sections: ['workspaces'] },
      totalEntries: 2,
      sectionCounts: { workspaces: 2 },
      estimatedBytes: 222,
      excludesSecrets: true,
      excludesVendorSources: true,
      warnings: [],
    });
    await flushMicrotasks();
    tree = draw();
    expect(textContent(tree)).toContain('2 entries');

    // Now resolve stale first request (totalEntries: 99, estimatedBytes: 9999) — must be ignored!
    resolveFirst({
      selection: { sections: [...OWNED_DATA_SNAPSHOT_SECTIONS] },
      totalEntries: 99,
      sectionCounts: { settings: 99 },
      estimatedBytes: 9999,
      excludesSecrets: true,
      excludesVendorSources: true,
      warnings: [],
    });
    await flushMicrotasks();
    tree = draw();
    expect(textContent(tree)).toContain('2 entries');
    expect(textContent(tree)).not.toContain('99 entries');
  });

  it('degrades cleanly on legacy hosts without snapshot capabilities', async () => {
    const platform = createMockPlatform({ seed: 'ready', host: 'bridge' });
    const hostState = await platform.capabilities.agents!.getState();
    const legacyAgents = { ...platform.capabilities.agents! };
    delete legacyAgents.previewOwnedDataExport;
    delete legacyAgents.exportOwnedDataSnapshot;
    delete legacyAgents.previewOwnedDataRestore;

    hooks.enabled = true;
    hooks.index = 0;
    expect(OwnedSnapshotCard({ t: MESSAGES.en, agents: legacyAgents })).toBeNull();

    hooks.enabled = false;
    const html = renderToStaticMarkup(
      createElement(
        MessagesContext.Provider,
        { value: MESSAGES.en },
        createElement(SettingsPage, {
          t: MESSAGES.en,
          platform: {
            ...platform,
            capabilities: { ...platform.capabilities, agents: legacyAgents },
          },
          preferences: DEFAULT_PREFERENCES,
          onChange: () => {},
          hostState,
          onHostState: () => {},
          updateStatus: null,
          section: 'storage',
        }),
      ),
    );
    expect(html).not.toContain('settings-owned-snapshots');

    const modernHtml = renderToStaticMarkup(
      createElement(
        MessagesContext.Provider,
        { value: MESSAGES.en },
        createElement(SettingsPage, {
          t: MESSAGES.en,
          platform,
          preferences: DEFAULT_PREFERENCES,
          onChange: () => {},
          hostState,
          onHostState: () => {},
          updateStatus: null,
          section: 'storage',
        }),
      ),
    );
    expect(modernHtml).toContain('settings-owned-snapshots');
  });
});
