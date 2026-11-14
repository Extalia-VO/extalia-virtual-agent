import type { OperatingProfile, Workspace } from '@extalia/core';
import type { AgentHostApi, HostState } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Select } from '../ui/Select';
import './operatingProfiles.css';

type Props = {
  t: Messages; agents: AgentHostApi; workspace: Workspace; profiles: readonly OperatingProfile[];
  onState(state: HostState): void;
};
export function WorkspaceProfilePicker(props: Props) {
  const native = props.workspace.mode !== 'observe' && props.workspace.runtimeId !== 'hermes';
  const [scope, setScope] = useState({ agents: props.agents, id: props.workspace.id, native, key: 0 });
  const changed = scope.agents !== props.agents || scope.id !== props.workspace.id || scope.native !== native;
  const key = scope.key + (changed ? 1 : 0);
  if (changed) setScope({ agents: props.agents, id: props.workspace.id, native, key });
  return <ProfilePicker key={key} {...props} />;
}
function ProfilePicker({ t, agents, workspace, profiles, onState }: Props) {
  const text = t.operatingProfiles, id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const owner = useRef({ active: true, busy: false });
  useEffect(() => { const operation = owner.current; operation.active = true; return () => { operation.active = false; }; }, []);
  const native = workspace.mode !== 'observe' && workspace.runtimeId !== 'hermes';
  if (typeof agents.setWorkspaceOperatingProfile !== 'function') return null;
  const selected = profiles.find(profile => profile.id === workspace.operatingProfileId);
  const customized = Object.keys(workspace.operatingProfileOverrides ?? {}).length > 0;
  async function apply(profileId: string | null) {
    const operation = owner.current;
    if (!native || !operation.active || operation.busy) return;
    operation.busy = true; setBusy(true); setError(undefined); setSaved(false);
    try {
      const state = await agents.setWorkspaceOperatingProfile!(workspace.id, { profileId, overrides: {} });
      if (!operation.active) return;
      onState(state); setSaved(true);
    } catch (failure) { if (operation.active) setError(errorMessage(failure)); }
    finally { operation.busy = false; if (operation.active) setBusy(false); }
  }
  return <div className="workspace-operating-profile">
    <Select id={`${id}-profile`} label={text.assignment} value={workspace.operatingProfileId ?? ''} disabled={busy || !native}
      options={[{ value: '', label: text.noProfile }, ...profiles.map(profile => ({ value: profile.id, label: profile.name })),
        ...(workspace.operatingProfileId && !selected ? [{ value: workspace.operatingProfileId, label: text.missingProfile, disabled: true }] : [])]}
      onChange={profileId => { void apply(profileId || null); }} />
    {!native ? <small className="muted">{text.nativeOnly}</small> : selected && <>
      <small className="muted">{customized ? text.customized : text.inherited} · {text.futureOnly}</small>
      {customized && <div className="actions"><button type="button" className="button small" disabled={busy} onClick={() => void apply(selected.id)}>{text.reset}</button></div>}
    </>}
    {error && <p role="alert" className="form-error">{error}</p>}{saved && <small role="status">{text.assignmentSaved}</small>}
  </div>;
}
