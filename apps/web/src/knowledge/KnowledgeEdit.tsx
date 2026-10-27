import type {
  AgentHostApi, KnowledgeHistory, KnowledgeHistoryEntry, KnowledgeMemoryImport, KnowledgeNoteFile, KnowledgeNoteResult, KnowledgeStatus, KnowledgeWriteResult,
} from '@extalia/platform';
import { useEffect, useState, type KeyboardEvent, type ReactNode } from 'react';
import { Markdown } from '../chat/Markdown';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { useLoad, type Loaded } from '../inspect/useLoad';
import { Icon } from '../ui/Icon';
import {
  editSupport, foldDiff, importOutcomeCounts, importWrites, isEditUnsupportedMessage, isManagedText, lineDiff, newNoteText, notePathFrom, restorableEntry, shortHash,
  splitFrontMatter, type EditSupport, type KnowledgeEditApi, type MemoryImportApi,
} from './noteEditModel';
import type { KnowledgeApi } from './knowledgeModel';

/**
 * Note editing on the Knowledge page (W5 slice 2b): a Markdown editor over the whole file (front matter
 * included) that saves with the hash of its read, a conflict panel when the note changed meanwhile, the
 * note's version history with rollback, new notes, and the legacy memory import (preview, then confirm).
 * Everything here is offered only when `editSupport` says the host and its native core serve it.
 */

export interface EditorDraft {
  mode: 'edit' | 'new';
  path: string;
  /** The read the edit started from (its hash is sent as `expectedSha256`); `null` for a new note. */
  base: KnowledgeNoteFile | null;
  /** The text the editor opened with. */
  initial: string;
  text: string;
}
export interface ConflictState { result: KnowledgeWriteResult; mine: string; compare: boolean; current?: Loaded<KnowledgeNoteFile | null> }

/** What the editor does with a key press: Ctrl/Cmd+S saves, Esc cancels. */
export function editorKeyAction(event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'metaKey' | 'altKey'>): 'save' | 'cancel' | null {
  if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 's') return 'save';
  if (event.key === 'Escape') return 'cancel';
  return null;
}

export const draftDirty = (draft: EditorDraft): boolean => draft.text !== draft.initial;

/** Save a draft over exactly the version it was read from (`null`: the note must not exist yet). */
export function saveDraft(api: Pick<KnowledgeEditApi, 'writeKnowledgeNote'>, draft: EditorDraft): Promise<KnowledgeWriteResult> {
  return api.writeKnowledgeNote({ path: draft.path, content: draft.text, expectedSha256: draft.base?.sha256 ?? null });
}

/** Roll back to `entry`, replacing exactly the version on screen. */
export function rollbackTo(api: Pick<KnowledgeEditApi, 'rollbackKnowledgeNote'>, path: string, entry: KnowledgeHistoryEntry, currentSha: string | undefined): Promise<KnowledgeWriteResult> {
  return api.rollbackKnowledgeNote({ path, toSha256: entry.sha256, expectedSha256: currentSha ?? null });
}

function formatAt(iso: string, language: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : new Intl.DateTimeFormat(language, { dateStyle: 'medium', timeStyle: 'short' }).format(date);
}

function authorLabel(t: Messages, author: string): string {
  const a = t.knowledge.edit.authors;
  if (author === 'user') return a.user;
  if (author === 'external') return a.external;
  return author.startsWith('extalia:') ? a.extalia(author.slice(8)) : author;
}

/** The chip and its explanation; managed notes only. */
export function ManagedChip({ t }: { t: Messages }) {
  const e = t.knowledge.edit;
  return <span className="badge knowledge-managed" title={e.managedHint}><Icon name="spark" />{e.managed}</span>;
}

/** Markdown preview of a draft: front matter folded away, wikilinks shown as plain link text. */
export function DraftPreview({ t, text }: { t: Messages; text: string }) {
  const { frontMatter, body } = splitFrontMatter(text);
  return (
    <div className="knowledge-body knowledge-preview">
      {frontMatter !== undefined && (
        <details className="knowledge-front-matter"><summary>{t.knowledge.edit.frontMatter}</summary><pre>{frontMatter}</pre></details>
      )}
      {body.trim()
        ? <Markdown text={body} wikilink={(link, key) => <span key={key} className="wikilink" data-link="preview">{link.display ?? link.target}</span>} />
        : <p className="muted small">{t.knowledge.edit.previewEmpty}</p>}
    </div>
  );
}

