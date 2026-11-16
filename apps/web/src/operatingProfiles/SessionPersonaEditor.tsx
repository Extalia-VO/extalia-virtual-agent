import { OPERATING_PROFILE_LIMITS, type AgentPersona, type SessionOperatingProfile } from '@extalia/core';
import type { AgentHostApi } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import './operatingProfiles.css';

interface Loaded { agents: AgentHostApi; sessionId: string; profile?: SessionOperatingProfile; lead: AgentPersona }
export function SessionPersonaEditor({ t, agents, sessionId, running, onSaved }: {
  t: Messages; agents: AgentHostApi; sessionId: string; running: boolean; onSaved?(): void;
}) {
  const text = t.operatingProfiles, id = useId();
  const [loaded, setLoaded] = useState<Loaded>();
  const [failure, setFailure] = useState<{ agents: AgentHostApi; sessionId: string; message: string }>();
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const owner = useRef<{ active: boolean; busy: boolean }>({ active: true, busy: false });
  const supported = typeof agents.getSessionOperatingProfile === 'function' && typeof agents.saveSessionOperatingProfile === 'function';
  const current = loaded?.agents === agents && loaded.sessionId === sessionId ? loaded : undefined;
  const error = failure?.agents === agents && failure.sessionId === sessionId ? failure.message : undefined;
  useEffect(() => {
    const operation = { active: true, busy: false }; owner.current = operation;
    if (supported) agents.getSessionOperatingProfile!(sessionId).then(profile => {
      if (operation.active) { setLoaded({ agents, sessionId, ...(profile ? { profile } : {}), lead: { ...profile?.lead } }); setBusy(false); setSaved(false); }
    }, error => { if (operation.active) { setFailure({ agents, sessionId, message: errorMessage(error) }); setBusy(false); setSaved(false); } });
    return () => { operation.active = false; };
  }, [agents, sessionId, supported]);
  const update = (patch: AgentPersona) => { setSaved(false); setLoaded(value => value?.agents === agents && value.sessionId === sessionId ? { ...value, lead: { ...value.lead, ...patch } } : value); };
  const inherit = () => {
    setSaved(false); setLoaded(value => {
      if (!value || value.agents !== agents || value.sessionId !== sessionId) return value;
      const { soul: _soul, ...lead } = value.lead;
      return { ...value, lead };
    });
  };
  async function save() {
    const operation = owner.current;
    if (!current || !operation.active || operation.busy || running) return;
    operation.busy = true; setBusy(true); setFailure(undefined); setSaved(false);
    try {
      const profile = await agents.saveSessionOperatingProfile!(sessionId, { lead: current.lead });
      if (!operation.active) return;
      setLoaded({ agents, sessionId, ...(profile ? { profile } : {}), lead: { ...profile?.lead } }); setSaved(true); onSaved?.();
    } catch (error) { if (operation.active) setFailure({ agents, sessionId, message: errorMessage(error) }); }
    finally { operation.busy = false; if (operation.active) setBusy(false); }
  }
  if (!supported) return null;
  const disabled = busy || running;
  return <details className="session-persona-editor">
    <summary>{text.sessionTitle}</summary>
    <p className="muted small">{text.sessionHint}</p>
    {current?.profile?.name && <p className="note">{current.profile.name}</p>}
    {current?.profile?.purpose && <p className="muted small">{text.purpose}: {current.profile.purpose}</p>}
    {running && <p role="status" className="muted small">{text.idleHint}</p>}
    {!current && !error && <p role="status">{t.common.loading}</p>}
    {current && <form onSubmit={event => { event.preventDefault(); void save(); }}>
      <label className="field" htmlFor={`${id}-role`}>{text.role}<input type="text" id={`${id}-role`} value={current.lead.role ?? ''} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={disabled} onChange={event => update({ role: event.target.value })} /></label>
      <label className="field" htmlFor={`${id}-task`}>{text.responsibility}<textarea id={`${id}-task`} rows={2} value={current.lead.task ?? ''} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={disabled} onChange={event => update({ task: event.target.value })} /></label>
      <label className="check-row"><input type="checkbox" checked={current.lead.soul === undefined} disabled={disabled} onChange={event => event.target.checked ? inherit() : update({ soul: '' })} />{text.inheritPersonality}</label>
      {current.lead.soul === undefined ? current.profile?.personality && <p className="muted small">{current.profile.personality}</p> : <label className="field" htmlFor={`${id}-soul`}>{text.ownPersonality}<textarea id={`${id}-soul`} rows={3} value={current.lead.soul} maxLength={OPERATING_PROFILE_LIMITS.persona} disabled={disabled} onChange={event => update({ soul: event.target.value })} /><small className="muted">{text.ownHint}</small></label>}
      <div className="actions"><button type="submit" className="button small" disabled={disabled}>{busy ? t.common.saving : t.common.save}</button></div>
    </form>}
    {error && <p role="alert" className="form-error">{error}</p>}{saved && <p role="status">{text.sessionSaved}</p>}
  </details>;
}
