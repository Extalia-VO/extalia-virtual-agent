import './navigation.css';
import type { Platform } from '@extalia/platform';
import { lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { loadLandingMemory, navigationGroups, resolveLandingPage, resolveLandingWorkspace, saveLandingMemory } from './appMode';
import { rememberResolvedTheme } from './boot/appearance';
import { Splash } from './boot/Splash';
import { useBoot } from './boot/useBoot';
import { isDaytime } from './environment/solarTime';
import { ChatPage } from './chat/ChatPage';
import { useWorkspaceMemoryDraftWarning } from './chat/useWorkspaceMemoryDraftWarning';
import { useComposerDraftWarning } from './chat/useComposerDraftWarning';
import { ObservedInputProvider } from './observe/ObservedInputProvider';
import { ObservedInputAlert } from './observe/ObservedInputCards';
import { OfficeAutoAttention } from './office/OfficeAutoAttention';
import type { OfficeInputFocus, OfficeAttentionOutcome } from './office/officeInputFocus';
import type { OfficeAttentionRequest } from './office/officeAttentionQueue';
import { ApprovalProvider } from './approvals/ApprovalProvider';
import { ApprovalInboxButton } from './approvals/ApprovalInbox';
import { resolveChat, type ChatSelection } from './chat/selection';
import { useHostState } from './host/useHostState';
import { HostConnectionDialog } from './host/HostConnectionDialog';
import { FullscreenButton } from './ui/FullscreenButton';
import { showsOfficeControls } from './office/officeControls';
import { OfficeTopbarControls } from './office/OfficeTopbarControls';
import { MESSAGES, type PageId } from './i18n';
import { LearningCountdown } from './knowledge/LearningCountdown';
import type { SettingsSection } from './pages/settings/settingsSections';
import { useSkillsWaiting } from './skills/skillsModel';
import { StartPage } from './pages/StartPage';
import { OfficePage } from './pages/OfficePage';
import { NativeStatusButton } from './native/NativeStatusButton';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import { useProfileSync } from './profileSync';
import { subscribeProfileClientState } from './profileClientState';
import { SetupWizard } from './setup/SetupWizard';
import { Brand } from './ui/Brand';
import { Icon, type IconName } from './ui/Icon';
import { MessagesContext } from './ui/messages';
import { UpdateBanner, useUpdateStatus } from './updates/Updates';
import { UpdateAvailableDialog } from './updates/UpdateAvailableDialog';
import { PageLoadBoundary } from './pages/PageLoadBoundary';

// Keep landing, conversation and global supervision controls available without loading every page.
const HistoryPage = lazy(() => import('./library/HistoryPage').then(module => ({ default: module.HistoryPage })));
const KnowledgePage = lazy(() => import('./knowledge/KnowledgePage').then(module => ({ default: module.KnowledgePage })));
const ImportPage = lazy(() => import('./library/ImportPage').then(module => ({ default: module.ImportPage })));
const DiagnosticsPage = lazy(() => import('./pages/DiagnosticsPage').then(module => ({ default: module.DiagnosticsPage })));
const EventLogPage = lazy(() => import('./pages/EventLogPage').then(module => ({ default: module.EventLogPage })));
const FilesPage = lazy(() => import('./pages/FilesPage').then(module => ({ default: module.FilesPage })));
const GitPage = lazy(() => import('./pages/GitPage').then(module => ({ default: module.GitPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(module => ({ default: module.SettingsPage })));
const SkillsPage = lazy(() => import('./skills/SkillsPage').then(module => ({ default: module.SkillsPage })));
const ObserverPage = lazy(() => import('./pages/ObserverPage').then(module => ({ default: module.ObserverPage })));
const MissionsPage = lazy(() => import('./missions/MissionsPage').then(module => ({ default: module.MissionsPage })));

const ICONS: Record<PageId, IconName> = { office: 'monitor', chat: 'chat', missions: 'mission', observe: 'diagnostics', files: 'files', git: 'git', knowledge: 'bulb', history: 'book', import: 'download', logs: 'logs', start: 'start', diagnostics: 'diagnostics', skills: 'spark', settings: 'settings' };

type ViewTransition = { ready: Promise<void>; finished: Promise<void>; updateCallbackDone: Promise<void> };

/**
 * Set a root `data-*` attribute (theme, material, font). Real changes cross-fade
 * with the View Transitions API where available; the first value, unchanged
 * values, hidden tabs and reduced motion apply instantly.
 */
function setRootData(key: 'theme' | 'material' | 'font', value: string): void {
  const root = document.documentElement;
  const previous = root.dataset[key];
  if (previous === value) return;
  const apply = () => { root.dataset[key] = value; };
  const start = (document as Document & { startViewTransition?: (update: () => void) => ViewTransition }).startViewTransition;
  if (previous === undefined || !start || document.visibilityState !== 'visible' || window.matchMedia('(prefers-reduced-motion: reduce)').matches) { apply(); return; }
  const transition = start.call(document, apply);
  // A transition is skipped when another starts or the tab hides; the change itself still applies.
  for (const promise of [transition.ready, transition.finished, transition.updateCallbackDone]) promise.catch(() => undefined);
}

function useColorScheme(theme: Preferences['theme']): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      let isDark: boolean;
      if (theme === 'dark') {
        isDark = true;
      } else if (theme === 'light') {
        isDark = false;
      } else if (theme === 'solar') {
        // Automatically switch: dark after sunset, light after sunrise
        isDark = !isDaytime();
      } else {
        // System preference
        isDark = media.matches;
      }
      setRootData('theme', isDark ? 'dark' : 'light');
      rememberResolvedTheme(isDark ? 'dark' : 'light');
    };

    apply();

    // Check periodically for solar cycle progression or system updates
    const interval = theme === 'solar' ? setInterval(apply, 60_000) : undefined;
    media.addEventListener('change', apply);

    return () => {
      if (interval) clearInterval(interval);
      media.removeEventListener('change', apply);
    };
  }, [theme]);
}

