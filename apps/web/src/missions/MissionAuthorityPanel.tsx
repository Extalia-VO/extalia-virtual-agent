import {
  MISSION_RECONCILIATION_DECISIONS,
  MISSION_WAIVER_DEFAULT_TTL_MS,
  type AgentHostApi,
  type HostMissionRun,
  type MissionAcceptanceState,
  type MissionAuthorityOverview,
  type MissionReconciliationDecision,
  type MissionReconciliationPreview,
  type MissionReconciliationReceipt,
  type MissionValidationOutcome,
  type MissionWaiverScope,
} from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Language, Messages } from '../i18n';
import { CopyButton } from '../ui/CopyButton';
import { Icon } from '../ui/Icon';
import './missionAuthority.css';

const ACCEPTANCE_TONE: Record<MissionAcceptanceState, 'ok' | 'warn' | 'error'> = {
  accepted: 'ok',
  waived: 'warn',
  unverified: 'warn',
  rejected: 'error',
};

const VALIDATION_TONE: Record<MissionValidationOutcome, 'ok' | 'warn' | 'error' | 'subtle'> = {
  passed: 'ok',
  failed: 'error',
  timed_out: 'error',
  cancelled: 'warn',
  not_run: 'subtle',
  unknown: 'warn',
};

const WAIVER_TTL_OPTIONS = [
  { key: 'short', ms: 15 * 60_000 },
  { key: 'hour', ms: MISSION_WAIVER_DEFAULT_TTL_MS },
  { key: 'day', ms: 24 * 3_600_000 },
] as const;

export interface ReconciliationFormState {
  decision: MissionReconciliationDecision;
  actor: string;
  reason: string;
}

export interface WaiverFormState {
  actor: string;
  reason: string;
  policyVersion: string;
  scope: MissionWaiverScope;
  ttlMs: number;
}

export interface MissionAuthorityViewProps {
  t: Messages;
  language: Language;
  run: HostMissionRun;
  overview: MissionAuthorityOverview | null;
  preview: MissionReconciliationPreview | null;
  reconciliationForm: ReconciliationFormState;
  committedReceipt?: MissionReconciliationReceipt | null;
  idempotentReplay?: boolean;
  staleDigestBanner?: boolean;
  openWaiverTaskId?: string | null;
  waiverForm: WaiverFormState;
  loading?: boolean;
  busy?: string | null;
  error?: string | null;
  reconcileError?: string | null;
  waiverError?: string | null;
  canPreviewReconciliation?: boolean;
  canCommitReconciliation?: boolean;
  canGrantWaiver?: boolean;
  canRevokeWaiver?: boolean;
  onRefresh?: () => void;
  onPreviewReconciliation?: () => void;
  onReconciliationFormChange?: (next: ReconciliationFormState) => void;
  onCommitReconciliation?: () => void;
  onToggleWaiverForm?: (taskId: string | null) => void;
  onWaiverFormChange?: (next: WaiverFormState) => void;
  onSubmitWaiver?: (taskId: string) => void;
  onRevokeWaiver?: (waiverId: string) => void;
}

const shortDigest = (digest: string) => digest.slice(0, 12);

