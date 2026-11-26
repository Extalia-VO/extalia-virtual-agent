import type {
  AgentHostApi,
  ConnectorHealth,
  ConnectorHealthDimension,
  GatewayAudience,
  GatewayConnectorState,
  GatewayLinkChallengeView,
  GatewayOverview,
  GatewayPermissionBand,
  GatewayProvider,
  GatewayRouteMode,
  HostState,
  WorkspaceReportsInboxView,
} from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { ChatSystemReportCard } from '../../chat/ChatSystemReportCard';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { CopyButton } from '../../ui/CopyButton';
import { Icon } from '../../ui/Icon';
import { Select } from '../../ui/Select';
import './gatewaySettings.css';

const HEALTH_DIMENSIONS = ['transport', 'host', 'runtime', 'progress', 'notification'] as const;
const PERMISSION_BANDS: readonly GatewayPermissionBand[] = [
  'read_status',
  'view_reports',
  'submit_prompt',
  'manage_own_session',
  'manage_schedule',
  'manage_gateway_route',
  'approve_sensitive_action',
];
const PROVIDERS: readonly GatewayProvider[] = ['discord', 'telegram', 'whatsapp'];
const ROUTE_MODES: readonly GatewayRouteMode[] = ['explicit-only', 'thread-new-session', 'reuse-pinned'];
const AUDIENCES: readonly GatewayAudience[] = ['private', 'team', 'public'];

function connectorStatusTone(status: GatewayConnectorState): string {
  if (status === 'connected') return 'ok';
  if (status === 'degraded' || status === 'configuring') return 'warn';
  if (status === 'blocked' || status === 'revoked') return 'error';
  return 'subtle';
}

function healthChipTone(dimension: ConnectorHealthDimension): string {
  if (dimension.status === 'healthy') return 'ok';
  if (dimension.status === 'degraded' || dimension.status === 'verification_insufficient') return 'warn';
  if (dimension.status === 'blocked') return 'error';
  return '';
}

function defaultHealthDimensions(status: GatewayConnectorState): Pick<ConnectorHealth, typeof HEALTH_DIMENSIONS[number]> {
  const dimStatus = status === 'connected' ? 'healthy' : status === 'degraded' ? 'degraded' : status === 'blocked' ? 'blocked' : status === 'disabled' ? 'disconnected' : 'unknown';
  return {
    transport: { status: dimStatus },
    host: { status: 'healthy' },
    runtime: { status: 'unknown' },
    progress: { status: 'unknown' },
    notification: { status: dimStatus },
  };
}

type Props = {
  t: Messages;
  agents: AgentHostApi;
  state: HostState;
  initialOverview?: GatewayOverview;
  initialInbox?: WorkspaceReportsInboxView;
};

export function GatewaySettingsSection(props: Props) {
  const [scope, setScope] = useState({
    agents: props.agents,
    profile: props.state.profile.id,
    directory: props.state.dataDirectory,
    revision: 0,
  });
  const changed =
    scope.agents !== props.agents
    || scope.profile !== props.state.profile.id
    || scope.directory !== props.state.dataDirectory;
  const revision = scope.revision + (changed ? 1 : 0);
  if (changed) {
    setScope({
      agents: props.agents,
      profile: props.state.profile.id,
      directory: props.state.dataDirectory,
      revision,
    });
  }
  return <GatewaySettingsContent key={revision} {...props} />;
}

