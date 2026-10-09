import type { PermissionMode } from '@extalia/core';
import type { AgentHostApi, ConnectionView, FileSystemCapability } from '@extalia/platform';
import { useId, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { validateWorkspace, type WorkspaceDraft, type WorkspaceField } from './validation';

/**
 * Workspace editor used by the wizard and Settings. Desktop picks folders with
 * the native dialog; the Bridge cannot, so the user types a path the host checks.
 */
export function WorkspaceForm({ t, agents, picker, draft, onChange, connections, showAllErrors = false }: {
  t: Messages;
  agents: AgentHostApi;
  /** Native folder picker; only used when it reveals full paths (Desktop). */
  picker?: FileSystemCapability;
  draft: WorkspaceDraft;
  onChange: (draft: WorkspaceDraft) => void;
  /** Offer a connection choice; the wizard fixes it to the one just created. */
  connections?: ConnectionView[];
  showAllErrors?: boolean;
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
        {connections && (
          <div className="field">
            <label htmlFor={`${id}-connection`}>{t.workspace.connection}</label>
            <select id={`${id}-connection`} value={draft.connectionId} onChange={event => update({ connectionId: event.target.value })}>
              {!draft.connectionId && <option value="">—</option>}
              {connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.model}</option>)}
            </select>
            {errorFor('connection') && <small className="field-error">{errorFor('connection')}</small>}
          </div>
        )}
      </div>

      <div className="form-stack tight">
        <h3 className="form-heading">{t.workspace.permissions}</h3>
        <p className="muted small">{t.workspace.permissionsLead}</p>
        <div className="form-grid">
          {permission('fileWrite')}
          {permission('commands')}
        </div>
      </div>
    </div>
  );
}
