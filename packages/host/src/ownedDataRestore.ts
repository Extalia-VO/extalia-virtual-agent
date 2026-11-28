import { createHash, randomBytes } from 'node:crypto';
import { lstat, readdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import {
  normalizeApplyOwnedDataRestoreInput,
  normalizeOwnedDataBackupId,
  verifyOwnedDataSnapshotIntegrity,
  type ApplyOwnedDataRestoreInput,
  type OwnedDataBackupFileEntry,
  type OwnedDataBackupManifest,
  type OwnedDataBackupSummary,
  type OwnedDataRestoreApplyErrorCode,
  type OwnedDataRestoreApplyResult,
  type OwnedDataRestoreConflict,
  type OwnedDataRestoreConflictKind,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotEntry,
  type OwnedDataSnapshotSection,
  type RollbackOwnedDataRestoreResult,
} from '@extalia/core';
import { isNotFound, readJson, writeFileAtomic, writeJsonAtomic } from './jsonStore.js';
import { MAX_SNAPSHOT_BYTES, sha256Hex } from './ownedDataSnapshot.js';
import { ensurePrivateDirectory, PRIVATE_FILE_MODE } from './paths.js';
import { SESSION_ID_PATTERN } from './sessions.js';

const BACKUP_FORMAT = 'extalia.restore-backup.v1' as const;
const EMPTY_SHA256 = sha256Hex('');
const APPLY_SECTION_ORDER: readonly OwnedDataSnapshotSection[] = [
  'operatingProfiles',
  'workspaces',
  'sessions',
  'schedules',
  'settings',
  'missions',
];
const STATIC_TRACKED_RELATIVE_PATHS = [
  'config/profile.json',
  'config/extalia.json',
  'config/config.json',
  'config/operating-profiles.json',
  'config/schedules.json',
  'sessions/index.json',
  'sessions/index.pre-unassigned.json',
  'state/schedules.sqlite',
] as const;
const SQLITE_SIDECAR_RELATIVE_PATHS = [
  'state/schedules.sqlite-wal',
  'state/schedules.sqlite-shm',
] as const;
const FATAL_CONFLICT_PRIORITY: readonly OwnedDataRestoreConflictKind[] = [
  'secret-detected',
  'schema-mismatch',
  'checksum-mismatch',
  'corrupt-archive',
  'missing-dependency',
];

export interface OwnedDataRestoreSettingsOutcome {
  applied: boolean;
  warning?: string;
}

export interface OwnedDataRestoreDependencies {
  appVersion: string;
  dataDirectory: string;
  now?: () => string;
  isBusy: () => boolean;
  previewRestore: (bundleJson: string) => Promise<OwnedDataRestorePreview>;
  /** Optional testing hook invoked before each section is applied. */
  onBeforeSectionApply?: (section: OwnedDataSnapshotSection) => void | Promise<void>;
  /** Prepare/close stores holding file locks (such as SQLite WAL) before reading/overwriting tracked files. */
  prepareForBackup?: () => Promise<void>;
  /** Reopen stores after a successful restore apply. */
  afterApply?: () => Promise<void>;
  restoreOperatingProfile: (payload: Record<string, unknown>) => Promise<void>;
  restoreWorkspace: (payload: Record<string, unknown>) => Promise<void>;
  restoreSession: (payload: Record<string, unknown>) => Promise<void>;
  restoreSchedule: (payload: Record<string, unknown>) => Promise<void>;
  restoreSettings: (payload: Record<string, unknown>) => Promise<OwnedDataRestoreSettingsOutcome>;
  /** Reload host in-memory state (config, operatingProfiles, schedules) after rollback. */
  reloadAfterRollback: () => Promise<void>;
}

export interface OwnedDataRestoreService {
  applyRestore(input: ApplyOwnedDataRestoreInput): Promise<OwnedDataRestoreApplyResult>;
  listBackups(): Promise<OwnedDataBackupSummary[]>;
  rollbackBackup(backupId: string): Promise<RollbackOwnedDataRestoreResult>;
}

function sha256Buffer(data: Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function resolveContainedPath(rootDir: string, relativePath: string): string {
  if (!relativePath || relativePath.includes('\0') || relativePath.includes('\\') || relativePath.startsWith('/')) {
    throw new Error(`Unsafe backup relative path: "${relativePath}".`);
  }
  const segments = relativePath.split('/');
  if (segments.some(segment => !segment || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe backup relative path: "${relativePath}".`);
  }
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(resolvedRoot, ...segments);
  const rootPrefix = resolvedRoot.endsWith(path.sep) ? resolvedRoot : `${resolvedRoot}${path.sep}`;
  if (!resolvedTarget.startsWith(rootPrefix)) {
    throw new Error(`Backup path escapes target root: "${relativePath}".`);
  }
  return resolvedTarget;
}

function pickFatalConflict(conflicts: readonly OwnedDataRestoreConflict[]): OwnedDataRestoreConflict | undefined {
  for (const kind of FATAL_CONFLICT_PRIORITY) {
    const match = conflicts.find(conflict => conflict.kind === kind);
    if (match) return match;
  }
  return undefined;
}

function mapNormalizationErrorCode(rawInput: unknown, error: unknown): OwnedDataRestoreApplyErrorCode {
  if (rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)) {
    const record = rawInput as Record<string, unknown>;
    if (record.confirmBackup === false) return 'confirmation-required';
  }
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes('confirmBackup')) return 'confirmation-required';
  if (message.includes('expectedBundleSha256')) return 'digest-mismatch';
  return 'corrupt-archive';
}

async function collectTrackedRelativePaths(
  dataDirectory: string,
  entries: readonly OwnedDataSnapshotEntry[],
): Promise<string[]> {
  const tracked = new Set<string>(STATIC_TRACKED_RELATIVE_PATHS);

  const sessionsDir = path.join(dataDirectory, 'sessions');
  try {
    const dirEntries = await readdir(sessionsDir, { withFileTypes: true });
    for (const dirEntry of dirEntries) {
      if (!dirEntry.isFile()) continue;
      if (
        dirEntry.name.endsWith('.messages.json')
        || dirEntry.name.endsWith('.events.jsonl')
        || dirEntry.name.endsWith('.events.json')
      ) {
        tracked.add(`sessions/${dirEntry.name}`);
      }
    }
  } catch (error) {
    if (!isNotFound(error)) throw error;
  }

  for (const entry of entries) {
    if (entry.section !== 'sessions') continue;
    if (!SESSION_ID_PATTERN.test(entry.id)) {
      throw new Error(`Invalid session id "${entry.id}" in snapshot.`);
    }
    tracked.add(`sessions/${entry.id}.messages.json`);
    tracked.add(`sessions/${entry.id}.events.jsonl`);
    tracked.add(`sessions/${entry.id}.events.json`);
  }

  return [...tracked].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

function isValidBackupManifest(raw: unknown, expectedBackupId: string): raw is OwnedDataBackupManifest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const manifest = raw as Record<string, unknown>;
  if (
    manifest.format !== BACKUP_FORMAT
    || manifest.backupId !== expectedBackupId
    || typeof manifest.createdAt !== 'string'
    || manifest.reason !== 'pre-restore'
    || typeof manifest.sourceBundleSha256 !== 'string'
    || typeof manifest.appVersion !== 'string'
    || !Array.isArray(manifest.files)
  ) {
    return false;
  }
  return manifest.files.every(item => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const entry = item as Record<string, unknown>;
    return (
      typeof entry.relativePath === 'string'
      && typeof entry.sha256 === 'string'
      && /^[0-9a-f]{64}$/.test(entry.sha256)
      && typeof entry.byteLength === 'number'
      && Number.isSafeInteger(entry.byteLength)
      && entry.byteLength >= 0
      && typeof entry.existed === 'boolean'
    );
  });
}

/** Create the host-owned portable restore & atomic pre-restore backup/rollback service. */
export function createOwnedDataRestoreService(deps: OwnedDataRestoreDependencies): OwnedDataRestoreService {
  const dataDirectory = path.resolve(deps.dataDirectory);
  const backupsRoot = path.join(dataDirectory, 'backups', 'restore');
  const now = deps.now ?? (() => new Date().toISOString());
  let activeExclusiveOp = false;

  async function createPreRestoreBackup(
    sourceBundleSha256: string,
    entries: readonly OwnedDataSnapshotEntry[],
  ): Promise<{ backupId: string; backupDir: string; manifest: OwnedDataBackupManifest }> {
    const backupId = `bk-${randomBytes(6).toString('hex')}`;
    const backupDir = path.join(backupsRoot, backupId);
    const filesDir = path.join(backupDir, 'files');

    await ensurePrivateDirectory(path.join(dataDirectory, 'backups'));
    await ensurePrivateDirectory(backupsRoot);
    await ensurePrivateDirectory(backupDir);
    await ensurePrivateDirectory(filesDir);

    try {
      await deps.prepareForBackup?.();
      const relativePaths = await collectTrackedRelativePaths(dataDirectory, entries);
      const manifestFiles: OwnedDataBackupFileEntry[] = [];

      for (const relativePath of relativePaths) {
        const livePath = resolveContainedPath(dataDirectory, relativePath);
        let info;
        try {
          info = await lstat(livePath);
        } catch (error) {
          if (isNotFound(error)) {
            manifestFiles.push({
              relativePath,
              sha256: EMPTY_SHA256,
              byteLength: 0,
              existed: false,
            });
            continue;
          }
          throw error;
        }

        if (!info.isFile() || info.isSymbolicLink()) {
          throw new Error(`Refusing to back up non-regular owned file: ${relativePath}.`);
        }
        const bytes = await readFile(livePath);
        const digest = sha256Buffer(bytes);
        const backupFilePath = resolveContainedPath(filesDir, relativePath);
        await ensurePrivateDirectory(path.dirname(backupFilePath));
        await writeFileAtomic(backupFilePath, bytes, { mode: PRIVATE_FILE_MODE });
        manifestFiles.push({
          relativePath,
          sha256: digest,
          byteLength: bytes.byteLength,
          existed: true,
        });
      }

      const manifest: OwnedDataBackupManifest = {
        format: BACKUP_FORMAT,
        backupId,
        createdAt: now(),
        reason: 'pre-restore',
        sourceBundleSha256,
        appVersion: deps.appVersion.trim().slice(0, 64) || '0.0.0',
        files: manifestFiles,
      };
      await writeJsonAtomic(path.join(backupDir, 'backup.json'), manifest, { mode: PRIVATE_FILE_MODE });
      return { backupId, backupDir, manifest };
    } catch (error) {
      await rm(backupDir, { recursive: true, force: true }).catch(() => undefined);
      throw error;
    }
  }

  async function verifyBackupContents(
    manifest: OwnedDataBackupManifest,
    backupDir: string,
  ): Promise<Map<string, Buffer>> {
    const filesDir = path.join(backupDir, 'files');
    const verifiedBytes = new Map<string, Buffer>();
    for (const entry of manifest.files) {
      // Validate every relative path (existed and non-existed) before mutating any file.
      resolveContainedPath(dataDirectory, entry.relativePath);
      if (!entry.existed) continue;
      const backupFilePath = resolveContainedPath(filesDir, entry.relativePath);
      const info = await lstat(backupFilePath);
      if (!info.isFile() || info.isSymbolicLink()) {
        throw new Error(`Backup file "${entry.relativePath}" is not a regular file.`);
      }
      const bytes = await readFile(backupFilePath);
      if (bytes.byteLength !== entry.byteLength || sha256Buffer(bytes) !== entry.sha256) {
        throw new Error(`Backup integrity check failed for "${entry.relativePath}".`);
      }
      verifiedBytes.set(entry.relativePath, bytes);
    }
    return verifiedBytes;
  }

  async function restoreFilesFromVerifiedBackup(
    manifest: OwnedDataBackupManifest,
    verifiedBytes: ReadonlyMap<string, Buffer>,
  ): Promise<{ restoredFiles: number; removedFiles: number }> {
    await deps.prepareForBackup?.();

    for (const sidecar of SQLITE_SIDECAR_RELATIVE_PATHS) {
      await rm(resolveContainedPath(dataDirectory, sidecar), { force: true });
    }

    let restoredFiles = 0;
    let removedFiles = 0;

    for (const entry of manifest.files) {
      const livePath = resolveContainedPath(dataDirectory, entry.relativePath);
      if (entry.existed) {
        const bytes = verifiedBytes.get(entry.relativePath);
        if (!bytes) {
          throw new Error(`Missing verified backup payload for "${entry.relativePath}".`);
        }
        await ensurePrivateDirectory(path.dirname(livePath));
        await writeFileAtomic(livePath, bytes, { mode: PRIVATE_FILE_MODE });
        const written = await readFile(livePath);
        if (written.byteLength !== entry.byteLength || sha256Buffer(written) !== entry.sha256) {
          throw new Error(`Post-rollback checksum verification failed for "${entry.relativePath}".`);
        }
        restoredFiles += 1;
      } else {
        const existedAfter = await lstat(livePath).then(() => true, error => {
          if (isNotFound(error)) return false;
          throw error;
        });
        if (existedAfter) {
          await rm(livePath, { force: true });
          removedFiles += 1;
        }
      }
    }

    await deps.reloadAfterRollback();
    return { restoredFiles, removedFiles };
  }

  return {
    async applyRestore(rawInput) {
      if (activeExclusiveOp || deps.isBusy()) {
        return {
          ok: false,
          code: 'host-busy',
          rolledBack: false,
          conflicts: [],
          detail: 'Host is busy with active work; wait until idle before applying a restore.',
        };
      }

      activeExclusiveOp = true;
      try {
        let input: ReturnType<typeof normalizeApplyOwnedDataRestoreInput>;
        try {
          input = normalizeApplyOwnedDataRestoreInput(rawInput);
        } catch (error) {
          return {
            ok: false,
            code: mapNormalizationErrorCode(rawInput, error),
            rolledBack: false,
            conflicts: [],
            detail: error instanceof Error ? error.message : 'Invalid restore request.',
          };
        }

        if (!input.confirmBackup) {
          return {
            ok: false,
            code: 'confirmation-required',
            rolledBack: false,
            conflicts: [],
            detail: 'Explicit backup confirmation (confirmBackup: true) is required before restoring owned data.',
          };
        }

        if (Buffer.byteLength(input.bundleJson, 'utf8') > MAX_SNAPSHOT_BYTES) {
          const detail = `Snapshot archive exceeds maximum size of ${MAX_SNAPSHOT_BYTES} bytes.`;
          return {
            ok: false,
            code: 'corrupt-archive',
            rolledBack: false,
            conflicts: [{ kind: 'corrupt-archive', detail }],
            detail,
          };
        }

        const actualBundleSha256 = sha256Hex(input.bundleJson);
        if (actualBundleSha256 !== input.expectedBundleSha256) {
          return {
            ok: false,
            code: 'digest-mismatch',
            rolledBack: false,
            conflicts: [],
            detail: 'Snapshot archive SHA-256 digest does not match expectedBundleSha256.',
          };
        }

        const integrity = verifyOwnedDataSnapshotIntegrity(input.bundleJson, sha256Hex);
        const preview = await deps.previewRestore(input.bundleJson);

        const combinedConflicts = preview.conflicts.length > 0 ? preview.conflicts : integrity.conflicts;
        const fatal = pickFatalConflict(combinedConflicts);
        if (fatal) {
          return {
            ok: false,
            code: fatal.kind,
            rolledBack: false,
            conflicts: combinedConflicts,
            detail: fatal.detail,
          };
        }

        if (!integrity.ok || !integrity.bundle) {
          const fallbackConflict = integrity.conflicts[0] ?? {
            kind: 'corrupt-archive' as const,
            detail: 'Snapshot archive failed integrity verification.',
          };
          return {
            ok: false,
            code: fallbackConflict.kind,
            rolledBack: false,
            conflicts: combinedConflicts.length > 0 ? combinedConflicts : [fallbackConflict],
            detail: fallbackConflict.detail,
          };
        }

        const collisionConflicts = preview.conflicts.filter(conflict => conflict.kind === 'id-collision');
        if (input.conflictPolicy === 'fail-on-collision' && collisionConflicts.length > 0) {
          return {
            ok: false,
            code: 'id-collision',
            rolledBack: false,
            conflicts: preview.conflicts,
            detail: collisionConflicts[0]!.detail,
          };
        }

        const bundle = integrity.bundle;
        const collidingKeys = new Set(
          collisionConflicts
            .filter(conflict => conflict.section && conflict.id)
            .map(conflict => `${conflict.section}:${conflict.id}`),
        );

        let backup: { backupId: string; backupDir: string; manifest: OwnedDataBackupManifest };
        try {
          backup = await createPreRestoreBackup(actualBundleSha256, bundle.entries);
        } catch (backupError) {
          await deps.reloadAfterRollback().catch(() => undefined);
          return {
            ok: false,
            code: 'write-failed-rolled-back',
            rolledBack: false,
            conflicts: [],
            detail: backupError instanceof Error
              ? `Failed to create pre-restore backup: ${backupError.message}`
              : 'Failed to create pre-restore backup.',
          };
        }

        let appliedCount = 0;
        let skippedCount = 0;
        const appliedBySection: Partial<Record<OwnedDataSnapshotSection, number>> = {};
        const skippedIds: string[] = [];
        const warnings: string[] = [];
        let skippedMissionCount = 0;

        try {
          for (const section of APPLY_SECTION_ORDER) {
            const sectionEntries = bundle.entries.filter(entry => entry.section === section);
            if (sectionEntries.length === 0) continue;

            await deps.onBeforeSectionApply?.(section);

            for (const entry of sectionEntries) {
              if (section === 'missions') {
                skippedCount += 1;
                skippedMissionCount += 1;
                skippedIds.push(entry.id);
                continue;
              }

              if (collidingKeys.has(`${section}:${entry.id}`)) {
                skippedCount += 1;
                skippedIds.push(entry.id);
                continue;
              }

              if (section === 'operatingProfiles') {
                await deps.restoreOperatingProfile(entry.payload);
                appliedCount += 1;
                appliedBySection.operatingProfiles = (appliedBySection.operatingProfiles ?? 0) + 1;
              } else if (section === 'workspaces') {
                await deps.restoreWorkspace(entry.payload);
                appliedCount += 1;
                appliedBySection.workspaces = (appliedBySection.workspaces ?? 0) + 1;
              } else if (section === 'sessions') {
                await deps.restoreSession(entry.payload);
                appliedCount += 1;
                appliedBySection.sessions = (appliedBySection.sessions ?? 0) + 1;
              } else if (section === 'schedules') {
                await deps.restoreSchedule({ ...entry.payload, enabled: false, state: 'paused' });
                appliedCount += 1;
                appliedBySection.schedules = (appliedBySection.schedules ?? 0) + 1;
                warnings.push(`Schedule "${entry.id}" was restored disabled (enabled: false) and requires manual activation.`);
              } else if (section === 'settings') {
                const settingsResult = await deps.restoreSettings(entry.payload);
                if (settingsResult.applied) {
                  appliedCount += 1;
                  appliedBySection.settings = (appliedBySection.settings ?? 0) + 1;
                } else {
                  skippedCount += 1;
                  skippedIds.push(entry.id);
                  if (settingsResult.warning) warnings.push(settingsResult.warning);
                }
              }
            }
          }

          if (skippedMissionCount > 0) {
            warnings.push(
              `Skipped ${skippedMissionCount} mission record(s): mission execution and verification states are never fabricated on restore.`,
            );
          }

          await deps.afterApply?.();
          return {
            ok: true,
            backupId: backup.backupId,
            bundleSha256: actualBundleSha256,
            appliedCount,
            skippedCount,
            appliedBySection,
            skippedIds,
            vendorSourcesUntouched: true,
            warnings,
          };
        } catch (applyError) {
          const applyDetail = applyError instanceof Error ? applyError.message : String(applyError);
          try {
            const verifiedBytes = await verifyBackupContents(backup.manifest, backup.backupDir);
            await restoreFilesFromVerifiedBackup(backup.manifest, verifiedBytes);
            return {
              ok: false,
              code: 'write-failed-rolled-back',
              backupId: backup.backupId,
              rolledBack: true,
              conflicts: [],
              detail: `Restore failed (${applyDetail}); pre-restore state was automatically rolled back.`,
            };
          } catch (rollbackError) {
            const rollbackDetail = rollbackError instanceof Error ? rollbackError.message : String(rollbackError);
            return {
              ok: false,
              code: 'rollback-incomplete',
              backupId: backup.backupId,
              rolledBack: false,
              conflicts: [],
              detail: `Restore failed (${applyDetail}) and automatic rollback was incomplete (${rollbackDetail}).`,
            };
          }
        }
      } finally {
        activeExclusiveOp = false;
      }
    },

    async listBackups() {
      let dirEntries;
      try {
        dirEntries = await readdir(backupsRoot, { withFileTypes: true });
      } catch (error) {
        if (isNotFound(error)) return [];
        throw error;
      }

      const summaries: OwnedDataBackupSummary[] = [];
      for (const dirEntry of dirEntries) {
        if (!dirEntry.isDirectory()) continue;
        let backupId: string;
        try {
          backupId = normalizeOwnedDataBackupId(dirEntry.name);
        } catch {
          continue;
        }
        const manifestPath = path.join(backupsRoot, backupId, 'backup.json');
        let rawManifest: unknown;
        try {
          rawManifest = await readJson<unknown>(manifestPath, undefined);
        } catch {
          continue;
        }
        if (!isValidBackupManifest(rawManifest, backupId)) continue;
        summaries.push({
          backupId: rawManifest.backupId,
          createdAt: rawManifest.createdAt,
          reason: rawManifest.reason,
          sourceBundleSha256: rawManifest.sourceBundleSha256,
          fileCount: rawManifest.files.length,
        });
      }

      return summaries.sort((a, b) => {
        if (a.createdAt !== b.createdAt) return a.createdAt > b.createdAt ? -1 : 1;
        return a.backupId > b.backupId ? -1 : a.backupId < b.backupId ? 1 : 0;
      });
    },

    async rollbackBackup(rawBackupId) {
      let backupId: string;
      try {
        backupId = normalizeOwnedDataBackupId(rawBackupId);
      } catch (error) {
        return {
          ok: false,
          backupId: typeof rawBackupId === 'string' ? rawBackupId.trim() : '',
          detail: error instanceof Error ? error.message : 'Invalid backupId.',
        };
      }

      if (activeExclusiveOp || deps.isBusy()) {
        return {
          ok: false,
          backupId,
          detail: 'Host is busy with active work; wait until idle before rolling back a restore.',
        };
      }

      activeExclusiveOp = true;
      try {
        const backupDir = path.join(backupsRoot, backupId);
        const manifestPath = path.join(backupDir, 'backup.json');
        let rawManifest: unknown;
        try {
          rawManifest = await readJson<unknown>(manifestPath, undefined);
        } catch (error) {
          return {
            ok: false,
            backupId,
            detail: error instanceof Error ? error.message : `Backup manifest for "${backupId}" is unreadable.`,
          };
        }
        if (!isValidBackupManifest(rawManifest, backupId)) {
          return {
            ok: false,
            backupId,
            detail: `Backup "${backupId}" was not found or has an invalid manifest.`,
          };
        }

        let verifiedBytes: Map<string, Buffer>;
        try {
          verifiedBytes = await verifyBackupContents(rawManifest, backupDir);
        } catch (error) {
          return {
            ok: false,
            backupId,
            detail: error instanceof Error ? error.message : `Backup "${backupId}" failed integrity verification.`,
          };
        }

        const { restoredFiles, removedFiles } = await restoreFilesFromVerifiedBackup(rawManifest, verifiedBytes);
        return {
          ok: true,
          backupId,
          restoredFiles,
          removedFiles,
          detail: `Rolled back backup "${backupId}" (${restoredFiles} restored, ${removedFiles} removed).`,
        };
      } catch (error) {
        return {
          ok: false,
          backupId,
          detail: error instanceof Error ? error.message : `Failed to roll back backup "${backupId}".`,
        };
      } finally {
        activeExclusiveOp = false;
      }
    },
  };
}
