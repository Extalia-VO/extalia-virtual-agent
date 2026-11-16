import { normalizeAutomaticLearningPolicy, type AgentHostApi, type FileSystemCapability, type SaveVaultProfileInput, type VaultProfile, type VaultProfilesCatalog } from '@extalia/platform';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { Messages } from '../../i18n';
import { errorMessage } from '../../host/remote';
import { isUnsupportedMessage } from '../../knowledge/knowledgeModel';
import { HostFolderPicker } from '../../ui/HostFolderPicker';
import { CopyButton } from '../../ui/CopyButton';

export type VaultProfileDraft = Omit<SaveVaultProfileInput, 'expectedRevision'>;
export const vaultProfileDraft = (profile: VaultProfile): VaultProfileDraft => ({ id: profile.id, name: profile.name,
  vaultRoot: profile.kind === 'custom' ? profile.root : null, workspaceIds: [...profile.workspaceIds], minutesEnabled: profile.minutesEnabled, automaticLearning: normalizeAutomaticLearningPolicy(profile.automaticLearning) });
export function toggleVaultWorkspace(draft: VaultProfileDraft, workspaceId: string): VaultProfileDraft {
  return { ...draft, workspaceIds: draft.workspaceIds.includes(workspaceId) ? draft.workspaceIds.filter(id => id !== workspaceId) : [...draft.workspaceIds, workspaceId] };
}

export function VaultProfilesView({ t, catalog, draft, busy, error, notice, folderControl, onDraft, onSelect, onNew, onSave, onRefresh }: {
  t: Messages; catalog: VaultProfilesCatalog; draft: VaultProfileDraft; busy: boolean; error?: string | undefined; notice?: string | undefined;
  onDraft(draft: VaultProfileDraft): void; onSelect(profile: VaultProfile): void; onNew(): void; onSave(): void; onRefresh(): void;
  folderControl?: ReactNode;
}) {
  const p = t.vaultProfiles, observedHintId = useId();
  const indexed = draft.id === catalog.defaultProfileId;
  const learning = normalizeAutomaticLearningPolicy(draft.automaticLearning);
  const selected = catalog.profiles.find(profile => profile.id === draft.id);
  const selectedPath = indexed ? selected?.root : draft.vaultRoot ?? (selected?.kind === 'managed' ? selected.root : undefined);
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
      <div className="field"><span>{p.root}</span><div className="knowledge-folder-location" role="group" aria-label={p.root}><code>{selectedPath ?? p.managed}</code>
        {selectedPath && <CopyButton text={selectedPath} label={p.root} />}</div></div>
      {!indexed && <div className="actions">{folderControl}<button type="button" className="button small" disabled={busy || !draft.vaultRoot} onClick={() => onDraft({ ...draft, vaultRoot: null })}>{t.knowledgeVault.useManaged}</button></div>}
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
        <label className="field"><span><input type="checkbox" checked={learning.observed === true} disabled={!learning.enabled} aria-describedby={observedHintId}
          onChange={event => onDraft({ ...draft, automaticLearning: { ...learning, observed: event.target.checked } })} /> {p.learningObserved}</span></label>
        <p id={observedHintId} className="muted small">{p.learningObservedHint}</p>
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

type SectionProps = { t: Messages; agents: AgentHostApi; picker?: FileSystemCapability | undefined; locked?: boolean | undefined; changed?: number | undefined };
export function VaultProfilesSection(props: SectionProps) {
  const [scope, setScope] = useState({ agents: props.agents, key: 0 });
  const changed = scope.agents !== props.agents, key = scope.key + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, key });
  return <VaultProfilesEditor key={key} {...props} />;
}
function VaultProfilesEditor({ t, agents, picker, locked, changed }: SectionProps) {
  const live = useRef(true), saving = useRef(false);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  const [catalog, setCatalog] = useState<VaultProfilesCatalog>();
  const [draft, setDraft] = useState<VaultProfileDraft>();
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
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
  if (!catalog || !draft) return <section className="card settings-section" aria-busy={!error || undefined}>
    <h2>{t.vaultProfiles.title}</h2>
    {error ? <><p className="form-error" role="alert">{error}</p>
      <button type="button" className="button small" onClick={() => { setError(undefined); setRefresh(value => value + 1); }}>{t.common.retry}</button></>
      : <p className="muted small" role="status">{t.common.loading}</p>}
  </section>;
  const save = async () => {
    if (saving.current || choosing || locked || !live.current) return;
    saving.current = true;
    setBusy(true); setError(undefined); setNotice(undefined);
    try {
      const next = await agents.saveVaultProfile!({ ...draft, vaultRoot: draft.id === catalog.defaultProfileId ? null : draft.vaultRoot,
        expectedRevision: catalog.revision });
      if (!live.current) return;
      setCatalog(next);
      const selected = next.profiles.find(profile => draft.id ? profile.id === draft.id : !catalog.profiles.some(previous => previous.id === profile.id));
      if (selected) setDraft(vaultProfileDraft(selected));
      setNotice(t.vaultProfiles.saved);
    } catch (failure) { if (live.current) setError(errorMessage(failure)); } finally { saving.current = false; if (live.current) setBusy(false); }
  };
  const selected = catalog.profiles.find(profile => profile.id === draft.id);
  return <VaultProfilesView t={t} catalog={catalog} draft={draft} busy={busy || choosing || !!locked} error={error} notice={notice} onDraft={setDraft}
    folderControl={<HostFolderPicker key={`${catalog.revision}:${draft.id ?? 'new'}`} t={t} purpose="knowledge-vault" title={t.directoryPicker.vault} agents={agents} picker={picker} startPath={draft.vaultRoot ?? (selected?.kind === 'managed' ? selected.root : undefined)} disabled={busy || locked}
      onBusyChange={setChoosing} onSelect={path => { if (live.current && !locked && !saving.current) setDraft(current => current ? { ...current, vaultRoot: path } : current); }} />}
    onSelect={profile => { setDraft(vaultProfileDraft(profile)); setNotice(undefined); }}
    onNew={() => { setDraft({ name: '', vaultRoot: null, workspaceIds: [], minutesEnabled: true, automaticLearning: { enabled: true, skills: true, notes: true } }); setNotice(undefined); }}
    onSave={() => void save()} onRefresh={() => setRefresh(value => value + 1)} />;
}
