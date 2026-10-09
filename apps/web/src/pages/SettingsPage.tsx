import type { HostState, Platform, UpdateStatus } from '@extalia/platform';
import { LANGUAGES, type Messages } from '../i18n';
import type { Preferences } from '../preferences';
import { useState } from 'react';
import { errorMessage } from '../host/remote';
import { UpdatesSection } from '../updates/Updates';
import { Select } from '../ui/Select';
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
          <div className="field">
            <Select
              label={t.settings.theme}
              value={preferences.theme}
              options={([
                { value: 'system' as const, label: t.settings.themes.system, icon: 'monitor' as const },
                { value: 'light' as const, label: t.settings.themes.light, icon: 'sun' as const },
                { value: 'dark' as const, label: t.settings.themes.dark, icon: 'moon' as const }
              ])}
              onChange={val => onChange({ ...preferences, theme: val })}
            />
          </div>
          <div className="field">
            <Select
              label={t.settings.material}
              value={preferences.material}
              options={([
                { value: 'standard' as const, label: t.settings.materials.standard, description: 'Classic solid surfaces' },
                { value: 'liquid-glass' as const, label: t.settings.materials['liquid-glass'], description: 'macOS frosted blur & vibrance', badge: 'macOS' }
              ])}
              onChange={val => onChange({ ...preferences, material: val })}
            />
            <small className="muted">{t.settings.materialHint}</small>
          </div>
          <div className="field">
            <Select
              label={t.settings.language}
              value={preferences.language}
              options={LANGUAGES.map(lang => ({
                value: lang.id,
                label: lang.label,
                icon: 'globe' as const
              }))}
              onChange={val => onChange({ ...preferences, language: val })}
            />
          </div>
          <div className="field">
            <Select
              label={t.settings.sidebar}
              value={preferences.sidebar}
              options={([
                { value: 'expanded' as const, label: t.settings.sidebars.expanded, icon: 'panel' as const },
                { value: 'compact' as const, label: t.settings.sidebars.compact, icon: 'menu' as const }
              ])}
              onChange={val => onChange({ ...preferences, sidebar: val })}
            />
          </div>
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
