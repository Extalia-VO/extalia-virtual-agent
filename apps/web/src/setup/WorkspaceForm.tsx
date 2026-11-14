import { INTEGRATION_GATE_LIMITS, MAX_WORKSPACE_FOLDERS, RUNTIME_IDS, WORKSPACE_CROSS_ACCESS, type PermissionMode } from '@extalia/core';
import type { AgentHostApi, ConnectionView, FileSystemCapability, HermesModelCatalog, RuntimeInfo } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { DeleteConfirmation } from '../ui/DeleteConfirmation';
import { CopyButton } from '../ui/CopyButton';
import { ComboBox, type ComboOption } from '../ui/ComboBox';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { RuntimePicker } from './RuntimePicker';
import { groupedModelOptions } from './modelOptions';
import { bypassesHermesApprovals, hermesPermissions } from './permissions';
import { availableHermes } from './useRuntimes';
import { useGateSuggestion } from './gateSuggestion';
import { validWorkspaceFolders, validateWorkspace, type WorkspaceDraft, type WorkspaceField } from './validation';
import { DirectoryBrowser } from './DirectoryBrowser';
import { createWorkspaceFolderRequests } from './workspaceFolderRequest';

/**
 * Workspace editor used by the wizard and Settings. Desktop picks folders with
 * the native dialog; the Bridge browses host folders through its authenticated API.
 */
