import { sha256Utf8Hex } from '@extalia/core';
import {
  OWNED_DATA_RESTORE_CONFLICT_POLICIES,
  OWNED_DATA_SNAPSHOT_SECTIONS,
  type AgentHostApi,
  type OwnedDataBackupSummary,
  type OwnedDataRestoreApplyResult,
  type OwnedDataRestoreConflictKind,
  type OwnedDataRestoreConflictPolicy,
  type OwnedDataRestorePreview,
  type OwnedDataSnapshotExportPreview,
  type OwnedDataSnapshotExportResult,
  type OwnedDataSnapshotSection,
  type RollbackOwnedDataRestoreResult,
} from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { CopyButton } from '../../ui/CopyButton';
import { Icon } from '../../ui/Icon';
import './ownedSnapshot.css';

export interface OwnedSnapshotViewProps {
  t: Messages;
  sections: readonly OwnedDataSnapshotSection[];
  exportPreview: OwnedDataSnapshotExportPreview | null;
  exportResult: OwnedDataSnapshotExportResult | null;
  archiveText: string;
  restorePreview: OwnedDataRestorePreview | null;
  previewingExport?: boolean;
  exporting?: boolean;
  previewingRestore?: boolean;
  error?: string | null;
  canApplyRestore?: boolean;
  conflictPolicy?: OwnedDataRestoreConflictPolicy;
  confirmBackup?: boolean;
  applyingRestore?: boolean;
  applyResult?: OwnedDataRestoreApplyResult | null;
  backupsSupported?: boolean;
  rollbackSupported?: boolean;
  backups?: readonly OwnedDataBackupSummary[];
  loadingBackups?: boolean;
  confirmingRollbackId?: string | null;
  rollingBackId?: string | null;
  rollbackResult?: RollbackOwnedDataRestoreResult | null;
  onToggleSection?: (section: OwnedDataSnapshotSection) => void;
  onExport?: () => void;
  onDownloadExport?: () => void;
  onArchiveTextChange?: (next: string) => void;
  onArchiveFileSelected?: (file: File) => void;
  onRunRestorePreview?: () => void;
  onConflictPolicyChange?: (policy: OwnedDataRestoreConflictPolicy) => void;
  onConfirmBackupChange?: (checked: boolean) => void;
  onApplyRestore?: () => void;
  onRefreshBackups?: () => void;
  onRequestRollback?: (backupId: string) => void;
  onConfirmRollback?: (backupId: string) => void;
  onCancelRollback?: () => void;
}

const CONFLICT_KIND_TONE: Record<OwnedDataRestoreConflictKind, 'warn' | 'error'> = {
  'id-collision': 'warn',
  'missing-dependency': 'warn',
  'schema-mismatch': 'error',
  'checksum-mismatch': 'error',
  'corrupt-archive': 'error',
  'secret-detected': 'error',
};

const FATAL_NON_COLLISION_CONFLICT_KINDS = new Set<OwnedDataRestoreConflictKind>([
  'corrupt-archive',
  'schema-mismatch',
  'checksum-mismatch',
  'secret-detected',
  'missing-dependency',
]);

function isRestorePreviewApplyEligible(preview: OwnedDataRestorePreview | null): boolean {
  if (!preview) return false;
  if (!preview.checksumVerified || !preview.secretFreeVerified) return false;
  return !preview.conflicts.some(conflict => FATAL_NON_COLLISION_CONFLICT_KINDS.has(conflict.kind));
}

