import { normalizeAutomaticLearningPolicy, type AgentHostApi, type SaveVaultProfileInput, type VaultProfile, type VaultProfilesCatalog } from '@extalia/platform';
import { useEffect, useState } from 'react';
import type { Messages } from '../../i18n';
import { errorMessage } from '../../host/remote';
import { isUnsupportedMessage } from '../../knowledge/knowledgeModel';

export type VaultProfileDraft = Omit<SaveVaultProfileInput, 'expectedRevision'>;
export const vaultProfileDraft = (profile: VaultProfile): VaultProfileDraft => ({ id: profile.id, name: profile.name,
  vaultRoot: profile.kind === 'custom' ? profile.root : null, workspaceIds: [...profile.workspaceIds], minutesEnabled: profile.minutesEnabled, automaticLearning: normalizeAutomaticLearningPolicy(profile.automaticLearning) });
export function toggleVaultWorkspace(draft: VaultProfileDraft, workspaceId: string): VaultProfileDraft {
  return { ...draft, workspaceIds: draft.workspaceIds.includes(workspaceId) ? draft.workspaceIds.filter(id => id !== workspaceId) : [...draft.workspaceIds, workspaceId] };
}

export function VaultProfilesView({ t, catalog, draft, busy, error, notice, onDraft, onSelect, onNew, onSave, onRefresh }: {
  t: Messages; catalog: VaultProfilesCatalog; draft: VaultProfileDraft; busy: boolean; error?: string | undefined; notice?: string | undefined;
  onDraft(draft: VaultProfileDraft): void; onSelect(profile: VaultProfile): void; onNew(): void; onSave(): void; onRefresh(): void;
}) {
  const p = t.vaultProfiles;
  const indexed = draft.id === catalog.defaultProfileId;
  const learning = normalizeAutomaticLearningPolicy(draft.automaticLearning);
  const selected = catalog.profiles.find(profile => profile.id === draft.id);
  return <section className="card settings-section" aria-labelledby="settings-vault-profiles">
    <h2 id="settings-vault-profiles">{p.title}</h2><p className="muted">{p.lead}</p><p className="note">{p.scope}</p>
    <ul>{catalog.profiles.map(profile => <li key={profile.id}>
      <button type="button" className="button small" aria-pressed={profile.id === draft.id} disabled={busy} onClick={() => onSelect(profile)}>{profile.name}</button>{' '}
      <span className="badge subtle">{profile.kind === 'indexed' ? p.indexed : p.notesOnly}</span><br /><code>{profile.root}</code>
      <p className="muted small">{profile.workspaceIds.map(id => catalog.workspaces.find(workspace => workspace.id === id)?.name ?? id).join(', ') || p.noWorkspaces}</p>
    </li>)}</ul>
    <div className="actions"><button type="button" className="button small" disabled={busy} onClick={onNew}>{p.create}</button>
      <button type="button" className="button small" disabled={busy} onClick={onRefresh}>{p.refresh}</button></div>
    <form onSubmit={event => { event.preventDefault(); onSave(); }}>
      <label className="field"><span>{p.name}</span><input type="text" maxLength={120} value={draft.name} disabled={busy} onChange={event => onDraft({ ...draft, name: event.target.value })} /></label>
      <label className="field"><span>{p.root}</span><input type="text" maxLength={4096} spellCheck={false} autoComplete="off" disabled={busy || indexed}
        placeholder={p.managed} value={indexed ? selected?.root ?? '' : draft.vaultRoot ?? ''} onChange={event => onDraft({ ...draft, vaultRoot: event.target.value.trim() ? event.target.value : null })} /></label>
      <p className="muted small">{indexed ? p.indexedHint : p.folderHint}</p>
      <label><input type="checkbox" checked={draft.minutesEnabled} disabled={busy} onChange={event => onDraft({ ...draft, minutesEnabled: event.target.checked })} /> {p.minutes}</label>
      <p className="muted small">{p.minutesHint}</p>
      <fieldset disabled={busy}><legend>{p.learningTitle}</legend>
        <label className="field"><span><input type="checkbox" checked={learning.enabled}
          onChange={event => onDraft({ ...draft, automaticLearning: { ...learning, enabled: event.target.checked } })} /> {p.learningEnabled}</span></label>
        <label className="field"><span><input type="checkbox" checked={learning.skills} disabled={!learning.enabled}
          onChange={event => onDraft({ ...draft, automaticLearning: { ...learning, skills: event.target.checked } })} /> {p.learningSkills}</span></label>
        <label className="field"><span><input type="checkbox" checked={learning.notes} disabled={!learning.enabled}
          onChange={event => onDraft({ ...draft, automaticLearning: { ...learning, notes: event.target.checked } })} /> {p.learningNotes}</span></label>
        <p className="muted small">{p.learningHint}</p><p className="muted small">{p.learningConsent}</p>
      </fieldset>
      <fieldset disabled={busy}><legend>{p.workspaces}</legend>{catalog.workspaces.map(workspace => <label className="field" key={workspace.id}>
        <span><input type="checkbox" checked={draft.workspaceIds.includes(workspace.id)} disabled={indexed && workspace.profileId === catalog.defaultProfileId}
          onChange={() => onDraft(toggleVaultWorkspace(draft, workspace.id))} /> {workspace.name}</span>
      </label>)}</fieldset>
      <p className="muted small">{p.bindingHint}</p><p className="muted small">{p.busyHint}</p>
      <button type="submit" className="button small primary" disabled={busy || !draft.name.trim()}>{p.save}</button>
    </form>
    {notice && <p role="status">{notice}</p>}{error && <p className="form-error" role="alert">{error}</p>}
  </section>;
}

