import type {
  AgentHostApi,
  CommandSandboxStatus,
  ExactApprovalState,
  ExactApprovalView,
  WorkerLeaseSettlement,
  WorkerLeaseStatus,
  WorkerLeaseView,
} from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Language, Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import './executionSafety.css';

export interface ExecutionSafetyViewProps {
  t: Messages;
  language: Language;
  sandbox: CommandSandboxStatus | null | undefined;
  approvals: readonly ExactApprovalView[];
  leases: readonly WorkerLeaseView[];
  compact?: boolean;
  loading?: boolean;
  busyKey?: string | null;
  error?: string | null;
  onRefresh?: () => void;
  onRevoke?: (sessionId: string, approvalId: string) => void;
  onAcknowledgeLease?: (leaseId: string) => void;
}

function abbreviateDigest(digest: string): string {
  if (digest.startsWith('sha256:')) {
    const hex = digest.slice('sha256:'.length);
    return hex.length > 12 ? `sha256:${hex.slice(0, 12)}…` : digest;
  }
  return digest.length > 16 ? `${digest.slice(0, 16)}…` : digest;
}

function formatTimestamp(value: number | string, language: Language): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
}

const APPROVAL_STATE_TONE: Record<ExactApprovalState, string> = {
  pending: 'warn',
  granted: 'ok',
  rejected: 'error',
  consumed: 'ok',
  revoked: 'error',
  expired: 'warn',
};

const LEASE_STATUS_TONE: Record<WorkerLeaseStatus, string> = {
  active: 'ok',
  settled: '',
  quarantined: 'warn',
};

const LEASE_SETTLEMENT_TONE: Record<WorkerLeaseSettlement, string> = {
  completed: 'ok',
  failed: 'error',
  cancelled: 'warn',
  timed_out: 'error',
  unknown: 'warn',
};

function badgeClass(tone: string): string {
  return tone ? `execution-badge ${tone}` : 'execution-badge';
}

