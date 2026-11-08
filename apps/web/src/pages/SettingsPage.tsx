import type { HostState, Platform, UpdateStatus } from '@extalia/platform';
import { LANGUAGES, type Messages } from '../i18n';
import { MATERIALS, type Preferences } from '../preferences';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { errorMessage } from '../host/remote';
import { UpdatesSection } from '../updates/Updates';
import { CopyButton } from '../ui/CopyButton';
import { RestartPrompt } from '../ui/RestartPrompt';
import { Select } from '../ui/Select';
import { ApprovalNotificationSetting } from '../approvals/NotificationSetting';
import { ConnectAgentAppsCard } from './ConnectAgentAppsCard';
import { AutoWatchLocations, IgnoredFolders } from './AutoWatchLocations';
import { availableSettingsSections, nextSettingsSection, resolveSettingsSection, type SettingsSection } from './settings/settingsSections';
import './settings/settingsNav.css';

import { ConnectionsSection } from './settings/ConnectionsSection';
import { WorkspacesSection } from './settings/WorkspacesSection';
import { KnowledgeVaultSection } from './settings/KnowledgeVaultSection';
import { Icon } from '../ui/Icon';

export type { SettingsSection } from './settings/settingsSections';

type SettingsPageProps = {
  t: Messages;
  platform: Platform;
  preferences: Preferences;
  onChange: (next: Preferences) => void;
  /** Present only when agents are available; agent sections are hidden otherwise. */
  hostState: HostState | null;
  onHostState: (next: HostState) => void;
  updateStatus: UpdateStatus | null;
  /** ADR 0028: open this workspace's editor at its integration test gate. */
  editGateFor?: string;
  onEditGateHandled?: () => void;
  /** Skills moved to their own page; with a workspace id the page opens on that workspace. */
  onOpenSkills?: (workspaceId?: string) => void;
  /** Optional controlled section, used by contextual Settings shortcuts. */
  section?: SettingsSection;
  onSectionChange?: (section: SettingsSection) => void;
  onOpenObserve?: () => void;
  onOpenImport?: () => void;
};

/** A changed host/profile discards its private editor drafts before new panels render. */
export function SettingsPage(props: SettingsPageProps) {
  const agents = props.platform.capabilities.agents;
  const profileId = props.hostState?.profile.id;
  const directory = props.hostState?.dataDirectory ?? props.hostState?.storage.dataDirectory;
  const [context, setContext] = useState({ agents, profileId, directory, revision: 0 });
  const changed = context.agents !== agents || context.profileId !== profileId || context.directory !== directory;
  const revision = context.revision + (changed ? 1 : 0);
  if (changed) setContext({ agents, profileId, directory, revision });
  return <SettingsPageContent key={revision} {...props} />;
}

