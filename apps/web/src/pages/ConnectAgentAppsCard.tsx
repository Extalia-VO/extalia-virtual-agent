import type {
  AgentAppConnection, AgentAppConnectPlan, AgentAppConnectResult, AgentAppId, AgentAppTestResult, AgentHostApi, HookIngestStatus,
} from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { formatAgo, timeAgo } from '../office/overlay/activityBoard';
import { Icon } from '../ui/Icon';
import { AgentAppLogo } from '../ui/OriginMark';
import { createConnectAppRefresh } from './connectAppRefresh';

export function connectCommand(app: AgentAppId): string {
  return `npx -y extalia-vo@latest connect ${app}`;
}

export function connectPrompt(app: AgentAppId): string {
  return `Run \`npx -y extalia-vo@latest connect ${app} --dry-run\` and show me its output verbatim. Do not change anything yet. If I reply "apply", run it again with \`--yes\` and tell me the backup path and the undo command.`;
}

export function formatLastEvent(
  t: Messages,
  connection: AgentAppConnection,
  ingest?: HookIngestStatus | null,
  nowMs = Date.now(),
): string | undefined {
  const lastAt = lastConnectionEvent(connection, ingest);
  if (lastAt) return t.agentApps.lastEvent(formatAgo(t.officeOverlay.ago, timeAgo(lastAt, nowMs)));
  if (connection.connected) return t.agentApps.waitingFirstEvent;
  return undefined;
}

/** History from before the current configuration cannot prove that revision loaded. */
export function lastConnectionEvent(connection: AgentAppConnection, ingest?: HookIngestStatus | null): string | undefined {
  const revision = connection.configuredAt ? Date.parse(connection.configuredAt) : -Infinity;
  return [ingest?.lastEvents[connection.app], connection.lastEventAt]
    .filter((at): at is string => Boolean(at) && Number.isFinite(Date.parse(at!)) && Date.parse(at!) >= revision)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0];
}

export interface AgentAppPrerequisiteState {
  /** Hook events arrived, which means the app loaded the Extalia hooks. */
  eventsReceived: boolean;
  /** Codex must approve Extalia hooks in /hooks; undefined when no approval applies. */
  approval?: 'trusted' | 'pending';
}

/** A restart and a Codex /hooks approval are separate prerequisites; neither implies the other. */
export function agentAppPrerequisites(connection: Pick<AgentAppConnection, 'app' | 'trust' | 'configuredAt'>, lastEventAt?: string): AgentAppPrerequisiteState {
  const { status } = connection.trust;
  const approval = connection.app !== 'codex' ? undefined
    : status === 'trusted' ? 'trusted'
      : status === 'untrusted' || status === 'modified' ? 'pending'
        : undefined;
  const receivedAt = lastEventAt ? Date.parse(lastEventAt) : NaN;
  return { eventsReceived: Number.isFinite(receivedAt) && (!connection.configuredAt || receivedAt >= Date.parse(connection.configuredAt)), ...(approval ? { approval } : {}) };
}

function AgentAppPrerequisites({ t, connection, lastEventAt }: { t: Messages; connection: AgentAppConnection; lastEventAt?: string }) {
  const state = agentAppPrerequisites(connection, lastEventAt);
  return (
    <section className="connect-app-prereqs" aria-label={t.agentApps.prerequisites.title}>
      <strong className="small">{t.agentApps.prerequisites.title}</strong>
      <ul>
        <li>
          <span className="small">{t.agentApps.prerequisites.restart(connection.label)}</span>
          <span className={`badge ${state.eventsReceived ? 'ok' : 'warn'}`}>{state.eventsReceived ? t.agentApps.prerequisites.restartDone : t.agentApps.prerequisites.restartWaiting}</span>
        </li>
        {state.approval && (
          <li>
            <span className="small">{t.agentApps.prerequisites.approve}</span>
            <span className={`badge ${state.approval === 'trusted' ? 'ok' : 'warn'}`}>{t.agentApps.trust[connection.trust.status]}</span>
          </li>
        )}
      </ul>
      <p className="muted small">{t.agentApps.prerequisites.note}</p>
    </section>
  );
}

