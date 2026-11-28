import {
  BRIDGE_CLIENT_SCOPES,
  type BridgeClientGrantState,
  type BridgeClientGrantView,
  type BridgeClientScope,
  type BridgePairingCapability,
  type BridgePairingChallengeView,
} from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Language, Messages } from '../../i18n';
import { CopyButton } from '../../ui/CopyButton';
import { Icon } from '../../ui/Icon';
import './bridgeClients.css';

export interface BridgeClientsViewProps {
  t: Messages;
  language: Language;
  clients: readonly BridgeClientGrantView[];
  name: string;
  scopes: readonly BridgeClientScope[];
  challenge: BridgePairingChallengeView | null;
  issuedToken: { client: BridgeClientGrantView; token: string } | null;
  loading?: boolean;
  busyAction?: string | null;
  error?: string | null;
  onNameChange?: (name: string) => void;
  onToggleScope?: (scope: BridgeClientScope) => void;
  onIssueChallenge?: () => void;
  onConfirmChallenge?: () => void;
  onCancelChallenge?: () => void;
  onDismissToken?: () => void;
  onRevokeClient?: (clientId: string) => void;
  onRefresh?: () => void;
}

const CLIENT_STATE_TONE: Record<BridgeClientGrantState, 'ok' | 'error' | 'warn'> = {
  active: 'ok',
  revoked: 'error',
  expired: 'warn',
};

function formatTimestamp(value: string, language: Language): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(language, { dateStyle: 'medium', timeStyle: 'short' });
}

