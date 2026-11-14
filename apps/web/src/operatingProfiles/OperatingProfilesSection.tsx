import { EFFORTS, OPERATING_PROFILE_LIMITS, type OperatingProfile } from '@extalia/core';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Select } from '../ui/Select';
import { ComboBox } from '../ui/ComboBox';
import { TeamSetupDialog } from '../office/TeamSetupDialog';
import { profileDraft, profileInput, type ProfileDraft } from './profileDraft';
import './operatingProfiles.css';

type Props = { t: Messages; agents: AgentHostApi; state: HostState; onState(state: HostState): void; onCatalogChanged?(): void };
export function OperatingProfilesSection(props: Props) {
  const [scope, setScope] = useState({ agents: props.agents, profile: props.state.profile.id, revision: 0 });
  const changed = scope.agents !== props.agents || scope.profile !== props.state.profile.id;
  const revision = scope.revision + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, profile: props.state.profile.id, revision });
  return <ProfileEditor key={revision} {...props} />;
}

function ProfileEditor({ t, agents, state, onState, onCatalogChanged }: Props) {
  const text = t.operatingProfiles, id = useId();
  const [profiles, setProfiles] = useState<OperatingProfile[]>();
  const [draft, setDraft] = useState<ProfileDraft>();
  const [error, setError] = useState<string>();
  const [status, setStatus] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<OperatingProfile>();
  const [teamOpen, setTeamOpen] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const [loadedRefresh, setLoadedRefresh] = useState(-1);
  const nativeWorkspaces = state.workspaces.filter(workspace => workspace.mode !== 'observe' && workspace.runtimeId !== 'hermes');
  const [catalogWorkspaceId, setCatalogWorkspaceId] = useState(nativeWorkspaces[0]?.id ?? '');
  const operation = useRef({ active: true, busy: false, refresh: 0 });
  const supported = typeof agents.listOperatingProfiles === 'function' && typeof agents.saveOperatingProfile === 'function' && typeof agents.deleteOperatingProfile === 'function';
  useEffect(() => {
    const current = { active: true, busy: false, refresh: 0 }; operation.current = current;
    if (supported) agents.listOperatingProfiles!().then(value => { if (current.active) { setProfiles(value); setLoadedRefresh(refresh); } }, failure => { if (current.active) { setError(errorMessage(failure)); setLoadedRefresh(refresh); } });
    return () => { current.active = false; };
  }, [agents, supported, refresh]);
  const edit = (profile?: OperatingProfile) => { setDraft(profileDraft(profile)); setError(undefined); setStatus(undefined); setConfirm(undefined); };
  const patch = (value: Partial<ProfileDraft>) => setDraft(current => current ? { ...current, ...value } : current);
  const run = async (action: () => Promise<void>) => {
    const current = operation.current;
    if (!current.active || current.busy) return;
    current.busy = true; setBusy(true); setError(undefined); setStatus(undefined);
    try { await action(); } catch (failure) { if (current.active) setError(errorMessage(failure)); }
    finally { current.busy = false; if (current.active) setBusy(false); }
  };
  const refreshHostState = () => {
    const current = operation.current, revision = ++current.refresh;
    void agents.getState().then(next => { if (current.active && current.refresh === revision) onState(next); }, failure => { if (current.active && current.refresh === revision) setError(errorMessage(failure)); });
  };
  const save = () => run(async () => {
    if (!draft) return;
    const saved = await agents.saveOperatingProfile!(profileInput(draft));
    if (!operation.current.active) return;
    setProfiles(current => [...(current ?? []).filter(profile => profile.id !== saved.id), saved]); setDraft(undefined); setStatus(text.saved);
    onCatalogChanged?.();
    refreshHostState();
  });
  const remove = () => run(async () => {
    if (!confirm) return;
    await agents.deleteOperatingProfile!(confirm.id, confirm.revision);
    if (!operation.current.active) return;
    setProfiles(current => current?.filter(profile => profile.id !== confirm.id)); setConfirm(undefined);
    onCatalogChanged?.();
    refreshHostState();
  });
  const reload = () => run(async () => {
    const value = await agents.listOperatingProfiles!();
    if (!operation.current.active) return;
    setProfiles(value); setStatus(text.refreshed); onCatalogChanged?.(); refreshHostState();
  });
  const connection = state.connections.find(item => item.id === draft?.connectionId);
  const catalogWorkspace = nativeWorkspaces.find(workspace => workspace.id === catalogWorkspaceId) ?? nativeWorkspaces[0];
  const loadingProfiles = loadedRefresh !== refresh;
  return <section className="card settings-section operating-profiles" aria-labelledby={`${id}-title`}>
    <div className="section-head"><div><h2 id={`${id}-title`}>{text.title}</h2><p className="muted small">{text.lead}</p></div>
      {supported && <div className="actions">{!draft && <button type="button" className="button" disabled={busy || loadingProfiles || !profiles || profiles.length >= OPERATING_PROFILE_LIMITS.profiles} onClick={() => edit()}>{text.add}</button>}
        <button type="button" className="button" disabled={busy || loadingProfiles} onClick={() => void reload()}>{text.refreshList}</button></div>}
    </div>
    <p className="muted small">{text.nativeOnly} {text.boundary}</p>
    {!supported ? <p role="status">{text.unsupported}</p> : <>
      <p className="note">{text.futureOnly}</p>
      {!profiles && !error && <p role="status">{t.common.loading}</p>}
      {!profiles && error && <button type="button" className="button small" onClick={() => { setError(undefined); setRefresh(value => value + 1); }}>{t.common.retry}</button>}
      {draft ? <form className="editor operating-profile-editor" aria-label={draft.id ? text.edit : text.add} onSubmit={event => { event.preventDefault(); void save(); }}>
        <label className="field" htmlFor={`${id}-name`}>{text.name}<input type="text" id={`${id}-name`} value={draft.name} maxLength={120} required disabled={busy} onChange={event => patch({ name: event.target.value })} /></label>
        <div className="operating-profile-grid">
          <label className="field" htmlFor={`${id}-purpose`}>{text.purpose}<textarea id={`${id}-purpose`} value={draft.purpose} rows={3} maxLength={OPERATING_PROFILE_LIMITS.purpose} disabled={busy} aria-describedby={`${id}-purpose-help`} onChange={event => patch({ purpose: event.target.value })} /><small id={`${id}-purpose-help`} className="muted">{text.purposeHint}</small></label>
          <label className="field" htmlFor={`${id}-personality`}>{text.personality}<textarea id={`${id}-personality`} value={draft.personality} rows={3} maxLength={OPERATING_PROFILE_LIMITS.personality} disabled={busy} aria-describedby={`${id}-personality-help`} onChange={event => patch({ personality: event.target.value })} /><small id={`${id}-personality-help`} className="muted">{text.personalityHint}</small></label>
        </div>
        <fieldset><legend>{text.leadAgent}</legend><div className="operating-profile-grid">
          <div className="field"><Select id={`${id}-connection`} label={text.connection} value={draft.connectionId} disabled={busy}
            options={[{ value: '', label: text.inheritConnection }, ...state.connections.map(item => ({ value: item.id, label: item.name })),
              ...(draft.connectionId && !connection ? [{ value: draft.connectionId, label: t.settings.missingConnection, disabled: true }] : [])]}
            onChange={connectionId => patch({ connectionId, model: '' })} /></div>
          <div className="field"><ComboBox id={`${id}-model`} label={text.model} value={draft.model} maxLength={200} disabled={busy} placeholder={connection?.model ?? ''}
            options={[{ value: '', label: text.inheritEffort }, ...[...new Set([connection?.model, ...(draft.team?.allowedModels ?? [])].filter((model): model is string => Boolean(model)))].map(model => ({ value: model, label: model }))]}
            customLabel={t.connection.modelCustom} emptyLabel={t.connection.modelEmpty} describedBy={`${id}-model-help`} onChange={model => patch({ model })} />
            <small id={`${id}-model-help`} className="muted">{text.modelHint}</small></div>
          <div className="field"><Select id={`${id}-effort`} label={text.effort} value={draft.effort} disabled={busy}
            options={[{ value: '', label: text.inheritEffort }, ...EFFORTS.map(effort => ({ value: effort, label: t.connection.efforts[effort] }))]}
            onChange={effort => patch({ effort: effort as ProfileDraft['effort'] })} /></div>
          <label className="field" htmlFor={`${id}-role`}>{text.role}<input type="text" id={`${id}-role`} value={draft.leadRole} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={busy} onChange={event => patch({ leadRole: event.target.value })} /></label>
        </div>
          <label className="field" htmlFor={`${id}-task`}>{text.responsibility}<textarea id={`${id}-task`} rows={2} value={draft.leadTask} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={busy} onChange={event => patch({ leadTask: event.target.value })} /></label>
          <label className="check-row"><input type="checkbox" checked={draft.inheritPersonality} disabled={busy} onChange={event => patch({ inheritPersonality: event.target.checked })} />{text.inheritPersonality}</label>
          {!draft.inheritPersonality && <label className="field" htmlFor={`${id}-soul`}>{text.ownPersonality}<textarea id={`${id}-soul`} rows={3} value={draft.leadSoul} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={busy} onChange={event => patch({ leadSoul: event.target.value })} /><small className="muted">{text.ownHint}</small></label>}
        </fieldset>
        <fieldset><legend>{text.team}</legend>
          <div className="field"><Select id={`${id}-team-mode`} label={text.team} disabled={busy} value={draft.team === undefined ? 'inherit' : draft.team === null ? 'solo' : 'team'}
            options={[{ value: 'inherit', label: text.inheritTeam }, { value: 'solo', label: text.solo }, { value: 'team', label: text.configuredTeam }]}
            onChange={mode => patch({ team: mode === 'inherit' ? undefined : mode === 'solo' ? null : draft.team ?? { enabled: true, allowedModels: [], members: [] } })} /></div>
          {draft.team && <>
            <p className="small">{text.teamSummary(draft.team.members.length)}</p>
            {catalogWorkspace ? <><div className="field"><Select id={`${id}-catalog-project`} label={text.catalogWorkspace} value={catalogWorkspace.id} disabled={busy}
              options={nativeWorkspaces.map(workspace => ({ value: workspace.id, label: workspace.name }))} aria-describedby={`${id}-catalog-help`} onChange={setCatalogWorkspaceId} />
              <small id={`${id}-catalog-help`} className="muted">{text.catalogHint}</small></div>
              <button type="button" className="button" disabled={busy} onClick={() => setTeamOpen(true)}>{text.configureTeam}</button></> : <p className="muted">{text.noCatalogWorkspace}</p>}
          </>}
        </fieldset>
        {error && <p className="form-error" role="alert">{error}</p>}
        <div className="actions"><button type="submit" className="primary" disabled={busy || !draft.name.trim()}>{busy ? t.common.saving : t.common.save}</button><button type="button" disabled={busy} onClick={() => { setDraft(undefined); setError(undefined); }}>{t.common.cancel}</button></div>
      </form> : <>
        {profiles?.length === 0 && <p className="muted">{text.empty}</p>}
        <ul className="entity-list">{profiles?.map(profile => <li className="entity" key={profile.id}><div className="entity-main"><strong>{profile.name}</strong>{profile.purpose && <p className="muted small">{profile.purpose}</p>}<span className="muted small">{profile.defaults.team ? text.teamSummary(profile.defaults.team.members.length) : profile.defaults.team === null ? text.solo : text.inheritTeam}</span></div>
          <div className="row-actions"><button type="button" className="button small" disabled={busy || loadingProfiles} aria-label={`${text.edit}: ${profile.name}`} onClick={() => edit(profile)}>{t.common.edit}</button><button type="button" className="button small danger" disabled={busy || loadingProfiles} aria-label={`${t.common.delete}: ${profile.name}`} onClick={() => { setConfirm(profile); setError(undefined); }}>{t.common.delete}</button></div>
        </li>)}</ul>
        {confirm && <div className="note operating-profile-delete" role="alertdialog" aria-label={text.deleteTitle(confirm.name)}><strong>{text.deleteTitle(confirm.name)}</strong><p>{text.deleteHint}</p><div className="actions"><button type="button" className="danger" disabled={busy} onClick={() => void remove()}>{t.common.delete}</button><button type="button" disabled={busy} onClick={() => setConfirm(undefined)}>{t.common.cancel}</button></div></div>}
        {error && <p className="form-error" role="alert">{error}</p>}
      </>}
      {status && <p role="status">{status}</p>}
      {teamOpen && draft?.team && catalogWorkspace && <TeamSetupDialog key={`${draft.id ?? 'new'}-${catalogWorkspace.id}-${draft.connectionId}`} t={t} agents={agents} workspaceId={catalogWorkspace.id} scope="draft" pending={draft.team} profileDraft catalogConnectionId={draft.connectionId || undefined}
        onSaved={team => patch({ team })} onClose={() => setTeamOpen(false)} />}
    </>}
  </section>;
}