export function App({ platform }: { platform: Platform }) {
  const { agents, updater } = platform.capabilities;
  useWorkspaceMemoryDraftWarning(agents);
  useComposerDraftWarning(agents);
  const [preferences, setPreferences] = useState(loadPreferences);
  const host = useHostState(agents);
  const hostState = host.state;
  const sourceContext = hostState ? JSON.stringify([hostState.profile.id, hostState.dataDirectory ?? hostState.storage.dataDirectory]) : undefined;
  // Splash → setup gate → shell; see boot/bootState.ts.
  const { boot, splash, retry: retryBoot } = useBoot(Boolean(agents), host);
  // The host owns remembered workspace selection; browser storage is only a mirror.
  const [stored, setStored] = useState(loadLandingMemory);
  useEffect(() => {
    const refresh = () => setStored(loadLandingMemory());
    refresh();
    return subscribeProfileClientState(refresh);
  }, []);
  const workflow = hostState?.workflow ?? 'managed';
  // Every launch and the end of setup land in the 3D Office (Get started without an agent host).
  const defaultPage: PageId = resolveLandingPage({ agents: Boolean(agents) });
  const [chosenPage, setChosenPage] = useState<PageId | null>(null);
  const page: PageId = chosenPage ?? defaultPage;
  const [missionFocus, setMissionFocus] = useState<{ id?: string; token: number } | null>(null);
  const [selection, setSelectionState] = useState<ChatSelection>({});
  const [officeLearningTarget, setOfficeLearningTarget] = useState<HTMLDivElement | null>(null);
  const [chatLearningTarget, setChatLearningTarget] = useState<HTMLDivElement | null>(null);
  const [settingsLearningTarget, setSettingsLearningTarget] = useState<HTMLDivElement | null>(null);
  const inputFocusSequence = useRef(0);
  const [inputFocus, setInputFocus] = useState<OfficeInputFocus>();
  const locateOfficeRequest = useCallback((target: Omit<OfficeInputFocus, 'token' | 'scope'>) => {
    setSelectionState({ sessionId: target.sessionId });
    setMissionFocus(null); setChosenPage('office');
    setInputFocus({ ...target, ...(sourceContext ? { scope: sourceContext } : {}), token: ++inputFocusSequence.current });
  }, [sourceContext]);
  const locateInput = useCallback((sessionId: string, requestId?: string) => {
    locateOfficeRequest({ sessionId, ...(requestId ? { requestId } : {}), kind: 'input' });
  }, [locateOfficeRequest]);
  const locateAttention = useCallback((request: OfficeAttentionRequest, onSettled: (outcome: OfficeAttentionOutcome) => void) => {
    locateOfficeRequest({ ...request, attentionKey: request.key, automatic: true, onSettled });
  }, [locateOfficeRequest]);
  const currentInputFocus = inputFocus?.scope === sourceContext ? inputFocus : undefined;
  if (inputFocus && inputFocus.scope !== sourceContext) setInputFocus(undefined);
  const inputFocused = useCallback((token: number) => setInputFocus(current => current?.token === token ? undefined : current), []);

  const setPage = (next: PageId) => {
    if (next !== 'office') setInputFocus(undefined);
    if (next !== 'missions') setMissionFocus(null);
    setChosenPage(next);
  };
  // ADR 0028: a mission's Changes panel opens Settings at a workspace's integration test gate.
  const [gateFocus, setGateFocus] = useState<string>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>('general');
  const openSettings = (section: SettingsSection = 'general') => { setSettingsSection(section); setPage('settings'); };
  // Settings → Workspaces "Review" opens Skills on one workspace (used once by the page).
  const [skillsFocus, setSkillsFocus] = useState<string>();
  const [skillsRefresh, setSkillsRefresh] = useState(0);
  // A workspace picked in Chat or the Office is remembered; unknown ids are ignored when read back.
  const setSelection = (next: ChatSelection) => {
    setSelectionState(next);
    if (next.workspaceId && next.workspaceId !== stored.workspaceId) { const nextStored = { ...stored, workspaceId: next.workspaceId }; setStored(nextStored); saveLandingMemory(nextStored); }
  };
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const updateStatus = useUpdateStatus(updater);
  const t = MESSAGES[preferences.language];
  const compact = preferences.sidebar === 'compact';
  // The Office uses the whole width: its sidebar stays narrow and opens over the scene on hover or keyboard focus.
  const currentSession = useMemo(() => hostState ? resolveChat(hostState, selection).session : undefined, [hostState, selection]);
  const chatWorkspaceId = selection.workspaceId;
  // Chat opens on the last-used workspace when it still exists, otherwise on the first one.
  const rememberedWorkspace = hostState ? resolveLandingWorkspace(hostState.workspaces, stored.workspaceId) : undefined;
  const chatSelection: ChatSelection = selection.workspaceId || !rememberedWorkspace ? selection : { ...selection, workspaceId: rememberedWorkspace };

  const groups = navigationGroups({ agents: Boolean(agents), workflow, canChat: Boolean(hostState?.workspaces.some(workspace => workspace.mode !== 'observe')) });
  const activePage = groups.some(group => group.pages.includes(page)) ? page : defaultPage;
  // Nav badge: skills waiting for review or approval; reloaded after Skills actions and when entering or leaving the page.
  const skillsWaiting = useSkillsWaiting(workflow === 'managed' ? agents : undefined, hostState?.workspaces, skillsRefresh, activePage === 'skills');
  const openSkills = (workspaceId?: string) => { setSkillsFocus(workspaceId); setPage('skills'); };
  const clearSkillsFocus = useCallback(() => setSkillsFocus(undefined), []);
  const bumpSkills = useCallback(() => setSkillsRefresh(count => count + 1), []);

  useColorScheme(preferences.theme);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => { document.documentElement.lang = preferences.language; }, [preferences.language]);
  useEffect(() => {
    setRootData('material', preferences.material);
  }, [preferences.material]);
  useEffect(() => {
    setRootData('font', preferences.font);
  }, [preferences.font]);

  const update = (next: Preferences) => { setPreferences(next); savePreferences(next); };
  // With an agent host, preferences follow the shared Extalia profile (Web and Desktop); localStorage mirrors it.
  useProfileSync(hostState ? agents : undefined, preferences, update, hostState ? JSON.stringify([hostState.dataDirectory, hostState.host.instanceId]) : undefined);
  // A conversation continued from another agent opens in Chat.
  const continued = {
    onContinued: (sessionId: string, workspaceId: string) => {
      agents?.getState().then(host.apply, () => undefined);
      setSelection({ workspaceId, sessionId });
      setPage('chat');
    },
    onOpenSettings: () => openSettings(hostState?.connections.length ? 'workspaces' : 'connections'),
  };
  const banner = <UpdateBanner t={t} updater={updater} status={updateStatus} />;

  let body;
  if (splash) {
    const details = boot.error ? [`Extalia v${platform.info.appVersion} · ${platform.info.kind}`, `boot: ${boot.phase} (${boot.error.category})`, ...(boot.error.message ? [boot.error.message] : [])].join('\n') : undefined;
    body = <Splash t={t} {...(boot.error ? { error: boot.error, onRetry: retryBoot } : {})} {...(details ? { details } : {})} />;
  } else if (boot.phase === 'setup-required' && agents && hostState) {
    // First run: only the wizard mounts (no sidebar, Office or Chat), whatever page was asked for.
    body = <>{banner}<SetupWizard t={t} platform={platform} agents={agents} state={hostState} preferences={preferences} onPreferences={update}
      onState={next => { if (next.setupComplete) setChosenPage(null); host.apply(next); }} /></>;
  } else {
    const hostLabel = hostState ? t.hosts[hostState.host.kind] : t.hosts[platform.info.kind];
    body = (
      <div className={`shell ${compact ? 'sidebar-compact' : ''} ${activePage === 'office' ? 'office-mode' : ''}`}>
        <nav className="sidebar" aria-label={t.nav.main}>
          <div className="sidebar-head">
            <Brand compact={compact && activePage !== 'office'} />
          </div>
          {groups.map(group => (
            <div key={group.section} className="nav-group" data-nav-section={group.section}>
              <p className="nav-section">{t.nav[group.section]}</p>
              <ul className="nav-list">
                {group.pages.map(id => {
                  const badge = id === 'skills' ? skillsWaiting : 0;
                  const label = badge > 0 ? t.nav.skillsWaiting(badge) : t.nav[id];
                  return (
                    <li key={id}>
                      <button type="button" className="nav-item" data-page={id} aria-label={label} aria-current={activePage === id ? 'page' : undefined} title={compact || activePage === 'office' ? label : undefined} onClick={event => { setPage(id); if (id === 'office' && event.detail > 0) event.currentTarget.blur(); }}>
                        <Icon name={ICONS[id]} /><span className="nav-label">{t.nav[id]}</span>
                        {badge > 0 && <span className="nav-badge" aria-hidden="true">{badge > 99 ? '99+' : badge}</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>
        <div className="main">
          {banner}
          <header className="topbar">
            <button type="button" className="icon-button" aria-label={t.nav.toggleSidebar} aria-pressed={compact} onClick={() => update({ ...preferences, sidebar: compact ? 'expanded' : 'compact' })}>
              <Icon name="panel" />
            </button>
            <span className="topbar-title">{t.nav[activePage]}</span>
            {showsOfficeControls(activePage) && <OfficeTopbarControls t={t} />}
            <ApprovalInboxButton t={t} />
            {workflow === 'managed' && agents && hostState && <NativeStatusButton t={t} agents={agents} state={hostState} onState={host.apply}
              onOpenSession={(sessionId, workspaceId) => { setSelection({ sessionId, workspaceId }); setPage('chat'); }}
              onOpenMissions={(sessionId, workspaceId, missionId) => {
                setSelection({ sessionId, workspaceId });
                setMissionFocus(current => ({ id: missionId, token: (current?.token ?? 0) + 1 }));
                setPage('missions');
              }} />}
            {platform.info.kind !== 'desktop' && <FullscreenButton t={t} />}
            <span className="topbar-meta">{hostLabel} · v{platform.info.appVersion}</span>
          </header>
          <ObservedInputAlert t={t} />
          <main className={`content ${activePage === 'chat' ? 'content-chat' : activePage === 'office' ? 'content-office' : activePage === 'knowledge' ? 'content-knowledge' : ''}`} key={activePage}>
            <PageLoadBoundary t={t}>
            {activePage === 'office' && <OfficePage key={sourceContext} t={t} language={preferences.language} agents={agents} hostDisconnected={Boolean(host.error)} state={hostState} onState={host.apply} workspaceId={chatWorkspaceId} inputFocus={currentInputFocus} onInputFocused={inputFocused}
              onWorkspace={(workspaceId, sessionId) => setSelection({ workspaceId, sessionId })} onLearningTarget={setOfficeLearningTarget}
              onOpenSession={session => { setSelection({ workspaceId: session.workspaceId, sessionId: session.id }); setPage(session.control === 'observed' ? 'observe' : 'chat'); }}
              onOpenMissions={workflow === 'managed' && hostState?.workspaces.length ? session => { if (session) setSelection({ workspaceId: session.workspaceId, sessionId: session.id }); setPage('missions'); } : undefined}
              onStartChat={() => setPage(!agents ? 'start' : workflow === 'observe' ? 'observe' : 'chat')}
              onOpenAgentSettings={() => openSettings('agent-apps')} onOpenSettings={() => openSettings(workflow === 'observe' ? 'workspaces' : hostState?.connections.length ? 'workspaces' : 'connections')} />}
            {activePage === 'missions' && agents && hostState && (
              <MissionsPage key={missionFocus?.token ?? 0} t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} workspaceId={chatWorkspaceId} sessionId={selection.sessionId ?? undefined} missionId={missionFocus?.id}
                onSelectWorkspace={workspaceId => { setMissionFocus(null); setSelection({ workspaceId }); }}
                onSelectSession={(sessionId, workspaceId) => { setMissionFocus(null); setSelection({ workspaceId, sessionId }); }} onOpenChat={() => setPage('chat')} onOpenSettings={() => openSettings(hostState?.connections.length ? 'workspaces' : 'connections')}
                onEditGate={workspaceId => { setGateFocus(workspaceId); openSettings('workspaces'); }} />
            )}
            {activePage === 'chat' && agents && hostState && (
              <ChatPage t={t} language={preferences.language} agents={agents} picker={hostState.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined} state={hostState} onState={host.apply}
                onLearningTarget={setChatLearningTarget}
                selection={chatSelection} onSelect={setSelection} onOpenSettings={() => openSettings(hostState?.connections.length ? 'workspaces' : 'connections')} onReviewSkills={() => openSkills()} onOpenKnowledge={() => setPage('knowledge')} />
            )}
            {activePage === 'history' && agents && hostState && (
              <HistoryPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} onOpenImport={() => setPage('import')} {...continued} />
            )}
            {activePage === 'files' && agents && hostState && <FilesPage t={t} language={preferences.language} agents={agents} state={hostState} {...(chatWorkspaceId ? { workspaceId: chatWorkspaceId } : {})} />}
            {activePage === 'knowledge' && agents && <KnowledgePage t={t} language={preferences.language} agents={agents} workspaces={hostState?.workspaces} workspaceId={chatWorkspaceId} onWorkspace={workspaceId => setSelection({ workspaceId })} picker={hostState?.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined} />}
            {activePage === 'git' && agents && hostState && <GitPage t={t} agents={agents} state={hostState} {...(chatWorkspaceId ? { workspaceId: chatWorkspaceId } : {})} />}
            {activePage === 'observe' && agents && hostState && <ObserverPage key={sourceContext} t={t} language={preferences.language} agents={agents} state={hostState} initialSessionId={selection.sessionId ?? undefined} onState={host.apply}
              onOpenAgentSettings={() => openSettings('agent-apps')} onOpenImport={() => setPage('import')} {...continued} />}
            {activePage === 'import' && agents && (
              <ImportPage key={sourceContext} t={t} language={preferences.language} agents={agents} onState={host.apply}
                onOpenObserve={() => setPage('observe')} onOpenAgentSettings={() => openSettings('agent-apps')}
                onImported={text => { setToast({ id: Date.now(), text }); setPage('history'); }} />
            )}
            {activePage === 'start' && <StartPage t={t} />}
            {activePage === 'logs' && <EventLogPage t={t} {...(agents && currentSession ? { loadCurrent: () => agents.sessionEvents(currentSession.id) } : {})} />}
            {activePage === 'diagnostics' && <DiagnosticsPage t={t} platform={platform} hostState={hostState} updateStatus={updateStatus} onOpenWorkspaces={() => openSettings('workspaces')} />}
            {activePage === 'settings' && (
              <SettingsPage t={t} platform={platform} preferences={preferences} onChange={update} hostState={hostState} onHostState={host.apply} updateStatus={updateStatus}
                onLearningTarget={setSettingsLearningTarget}
                section={settingsSection} onSectionChange={setSettingsSection} onOpenObserve={() => setPage('observe')} onOpenImport={() => setPage('import')}
                editGateFor={gateFocus} onEditGateHandled={() => setGateFocus(undefined)} onOpenSkills={openSkills} />
            )}
            {activePage === 'skills' && agents && hostState && (
              <SkillsPage t={t} agents={agents} state={hostState} {...(hostState.host.kind === 'desktop' && platform.capabilities.filesystem ? { picker: platform.capabilities.filesystem } : {})}
                {...(skillsFocus ? { focusWorkspaceId: skillsFocus } : {})} onFocusHandled={clearSkillsFocus} onChanged={bumpSkills} />
            )}
            </PageLoadBoundary>
          </main>
        </div>
        <div className="toast-region" role="status" aria-live="polite">
          {toast && <p key={toast.id} className="toast"><Icon name="check" />{toast.text}</p>}
        </div>
        {agents && hostState && <LearningCountdown key={sourceContext} agents={agents} t={t} target={activePage === 'office' ? officeLearningTarget : activePage === 'chat' ? chatLearningTarget : activePage === 'settings' ? settingsLearningTarget : null} embedded={activePage === 'chat' || activePage === 'settings' || undefined} />}
      </div>
    );
  }

  return <MessagesContext value={t}>
    <ApprovalProvider t={t} hostKind={platform.info.kind} agents={agents} state={hostState} notifier={platform.capabilities.notifications}>
      <ObservedInputProvider t={t} hostKind={platform.info.kind} agents={agents} state={hostState} notifier={platform.capabilities.notifications} onLocate={locateInput}>
        <OfficeAutoAttention active={!splash && !host.error && hostState?.setupComplete === true && activePage === 'office'} scope={sourceContext ?? 'unloaded'} busy={Boolean(currentInputFocus)} onLocate={locateAttention} />
        {body}
      </ObservedInputProvider>
      <UpdateAvailableDialog t={t} updater={updater} status={updateStatus} enabled={!splash && platform.info.kind === 'desktop'} />
      {hostState && <HostConnectionDialog t={t} error={host.error} desktop={platform.info.kind === 'desktop'} onRetry={host.retry} />}
    </ApprovalProvider>
  </MessagesContext>;
}
