import { RUNTIME_IDS, type PermissionMode } from '@extalia/core';
import type { AgentHostApi, ConnectionView, FileSystemCapability, HermesModelCatalog, RuntimeInfo } from '@extalia/platform';
import { useEffect, useId, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { ComboBox, type ComboOption } from '../ui/ComboBox';
import { Select } from '../ui/Select';
import { Segmented } from '../ui/Segmented';
import { RuntimePicker } from './RuntimePicker';
import { groupedModelOptions } from './modelOptions';
import { bypassesHermesApprovals, hermesPermissions } from './permissions';
import { availableHermes } from './useRuntimes';
import { useGateSuggestion } from './gateSuggestion';
import { validateWorkspace, type WorkspaceDraft, type WorkspaceField } from './validation';

/**
 * Workspace editor used by the wizard and Settings. Desktop picks folders with
 * the native dialog; the Bridge cannot, so the user types a path the host checks.
 */
export function WorkspaceForm({ t, agents, picker, draft, onChange, connections, runtimes = [], runtimesReady = true, onRecheckRuntimes, showAllErrors = false, showGate = false, focusGate = false }: {
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
}) {
  const id = useId();
  const [touched, setTouched] = useState<ReadonlySet<WorkspaceField>>(new Set());
  const [checking, setChecking] = useState(false);
  const [folderError, setFolderError] = useState<string | null>(null);
  const errors = validateWorkspace(draft);
  const errorFor = (field: WorkspaceField) => (showAllErrors || touched.has(field)) && errors[field] ? t.workspace.errors[errors[field]] : undefined;
  const touch = (field: WorkspaceField) => setTouched(previous => new Set(previous).add(field));
  const update = (patch: Partial<WorkspaceDraft>) => onChange({ ...draft, ...patch });

  async function check(path: string, current: WorkspaceDraft) {
    if (!path.trim()) return;
    setChecking(true);
    setFolderError(null);
    try {
      const result = await agents.checkFolder(path.trim());
      if (result.ok && result.path) {
        const name = result.name ?? result.path.split(/[\\/]/).pop() ?? result.path;
        // Suggest the folder's name unless the user already named the workspace.
        const keepName = current.name.trim() && current.name !== current.folder?.name;
        onChange({ ...current, folderInput: result.path, folder: { path: result.path, name }, name: keepName ? current.name : name });
      } else {
        setFolderError(result.error ?? t.workspace.errors.folderRequired);
      }
    } catch (error) {
      setFolderError(errorMessage(error));
    } finally {
      setChecking(false);
      touch('folder');
    }
  }

  async function choose() {
    if (!picker) return;
    try {
      const selection = await picker.selectDirectory();
      if (selection?.path) await check(selection.path, draft);
    } catch (error) {
      setFolderError(errorMessage(error));
    }
  }

  const folderMessage = folderError ?? errorFor('folder');
  const hermes = availableHermes(runtimes);
  // The profile's default model and, for a local router such as 9Router, the models it offers.
  const [scan, setScan] = useState(0);
  const scanProfile = draft.runtimeId === 'hermes' && hermes ? draft.hermesProfile || 'default' : undefined;
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
  const isHermes = draft.runtimeId === 'hermes';
  // A suggestion from the saved workspace's files; offered as a button, never applied by itself.
  const gateSuggestion = useGateSuggestion(agents, showGate ? draft.id : undefined);
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
    <div className="form-stack">
      <div className="field" {...(picker ? { role: 'group', 'aria-labelledby': `${id}-folder-label` } : {})}>
        {/* A label would rename the picker button, so Desktop uses a group heading instead. */}
        {picker ? <span id={`${id}-folder-label`}>{t.workspace.folder}</span> : <label htmlFor={`${id}-folder`}>{t.workspace.folder}</label>}
        {picker ? (
          <div className="folder-pick">
            <button type="button" id={`${id}-folder`} className="button" disabled={checking} onClick={choose} aria-describedby={`${id}-folder-path`}>
              <Icon name="folder" />{draft.folder ? t.workspace.change : t.workspace.choose}
            </button>
            <code className="folder-path" id={`${id}-folder-path`}>{draft.folder?.path ?? t.workspace.noFolder}</code>
          </div>
        ) : (
          <div className="input-row">
            <input id={`${id}-folder`} type="text" value={draft.folderInput} spellCheck={false} autoComplete="off" placeholder={t.workspace.pathPlaceholder}
              aria-invalid={Boolean(folderMessage)} aria-describedby={`${id}-folder-status`}
              onChange={event => { setFolderError(null); onChange({ ...draft, folderInput: event.target.value, folder: undefined }); }}
              onBlur={() => { if (!draft.folder) void check(draft.folderInput, draft); }}
              onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void check(draft.folderInput, draft); } }} />
            <button type="button" className="button" disabled={checking || !draft.folderInput.trim() || Boolean(draft.folder)} onClick={() => check(draft.folderInput, draft)}>
              {checking ? t.workspace.checking : t.workspace.check}
            </button>
          </div>
        )}
        <small id={`${id}-folder-status`} role="status" className={folderMessage ? 'field-error' : draft.folder && !picker ? 'status ok' : 'muted'}>
          {folderMessage ?? (picker ? null : draft.folder ? <><Icon name="check" />{draft.folder.path}</> : t.workspace.pathHint)}
        </small>
      </div>

      <div className="form-grid">
        <div className="field">
          <label htmlFor={`${id}-name`}>{t.workspace.name}</label>
          <input id={`${id}-name`} type="text" value={draft.name} maxLength={120} autoComplete="off" aria-invalid={Boolean(errorFor('name'))}
            onChange={event => update({ name: event.target.value })} onBlur={() => touch('name')} />
          {errorFor('name') && <small className="field-error">{errorFor('name')}</small>}
        </div>
        {connections && !isHermes && (
          <div className="field">
            <Select
              id={`${id}-connection`}
              label={t.workspace.connection}
              value={draft.connectionId}
              options={connections.map(connection => ({
                value: connection.id,
                label: `${connection.name} · ${connection.model}`
              }))}
              onChange={val => update({ connectionId: val })}
            />
            {errorFor('connection') && <small className="field-error">{errorFor('connection')}</small>}
          </div>
        )}
      </div>

      {connections && (
        <RuntimePicker t={t} legend={t.workspace.runtime} value={draft.runtimeId} offered={RUNTIME_IDS} hermesInstalled={Boolean(hermes)}
          runtimesReady={runtimesReady} rechecking={rechecking} onRecheck={onRecheckRuntimes ? recheckRuntimes : undefined}
          onChange={runtimeId => update({ runtimeId, ...(runtimeId === 'hermes' ? { permissions: hermesPermissions(bypassesHermesApprovals(draft.permissions)) } : {}) })} />
      )}
      {isHermes && (
        <div className="form-stack tight">
          <div className="form-grid">
            <div className="field">
              <Select
                id={`${id}-profile`}
                label={t.workspace.hermesProfile}
                value={draft.hermesProfile}
                options={profiles.map(profile => ({ value: profile, label: profile }))}
                onChange={val => { touch('profile'); update({ hermesProfile: val }); }}
              />
              {errorFor('profile') && <small className="field-error">{errorFor('profile')}</small>}
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

      <div className="form-stack tight">
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
          </>
        )}
      </div>

      {showGate && (
        <div className="form-stack tight workspace-gate" role="group" aria-labelledby={`${id}-gate-heading`}>
          <h3 className="form-heading" id={`${id}-gate-heading`}>{t.workspace.gate.heading}</h3>
          <p className="muted small" id={`${id}-gate-lead`}>{t.workspace.gate.lead}</p>
          <div className="form-grid">
            <div className="field">
              <label htmlFor={`${id}-gate`}>{t.workspace.gate.command}</label>
              <input id={`${id}-gate`} ref={gateInput} type="text" value={draft.gateCommand ?? ''} maxLength={4000} spellCheck={false} autoCapitalize="off" autoComplete="off"
                placeholder={t.workspace.gate.commandPlaceholder} aria-invalid={Boolean(errorFor('gate'))} aria-describedby={`${id}-gate-lead ${id}-gate-detail`}
                onChange={event => update({ gateCommand: event.target.value })} onBlur={() => touch('gate')} />
              {errorFor('gate') && <small className="field-error">{errorFor('gate')}</small>}
            </div>
            <div className="field">
              <label htmlFor={`${id}-gate-timeout`}>{t.workspace.gate.timeout}</label>
              <input id={`${id}-gate-timeout`} type="text" inputMode="numeric" value={draft.gateTimeout ?? ''} maxLength={4} autoComplete="off"
                placeholder={t.workspace.gate.timeoutPlaceholder} aria-invalid={Boolean(errorFor('gateTimeout'))}
                onChange={event => update({ gateTimeout: event.target.value })} onBlur={() => touch('gateTimeout')} />
              {errorFor('gateTimeout') && <small className="field-error">{errorFor('gateTimeout')}</small>}
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