/** Two texts side by side, changed lines marked; long unchanged stretches fold away. */
export function DiffView({ t, before, after }: { t: Messages; before: string; after: string }) {
  const e = t.knowledge.edit;
  const diff = lineDiff(before, after);
  if (!diff.added && !diff.removed) return <p className="muted small">{e.noDifferences}</p>;
  const cell = (side: 'left' | 'right', value: { line: number; text: string } | undefined, kind: string) => (
    <>
      <span className="knowledge-diff-line" aria-hidden="true">{value?.line ?? ''}</span>
      <span className="knowledge-diff-text" data-side={side} data-kind={value ? kind : 'empty'} role="cell">{value?.text ?? ''}</span>
    </>
  );
  return (
    <div className="knowledge-diff-wrap">
      <p className="muted small">{e.diffSummary(diff.added, diff.removed)}{diff.approximate ? ` · ${e.diffApproximate}` : ''}</p>
      <div className="knowledge-diff" role="table" aria-label={`${e.current} / ${e.yours}`}>
        <div className="knowledge-diff-head" role="row"><span role="columnheader">{e.current}</span><span role="columnheader">{e.yours}</span></div>
        {foldDiff(diff.rows).map((row, index) => row.kind === 'gap'
          ? <div key={index} className="knowledge-diff-gap" role="row"><span role="cell">{e.unchangedLines(row.count)}</span></div>
          : <div key={index} className="knowledge-diff-row" role="row" data-kind={row.kind}>{cell('left', row.left, row.kind)}{cell('right', row.right, row.kind)}</div>)}
      </div>
    </div>
  );
}

export interface ConflictPanelProps {
  t: Messages;
  conflict: ConflictState;
  busy?: boolean;
  onOpenCopy: () => void;
  onCompare: (open: boolean) => void;
  onReload: () => void;
}

/** What happened, where the user's version is, and the ways forward. */
export function ConflictPanelView({ t, conflict, busy, onOpenCopy, onCompare, onReload }: ConflictPanelProps) {
  const e = t.knowledge.edit;
  // One editor, form and import panel at a time on the page, so fixed ids (the views stay hook-free for tests).
  const titleId = 'knowledge-conflict-title';
  const reason = conflict.result.conflictReason ?? 'hash_mismatch';
  const current = conflict.current;
  return (
    <section className="knowledge-conflict" role="alert" aria-labelledby={titleId} data-reason={reason}>
      <h3 id={titleId}><Icon name="alert" />{e.conflictTitle}</h3>
      <p>{e.conflictReasons[reason]}</p>
      {conflict.result.conflictPath && <p>{e.conflictSaved} <code className="knowledge-path">{conflict.result.conflictPath}</code></p>}
      <p className="muted small">{e.conflictNext}</p>
      <div className="row-actions">
        {conflict.result.conflictPath && <button type="button" className="button small" disabled={busy} onClick={onOpenCopy}><Icon name="file" />{e.openCopy}</button>}
        <button type="button" className="button small" aria-expanded={conflict.compare} onClick={() => onCompare(!conflict.compare)}><Icon name="eye" />{conflict.compare ? e.hideCompare : e.compare}</button>
        <button type="button" className="button small" disabled={busy} onClick={onReload}><Icon name="refresh" />{e.reload}</button>
      </div>
      {conflict.compare && (current?.error ? <p className="form-error" role="alert"><Icon name="alert" />{current.error}</p>
        : !current || current.loading && !current.value ? <p className="muted small" role="status">{t.common.loading}</p>
          : <DiffView t={t} before={current.value?.body ?? ''} after={conflict.mine} />)}
    </section>
  );
}

export interface NoteEditorProps {
  t: Messages;
  draft: EditorDraft;
  preview: boolean;
  onPreview: (preview: boolean) => void;
  onText: (text: string) => void;
  saving: boolean;
  error?: string | undefined;
  confirmDiscard: boolean;
  onSave: () => void;
  /** Cancel or Esc: closes a clean draft, asks first for a dirty one. */
  onCancel: () => void;
  onDiscard: () => void;
  onKeepEditing: () => void;
  conflict?: ConflictState | undefined;
  conflictBusy?: boolean;
  onOpenCopy: () => void;
  onCompare: (open: boolean) => void;
  onReload: () => void;
}