/** Pure, hook-free presentation for Execution Safety status, approval ledger, and worker lease recovery. */
export function ExecutionSafetyView({
  t,
  language,
  sandbox,
  approvals,
  leases,
  compact = false,
  loading = false,
  busyKey = null,
  error = null,
  onRefresh,
  onRevoke,
  onAcknowledgeLease,
}: ExecutionSafetyViewProps) {
  const m = t.executionSafety;
  const disabled = Boolean(loading || busyKey);
  const showLeases = !compact || leases.length > 0;

  return (
    <div className={`execution-safety-panel${compact ? ' compact' : ''}`}>
      <header className="execution-safety-head">
        <div>
          {compact
            ? <h3>{m.title}</h3>
            : <h2 id="settings-execution-safety">{m.title}</h2>}
          {!compact && <p className="muted">{m.lead}</p>}
        </div>
        {onRefresh && (
          <button
            type="button"
            className="icon-button small"
            aria-label={m.refresh}
            title={m.refresh}
            disabled={disabled}
            onClick={onRefresh}
          >
            <Icon name="refresh" className={loading ? 'spin' : ''} />
          </button>
        )}
      </header>

      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      <section className="execution-subcard" aria-label={m.sandbox.title}>
        <div className="execution-subcard-head">
          {compact ? <h4>{m.sandbox.title}</h4> : <h3>{m.sandbox.title}</h3>}
          {sandbox && (
            <span className={badgeClass(sandbox.supported ? 'ok' : 'error')}>
              <Icon name={sandbox.supported ? 'check' : 'alert'} />
              {sandbox.supported ? m.sandbox.verified : m.sandbox.failClosed}
            </span>
          )}
        </div>

        {sandbox === undefined ? (
          <p className="muted small" role={loading ? 'status' : undefined}>
            {loading ? m.sandbox.loading : m.sandbox.unsupportedHost}
          </p>
        ) : sandbox === null ? (
          <p className="muted small">{m.sandbox.unsupportedHost}</p>
        ) : (
          <>
            <div className="execution-badge-row">
              <span className="execution-badge">{m.sandbox.kindLabel[sandbox.kind]}</span>
              <span className="execution-badge">{m.sandbox.platform}: {sandbox.platform}</span>
              {sandbox.networkAccess === 'denied' && (
                <span className="execution-badge">
                  <Icon name="shield" />
                  {m.sandbox.networkDenied}
                </span>
              )}
            </div>
            {sandbox.supported && sandbox.verifiedAt && (
              <p className="muted small">
                {m.sandbox.verifiedAt}: <time dateTime={sandbox.verifiedAt}>{formatTimestamp(sandbox.verifiedAt, language)}</time>
              </p>
            )}
            {!sandbox.supported && (
              <p className="execution-fail-closed" role="status">
                <Icon name="alert" />
                <span>
                  <strong>{m.sandbox.unavailableReason}:</strong> {sandbox.reason || m.sandbox.failClosed}
                </span>
              </p>
            )}
          </>
        )}
      </section>

      <section className="execution-subcard" aria-label={m.approvals.title}>
        <div className="execution-subcard-head">
          {compact ? <h4>{m.approvals.title}</h4> : <h3>{m.approvals.title}</h3>}
          <span className="execution-badge">{approvals.length}</span>
        </div>
        {!compact && <p className="muted small">{m.approvals.lead}</p>}
        {approvals.length === 0 ? (
          <p className="muted small">{compact ? m.approvals.sessionEmpty : m.approvals.empty}</p>
        ) : (
          <ul className="execution-list">
            {approvals.map(item => {
              const revocable = item.state === 'pending' || item.state === 'granted';
              const revoking = busyKey === `revoke:${item.approvalId}`;
              return (
                <li key={item.approvalId} className="execution-item">
                  <div className="execution-item-head">
                    <div className="execution-item-title">
                      <code>{item.toolName}</code>
                      <span className="execution-badge">{m.approvals.access[item.access]}</span>
                      <span className={badgeClass(APPROVAL_STATE_TONE[item.state])}>
                        {m.approvals.state[item.state]}
                      </span>
                    </div>
                    {revocable && onRevoke && (
                      <div className="execution-item-actions">
                        <button
                          type="button"
                          className="button small danger"
                          disabled={disabled}
                          onClick={() => onRevoke(item.sessionId, item.approvalId)}
                        >
                          {revoking ? m.approvals.revoking : m.approvals.revoke}
                        </button>
                      </div>
                    )}
                  </div>
                  {item.target && (
                    <div className="execution-item-meta">
                      <span>{m.approvals.target}: <code>{item.target}</code></span>
                    </div>
                  )}
                  <div className="execution-item-meta">
                    <span>
                      {m.approvals.digest}: <code title={item.actionDigest}>{abbreviateDigest(item.actionDigest)}</code>
                    </span>
                    <span>{m.approvals.generation} {item.generation}</span>
                    <span>{m.approvals.expiresAt}: {formatTimestamp(item.expiresAt, language)}</span>
                    {item.revokedAt !== undefined && (
                      <span>{m.approvals.revokedAt}: {formatTimestamp(item.revokedAt, language)}</span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {showLeases && (
        <section className="execution-subcard" aria-label={m.leases.title}>
          <div className="execution-subcard-head">
            {compact ? <h4>{m.leases.title}</h4> : <h3>{m.leases.title}</h3>}
            <span className="execution-badge">{leases.length}</span>
          </div>
          {!compact && <p className="muted small">{m.leases.lead}</p>}
          {leases.length === 0 ? (
            <p className="muted small">{m.leases.empty}</p>
          ) : (
            <ul className="execution-list">
              {leases.map(lease => {
                const acknowledging = busyKey === `lease:${lease.leaseId}`;
                return (
                  <li key={lease.leaseId} className="execution-item">
                    <div className="execution-item-head">
                      <div className="execution-item-title">
                        <code>{lease.taskId}</code>
                        <span className={badgeClass(LEASE_STATUS_TONE[lease.status])}>
                          {m.leases.status[lease.status]}
                        </span>
                        {lease.settlement && (
                          <span className={badgeClass(LEASE_SETTLEMENT_TONE[lease.settlement])}>
                            {m.leases.settlement[lease.settlement]}
                          </span>
                        )}
                      </div>
                      {lease.status === 'quarantined' && onAcknowledgeLease && (
                        <div className="execution-item-actions">
                          <button
                            type="button"
                            className="button small"
                            disabled={disabled}
                            onClick={() => onAcknowledgeLease(lease.leaseId)}
                          >
                            {acknowledging ? m.leases.acknowledging : m.leases.acknowledge}
                          </button>
                        </div>
                      )}
                    </div>
                    <div className="execution-item-meta">
                      <span>{m.leases.fencingToken}: <code>#{lease.fencingToken}</code></span>
                    </div>
                    {lease.quarantineReason && (
                      <p className="execution-quarantine-note">
                        <Icon name="alert" />
                        <span>
                          <strong>{m.leases.quarantineNote}:</strong> {lease.quarantineReason}
                        </span>
                      </p>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </section>
      )}
    </div>
  );
}

/** Stateful Execution Safety panel that feature-detects optional host RPCs and guards async updates. */
export function ExecutionSafetyPanel({
  t,
  language,
  agents,
  sessionId,
  compact = false,
}: {
  t: Messages;
  language: Language;
  agents: AgentHostApi;
  sessionId?: string;
  compact?: boolean;
}) {
  const [sandbox, setSandbox] = useState<CommandSandboxStatus | null | undefined>(undefined);
  const [approvals, setApprovals] = useState<ExactApprovalView[]>([]);
  const [leases, setLeases] = useState<WorkerLeaseView[]>([]);
  const [loading, setLoading] = useState(false);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const busyRef = useRef(false);
  const lastSessionRef = useRef<string | undefined>(sessionId);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const hasSandbox = typeof agents.commandSandboxStatus === 'function';
  const hasApprovals = typeof agents.listApprovals === 'function';
  const hasLeases = typeof agents.listWorkerLeases === 'function';
  const hasAnyApi = hasSandbox || hasApprovals || hasLeases;

  useEffect(() => {
    if (!hasAnyApi) return;
    let active = true;
    const generation = ++generationRef.current;
    const sessionChanged = lastSessionRef.current !== sessionId;
    lastSessionRef.current = sessionId;
    const isCurrent = () => active && mountedRef.current && generation === generationRef.current;

    void (async () => {
      if (sessionChanged) setApprovals([]);
      setLoading(true);
      setError(null);
      const [sandboxRes, approvalsRes, leasesRes] = await Promise.allSettled([
        hasSandbox ? agents.commandSandboxStatus!() : Promise.resolve(null),
        hasApprovals ? agents.listApprovals!(sessionId) : Promise.resolve([] as ExactApprovalView[]),
        hasLeases ? agents.listWorkerLeases!() : Promise.resolve([] as WorkerLeaseView[]),
      ]);

      if (!isCurrent()) return;

      const failures: string[] = [];
      if (sandboxRes.status === 'fulfilled') setSandbox(sandboxRes.value);
      else failures.push(errorMessage(sandboxRes.reason));

      if (approvalsRes.status === 'fulfilled') setApprovals(approvalsRes.value);
      else failures.push(errorMessage(approvalsRes.reason));

      if (leasesRes.status === 'fulfilled') setLeases(leasesRes.value);
      else failures.push(errorMessage(leasesRes.reason));

      setError(failures[0] ?? null);
      setLoading(false);
    })();

    return () => {
      active = false;
    };
  }, [agents, sessionId, refreshTick, hasAnyApi, hasSandbox, hasApprovals, hasLeases]);

  const handleRefresh = () => {
    setRefreshTick(value => value + 1);
  };

  const handleRevoke = typeof agents.revokeApproval === 'function'
    ? (targetSessionId: string, approvalId: string) => {
        if (busyRef.current) return;
        busyRef.current = true;
        const actionGeneration = generationRef.current;
        void (async () => {
          setBusyKey(`revoke:${approvalId}`);
          setError(null);
          try {
            await agents.revokeApproval!(targetSessionId, approvalId);
            if (!mountedRef.current || actionGeneration !== generationRef.current) return;
            setRefreshTick(value => value + 1);
          } catch (failure) {
            if (!mountedRef.current || actionGeneration !== generationRef.current) return;
            setError(errorMessage(failure));
          } finally {
            busyRef.current = false;
            if (mountedRef.current) setBusyKey(null);
          }
        })();
      }
    : undefined;

  const handleAcknowledgeLease = typeof agents.reconcileWorkerLease === 'function'
    ? (leaseId: string) => {
        if (busyRef.current) return;
        busyRef.current = true;
        const actionGeneration = generationRef.current;
        void (async () => {
          setBusyKey(`lease:${leaseId}`);
          setError(null);
          try {
            await agents.reconcileWorkerLease!(leaseId, 'acknowledge');
            if (!mountedRef.current || actionGeneration !== generationRef.current) return;
            setRefreshTick(value => value + 1);
          } catch (failure) {
            if (!mountedRef.current || actionGeneration !== generationRef.current) return;
            setError(errorMessage(failure));
          } finally {
            busyRef.current = false;
            if (mountedRef.current) setBusyKey(null);
          }
        })();
      }
    : undefined;

  return (
    <ExecutionSafetyView
      t={t}
      language={language}
      sandbox={hasAnyApi ? sandbox : null}
      approvals={hasAnyApi ? approvals : []}
      leases={hasAnyApi ? leases : []}
      compact={compact}
      loading={hasAnyApi && loading}
      busyKey={busyKey}
      error={error}
      onRefresh={handleRefresh}
      onRevoke={handleRevoke}
      onAcknowledgeLease={handleAcknowledgeLease}
    />
  );
}