function GatewaySettingsContent({ t, agents, state, initialOverview, initialInbox }: Props) {
  const g = t.gatewaySettings;
  const headingId = useId();
  const owner = useRef({ active: true, busy: false });
  useEffect(() => {
    const current = owner.current;
    current.active = true;
    return () => { current.active = false; };
  }, []);

  const supported =
    typeof agents.gatewayOverview === 'function'
    && typeof agents.saveGatewayConnector === 'function'
    && typeof agents.setGatewayConnectorStatus === 'function'
    && typeof agents.issueGatewayLinkChallenge === 'function'
    && typeof agents.confirmGatewayPrincipalLink === 'function'
    && typeof agents.revokeGatewayPrincipalLink === 'function'
    && typeof agents.saveGatewayRoute === 'function'
    && typeof agents.deleteGatewayRoute === 'function'
    && typeof agents.listWorkspaceReports === 'function';

  const managedWorkspaces = state.workspaces.filter(item => item.mode !== 'observe');
  const [refreshTick, setRefreshTick] = useState(0);
  const [overviewState, setOverviewState] = useState<{ tick: number; data: GatewayOverview | null; error: string | null }>({
    tick: initialOverview ? 0 : -1,
    data: initialOverview ?? null,
    error: null,
  });
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);

  // Connector form
  const [connectorProvider, setConnectorProvider] = useState<GatewayProvider>('discord');
  const [connectorAccountId, setConnectorAccountId] = useState('');
  const [connectorSecretRef, setConnectorSecretRef] = useState('');

  // Identity linking
  const [linkConnectorId, setLinkConnectorId] = useState(initialOverview?.connectors[0]?.id ?? '');
  const [extaliaPrincipalId, setExtaliaPrincipalId] = useState('');
  const [challenge, setChallenge] = useState<GatewayLinkChallengeView | null>(null);
  const [confirmAccountId, setConfirmAccountId] = useState(initialOverview?.connectors[0]?.providerAccountId ?? '');
  const [externalActorId, setExternalActorId] = useState('');
  const [permissionBands, setPermissionBands] = useState<GatewayPermissionBand[]>(['read_status', 'view_reports']);

  // Route form
  const [routeConnectorId, setRouteConnectorId] = useState(initialOverview?.connectors[0]?.id ?? '');
  const [routeAccountId, setRouteAccountId] = useState(initialOverview?.connectors[0]?.providerAccountId ?? '');
  const [routeChannelId, setRouteChannelId] = useState('');
  const [routeThreadId, setRouteThreadId] = useState('');
  const [routeWorkspaceId, setRouteWorkspaceId] = useState(managedWorkspaces[0]?.id ?? '');
  const [routeMode, setRouteMode] = useState<GatewayRouteMode>('explicit-only');
  const [routeAudience, setRouteAudience] = useState<GatewayAudience>('private');
  const [routeInbound, setRouteInbound] = useState(true);
  const [routeOutbound, setRouteOutbound] = useState(true);

  // Workspace Reports Inbox
  const [inboxWorkspaceId, setInboxWorkspaceId] = useState(initialInbox?.workspaceId ?? managedWorkspaces[0]?.id ?? '');

  const overview = overviewState.data;
  const loadingOverview = supported && overviewState.tick !== refreshTick && !overviewState.error;
  const error = actionError ?? overviewState.error;
  const setError = setActionError;
  const setOverview = (next: GatewayOverview) => setOverviewState({ tick: refreshTick, data: next, error: null });

  const effectiveLinkConnectorId = overview?.connectors.some(item => item.id === linkConnectorId)
    ? linkConnectorId
    : overview?.connectors[0]?.id ?? '';
  const effectiveRouteConnectorId = overview?.connectors.some(item => item.id === routeConnectorId)
    ? routeConnectorId
    : overview?.connectors[0]?.id ?? '';
  const effectiveRouteWorkspaceId = managedWorkspaces.some(item => item.id === routeWorkspaceId)
    ? routeWorkspaceId
    : managedWorkspaces[0]?.id ?? '';
  const effectiveInboxWorkspaceId = managedWorkspaces.some(item => item.id === inboxWorkspaceId)
    ? inboxWorkspaceId
    : managedWorkspaces[0]?.id ?? '';

  const inboxKey = effectiveInboxWorkspaceId ? `${effectiveInboxWorkspaceId}:${refreshTick}:${overview?.connectors.length ?? 0}` : '';
  const [inboxState, setInboxState] = useState<{ key: string; workspaceId: string; data: WorkspaceReportsInboxView | null; error: string | null }>({
    key: initialInbox ? `${initialInbox.workspaceId}:0:${initialOverview?.connectors.length ?? 0}` : '',
    workspaceId: initialInbox?.workspaceId ?? '',
    data: initialInbox ?? null,
    error: null,
  });

  useEffect(() => {
    if (!supported || typeof agents.gatewayOverview !== 'function') return;
    let active = true;
    void agents.gatewayOverview().then(
      next => {
        if (!active) return;
        setOverviewState({ tick: refreshTick, data: next, error: null });
        if (next.connectors[0]) {
          setLinkConnectorId(current => current || next.connectors[0]!.id);
          setRouteConnectorId(current => current || next.connectors[0]!.id);
          setConfirmAccountId(current => current || next.connectors[0]!.providerAccountId);
          setRouteAccountId(current => current || next.connectors[0]!.providerAccountId);
        }
      },
      failure => {
        if (!active) return;
        setOverviewState(current => ({ tick: refreshTick, data: current.data, error: errorMessage(failure) }));
      },
    );
    return () => { active = false; };
  }, [agents, supported, refreshTick]);

  useEffect(() => {
    if (!supported || !effectiveInboxWorkspaceId || typeof agents.listWorkspaceReports !== 'function') return;
    let active = true;
    const targetWorkspaceId = effectiveInboxWorkspaceId;
    const targetKey = inboxKey;
    void agents.listWorkspaceReports(targetWorkspaceId).then(
      next => {
        if (!active) return;
        setInboxState({ key: targetKey, workspaceId: targetWorkspaceId, data: next, error: null });
      },
      failure => {
        if (!active) return;
        setInboxState(current => ({
          key: targetKey,
          workspaceId: targetWorkspaceId,
          data: current.workspaceId === targetWorkspaceId ? current.data : null,
          error: errorMessage(failure),
        }));
      },
    );
    return () => { active = false; };
  }, [agents, supported, effectiveInboxWorkspaceId, inboxKey]);

  const inbox = effectiveInboxWorkspaceId && inboxState.workspaceId === effectiveInboxWorkspaceId ? inboxState.data : null;
  const inboxError = effectiveInboxWorkspaceId && inboxState.workspaceId === effectiveInboxWorkspaceId ? inboxState.error : null;
  const inboxLoading = supported && Boolean(effectiveInboxWorkspaceId) && inboxState.key !== inboxKey && !inboxError;

  async function runAction(action: (isActive: () => boolean) => Promise<void>) {
    const current = owner.current;
    if (!current.active || current.busy) return;
    current.busy = true;
    setBusy(true);
    setError(null);
    try {
      await action(() => current.active);
    } catch (failure) {
      if (current.active) setError(errorMessage(failure));
    } finally {
      current.busy = false;
      if (current.active) setBusy(false);
    }
  }

  if (!supported) {
    return (
      <section className="card settings-section" aria-labelledby={headingId}>
        <h2 id={headingId}>{g.title}</h2>
        <p className="muted">{g.unsupported}</p>
      </section>
    );
  }

  const connectors = overview?.connectors ?? [];
  const links = overview?.links ?? [];
  const routes = overview?.routes ?? [];
  const recentAudit = overview?.recentAudit ?? [];
  const connectorOptions = connectors.map(item => ({
    value: item.id,
    label: `${g.connectors.providers[item.provider as keyof typeof g.connectors.providers] ?? item.provider} · ${item.providerAccountId}`,
    description: item.id,
  }));
  const workspaceOptions = managedWorkspaces.map(item => ({
    value: item.id,
    label: item.name,
    description: item.projectLocation,
  }));

  const saveConnector = () => runAction(async isActive => {
    const next = await agents.saveGatewayConnector!({
      provider: connectorProvider,
      providerAccountId: connectorAccountId.trim(),
      secretRef: connectorSecretRef.trim(),
      status: 'connected',
    });
    if (!isActive()) return;
    setOverview(next);
    setConnectorAccountId('');
    setConnectorSecretRef('');
  });

  const toggleConnector = (connectorId: string, nextStatus: GatewayConnectorState) => runAction(async isActive => {
    const next = await agents.setGatewayConnectorStatus!(connectorId, nextStatus);
    if (!isActive()) return;
    setOverview(next);
  });

  const issueChallenge = () => runAction(async isActive => {
    if (!effectiveLinkConnectorId) return;
    const issued = await agents.issueGatewayLinkChallenge!({
      connectorId: effectiveLinkConnectorId,
      ...(extaliaPrincipalId.trim() ? { extaliaPrincipalId: extaliaPrincipalId.trim() } : {}),
    });
    if (!isActive()) return;
    setChallenge(issued);
    const chosen = connectors.find(item => item.id === effectiveLinkConnectorId);
    if (chosen && !confirmAccountId.trim()) setConfirmAccountId(chosen.providerAccountId);
    const refreshed = await agents.gatewayOverview!();
    if (isActive()) setOverview(refreshed);
  });

  const confirmLink = () => runAction(async isActive => {
    if (!challenge) return;
    const next = await agents.confirmGatewayPrincipalLink!({
      challengeId: challenge.challengeId,
      providerAccountId: confirmAccountId.trim(),
      externalActorId: externalActorId.trim(),
      permissionBands: [...permissionBands],
    });
    if (!isActive()) return;
    setOverview(next);
    setChallenge(null);
    setExternalActorId('');
  });

  const revokeLink = (linkId: string) => runAction(async isActive => {
    const next = await agents.revokeGatewayPrincipalLink!(linkId);
    if (!isActive()) return;
    setOverview(next);
  });

  const saveRoute = () => runAction(async isActive => {
    if (!effectiveRouteConnectorId || !effectiveRouteWorkspaceId) return;
    const next = await agents.saveGatewayRoute!({
      connectorId: effectiveRouteConnectorId,
      providerAccountId: routeAccountId.trim(),
      channelId: routeChannelId.trim(),
      ...(routeThreadId.trim() ? { threadId: routeThreadId.trim() } : {}),
      workspaceId: effectiveRouteWorkspaceId,
      mode: routeMode,
      audience: routeAudience,
      inboundEnabled: routeInbound,
      outboundEnabled: routeOutbound,
    });
    if (!isActive()) return;
    setOverview(next);
    setRouteChannelId('');
    setRouteThreadId('');
  });

  const removeRoute = (routeId: string) => runAction(async isActive => {
    const next = await agents.deleteGatewayRoute!(routeId);
    if (!isActive()) return;
    setOverview(next);
  });

  const togglePermission = (band: GatewayPermissionBand) => {
    setPermissionBands(current =>
      current.includes(band) ? current.filter(item => item !== band) : [...current, band]);
  };

  return (
    <section className="card settings-section" aria-labelledby={headingId} aria-busy={busy || loadingOverview || undefined}>
      <div className="section-head">
        <div>
          <h2 id={headingId}>{g.title}</h2>
          <p className="muted small">{g.lead}</p>
        </div>
        <button type="button" className="button small" disabled={busy || loadingOverview} onClick={() => { setError(null); setRefreshTick(value => value + 1); }}>
          <Icon name="refresh" className={loadingOverview ? 'spin' : ''} />{g.refresh}
        </button>
      </div>

      {loadingOverview && !overview && <p className="muted small" role="status">{g.loading}</p>}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      <div className="gateway-settings-stack">
        {/* 1. Connectors card */}
        <article className="gateway-subcard" aria-labelledby={`${headingId}-connectors`}>
          <div className="gateway-subcard-head">
            <div>
              <h3 id={`${headingId}-connectors`}>{g.connectors.title}</h3>
              <p className="muted small">{g.connectors.lead}</p>
            </div>
          </div>

          {connectors.length === 0 ? (
            <p className="muted small">{g.connectors.empty}</p>
          ) : (
            <ul className="entity-list">
              {connectors.map(connector => {
                const health = connector.health ?? {
                  connectorId: connector.id,
                  provider: connector.provider,
                  connectorState: connector.status,
                  ...defaultHealthDimensions(connector.status),
                  checkedAt: connector.updatedAt,
                };
                const enabled = connector.status !== 'disabled' && connector.status !== 'revoked';
                return (
                  <li key={connector.id} className="entity">
                    <div className="entity-main">
                      <strong>{g.connectors.providers[connector.provider as keyof typeof g.connectors.providers] ?? connector.provider} · {connector.providerAccountId}</strong>
                      <span className="muted small"><code>{connector.secretRef}</code></span>
                      <div className="gateway-health-grid" aria-label={g.connectors.healthLabel}>
                        {HEALTH_DIMENSIONS.map(dimension => {
                          const entry = health[dimension];
                          const dimLabel = g.connectors.healthDimensions[dimension];
                          const statusLabel = g.connectors.healthStatuses[entry.status] ?? entry.status;
                          return (
                            <span
                              key={dimension}
                              className={`gateway-health-chip ${healthChipTone(entry)}`}
                              title={entry.detail ? `${dimLabel}: ${statusLabel} — ${entry.detail}` : `${dimLabel}: ${statusLabel}`}
                            >
                              {dimLabel}: {statusLabel}
                            </span>
                          );
                        })}
                      </div>
                    </div>
                    <span className={`badge ${connectorStatusTone(connector.status)}`}>
                      {g.connectors.statuses[connector.status] ?? connector.status}
                    </span>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button small"
                        disabled={busy || connector.status === 'revoked'}
                        onClick={() => void toggleConnector(connector.id, enabled ? 'disabled' : 'connected')}
                      >
                        {enabled ? g.connectors.disable : g.connectors.enable}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          <form className="gateway-form" onSubmit={event => { event.preventDefault(); void saveConnector(); }}>
            <h4>{g.connectors.addTitle}</h4>
            <div className="gateway-form-grid">
              <div className="field">
                <Select
                  label={g.connectors.provider}
                  value={connectorProvider}
                  options={PROVIDERS.map(provider => ({
                    value: provider,
                    label: g.connectors.providers[provider as keyof typeof g.connectors.providers] ?? provider,
                  }))}
                  onChange={value => setConnectorProvider(value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`${headingId}-conn-account`}>{g.connectors.accountId}</label>
                <input
                  id={`${headingId}-conn-account`}
                  type="text"
                  value={connectorAccountId}
                  placeholder={g.connectors.accountIdPlaceholder}
                  disabled={busy}
                  onChange={event => setConnectorAccountId(event.target.value)}
                />
              </div>
              <div className="field">
                <label htmlFor={`${headingId}-conn-secret`}>{g.connectors.secretRef}</label>
                <input
                  id={`${headingId}-conn-secret`}
                  type="text"
                  value={connectorSecretRef}
                  placeholder={g.connectors.secretRefPlaceholder}
                  disabled={busy}
                  onChange={event => setConnectorSecretRef(event.target.value)}
                />
                <small className="muted">{g.connectors.secretRefHint}</small>
              </div>
            </div>
            <div className="actions">
              <button
                type="submit"
                className="button primary small"
                disabled={busy || !connectorAccountId.trim() || !connectorSecretRef.trim()}
              >
                {busy ? g.connectors.saving : g.connectors.save}
              </button>
            </div>
          </form>
        </article>

        {/* 2. Identity Linking card */}
        <article className="gateway-subcard" aria-labelledby={`${headingId}-linking`}>
          <div className="gateway-subcard-head">
            <div>
              <h3 id={`${headingId}-linking`}>{g.linking.title}</h3>
              <p className="muted small">{g.linking.lead}</p>
            </div>
          </div>

          <div className="gateway-form-grid">
            <div className="field">
              <Select
                label={g.linking.connectorLabel}
                value={effectiveLinkConnectorId}
                options={connectorOptions}
                disabled={busy || connectorOptions.length === 0}
                onChange={next => {
                  setLinkConnectorId(next);
                  const chosen = connectors.find(item => item.id === next);
                  if (chosen) setConfirmAccountId(chosen.providerAccountId);
                }}
              />
            </div>
            <div className="field">
              <label htmlFor={`${headingId}-principal`}>{g.linking.principalLabel}</label>
              <input
                id={`${headingId}-principal`}
                type="text"
                value={extaliaPrincipalId}
                placeholder={g.linking.principalPlaceholder}
                disabled={busy}
                onChange={event => setExtaliaPrincipalId(event.target.value)}
              />
            </div>
          </div>

          <div className="actions">
            <button
              type="button"
              className="button small"
              disabled={busy || !effectiveLinkConnectorId}
              onClick={() => void issueChallenge()}
            >
              <Icon name="key" />{busy ? g.linking.issuing : g.linking.issueChallenge}
            </button>
          </div>

          {challenge && (
            <div className="gateway-challenge-box" role="status">
              <div className="gateway-challenge-details">
                <strong>{g.linking.challengeCode}: <code>{challenge.code}</code></strong>
                <span className="muted small">{g.linking.challengeId}: <code>{challenge.challengeId}</code> · {g.linking.challengeExpires}: {challenge.expiresAt}</span>
              </div>
              <CopyButton text={challenge.code} label={g.linking.copyCode} />
            </div>
          )}

          {challenge && (
            <form className="gateway-form" onSubmit={event => { event.preventDefault(); void confirmLink(); }}>
              <h4>{g.linking.confirmTitle}</h4>
              <p className="muted small">{g.linking.confirmLead}</p>
              <div className="gateway-form-grid">
                <div className="field">
                  <label htmlFor={`${headingId}-confirm-account`}>{g.linking.accountId}</label>
                  <input
                    id={`${headingId}-confirm-account`}
                    type="text"
                    value={confirmAccountId}
                    placeholder={g.linking.accountIdPlaceholder}
                    disabled={busy}
                    onChange={event => setConfirmAccountId(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${headingId}-confirm-actor`}>{g.linking.externalActorId}</label>
                  <input
                    id={`${headingId}-confirm-actor`}
                    type="text"
                    value={externalActorId}
                    placeholder={g.linking.externalActorPlaceholder}
                    disabled={busy}
                    onChange={event => setExternalActorId(event.target.value)}
                  />
                </div>
              </div>

              <fieldset>
                <legend className="small">{g.linking.permissionsLabel}</legend>
                <div className="gateway-permission-grid">
                  {PERMISSION_BANDS.map(band => (
                    <label key={band} className="gateway-permission-pill">
                      <input
                        type="checkbox"
                        checked={permissionBands.includes(band)}
                        disabled={busy}
                        onChange={() => togglePermission(band)}
                      />
                      <span>{g.linking.permissions[band]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="actions">
                <button
                  type="submit"
                  className="button primary small"
                  disabled={busy || !confirmAccountId.trim() || !externalActorId.trim() || permissionBands.length === 0}
                >
                  {busy ? g.linking.confirming : g.linking.confirm}
                </button>
              </div>
            </form>
          )}

          <div>
            <h4 className="small">{g.linking.linksHeading}</h4>
            {links.length === 0 ? (
              <p className="muted small">{g.linking.emptyLinks}</p>
            ) : (
              <ul className="entity-list">
                {links.map(link => (
                  <li key={link.id} className="entity">
                    <div className="entity-main">
                      <strong><code>{link.externalActorId}</code> · {link.providerAccountId}</strong>
                      <span className="muted small">{link.extaliaPrincipalId}</span>
                      <div className="gateway-health-grid">
                        {link.permissionBands.map(band => (
                          <span key={band} className="badge subtle">{g.linking.permissions[band] ?? band}</span>
                        ))}
                      </div>
                    </div>
                    <span className={`badge ${link.state === 'active' ? 'ok' : link.state === 'revoked' ? 'error' : 'warn'}`}>
                      {g.linking.linkStates[link.state] ?? link.state}
                    </span>
                    {link.state === 'active' && (
                      <div className="row-actions">
                        <button
                          type="button"
                          className="button small danger"
                          disabled={busy}
                          onClick={() => void revokeLink(link.id)}
                        >
                          {g.linking.revoke}
                        </button>
                      </div>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </article>

        {/* 3. Workspace Routes & ACL card */}
        <article className="gateway-subcard" aria-labelledby={`${headingId}-routes`}>
          <div className="gateway-subcard-head">
            <div>
              <h3 id={`${headingId}-routes`}>{g.routes.title}</h3>
              <p className="muted small">{g.routes.lead}</p>
            </div>
          </div>

          {routes.length === 0 ? (
            <p className="muted small">{g.routes.empty}</p>
          ) : (
            <ul className="entity-list">
              {routes.map(route => {
                const workspaceName = state.workspaces.find(item => item.id === route.workspaceId)?.name ?? route.workspaceId;
                return (
                  <li key={route.id} className="entity">
                    <div className="entity-main">
                      <strong>
                        <code>{route.channelId}</code>
                        {route.threadId ? <> · <code>{route.threadId}</code></> : null}
                        {' → '}
                        {workspaceName}
                      </strong>
                      <span className="muted small">
                        {route.providerAccountId} · {g.routes.modes[route.mode] ?? route.mode} · {g.routes.audiences[route.audience] ?? route.audience}
                      </span>
                      <div className="gateway-health-grid">
                        <span className={`badge ${route.inboundEnabled ? 'ok' : 'subtle'}`}>
                          {route.inboundEnabled ? g.routes.inboundOn : g.routes.inboundOff}
                        </span>
                        <span className={`badge ${route.outboundEnabled ? 'ok' : 'subtle'}`}>
                          {route.outboundEnabled ? g.routes.outboundOn : g.routes.outboundOff}
                        </span>
                      </div>
                    </div>
                    <span className={`badge ${route.state === 'active' ? 'ok' : route.state === 'paused' ? 'warn' : 'error'}`}>
                      {g.routes.states[route.state] ?? route.state}
                    </span>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button small danger"
                        disabled={busy}
                        onClick={() => void removeRoute(route.id)}
                      >
                        <Icon name="trash" />{g.routes.delete}
                      </button>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}

          {managedWorkspaces.length === 0 ? (
            <p className="muted small">{g.routes.noWorkspaces}</p>
          ) : (
            <form className="gateway-form" onSubmit={event => { event.preventDefault(); void saveRoute(); }}>
              <h4>{g.routes.createTitle}</h4>
              <div className="gateway-form-grid">
                <div className="field">
                  <Select
                    label={g.routes.connector}
                    value={effectiveRouteConnectorId}
                    options={connectorOptions}
                    disabled={busy || connectorOptions.length === 0}
                    onChange={next => {
                      setRouteConnectorId(next);
                      const chosen = connectors.find(item => item.id === next);
                      if (chosen) setRouteAccountId(chosen.providerAccountId);
                    }}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${headingId}-route-account`}>{g.routes.accountId}</label>
                  <input
                    id={`${headingId}-route-account`}
                    type="text"
                    value={routeAccountId}
                    placeholder={g.connectors.accountIdPlaceholder}
                    disabled={busy}
                    onChange={event => setRouteAccountId(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${headingId}-route-channel`}>{g.routes.channelId}</label>
                  <input
                    id={`${headingId}-route-channel`}
                    type="text"
                    value={routeChannelId}
                    placeholder={g.routes.channelIdPlaceholder}
                    disabled={busy}
                    onChange={event => setRouteChannelId(event.target.value)}
                  />
                </div>
                <div className="field">
                  <label htmlFor={`${headingId}-route-thread`}>{g.routes.threadId}</label>
                  <input
                    id={`${headingId}-route-thread`}
                    type="text"
                    value={routeThreadId}
                    placeholder={g.routes.threadIdPlaceholder}
                    disabled={busy}
                    onChange={event => setRouteThreadId(event.target.value)}
                  />
                </div>
                <div className="field">
                  <Select
                    label={g.routes.workspace}
                    value={effectiveRouteWorkspaceId}
                    options={workspaceOptions}
                    disabled={busy}
                    onChange={setRouteWorkspaceId}
                  />
                </div>
                <div className="field">
                  <Select
                    label={g.routes.mode}
                    value={routeMode}
                    options={ROUTE_MODES.map(mode => ({ value: mode, label: g.routes.modes[mode] }))}
                    disabled={busy}
                    onChange={setRouteMode}
                  />
                </div>
                <div className="field">
                  <Select
                    label={g.routes.audience}
                    value={routeAudience}
                    options={AUDIENCES.map(audience => ({ value: audience, label: g.routes.audiences[audience] }))}
                    disabled={busy}
                    onChange={setRouteAudience}
                  />
                </div>
              </div>

              <div className="gateway-switch-row">
                <label className="switch">
                  <input type="checkbox" role="switch" checked={routeInbound} disabled={busy} onChange={event => setRouteInbound(event.target.checked)} />
                  <span className="switch-track" aria-hidden="true" />
                  <span>{g.routes.inboundEnabled}</span>
                </label>
                <label className="switch">
                  <input type="checkbox" role="switch" checked={routeOutbound} disabled={busy} onChange={event => setRouteOutbound(event.target.checked)} />
                  <span className="switch-track" aria-hidden="true" />
                  <span>{g.routes.outboundEnabled}</span>
                </label>
              </div>

              <div className="actions">
                <button
                  type="submit"
                  className="button primary small"
                  disabled={busy || !effectiveRouteConnectorId || !routeAccountId.trim() || !routeChannelId.trim() || !effectiveRouteWorkspaceId}
                >
                  {busy ? g.routes.saving : g.routes.save}
                </button>
              </div>
            </form>
          )}
        </article>

        {/* 4. Workspace Reports Inbox card */}
        <article className="gateway-subcard" aria-labelledby={`${headingId}-inbox`}>
          <div className="gateway-subcard-head">
            <div>
              <h3 id={`${headingId}-inbox`}>{g.inbox.title}</h3>
              <p className="muted small">{g.inbox.lead}</p>
            </div>
          </div>

          <p className="note small"><Icon name="shield" />{g.inbox.candidateSeparationNote}</p>

          {managedWorkspaces.length === 0 ? (
            <p className="muted small">{g.inbox.noWorkspaces}</p>
          ) : (
            <>
              <div className="gateway-form-grid">
                <div className="field">
                  <Select
                    label={g.inbox.workspaceLabel}
                    value={effectiveInboxWorkspaceId}
                    options={workspaceOptions}
                    onChange={setInboxWorkspaceId}
                  />
                </div>
              </div>
              {inboxLoading && <p className="muted small" role="status">{g.inbox.loading}</p>}
              {inboxError && <p className="form-error" role="alert"><Icon name="alert" />{inboxError}</p>}
              {inbox && !inboxLoading && (
                <>
                  <p className="muted small">{g.inbox.projectionsCount(inbox.projections.length)}</p>
                  {inbox.reports.length === 0 ? (
                    <p className="muted small">{g.inbox.empty}</p>
                  ) : (
                    <div className="gateway-reports-list">
                      {inbox.reports.map(report => (
                        <ChatSystemReportCard key={report.id} t={t} report={report} variant="inbox" />
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}
        </article>

        {/* 5. Audit Log */}
        <details className="gateway-audit-details">
          <summary>
            <span>{g.audit.title}</span>
            <span className="muted small">{g.audit.count(recentAudit.length)}</span>
          </summary>
          {recentAudit.length === 0 ? (
            <p className="muted small">{g.audit.empty}</p>
          ) : (
            <ul className="gateway-audit-list">
              {recentAudit.map(entry => (
                <li key={entry.sequence} className="gateway-audit-entry">
                  <div className="gateway-audit-meta">
                    <strong>#{entry.sequence} · {entry.action}</strong>
                    <span className="badge subtle">{entry.outcome}</span>
                    <span className="muted small">{entry.actor} → <code>{entry.resource}</code></span>
                    <span className="muted small">{entry.at}</span>
                  </div>
                  {entry.reason && <span className="muted small">{g.audit.reason}: {entry.reason}</span>}
                </li>
              ))}
            </ul>
          )}
        </details>
      </div>
    </section>
  );
}