/** Pure, hook-free view for Reviewed Terminal Reconciliation, Evidence & Waiver Gates. */
export function MissionAuthorityView({
  t,
  language,
  run,
  overview,
  preview,
  reconciliationForm,
  committedReceipt = null,
  idempotentReplay = false,
  staleDigestBanner = false,
  openWaiverTaskId = null,
  waiverForm,
  loading = false,
  busy = null,
  error = null,
  reconcileError = null,
  waiverError = null,
  canPreviewReconciliation = false,
  canCommitReconciliation = false,
  canGrantWaiver = false,
  canRevokeWaiver = false,
  onRefresh,
  onPreviewReconciliation,
  onReconciliationFormChange,
  onCommitReconciliation,
  onToggleWaiverForm,
  onWaiverFormChange,
  onSubmitWaiver,
  onRevokeWaiver,
}: MissionAuthorityViewProps) {
  const m = t.missionAuthority;
  const baseId = useId();
  const headingId = `${baseId}-heading`;
  const actorId = `${baseId}-reconcile-actor`;
  const reasonId = `${baseId}-reconcile-reason`;
  const waiverActorId = `${baseId}-waiver-actor`;
  const waiverReasonId = `${baseId}-waiver-reason`;
  const waiverPolicyId = `${baseId}-waiver-policy`;
  const waiverScopeId = `${baseId}-waiver-scope`;
  const waiverTtlId = `${baseId}-waiver-ttl`;

  const activeReceipt = committedReceipt ?? overview?.reconciliationReceipt ?? preview?.existingReceipt ?? null;
  const showReconciliationBlock = run.state === 'recovering' || Boolean(activeReceipt) || Boolean(preview);
  const effectiveDigest = overview?.reviewDigest ?? preview?.reviewDigest ?? '';
  const time = (iso: string) => new Date(iso).toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
  const decisions = preview?.eligibleDecisions.length ? preview.eligibleDecisions : MISSION_RECONCILIATION_DECISIONS;
  const hasActiveLeases = Boolean(preview && preview.activeLeaseIds.length > 0);
  const canSubmitCommit = canCommitReconciliation
    && Boolean(effectiveDigest)
    && Boolean(reconciliationForm.actor.trim())
    && Boolean(reconciliationForm.reason.trim())
    && !hasActiveLeases
    && busy === null;

  return (
    <section
      className="mission-authority"
      aria-labelledby={headingId}
      aria-busy={Boolean(loading || busy) || undefined}
    >
      <header className="mission-authority-head">
        <div>
          <h3 id={headingId}>{m.title}</h3>
          <p className="muted small">{m.lead}</p>
        </div>
        <button
          type="button"
          className="icon-button small"
          aria-label={m.refresh}
          title={m.refresh}
          disabled={loading || busy !== null}
          onClick={onRefresh}
        >
          <Icon name="refresh" className={loading ? 'spin' : ''} />
        </button>
      </header>

      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      {loading && !overview ? (
        <p className="muted small" role="status">{m.loading}</p>
      ) : overview && (
        <>
          <div className="mission-authority-summary" role="status">
            <span className={`badge ${overview.verifiedComplete ? 'ok' : 'warn'}`}>
              <Icon name={overview.verifiedComplete ? 'check' : 'alert'} />
              <span>{overview.verifiedComplete ? m.verifiedComplete : m.unverified}</span>
            </span>
            <span className="mission-authority-digest">
              <span className="muted">{m.reviewDigestLabel}:</span>
              <code title={overview.reviewDigest}>{shortDigest(overview.reviewDigest)}</code>
              <CopyButton text={overview.reviewDigest} label={m.copyDigest} />
            </span>
          </div>

          {showReconciliationBlock && (
            <section className="mission-authority-block" aria-label={m.reconciliation.heading}>
              <div className="mission-authority-head">
                <h4>{m.reconciliation.heading}</h4>
                {!activeReceipt && canPreviewReconciliation && (
                  <button
                    type="button"
                    className="button small"
                    disabled={busy !== null}
                    onClick={onPreviewReconciliation}
                  >
                    {busy === 'preview' ? m.reconciliation.previewing : m.reconciliation.previewButton}
                  </button>
                )}
              </div>

              <p className="mission-authority-disclaimer small">
                <Icon name="shield" />
                <span>{m.reconciliation.disclaimer}</span>
              </p>

              {staleDigestBanner && (
                <div className="mission-authority-stale small" role="alert">
                  <Icon name="alert" />
                  <span>{m.reconciliation.staleBanner}</span>
                  {onRefresh && (
                    <button type="button" className="button small" disabled={loading || busy !== null} onClick={onRefresh}>
                      {m.refresh}
                    </button>
                  )}
                </div>
              )}

              {preview && (
                <div className="mission-authority-badges">
                  <span className="badge subtle">
                    {m.reconciliation.leasesSummary(preview.activeLeaseIds.length, preview.quarantinedLeaseIds.length)}
                  </span>
                </div>
              )}

              {preview && preview.warnings.length > 0 && (
                <div className="small">
                  <strong>{m.reconciliation.warningsHeading}:</strong>
                  <ul>
                    {preview.warnings.map(warning => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                </div>
              )}

              {activeReceipt ? (
                <div className="mission-authority-receipt" role="status" aria-label={m.reconciliation.receiptHeading}>
                  <div className="mission-authority-badges">
                    <strong>{m.reconciliation.receiptHeading}</strong>
                    {idempotentReplay && <span className="badge subtle">{m.reconciliation.receiptIdempotent}</span>}
                    <span className="badge ok">{m.reconciliation.decisions[activeReceipt.decision]}</span>
                  </div>
                  <dl className="mission-authority-receipt-grid">
                    <div>
                      <dt>{m.reconciliation.receiptFields.receiptId}</dt>
                      <dd><code>{activeReceipt.receiptId}</code></dd>
                    </div>
                    <div>
                      <dt>{m.reconciliation.receiptFields.transition}</dt>
                      <dd>{activeReceipt.previousState} → {activeReceipt.resultingState}</dd>
                    </div>
                    <div>
                      <dt>{m.reconciliation.receiptFields.actor}</dt>
                      <dd>{activeReceipt.actor}</dd>
                    </div>
                    <div>
                      <dt>{m.reconciliation.receiptFields.committedAt}</dt>
                      <dd><time dateTime={activeReceipt.committedAt}>{time(activeReceipt.committedAt)}</time></dd>
                    </div>
                    <div>
                      <dt>{m.reconciliation.receiptFields.reviewDigest}</dt>
                      <dd><code title={activeReceipt.reviewDigest}>{shortDigest(activeReceipt.reviewDigest)}</code></dd>
                    </div>
                    <div>
                      <dt>{m.reconciliation.receiptFields.reason}</dt>
                      <dd>{activeReceipt.reason}</dd>
                    </div>
                  </dl>
                  <p className="muted small" style={{ margin: 0 }}>{m.reconciliation.receiptFields.noSideEffects}</p>
                </div>
              ) : run.state === 'recovering' && (
                <form
                  className="mission-authority-form"
                  onSubmit={event => {
                    event.preventDefault();
                    onCommitReconciliation?.();
                  }}
                >
                  <fieldset className="mission-authority-radios">
                    <legend>{m.reconciliation.decisionLabel}</legend>
                    {decisions.map(decision => (
                      <label key={decision} className="mission-authority-radio-pill">
                        <input
                          type="radio"
                          name={`${baseId}-decision`}
                          value={decision}
                          checked={reconciliationForm.decision === decision}
                          disabled={busy !== null}
                          onChange={() => onReconciliationFormChange?.({ ...reconciliationForm, decision })}
                        />
                        <span>{m.reconciliation.decisions[decision]}</span>
                      </label>
                    ))}
                  </fieldset>

                  <div className="mission-authority-fields">
                    <div className="mission-authority-field">
                      <label htmlFor={actorId}>{m.reconciliation.actorLabel}</label>
                      <input
                        id={actorId}
                        type="text"
                        maxLength={120}
                        required
                        value={reconciliationForm.actor}
                        placeholder={m.reconciliation.actorPlaceholder}
                        disabled={busy !== null}
                        onChange={event => onReconciliationFormChange?.({ ...reconciliationForm, actor: event.target.value })}
                      />
                    </div>
                    <div className="mission-authority-field">
                      <label htmlFor={reasonId}>{m.reconciliation.reasonLabel}</label>
                      <input
                        id={reasonId}
                        type="text"
                        maxLength={1000}
                        required
                        value={reconciliationForm.reason}
                        placeholder={m.reconciliation.reasonPlaceholder}
                        disabled={busy !== null}
                        onChange={event => onReconciliationFormChange?.({ ...reconciliationForm, reason: event.target.value })}
                      />
                    </div>
                  </div>

                  {reconcileError && (
                    <p className="form-error" role="alert">
                      <Icon name="alert" />
                      <span>{reconcileError}</span>
                    </p>
                  )}

                  <div className="actions">
                    <button type="submit" className="button primary small" disabled={!canSubmitCommit}>
                      <Icon name="check" />
                      <span>{busy === 'commit' ? m.reconciliation.committing : m.reconciliation.commitButton}</span>
                    </button>
                  </div>
                </form>
              )}
            </section>
          )}

          <section className="mission-authority-block" aria-label={m.tasks.heading}>
            <h4>{m.tasks.heading}</h4>
            {waiverError && (
              <p className="form-error" role="alert">
                <Icon name="alert" />
                <span>{waiverError}</span>
              </p>
            )}
            {overview.taskGates.length === 0 ? (
              <p className="muted small">{m.tasks.empty}</p>
            ) : (
              <ol className="mission-authority-task-list">
                {overview.taskGates.map(gate => {
                  const taskEvidence = overview.evidence.filter(item => item.taskId === gate.taskId);
                  const taskWaivers = overview.waivers.filter(item => item.taskId === gate.taskId);
                  const isWaiverOpen = openWaiverTaskId === gate.taskId;
                  return (
                    <li key={gate.taskId} className="mission-authority-task" data-task-id={gate.taskId}>
                      <div className="mission-authority-task-head">
                        <h5>
                          {gate.title}{' '}
                          <span className="muted small"><code>{gate.id}</code></span>
                        </h5>
                        <div className="mission-authority-badges">
                          <span className="badge subtle">
                            {m.tasks.headers.executionOutcome}: {m.tasks.executionOutcomes[gate.executionOutcome] ?? gate.executionOutcome}
                          </span>
                          <span className={`badge ${VALIDATION_TONE[gate.validation]}`}>
                            {m.tasks.headers.validation}: {m.tasks.validations[gate.validation] ?? gate.validation}
                          </span>
                          <span className={`badge ${ACCEPTANCE_TONE[gate.acceptance]}`} data-acceptance={gate.acceptance}>
                            {m.tasks.acceptances[gate.acceptance] ?? gate.acceptance}
                          </span>
                        </div>
                      </div>

                      <div className="mission-authority-badges">
                        {gate.dependencyBlockedBy.length > 0 ? (
                          <span className="badge warn" data-dependency-blocked="true">
                            <Icon name="alert" />
                            <span>{m.tasks.dependencyBlockedBy(gate.dependencyBlockedBy.join(', '))}</span>
                          </span>
                        ) : (
                          <span className="badge ok" data-dependency-eligible="true">
                            <Icon name="check" />
                            <span>{m.tasks.dependencyEligible}</span>
                          </span>
                        )}
                      </div>

                      {gate.legacyUnverified && (
                        <p className="muted small" style={{ margin: 0 }}>{m.tasks.legacyUnverifiedNote}</p>
                      )}

                      {taskEvidence.length === 0 ? (
                        <p className="muted small" style={{ margin: 0 }}>{m.tasks.noEvidence}</p>
                      ) : (
                        <ul className="mission-authority-evidence-list" aria-label={m.tasks.headers.evidence}>
                          {taskEvidence.map(item => {
                            const hostVerified = item.verifiedByHost && item.sourceKind !== 'observed-claim';
                            return (
                              <li key={item.evidenceId} className="mission-authority-evidence-item">
                                <div className="mission-authority-evidence-head">
                                  <div className="mission-authority-badges">
                                    <span className="badge subtle">{m.tasks.sourceKinds[item.sourceKind] ?? item.sourceKind}</span>
                                    <span className={`badge ${hostVerified ? 'ok' : 'warn'}`} data-host-verified={hostVerified ? 'true' : 'false'}>
                                      <Icon name={hostVerified ? 'check' : 'alert'} />
                                      <span>{hostVerified ? m.tasks.evidenceHostVerified : m.tasks.evidenceObservedUnverified}</span>
                                    </span>
                                    <span className={`badge ${VALIDATION_TONE[item.validation]}`}>
                                      {m.tasks.validations[item.validation] ?? item.validation}
                                    </span>
                                  </div>
                                  <span className="muted small">
                                    {m.tasks.digestPrefix}: <code title={item.contentSha256}>{shortDigest(item.contentSha256)}</code>
                                  </span>
                                </div>
                                <span>{item.summary}</span>
                                {item.artifactPath && (
                                  <span className="muted small"><code>{item.artifactPath}</code></span>
                                )}
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {taskWaivers.length > 0 && (
                        <ul className="mission-authority-waiver-list">
                          {taskWaivers.map(waiver => {
                            const revoked = Boolean(waiver.revokedAt);
                            return (
                              <li key={waiver.waiverId} className="mission-authority-waiver-item">
                                <div className="mission-authority-waiver-head">
                                  <div className="mission-authority-badges">
                                    <span className={`badge ${revoked ? 'subtle' : 'warn'}`}>
                                      {revoked ? m.waivers.revokedBadge : m.waivers.activeBadge}
                                    </span>
                                    <span className="badge subtle">{m.waivers.scopes[waiver.scope]}</span>
                                    <code>{waiver.policyVersion}</code>
                                  </div>
                                  {!revoked && canRevokeWaiver && (
                                    <button
                                      type="button"
                                      className="button small"
                                      disabled={busy !== null}
                                      onClick={() => onRevokeWaiver?.(waiver.waiverId)}
                                    >
                                      {busy === `revoke:${waiver.waiverId}` ? m.waivers.revoking : m.waivers.revoke}
                                    </button>
                                  )}
                                </div>
                                <span>
                                  <strong>{waiver.actor}</strong>: {waiver.reason}
                                </span>
                                <span className="muted small">
                                  {m.waivers.expiresAt}: <time dateTime={waiver.expiresAt}>{time(waiver.expiresAt)}</time>
                                </span>
                              </li>
                            );
                          })}
                        </ul>
                      )}

                      {canGrantWaiver && (
                        isWaiverOpen ? (
                          <form
                            className="mission-authority-waiver-form"
                            onSubmit={event => {
                              event.preventDefault();
                              onSubmitWaiver?.(gate.taskId);
                            }}
                          >
                            <div className="mission-authority-fields">
                              <div className="mission-authority-field">
                                <label htmlFor={waiverActorId}>{m.waivers.actorLabel}</label>
                                <input
                                  id={waiverActorId}
                                  type="text"
                                  maxLength={120}
                                  required
                                  value={waiverForm.actor}
                                  placeholder={m.waivers.actorPlaceholder}
                                  disabled={busy !== null}
                                  onChange={event => onWaiverFormChange?.({ ...waiverForm, actor: event.target.value })}
                                />
                              </div>
                              <div className="mission-authority-field">
                                <label htmlFor={waiverPolicyId}>{m.waivers.policyVersionLabel}</label>
                                <input
                                  id={waiverPolicyId}
                                  type="text"
                                  maxLength={64}
                                  required
                                  value={waiverForm.policyVersion}
                                  disabled={busy !== null}
                                  onChange={event => onWaiverFormChange?.({ ...waiverForm, policyVersion: event.target.value })}
                                />
                              </div>
                              <div className="mission-authority-field">
                                <label htmlFor={waiverScopeId}>{m.waivers.scopeLabel}</label>
                                <select
                                  id={waiverScopeId}
                                  value={waiverForm.scope}
                                  disabled={busy !== null}
                                  onChange={event => onWaiverFormChange?.({ ...waiverForm, scope: event.target.value as MissionWaiverScope })}
                                >
                                  <option value="dependency-release">{m.waivers.scopes['dependency-release']}</option>
                                  <option value="mission-acceptance">{m.waivers.scopes['mission-acceptance']}</option>
                                </select>
                              </div>
                              <div className="mission-authority-field">
                                <label htmlFor={waiverTtlId}>{m.waivers.ttlLabel}</label>
                                <select
                                  id={waiverTtlId}
                                  value={waiverForm.ttlMs}
                                  disabled={busy !== null}
                                  onChange={event => onWaiverFormChange?.({ ...waiverForm, ttlMs: Number(event.target.value) })}
                                >
                                  {WAIVER_TTL_OPTIONS.map(option => (
                                    <option key={option.key} value={option.ms}>
                                      {m.waivers.ttlOptions[option.key]}
                                    </option>
                                  ))}
                                </select>
                              </div>
                            </div>
                            <div className="mission-authority-field">
                              <label htmlFor={waiverReasonId}>{m.waivers.reasonLabel}</label>
                              <input
                                id={waiverReasonId}
                                type="text"
                                maxLength={1000}
                                required
                                value={waiverForm.reason}
                                placeholder={m.waivers.reasonPlaceholder}
                                disabled={busy !== null}
                                onChange={event => onWaiverFormChange?.({ ...waiverForm, reason: event.target.value })}
                              />
                            </div>
                            <div className="actions">
                              <button
                                type="submit"
                                className="button primary small"
                                disabled={busy !== null || !waiverForm.actor.trim() || !waiverForm.reason.trim() || !waiverForm.policyVersion.trim()}
                              >
                                {busy === `grant:${gate.taskId}` ? m.waivers.submitting : m.waivers.submit}
                              </button>
                              <button
                                type="button"
                                className="button small"
                                disabled={busy !== null}
                                onClick={() => onToggleWaiverForm?.(null)}
                              >
                                {m.waivers.cancelToggle}
                              </button>
                            </div>
                          </form>
                        ) : (
                          <div className="actions">
                            <button
                              type="button"
                              className="button small"
                              disabled={busy !== null}
                              onClick={() => onToggleWaiverForm?.(gate.taskId)}
                            >
                              <Icon name="shield" />
                              <span>{m.waivers.grantToggle}</span>
                            </button>
                          </div>
                        )
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </section>
        </>
      )}
    </section>
  );
}

/** Stateful container for mission reconciliation, evidence gates, and expiring waivers. */
export function MissionAuthorityPanel({
  t,
  language,
  agents,
  run,
  onRunUpdated,
}: {
  t: Messages;
  language: Language;
  agents: AgentHostApi;
  run: HostMissionRun;
  onRunUpdated?: (next: HostMissionRun) => void;
}) {
  const [overview, setOverview] = useState<MissionAuthorityOverview | null>(null);
  const [preview, setPreview] = useState<MissionReconciliationPreview | null>(null);
  const [committedReceipt, setCommittedReceipt] = useState<MissionReconciliationReceipt | null>(null);
  const [idempotentReplay, setIdempotentReplay] = useState(false);
  const [staleDigestBanner, setStaleDigestBanner] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reconcileError, setReconcileError] = useState<string | null>(null);
  const [waiverError, setWaiverError] = useState<string | null>(null);
  const [reloadVersion, setReloadVersion] = useState(0);
  const [reconciliationForm, setReconciliationForm] = useState<ReconciliationFormState>({
    decision: 'mark-failed',
    actor: 'operator',
    reason: '',
  });
  const [openWaiverTaskId, setOpenWaiverTaskId] = useState<string | null>(null);
  const [waiverForm, setWaiverForm] = useState<WaiverFormState>({
    actor: 'operator',
    reason: '',
    policyVersion: 'v1',
    scope: 'dependency-release',
    ttlMs: MISSION_WAIVER_DEFAULT_TTL_MS,
  });

  const mountedRef = useRef(true);
  const loadGenerationRef = useRef(0);
  const actionGenerationRef = useRef(0);
  const decisionKeyRef = useRef<{ signature: string; key: string }>({ signature: '', key: '' });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const overviewFn = agents.missionAuthorityOverview;
    if (typeof overviewFn !== 'function') return;
    let active = true;
    const generation = ++loadGenerationRef.current;
    const isCurrent = () => active && mountedRef.current && generation === loadGenerationRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const previewFn = run.state === 'recovering' ? agents.previewMissionReconciliation : undefined;
        const [nextOverview, nextPreview] = await Promise.all([
          overviewFn(run.sessionId, run.id),
          typeof previewFn === 'function' ? previewFn(run.sessionId, run.id) : Promise.resolve(null),
        ]);
        if (!isCurrent()) return;
        setOverview(nextOverview);
        if (nextPreview) setPreview(nextPreview);
        setStaleDigestBanner(false);
      } catch (failure) {
        if (!isCurrent()) return;
        setError(errorMessage(failure));
      } finally {
        if (isCurrent()) setLoading(false);
      }
    })();
    return () => {
      active = false;
    };
  }, [agents, run.id, run.sessionId, run.state, run.updatedAt, reloadVersion]);

  if (typeof agents.missionAuthorityOverview !== 'function') return null;

  const m = t.missionAuthority;

  const handlePreviewReconciliation = () => {
    const previewFn = agents.previewMissionReconciliation;
    if (typeof previewFn !== 'function') return;
    const generation = ++actionGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === actionGenerationRef.current;
    setBusy('preview');
    setReconcileError(null);
    void (async () => {
      try {
        const nextPreview = await previewFn(run.sessionId, run.id);
        if (!isCurrent()) return;
        setPreview(nextPreview);
      } catch (failure) {
        if (!isCurrent()) return;
        setReconcileError(errorMessage(failure));
      } finally {
        if (isCurrent()) setBusy(null);
      }
    })();
  };

  const handleCommitReconciliation = () => {
    const commitFn = agents.commitMissionReconciliation;
    const expectedDigest = overview?.reviewDigest ?? preview?.reviewDigest;
    if (typeof commitFn !== 'function' || !expectedDigest) return;
    const signature = `${run.id}:${expectedDigest}:${reconciliationForm.decision}`;
    if (decisionKeyRef.current.signature !== signature) {
      decisionKeyRef.current = {
        signature,
        key: `reconcile-${run.id.slice(0, 8)}-${expectedDigest.slice(0, 8)}-${reconciliationForm.decision}`,
      };
    }
    const generation = ++actionGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === actionGenerationRef.current;
    setBusy('commit');
    setReconcileError(null);
    setStaleDigestBanner(false);
    void (async () => {
      try {
        const result = await commitFn({
          sessionId: run.sessionId,
          missionId: run.id,
          expectedReviewDigest: expectedDigest,
          decisionKey: decisionKeyRef.current.key,
          decision: reconciliationForm.decision,
          actor: reconciliationForm.actor,
          reason: reconciliationForm.reason,
        });
        if (!isCurrent()) return;
        if (!result.ok) {
          if (result.code === 'stale-review-digest') {
            setStaleDigestBanner(true);
            setReconcileError(m.reconciliation.errors['stale-review-digest'] ?? result.detail);
          } else {
            setReconcileError(m.reconciliation.errors[result.code] ?? result.detail);
          }
          return;
        }
        setCommittedReceipt(result.receipt);
        setIdempotentReplay(result.idempotentReplay);
        setOverview(current => (current ? { ...current, reconciliationReceipt: result.receipt } : current));
        onRunUpdated?.(result.run);
        setReloadVersion(version => version + 1);
      } catch (failure) {
        if (!isCurrent()) return;
        setReconcileError(errorMessage(failure));
      } finally {
        if (isCurrent()) setBusy(null);
      }
    })();
  };

  const handleSubmitWaiver = (taskId: string) => {
    const grantFn = agents.grantMissionWaiver;
    if (typeof grantFn !== 'function' || !overview) return;
    const generation = ++actionGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === actionGenerationRef.current;
    setBusy(`grant:${taskId}`);
    setWaiverError(null);
    void (async () => {
      try {
        const nextOverview = await grantFn({
          sessionId: run.sessionId,
          missionId: run.id,
          taskId,
          expectedReviewDigest: overview.reviewDigest,
          actor: waiverForm.actor,
          reason: waiverForm.reason,
          policyVersion: waiverForm.policyVersion,
          scope: waiverForm.scope,
          ttlMs: waiverForm.ttlMs,
        });
        if (!isCurrent()) return;
        setOverview(nextOverview);
        setOpenWaiverTaskId(null);
        setWaiverForm(current => ({ ...current, reason: '' }));
      } catch (failure) {
        if (!isCurrent()) return;
        setWaiverError(errorMessage(failure));
      } finally {
        if (isCurrent()) setBusy(null);
      }
    })();
  };

  const handleRevokeWaiver = (waiverId: string) => {
    const revokeFn = agents.revokeMissionWaiver;
    if (typeof revokeFn !== 'function') return;
    const generation = ++actionGenerationRef.current;
    const isCurrent = () => mountedRef.current && generation === actionGenerationRef.current;
    setBusy(`revoke:${waiverId}`);
    setWaiverError(null);
    void (async () => {
      try {
        const nextOverview = await revokeFn(run.sessionId, run.id, waiverId);
        if (!isCurrent()) return;
        setOverview(nextOverview);
      } catch (failure) {
        if (!isCurrent()) return;
        setWaiverError(errorMessage(failure));
      } finally {
        if (isCurrent()) setBusy(null);
      }
    })();
  };

  return (
    <MissionAuthorityView
      t={t}
      language={language}
      run={run}
      overview={overview}
      preview={preview}
      reconciliationForm={reconciliationForm}
      committedReceipt={committedReceipt}
      idempotentReplay={idempotentReplay}
      staleDigestBanner={staleDigestBanner}
      openWaiverTaskId={openWaiverTaskId}
      waiverForm={waiverForm}
      loading={loading}
      busy={busy}
      error={error}
      reconcileError={reconcileError}
      waiverError={waiverError}
      canPreviewReconciliation={typeof agents.previewMissionReconciliation === 'function'}
      canCommitReconciliation={typeof agents.commitMissionReconciliation === 'function'}
      canGrantWaiver={typeof agents.grantMissionWaiver === 'function'}
      canRevokeWaiver={typeof agents.revokeMissionWaiver === 'function'}
      onRefresh={() => setReloadVersion(version => version + 1)}
      onPreviewReconciliation={handlePreviewReconciliation}
      onReconciliationFormChange={setReconciliationForm}
      onCommitReconciliation={handleCommitReconciliation}
      onToggleWaiverForm={taskId => {
        setWaiverError(null);
        setOpenWaiverTaskId(taskId);
      }}
      onWaiverFormChange={setWaiverForm}
      onSubmitWaiver={handleSubmitWaiver}
      onRevokeWaiver={handleRevokeWaiver}
    />
  );
}
