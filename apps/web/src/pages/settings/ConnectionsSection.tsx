import { presetById } from '@extalia/core';
import type { AgentHostApi, ConnectionTestResult, HostState } from '@extalia/platform';
import { useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { ConnectionForm } from '../../setup/ConnectionForm';
import { draftFromConnection, draftFromPreset, isValid, toConnectionInput, validateConnection, type ConnectionDraft } from '../../setup/validation';
import { Icon } from '../../ui/Icon';

type TestState = ConnectionTestResult | 'testing';

export function ConnectionsSection({ t, agents, state, onState }: { t: Messages; agents: AgentHostApi; state: HostState; onState: (next: HostState) => void }) {
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  }

  const save = () => run(async () => {
    if (!draft) return;
    setAttempted(true);
    if (!isValid(validateConnection(draft))) return;
    const { input, secret } = toConnectionInput(draft);
    onState(await agents.saveConnection(input, secret));
    setDraft(null);
  });

  const test = async (id: string) => {
    const view = state.connections.find(item => item.id === id);
    if (!view) return;
    setTests(previous => ({ ...previous, [id]: 'testing' }));
    let result: ConnectionTestResult;
    try { result = await agents.testConnection(toConnectionInput(draftFromConnection(view)).input); }
    catch (failure) { result = { ok: false, error: errorMessage(failure) }; }
    setTests(previous => ({ ...previous, [id]: result }));
  };

  const edit = (next: ConnectionDraft) => { setAttempted(false); setError(null); setConfirming(null); setDraft(next); };

  return (
    <section className="card settings-section" aria-labelledby="settings-connections">
      <div className="section-head">
        <div>
          <h2 id="settings-connections">{t.settings.connections}</h2>
          <p className="muted small">{t.settings.connectionsLead}</p>
        </div>
        {!draft && <button type="button" className="button" onClick={() => edit(draftFromPreset('openai'))}><Icon name="plus" />{t.settings.addConnection}</button>}
      </div>

      {draft ? (
        <form className="editor" aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addConnection} onSubmit={event => { event.preventDefault(); void save(); }}>
          <ConnectionForm t={t} agents={agents} draft={draft} onChange={setDraft} showAllErrors={attempted} />
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? t.common.saving : t.common.save}</button>
            <button type="button" disabled={busy} onClick={() => setDraft(null)}>{t.common.cancel}</button>
          </div>
        </form>
      ) : state.connections.length === 0 ? <p className="muted">{t.settings.noConnections}</p> : (
        <ul className="entity-list">
          {state.connections.map(connection => {
            const result = tests[connection.id];
            return (
              <li key={connection.id} className="entity">
                <div className="entity-main">
                  <strong>{connection.name}</strong>
                  <span className="muted small">{presetById(connection.preset).label} · {connection.model || '—'}</span>
                  <code className="entity-path">{connection.baseUrl}</code>
                </div>
                <span className={`badge ${connection.credentialStatus === 'missing' ? 'error' : connection.credentialStatus === 'ok' ? 'ok' : ''}`}>
                  <Icon name={connection.credentialStatus === 'missing' ? 'alert' : 'key'} />{t.connection.credentialStatus[connection.credentialStatus]}
                </span>
                {confirming === connection.id ? (
                  <div className="confirm" role="alertdialog" aria-label={t.settings.deleteConnection}>
                    <p>{t.settings.deleteConnection}</p>
                    <div className="row-actions">
                      <button type="button" className="button small danger" autoFocus disabled={busy}
                        onClick={() => run(async () => { onState(await agents.deleteConnection(connection.id)); setConfirming(null); })}>{t.common.delete}</button>
                      <button type="button" className="button small" onClick={() => setConfirming(null)}>{t.common.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <div className="row-actions">
                    <button type="button" className="button small" disabled={result === 'testing'} onClick={() => test(connection.id)}>{result === 'testing' ? t.connection.testing : t.settings.test}</button>
                    <button type="button" className="button small" onClick={() => edit(draftFromConnection(connection))}><Icon name="edit" />{t.common.edit}</button>
                    <button type="button" className="button small" aria-label={`${t.common.delete}: ${connection.name}`} onClick={() => { setError(null); setConfirming(connection.id); }}><Icon name="trash" /></button>
                  </div>
                )}
                {result && result !== 'testing' && (
                  <p className="entity-note" role="status">
                    {result.ok
                      ? <span className="status ok"><Icon name="check" />{t.connection.testOk(result.latencyMs)}</span>
                      : <span className="status error"><Icon name="alert" />{t.connection.testFailed} {result.error}</span>}
                  </p>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {!draft && error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}