export function VaultProfilesSection({ t, agents, locked, changed }: { t: Messages; agents: AgentHostApi; locked?: boolean | undefined; changed?: number | undefined }) {
  const [catalog, setCatalog] = useState<VaultProfilesCatalog>();
  const [draft, setDraft] = useState<VaultProfileDraft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [hidden, setHidden] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    if (!agents.listVaultProfiles || !agents.saveVaultProfile) return;
    let live = true;
    agents.listVaultProfiles().then(value => {
      if (!live) return;
      setCatalog(value); setDraft(current => vaultProfileDraft(value.profiles.find(profile => profile.id === current?.id) ?? value.profiles[0]!)); setError(undefined);
    }, failure => { if (live) { const message = errorMessage(failure); if (isUnsupportedMessage(message)) setHidden(true); else setError(message); } }).finally(() => { if (live) setBusy(false); });
    return () => { live = false; };
  }, [agents, refresh, changed]);
  if (hidden || !agents.listVaultProfiles || !agents.saveVaultProfile) return null;
  if (!catalog || !draft) return error ? <p className="form-error" role="alert">{error}</p> : null;
  const save = async () => {
    if (busy || locked) return;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = await agents.saveVaultProfile!({ ...draft, vaultRoot: draft.id === catalog.defaultProfileId ? null : draft.vaultRoot,
        expectedRevision: catalog.revision });
      setCatalog(next);
      const selected = next.profiles.find(profile => draft.id ? profile.id === draft.id : !catalog.profiles.some(previous => previous.id === profile.id));
      if (selected) setDraft(vaultProfileDraft(selected));
      setNotice(t.vaultProfiles.saved);
    } catch (failure) { setError(errorMessage(failure)); } finally { setBusy(false); }
  };
  return <VaultProfilesView t={t} catalog={catalog} draft={draft} busy={busy || !!locked} error={error} notice={notice} onDraft={setDraft}
    onSelect={profile => { setDraft(vaultProfileDraft(profile)); setNotice(undefined); }}
    onNew={() => { setDraft({ name: '', vaultRoot: null, workspaceIds: [], minutesEnabled: true, automaticLearning: { enabled: true, skills: true, notes: true } }); setNotice(undefined); }}
    onSave={() => void save()} onRefresh={() => setRefresh(value => value + 1)} />;
}