/** The editor card that replaces the note view while editing. */
export function NoteEditorView(props: NoteEditorProps) {
  const { t, draft, preview, onPreview, onText, saving, error, confirmDiscard, onSave, onCancel, onDiscard, onKeepEditing, conflict } = props;
  const e = t.knowledge.edit;
  const titleId = 'knowledge-editor-title', textId = 'knowledge-editor-text', keysId = 'knowledge-editor-keys';
  const dirty = draftDirty(draft);
  const onKeyDown = (event: KeyboardEvent) => {
    const action = editorKeyAction(event);
    if (!action) return;
    event.preventDefault();
    event.stopPropagation();
    if (action === 'save') { if (!saving) onSave(); return; }
    if (confirmDiscard) onKeepEditing(); else onCancel();
  };
  const name = draft.path.split('/').pop()!.replace(/\.md$/i, '');
  return (
    <article className="card history-viewer knowledge-note knowledge-editor" aria-labelledby={titleId} onKeyDown={onKeyDown} data-mode={draft.mode}>
      <header className="viewer-head">
        <h2 id={titleId} className="viewer-title">{draft.mode === 'new' ? e.newTitle : e.editTitle(name)}</h2>
        <code className="muted small knowledge-path">{draft.path}</code>
      </header>
      <div className="knowledge-chips">
        {isManagedText(draft.text) && <ManagedChip t={t} />}
        {dirty && <span className="badge warn" data-dirty="true">{e.unsaved}</span>}
      </div>
      <p className="muted small">{isManagedText(draft.text) ? e.managedHint : e.notManagedHint}</p>
      {conflict && <ConflictPanelView t={t} conflict={conflict} busy={props.conflictBusy ?? false} onOpenCopy={props.onOpenCopy} onCompare={props.onCompare} onReload={props.onReload} />}
      <div className="segmented knowledge-editor-mode" role="group" aria-label={e.editor}>
        <button type="button" className="chip-button" aria-pressed={!preview} onClick={() => onPreview(false)}>{e.write}</button>
        <button type="button" className="chip-button" aria-pressed={preview} onClick={() => onPreview(true)}>{e.preview}</button>
      </div>
      {preview
        ? <DraftPreview t={t} text={draft.text} />
        : (
          <>
            <label className="visually-hidden" htmlFor={textId}>{e.editor}</label>
            <textarea id={textId} className="knowledge-editor-text" value={draft.text} spellCheck={false} autoFocus aria-describedby={keysId}
              onChange={event => onText(event.target.value)} />
          </>
        )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {confirmDiscard ? (
        <div className="confirm" role="alertdialog" aria-label={e.discardTitle}>
          <p>{e.discardTitle}</p>
          <div className="row-actions">
            <button type="button" className="button small danger" onClick={onDiscard}>{e.discard}</button>
            <button type="button" className="button small" autoFocus onClick={onKeepEditing}>{e.keepEditing}</button>
          </div>
        </div>
      ) : (
        <div className="row-actions knowledge-editor-actions">
          <button type="button" className="button primary small" disabled={saving} onClick={onSave}><Icon name="check" />{saving ? e.saving : e.save}</button>
          <button type="button" className="button small" disabled={saving} onClick={onCancel}>{e.cancel}</button>
          <span id={keysId} className="muted small">{e.keys}</span>
        </div>
      )}
    </article>
  );
}

export interface NewNoteProps {
  t: Messages; path: string; title: string; error?: string | undefined;
  onPath: (path: string) => void; onTitle: (title: string) => void; onCreate: () => void; onCancel: () => void;
}

export function NewNoteView({ t, path, title, error, onPath, onTitle, onCreate, onCancel }: NewNoteProps) {
  const e = t.knowledge.edit;
  const pathId = 'knowledge-new-path', titleId = 'knowledge-new-title', hintId = 'knowledge-new-hint';
  return (
    <form className="card knowledge-new" aria-label={e.newTitle} onSubmit={event => { event.preventDefault(); onCreate(); }}
      onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel(); } }}>
      <h2>{e.newTitle}</h2>
      <div className="knowledge-new-fields">
        <label htmlFor={pathId}>{e.path}</label>
        <input id={pathId} type="text" value={path} placeholder={e.pathPlaceholder} autoFocus aria-describedby={hintId} maxLength={1024} spellCheck={false}
          onChange={event => onPath(event.target.value)} />
        <label htmlFor={titleId}>{e.title}</label>
        <input id={titleId} type="text" value={title} placeholder={e.titlePlaceholder} maxLength={200} onChange={event => onTitle(event.target.value)} />
      </div>
      <p id={hintId} className="muted small">{e.pathHint}</p>
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      <div className="row-actions">
        <button type="submit" className="button primary small"><Icon name="plus" />{e.create}</button>
        <button type="button" className="button small" onClick={onCancel}>{e.cancel}</button>
      </div>
    </form>
  );
}

