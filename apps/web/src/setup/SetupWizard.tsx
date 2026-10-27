import { presetById, type RuntimeId } from '@extalia/core';
import type { AgentHostApi, HostState, Platform } from '@extalia/platform';
import { useEffect, useId, useMemo, useRef, useState, type CSSProperties } from 'react';
import { errorMessage } from '../host/remote';
import { LANGUAGES, type Messages } from '../i18n';
import { FONTS, MATERIALS, THEMES, type MaterialPreference, type Preferences } from '../preferences';
import { Brand } from '../ui/Brand';
import { Icon, type IconName } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import { ConnectionForm } from './ConnectionForm';
import { friendlyConnectionError } from './connectionErrors';
import { permissionsLabel } from './permissions';
import { AgentAppLogo } from '../ui/OriginMark';
import { RuntimePicker } from './RuntimePicker';
import {
  SETUP_STEPS, canAdvance, canFinish, dataDirectoryOf, detectExistingSetup, nextStep, previousStep, stepIndex, validateDisplayName,
  DISPLAY_NAME_MAX, type SetupStepId,
} from './steps';
import { availableHermes, useRuntimeStatus } from './useRuntimes';
import {
  draftFromConnection, draftFromPreset, draftFromWorkspace, emptyWorkspaceDraft, isValid, toConnectionInput, toWorkspaceInput,
  validateConnection, validateWorkspace, type ConnectionDraft, type WorkspaceDraft,
} from './validation';
import { WorkspaceForm } from './WorkspaceForm';

const THEME_ICONS: Record<Preferences['theme'], IconName> = { solar: 'sunrise', system: 'monitor', light: 'sun', dark: 'moon' };
const POINT_ICONS: IconName[] = ['users', 'spark', 'folder', 'monitor'];
const AGENT_APPS = ['Codex', 'Claude Code', 'Gemini CLI', 'Antigravity', 'Hermes'] as const;
const RUNTIME_OPTIONS = ['extalia-native', 'hermes'] as const satisfies readonly RuntimeId[];
/** Poster of the Office drawn behind setup; optional, a gradient shows until (or unless) it loads. */
const POSTER = `${import.meta.env.BASE_URL}splash/office-poster.webp`;

function usePoster(src: string): boolean {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const image = new Image();
    let live = true;
    image.onload = () => { if (live) setReady(true); };
    image.src = src;
    return () => { live = false; image.onload = null; };
  }, [src]);
  return ready;
}

/**
 * Full-screen first run, shown instead of the app shell: welcome, profile and
 * appearance, connection (Extalia Native or Hermes Agent), workspace, an
 * optional pointer to agent-app hooks, then done. Only the connection and
 * workspace steps write setup data; setup completes through `completeSetup()`
 * on the last step (or observe mode on the first), never from cosmetic steps.
 */
