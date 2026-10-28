import type { Platform } from '@extalia/platform';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { loadLandingMemory, navigationGroups, resolveLandingPage, resolveLandingWorkspace, saveLandingMemory } from './appMode';
import { rememberResolvedTheme } from './boot/appearance';
import { Splash } from './boot/Splash';
import { useBoot } from './boot/useBoot';
import { isDaytime } from './environment/solarTime';
import { ChatPage } from './chat/ChatPage';
import { ApprovalProvider } from './approvals/ApprovalProvider';
import { ApprovalInboxButton } from './approvals/ApprovalInbox';
import { resolveChat, type ChatSelection } from './chat/selection';
import { useHostState } from './host/useHostState';
import { HostConnectionBanner } from './host/HostConnectionBanner';
import { showsOfficeControls } from './office/officeControls';
import { OfficeTopbarControls } from './office/OfficeTopbarControls';
import { MESSAGES, type PageId } from './i18n';
import { HistoryPage } from './library/HistoryPage';
import { KnowledgePage, useKnowledgeSupport } from './knowledge/KnowledgePage';
import { ImportPage } from './library/ImportPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { EventLogPage } from './pages/EventLogPage';
import { FilesPage } from './pages/FilesPage';
import { GitPage } from './pages/GitPage';
import { SettingsPage } from './pages/SettingsPage';
import { SkillsPage } from './skills/SkillsPage';
import { useSkillsWaiting } from './skills/skillsModel';
import { StartPage } from './pages/StartPage';
import { ObserverPage } from './pages/ObserverPage';
import { OfficePage } from './pages/OfficePage';
import { MissionsPage } from './missions/MissionsPage';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import { useProfileSync } from './profileSync';
import { SetupWizard } from './setup/SetupWizard';
import { Brand } from './ui/Brand';
import { Icon, type IconName } from './ui/Icon';
import { MessagesContext } from './ui/messages';
import { UpdateBanner, useUpdateStatus } from './updates/Updates';

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
  const [preferences, setPreferences] = useState(loadPreferences);
  const host = useHostState(agents);
  const hostState = host.state;
  // Splash → setup gate → shell; see boot/bootState.ts.
  const { boot, splash, retry: retryBoot } = useBoot(Boolean(agents), host);
  // The workspace last used on this device; the page itself is never remembered.
  const [stored, setStored] = useState(loadLandingMemory);
  const workflow = hostState?.workflow ?? 'managed';
  // Every launch and the end of setup land in the 3D Office (Get started without an agent host).
  const defaultPage: PageId = resolveLandingPage({ agents: Boolean(agents) });
  const [chosenPage, setChosenPage] = useState<PageId | null>(null);
  const page: PageId = chosenPage ?? defaultPage;
  const setPage = (next: PageId) => setChosenPage(next);
  const [selection, setSelectionState] = useState<ChatSelection>({});
  // ADR 0028: a mission's Changes panel opens Settings at a workspace's integration test gate.
  const [gateFocus, setGateFocus] = useState<string>();
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

  // W5: listed only when the host answers the knowledge methods (hosts without them answer "not supported").
  const knowledge = useKnowledgeSupport(agents);
  const groups = navigationGroups({ agents: Boolean(agents), workflow, canChat: Boolean(hostState?.workspaces.length), knowledge });
  const activePage = groups.some(group => group.pages.includes(page)) ? page : defaultPage;
  // Nav badge: skills waiting for review or approval; reloaded after Skills actions and when entering or leaving the page.
  const skillsWaiting = useSkillsWaiting(agents, hostState?.workspaces, skillsRefresh, activePage === 'skills');
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
  useProfileSync(agents, preferences, update);
  // A conversation continued from another agent opens in Chat.
  const continued = {
    onContinued: (sessionId: string, workspaceId: string) => {
      agents?.getState().then(host.apply, () => undefined);
      setSelection({ workspaceId, sessionId });
      setPage('chat');
    },
    onOpenSettings: () => setPage('settings'),
  };
  const banner = <><UpdateBanner t={t} updater={updater} status={updateStatus} />
    <HostConnectionBanner t={t} error={host.error} desktop={platform.info.kind === 'desktop'} onRetry={host.retry} /></>;

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
            <div key={group.section} className="nav-group">
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
            <span className="topbar-meta">{hostLabel} · v{platform.info.appVersion}</span>
          </header>
          <main className={`content ${activePage === 'chat' ? 'content-chat' : activePage === 'office' ? 'content-office' : ''}`} key={activePage}>
            {activePage === 'office' && <OfficePage t={t} language={preferences.language} agents={agents} hostDisconnected={Boolean(host.error)} state={hostState} onState={host.apply} workspaceId={chatWorkspaceId}
              onWorkspace={workspaceId => setSelection({ workspaceId })}
              onOpenSession={session => { setSelection({ workspaceId: session.workspaceId, sessionId: session.id }); setPage(session.control === 'observed' ? 'observe' : 'chat'); }}
              onOpenMissions={hostState?.workspaces.length ? session => { if (session) setSelection({ workspaceId: session.workspaceId, sessionId: session.id }); setPage('missions'); } : undefined}
              onStartChat={() => setPage(!agents ? 'start' : hostState?.workspaces.length ? 'chat' : 'settings')}
              onOpenSettings={() => setPage('settings')} />}
            {activePage === 'missions' && agents && hostState && (
              <MissionsPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} sessionId={selection.sessionId ?? undefined}
                onSelectSession={(sessionId, workspaceId) => setSelection({ workspaceId, sessionId })} onOpenChat={() => setPage('chat')}
                onEditGate={workspaceId => { setGateFocus(workspaceId); setPage('settings'); }} />
            )}
            {activePage === 'chat' && agents && hostState && (
              <ChatPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply}
                selection={chatSelection} onSelect={setSelection} onOpenSettings={() => setPage('settings')} onReviewSkills={() => openSkills()} />
            )}
            {activePage === 'history' && agents && hostState && (
              <HistoryPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} onOpenImport={() => setPage('import')} {...continued} />
            )}
            {activePage === 'files' && agents && hostState && <FilesPage t={t} language={preferences.language} agents={agents} state={hostState} {...(chatWorkspaceId ? { workspaceId: chatWorkspaceId } : {})} />}
            {activePage === 'knowledge' && agents && knowledge && <KnowledgePage t={t} language={preferences.language} agents={agents} />}
            {activePage === 'git' && agents && hostState && <GitPage t={t} agents={agents} state={hostState} {...(chatWorkspaceId ? { workspaceId: chatWorkspaceId } : {})} />}
            {activePage === 'observe' && agents && hostState && <ObserverPage t={t} language={preferences.language} agents={agents} state={hostState} initialSessionId={selection.sessionId ?? undefined} onState={host.apply} onAdd={() => setPage('import')} {...continued} />}
            {activePage === 'import' && agents && (
              <ImportPage t={t} language={preferences.language} agents={agents} onState={host.apply}
                onObserved={() => setPage('observe')}
                onImported={text => { setToast({ id: Date.now(), text }); setPage('history'); }} />
            )}
            {activePage === 'start' && <StartPage t={t} />}
            {activePage === 'logs' && <EventLogPage t={t} {...(agents && currentSession ? { loadCurrent: () => agents.sessionEvents(currentSession.id) } : {})} />}
            {activePage === 'diagnostics' && <DiagnosticsPage t={t} platform={platform} hostState={hostState} updateStatus={updateStatus} onOpenWorkspaces={() => setPage('settings')} />}
            {activePage === 'settings' && (
              <SettingsPage t={t} platform={platform} preferences={preferences} onChange={update} hostState={hostState} onHostState={host.apply} updateStatus={updateStatus}
                editGateFor={gateFocus} onEditGateHandled={() => setGateFocus(undefined)} onOpenSkills={openSkills} />
            )}
            {activePage === 'skills' && agents && hostState && (
              <SkillsPage t={t} agents={agents} state={hostState} {...(hostState.host.kind === 'desktop' && platform.capabilities.filesystem ? { picker: platform.capabilities.filesystem } : {})}
                {...(skillsFocus ? { focusWorkspaceId: skillsFocus } : {})} onFocusHandled={clearSkillsFocus} onChanged={bumpSkills} />
            )}
          </main>
        </div>
        <div className="toast-region" role="status" aria-live="polite">
          {toast && <p key={toast.id} className="toast"><Icon name="check" />{toast.text}</p>}
        </div>
      </div>
    );
  }

  return <MessagesContext value={t}>
    <ApprovalProvider t={t} hostKind={platform.info.kind} agents={agents} state={hostState} notifier={platform.capabilities.notifications}>{body}</ApprovalProvider>
  </MessagesContext>;
}
