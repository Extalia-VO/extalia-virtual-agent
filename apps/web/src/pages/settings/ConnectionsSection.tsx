import { presetById } from '@extalia/core';
import type { AgentHostApi, ConnectionTestResult, HostState } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../../host/remote';
import type { Messages } from '../../i18n';
import { ConnectionForm } from '../../setup/ConnectionForm';
import { draftFromConnection, draftFromPreset, isValid, toConnectionInput, validateConnection, type ConnectionDraft } from '../../setup/validation';
import { Icon } from '../../ui/Icon';

type TestState = ConnectionTestResult | 'testing';
type Props = { t: Messages; agents: AgentHostApi; state: HostState; onState: (next: HostState) => void };

export function ConnectionsSection(props: Props) {
  const [scope, setScope] = useState({ agents: props.agents, profile: props.state.profile.id, directory: props.state.dataDirectory, revision: 0 });
  const changed = scope.agents !== props.agents || scope.profile !== props.state.profile.id || scope.directory !== props.state.dataDirectory;
  const revision = scope.revision + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, profile: props.state.profile.id, directory: props.state.dataDirectory, revision });
  return <ConnectionEditor key={revision} {...props} />;
}

function ConnectionEditor({ t, agents, state, onState }: Props) {
  const owner = useRef({ active: true, busy: false, testing: new Set<string>() });
  useEffect(() => { const operation = owner.current; operation.active = true; return () => { operation.active = false; }; }, []);
  const [draft, setDraft] = useState<ConnectionDraft | null>(null);
  const [attempted, setAttempted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, TestState>>({});

  async function run(action: (active: () => boolean) => Promise<void>) {
    const operation = owner.current;
    if (!operation.active || operation.busy) return;
    operation.busy = true;
    setBusy(true);
    setError(null);
    try { await action(() => operation.active); }
    catch (failure) { if (operation.active) setError(errorMessage(failure)); }
    finally { operation.busy = false; if (operation.active) setBusy(false); }
  }

  const save = () => run(async active => {
    if (!draft) return;
    setAttempted(true);
    if (!isValid(validateConnection(draft))) return;
    const { input, secret } = toConnectionInput(draft);
    const next = await agents.saveConnection(input, secret);
    if (!active()) return;
    onState(next);
    setDraft(null);
  });

  const test = async (id: string) => {
    const operation = owner.current;
    if (!operation.active || operation.busy || operation.testing.has(id)) return;
    const view = state.connections.find(item => item.id === id);
    if (!view) return;
    operation.testing.add(id);
    setTests(previous => ({ ...previous, [id]: 'testing' }));
    let result: ConnectionTestResult;
    try { result = await agents.testConnection(toConnectionInput(draftFromConnection(view)).input); }
    catch (failure) { result = { ok: false, error: errorMessage(failure) }; }
    operation.testing.delete(id);
    if (operation.active) setTests(previous => ({ ...previous, [id]: result }));
  };

  const edit = (next: ConnectionDraft) => { if (owner.current.busy || !owner.current.active) return; setAttempted(false); setError(null); setConfirming(null); setDraft(next); };
  const changeDraft = (next: ConnectionDraft) => { if (!owner.current.busy && owner.current.active) setDraft(next); };
  const confirm = (id: string | null) => { if (owner.current.busy || !owner.current.active) return; setError(null); setConfirming(id); };
  // The models a row's successful test listed; the editor offers them until the connection is tested again.
  const listedModels = (id?: string) => {
    const result = id ? tests[id] : undefined;
    return result && result !== 'testing' && result.ok ? result.models : undefined;
  };

  return (
    <section className="card settings-section" aria-labelledby="settings-connections">
      <div className="section-head">
        <div>
          <h2 id="settings-connections">{t.settings.connections}</h2>
          <p className="muted small">{t.settings.connectionsLead}</p>
        </div>
        {!draft && <button type="button" className="button" disabled={busy} onClick={() => edit(draftFromPreset('openai'))}><Icon name="plus" />{t.settings.addConnection}</button>}
      </div>

      {draft ? (
        <form className="editor" noValidate autoComplete="off" aria-busy={busy} aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addConnection} onSubmit={event => { event.preventDefault(); void save(); }}>
          <fieldset disabled={busy} aria-label={draft.id ? t.settings.editing(draft.name) : t.settings.addConnection}>
            <ConnectionForm t={t} agents={agents} draft={draft} onChange={changeDraft} showAllErrors={attempted} knownModels={listedModels(draft.id)} />
          </fieldset>
          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
          <div className="actions">
            <button type="submit" className="primary" disabled={busy}>{busy ? t.common.saving : t.common.save}</button>
            <button type="button" disabled={busy} onClick={() => { if (!owner.current.busy && owner.current.active) setDraft(null); }}>{t.common.cancel}</button>
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
                        onClick={() => run(async active => { const next = await agents.deleteConnection(connection.id); if (active()) { onState(next); setConfirming(null); } })}>{t.common.delete}</button>
                      <button type="button" className="button small" disabled={busy} onClick={() => confirm(null)}>{t.common.cancel}</button>
                    </div>
                  </div>
                ) : (
                  <div className="row-actions">
                    <button type="button" className="button small" disabled={busy || result === 'testing'} onClick={() => test(connection.id)}>{result === 'testing' ? t.connection.testing : t.settings.test}</button>
                    <button type="button" className="button small" disabled={busy} onClick={() => edit(draftFromConnection(connection))}><Icon name="edit" />{t.common.edit}</button>
                    <button type="button" className="button small" aria-label={`${t.common.delete}: ${connection.name}`} disabled={busy} onClick={() => confirm(connection.id)}><Icon name="trash" /></button>
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