export interface HistoryViewProps {
  t: Messages;
  language: string;
  history: Loaded<KnowledgeHistory>;
  /** Hash of the version on screen. */
  currentSha?: string | undefined;
  selected?: string | undefined;
  onSelect: (sha: string) => void;
  confirming?: KnowledgeHistoryEntry | undefined;
  onRollback: (entry: KnowledgeHistoryEntry) => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  busy: boolean;
  error?: string | undefined;
}

/** The journal, a version's details, and rollback with a confirmation that names both hashes. */
export function HistoryView(props: HistoryViewProps) {
  const { t, language, history, currentSha, selected, onSelect, confirming, onRollback, onConfirm, onCancelConfirm, busy, error } = props;
  const e = t.knowledge.edit;
  const entries = history.value?.entries ?? [];
  const chosen = entries.find(entry => entry.sha256 === selected);
  return (
    <section className="knowledge-history" aria-label={e.historyTitle}>
      <h3>{e.historyTitle}</h3>
      {history.error ? <p className="form-error" role="alert"><Icon name="alert" />{history.error}</p>
        : !history.value ? <p className="muted small" role="status">{e.historyLoading}</p>
          : entries.length === 0 ? <p className="muted small">{e.historyEmpty}</p>
            : (
              <ol className="knowledge-history-list">
                {entries.map((entry, index) => (
                  <li key={`${entry.sha256}-${index}`}>
                    <button type="button" className="knowledge-version" aria-pressed={entry.sha256 === selected} data-kind={entry.kind} onClick={() => onSelect(entry.sha256)}>
                      <span className="badge subtle">{e.kinds[entry.kind]}</span>
                      <span className="knowledge-version-when">{formatAt(entry.at, language)}</span>
                      <span className="muted small">{authorLabel(t, entry.author)}</span>
                      <code className="small">{shortHash(entry.sha256)}</code>
                      {entry.sha256 === currentSha && entry.kind !== 'conflict' && <span className="badge ok">{e.currentVersion}</span>}
                    </button>
                  </li>
                ))}
              </ol>
            )}
      {chosen && (
        <div className="knowledge-version-detail">
          <dl className="history-meta">
            <div><dt>{chosen.kind === 'conflict' ? e.conflictCopy : e.version}</dt><dd><code>{chosen.sha256}</code></dd></div>
            {chosen.previousSha256 && <div><dt>{e.previous}</dt><dd><code>{chosen.previousSha256}</code></dd></div>}
            {chosen.conflictPath && <div><dt>{e.conflictCopy}</dt><dd><code>{chosen.conflictPath}</code></dd></div>}
          </dl>
          <p className="muted small">{e.versionHint}</p>
          {confirming ? (
            <div className="confirm" role="alertdialog" aria-label={e.rollbackTitle}>
              <p><strong>{e.rollbackTitle}</strong> {e.rollbackBody}</p>
              <dl className="history-meta knowledge-rollback-hashes">
                <div><dt>{e.rollbackFrom}</dt><dd><code data-hash="from">{currentSha ?? '—'}</code></dd></div>
                <div><dt>{e.rollbackTo}</dt><dd><code data-hash="to">{confirming.sha256}</code></dd></div>
              </dl>
              <div className="row-actions">
                <button type="button" className="button small danger" disabled={busy} onClick={onConfirm}>{busy ? e.rollingBack : e.confirmRollback}</button>
                <button type="button" className="button small" autoFocus disabled={busy} onClick={onCancelConfirm}>{e.cancel}</button>
              </div>
            </div>
          ) : restorableEntry(chosen) && chosen.sha256 !== currentSha && (
            <button type="button" className="button small" onClick={() => onRollback(chosen)}><Icon name="refresh" />{e.rollback}</button>
          )}
          {chosen.kind === 'conflict' && chosen.previousSha256 && chosen.previousSha256 !== currentSha && !confirming && (
            <button type="button" className="button small" onClick={() => onRollback({ ...chosen, kind: 'external', sha256: chosen.previousSha256! })}><Icon name="refresh" />{e.rollback}</button>
          )}
        </div>
      )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
    </section>
  );
}

export interface ImportViewProps {
  t: Messages;
  workspaces: Loaded<{ id: string; name: string }[]>;
  workspaceId: string;
  onWorkspace: (id: string) => void;
  /** The dry run (preview), then the confirmed import's result. */
  preview: KnowledgeMemoryImport | null;
  done: KnowledgeMemoryImport | null;
  busy: 'preview' | 'import' | null;
  error?: string | undefined;
  onPreview: () => void;
  onImport: () => void;
  onClose: () => void;
}

function ImportList({ t, result }: { t: Messages; result: KnowledgeMemoryImport }) {
  const e = t.knowledge.edit;
  return (
    <>
      <p className="knowledge-chips">{importOutcomeCounts(result).map(([outcome, count]) => <span key={outcome} className="badge subtle" data-outcome={outcome}>{e.outcomes[outcome]} · {count}</span>)}</p>
      <ul className="knowledge-import-list">
        {result.notes.map(note => (
          <li key={note.name} data-outcome={note.outcome}>
            <span className="knowledge-import-name">{note.name}</span>
            <span className={`badge ${note.outcome === 'created' || note.outcome === 'updated' ? 'ok' : note.outcome === 'skipped' || note.outcome.includes('conflict') ? 'warn' : 'subtle'}`}>{e.outcomes[note.outcome]}</span>
            {note.masked > 0 && <span className="badge warn"><Icon name="key" />{e.masked(note.masked)}</span>}
            {note.vaultPath && <code className="muted small knowledge-path">{note.vaultPath}</code>}
          </li>
        ))}
      </ul>
      {result.truncated && <p className="muted small">{e.importTruncated}</p>}
    </>
  );
}

/** Choose a workspace, preview (dry run), then confirm. */
export function MemoryImportView({ t, workspaces, workspaceId, onWorkspace, preview, done, busy, error, onPreview, onImport, onClose }: ImportViewProps) {
  const e = t.knowledge.edit;
  const selectId = 'knowledge-import-workspace', titleId = 'knowledge-import-title';
  const list = workspaces.value ?? [];
  const writes = preview ? importWrites(preview) : 0;
  return (
    <section className="card knowledge-import" aria-labelledby={titleId}>
      <div className="knowledge-graph-head">
        <h2 id={titleId}>{e.importTitle}</h2>
        <button type="button" className="button small" onClick={onClose}>{e.close}</button>
      </div>
      <p className="muted small">{e.importLead}</p>
      {workspaces.error ? <p className="form-error" role="alert">{workspaces.error}</p>
        : !workspaces.value ? <p className="muted small" role="status">{t.common.loading}</p>
          : list.length === 0 ? <p className="note">{e.noWorkspaces}</p>
            : (
              <div className="knowledge-import-pick">
                <label htmlFor={selectId}>{e.workspace}</label>
                <select id={selectId} value={workspaceId} disabled={busy !== null} onChange={event => onWorkspace(event.target.value)}>
                  {list.map(workspace => <option key={workspace.id} value={workspace.id}>{workspace.name}</option>)}
                </select>
                <button type="button" className="button small" disabled={busy !== null || !workspaceId} onClick={onPreview}><Icon name="eye" />{busy === 'preview' ? e.previewing : e.previewImport}</button>
              </div>
            )}
      {error && <p className="form-error" role="alert"><Icon name="alert" />{error}</p>}
      {done ? (
        <div className="knowledge-import-result" role="status">
          <h3><Icon name="check" />{e.importDone}</h3>
          <ImportList t={t} result={done} />
        </div>
      ) : preview && (
        <div className="knowledge-import-preview">
          {preview.notes.length === 0 ? <p className="muted small">{e.importEmpty}</p> : <ImportList t={t} result={preview} />}
          {preview.notes.length > 0 && writes === 0 && <p className="muted small">{e.importNothing}</p>}
          {writes > 0 && (
            <div className="row-actions">
              <button type="button" className="button primary small" disabled={busy !== null} onClick={onImport}><Icon name="download" />{busy === 'import' ? e.importing : e.importConfirm(writes)}</button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}

/** The edit slots of the Knowledge view. */
export interface KnowledgeEditSlots {
  /** After the status bar: New note, Import memory notes, their panels, and the toast. */
  toolbar?: ReactNode;
  /** In the note view after its metadata: the managed chip, Edit, History. */
  noteTools?: ReactNode;
  /** Replaces the note view while editing or creating a note. */
  editor?: ReactNode;
}

export interface KnowledgeEditingOptions {
  t: Messages;
  language: string;
  agents: AgentHostApi;
  status: Loaded<KnowledgeStatus>;
  onStatus: (status: KnowledgeStatus) => void;
  note: Loaded<KnowledgeNoteResult | null>;
  /** Open a note by node id (the page's selection). */
  open: (nodeId: string) => void;
  close: () => void;
}

type Toast = { id: number; text: string };

/**
 * The page's editing state. Returns the slots and the page's `onOpen`/`onClose`, which ask before an
 * unsaved draft is left.
 */
export function useKnowledgeEditing({ t, language, agents, status, onStatus, note, open, close }: KnowledgeEditingOptions): KnowledgeEditSlots & { support: EditSupport; onOpen: (nodeId: string) => void; onClose: () => void } {
  const e = t.knowledge.edit;
  const support = editSupport(agents, status.value);
  const api = agents as AgentHostApi & KnowledgeApi & KnowledgeEditApi & MemoryImportApi;
  const generation = String(status.value?.generation ?? 0);
  const [version, setVersion] = useState(0);
  const path = note.value?.node.path;
  const file = useLoad(support.notes && path ? `${generation}\n${path}` : null, version, () => api.readKnowledgeNote(path!));
  const fileUnsupported = Boolean(file.error && isEditUnsupportedMessage(file.error));

  const [draft, setDraft] = useState<EditorDraft | null>(null);
  const [preview, setPreview] = useState(false);
  const [saving, setSaving] = useState(false);
  const [editError, setEditError] = useState<string>();
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [pending, setPending] = useState<{ action: 'open'; nodeId: string } | { action: 'close' } | null>(null);
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [conflictBusy, setConflictBusy] = useState(false);
  const [opening, setOpening] = useState(false);
  const [toast, setToast] = useState<Toast | null>(null);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [selectedVersion, setSelectedVersion] = useState<string>();
  const [confirming, setConfirming] = useState<KnowledgeHistoryEntry>();
  const [rollbackBusy, setRollbackBusy] = useState(false);
  const [rollbackError, setRollbackError] = useState<string>();
  const [newForm, setNewForm] = useState<{ path: string; title: string; error?: string } | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [workspaceId, setWorkspaceId] = useState('');
  const [importPreview, setImportPreview] = useState<KnowledgeMemoryImport | null>(null);
  const [importDone, setImportDone] = useState<KnowledgeMemoryImport | null>(null);
  const [importBusy, setImportBusy] = useState<'preview' | 'import' | null>(null);
  const [importError, setImportError] = useState<string>();
  const history = useLoad(support.notes && historyOpen && path ? `${generation}\n${path}` : null, version, () => api.knowledgeHistory(path!));
  const workspaces = useLoad(importOpen ? 'workspaces' : null, 0, async () => (await agents.getState()).workspaces.map(item => ({ id: item.id, name: item.name })));

  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(timer);
  }, [toast]);

  const say = (text: string) => setToast({ id: Date.now(), text });
  /** After a change: the daemon re-indexed, so a fresh status (new generation) reloads what is on screen. */
  const refresh = async () => {
    setVersion(value => value + 1);
    try { onStatus(await api.knowledgeStatus()); } catch { /* The page keeps its status; Sync now still works. */ }
  };
  const closeEditor = () => {
    setDraft(null); setConflict(null); setEditError(undefined); setConfirmDiscard(false); setPreview(false); setPending(null);
  };
  /** Leave the draft, asking first when it has unsaved changes. */
  const leave = (next: { action: 'open'; nodeId: string } | { action: 'close' }) => {
    if (draft && draftDirty(draft)) { setPending(next); setConfirmDiscard(true); return; }
    closeEditor();
    if (next.action === 'open') open(next.nodeId); else close();
  };

  const startEdit = async () => {
    if (!path) return;
    setOpening(true); setEditError(undefined); setNewForm(null);
    try {
      const fresh = await api.readKnowledgeNote(path);
      if (!fresh) { setEditError(t.knowledge.notFound); return; }
      if (fresh.truncated) { setEditError(e.tooLarge); return; }
      setDraft({ mode: 'edit', path, base: fresh, initial: fresh.body, text: fresh.body });
      setConflict(null); setPreview(false);
    } catch (failure) { setEditError(errorMessage(failure)); } finally { setOpening(false); }
  };

  const save = async () => {
    if (!draft || saving) return;
    setSaving(true); setEditError(undefined);
    try {
      const result = await saveDraft(api, draft);
      if (result.outcome === 'conflict') {
        setConflict({ result, mine: draft.text, compare: false });
        await refresh();
        return;
      }
      const created = draft.mode === 'new';
      closeEditor();
      say(result.outcome === 'unchanged' ? e.unchanged : created ? e.created(result.path) : e.saved(result.path));
      await refresh();
      if (created) {
        const found = await api.knowledgeNode({ path: result.path }).catch(() => null);
        if (found) open(found.node.nodeId);
      }
    } catch (failure) { setEditError(errorMessage(failure)); } finally { setSaving(false); }
  };

  const compare = async (show: boolean) => {
    if (!conflict) return;
    if (!show) { setConflict({ ...conflict, compare: false }); return; }
    setConflict({ ...conflict, compare: true, current: { loading: true } });
    try {
      const value = await api.readKnowledgeNote(conflict.result.path);
      setConflict(state => state && { ...state, current: { value, loading: false } });
    } catch (failure) { setConflict(state => state && { ...state, current: { error: errorMessage(failure), loading: false } }); }
  };

  const reload = async () => {
    if (!draft) return;
    setConflictBusy(true);
    try {
      const fresh = await api.readKnowledgeNote(draft.path);
      if (fresh?.truncated) { setEditError(e.tooLarge); return; }
      // The user's text is safe in the conflict copy; the editor now starts from the note as it is.
      setDraft({ mode: fresh ? 'edit' : 'new', path: draft.path, base: fresh, initial: fresh?.body ?? '', text: fresh?.body ?? '' });
      setConflict(null); setEditError(undefined);
    } catch (failure) { setEditError(errorMessage(failure)); } finally { setConflictBusy(false); }
  };

  const openCopy = async () => {
    const copy = conflict?.result.conflictPath;
    if (!copy) return;
    setConflictBusy(true);
    try {
      const found = await api.knowledgeNode({ path: copy });
      if (!found) { setEditError(e.copyNotIndexed); return; }
      closeEditor();
      open(found.node.nodeId);
    } catch (failure) { setEditError(errorMessage(failure)); } finally { setConflictBusy(false); }
  };

  const rollback = async () => {
    if (!confirming || !path) return;
    setRollbackBusy(true); setRollbackError(undefined);
    try {
      const result = await rollbackTo(api, path, confirming, file.value?.sha256);
      setConfirming(undefined);
      if (result.outcome === 'conflict') setRollbackError(e.rollbackConflict(result.conflictPath ?? ''));
      else { say(result.outcome === 'unchanged' ? e.unchanged : e.rolledBack(shortHash(confirming.sha256))); setSelectedVersion(undefined); }
      await refresh();
    } catch (failure) { setRollbackError(errorMessage(failure)); } finally { setRollbackBusy(false); }
  };

  const createNote = () => {
    if (!newForm) return;
    let notePath: string;
    try { notePath = notePathFrom(newForm.path); } catch (failure) { setNewForm({ ...newForm, error: errorMessage(failure) }); return; }
    const text = newNoteText(newForm.title, notePath);
    setNewForm(null);
    setDraft({ mode: 'new', path: notePath, base: null, initial: text, text });
    setConflict(null); setPreview(false); setEditError(undefined);
  };

  const runImport = async (dryRun: boolean) => {
    const target = workspaceId || workspaces.value?.[0]?.id;
    if (!target) return;
    setImportBusy(dryRun ? 'preview' : 'import'); setImportError(undefined);
    try {
      const result = await api.importMemoryNotes({ workspaceId: target, dryRun });
      if (dryRun) { setImportPreview(result); setImportDone(null); } else {
        setImportDone(result); setImportPreview(null);
        say(e.imported(importWrites(result)));
        await refresh();
      }
    } catch (failure) { setImportError(errorMessage(failure)); } finally { setImportBusy(null); }
  };

  const toastRegion = <div className="toast-region knowledge-toast" role="status" aria-live="polite">{toast && <p key={toast.id} className="toast"><Icon name="check" />{toast.text}</p>}</div>;
  const anyTools = support.notes || support.memoryImport;
  const toolbar = (
    <>
      {anyTools && (
        <div className="knowledge-edit-bar" role="group" aria-label={e.edit}>
          {support.notes && <button type="button" className="button small" aria-expanded={Boolean(newForm)} disabled={Boolean(draft)} onClick={() => setNewForm(newForm ? null : { path: '', title: '' })}><Icon name="plus" />{e.newNote}</button>}
          {support.memoryImport && <button type="button" className="button small" aria-expanded={importOpen} onClick={() => { setImportOpen(!importOpen); setImportPreview(null); setImportDone(null); setImportError(undefined); }}><Icon name="download" />{e.importMemory}</button>}
        </div>
      )}
      {newForm && !draft && (
        <NewNoteView t={t} path={newForm.path} title={newForm.title} error={newForm.error} onPath={value => setNewForm({ ...newForm, path: value, error: undefined })}
          onTitle={value => setNewForm({ ...newForm, title: value })} onCreate={createNote} onCancel={() => setNewForm(null)} />
      )}
      {importOpen && support.memoryImport && (
        <MemoryImportView t={t} workspaces={workspaces} workspaceId={workspaceId || workspaces.value?.[0]?.id || ''} onWorkspace={id => { setWorkspaceId(id); setImportPreview(null); setImportDone(null); }}
          preview={importPreview} done={importDone} busy={importBusy} error={importError} onPreview={() => void runImport(true)} onImport={() => void runImport(false)}
          onClose={() => setImportOpen(false)} />
      )}
      {toastRegion}
    </>
  );

  const noteTools = support.notes && note.value && !fileUnsupported ? (
    <div className="knowledge-edit-tools">
      <div className="row-actions">
        {file.value?.managed && <ManagedChip t={t} />}
        <button type="button" className="button small" disabled={opening || Boolean(draft)} onClick={() => void startEdit()}><Icon name="edit" />{opening ? e.loading : e.edit}</button>
        <button type="button" className="button small" aria-expanded={historyOpen} onClick={() => { setHistoryOpen(!historyOpen); setConfirming(undefined); setRollbackError(undefined); }}>
          <Icon name="logs" />{historyOpen ? e.hideHistory : e.history}
        </button>
      </div>
      {file.value?.managed && <p className="muted small">{e.managedHint}</p>}
      {!draft && editError && <p className="form-error" role="alert"><Icon name="alert" />{editError}</p>}
      {historyOpen && (
        <HistoryView t={t} language={language} history={history} currentSha={file.value?.sha256} selected={selectedVersion} onSelect={sha => { setSelectedVersion(sha); setConfirming(undefined); }}
          confirming={confirming} onRollback={entry => setConfirming(entry)} onConfirm={() => void rollback()} onCancelConfirm={() => setConfirming(undefined)} busy={rollbackBusy} error={rollbackError} />
      )}
    </div>
  ) : null;

  const editor = draft ? (
    <NoteEditorView t={t} draft={draft} preview={preview} onPreview={setPreview} onText={text => setDraft({ ...draft, text })} saving={saving} error={editError}
      confirmDiscard={confirmDiscard} onSave={() => void save()}
      onCancel={() => { if (draftDirty(draft)) { setPending(null); setConfirmDiscard(true); } else closeEditor(); }}
      onDiscard={() => {
        const next = pending;
        closeEditor();
        if (next?.action === 'open') open(next.nodeId); else if (next?.action === 'close') close();
      }}
      onKeepEditing={() => { setConfirmDiscard(false); setPending(null); }}
      conflict={conflict ?? undefined} conflictBusy={conflictBusy} onOpenCopy={() => void openCopy()} onCompare={show => void compare(show)} onReload={() => void reload()} />
  ) : undefined;

  return {
    support, toolbar, noteTools, ...(editor ? { editor } : {}),
    onOpen: nodeId => (draft ? leave({ action: 'open', nodeId }) : open(nodeId)),
    onClose: () => (draft ? leave({ action: 'close' }) : close()),
  };
}
