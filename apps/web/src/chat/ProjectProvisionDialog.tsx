import { type PermissionMode, type WorkspaceCrossAccess } from '@extalia/core';
import {
  PROJECT_SCAFFOLD_TEMPLATES,
  validateProjectFolderName,
  type AgentHostApi,
  type FileSystemCapability,
  type HostState,
  type ProjectProvisionMode,
  type ProjectProvisionPreview,
  type ProjectProvisionReceipt,
  type ProjectScaffoldTemplateId,
  type SessionSummary,
} from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { DirectoryPickerButton } from '../setup/DirectoryPickerButton';
import { Icon } from '../ui/Icon';
import { Segmented } from '../ui/Segmented';
import { Select } from '../ui/Select';
import './projectProvision.css';

const CROSS_ACCESS_MODES: readonly WorkspaceCrossAccess[] = ['read-only', 'isolated'];

export function ProjectProvisionDialog({
  t,
  agents,
  picker,
  state,
  initialMode,
  session,
  connectionId,
  onClose,
  onProvisioned,
}: {
  t: Messages;
  agents: AgentHostApi;
  picker?: FileSystemCapability | undefined;
  state: HostState;
  initialMode: ProjectProvisionMode;
  session?: SessionSummary | undefined;
  connectionId?: string | undefined;
  onClose(): void;
  onProvisioned(receipt: ProjectProvisionReceipt): void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const request = useRef(0);
  const activeRequest = useRef(0);
  const locked = useRef(false);
  const text = t.chat.provision;
  const moveText = t.chat.move;

  const [mode, setMode] = useState<ProjectProvisionMode>(initialMode);
  const [parentPath, setParentPath] = useState('');
  const [folderName, setFolderName] = useState('');
  const [openTargetPath, setOpenTargetPath] = useState('');
  const [workspaceName, setWorkspaceName] = useState('');
  const [selectedConnectionId, setSelectedConnectionId] = useState(
    () => (connectionId && state.connections.some(item => item.id === connectionId) ? connectionId : state.connections[0]?.id) ?? '',
  );
  const [templateId, setTemplateId] = useState<ProjectScaffoldTemplateId>('none');
  const [gitInit, setGitInit] = useState(true);
  const [fileWrite, setFileWrite] = useState<PermissionMode>('ask');
  const [commands, setCommands] = useState<PermissionMode>('ask');
  const [crossWorkspaceAccess, setCrossWorkspaceAccess] = useState<WorkspaceCrossAccess>('read-only');

  const canAttachSession = Boolean(
    session
    && session.workspaceId === null
    && !session.running
    && !session.pendingApprovalId
    && !session.transient
    && session.control !== 'observed'
    && !session.runtime,
  );
  const [attachSession, setAttachSession] = useState(true);
  const [attempted, setAttempted] = useState(false);

  const effectiveConnectionId = state.connections.some(item => item.id === selectedConnectionId)
    ? selectedConnectionId
    : (connectionId && state.connections.some(item => item.id === connectionId) ? connectionId : state.connections[0]?.id ?? '');

  const context = JSON.stringify([
    mode,
    parentPath,
    folderName,
    openTargetPath,
    workspaceName,
    effectiveConnectionId,
    templateId,
    gitInit,
    fileWrite,
    commands,
    crossWorkspaceAccess,
    canAttachSession && attachSession,
    session?.id,
    state.connections.length,
    state.workspaces.length,
  ]);
  const viewContext = useMemo(() => ({ context, agents }), [agents, context]);
  const committed = useRef(viewContext);
  const onProvisionedRef = useRef(onProvisioned);
  useLayoutEffect(() => {
    committed.current = viewContext;
    onProvisionedRef.current = onProvisioned;
  }, [viewContext, onProvisioned]);

  const [reviewed, setReviewed] = useState<{ context: string; owner: { context: string }; preview: ProjectProvisionPreview }>();
  const preview = reviewed?.context === context && reviewed.owner === viewContext ? reviewed.preview : undefined;
  const [confirmed, setConfirmed] = useState(false);
  const [acknowledgeWarnings, setAcknowledgeWarnings] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [receipt, setReceipt] = useState<ProjectProvisionReceipt>();

  useEffect(() => {
    const element = dialog.current;
    const requests = request;
    const active = activeRequest;
    element?.showModal();
    return () => {
      requests.current++;
      active.current++;
      element?.close();
    };
  }, [agents, session?.id]);

  const folderNameError = mode === 'create' && (folderName.length > 0 || attempted)
    ? validateProjectFolderName(folderName)
    : undefined;
  const parentMissing = mode === 'create' && attempted && !parentPath.trim();
  const targetMissing = mode === 'open' && attempted && !openTargetPath.trim();
  const hasConnections = state.connections.length > 0 && Boolean(effectiveConnectionId);
  const supported = Boolean(agents.previewProjectProvision && agents.applyProjectProvision);

  const canReview = supported
    && hasConnections
    && (mode === 'create'
      ? Boolean(parentPath.trim()) && !validateProjectFolderName(folderName)
      : Boolean(openTargetPath.trim()));

  const resetReviewState = () => {
    request.current++;
    setReviewed(undefined);
    setConfirmed(false);
    setAcknowledgeWarnings(false);
    setError(undefined);
    setReceipt(undefined);
  };

  const switchMode = (next: ProjectProvisionMode) => {
    if (locked.current || next === mode) return;
    resetReviewState();
    setAttempted(false);
    setMode(next);
  };

  const review = async () => {
    if (locked.current) return;
    setAttempted(true);
    if (!canReview || !agents.previewProjectProvision) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    locked.current = true;
    const activeId = ++activeRequest.current;
    const revision = ++request.current;
    setBusy(true);
    setError(undefined);
    setReviewed(undefined);
    setConfirmed(false);
    setAcknowledgeWarnings(false);
    setReceipt(undefined);
    try {
      const next = await agents.previewProjectProvision({
        mode,
        ...(mode === 'create'
          ? {
            parentPath: parentPath.trim(),
            folderName,
            templateId,
            gitInit,
          }
          : {
            targetPath: openTargetPath.trim(),
          }),
        ...(workspaceName.trim() ? { workspaceName: workspaceName.trim() } : {}),
        connectionId: effectiveConnectionId,
        permissions: { fileWrite, commands },
        crossWorkspaceAccess,
        ...(canAttachSession && attachSession && session ? { attachSessionId: session.id } : {}),
      });
      if (revision === request.current && owner === committed.current) {
        setReviewed({ context, owner, preview: next });
      }
    } catch (failure) {
      if (revision === request.current && owner === committed.current) {
        setError(errorMessage(failure));
      }
    } finally {
      locked.current = false;
      if (activeId === activeRequest.current) setBusy(false);
    }
  };

  const apply = async () => {
    if (locked.current || !preview || !confirmed || !agents.applyProjectProvision) return;
    if (preview.requiresWarningAcknowledgement && !acknowledgeWarnings) return;
    const owner = viewContext;
    if (owner !== committed.current) return;
    const activeId = ++activeRequest.current;
    const revision = ++request.current;
    locked.current = true;
    setBusy(true);
    setError(undefined);
    setReceipt(undefined);
    try {
      const result = await agents.applyProjectProvision({
        reviewId: preview.reviewId,
        ...(preview.requiresWarningAcknowledgement ? { acknowledgeWarnings } : {}),
      });
      if (revision === request.current) {
        if (owner === committed.current) {
          if (result.ok) {
            onProvisionedRef.current(result);
          } else {
            setError(result.error ?? text.partialFailureNotice);
            setReceipt(result);
            setReviewed(undefined);
            setConfirmed(false);
            setAcknowledgeWarnings(false);
          }
        } else {
          setReviewed(undefined);
          setConfirmed(false);
          setAcknowledgeWarnings(false);
        }
      }
    } catch (failure) {
      if (revision === request.current) {
        if (owner === committed.current) setError(errorMessage(failure));
        setReviewed(undefined);
        setConfirmed(false);
        setAcknowledgeWarnings(false);
      }
    } finally {
      locked.current = false;
      if (activeId === activeRequest.current) setBusy(false);
    }
  };

  const planningWithoutFiles = session?.workspaceId === null || state.workspaces.length === 0;
  const cancelLabel = planningWithoutFiles ? text.continueWithoutFiles : t.common.cancel;
  const applyReady = Boolean(preview && confirmed && (!preview.requiresWarningAcknowledgement || acknowledgeWarnings));

  return (
    <dialog
      ref={dialog}
      className="project-provision-dialog"
      aria-labelledby={titleId}
      onCancel={event => {
        event.preventDefault();
        if (!locked.current) onClose();
      }}
    >
      <header className="project-provision-header">
        <h2 id={titleId}>{text.title}</h2>
        <button type="button" className="icon-button" aria-label={t.common.close} disabled={busy} onClick={onClose}>
          <Icon name="close" />
        </button>
      </header>

      <div
        className="project-provision-tabs"
        role="tablist"
        aria-label={text.title}
        onKeyDown={event => {
          if (busy || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
          event.preventDefault();
          const next: ProjectProvisionMode = event.key === 'Home'
            ? 'create'
            : event.key === 'End'
              ? 'open'
              : mode === 'create' ? 'open' : 'create';
          switchMode(next);
          event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next === 'create' ? 0 : 1]?.focus();
        }}
      >
        <button
          type="button"
          role="tab"
          id={`${titleId}-create-tab`}
          aria-controls={`${titleId}-panel`}
          aria-selected={mode === 'create'}
          tabIndex={mode === 'create' ? 0 : -1}
          disabled={busy}
          onClick={() => switchMode('create')}
        >
          {text.createTab}
        </button>
        <button
          type="button"
          role="tab"
          id={`${titleId}-open-tab`}
          aria-controls={`${titleId}-panel`}
          aria-selected={mode === 'open'}
          tabIndex={mode === 'open' ? 0 : -1}
          disabled={busy}
          onClick={() => switchMode('open')}
        >
          {text.openTab}
        </button>
      </div>

      <section
        role="tabpanel"
        id={`${titleId}-panel`}
        aria-labelledby={mode === 'create' ? `${titleId}-create-tab` : `${titleId}-open-tab`}
        className="project-provision-body"
      >
        {!hasConnections && <p className="form-error" role="alert"><Icon name="alert" />{text.noConnections}</p>}

        {mode === 'create' ? (
          <>
            <div className="field">
              <label htmlFor={`${titleId}-parent`}>{text.parentFolder}</label>
              <div className="project-provision-folder-row">
                <input
                  id={`${titleId}-parent`}
                  type="text"
                  value={parentPath}
                  disabled={busy}
                  placeholder="/Users/<name>/Projects"
                  aria-invalid={parentMissing || undefined}
                  onChange={event => {
                    resetReviewState();
                    setParentPath(event.target.value);
                  }}
                />
                <DirectoryPickerButton
                  t={t}
                  agents={agents}
                  picker={picker}
                  initialPath={parentPath || state.dataDirectory}
                  purpose="project"
                  title={text.chooseParent}
                  label={text.chooseParent}
                  disabled={busy}
                  scopeKey={`provision-parent:${state.profile.id}`}
                  onSelected={selected => {
                    resetReviewState();
                    setParentPath(selected);
                  }}
                />
              </div>
              {parentMissing && <small className="field-error">{text.noFolder}</small>}
            </div>

            <div className="field">
              <label htmlFor={`${titleId}-folder-name`}>{text.folderName}</label>
              <input
                id={`${titleId}-folder-name`}
                type="text"
                value={folderName}
                maxLength={120}
                disabled={busy}
                autoComplete="off"
                placeholder={text.folderNamePlaceholder}
                aria-invalid={Boolean(folderNameError) || undefined}
                aria-describedby={folderNameError ? `${titleId}-folder-name-error` : `${titleId}-folder-name-hint`}
                onChange={event => {
                  resetReviewState();
                  setFolderName(event.target.value);
                }}
              />
              <small id={`${titleId}-folder-name-hint`} className="muted">{text.folderNameHint}</small>
              {folderNameError && (
                <small id={`${titleId}-folder-name-error`} className="field-error" role="alert">
                  {folderNameError}
                </small>
              )}
            </div>
          </>
        ) : (
          <div className="field">
            <label htmlFor={`${titleId}-target`}>{text.projectFolder}</label>
            <div className="project-provision-folder-row">
              <input
                id={`${titleId}-target`}
                type="text"
                value={openTargetPath}
                disabled={busy}
                placeholder="/Users/<name>/Projects/my-app"
                aria-invalid={targetMissing || undefined}
                onChange={event => {
                  resetReviewState();
                  setOpenTargetPath(event.target.value);
                }}
              />
              <DirectoryPickerButton
                t={t}
                agents={agents}
                picker={picker}
                initialPath={openTargetPath || state.dataDirectory}
                purpose="project"
                title={text.chooseProject}
                label={text.chooseProject}
                disabled={busy}
                scopeKey={`provision-open:${state.profile.id}`}
                onSelected={selected => {
                  resetReviewState();
                  setOpenTargetPath(selected);
                }}
              />
            </div>
            {targetMissing && <small className="field-error">{text.noFolder}</small>}
          </div>
        )}

        <div className="form-grid">
          <div className="field">
            <label htmlFor={`${titleId}-workspace-name`}>{text.workspaceName}</label>
            <input
              id={`${titleId}-workspace-name`}
              type="text"
              value={workspaceName}
              maxLength={120}
              disabled={busy}
              autoComplete="off"
              placeholder={text.workspaceNamePlaceholder}
              onChange={event => {
                resetReviewState();
                setWorkspaceName(event.target.value);
              }}
            />
          </div>

          <div className="field">
            <Select
              id={`${titleId}-connection`}
              label={text.connection}
              value={effectiveConnectionId}
              disabled={busy || !hasConnections}
              options={state.connections.map(item => ({
                value: item.id,
                label: `${item.name} · ${item.model}`,
              }))}
              onChange={value => {
                resetReviewState();
                setSelectedConnectionId(value);
              }}
            />
          </div>
        </div>

        {mode === 'create' && (
          <div className="form-stack tight">
            <div className="field">
              <Select
                id={`${titleId}-template`}
                label={text.template}
                value={templateId}
                disabled={busy}
                options={PROJECT_SCAFFOLD_TEMPLATES.map(template => ({
                  value: template.id,
                  label: text.templates[template.id],
                  description: text.templateDescriptions[template.id],
                }))}
                onChange={value => {
                  resetReviewState();
                  setTemplateId(value);
                }}
              />
              <p className="muted small">{text.templateNotice}</p>
            </div>
            <label className="project-provision-check">
              <input
                type="checkbox"
                checked={gitInit}
                disabled={busy}
                onChange={event => {
                  resetReviewState();
                  setGitInit(event.target.checked);
                }}
              />
              <span>{text.gitInit}</span>
            </label>
          </div>
        )}

        <div className="form-stack tight">
          <h3 className="form-heading">{text.permissions}</h3>
          <div className="form-grid">
            <div className="permission">
              <Segmented
                legend={text.fileWrite}
                value={fileWrite}
                options={[
                  { value: 'ask' as PermissionMode, label: moveText.permissions.ask },
                  { value: 'allow' as PermissionMode, label: moveText.permissions.allow },
                ]}
                onChange={value => {
                  resetReviewState();
                  setFileWrite(value);
                }}
              />
            </div>
            <div className="permission">
              <Segmented
                legend={text.commands}
                value={commands}
                options={[
                  { value: 'ask' as PermissionMode, label: moveText.permissions.ask },
                  { value: 'allow' as PermissionMode, label: moveText.permissions.allow },
                ]}
                onChange={value => {
                  resetReviewState();
                  setCommands(value);
                }}
              />
            </div>
          </div>
          <div className="field">
            <Select
              id={`${titleId}-cross-access`}
              label={text.crossAccess}
              value={crossWorkspaceAccess}
              disabled={busy}
              options={CROSS_ACCESS_MODES.map(value => ({
                value,
                label: moveText.policies[value],
                description: t.workspace.crossAccess.descriptions[value],
              }))}
              onChange={value => {
                resetReviewState();
                setCrossWorkspaceAccess(value);
              }}
            />
          </div>
        </div>

        {canAttachSession && (
          <div className="form-stack tight">
            <label className="project-provision-check">
              <input
                type="checkbox"
                checked={attachSession}
                disabled={busy}
                onChange={event => {
                  resetReviewState();
                  setAttachSession(event.target.checked);
                }}
              />
              <span>
                <strong>{text.attachCurrentSession}</strong>
                <br />
                <span className="muted small">{text.attachSessionHint}</span>
              </span>
            </label>
          </div>
        )}

        {preview && (
          <section className="project-provision-review" aria-label={text.reviewHeading}>
            <h3>{text.reviewHeading}</h3>
            <p className="small">
              <strong>{text.targetPathLabel}:</strong> <code>{preview.targetPath}</code>
            </p>
            <div>
              <p className="small"><strong>{text.plannedActionsLabel}</strong></p>
              <ul>
                {preview.plannedActions.map((action, index) => (
                  <li key={`${action.kind}:${action.target}:${index}`}>
                    <span className="badge">{text.actionKinds[action.kind]}</span>
                    <code>{action.target}</code>
                    {action.detail && <span className="muted small">{action.detail}</span>}
                  </li>
                ))}
              </ul>
            </div>
            <p className="small">
              <strong>{text.effectivePermissions}:</strong>{' '}
              {text.fileWrite}: {moveText.permissions[preview.permissions.fileWrite]} ·{' '}
              {text.commands}: {moveText.permissions[preview.permissions.commands]} ·{' '}
              {text.crossAccess}: {moveText.policies[preview.crossWorkspaceAccess]}
            </p>
            {preview.attachSession && (
              <p className="note small">
                <Icon name="chat" />
                <span>{text.attachContextNotice}</span>
              </p>
            )}
            <div className="project-provision-git">
              <p className="small">
                <strong>{text.gitHeading}:</strong>{' '}
                {preview.gitInspection.isGitRepo ? text.gitRepo : text.gitNotRepo}
                {preview.gitInspection.branch && <> · {text.gitBranch(preview.gitInspection.branch)}</>}
                {preview.gitInspection.isGitRepo && (
                  <> · {preview.gitInspection.dirty ? text.gitDirty(preview.gitInspection.dirtyChangeCount) : text.gitClean}</>
                )}
              </p>
              {preview.gitInspection.protectedBranch && (
                <div>
                  <span className="badge warn">
                    <Icon name="alert" />
                    {text.gitProtectedBranch}
                  </span>
                </div>
              )}
            </div>
            {preview.warnings.length > 0 && (
              <div className="project-provision-warnings">
                <p className="small"><strong>{text.warningsHeading}</strong></p>
                {preview.warnings.map((warning, index) => (
                  <p key={`${warning.code}:${index}`} className="warning">
                    <Icon name="alert" />
                    <span>
                      {text.warningCodes[warning.code]}
                      {warning.detail ? ` (${warning.detail})` : ''}
                    </span>
                  </p>
                ))}
              </div>
            )}
            <label className="project-provision-check">
              <input
                type="checkbox"
                checked={confirmed}
                disabled={busy}
                onChange={event => setConfirmed(event.target.checked)}
              />
              <span>{text.confirmLabel}</span>
            </label>
            {preview.requiresWarningAcknowledgement && (
              <label className="project-provision-check">
                <input
                  type="checkbox"
                  checked={acknowledgeWarnings}
                  disabled={busy}
                  onChange={event => setAcknowledgeWarnings(event.target.checked)}
                />
                <span>{text.acknowledgeWarningsLabel}</span>
              </label>
            )}
          </section>
        )}
      </section>

      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}

      {receipt && !receipt.ok && receipt.steps.length > 0 && (
        <section className="project-provision-steps" aria-label={text.partialFailureNotice}>
          <p className="small"><strong>{text.partialFailureNotice}</strong></p>
          <ul>
            {receipt.steps.map((step, index) => (
              <li key={`${step.step}:${index}`}>
                <span className={`badge ${step.status === 'failed' ? 'error' : step.status === 'completed' ? 'ok' : ''}`}>
                  {text.stepStatuses[step.status]}
                </span>
                <span>{text.actionKinds[step.step]}</span>
                {step.target && <code>{step.target}</code>}
                {step.detail && <span className="muted small">{step.detail}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      <footer className="row-actions">
        <button type="button" className="button" disabled={busy} onClick={onClose}>
          {cancelLabel}
        </button>
        {preview ? (
          <>
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                resetReviewState();
              }}
            >
              {text.editSettings}
            </button>
            <button
              type="button"
              className="button primary"
              disabled={busy || !applyReady}
              onClick={() => {
                void apply();
              }}
            >
              {busy ? text.applying : preview.mode === 'create' ? text.applyCreate : text.applyOpen}
            </button>
          </>
        ) : (
          <button
            type="button"
            className="button primary"
            disabled={busy || !canReview}
            onClick={() => {
              void review();
            }}
          >
            {busy ? text.reviewing : text.reviewAction}
          </button>
        )}
      </footer>
    </dialog>
  );
}
