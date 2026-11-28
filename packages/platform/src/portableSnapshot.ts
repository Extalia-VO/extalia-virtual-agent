import {
  OWNED_DATA_RESTORE_CONFLICT_POLICIES,
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  OWNED_DATA_SNAPSHOT_SECTIONS,
  type ApplyOwnedDataRestoreInput,
  type OwnedDataBackupFileEntry,
  type OwnedDataBackupManifest,
  type OwnedDataBackupSummary,
  type OwnedDataRestoreApplyErrorCode,
  type OwnedDataRestoreApplyResult,
  type OwnedDataRestoreConflict,
  type OwnedDataRestoreConflictKind,
  type OwnedDataRestoreConflictPolicy,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotBundle,
  type OwnedDataSnapshotEntry,
  type OwnedDataSnapshotExportPreview,
  type OwnedDataSnapshotExportResult,
  type OwnedDataSnapshotManifest,
  type OwnedDataSnapshotProvenance,
  type OwnedDataSnapshotSection,
  type OwnedDataSnapshotSelection,
  type RollbackOwnedDataRestoreResult,
} from '@extalia/core';

export {
  OWNED_DATA_RESTORE_CONFLICT_POLICIES,
  OWNED_DATA_SNAPSHOT_FORMAT,
  OWNED_DATA_SNAPSHOT_SCHEMA_VERSION,
  OWNED_DATA_SNAPSHOT_SECTIONS,
};

export type {
  ApplyOwnedDataRestoreInput,
  OwnedDataBackupFileEntry,
  OwnedDataBackupManifest,
  OwnedDataBackupSummary,
  OwnedDataRestoreApplyErrorCode,
  OwnedDataRestoreApplyResult,
  OwnedDataRestoreConflict,
  OwnedDataRestoreConflictKind,
  OwnedDataRestoreConflictPolicy,
  OwnedDataRestorePreview,
  OwnedDataSnapshotBundle,
  OwnedDataSnapshotEntry,
  OwnedDataSnapshotExportPreview,
  OwnedDataSnapshotExportResult,
  OwnedDataSnapshotManifest,
  OwnedDataSnapshotProvenance,
  OwnedDataSnapshotSection,
  OwnedDataSnapshotSelection,
  RollbackOwnedDataRestoreResult,
};

export const PORTABLE_SNAPSHOT_HOST_METHODS = [
  'previewOwnedDataExport',
  'exportOwnedDataSnapshot',
  'previewOwnedDataRestore',
  'applyOwnedDataRestore',
  'listOwnedDataBackups',
  'rollbackOwnedDataRestore',
] as const;

export type PortableSnapshotHostMethod = (typeof PORTABLE_SNAPSHOT_HOST_METHODS)[number];