function SettingsPageContent({ t, platform, preferences, onChange, hostState, onHostState, updateStatus, editGateFor, onEditGateHandled, onOpenSkills, section, onSectionChange, onOpenObserve, onOpenImport }: SettingsPageProps) {
  const { agents, updater } = platform.capabilities;
  const picker = hostState?.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined;
  const sections = availableSettingsSections({ agents: Boolean(agents && hostState), system: Boolean(updater || platform.capabilities.restart) });
  const [localSection, setLocalSection] = useState<SettingsSection>('general');
  const activeSection = resolveSettingsSection(section ?? localSection, sections, editGateFor);
  const [visited, setVisited] = useState<SettingsSection[]>([activeSection]);
  const tabsId = useId();
  const tabs = useRef(new Map<SettingsSection, HTMLButtonElement>());
  // A programmatic destination mounts in the current render; retaining it after
  // that visit keeps editor state alive when another destination is selected.
  if (!visited.includes(activeSection)) setVisited([...visited, activeSection]);
  useEffect(() => {
    if (section !== undefined || editGateFor) tabs.current.get(activeSection)?.focus();
  }, [section, editGateFor, activeSection]);
  const selectSection = (next: SettingsSection) => {
    setVisited(previous => previous.includes(next) ? previous : [...previous, next]);
    setLocalSection(next);
    onSectionChange?.(next);
  };
  const moveTab = (event: KeyboardEvent<HTMLButtonElement>, current: SettingsSection) => {
    const next = nextSettingsSection(current, event.key, sections);
    if (!next) return;
    event.preventDefault();
    selectSection(next);
    tabs.current.get(next)?.focus();
  };
  const [workflowError, setWorkflowError] = useState<string>();
  const [workflowBusy, setWorkflowBusy] = useState(false);
  const workflowOperation = useRef({ active: true, busy: false });
  useEffect(() => {
    const operation = workflowOperation.current;
    operation.active = true;
    return () => { operation.active = false; };
  }, []);
  const changeWorkflow = (mode: 'managed' | 'observe') => {
    const operation = workflowOperation.current;
    if (!agents || !operation.active || operation.busy) return;
    operation.busy = true;
    setWorkflowBusy(true); setWorkflowError(undefined);
    void agents.setWorkflow(mode).then(
      state => { if (operation.active) onHostState(state); },
      failure => { if (operation.active) setWorkflowError(errorMessage(failure)); },
    ).finally(() => {
      operation.busy = false;
      if (operation.active) setWorkflowBusy(false);
    });
  };
  return (
    <div className="page settings-page">
      <header className="page-header">
        <h1>{t.settings.title}</h1>
        <p className="lead">{agents && hostState ? t.pageRoles.settings : t.settings.lead}</p>
        {agents && hostState && (onOpenObserve || onOpenImport) && <div className="actions">
          {onOpenObserve && <button type="button" onClick={onOpenObserve}>{t.nav.observe}</button>}
          {onOpenImport && <button type="button" onClick={onOpenImport}>{t.nav.import}</button>}
        </div>}
      </header>
      <div className="settings-tabs" role="tablist" aria-label={t.settings.sections.label}>
        {sections.map(item => <button key={item} type="button" role="tab" id={`${tabsId}-${item}-tab`}
          ref={element => { if (element) tabs.current.set(item, element); else tabs.current.delete(item); }}
          aria-controls={`${tabsId}-${item}-panel`} aria-selected={activeSection === item} tabIndex={activeSection === item ? 0 : -1}
          onClick={() => selectSection(item)} onKeyDown={event => moveTab(event, item)}>{t.settings.sections[item]}</button>)}
      </div>
      {sections.map(item => <div key={item} className="settings-panel" role="tabpanel" id={`${tabsId}-${item}-panel`}
        aria-labelledby={`${tabsId}-${item}-tab`} hidden={activeSection !== item} tabIndex={0}>
        {(visited.includes(item) || activeSection === item) && <>
          <p className="muted settings-section-lead">{t.settings.sectionLead[item]}</p>
          {item === 'general' && <>
            <section className="card settings-section" aria-labelledby="settings-interface">
              <h2 id="settings-interface">{t.settings.interface}</h2>
              {agents && hostState && <p className="muted">{t.settings.leadProfile}</p>}
              <div className="settings">
                <div className="field">
                  <Select
                    label={t.settings.theme}
                    value={preferences.theme}
                    options={([
                      { value: 'solar' as const, label: t.settings.themes.solar, icon: 'sunrise' as const, badge: 'Auto' },
                      { value: 'system' as const, label: t.settings.themes.system, icon: 'monitor' as const },
                      { value: 'light' as const, label: t.settings.themes.light, icon: 'sun' as const },
                      { value: 'dark' as const, label: t.settings.themes.dark, icon: 'moon' as const }
                    ])}
                    onChange={val => onChange({ ...preferences, theme: val })}
                  />
                  <small className="muted" aria-live="polite">{t.settings.themeEffects[preferences.theme]} {t.settings.themeLightsNote}</small>
                </div>
                <div className="field">
                  <Select
                    label={t.settings.material}
                    value={preferences.material}
                    options={MATERIALS.map(material => ({
                      value: material,
                      label: t.settings.materials[material],
                      description: t.settings.materialDescriptions[material],
                      badge: material === 'standard' ? undefined : t.settings.materialBadges[material]
                    }))}
                    onChange={val => onChange({ ...preferences, material: val })}
                  />
                  <small className="muted">{t.settings.materialHint}</small>
                </div>
                <div className="field">
                  <Select
                    label={t.settings.font}
                    value={preferences.font}
                    options={([
                      { value: 'sf-pro' as const, label: t.settings.fonts['sf-pro'], description: 'macOS Native SF Pro Display' },
                      { value: 'quicksand' as const, label: t.settings.fonts.quicksand, description: 'Soft rounded geometry', badge: 'Popular' },
                      { value: 'geist' as const, label: t.settings.fonts.geist, description: 'Vercel / Linear modern AI look' },
                      { value: 'jakarta' as const, label: t.settings.fonts.jakarta, description: 'Plus Jakarta Sans modern' },
                      { value: 'inter' as const, label: t.settings.fonts.inter, description: 'Classic developer neutral' }
                    ])}
                    onChange={val => onChange({ ...preferences, font: val })}
                  />
                </div>
                <div className="field">
                  <Select
                    label={t.settings.language}
                    value={preferences.language}
                    options={LANGUAGES.map(lang => ({
                      value: lang.id,
                      label: lang.label,
                      flag: lang.id
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
            {agents && hostState && <section className="card settings-section"><h2>{t.observer.workflow}</h2><div className="actions">
              {(['managed', 'observe'] as const).map(mode => <button key={mode} type="button" disabled={workflowBusy} aria-pressed={(hostState.workflow ?? 'managed') === mode} onClick={() => changeWorkflow(mode)}>{t.observer[mode]}</button>)}
            </div>{workflowError && <p role="alert" className="form-error">{workflowError}</p>}</section>}
            {agents && hostState && (
              <section className="card settings-section" aria-labelledby="settings-approvals">
                <h2 id="settings-approvals">{t.approvalInbox.settings.title}</h2>
                <ApprovalNotificationSetting t={t} hostKind={platform.info.kind} notifier={platform.capabilities.notifications} />
              </section>
            )}
          </>}
          {item === 'connections' && agents && hostState && <ConnectionsSection t={t} agents={agents} state={hostState} onState={onHostState} />}
          {item === 'workspaces' && agents && hostState && <>
            <WorkspacesSection t={t} agents={agents} picker={picker} state={hostState} onState={onHostState} editGateFor={editGateFor} onEditGateHandled={onEditGateHandled}
              {...(onOpenSkills ? { onReviewSkills: (workspaceId: string) => onOpenSkills(workspaceId) } : {})} />
            {onOpenSkills && <SkillsMovedPointer t={t} onOpen={() => onOpenSkills()} />}
          </>}
          {item === 'agent-apps' && agents && hostState && <>
            <ConnectAgentAppsCard t={t} agents={agents} />
            <AutoWatchLocations t={t} agents={agents} onState={onHostState} />
            <IgnoredFolders t={t} agents={agents} onState={onHostState} />
          </>}
          {item === 'storage' && <>
            {agents && hostState && (
              <section className="card settings-section" aria-labelledby="settings-data-folder">
                <h2 id="settings-data-folder">{t.settings.dataFolder}</h2>
                <p className="muted">{t.settings.dataFolderLead}</p>
                <div className="command-line settings-data-folder" role="group" aria-label={t.settings.dataFolderPath}>
                  <code>{hostState.dataDirectory ?? hostState.storage.dataDirectory}</code>
                  <CopyButton text={hostState.dataDirectory ?? hostState.storage.dataDirectory} label={t.settings.dataFolderPath} />
                </div>
                <p className="muted">{t.settings.dataFolderHint}</p>
              </section>
            )}
            {agents && hostState && <KnowledgeVaultSection t={t} agents={agents} picker={picker} />}
          </>}
          {item === 'system' && <>
            {updater && <UpdatesSection t={t} updater={updater} status={updateStatus} />}
            {platform.capabilities.restart && (
              <section className="card settings-section" aria-labelledby="settings-restart">
                <h2 id="settings-restart">{t.restart.title}</h2>
                <RestartPrompt t={t} restart={platform.capabilities.restart} hostState={hostState} reason={t.restart.manualLead} />
              </section>
            )}
          </>}
        </>}
      </div>)}
    </div>
  );
}

/** The Skill Security Center and project skills moved to the Skills page; Settings keeps a one-line pointer. */
export function SkillsMovedPointer({ t, onOpen }: { t: Messages; onOpen: () => void }) {
  return (
    <section className="card settings-section settings-pointer" aria-label={t.skillsPage.title}>
      <p className="muted"><Icon name="spark" />{t.skillsPage.moved}</p>
      <button type="button" className="button small" onClick={onOpen}>{t.skillsPage.open}</button>
    </section>
  );
}