export function WorkspaceForm({ t, agents, picker, draft, onChange, connections, runtimes = [], runtimesReady = true, onRecheckRuntimes, showAllErrors = false, showGate = false, focusGate = false, onValidationBusyChange }: {
  t: Messages;
  agents: AgentHostApi;
  /** Native folder picker; only used when it reveals full paths (Desktop). */
  picker?: FileSystemCapability;
  draft: WorkspaceDraft;
  onChange: (draft: WorkspaceDraft) => void;
  /** Offer a connection and runtime choice; the wizard fixes them in its earlier step. */
  connections?: ConnectionView[];
  /** What the host can run; Hermes Agent is selectable only when it is installed. */
  runtimes?: readonly RuntimeInfo[];
  /** The host has answered which runtimes it can run (before that, Hermes is looked for). */
  runtimesReady?: boolean;
  /** Look for the runtimes again, after Hermes Agent was installed. */
  onRecheckRuntimes?: () => Promise<void> | void;
  showAllErrors?: boolean;
  /** ADR 0028: offer the workspace's integration test gate (Settings; the wizard leaves it out). */
  showGate?: boolean;
  /** Scroll to and focus the gate command (opened from a mission's Changes panel). */
  focusGate?: boolean;
  /** Keep the enclosing Save action pending until all selected folder paths are checked. */
  onValidationBusyChange?: (busy: boolean) => void;
}) {
  const id = useId();
  const [touched, setTouched] = useState<ReadonlySet<WorkspaceField>>(new Set());
  const [checkingFolder, setCheckingFolder] = useState<{ path: string; workspaceId?: string } | null>(null);
  const [folderFailure, setFolderFailure] = useState<{ path: string; workspaceId?: string; message: string } | null>(null);
  const observe = draft.mode === 'observe';
  const folderContext = `${draft.id ?? ''}:${draft.runtimeId}:${draft.mode ?? 'managed'}`;
  const removalContext = JSON.stringify([folderContext, draft.folderInput, draft.folder?.path]);
  const removalOwner = useRef({ active: true, agents, context: removalContext });
  useLayoutEffect(() => { removalOwner.current.agents = agents; removalOwner.current.context = removalContext; }, [agents, removalContext]);
  const [folderToRemove, setFolderToRemove] = useState<{ path: string; context: string; agents: AgentHostApi } | null>(null);
  const pendingRemoval = useRef<typeof folderToRemove>(null);
  const removal = folderToRemove?.agents === agents && folderToRemove.context === removalContext
    && draft.additionalProjectLocations.includes(folderToRemove.path) && draft.folder?.path !== folderToRemove.path && draft.folderInput !== folderToRemove.path ? folderToRemove : null;
  useLayoutEffect(() => {
    const owner = removalOwner.current;
    owner.active = true;
    return () => { owner.active = false; pendingRemoval.current = null; };
  }, []);
  if (folderToRemove && !removal) setFolderToRemove(null);
  useLayoutEffect(() => { if (!removal) pendingRemoval.current = null; }, [removal]);
  const [browserState, setBrowserState] = useState<{ context: string; kind: 'primary' | 'additional' } | null>(null);
  const browsing = browserState?.context === folderContext ? browserState.kind : null;
  const setBrowsing = (kind: 'primary' | 'additional' | null) => setBrowserState(kind ? { context: folderContext, kind } : null);
  const emptyAdditional = { context: folderContext, checking: false, error: null as string | null };
  const [additionalState, setAdditionalState] = useState(emptyAdditional);
  if (additionalState.context !== folderContext) {
    setAdditionalState(emptyAdditional);
    setBrowserState(null);
  }
  const additional = additionalState.context === folderContext ? additionalState : emptyAdditional;
  const { checking: checkingAdditional, error: additionalFolderError } = additional;
  const updateAdditional = (patch: Partial<typeof emptyAdditional>) => setAdditionalState(previous => ({ ...(previous.context === folderContext ? previous : emptyAdditional), ...patch }));
  const setCheckingAdditional = (checking: boolean) => updateAdditional({ checking });
  const setAdditionalFolderError = (error: string | null) => updateAdditional({ error });
  const additionalRequest = useRef(0);
  const [folderRequests] = useState(() => createWorkspaceFolderRequests(draft));
  useLayoutEffect(() => {
    folderRequests.sync(draft);
  }, [draft, folderRequests]);
  useLayoutEffect(() => () => folderRequests.invalidate(), [folderRequests]);
  useLayoutEffect(() => {
    const invalidateAdditional = () => { additionalRequest.current++; };
    invalidateAdditional();
    return invalidateAdditional;
  }, [draft.id, draft.runtimeId, draft.mode]);
  const checking = Boolean(checkingFolder && checkingFolder.workspaceId === draft.id && checkingFolder.path === draft.folderInput && !draft.folder);
  useEffect(() => {
    onValidationBusyChange?.(checking || checkingAdditional);
    return () => onValidationBusyChange?.(false);
  }, [checking, checkingAdditional, onValidationBusyChange]);
  const folderError = folderFailure && folderFailure.workspaceId === draft.id && folderFailure.path === draft.folderInput ? folderFailure.message : null;
  const setChecking = (value: boolean) => {
    const current = folderRequests.draft();
    setCheckingFolder(value ? { path: current.folderInput, workspaceId: current.id } : null);
  };
  const setFolderError = (message: string | null) => {
    const current = folderRequests.draft();
    setFolderFailure(message === null ? null : { path: current.folderInput, workspaceId: current.id, message });
  };
  const errors = validateWorkspace(draft);
  const errorFor = (field: WorkspaceField) => (showAllErrors || touched.has(field)) && errors[field] ? t.workspace.errors[errors[field]] : undefined;
  const touch = (field: WorkspaceField) => setTouched(previous => new Set(previous).add(field));
  const update = (patch: Partial<WorkspaceDraft>) => {
    const next = { ...folderRequests.draft(), ...patch };
    folderRequests.sync(next);
    onChange(next);
  };
  const confirmFolderRemoval = () => {
    const selected = pendingRemoval.current;
    if (!selected || !removalOwner.current.active) return;
    pendingRemoval.current = null;
    setFolderToRemove(null);
    const current = folderRequests.draft();
    const currentContext = JSON.stringify([`${current.id ?? ''}:${current.runtimeId}:${current.mode ?? 'managed'}`, current.folderInput, current.folder?.path]);
    if (selected.agents !== removalOwner.current.agents || selected.context !== removalOwner.current.context || selected.context !== currentContext
      || current.folder?.path === selected.path || current.folderInput === selected.path || !current.additionalProjectLocations.includes(selected.path)) return;
    update({ additionalProjectLocations: current.additionalProjectLocations.filter(path => path !== selected.path) });
  };
  const invalidateFolder = () => {
    folderRequests.invalidate();
    setChecking(false);
    setFolderError(null);
  };

  async function check(path: string) {
    if (!path.trim()) { invalidateFolder(); return; }
    const pending = folderRequests.check(path);
    setChecking(true);
    setFolderError(null);
    onChange(pending.draft);
    try {
      const result = await agents.checkFolder(path.trim());
      if (!folderRequests.current(pending.request)) return;
      if (result.ok && result.path) {
        const next = folderRequests.accept(pending.request, result);
        if (next) onChange(next);
      } else {
        setFolderError(result.error ?? t.workspace.errors.folderRequired);
      }
    } catch (error) {
      if (folderRequests.current(pending.request)) setFolderError(errorMessage(error));
    } finally {
      if (folderRequests.current(pending.request)) {
        setChecking(false);
        touch('folder');
      }
    }
  }

  async function choose() {
    invalidateFolder();
    const request = folderRequests.begin();
    if (!picker) { setBrowsing('primary'); return; }
    try {
      const selection = await picker.selectDirectory();
      if (!folderRequests.current(request)) return;
      if (selection?.path) await check(selection.path);
      else if (selection) setBrowsing('primary');
    } catch (error) {
      if (folderRequests.current(request)) setFolderError(errorMessage(error));
    }
  }

  async function checkAdditional(path: string, request = ++additionalRequest.current) {
    setCheckingAdditional(true);
    setAdditionalFolderError(null);
    try {
      const result = await agents.checkFolder(path.trim());
      if (request !== additionalRequest.current) return;
      const current = folderRequests.draft();
      if (!result.ok || !result.path) { setAdditionalFolderError(result.error ?? t.workspace.errors.folderRequired); return; }
      const locations = [...current.additionalProjectLocations, result.path];
      if (!validWorkspaceFolders(current.folder?.path ?? current.folderInput, locations)) {
        setAdditionalFolderError(t.workspace.errors.additionalFoldersInvalid);
        return;
      }
      update({ additionalProjectLocations: locations });
    } catch (error) {
      if (request === additionalRequest.current) setAdditionalFolderError(errorMessage(error));
    } finally {
      if (request === additionalRequest.current) setCheckingAdditional(false);
    }
  }

  async function chooseAdditional() {
    const request = ++additionalRequest.current;
    setAdditionalFolderError(null);
    if (!picker) { setBrowsing('additional'); return; }
    setCheckingAdditional(true);
    try {
      const selection = await picker.selectDirectory();
      if (request !== additionalRequest.current) return;
      if (selection?.path) await checkAdditional(selection.path, request);
      else if (selection) setBrowsing('additional');
    } catch (error) {
      if (request === additionalRequest.current) setAdditionalFolderError(errorMessage(error));
    } finally {
      if (request === additionalRequest.current) setCheckingAdditional(false);
    }
  }

  const folderMessage = folderError ?? errorFor('folder');
  const hermes = availableHermes(runtimes);
  // The profile's default model and, for a local router such as 9Router, the models it offers.
  const [scan, setScan] = useState(0);
  const scanProfile = !observe && draft.runtimeId === 'hermes' && hermes ? draft.hermesProfile || 'default' : undefined;
  const scanKey = scanProfile && `${scanProfile}#${scan}`;
  const [result, setResult] = useState<{ key: string; catalog?: HermesModelCatalog }>();
  useEffect(() => {
    if (!scanKey || !scanProfile || !agents.hermesModels) return;
    let live = true;
    agents.hermesModels(scanProfile).then(catalog => { if (live) setResult({ key: scanKey, catalog }); }, () => { if (live) setResult({ key: scanKey }); });
    return () => { live = false; };
  }, [agents, scanKey, scanProfile]);
  const scanning = Boolean(scanKey && agents.hermesModels) && result?.key !== scanKey;
  // While a rescan runs, the last list of the same profile stays usable.
  const catalog = scanProfile && result?.catalog?.profile === scanProfile ? result.catalog : undefined;
  // Empty means "the profile's default"; the router's models follow, grouped by their provider prefix.
  const modelOptions: ComboOption[] = [
    ...(catalog?.defaultModel ? [{ value: '', label: t.workspace.hermesModelScan.useDefault, description: catalog.defaultModel, badge: t.workspace.hermesModelScan.defaultBadge }] : []),
    ...groupedModelOptions(catalog?.models ?? [], { otherGroup: t.workspace.hermesModelScan.otherGroup, defaultModel: catalog?.defaultModel, defaultBadge: t.workspace.hermesModelScan.defaultBadge }),
  ];
  const modelHint = scanning && !catalog ? t.workspace.hermesModelScan.loading(scanProfile ?? 'default')
    : catalog?.error === 'unreachable' && catalog.endpoint ? t.workspace.hermesModelScan.unreachable(catalog.endpoint)
      : catalog?.defaultModel && catalog.models.length && catalog.endpoint ? t.workspace.hermesModelScan.found(catalog.defaultModel, catalog.models.length, catalog.endpoint)
        : catalog?.defaultModel ? t.workspace.hermesModelScan.defaultOnly(catalog.defaultModel)
          : catalog && scanProfile ? t.workspace.hermesModelScan.noDefault(scanProfile)
            : t.workspace.hermesModelHint;
  const isHermes = !observe && draft.runtimeId === 'hermes';
  // A suggestion from the saved workspace's files; offered as a button, never applied by itself.
  const gateSuggestion = useGateSuggestion(agents, showGate && !observe ? draft.id : undefined);
  const gateInput = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (!showGate || !focusGate) return;
    gateInput.current?.scrollIntoView?.({ block: 'center' });
    gateInput.current?.focus();
  }, [showGate, focusGate]);
  const [rechecking, setRechecking] = useState(false);
  async function recheckRuntimes() {
    if (!onRecheckRuntimes) return;
    setRechecking(true);
    try { await onRecheckRuntimes(); } finally { setRechecking(false); }
  }
  const profiles = [...new Set([...(hermes?.profiles ?? ['default']), draft.hermesProfile].filter(Boolean))];
  const bypass = bypassesHermesApprovals(draft.permissions);
  const permission = (key: 'fileWrite' | 'commands') => (
    <div className="permission">
      <Segmented legend={t.workspace[key]} value={draft.permissions[key]}
        options={[{ value: 'ask' as PermissionMode, label: t.workspace.modes.ask }, { value: 'allow' as PermissionMode, label: t.workspace.modes.allow }]}
        onChange={mode => update({ permissions: { ...draft.permissions, [key]: mode } })} />
      {draft.permissions[key] === 'allow' && <p className="warning"><Icon name="alert" />{t.workspace.allowWarning[key]}</p>}
    </div>
  );

  return (
    <div className="form-stack" aria-busy={checking || checkingAdditional || undefined}>
      {connections && <Segmented legend={t.workspace.mode} value={observe ? 'observe' : 'managed'}
        options={[{ value: 'observe', label: t.workspace.observe }, { value: 'managed', label: t.workspace.managed }]}
        onChange={mode => update({ mode })} />}
      {observe && <p className="note small">{t.workspace.observeLead}</p>}
      <div className="field" role="group" aria-labelledby={`${id}-folder-label`}>
        <span id={`${id}-folder-label`}>{t.workspace.folder}</span>
          <div className="folder-pick">
            <button type="button" id={`${id}-folder`} className="button" disabled={checking} onClick={choose} aria-describedby={`${id}-folder-path ${id}-folder-status`}>
              <Icon name="folder" />{draft.folder ? t.workspace.change : t.workspace.choose}
            </button>
            <code className="folder-path" id={`${id}-folder-path`}>{draft.folder?.path ?? t.workspace.noFolder}</code>
            {draft.folder && <CopyButton text={draft.folder.path} label={t.workspace.folder} />}
          </div>
        <small id={`${id}-folder-status`} role="status" className={checking ? 'muted' : folderMessage ? 'field-error' : draft.folder && !picker ? 'status ok' : 'muted'}>
          {checking ? t.workspace.checking : folderMessage ?? null}
        </small>
      </div>
      {removal && <DeleteConfirmation t={t} title={t.deletion.folderTitle} target={removal.path} description={t.deletion.folderDescription}
        onConfirm={confirmFolderRemoval} onCancel={() => { pendingRemoval.current = null; setFolderToRemove(null); }} />}
      {browsing && <DirectoryBrowser t={t} agents={agents} {...(draft.folder ? { startPath: draft.folder.path } : {})}
        onClose={() => { invalidateFolder(); additionalRequest.current++; setBrowsing(null); }}
        onSelect={selected => { const additional = browsing === 'additional'; setBrowsing(null); if (additional) void checkAdditional(selected); else void check(selected); }} />}

      {!isHermes && <div className="form-stack tight" role="group" aria-labelledby={`${id}-additional-heading`}>
        <h3 className="form-heading" id={`${id}-additional-heading`}>{t.workspace.additionalFolders.heading}</h3>
        <p className="muted small">{t.workspace.additionalFolders.lead}</p>
        {draft.additionalProjectLocations.map(path => <div className="input-row" key={path}>
          <code className="folder-path">{path}</code><CopyButton text={path} label={t.workspace.additionalFolders.path} />
          <button type="button" className="button small" aria-label={t.workspace.additionalFolders.remove(path)} onClick={() => { const selected = { path, context: removalContext, agents }; pendingRemoval.current = selected; setFolderToRemove(selected); }}><Icon name="trash" />{t.common.delete}</button>
        </div>)}
        <button type="button" className="button" disabled={checkingAdditional || draft.additionalProjectLocations.length >= MAX_WORKSPACE_FOLDERS - 1} aria-describedby={`${id}-additional-status`} onClick={() => void chooseAdditional()}><Icon name="folder" />{t.workspace.additionalFolders.add}</button>
        <small id={`${id}-additional-status`} role="status" className={checkingAdditional ? 'muted' : 'field-error'}>{checkingAdditional ? t.workspace.checking : additionalFolderError ?? errorFor('additionalFolders')}</small>
      </div>}

      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-name`}>{t.workspace.name}</label>
          <input id={`${id}-name`} type="text" value={draft.name} maxLength={120} autoComplete="off" aria-invalid={Boolean(errorFor('name'))} aria-describedby={errorFor('name') ? `${id}-name-error` : undefined}
            onChange={event => update({ name: event.target.value })} onBlur={() => touch('name')} />
          {errorFor('name') && <small id={`${id}-name-error`} className="field-error">{errorFor('name')}</small>}
        </div>
        {connections && !isHermes && !observe && (
          <div className="field">
            <Select
              id={`${id}-connection`}
              label={t.workspace.connection}
              value={draft.connectionId}
              aria-invalid={Boolean(errorFor('connection'))}
              aria-describedby={errorFor('connection') ? `${id}-connection-error` : undefined}
              options={connections.map(connection => ({
                value: connection.id,
                label: `${connection.name} · ${connection.model}`
              }))}
              onChange={val => update({ connectionId: val })}
            />
            {errorFor('connection') && <small id={`${id}-connection-error`} className="field-error">{errorFor('connection')}</small>}
          </div>
        )}
      </div>

      {connections && observe && <details className="workspace-observe-curator">
        <summary>{t.workspace.curator}</summary>
        <p className="muted small">{t.workspace.curatorLead}</p>
        <Select label={t.workspace.connection} value={draft.connectionId}
          options={[{ value: '', label: t.workspace.noCurator }, ...connections.map(connection => ({ value: connection.id, label: `${connection.name} · ${connection.model}` }))]}
          onChange={connectionId => update({ connectionId })} />
      </details>}

      {connections && !observe && (
        <RuntimePicker t={t} legend={t.workspace.runtime} value={draft.runtimeId} offered={RUNTIME_IDS} hermesInstalled={Boolean(hermes)}
          runtimesReady={runtimesReady} rechecking={rechecking} onRecheck={onRecheckRuntimes ? recheckRuntimes : undefined}
          onChange={runtimeId => update({ runtimeId, ...(runtimeId === 'hermes' ? { permissions: hermesPermissions(bypassesHermesApprovals(draft.permissions)) } : {}) })} />
      )}
      {draft.id && !observe && <p className="note small">{t.workspace.runtimeChangeHint}</p>}
      {isHermes && (
        <div className="form-stack tight">
          <div className="form-grid">
            <div className="field">
              <Select
                id={`${id}-profile`}
                label={t.workspace.hermesProfile}
                value={draft.hermesProfile}
                aria-invalid={Boolean(errorFor('profile'))}
                aria-describedby={errorFor('profile') ? `${id}-profile-error` : undefined}
                options={profiles.map(profile => ({ value: profile, label: profile }))}
                onChange={val => { touch('profile'); update({ hermesProfile: val }); }}
              />
              {errorFor('profile') && <small id={`${id}-profile-error`} className="field-error">{errorFor('profile')}</small>}
            </div>
            <div className="field">
              <ComboBox id={`${id}-model`} label={t.workspace.hermesModel} value={draft.hermesModel} options={modelOptions}
                placeholder={catalog?.defaultModel ? t.workspace.hermesModelDefault(catalog.defaultModel) : t.workspace.hermesModelPlaceholder}
                customLabel={t.workspace.hermesModelScan.custom} emptyLabel={t.workspace.hermesModelScan.empty}
                invalid={Boolean(errorFor('model'))} describedBy={`${id}-model-hint`}
                onChange={value => update({ hermesModel: value })} onBlur={() => touch('model')}
                action={<button type="button" className="icon-button small" aria-label={t.workspace.hermesModelScan.refresh} title={t.workspace.hermesModelScan.refresh}
                  disabled={scanning} onClick={() => setScan(value => value + 1)}><Icon name="refresh" className={scanning ? 'spin' : ''} /></button>} />
              <small id={`${id}-model-hint`} className={errorFor('model') ? 'field-error' : 'muted'} aria-live="polite">{errorFor('model') ?? modelHint}</small>
            </div>
          </div>
          {runtimes.length > 0 && !hermes && <p className="warning"><Icon name="alert" />{t.workspace.hermesUnavailable}</p>}
          <p className="note"><Icon name="shield" />{t.workspace.hermesApprovals}</p>
        </div>
      )}

      {!observe && <div className="form-stack tight">
        <h3 className="form-heading">{t.workspace.permissions}</h3>
        {isHermes ? (
          <>
            <p className="muted small">{t.workspace.hermesPermissions.lead}</p>
            <p className="status" id={`${id}-hermes-permissions`}><Icon name="shield" />{bypass ? t.workspace.hermesPermissions.bypassSummary : t.workspace.hermesPermissions.managed}</p>
            <label className="switch">
              <input type="checkbox" role="switch" checked={bypass} aria-describedby={`${id}-hermes-permissions`}
                onChange={event => update({ permissions: hermesPermissions(event.target.checked) })} />
              <span className="switch-track" aria-hidden="true" />
              <span>{t.workspace.hermesPermissions.bypass}</span>
            </label>
            {bypass && <p className="warning"><Icon name="alert" />{t.workspace.hermesPermissions.bypassWarning}</p>}
          </>
        ) : (
          <>
            <p className="muted small">{t.workspace.permissionsLead}</p>
            <div className="form-grid">
              {permission('fileWrite')}
              {permission('commands')}
            </div>
            <div className="field">
              <Select id={`${id}-cross-access`} label={t.workspace.crossAccess.heading} value={draft.crossWorkspaceAccess}
                options={WORKSPACE_CROSS_ACCESS.map(value => ({ value, label: t.workspace.crossAccess.modes[value], description: t.workspace.crossAccess.descriptions[value] }))}
                onChange={crossWorkspaceAccess => update({ crossWorkspaceAccess })} />
              <p className="muted small">{t.workspace.crossAccess.lead}</p>
              <p className="note small" aria-live="polite">{t.workspace.crossAccess.descriptions[draft.crossWorkspaceAccess]}</p>
              <p className="note small">{t.workspace.crossAccess.detail}</p>
            </div>
          </>
        )}
      </div>}

      {showGate && !observe && (
        <div className="form-stack tight workspace-gate" role="group" aria-labelledby={`${id}-gate-heading`}>
          <h3 className="form-heading" id={`${id}-gate-heading`}>{t.workspace.gate.heading}</h3>
          <p className="muted small" id={`${id}-gate-lead`}>{t.workspace.gate.lead}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`${id}-gate`}>{t.workspace.gate.command}</label>
              <input id={`${id}-gate`} ref={gateInput} type="text" value={draft.gateCommand ?? ''} maxLength={4000} spellCheck={false} autoCapitalize="off" autoComplete="off"
                placeholder={t.workspace.gate.commandPlaceholder} aria-invalid={Boolean(errorFor('gate'))} aria-describedby={`${id}-gate-lead ${id}-gate-detail${errorFor('gate') ? ` ${id}-gate-error` : ''}`}
                onChange={event => update({ gateCommand: event.target.value })} onBlur={() => touch('gate')} />
              {errorFor('gate') && <small id={`${id}-gate-error`} className="field-error">{errorFor('gate')}</small>}
            </div>
            <div className="field">
              <label htmlFor={`${id}-gate-timeout`}>{t.workspace.gate.timeout}</label>
              <input id={`${id}-gate-timeout`} type="number" inputMode="numeric" min={INTEGRATION_GATE_LIMITS.minTimeoutSeconds} max={INTEGRATION_GATE_LIMITS.maxTimeoutSeconds} step={1} value={draft.gateTimeout ?? ''} autoComplete="off"
                placeholder={t.workspace.gate.timeoutPlaceholder} aria-invalid={Boolean(errorFor('gateTimeout'))} aria-describedby={errorFor('gateTimeout') ? `${id}-gate-timeout-error` : undefined}
                onChange={event => update({ gateTimeout: event.target.value })} onBlur={() => touch('gateTimeout')} />
              {errorFor('gateTimeout') && <small id={`${id}-gate-timeout-error`} className="field-error">{errorFor('gateTimeout')}</small>}
            </div>
          </div>
          {gateSuggestion && gateSuggestion !== (draft.gateCommand ?? '').trim() && (
            <p className="muted small workspace-gate-suggestion">
              <button type="button" className="button small" onClick={() => update({ gateCommand: gateSuggestion })}><Icon name="check" />{t.workspace.gate.suggestion(gateSuggestion)}</button>
              {' '}{t.workspace.gate.suggestionHint}
            </p>
          )}
          <p className="note" id={`${id}-gate-detail`}><Icon name="shield" />{t.workspace.gate.detail}</p>
        </div>
      )}
    </div>
  );
}
