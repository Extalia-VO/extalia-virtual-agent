import type { HostState, Platform, UpdateStatus } from '@extalia/platform';
import { LANGUAGES, type Language, type Messages } from '../i18n';
import type { MaterialPreference, Preferences, SidebarPreference, ThemePreference } from '../preferences';
import { useState } from 'react';
import { errorMessage } from '../host/remote';
import { UpdatesSection } from '../updates/Updates';
import { ConnectionsSection } from './settings/ConnectionsSection';
import { WorkspacesSection } from './settings/WorkspacesSection';

export function SettingsPage({ t, platform, preferences, onChange, hostState, onHostState, updateStatus }: {
  t: Messages;
  platform: Platform;
  preferences: Preferences;
  onChange: (next: Preferences) => void;
  /** Present only when agents are available; agent sections are hidden otherwise. */
  hostState: HostState | null;
  onHostState: (next: HostState) => void;
  updateStatus: UpdateStatus | null;
}) {
  const { agents, updater } = platform.capabilities;
  const picker = hostState?.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined;
  const [workflowError, setWorkflowError] = useState<string>();
  const [workflowBusy, setWorkflowBusy] = useState(false);
  return (
    <div className="page">
      <header className="page-header">
        <h1>{t.settings.title}</h1>
        <p className="lead">{t.settings.lead}</p>
      </header>
      {agents && hostState && <section className="card settings-section"><h2>{t.observer.workflow}</h2><div className="actions">
        {(['managed', 'observe'] as const).map(mode => <button key={mode} type="button" disabled={workflowBusy} aria-pressed={(hostState.workflow ?? 'managed') === mode} onClick={() => {
          setWorkflowBusy(true); setWorkflowError(undefined); agents.setWorkflow(mode).then(onHostState, failure => setWorkflowError(errorMessage(failure))).finally(() => setWorkflowBusy(false));
        }}>{t.observer[mode]}</button>)}
      </div>{workflowError && <p role="alert" className="form-error">{workflowError}</p>}</section>}
      <section className="card settings-section" aria-labelledby="settings-interface">
        <h2 id="settings-interface">{t.settings.interface}</h2>
        <div className="settings">
          <label className="field">
            <span>{t.settings.theme}</span>
            <select value={preferences.theme} onChange={event => onChange({ ...preferences, theme: event.target.value as ThemePreference })}>
              {(['system', 'light', 'dark'] as const).map(theme => <option key={theme} value={theme}>{t.settings.themes[theme]}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t.settings.material}</span>
            <select value={preferences.material} onChange={event => onChange({ ...preferences, material: event.target.value as MaterialPreference })}>
              {(['standard', 'liquid-glass'] as const).map(material => <option key={material} value={material}>{t.settings.materials[material]}</option>)}
            </select>
            <small className="muted">{t.settings.materialHint}</small>
          </label>
          <label className="field">
            <span>{t.settings.language}</span>
            <select value={preferences.language} onChange={event => onChange({ ...preferences, language: event.target.value as Language })}>
              {LANGUAGES.map(language => <option key={language.id} value={language.id}>{language.label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>{t.settings.sidebar}</span>
            <select value={preferences.sidebar} onChange={event => onChange({ ...preferences, sidebar: event.target.value as SidebarPreference })}>
              {(['expanded', 'compact'] as const).map(mode => <option key={mode} value={mode}>{t.settings.sidebars[mode]}</option>)}
            </select>
          </label>
        </div>
      </section>
      {agents && hostState && (
        <>
          <ConnectionsSection t={t} agents={agents} state={hostState} onState={onHostState} />
          <WorkspacesSection t={t} agents={agents} picker={picker} state={hostState} onState={onHostState} />
        </>
      )}
      {updater && <UpdatesSection t={t} updater={updater} status={updateStatus} />}
    </div>
  );
}