async function writeClipboardText(text: string): Promise<void> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    return navigator.clipboard.writeText(text);
  }
  if (typeof document === 'undefined') return;
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try { document.execCommand('copy'); } finally { area.remove(); }
}

export function ConnectAgentAppsCard({
  t,
  agents,
  initialConnections,
  initialIngest,
  initialPlan,
  compact = false,
  onClose,
}: {
  t: Messages;
  agents: AgentHostApi;
  initialConnections?: AgentAppConnection[];
  initialIngest?: HookIngestStatus | null;
  initialPlan?: AgentAppConnectPlan | null;
  compact?: boolean;
  onClose?: () => void;
}) {
  const [connections, setConnections] = useState<AgentAppConnection[] | null>(initialConnections ?? null);
  const [ingest, setIngest] = useState<HookIngestStatus | null>(initialIngest ?? null);
  const [dashboardUrl, setDashboardUrl] = useState<string>(initialIngest?.hermesDashboardUrl ?? '');
  const [dashboardSaved, setDashboardSaved] = useState(false);
  const [plan, setPlan] = useState<AgentAppConnectPlan | null>(initialPlan ?? null);
  const [trustCodex, setTrustCodex] = useState(false);
  const [applied, setApplied] = useState<Record<string, AgentAppConnectResult | undefined>>({});
  const [tests, setTests] = useState<Record<string, AgentAppTestResult | undefined>>({});
  const [notes, setNotes] = useState<Record<string, string | undefined>>({});
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  const dashboardDirty = useRef(false);
  const busy = useRef(false);
  const lifecycle = useRef<{ active: boolean; refresh?: ReturnType<typeof createConnectAppRefresh> }>({ active: true });

  useEffect(() => {
    const scope: typeof lifecycle.current = { active: true };
    const refresh = createConnectAppRefresh({
      agents,
      connections: setConnections,
      ingest: next => {
        setIngest(next);
        if (!dashboardDirty.current) setDashboardUrl(next.hermesDashboardUrl ?? '');
      },
      error: failure => {
        setConnections(current => current ?? []);
        setError(errorMessage(failure));
      },
    });
    scope.refresh = refresh;
    lifecycle.current = scope;
    if (initialConnections === undefined) void refresh.refresh();
    let focusTimer: ReturnType<typeof setTimeout> | undefined;
    const visible = () => typeof document === 'undefined' || document.visibilityState !== 'hidden';
    const scheduleFocusRefresh = () => {
      if (focusTimer) clearTimeout(focusTimer);
      if (visible()) focusTimer = setTimeout(() => { void refresh.refresh(); }, 200);
    };
    // Full connections include Codex trust RPCs. Only explicit refresh/focus runs those;
    // cheap ingest reads keep all five apps' real event timestamps current while visible.
    const timer = setInterval(() => { if (visible()) void refresh.refresh(false); }, 2000);
    if (typeof window !== 'undefined') window.addEventListener('focus', scheduleFocusRefresh);
    if (typeof document !== 'undefined') document.addEventListener('visibilitychange', scheduleFocusRefresh);
    return () => {
      scope.active = false;
      refresh.dispose();
      clearInterval(timer);
      if (focusTimer) clearTimeout(focusTimer);
      if (typeof window !== 'undefined') window.removeEventListener('focus', scheduleFocusRefresh);
      if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', scheduleFocusRefresh);
    };
  }, [agents, initialConnections]);

  const load = async () => {
    setError(undefined);
    await lifecycle.current.refresh?.refresh();
  };

  const perform = async (key: string, changesStatus: boolean, action: (active: () => boolean) => Promise<void>) => {
    const scope = lifecycle.current;
    if (busy.current || !scope.active) return;
    busy.current = true;
    setBusyKey(key);
    setError(undefined);
    if (changesStatus) scope.refresh?.pause();
    try {
      await action(() => scope.active);
    } catch (failure) {
      if (scope.active) setError(errorMessage(failure));
    } finally {
      if (scope.active && changesStatus) await scope.refresh?.resume();
      // An old host's reply is ignored, but its completed operation must release
      // the shared action guard after a capability rebind. Unmounted UI stays untouched.
      busy.current = false;
      if (lifecycle.current.active) setBusyKey(null);
    }
  };

  useEffect(() => {
    if (!copiedKey) return;
    const timer = setTimeout(() => setCopiedKey(null), 1600);
    return () => clearTimeout(timer);
  }, [copiedKey]);

  const copy = (key: string, text: string) => {
    const scope = lifecycle.current;
    void writeClipboardText(text).then(
      () => { if (scope.active) setCopiedKey(key); },
      () => { if (scope.active) setCopiedKey(null); },
    );
  };

  const toggleLabelsOnly = async (enabled: boolean) => {
    if (!agents.setHookPrivacy) return;
    await perform('privacy:labels', true, async active => {
      const nextIngest = await agents.setHookPrivacy({ labelsOnly: enabled });
      if (active()) setIngest(nextIngest);
    });
  };

  const saveDashboardUrl = async () => {
    if (!agents.setHookPrivacy) return;
    await perform('privacy:dashboard', true, async active => {
      setDashboardSaved(false);
      const nextIngest = await agents.setHookPrivacy({ hermesDashboardUrl: dashboardUrl.trim() || null });
      if (!active()) return;
      setIngest(nextIngest);
      dashboardDirty.current = false;
      setDashboardUrl(nextIngest.hermesDashboardUrl ?? '');
      setDashboardSaved(true);
    });
  };

  const previewPlan = async (app: AgentAppId) => {
    await perform(`plan:${app}`, false, async active => {
      setPlan(null);
      setTrustCodex(false);
      const nextPlan = await agents.planAgentAppConnect(app);
      if (active()) setPlan(nextPlan);
    });
  };

  const applyPlan = async (app: AgentAppId) => {
    if (plan?.app !== app || plan.nodeStatus === 'missing') return;
    await perform(`apply:${app}`, true, async active => {
      const connectOptions = app === 'codex' || plan.previewDigest !== undefined ? {
        ...(app === 'codex' ? { trust: trustCodex } : {}),
        ...(plan.previewDigest !== undefined ? { expectedPreviewDigest: plan.previewDigest } : {}),
      } : undefined;
      const result = await agents.applyAgentAppConnect(app, connectOptions);
      if (!active()) return;
      setApplied(previous => ({ ...previous, [app]: result }));
      setTests(previous => ({ ...previous, [app]: result.test }));
      setNotes(previous => ({ ...previous, [app]: undefined }));
      setPlan(null);
    });
  };

  const runTest = async (app: AgentAppId) => {
    await perform(`test:${app}`, true, async active => {
      const result = await agents.testAgentAppConnection(app);
      if (active()) setTests(previous => ({ ...previous, [app]: result }));
    });
  };

  const disconnect = async (app: AgentAppId) => {
    await perform(`disconnect:${app}`, true, async active => {
      const result = await agents.disconnectAgentApp(app);
      if (!active()) return;
      setApplied(previous => ({ ...previous, [app]: undefined }));
      setTests(previous => ({ ...previous, [app]: undefined }));
      setNotes(previous => ({ ...previous, [app]: t.agentApps.disconnectedNote(result.removed) }));
      if (plan?.app === app) setPlan(null);
      // Disconnect owns hooks only; separately enabled transcript observation keeps its setting.
    });
  };

  return (
    <section className={`card settings-section connect-apps-card ${compact ? 'compact' : ''}`} aria-labelledby="connect-agent-apps-heading">
      <div className="section-head">
        <div>
          <h2 id="connect-agent-apps-heading">{t.agentApps.title}</h2>
          <p className="muted small">{t.agentApps.lead}</p>
        </div>
        <div className="row-actions">
          <button type="button" className="button small" disabled={busyKey !== null} onClick={() => { void load(); }}>
            <Icon name="refresh" />{t.agentApps.refresh}
          </button>
          {onClose && (
            <button type="button" className="icon-button small" aria-label={t.common.close} onClick={onClose}>
              <Icon name="close" />
            </button>
          )}
        </div>
      </div>
      <p className="muted small">{t.agentApps.terminalHint}</p>

      {!connections ? (
        <p className="muted" role="status">{t.common.loading}</p>
      ) : (
        <ul className="entity-list connect-app-list">
          {connections.map(conn => {
            const eventSummary = formatLastEvent(t, conn, ingest);
            const commandKey = `cmd:${conn.app}`;
            const promptKey = `prompt:${conn.app}`;
            const canDisconnect = conn.connected || conn.state === 'partial' || conn.state === 'stale';
            const appResult = applied[conn.app];
            const testResult = tests[conn.app];
            const appNote = notes[conn.app];
            const badgeClass = !conn.supported ? '' : conn.state === 'connected' ? 'ok' : conn.state === 'not-connected' ? '' : 'warn';
            const badgeLabel = !conn.supported ? t.agentApps.states.comingSoon : t.agentApps.states[conn.state];
            const trustLabel = conn.app === 'codex' && conn.trust.status !== 'not-applicable' && conn.trust.status !== 'unknown'
              ? t.agentApps.trust[conn.trust.status]
              : '';

            return (
              <li key={conn.app} className={`entity connect-app-row ${!conn.supported ? 'disabled' : ''}`}>
                <span className="connect-app-mark" data-app={conn.app} aria-hidden="true">
                  <AgentAppLogo app={conn.app} size={20} />
                </span>
                <div className="entity-main">
                  <div className="connect-app-title">
                    <strong>{conn.label}{conn.version ? ` ${conn.version}` : ''}</strong>
                    <span className={`badge ${badgeClass}`}>{badgeLabel}</span>
                    {conn.supported && !conn.installed && <span className="badge">{t.agentApps.notInstalled}</span>}
                    {trustLabel && <span className={`badge ${conn.trust.status === 'trusted' ? 'ok' : 'warn'}`}>{trustLabel}</span>}
                  </div>
                  {eventSummary && <span className="muted small" role="status">{eventSummary}</span>}
                  {conn.configPath && <code className="entity-path">{conn.configPath}</code>}
                  {conn.supported && <code className="connect-app-command">{connectCommand(conn.app)}</code>}
                  {conn.nodeStatus === 'missing' && <span className="muted small">{t.agentApps.nodeMissing}</span>}
                  {conn.warnings.map(warning => (
                    <span key={warning} className="muted small">{warning}</span>
                  ))}
                </div>

                {conn.supported && (
                  <div className="row-actions">
                    <button type="button" className="button small" onClick={() => copy(commandKey, connectCommand(conn.app))}>
                      <Icon name={copiedKey === commandKey ? 'check' : 'copy'} />
                      <span aria-live="polite">{copiedKey === commandKey ? t.agentApps.copied : t.agentApps.copyCommand}</span>
                    </button>
                    <button type="button" className="button small" onClick={() => copy(promptKey, connectPrompt(conn.app))}>
                      <Icon name={copiedKey === promptKey ? 'check' : 'terminal'} />
                      <span aria-live="polite">{copiedKey === promptKey ? t.agentApps.copied : t.agentApps.copyPrompt}</span>
                    </button>
                    <button
                      type="button"
                      className={`button small ${conn.connected ? '' : 'primary'}`}
                      disabled={busyKey !== null || conn.nodeStatus === 'missing'}
                      onClick={() => { void previewPlan(conn.app); }}
                    >
                      {busyKey === `plan:${conn.app}` ? t.common.loading : t.agentApps.connect}
                    </button>
                    {conn.connected && (
                      <button type="button" className="button small" disabled={busyKey !== null} onClick={() => { void runTest(conn.app); }}>
                        {busyKey === `test:${conn.app}` ? t.agentApps.testing : t.agentApps.test}
                      </button>
                    )}
                    {canDisconnect && (
                      <button type="button" className="button small" disabled={busyKey !== null} onClick={() => { void disconnect(conn.app); }}>
                        {busyKey === `disconnect:${conn.app}` ? t.agentApps.disconnecting : t.agentApps.disconnect}
                      </button>
                    )}
                  </div>
                )}

                {plan?.app === conn.app && (
                  <div className="connect-app-preview" role="region" aria-label={t.agentApps.previewTitle(conn.label)}>
                    <strong>{t.agentApps.previewTitle(conn.label)}</strong>
                    {plan.diff ? (
                      <pre className="tool-output connect-app-diff">{plan.diff}</pre>
                    ) : (
                      <p className="muted small">{t.agentApps.noChanges}</p>
                    )}
                    {plan.nodeStatus === 'missing' && <p className="warning">{t.agentApps.nodeMissing}</p>}
                    {plan.warnings.map(warning => (
                      <p key={warning} className="warning"><Icon name="alert" /><span>{warning}</span></p>
                    ))}
                    {conn.app === 'codex' && plan.needsTrust && (
                      <label className="check-row small">
                        <input type="checkbox" checked={trustCodex} onChange={event => setTrustCodex(event.target.checked)} />
                        <span>{t.agentApps.trustConsent}</span>
                      </label>
                    )}
                    <div className="row-actions">
                      <button type="button" className="button small primary" disabled={busyKey !== null || plan.nodeStatus === 'missing' || conn.nodeStatus === 'missing'} onClick={() => { void applyPlan(conn.app); }}>
                        {busyKey === `apply:${conn.app}` ? t.agentApps.applying : t.agentApps.apply}
                      </button>
                      <button type="button" className="button small" disabled={busyKey !== null} onClick={() => setPlan(null)}>
                        {t.common.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {conn.supported && (conn.connected || appResult) && (
                  <AgentAppPrerequisites t={t} connection={conn} lastEventAt={lastConnectionEvent(conn, ingest)} />
                )}

                {appResult && (
                  <div className="entity-note connect-app-result" role="status">
                    {appResult.backupPath && <p className="muted small">{t.agentApps.backupLabel}: <code>{appResult.backupPath}</code></p>}
                    <p className="muted small">{t.agentApps.undoLabel}: <code>{appResult.undoCommand}</code></p>
                  </div>
                )}

                {testResult && (
                  <p className="entity-note" role="status">
                    <span className={`status ${testResult.ok ? 'ok' : 'error'}`}>
                      <Icon name={testResult.ok ? 'check' : 'alert'} />{testResult.message}
                    </span>
                  </p>
                )}

                {appNote && <p className="entity-note muted small" role="status">{appNote}</p>}
              </li>
            );
          })}
        </ul>
      )}

      {!compact && (
        <div className="connect-apps-options">
          <label className="check-row small">
            <input
              type="checkbox"
              checked={Boolean(ingest?.labelsOnly)}
              disabled={busyKey !== null}
              onChange={event => { void toggleLabelsOnly(event.target.checked); }}
            />
            <span>{t.agentApps.labelsOnlyLabel}</span>
          </label>
          <div className="field-row small">
            <label>
              <span className="muted small">{t.agentApps.dashboardUrlLabel}</span>
              <input
                type="url"
                value={dashboardUrl}
                placeholder={t.agentApps.dashboardUrlPlaceholder}
                disabled={busyKey !== null}
                onChange={event => { dashboardDirty.current = true; setDashboardUrl(event.target.value); setDashboardSaved(false); }}
              />
            </label>
            <button type="button" className="button small" disabled={busyKey !== null} onClick={() => { void saveDashboardUrl(); }}>
              {t.common.save}
            </button>
            {dashboardSaved && <span className="badge ok" role="status">{t.agentApps.dashboardUrlSaved}</span>}
          </div>
        </div>
      )}

      <p className="muted small">{t.agentApps.disconnectHint}</p>
      <p className="note small"><Icon name="terminal" /><span>{t.agentApps.restartHint}</span></p>
      {error && <p role="alert" className="form-error"><Icon name="alert" />{error}</p>}
    </section>
  );
}