/** Pure, hook-free presentation for Scoped Bridge client pairing and grant management. */
export function BridgeClientsView({
  t,
  language,
  clients,
  name,
  scopes,
  challenge,
  issuedToken,
  loading = false,
  busyAction = null,
  error = null,
  onNameChange,
  onToggleScope,
  onIssueChallenge,
  onConfirmChallenge,
  onCancelChallenge,
  onDismissToken,
  onRevokeClient,
  onRefresh,
}: BridgeClientsViewProps) {
  const m = t.bridgePairing;
  const headingId = 'settings-bridge-clients';
  const nameInputId = 'bridge-client-name-input';
  const busy = Boolean(busyAction);
  const disabled = Boolean(loading || busy);
  const issuing = busyAction === 'issue';
  const confirming = busyAction === 'confirm';
  const canIssue = Boolean(name.trim()) && scopes.length > 0 && !disabled;

  return (
    <section
      className="card settings-section bridge-clients-card"
      aria-labelledby={headingId}
      aria-busy={Boolean(loading || busy) || undefined}
    >
      <div className="section-head">
        <div>
          <h2 id={headingId}>{m.title}</h2>
          <p className="muted small">{m.lead}</p>
        </div>
        <button
          type="button"
          className="button small"
          disabled={disabled || !onRefresh}
          aria-label={m.refresh}
          title={m.refresh}
          onClick={onRefresh}
        >
          <Icon name="refresh" className={loading ? 'spin' : ''} />
          {m.refresh}
        </button>
      </div>

      {error && (
        <p className="form-error" role="alert">
          <Icon name="alert" />
          <span>{error}</span>
        </p>
      )}

      <form
        className="bridge-pairing-form"
        onSubmit={event => {
          event.preventDefault();
          if (canIssue) onIssueChallenge?.();
        }}
      >
        <h3>{m.form.heading}</h3>
        <div className="field">
          <label htmlFor={nameInputId}>{m.form.nameLabel}</label>
          <input
            id={nameInputId}
            type="text"
            value={name}
            placeholder={m.form.namePlaceholder}
            maxLength={80}
            disabled={disabled}
            onChange={event => onNameChange?.(event.target.value)}
          />
        </div>
        <fieldset className="bridge-scope-fieldset">
          <legend className="small">{m.form.scopesLabel}</legend>
          <div className="bridge-scope-grid">
            {BRIDGE_CLIENT_SCOPES.map(scope => (
              <label key={scope} className="bridge-scope-pill">
                <input
                  type="checkbox"
                  checked={scopes.includes(scope)}
                  disabled={disabled}
                  onChange={() => onToggleScope?.(scope)}
                />
                <span>{m.scopes[scope]}</span>
              </label>
            ))}
          </div>
        </fieldset>
        <div className="actions">
          <button type="submit" className="button primary small" disabled={!canIssue}>
            <Icon name="key" />
            {issuing ? m.form.issuing : m.form.issueButton}
          </button>
        </div>
      </form>

      {challenge && (
        <div className="bridge-challenge-banner" role="status" aria-label={m.challenge.heading}>
          <div className="bridge-banner-head">
            <h3>{m.challenge.heading}</h3>
            <span className="muted small">
              {challenge.clientName}
            </span>
          </div>
          <div className="bridge-challenge-code-row">
            <span>
              {m.challenge.codeLabel}: <code>{challenge.code}</code>
            </span>
            <CopyButton text={challenge.code} label={m.challenge.copyCode} />
          </div>
          <div className="bridge-client-scopes">
            {challenge.requestedScopes.map(scope => (
              <span key={scope} className="badge subtle">{m.scopes[scope]}</span>
            ))}
          </div>
          <span className="muted small">
            {m.challenge.expiresLabel}: <time dateTime={challenge.expiresAt}>{formatTimestamp(challenge.expiresAt, language)}</time>
          </span>
          <div className="actions">
            <button
              type="button"
              className="button primary small"
              disabled={disabled}
              onClick={onConfirmChallenge}
            >
              {confirming ? m.challenge.confirming : m.challenge.confirmButton}
            </button>
            <button
              type="button"
              className="button small"
              disabled={disabled}
              onClick={onCancelChallenge}
            >
              {m.challenge.cancelButton}
            </button>
          </div>
        </div>
      )}

      {issuedToken && (
        <div className="bridge-token-banner" role="status" aria-label={m.issuedToken.heading}>
          <div className="bridge-banner-head">
            <h3>{m.issuedToken.heading}</h3>
            <span className="muted small">
              <strong>{issuedToken.client.name}</strong> · <code>{issuedToken.client.clientId}</code>
            </span>
          </div>
          <div className="command-line">
            <code>{issuedToken.token}</code>
            <CopyButton text={issuedToken.token} label={m.issuedToken.copyToken} />
          </div>
          <p className="bridge-token-warning">
            <Icon name="alert" />
            <span>{m.issuedToken.warning}</span>
          </p>
          <div className="actions">
            <button type="button" className="button small" onClick={onDismissToken}>
              {m.issuedToken.dismiss}
            </button>
          </div>
        </div>
      )}

      <div className="bridge-clients-list-wrap">
        <h3>{m.clients.heading}</h3>
        {clients.length === 0 ? (
          <p className="muted small">{m.empty}</p>
        ) : (
          <ul className="entity-list">
            {clients.map(client => {
              const revoking = busyAction === `revoke:${client.clientId}`;
              return (
                <li key={client.clientId} className="entity">
                  <div className="entity-main">
                    <div className="bridge-client-head">
                      <strong>{client.name}</strong>
                      <code>{client.clientId}</code>
                      <span className={`badge ${CLIENT_STATE_TONE[client.state]}`}>
                        {m.states[client.state]}
                      </span>
                    </div>
                    <div className="bridge-client-scopes">
                      {client.scopes.map(scope => (
                        <span key={scope} className="badge subtle">{m.scopes[scope]}</span>
                      ))}
                    </div>
                    <div className="bridge-client-meta">
                      <span>
                        {m.clients.issuedAt}: <time dateTime={client.issuedAt}>{formatTimestamp(client.issuedAt, language)}</time>
                      </span>
                      {client.lastUsedAt && (
                        <span>
                          {m.clients.lastUsedAt}: <time dateTime={client.lastUsedAt}>{formatTimestamp(client.lastUsedAt, language)}</time>
                        </span>
                      )}
                      {client.revokedAt && (
                        <span>
                          {m.clients.revokedAt}: <time dateTime={client.revokedAt}>{formatTimestamp(client.revokedAt, language)}</time>
                        </span>
                      )}
                      {client.revokeReason && <span>{client.revokeReason}</span>}
                    </div>
                  </div>
                  {client.state === 'active' && (
                    <div className="row-actions">
                      <button
                        type="button"
                        className="button small danger"
                        disabled={disabled}
                        onClick={() => onRevokeClient?.(client.clientId)}
                      >
                        {revoking ? m.clients.revoking : m.clients.revokeButton}
                      </button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}

/** Stateful Settings card for pairing, inspecting, and revoking scoped Bridge clients. */
export function BridgeClientsCard({
  t,
  language,
  pairing,
}: {
  t: Messages;
  language: Language;
  pairing: BridgePairingCapability;
}) {
  const [clients, setClients] = useState<BridgeClientGrantView[]>([]);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<BridgeClientScope[]>(['read', 'events']);
  const [challenge, setChallenge] = useState<BridgePairingChallengeView | null>(null);
  const [issuedToken, setIssuedToken] = useState<{ client: BridgeClientGrantView; token: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshTick, setRefreshTick] = useState(0);

  const mountedRef = useRef(true);
  const generationRef = useRef(0);
  const busyRef = useRef(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    const generation = ++generationRef.current;
    const isCurrent = () => active && mountedRef.current && generation === generationRef.current;
    void (async () => {
      setLoading(true);
      setError(null);
      try {
        const list = await pairing.listClients();
        if (!isCurrent()) return;
        setClients(list);
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
  }, [pairing, refreshTick]);

  const runAction = (actionKey: string, task: (isCurrent: () => boolean) => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    const actionGeneration = generationRef.current;
    const isCurrent = () => mountedRef.current && actionGeneration === generationRef.current;
    setBusyAction(actionKey);
    setError(null);
    void task(isCurrent).catch(failure => {
      if (isCurrent()) setError(errorMessage(failure));
    }).finally(() => {
      busyRef.current = false;
      if (mountedRef.current) setBusyAction(null);
    });
  };

  const handleToggleScope = (scope: BridgeClientScope) => {
    setScopes(current => {
      const next = current.includes(scope)
        ? current.filter(item => item !== scope)
        : [...current, scope];
      return BRIDGE_CLIENT_SCOPES.filter(item => next.includes(item));
    });
  };

  const handleIssueChallenge = () => {
    const trimmedName = name.trim();
    if (!trimmedName || scopes.length === 0) return;
    runAction('issue', async isCurrent => {
      const issued = await pairing.issueChallenge({ name: trimmedName, scopes: [...scopes] });
      if (!isCurrent()) return;
      setChallenge(issued);
      setIssuedToken(null);
    });
  };

  const handleConfirmChallenge = () => {
    if (!challenge) return;
    const currentChallenge = challenge;
    runAction('confirm', async isCurrent => {
      const minted = await pairing.confirmChallenge({
        challengeId: currentChallenge.challengeId,
        code: currentChallenge.code,
      });
      if (!isCurrent()) return;
      setChallenge(null);
      setIssuedToken(minted);
      setName('');
      const refreshed = await pairing.listClients();
      if (isCurrent()) setClients(refreshed);
    });
  };

  const handleRevokeClient = (clientId: string) => {
    runAction(`revoke:${clientId}`, async isCurrent => {
      await pairing.revokeClient(clientId);
      if (!isCurrent()) return;
      const refreshed = await pairing.listClients();
      if (isCurrent()) setClients(refreshed);
    });
  };

  return (
    <BridgeClientsView
      t={t}
      language={language}
      clients={clients}
      name={name}
      scopes={scopes}
      challenge={challenge}
      issuedToken={issuedToken}
      loading={loading}
      busyAction={busyAction}
      error={error}
      onNameChange={setName}
      onToggleScope={handleToggleScope}
      onIssueChallenge={handleIssueChallenge}
      onConfirmChallenge={handleConfirmChallenge}
      onCancelChallenge={() => setChallenge(null)}
      onDismissToken={() => setIssuedToken(null)}
      onRevokeClient={handleRevokeClient}
      onRefresh={() => setRefreshTick(value => value + 1)}
    />
  );
}
