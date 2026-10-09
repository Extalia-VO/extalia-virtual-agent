import { presetById } from '@extalia/core';
import type { AgentHostApi, HostState, Platform } from '@extalia/platform';
import { useEffect, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import { LANGUAGES, type Language, type Messages } from '../i18n';
import type { Preferences, ThemePreference } from '../preferences';
import { Brand } from '../ui/Brand';
import { Icon } from '../ui/Icon';
import { ConnectionForm } from './ConnectionForm';
import {
  draftFromConnection, draftFromPreset, draftFromWorkspace, emptyWorkspaceDraft, isValid, toConnectionInput, toWorkspaceInput,
  validateConnection, validateWorkspace, type ConnectionDraft, type WorkspaceDraft,
} from './validation';
import { WorkspaceForm } from './WorkspaceForm';

const STEPS = 4;

/** Full-screen first run: welcome, model connection, workspace, done. Shown instead of the app shell. */
export function SetupWizard({ t, platform, agents, state, onState, preferences, onPreferences }: {
  t: Messages;
  platform: Platform;
  agents: AgentHostApi;
  state: HostState;
  onState: (next: HostState) => void;
  preferences: Preferences;
  onPreferences: (next: Preferences) => void;
}) {
  // A setup that was interrupted resumes with what the host already has.
  const [step, setStep] = useState(0);
  const [connection, setConnection] = useState<ConnectionDraft>(() => state.connections[0] ? draftFromConnection(state.connections[0]) : draftFromPreset('openai'));
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() => state.workspaces[0] ? draftFromWorkspace(state.workspaces[0]) : emptyWorkspaceDraft(state.connections[0]?.id));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const first = useRef(true);

  useEffect(() => {
    // Move focus to the new step's heading so screen readers announce it; not on first load.
    if (first.current) { first.current = false; return; }
    heading.current?.focus();
  }, [step]);

  const go = (next: number) => { setError(null); setAttempted(false); setStep(next); };

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }

  const saveConnection = () => run(async () => {
    setAttempted(true);
    if (!isValid(validateConnection(connection))) return;
    const { input, secret } = toConnectionInput(connection);
    const before = new Set(state.connections.map(item => item.id));
    const next = await agents.saveConnection(input, secret);
    const saved = (input.id && next.connections.find(item => item.id === input.id))
      ?? next.connections.find(item => !before.has(item.id))
      ?? next.connections[next.connections.length - 1];
    onState(next);
    if (!saved) return;
    // The key now lives in the host; the form only remembers that one is stored.
    setConnection(draftFromConnection(saved));
    setWorkspace(current => ({ ...current, connectionId: saved.id }));
    go(2);
  });

  const saveWorkspace = () => run(async () => {
    setAttempted(true);
    if (!isValid(validateWorkspace(workspace))) return;
    const input = toWorkspaceInput(workspace);
    const before = new Set(state.workspaces.map(item => item.id));
    const next = await agents.saveWorkspace(input);
    const saved = (input.id && next.workspaces.find(item => item.id === input.id)) ?? next.workspaces.find(item => !before.has(item.id));
    onState(next);
    if (saved) setWorkspace(draftFromWorkspace(saved));
    go(3);
  });

  const finish = () => run(async () => { onState(await agents.completeSetup()); });

  const connectionValid = isValid(validateConnection(connection));
  const workspaceValid = isValid(validateWorkspace(workspace));
  const savedConnection = state.connections.find(item => item.id === workspace.connectionId);
  const picker = state.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined;
  const modeLabel = (mode: 'ask' | 'allow') => t.workspace.modes[mode];

  return (
    <div className="setup" data-onboarding-step={step + 1}>
      <header className="setup-header">
        <Brand />
        <div className="setup-prefs">
          <label className="inline-select">
            <span className="visually-hidden">{t.setup.language}</span>
            <select value={preferences.language} aria-label={t.setup.language} onChange={event => onPreferences({ ...preferences, language: event.target.value as Language })}>
              {LANGUAGES.map(language => <option key={language.id} value={language.id}>{language.label}</option>)}
            </select>
          </label>
          <label className="inline-select">
            <span className="visually-hidden">{t.setup.theme}</span>
            <select value={preferences.theme} aria-label={t.setup.theme} onChange={event => onPreferences({ ...preferences, theme: event.target.value as ThemePreference })}>
              {(['system', 'light', 'dark'] as const).map(theme => <option key={theme} value={theme}>{t.settings.themes[theme]}</option>)}
            </select>
          </label>
          <span className="topbar-meta">{t.hosts[state.host.kind]} · v{platform.info.appVersion}</span>
        </div>
      </header>

      <main className="setup-main">
        <ol className="setup-steps" aria-label={t.setup.progress}>
          {t.setup.steps.map((label, index) => (
            <li key={label} aria-current={index === step ? 'step' : undefined} className={index < step ? 'done' : ''}>
              <span className="step-index" aria-hidden="true">{index < step ? <Icon name="check" /> : index + 1}</span>
              <span className="step-label">{label}</span>
            </li>
          ))}
        </ol>

        <section className="card setup-card" aria-labelledby="setup-title">
          <p className="muted small">{t.setup.stepOf(step + 1, STEPS)}</p>
          {step === 0 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>{t.setup.welcomeTitle}</h1>
              <p className="lead">{t.setup.welcomeLead}</p>
              <ol className="welcome-points">
                {t.setup.welcomePoints.map(([title, text], index) => (
                  <li key={title}><span className="step-index" aria-hidden="true">{index + 1}</span><span><strong>{title}</strong><br /><span className="muted">{text}</span></span></li>
                ))}
              </ol>
              <p className="note"><Icon name="shield" />{t.setup.secretStore[state.storage.secretStore]}</p>
              <p className="muted small">{t.observer.setup}</p>
            </>
          )}
          {step === 1 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>{t.setup.modelTitle}</h1>
              <p className="lead">{t.setup.modelLead}</p>
              <ConnectionForm t={t} agents={agents} draft={connection} onChange={setConnection} showAllErrors={attempted} />
            </>
          )}
          {step === 2 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>{t.setup.workspaceTitle}</h1>
              <p className="lead">{t.setup.workspaceLead}</p>
              <WorkspaceForm t={t} agents={agents} picker={picker} draft={workspace} onChange={setWorkspace} showAllErrors={attempted} />
            </>
          )}
          {step === 3 && (
            <>
              <h1 id="setup-title" ref={heading} tabIndex={-1}>{t.setup.doneTitle}</h1>
              <p className="lead">{t.setup.doneLead}</p>
              <dl className="facts">
                <div><dt>{t.setup.summaryConnection}</dt><dd>{savedConnection ? `${savedConnection.name} · ${savedConnection.model}` : presetById(connection.preset).label}</dd></div>
                <div><dt>{t.setup.summaryWorkspace}</dt><dd>{workspace.name}</dd></div>
                <div><dt>{t.setup.summaryFolder}</dt><dd><code>{workspace.folder?.path ?? workspace.folderInput}</code></dd></div>
                <div><dt>{t.setup.summaryPermissions}</dt><dd>{t.setup.permissionSummary(modeLabel(workspace.permissions.fileWrite), modeLabel(workspace.permissions.commands))}</dd></div>
              </dl>
            </>
          )}

          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

          <div className="actions setup-actions">
            {step > 0 && <button type="button" disabled={busy} onClick={() => go(step - 1)}>{t.common.back}</button>}
            <span className="spacer" />
            {step === 0 && <><button type="button" disabled={busy} onClick={() => run(async () => { onState(await agents.completeSetup('observe')); })}>{t.observer.observe}</button><button type="button" className="primary" disabled={busy} onClick={() => go(1)}>{t.setup.begin}<Icon name="chevron" /></button></>}
            {step === 1 && <button type="button" className="primary" disabled={busy || !connectionValid} onClick={saveConnection}>{busy ? t.common.saving : t.common.next}<Icon name="chevron" /></button>}
            {step === 2 && <button type="button" className="primary" disabled={busy || !workspaceValid} onClick={saveWorkspace}>{busy ? t.common.saving : t.common.next}<Icon name="chevron" /></button>}
            {step === 3 && <button type="button" className="primary" disabled={busy} onClick={finish}>{busy ? t.setup.finishing : t.setup.finish}<Icon name="chat" /></button>}
          </div>
        </section>
      </main>
    </div>
  );
}
