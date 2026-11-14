import type { Workspace } from '@extalia/core';
import { sessionBrowserProject, type AgentHostApi, type HostState, type SessionSummary } from '@extalia/platform';
import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { Icon } from '../ui/Icon';
import { SessionBrowserIndicators } from '../sessions/SessionBrowser';
import { SessionBrowserExpansion, sessionBrowserNodeKey } from '../sessions/sessionBrowserState';
import { TREE_FOLDER_SELECTOR, TREE_ROW_SELECTOR, useTreeReorderMotion } from '../sessions/treeReorderMotion';
import { SessionList } from './SessionList';
import { NATIVE_SESSION_DRAG_TYPE, nativeSession, nativeSessionDrop, parseNativeSessionDrag, registeredSessionFolders, type NativeSessionDrag } from './nativeSessionTreeModel';
import type { ChatSelection } from './selection';
import './nativeSessionTree.css';

type Props = {
  t: Messages; language: string; agents: AgentHostApi; state: HostState; workspaceId: string; activeId?: string; locked?: boolean;
  onSelect: (selection: ChatSelection) => void; onState: (state: HostState) => void;
  onSettings: (session: SessionSummary) => void; onRename: (id: string, title: string) => Promise<void>; onDelete: (id: string) => Promise<void>;
};

/** Native folders are registered workspace metadata, never inferred grants. */
export function NativeSessionTree(props: Props) {
  const source = JSON.stringify([props.state.profile?.id, props.state.dataDirectory, props.state.storage?.dataDirectory]);
  const [scope, setScope] = useState(() => ({ agents: props.agents, source, revision: 0, memory: new SessionBrowserExpansion() }));
  if (scope.agents !== props.agents || scope.source !== source) setScope({ agents: props.agents, source, revision: scope.revision + 1, memory: new SessionBrowserExpansion() });
  return <NativeTreeContents key={scope.revision} {...props} memory={scope.memory} />;
}

function useExpanded(memory: SessionBrowserExpansion, key: string, initial: boolean, slot?: string) {
  const [open, update] = useState(() => memory.read(key, initial, slot));
  return [open, (value: boolean) => { memory.set(key, value); update(value); }] as const;
}

function NativeTreeContents({ memory, ...props }: Props & { memory: SessionBrowserExpansion }) {
  const { t, state, agents, locked, onState } = props;
  const drag = useRef<NativeSessionDrag | undefined>(undefined);
  const admitting = useRef(false), alive = useRef(true);
  const tree = useRef<HTMLDivElement>(null);
  const [pending, setPending] = useState(false), [error, setError] = useState<string>();
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const clearDrag = () => {
    drag.current = undefined;
    tree.current?.querySelectorAll<HTMLElement>('[data-drop-target]').forEach(node => { delete node.dataset.dropTarget; });
  };
  const candidate = (workspaceId: string, path: string) => !locked && !admitting.current && agents.setSessionProjectRoot
    ? nativeSessionDrop(state.sessions, state.workspaces, drag.current, workspaceId, path) : undefined;
  const rowDrag = (session: SessionSummary) => nativeSession(session) && !session.transient && agents.setSessionProjectRoot ? {
    draggable: !locked && !pending && !session.running && !session.pendingApprovalId,
    onDragStart: (event: DragEvent<HTMLLIElement>) => {
      const current = state.sessions.find(row => row.id === session.id);
      if (!current || locked || admitting.current || current.running || current.pendingApprovalId || !nativeSession(current) || current.transient) { event.preventDefault(); return; }
      drag.current = { sessionId: current.id, workspaceId: current.workspaceId };
      event.dataTransfer.setData(NATIVE_SESSION_DRAG_TYPE, JSON.stringify(drag.current));
      event.dataTransfer.effectAllowed = 'move';
      setError(undefined);
    },
    onDragEnd: clearDrag,
  } : undefined;
  const dropProps = (workspaceId: string, path: string) => ({
    onDragOver: (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(NATIVE_SESSION_DRAG_TYPE) || !candidate(workspaceId, path)) return;
      event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move';
      event.currentTarget.dataset.dropTarget = 'true';
    },
    onDragLeave: (event: DragEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) delete event.currentTarget.dataset.dropTarget;
    },
    onDrop: async (event: DragEvent<HTMLDivElement>) => {
      if (!event.dataTransfer.types.includes(NATIVE_SESSION_DRAG_TYPE)) return;
      event.preventDefault(); event.stopPropagation();
      const payload = parseNativeSessionDrag(event.dataTransfer.getData(NATIVE_SESSION_DRAG_TYPE));
      const source = candidate(workspaceId, path);
      const ours = payload && payload.sessionId === drag.current?.sessionId && payload.workspaceId === drag.current?.workspaceId;
      clearDrag();
      if (!ours || !source || !agents.setSessionProjectRoot) return;
      admitting.current = true; setPending(true); setError(undefined);
      try {
        const next = await agents.setSessionProjectRoot(source.id, { workspaceId, projectLocation: path });
        if (alive.current) onState(next);
      } catch (failure) { if (alive.current) setError(errorMessage(failure)); }
      finally { admitting.current = false; if (alive.current) setPending(false); }
    },
  });
  return <div ref={tree} className="session-browser native-session-tree" aria-busy={pending || undefined}>
    <p className="muted small native-tree-hint">{agents.setSessionProjectRoot ? t.chat.sessionSettings.dragHint : t.chat.sessionSettings.unavailable}</p>
    {pending && <p className="small" role="status"><span className="session-browser-spinner spin" /> {t.chat.sessionSettings.moving}</p>}
    {error && <p className="form-error" role="alert">{error}</p>}
    <div className="session-browser-harness-list">{state.workspaces.filter(workspace => workspace.mode !== 'observe').map(workspace =>
      <NativeWorkspace key={workspace.id} {...props} workspace={workspace} memory={memory} pending={pending} rowDrag={rowDrag} dropProps={dropProps} />)}</div>
  </div>;
}

