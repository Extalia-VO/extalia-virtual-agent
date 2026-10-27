import type {
  AgentAppConnection, AgentAppConnectPlan, AgentAppConnectResult, AgentAppId, AgentAppTestResult, AgentHostApi, HookIngestStatus,
} from '@extalia/platform';
import { useEffect, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { formatAgo, timeAgo } from '../office/overlay/activityBoard';
import { Icon } from '../ui/Icon';
import { AgentAppLogo } from '../ui/OriginMark';

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
  const lastAt = ingest?.lastEvents[connection.app] ?? connection.lastEventAt;
  if (lastAt) return t.agentApps.lastEvent(formatAgo(t.officeOverlay.ago, timeAgo(lastAt, nowMs)));
  if (connection.connected) return t.agentApps.waitingFirstEvent;
  return undefined;
}

export interface AgentAppPrerequisiteState {
  /** Hook events arrived, which means the app loaded the Extalia hooks. */
  eventsReceived: boolean;
  /** Codex must approve Extalia hooks in /hooks; undefined when no approval applies. */
  approval?: 'trusted' | 'pending';
}

/** A restart and a Codex /hooks approval are separate prerequisites; neither implies the other. */
export function agentAppPrerequisites(connection: Pick<AgentAppConnection, 'app' | 'trust'>, lastEventAt?: string): AgentAppPrerequisiteState {
  const { status } = connection.trust;
  const approval = connection.app !== 'codex' ? undefined
    : status === 'trusted' ? 'trusted'
      : status === 'untrusted' || status === 'modified' ? 'pending'
        : undefined;
  return { eventsReceived: Boolean(lastEventAt), ...(approval ? { approval } : {}) };
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

  const load = async () => {
    setError(undefined);
    try {
      const [nextConnections, nextIngest] = await Promise.all([agents.agentAppConnections(), agents.hookIngest()]);
      setConnections(nextConnections);
      setIngest(nextIngest);
      setDashboardUrl(nextIngest.hermesDashboardUrl ?? '');
    } catch (failure) {
      setConnections(current => current ?? []);
      setError(errorMessage(failure));
    }
  };

  useEffect(() => {
    if (initialConnections !== undefined) return;
    let active = true;
    Promise.all([agents.agentAppConnections(), agents.hookIngest()]).then(
      ([nextConnections, nextIngest]) => {
        if (!active) return;
        setConnections(nextConnections);
        setIngest(nextIngest);
        setDashboardUrl(nextIngest.hermesDashboardUrl ?? '');
      },
      failure => {
        if (!active) return;
        setConnections([]);
        setError(errorMessage(failure));
      },
    );
    return () => { active = false; };
  }, [agents, initialConnections]);

  useEffect(() => {
    if (!copiedKey) return;
    const timer = setTimeout(() => setCopiedKey(null), 1600);
    return () => clearTimeout(timer);
  }, [copiedKey]);

  const copy = (key: string, text: string) => {
    void writeClipboardText(text).then(() => setCopiedKey(key), () => setCopiedKey(null));
  };

  const toggleLabelsOnly = async (enabled: boolean) => {
    if (!agents.setHookPrivacy) return;
    setBusyKey('privacy:labels');
    setError(undefined);
    try {
      const nextIngest = await agents.setHookPrivacy({ labelsOnly: enabled });
      setIngest(nextIngest);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyKey(null);
    }
  };

  const saveDashboardUrl = async () => {
    if (!agents.setHookPrivacy) return;
    setBusyKey('privacy:dashboard');
    setError(undefined);
    setDashboardSaved(false);
    try {
      const nextIngest = await agents.setHookPrivacy({ hermesDashboardUrl: dashboardUrl.trim() || null });
      setIngest(nextIngest);
      setDashboardUrl(nextIngest.hermesDashboardUrl ?? '');
      setDashboardSaved(true);
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyKey(null);
    }
  };

  const applyPlan = async (app: AgentAppId, trustOverride?: boolean) => {
    setBusyKey(`apply:${app}`);
    setError(undefined);
    try {
      const result = await agents.applyAgentAppConnect(app, app === 'codex' ? { trust: trustOverride ?? trustCodex } : undefined);
      setApplied(previous => ({ ...previous, [app]: result }));
      setTests(previous => ({ ...previous, [app]: result.test }));
      setNotes(previous => ({ ...previous, [app]: undefined }));
      setPlan(null);
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyKey(null);
    }
  };

  const runTest = async (app: AgentAppId) => {
    setBusyKey(`test:${app}`);
    setError(undefined);
    try {
      const result = await agents.testAgentAppConnection(app);
      setTests(previous => ({ ...previous, [app]: result }));
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyKey(null);
    }
  };

  const disconnect = async (app: AgentAppId) => {
    setBusyKey(`disconnect:${app}`);
    setError(undefined);
    try {
      const result = await agents.disconnectAgentApp(app);
      setApplied(previous => ({ ...previous, [app]: undefined }));
      setTests(previous => ({ ...previous, [app]: undefined }));
      setNotes(previous => ({ ...previous, [app]: t.agentApps.disconnectedNote(result.removed) }));
      if (plan?.app === app) setPlan(null);
      await load();
    } catch (failure) {
      setError(errorMessage(failure));
    } finally {
      setBusyKey(null);
    }
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
                      disabled={busyKey !== null}
                      onClick={() => { void applyPlan(conn.app, conn.app === 'codex' ? true : undefined); }}
                    >
                      {busyKey === `apply:${conn.app}` ? t.agentApps.applying : t.agentApps.connect}
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
                      <button type="button" className="button small primary" disabled={busyKey !== null} onClick={() => { void applyPlan(conn.app); }}>
                        {busyKey === `apply:${conn.app}` ? t.agentApps.applying : t.agentApps.apply}
                      </button>
                      <button type="button" className="button small" disabled={busyKey !== null} onClick={() => setPlan(null)}>
                        {t.common.cancel}
                      </button>
                    </div>
                  </div>
                )}

                {conn.supported && (conn.connected || appResult) && (
                  <AgentAppPrerequisites t={t} connection={conn} lastEventAt={ingest?.lastEvents[conn.app] ?? conn.lastEventAt} />
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
                onChange={event => { setDashboardUrl(event.target.value); setDashboardSaved(false); }}
              />
            </label>
            <button type="button" className="button small" disabled={busyKey !== null} onClick={() => { void saveDashboardUrl(); }}>
              {t.common.save}
            </button>
            {dashboardSaved && <span className="badge ok" role="status">{t.agentApps.dashboardUrlSaved}</span>}
          </div>
        </div>
      )}

      <p className="note small"><Icon name="terminal" /><span>{t.agentApps.restartHint}</span></p>
      {error && <p role="alert" className="form-error"><Icon name="alert" />{error}</p>}
    </section>
  );
}
