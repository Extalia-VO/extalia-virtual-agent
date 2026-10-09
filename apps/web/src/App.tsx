import type { Platform } from '@extalia/platform';
import { useEffect, useMemo, useState } from 'react';
import { ChatPage } from './chat/ChatPage';
import { resolveChat, type ChatSelection } from './chat/selection';
import { useHostState } from './host/useHostState';
import { MESSAGES, type Messages, type PageId } from './i18n';
import { HistoryPage } from './library/HistoryPage';
import { ImportPage } from './library/ImportPage';
import { DiagnosticsPage } from './pages/DiagnosticsPage';
import { EventLogPage } from './pages/EventLogPage';
import { SettingsPage } from './pages/SettingsPage';
import { StartPage } from './pages/StartPage';
import { ObserverPage } from './pages/ObserverPage';
import { loadPreferences, savePreferences, type Preferences } from './preferences';
import { SetupWizard } from './setup/SetupWizard';
import { Brand } from './ui/Brand';
import { Icon, type IconName } from './ui/Icon';
import { MessagesContext } from './ui/messages';
import { UpdateBanner, useUpdateStatus } from './updates/Updates';

const ICONS: Record<PageId, IconName> = { chat: 'chat', observe: 'diagnostics', history: 'book', import: 'download', logs: 'logs', start: 'start', diagnostics: 'diagnostics', settings: 'settings' };

/** Only pages that work in this host appear; nothing is shown as a placeholder. */
function navigation(agents: boolean, workflow: 'managed' | 'observe'): { section: 'work' | 'app'; pages: PageId[] }[] {
  return agents
    ? [{ section: 'work', pages: workflow === 'observe' ? ['observe', 'history', 'import', 'logs'] : ['chat', 'observe', 'history', 'import', 'logs'] }, { section: 'app', pages: ['settings', 'diagnostics'] }]
    : [{ section: 'app', pages: ['start', 'logs', 'diagnostics', 'settings'] }];
}

function useColorScheme(theme: Preferences['theme']): void {
  useEffect(() => {
    const media = window.matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    };
    apply();
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [theme]);
}

function Startup({ t, error, onRetry }: { t: Messages; error: string | null; onRetry: () => void }) {
  return (
    <div className="startup">
      <Brand />
      {error ? (
        <div className="startup-message" role="alert">
          <p><strong>{t.startup.failed}</strong></p>
          <p className="muted">{error}</p>
          <div className="actions"><button type="button" className="primary" onClick={onRetry}><Icon name="refresh" />{t.common.retry}</button></div>
        </div>
      ) : <p className="muted" role="status"><span className="pulse" aria-hidden="true" />{t.startup.loading}</p>}
    </div>
  );
}

export function App({ platform }: { platform: Platform }) {
  const { agents, updater } = platform.capabilities;
  const [preferences, setPreferences] = useState(loadPreferences);
  const host = useHostState(agents);
  const hostState = host.state;
  const defaultPage: PageId = agents ? hostState?.workflow === 'observe' ? 'observe' : 'chat' : 'start';
  const [page, setPage] = useState<PageId>(defaultPage);
  const [selection, setSelection] = useState<ChatSelection>({});
  const [toast, setToast] = useState<{ id: number; text: string } | null>(null);
  const updateStatus = useUpdateStatus(updater);
  const t = MESSAGES[preferences.language];
  const compact = preferences.sidebar === 'compact';
  const currentSession = useMemo(() => hostState ? resolveChat(hostState, selection).session : undefined, [hostState, selection]);

  const activePage = page === 'start' && agents ? defaultPage : page;

  useColorScheme(preferences.theme);
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);
  useEffect(() => { document.documentElement.lang = preferences.language; }, [preferences.language]);
  useEffect(() => { document.documentElement.dataset.material = preferences.material; }, [preferences.material]);

  const update = (next: Preferences) => { setPreferences(next); savePreferences(next); };
  const banner = <UpdateBanner t={t} updater={updater} status={updateStatus} />;

  let body;
  if (agents && !hostState) {
    body = <Startup t={t} error={host.error} onRetry={host.retry} />;
  } else if (agents && hostState && !hostState.setupComplete) {
    body = <>{banner}<SetupWizard t={t} platform={platform} agents={agents} state={hostState} onState={host.apply} preferences={preferences} onPreferences={update} /></>;
  } else {
    const hostLabel = hostState ? t.hosts[hostState.host.kind] : t.hosts[platform.info.kind];
    body = (
      <div className={`shell ${compact ? 'sidebar-compact' : ''}`}>
        <nav className="sidebar" aria-label={t.nav.main}>
          <div className="sidebar-head">
            <Brand compact={compact} />
          </div>
          {navigation(Boolean(agents), hostState?.workflow ?? 'managed').map(group => (
            <div key={group.section} className="nav-group">
              <p className="nav-section">{t.nav[group.section]}</p>
              <ul className="nav-list">
                {group.pages.map(id => (
                  <li key={id}>
                    <button type="button" className="nav-item" data-page={id} aria-current={page === id ? 'page' : undefined} title={compact ? t.nav[id] : undefined} onClick={() => setPage(id)}>
                      <Icon name={ICONS[id]} /><span className="nav-label">{t.nav[id]}</span>
                    </button>
                  </li>
                ))}
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
            <span className="topbar-meta">{hostLabel} · v{platform.info.appVersion}</span>
          </header>
          <main className={`content ${activePage === 'chat' ? 'content-chat' : ''}`} key={activePage}>
            {activePage === 'chat' && agents && hostState && (
              <ChatPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply}
                selection={selection} onSelect={setSelection} onOpenSettings={() => setPage('settings')} />
            )}
            {activePage === 'history' && agents && hostState && (
              <HistoryPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} onOpenImport={() => setPage('import')} />
            )}
            {activePage === 'observe' && agents && hostState && <ObserverPage t={t} language={preferences.language} agents={agents} state={hostState} onState={host.apply} onAdd={() => setPage('import')} />}
            {activePage === 'import' && agents && (
              <ImportPage t={t} language={preferences.language} agents={agents} onState={host.apply}
                onObserved={() => setPage('observe')}
                onImported={text => { setToast({ id: Date.now(), text }); setPage('history'); }} />
            )}
            {activePage === 'start' && <StartPage t={t} />}
            {activePage === 'logs' && <EventLogPage t={t} {...(agents && currentSession ? { loadCurrent: () => agents.sessionEvents(currentSession.id) } : {})} />}
            {activePage === 'diagnostics' && <DiagnosticsPage t={t} platform={platform} hostState={hostState} />}
            {activePage === 'settings' && (
              <SettingsPage t={t} platform={platform} preferences={preferences} onChange={update} hostState={hostState} onHostState={host.apply} updateStatus={updateStatus} />
            )}
          </main>
        </div>
        <div className="toast-region" role="status" aria-live="polite">
          {toast && <p key={toast.id} className="toast"><Icon name="check" />{toast.text}</p>}
        </div>
      </div>
    );
  }

  return <MessagesContext value={t}>{body}</MessagesContext>;
}