type TreeHandlers = {
  memory: SessionBrowserExpansion; pending: boolean;
  rowDrag: (session: SessionSummary) => { draggable: boolean; onDragStart: (event: DragEvent<HTMLLIElement>) => void; onDragEnd: () => void } | undefined;
  dropProps: (workspaceId: string, path: string) => { onDragOver: (event: DragEvent<HTMLDivElement>) => void; onDragLeave: (event: DragEvent<HTMLDivElement>) => void; onDrop: (event: DragEvent<HTMLDivElement>) => Promise<void> };
};
function NativeWorkspace({ workspace, memory, ...props }: Props & TreeHandlers & { workspace: Workspace }) {
  const { t, state, activeId, workspaceId, onSelect } = props;
  const [open, setOpen] = useExpanded(memory, sessionBrowserNodeKey('native-workspace', workspace.id), workspace.id === workspaceId);
  const folders = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(folders, TREE_FOLDER_SELECTOR);
  const rows = useMemo(() => state.sessions.filter(session => session.workspaceId === workspace.id).sort((a, b) => b.lastActiveAt.localeCompare(a.lastActiveAt) || a.id.localeCompare(b.id)), [state.sessions, workspace.id]);
  const groups = useMemo(() => registeredSessionFolders(workspace).map((path, index) => ({ path, index, rows: rows.filter(session => nativeSession(session) && (session.projectLocation ?? workspace.projectLocation) === path) }))
    .sort((a, b) => (b.rows[0]?.lastActiveAt ?? '').localeCompare(a.rows[0]?.lastActiveAt ?? '') || a.index - b.index), [workspace, rows]);
  const registered = new Set(groups.map(group => group.path));
  const others = rows.filter(session => !nativeSession(session) || !registered.has(session.projectLocation ?? workspace.projectLocation ?? ''));
  const chosen = rows.find(row => row.id === activeId);
  const firstOpen = chosen && nativeSession(chosen) ? chosen.projectLocation ?? workspace.projectLocation : workspace.projectLocation;
  return <article className={`session-browser-harness native-workspace${workspace.id === workspaceId ? ' is-selected' : ''}`}>
    <div className="native-workspace-heading">
      <button type="button" className="session-browser-harness-toggle" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Icon name="chevron" /><Icon name="folder" /><span>{workspace.name}</span><SessionBrowserIndicators t={t} running={rows.some(row => row.running)} /><span className="badge">{rows.length}</span>
      </button>
      <button type="button" className="icon-button small" aria-label={`${t.chat.newSession}: ${workspace.name}`} title={t.chat.newSession} disabled={props.pending || props.locked} onClick={() => onSelect({ workspaceId: workspace.id, sessionId: null })}><Icon name="plus" /></button>
    </div>
    {open && <div className="session-browser-harness-children"><div ref={folders} className="session-browser-section-body">
      {groups.map(group => <NativeFolder key={group.path} {...props} workspace={workspace} memory={memory} path={group.path} rows={group.rows} initiallyOpen={group.path === firstOpen} duplicateName={groups.some(other => other.path !== group.path && sessionBrowserProject(other.path)?.name === sessionBrowserProject(group.path)?.name)} />)}
      {others.length > 0 && <NativeFolder {...props} workspace={workspace} memory={memory} rows={others} initiallyOpen path={undefined} />}
    </div></div>}
  </article>;
}

function NativeFolder({ workspace, memory, path, rows, initiallyOpen, duplicateName, ...props }: Props & TreeHandlers & { workspace: Workspace; path?: string; rows: SessionSummary[]; initiallyOpen: boolean; duplicateName?: boolean }) {
  const { t, language, agents, onSettings, onRename, onDelete, onSelect, activeId, pending, locked, rowDrag, dropProps } = props;
  const [open, setOpen] = useExpanded(memory, sessionBrowserNodeKey('native-folder', workspace.id, path ?? 'other'), initiallyOpen, path ? sessionBrowserNodeKey('initial-native-folder', workspace.id) : undefined);
  const [limit, setLimit] = useState(12);
  const list = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(list, TREE_ROW_SELECTOR);
  const label = path ? sessionBrowserProject(path)?.name ?? path : t.chat.sessionSettings.other;
  return <div className="session-browser-folder native-session-folder" {...(path ? dropProps(workspace.id, path) : {})}>
    <button type="button" className="session-browser-folder-toggle" aria-expanded={open} title={path} onClick={() => setOpen(!open)}>
      <Icon name="chevron" /><Icon name={path ? 'folder' : 'chat'} /><span>{label}{duplicateName && <small className="session-browser-folder-path">{path}</small>}</span><SessionBrowserIndicators t={t} running={rows.some(row => row.running)} /><small>{rows.length}</small>
    </button>
    {open && <div ref={list} className="session-browser-rows"><SessionList t={t} language={language} sessions={rows.slice(0, limit)} activeId={activeId} compactIndicators showSource
      onSelect={id => onSelect({ workspaceId: workspace.id, sessionId: id })} onRename={onRename} onDelete={onDelete} actionsDisabled={pending || locked}
      onSettings={agents.setSessionProjectRoot || (agents.previewSessionMove && agents.moveSession) ? onSettings : undefined} rowDrag={rowDrag} />
      {rows.length > limit && <button type="button" className="session-browser-more" onClick={() => setLimit(value => value + 12)}>{t.sessionBrowser.older}</button>}
    </div>}
  </div>;
}