function downloadSnapshotJson(result: OwnedDataSnapshotExportResult) {
  if (typeof document === 'undefined' || typeof Blob === 'undefined' || typeof URL.createObjectURL !== 'function') return;
  const blob = new Blob([result.bundleJson], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  const stamp = result.bundle.manifest.provenance.exportedAt.replace(/[:.]/g, '-');
  link.download = `extalia-snapshot-${stamp}.json`;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Pure, hook-free presentation for Owned-Data Snapshot export, dry-run restore preview, apply, and rollback. */
export function OwnedSnapshotView({
  t,
  sections,
  exportPreview,
  exportResult,
  archiveText,
  restorePreview,
  previewingExport = false,
  exporting = false,
  previewingRestore = false,
  error = null,
  canApplyRestore = false,
  conflictPolicy = 'fail-on-collision',
  confirmBackup = false,
  applyingRestore = false,
  applyResult = null,
  backupsSupported = false,
  rollbackSupported = false,
  backups = [],
  loadingBackups = false,
  confirmingRollbackId = null,
  rollingBackId = null,
  rollbackResult = null,
  onToggleSection,
  onExport,
  onDownloadExport,
  onArchiveTextChange,
  onArchiveFileSelected,
  onRunRestorePreview,
  onConflictPolicyChange,
  onConfirmBackupChange,
  onApplyRestore,
  onRefreshBackups,
  onRequestRollback,
  onConfirmRollback,
  onCancelRollback,
}: OwnedSnapshotViewProps) {
  const m = t.ownedSnapshot;
  const headingId = 'settings-owned-snapshots';
  const baseId = useId();
  const fileInputId = `${baseId}-snapshot-file`;
  const textareaId = `${baseId}-snapshot-json`;
  const policySelectId = `${baseId}-restore-policy`;
  const confirmBackupId = `${baseId}-confirm-backup`;
  const canExport = sections.length > 0 && !exporting;
  const canRunRestorePreview = Boolean(archiveText.trim()) && !previewingRestore && !applyingRestore;
  const applyEligible = canApplyRestore && isRestorePreviewApplyEligible(restorePreview);
  const collisionBlocked = Boolean(
    restorePreview
    && conflictPolicy === 'fail-on-collision'
    && restorePreview.wouldCollide > 0,
  );
  const canClickApply = applyEligible && confirmBackup && !collisionBlocked && !applyingRestore && !previewingRestore;

  return (
    <section
      className="card settings-section owned-snapshot-card"
      aria-labelledby={headingId}
      aria-busy={Boolean(previewingExport || exporting || previewingRestore || applyingRestore || loadingBackups || rollingBackId) || undefined}
    >
      <div>
        <h2 id={headingId}>{m.title}</h2>
        <p className="muted small">{m.lead}</p>
      </div>

      <p className="owned-snapshot-notice small">
        <Icon name="shield" />
        <span>{m.notice}</span>
      </p>

      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      <div className="owned-snapshot-block">
        <h3>{m.export.heading}</h3>

        <fieldset className="owned-snapshot-fieldset">
          <legend className="small">{m.export.sectionsLabel}</legend>
          <div className="owned-snapshot-pill-grid">
            {OWNED_DATA_SNAPSHOT_SECTIONS.map(section => {
              const count = exportPreview?.sectionCounts[section];
              return (
                <label key={section} className="owned-snapshot-pill">
                  <input
                    type="checkbox"
                    checked={sections.includes(section)}
                    disabled={exporting}
                    onChange={() => onToggleSection?.(section)}
                  />
                  <span>{m.sections[section]}</span>
                  {count !== undefined && <span className="muted">({count})</span>}
                </label>
              );
            })}
          </div>
        </fieldset>

        <div className="owned-snapshot-summary-row small">
          {sections.length === 0 ? (
            <span className="muted">{m.export.selectAtLeastOne}</span>
          ) : previewingExport && !exportPreview ? (
            <span className="muted" role="status">{m.export.previewing}</span>
          ) : exportPreview ? (
            <>
              <span>
                <strong>{m.export.summaryLabel}:</strong>{' '}
                {m.export.totalEntries(exportPreview.totalEntries)} · {m.export.estimatedBytes(exportPreview.estimatedBytes)}
              </span>
              <span className="muted">{m.export.excludesNote}</span>
            </>
          ) : null}
        </div>

        <div className="actions">
          <button
            type="button"
            className="button primary small"
            disabled={!canExport}
            onClick={onExport}
          >
            <Icon name="download" />
            {exporting ? m.export.exporting : m.export.button}
          </button>
        </div>

        {exportResult && (
          <div className="owned-snapshot-result is-valid" role="status" aria-label={m.export.resultHeading}>
            <h4>{m.export.resultHeading}</h4>
            <div className="command-line">
              <span>{m.export.digestLabel}:</span>
              <code>{exportResult.sha256}</code>
              <CopyButton text={exportResult.sha256} label={m.export.copyDigest} />
            </div>
            <div className="owned-snapshot-metrics small">
              <span>{m.export.entriesLabel}: <strong>{exportResult.bundle.manifest.entryCount}</strong></span>
              <span>{m.export.bytesLabel}: <strong>{exportResult.byteLength.toLocaleString()}</strong></span>
              <span>{m.export.omittedSecretsLabel}: <strong>{exportResult.omittedSecretFields}</strong></span>
            </div>
            <div className="actions">
              <button type="button" className="button small" onClick={onDownloadExport}>
                <Icon name="download" />
                {m.export.downloadButton}
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="owned-snapshot-block">
        <h3>{m.restore.heading}</h3>
        <p className="owned-snapshot-dryrun-notice small">
          <Icon name="eye" />
          <span>{m.restore.dryRunNotice}</span>
        </p>

        <div className="owned-snapshot-field">
          <label className="small" htmlFor={fileInputId}>{m.restore.fileLabel}</label>
          <input
            id={fileInputId}
            type="file"
            accept=".json,application/json"
            disabled={previewingRestore || applyingRestore}
            onChange={event => {
              const file = event.target.files?.[0];
              if (file) onArchiveFileSelected?.(file);
            }}
          />
        </div>

        <div className="owned-snapshot-field">
          <label className="small" htmlFor={textareaId}>{m.restore.jsonLabel}</label>
          <textarea
            id={textareaId}
            rows={5}
            value={archiveText}
            placeholder={m.restore.jsonPlaceholder}
            disabled={previewingRestore || applyingRestore}
            onChange={event => onArchiveTextChange?.(event.target.value)}
          />
        </div>

        <div className="actions">
          <button
            type="button"
            className="button small"
            disabled={!canRunRestorePreview}
            onClick={onRunRestorePreview}
          >
            <Icon name="shield" />
            {previewingRestore ? m.restore.previewing : m.restore.previewButton}
          </button>
        </div>

        {restorePreview && (
          <div
            className={`owned-snapshot-result ${restorePreview.valid ? 'is-valid' : 'is-blocked'}`}
            role="status"
            aria-label={m.restore.heading}
          >
            <div className="owned-snapshot-badges">
              <span className={`badge ${restorePreview.valid ? 'ok' : 'error'}`}>
                {restorePreview.valid ? m.restore.validBadge : m.restore.blockedBadge}
              </span>
              <span className="badge subtle">{m.restore.dryRunOnlyBadge}</span>
              <span className={`badge ${restorePreview.checksumVerified ? 'ok' : 'error'}`}>
                {restorePreview.checksumVerified ? m.restore.checksumVerified : m.restore.checksumFailed}
              </span>
              <span className={`badge ${restorePreview.secretFreeVerified ? 'ok' : 'error'}`}>
                {restorePreview.secretFreeVerified ? m.restore.secretFreeVerified : m.restore.secretDetected}
              </span>
            </div>

            <div className="owned-snapshot-metrics small">
              <span>{m.restore.entryCountLabel}: <strong>{restorePreview.entryCount}</strong></span>
              <span>{m.restore.wouldAddLabel}: <strong>{restorePreview.wouldAdd}</strong></span>
              <span>{m.restore.wouldCollideLabel}: <strong>{restorePreview.wouldCollide}</strong></span>
              {restorePreview.schemaVersion !== undefined && (
                <span>{m.restore.schemaVersionLabel}: <strong>v{restorePreview.schemaVersion}</strong></span>
              )}
            </div>

            {restorePreview.conflicts.length === 0 ? (
              <p className="muted small">{m.restore.noConflicts}</p>
            ) : (
              <div className="owned-snapshot-field">
                <h4>{m.restore.conflictsHeading}</h4>
                <div className="table-card">
                  <table className="owned-snapshot-conflicts-table">
                    <thead>
                      <tr>
                        <th scope="col">{m.restore.conflictHeaders.kind}</th>
                        <th scope="col">{m.restore.conflictHeaders.section}</th>
                        <th scope="col">{m.restore.conflictHeaders.id}</th>
                        <th scope="col">{m.restore.conflictHeaders.detail}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {restorePreview.conflicts.map((conflict, index) => (
                        <tr key={`${conflict.kind}:${conflict.section ?? 'none'}:${conflict.id ?? index}`}>
                          <td>
                            <span className={`badge ${CONFLICT_KIND_TONE[conflict.kind]}`}>
                              {m.restore.conflictKinds[conflict.kind]}
                            </span>
                          </td>
                          <td>{conflict.section ? m.sections[conflict.section] : '—'}</td>
                          <td>{conflict.id ? <code>{conflict.id}</code> : '—'}</td>
                          <td>{conflict.detail}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {applyEligible && (
              <div className="owned-snapshot-apply-panel">
                <div className="owned-snapshot-field">
                  <label className="small" htmlFor={policySelectId}>{m.restore.policyLabel}</label>
                  <select
                    id={policySelectId}
                    value={conflictPolicy}
                    disabled={applyingRestore}
                    onChange={event => onConflictPolicyChange?.(event.target.value as OwnedDataRestoreConflictPolicy)}
                  >
                    {OWNED_DATA_RESTORE_CONFLICT_POLICIES.map(policy => (
                      <option key={policy} value={policy}>
                        {m.restore.policies[policy]}
                      </option>
                    ))}
                  </select>
                </div>

                {collisionBlocked && (
                  <p className="warning small" role="status">
                    <Icon name="alert" />
                    <span>{m.restore.collisionBlockedHint}</span>
                  </p>
                )}

                <label className="owned-snapshot-confirm-row small" htmlFor={confirmBackupId}>
                  <input
                    id={confirmBackupId}
                    type="checkbox"
                    checked={confirmBackup}
                    disabled={applyingRestore}
                    onChange={event => onConfirmBackupChange?.(event.target.checked)}
                  />
                  <span>{m.restore.confirmBackupLabel}</span>
                </label>

                <div className="actions">
                  <button
                    type="button"
                    className="button primary small"
                    disabled={!canClickApply}
                    onClick={onApplyRestore}
                  >
                    <Icon name="check" />
                    {applyingRestore ? m.restore.applying : m.restore.applyButton}
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {applyResult && (
          applyResult.ok ? (
            <div className="owned-snapshot-result is-valid" role="status" aria-label={m.restore.applyReceiptHeading}>
              <h4>{m.restore.applyReceiptHeading}</h4>
              <div className="owned-snapshot-metrics small">
                <span>{m.restore.backupIdLabel}: <code>{applyResult.backupId}</code></span>
                <span>{m.restore.appliedCountLabel}: <strong>{applyResult.appliedCount}</strong></span>
                <span>{m.restore.skippedCountLabel}: <strong>{applyResult.skippedCount}</strong></span>
              </div>
              {applyResult.warnings.length > 0 && (
                <div className="owned-snapshot-field">
                  <strong className="small">{m.restore.warningsHeading}</strong>
                  <ul className="owned-snapshot-warnings small muted">
                    {applyResult.warnings.map((warning, index) => (
                      <li key={index}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          ) : (
            <div className="owned-snapshot-result is-blocked" role="alert" aria-label={m.restore.applyFailedHeading}>
              <div className="owned-snapshot-badges">
                <h4>{m.restore.applyFailedHeading}</h4>
                <span className="badge error">{m.restore.errorCodes[applyResult.code] ?? applyResult.code}</span>
              </div>
              <p className="small">{applyResult.detail}</p>
              {applyResult.backupId && (
                <p className="small muted">{m.restore.backupIdLabel}: <code>{applyResult.backupId}</code></p>
              )}
              {applyResult.rolledBack && (
                <p className="owned-snapshot-notice small">
                  <Icon name="refresh" />
                  <span>{m.restore.rolledBackNotice}</span>
                </p>
              )}
              {!applyResult.rolledBack && applyResult.code === 'rollback-incomplete' && (
                <p className="form-error small" role="alert">
                  <Icon name="alert" />
                  <span>{m.restore.rollbackIncompleteNotice}</span>
                </p>
              )}
            </div>
          )
        )}
      </div>

      {backupsSupported && (
        <div className="owned-snapshot-block">
          <div className="section-head">
            <div>
              <h3>{m.backups.heading}</h3>
              <p className="muted small">{m.backups.lead}</p>
            </div>
            <button
              type="button"
              className="button small"
              disabled={loadingBackups || rollingBackId !== null || !onRefreshBackups}
              onClick={onRefreshBackups}
            >
              <Icon name="refresh" className={loadingBackups ? 'spin' : ''} />
              {m.backups.refresh}
            </button>
          </div>

          {rollbackResult && (
            rollbackResult.ok ? (
              <div className="owned-snapshot-result is-valid" role="status">
                <p className="small">
                  {m.backups.rollbackSuccess(rollbackResult.backupId, rollbackResult.restoredFiles, rollbackResult.removedFiles)}
                </p>
                <p className="muted small">{rollbackResult.detail}</p>
              </div>
            ) : (
              <div className="owned-snapshot-result is-blocked" role="alert">
                <h4>{m.backups.rollbackErrorHeading}</h4>
                <p className="small"><code>{rollbackResult.backupId}</code> — {rollbackResult.detail}</p>
              </div>
            )
          )}

          {loadingBackups && backups.length === 0 ? (
            <p className="muted small" role="status">{m.backups.loading}</p>
          ) : backups.length === 0 ? (
            <p className="muted small">{m.backups.empty}</p>
          ) : (
            <ul className="owned-snapshot-backups-list">
              {backups.map(backup => {
                const isConfirming = confirmingRollbackId === backup.backupId;
                const isRollingBack = rollingBackId === backup.backupId;
                return (
                  <li key={backup.backupId} className="owned-snapshot-backup-row">
                    <div className="owned-snapshot-backup-meta small">
                      <span>{m.backups.backupIdLabel}: <code>{backup.backupId}</code></span>
                      <span className="muted">{m.backups.createdAtLabel}: {backup.createdAt}</span>
                      <span>{m.backups.fileCountLabel}: <strong>{backup.fileCount}</strong></span>
                    </div>
                    <div className="owned-snapshot-backup-digest small">
                      <span className="muted">{m.backups.sourceDigestLabel}:</span>
                      <code>{backup.sourceBundleSha256}</code>
                    </div>
                    {rollbackSupported && (
                      <div className="owned-snapshot-rollback-confirm">
                        {isConfirming ? (
                          <>
                            <span className="small">{m.backups.confirmPrompt}</span>
                            <button
                              type="button"
                              className="button danger small"
                              disabled={rollingBackId !== null}
                              onClick={() => onConfirmRollback?.(backup.backupId)}
                            >
                              {isRollingBack ? m.backups.rollingBack : m.backups.confirmRollbackButton}
                            </button>
                            <button
                              type="button"
                              className="button small"
                              disabled={rollingBackId !== null}
                              onClick={onCancelRollback}
                            >
                              {m.backups.cancelRollbackButton}
                            </button>
                          </>
                        ) : (
                          <button
                            type="button"
                            className="button small"
                            disabled={rollingBackId !== null}
                            onClick={() => onRequestRollback?.(backup.backupId)}
                          >
                            <Icon name="refresh" />
                            {m.backups.rollbackButton}
                          </button>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </section>
  );
}

/** Stateful Settings card for Owned-Data Snapshot export, dry-run preview, apply, and backup rollback. */
export function OwnedSnapshotCard({
  t,
  agents,
}: {
  t: Messages;
  agents: AgentHostApi;
}) {
  const [sections, setSections] = useState<OwnedDataSnapshotSection[]>([...OWNED_DATA_SNAPSHOT_SECTIONS]);
  const [exportPreview, setExportPreview] = useState<OwnedDataSnapshotExportPreview | null>(null);
  const [exportResult, setExportResult] = useState<OwnedDataSnapshotExportResult | null>(null);
  const [archiveText, setArchiveText] = useState('');
  const [restorePreview, setRestorePreview] = useState<OwnedDataRestorePreview | null>(null);
  const [previewingExport, setPreviewingExport] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [previewingRestore, setPreviewingRestore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [conflictPolicy, setConflictPolicy] = useState<OwnedDataRestoreConflictPolicy>('fail-on-collision');
  const [confirmBackup, setConfirmBackup] = useState(false);
  const [applyingRestore, setApplyingRestore] = useState(false);
  const [applyResult, setApplyResult] = useState<OwnedDataRestoreApplyResult | null>(null);

  const [backups, setBackups] = useState<OwnedDataBackupSummary[]>([]);
  const [loadingBackups, setLoadingBackups] = useState(false);
  const [confirmingRollbackId, setConfirmingRollbackId] = useState<string | null>(null);
  const [rollingBackId, setRollingBackId] = useState<string | null>(null);
  const [rollbackResult, setRollbackResult] = useState<RollbackOwnedDataRestoreResult | null>(null);

  const mountedRef = useRef(true);
  const previewGenerationRef = useRef(0);
  const exportGenerationRef = useRef(0);
  const restoreGenerationRef = useRef(0);
  const applyGenerationRef = useRef(0);
  const backupsGenerationRef = useRef(0);
  const rollbackGenerationRef = useRef(0);

  const supported = Boolean(
    agents.previewOwnedDataExport
    && agents.exportOwnedDataSnapshot
    && agents.previewOwnedDataRestore,
  );
  const canApplyRestore = typeof agents.applyOwnedDataRestore === 'function';
  const backupsSupported = typeof agents.listOwnedDataBackups === 'function';
  const rollbackSupported = typeof agents.rollbackOwnedDataRestore === 'function';

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const previewFn = agents.previewOwnedDataExport;
    if (!previewFn || !agents.exportOwnedDataSnapshot || !agents.previewOwnedDataRestore) return;
    let active = true;
    const generation = ++previewGenerationRef.current;
    const isCurrent = () => active && mountedRef.current && generation === previewGenerationRef.current;
    void (async () => {
      if (sections.length === 0) {
        await Promise.resolve();
        if (!isCurrent()) return;
        setExportPreview(null);
        setPreviewingExport(false);
        return;
      }
      setPreviewingExport(true);
      setError(null);
      try {
        const next = await previewFn({ sections: [...sections] });
        if (!isCurrent()) return;
        setExportPreview(next);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setPreviewingExport(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [agents, sections]);

  useEffect(() => {
    const listBackupsFn = agents.listOwnedDataBackups;
    if (!supported || !listBackupsFn) return;
    let active = true;
    const generation = ++backupsGenerationRef.current;
    const isCurrent = () => active && mountedRef.current && generation === backupsGenerationRef.current;
    void (async () => {
      await Promise.resolve();
      if (!isCurrent()) return;
      setLoadingBackups(true);
      try {
        const list = await listBackupsFn();
        if (!isCurrent()) return;
        setBackups(list);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setLoadingBackups(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [agents, supported]);

  if (!supported) return null;

  const refreshBackups = () => {
    const listBackupsFn = agents.listOwnedDataBackups;
    if (!listBackupsFn) return;
    const generation = ++backupsGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === backupsGenerationRef.current;
    setLoadingBackups(true);
    void (async () => {
      try {
        const list = await listBackupsFn();
        if (!isCurrent()) return;
        setBackups(list);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setLoadingBackups(false);
      }
    })();
  };

  const handleToggleSection = (section: OwnedDataSnapshotSection) => {
    setSections(current => {
      const next = current.includes(section)
        ? current.filter(item => item !== section)
        : [...current, section];
      return OWNED_DATA_SNAPSHOT_SECTIONS.filter(item => next.includes(item));
    });
  };

  const handleExport = () => {
    const exportFn = agents.exportOwnedDataSnapshot;
    if (!exportFn || sections.length === 0) return;
    const generation = ++exportGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === exportGenerationRef.current;
    setExporting(true);
    setError(null);
    void (async () => {
      try {
        const result = await exportFn({ sections: [...sections] });
        if (!isCurrent()) return;
        setExportResult(result);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setExporting(false);
      }
    })();
  };

  const handleRunRestorePreview = () => {
    const restoreFn = agents.previewOwnedDataRestore;
    if (!restoreFn || !archiveText.trim()) return;
    const generation = ++restoreGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === restoreGenerationRef.current;
    setPreviewingRestore(true);
    setConfirmBackup(false);
    setApplyResult(null);
    setError(null);
    void (async () => {
      try {
        const result = await restoreFn(archiveText);
        if (!isCurrent()) return;
        setRestorePreview(result);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setPreviewingRestore(false);
      }
    })();
  };

  const handleArchiveFileSelected = (file: File) => {
    const generation = ++restoreGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === restoreGenerationRef.current;
    void (async () => {
      try {
        const content = await file.text();
        if (!isCurrent()) return;
        setArchiveText(content);
        setRestorePreview(null);
        setConfirmBackup(false);
        setApplyResult(null);
        setError(null);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      }
    })();
  };

  const handleApplyRestore = () => {
    const applyFn = agents.applyOwnedDataRestore;
    if (!applyFn || !archiveText.trim() || !isRestorePreviewApplyEligible(restorePreview)) return;
    const generation = ++applyGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === applyGenerationRef.current;
    setApplyingRestore(true);
    setError(null);
    void (async () => {
      try {
        const expectedBundleSha256 = sha256Utf8Hex(archiveText);
        const result = await applyFn({
          bundleJson: archiveText,
          expectedBundleSha256,
          conflictPolicy,
          confirmBackup,
        });
        if (!isCurrent()) return;
        setApplyResult(result);
        if (result.ok) {
          setConfirmBackup(false);
        }
        if (result.ok || result.backupId) {
          refreshBackups();
        }
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setApplyingRestore(false);
      }
    })();
  };

  const handleConfirmRollback = (backupId: string) => {
    const rollbackFn = agents.rollbackOwnedDataRestore;
    if (!rollbackFn) return;
    const generation = ++rollbackGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === rollbackGenerationRef.current;
    setRollingBackId(backupId);
    setError(null);
    void (async () => {
      try {
        const result = await rollbackFn(backupId);
        if (!isCurrent()) return;
        setRollbackResult(result);
        setConfirmingRollbackId(null);
        if (result.ok) {
          refreshBackups();
        }
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setRollingBackId(null);
      }
    })();
  };

  return (
    <OwnedSnapshotView
      t={t}
      sections={sections}
      exportPreview={exportPreview}
      exportResult={exportResult}
      archiveText={archiveText}
      restorePreview={restorePreview}
      previewingExport={previewingExport}
      exporting={exporting}
      previewingRestore={previewingRestore}
      error={error}
      canApplyRestore={canApplyRestore}
      conflictPolicy={conflictPolicy}
      confirmBackup={confirmBackup}
      applyingRestore={applyingRestore}
      applyResult={applyResult}
      backupsSupported={backupsSupported}
      rollbackSupported={rollbackSupported}
      backups={backups}
      loadingBackups={loadingBackups}
      confirmingRollbackId={confirmingRollbackId}
      rollingBackId={rollingBackId}
      rollbackResult={rollbackResult}
      onToggleSection={handleToggleSection}
      onExport={handleExport}
      onDownloadExport={exportResult ? () => downloadSnapshotJson(exportResult) : undefined}
      onArchiveTextChange={next => {
        setArchiveText(next);
        setRestorePreview(null);
        setConfirmBackup(false);
        setApplyResult(null);
      }}
      onArchiveFileSelected={handleArchiveFileSelected}
      onRunRestorePreview={handleRunRestorePreview}
      onConflictPolicyChange={setConflictPolicy}
      onConfirmBackupChange={setConfirmBackup}
      onApplyRestore={handleApplyRestore}
      onRefreshBackups={refreshBackups}
      onRequestRollback={backupId => {
        setConfirmingRollbackId(backupId);
        setRollbackResult(null);
      }}
      onConfirmRollback={handleConfirmRollback}
      onCancelRollback={() => setConfirmingRollbackId(null)}
    />
  );
}