export function SetupWizard({ t, platform, agents, state, onState, preferences, onPreferences }: {
  t: Messages;
  platform: Platform;
  agents: AgentHostApi;
  state: HostState;
  onState: (next: HostState) => void;
  preferences: Preferences;
  onPreferences: (next: Preferences) => void;
}) {
  // An older or interrupted setup resumes with what the host already has, preselected.
  const existing = useMemo(() => detectExistingSetup(state), []); // eslint-disable-line react-hooks/exhaustive-deps -- first render only
  const [step, setStep] = useState<SetupStepId>('welcome');
  const [connection, setConnection] = useState<ConnectionDraft>(() => existing.connection ? draftFromConnection(existing.connection) : draftFromPreset('openai'));
  const [workspace, setWorkspace] = useState<WorkspaceDraft>(() => existing.workspace ? draftFromWorkspace(existing.workspace) : emptyWorkspaceDraft(existing.connection?.id));
  const [displayName, setDisplayName] = useState('');
  const [profileFailed, setProfileFailed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attempted, setAttempted] = useState(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const shownStep = useRef<SetupStepId>('welcome');
  const { runtimes, ready: runtimesReady, refresh: refreshRuntimes } = useRuntimeStatus(agents);
  const materialName = useId();
  const nameId = useId();
  const [rechecking, setRechecking] = useState(false);
  const poster = usePoster(POSTER);
  // Hermes Agent brings its own models: choosing it skips the model connection.
  const hermes = workspace.runtimeId === 'hermes';
  const hermesInstalled = Boolean(availableHermes(runtimes));
  const hermesBlocked = hermes && runtimesReady && !hermesInstalled;
  const index = stepIndex(step);
  const dataDirectory = dataDirectoryOf(state);

  useEffect(() => {
    // The stored display name, when the host already has a profile.
    let live = true;
    // Older hosts may not offer profiles; that only leaves the name empty.
    Promise.resolve().then(() => agents.getProfile()).then(profile => {
      if (!live || !profile.displayName) return;
      setDisplayName(current => current || profile.displayName || '');
    }, () => undefined);
    return () => { live = false; };
  }, [agents]);

  useEffect(() => {
    // Move focus to the new step's heading so screen readers announce it; not on first load
    // (compared with the last shown step, so a re-run effect does not count as a change).
    if (shownStep.current === step) return;
    shownStep.current = step;
    heading.current?.focus();
  }, [step]);

  const go = (next: SetupStepId) => { setError(null); setAttempted(false); setStep(next); };

  async function run(action: () => Promise<void>, describe: (raw: string) => string = raw => raw) {
    setBusy(true);
    setError(null);
    try { await action(); }
    catch (failure) { setError(describe(errorMessage(failure))); }
    finally { setBusy(false); }
  }

  const recheckRuntimes = async () => { setRechecking(true); try { await refreshRuntimes(); } finally { setRechecking(false); } };

  const displayNameError = validateDisplayName(displayName);

  const saveProfileStep = () => run(async () => {
    setAttempted(true);
    if (displayNameError) return;
    // Appearance already applies on this device; the profile shares it with Web and Desktop.
    // A host that cannot save it does not block setup: the second press continues.
    if (!profileFailed) {
      const name = displayName.trim();
      try {
        await agents.saveProfile({
          displayName: name, // empty removes the stored name
          preferences: { language: preferences.language, theme: preferences.theme, material: preferences.material, font: preferences.font, sidebar: preferences.sidebar },
        });
      } catch {
        setProfileFailed(true);
        return;
      }
    }
    go('connection');
  });

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
    go('workspace');
  }, raw => {
    // Host validation text such as "model: expected a string" is not for users; known failures get plain wording.
    const friendly = friendlyConnectionError(t, raw);
    return friendly === t.connection.failures.generic ? raw : friendly;
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
    go('agentApps');
  });

  const ready = canFinish(state, workspace.id);
  const finish = () => run(async () => { if (ready) onState(await agents.completeSetup()); });
  const observe = () => run(async () => { onState(await agents.completeSetup('observe')); });

  const connectionValid = isValid(validateConnection(connection));
  const workspaceValid = isValid(validateWorkspace(workspace));
  const advance = canAdvance(step, { busy, displayNameValid: !displayNameError, hermes, hermesBlocked, connectionValid, workspaceValid });
  const savedConnection = state.connections.find(item => item.id === workspace.connectionId);
  const picker = state.host.kind === 'desktop' ? platform.capabilities.filesystem : undefined;
  const setPreference = <K extends keyof Preferences>(key: K, value: Preferences[K]) => onPreferences({ ...preferences, [key]: value });
  const connectionLabel = hermes ? t.workspace.usesHermes(workspace.hermesProfile || 'default') : savedConnection ? `${savedConnection.name} · ${savedConnection.model}` : presetById(connection.preset).label;

  const existingNote = existing.found && (step === 'connection' || step === 'workspace') && (
    <div className="setup-existing" role="note">
      <Icon name="check" />
      <div>
        <strong>{t.setup.existingTitle}</strong>
        <p className="muted small">{t.setup.existingLead}</p>
        <p className="small setup-existing-items">
          {existing.connection && <span className="chip">{existing.connection.name} · {existing.connection.model}</span>}
          {existing.workspace && <span className="chip">{existing.workspace.name}</span>}
        </p>
      </div>
    </div>
  );

  const title = (text: string) => <h1 id="setup-title" ref={heading} tabIndex={-1}>{text}</h1>;

  return (
    <div className={`setup setup-welcome-flow ${poster ? 'has-poster' : ''}`} data-onboarding-step={index + 1} data-setup-step={step}>
      <div className="setup-backdrop" aria-hidden="true" style={poster ? { '--setup-poster': `url("${POSTER}")` } as CSSProperties : undefined} />
      <header className="setup-header">
        <Brand />
        <div className="setup-prefs">
          {step !== 'welcome' && (
            <Select
              value={preferences.language}
              aria-label={t.setup.language}
              options={LANGUAGES.map(lang => ({ value: lang.id, label: lang.label, flag: lang.id }))}
              onChange={val => setPreference('language', val)}
            />
          )}
          <span className="topbar-meta">{t.hosts[state.host.kind]} · v{platform.info.appVersion}</span>
        </div>
      </header>

      <main className="setup-main">
        <section className="card setup-card" aria-labelledby="setup-title">
          <div className="setup-progress">
            <p className="muted small" id="setup-step-of">{t.setup.stepOf(index + 1, SETUP_STEPS.length)} · {t.setup.steps[index]}</p>
            <ol className="setup-steps" aria-label={t.setup.progress}>
              {t.setup.steps.map((label, position) => (
                <li key={label} aria-current={position === index ? 'step' : undefined} className={position < index ? 'done' : ''}>
                  <span className="step-index" aria-hidden="true">{position < index ? <Icon name="check" /> : position + 1}</span>
                  <span className="step-label">{label}</span>
                </li>
              ))}
            </ol>
          </div>

          {step === 'welcome' && (
            <>
              <p className="setup-eyebrow">{t.setup.welcomeEyebrow}</p>
              {title(t.setup.welcomeTitle)}
              <p className="lead">{t.setup.welcomeLead}</p>
              <Segmented
                className="setup-language"
                legend={t.setup.language}
                value={preferences.language}
                options={LANGUAGES.map(lang => ({ value: lang.id, label: lang.label }))}
                onChange={val => setPreference('language', val)}
              />
              <h2 className="setup-subtitle">{t.setup.setupListTitle}</h2>
              <ol className="welcome-points">
                {t.setup.welcomePoints.map(([pointTitle, text], position) => (
                  <li key={pointTitle}><span className="welcome-point-icon" aria-hidden="true"><Icon name={POINT_ICONS[position] ?? 'check'} /></span><span><strong>{pointTitle}</strong><br /><span className="muted">{text}</span></span></li>
                ))}
              </ol>
              <p className="note"><Icon name="shield" />{t.setup.secretStore[state.storage.secretStore]}</p>
            </>
          )}

          {step === 'profile' && (
            <>
              {title(t.setup.profileTitle)}
              <p className="lead">{t.setup.profileLead}</p>
              <div className="field">
                <label htmlFor={nameId}>{t.setup.displayName} <span className="muted small">({t.setup.optional})</span></label>
                <input id={nameId} type="text" autoComplete="nickname" maxLength={DISPLAY_NAME_MAX + 16} value={displayName} placeholder={t.setup.displayNamePlaceholder}
                  aria-invalid={attempted && displayNameError ? true : undefined} aria-describedby={`${nameId}-hint`}
                  onChange={event => setDisplayName(event.target.value)}
                  onKeyDown={event => { if (event.key === 'Enter' && advance) { event.preventDefault(); void saveProfileStep(); } }} />
                <small className={displayNameError ? 'field-error' : 'muted'} id={`${nameId}-hint`}>{displayNameError ? t.setup.displayNameErrors[displayNameError] : t.setup.displayNameHint}</small>
              </div>
              <Segmented
                className="setup-theme"
                legend={t.setup.theme}
                value={preferences.theme}
                options={THEMES.map(theme => ({ value: theme, label: t.settings.themes[theme].replace(/\s*\(.*\)$/, ''), icon: <Icon name={THEME_ICONS[theme]} /> }))}
                onChange={val => setPreference('theme', val)}
                hint={<>{t.settings.themeEffects[preferences.theme]} {t.settings.themeLightsNote}</>}
              />
              <fieldset className="preset-picker material-picker">
                <legend>{t.setup.material}</legend>
                <div className="material-grid">
                  {MATERIALS.map(material => (
                    <label key={material} className="preset-card material-card">
                      <input type="radio" name={materialName} value={material} checked={preferences.material === material}
                        onChange={() => setPreference('material', material)} />
                      <MaterialPreview material={material} />
                      <span className="preset-name">{t.settings.materials[material]}{material !== 'standard' && <span className="chip">{t.settings.materialBadges[material]}</span>}</span>
                      <span className="preset-hint">{t.settings.materialDescriptions[material]}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <Select
                label={t.setup.font}
                value={preferences.font}
                options={FONTS.map(font => ({ value: font, label: t.settings.fonts[font] }))}
                onChange={val => setPreference('font', val)}
              />
              <p className="note"><Icon name="folder" /><span>{t.setup.profileStored} <code>{dataDirectory}</code></span></p>
              {profileFailed && <p className="note setup-warn" role="status"><Icon name="alert" />{t.setup.profileSaveFailed}</p>}
            </>
          )}

          {step === 'connection' && (
            <>
              {title(t.setup.connectionTitle)}
              <p className="lead">{t.setup.connectionLead}</p>
              {existingNote}
              <RuntimePicker t={t} legend={t.setup.runtimeLegend} value={hermes ? 'hermes' : 'extalia-native'} offered={RUNTIME_OPTIONS}
                hermesInstalled={hermesInstalled} runtimesReady={runtimesReady} rechecking={rechecking} onRecheck={recheckRuntimes}
                onChange={runtimeId => setWorkspace(current => ({ ...current, runtimeId }))} />
              <p className="lead">{hermes ? t.setup.hermesLead : t.setup.modelLead}</p>
              {!hermes && <ConnectionForm t={t} agents={agents} draft={connection} onChange={setConnection} showAllErrors={attempted} />}
            </>
          )}

          {step === 'workspace' && (
            <>
              {title(t.setup.workspaceTitle)}
              <p className="lead">{t.setup.workspaceLead}</p>
              {existingNote}
              <WorkspaceForm t={t} agents={agents} picker={picker} draft={workspace} onChange={setWorkspace} runtimes={runtimes} runtimesReady={runtimesReady} showAllErrors={attempted} />
            </>
          )}

          {step === 'agentApps' && (
            <>
              {title(t.setup.agentAppsTitle)}
              <p className="lead">{t.setup.agentAppsLead}</p>
              <ul className="setup-agent-apps">
                {AGENT_APPS.map(app => (
                  <li key={app}>
                    <span className="setup-agent-app-mark" aria-hidden="true"><AgentAppLogo app={app} /></span>
                    <span>{app}</span>
                  </li>
                ))}
              </ul>
              <p className="note"><Icon name="monitor" /><span>{t.setup.agentAppsHow}</span></p>
              <p className="muted small">{t.setup.agentAppsOptional}</p>
            </>
          )}

          {step === 'done' && (
            <>
              {title(t.setup.doneTitle)}
              <p className="lead">{t.setup.doneLead}</p>
              <dl className="facts">
                <div><dt>{t.setup.summaryProfile}</dt><dd>{displayName.trim() || <span className="muted">{t.setup.anonymous}</span>}</dd></div>
                <div><dt>{t.setup.summaryAppearance}</dt><dd>{t.settings.themes[preferences.theme].replace(/\s*\(.*\)$/, '')} · {t.settings.materials[preferences.material]}</dd></div>
                <div><dt>{t.setup.summaryConnection}</dt><dd>{connectionLabel}</dd></div>
                <div><dt>{t.setup.summaryWorkspace}</dt><dd>{workspace.name}</dd></div>
                <div><dt>{t.setup.summaryFolder}</dt><dd><code>{workspace.folder?.path ?? workspace.folderInput}</code></dd></div>
                <div><dt>{t.setup.summaryPermissions}</dt><dd>{permissionsLabel(t, workspace.runtimeId, workspace.permissions)}</dd></div>
                <div><dt>{t.setup.summaryDataFolder}</dt><dd><code>{dataDirectory}</code></dd></div>
              </dl>
              {!ready && <p className="note setup-warn" role="status"><Icon name="alert" />{t.setup.notReady}</p>}
            </>
          )}

          {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

          <div className="actions setup-actions">
            {step !== 'welcome' && <button type="button" disabled={busy} onClick={() => go(previousStep(step))}><Icon name="chevron" className="flip" />{t.common.back}</button>}
            {step === 'welcome' && <button type="button" className="setup-observe" disabled={busy} onClick={observe} aria-describedby="setup-observe-hint">{t.setup.observeOnly}</button>}
            <span className="spacer" />
            {step === 'welcome' && <button type="button" className="primary" disabled={!advance} onClick={() => go(nextStep(step))}>{t.setup.begin}<Icon name="chevron" /></button>}
            {step === 'profile' && <button type="button" className="primary" disabled={!advance} onClick={saveProfileStep}>{busy ? t.common.saving : t.common.next}<Icon name="chevron" /></button>}
            {step === 'connection' && <button type="button" className="primary" disabled={!advance} onClick={hermes ? () => go('workspace') : saveConnection}>{busy ? t.common.saving : t.common.next}<Icon name="chevron" /></button>}
            {step === 'workspace' && <button type="button" className="primary" disabled={!advance} onClick={saveWorkspace}>{busy ? t.common.saving : t.common.next}<Icon name="chevron" /></button>}
            {step === 'agentApps' && <button type="button" className="primary" disabled={!advance} onClick={() => go('done')}>{t.setup.continue}<Icon name="chevron" /></button>}
            {step === 'done' && <button type="button" className="primary" disabled={busy || !ready} onClick={finish}>{busy ? t.setup.finishing : t.setup.finish}<Icon name="monitor" /></button>}
          </div>
          {step === 'welcome' && <p className="muted small setup-observe-hint" id="setup-observe-hint">{t.observer.setup}</p>}
        </section>
      </main>
    </div>
  );
}

/** Small static sample of a surface style: a window over a soft office-coloured backdrop. */
function MaterialPreview({ material }: { material: MaterialPreference }) {
  return (
    <span className="material-preview" data-preview={material} aria-hidden="true">
      <span className="material-preview-blob a" />
      <span className="material-preview-blob b" />
      <span className="material-preview-rail" />
      <span className="material-preview-window">
        <span className="material-preview-line" />
        <span className="material-preview-line short" />
        <span className="material-preview-pill" />
      </span>
    </span>
  );
}
