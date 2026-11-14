import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sourceLabel } from '@extalia/core';
import { buildSessionBrowserHarnessGroups, buildSessionBrowserSnapshot, type AgentHostApi, type HostState, type SessionBrowserGroup, type SessionBrowserQuery, type SessionBrowserRow } from '@extalia/platform';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { OriginMark } from '../ui/OriginMark';
import { observedSource } from '../office/agentOrigin';
import { errorMessage } from '../host/remote';
import './sessionBrowser.css';
import { missingSessionBrowserCapability } from './sessionBrowserCompatibility';
import { TREE_FOLDER_SELECTOR, TREE_ROW_SELECTOR, useTreeReorderMotion } from './treeReorderMotion';
import { readSessionBrowserWindow, SessionBrowserExpansion, sessionBrowserFilterKey, sessionBrowserNodeKey } from './sessionBrowserState';

const GROUP_PAGE = 12;
const SESSION_PAGE = 12;
type Page<T> = { items: T[]; cursor?: string; busy: boolean; error?: string; ready: boolean };
const empty = <T,>(): Page<T> => ({ items: [], busy: false, ready: false });
const distinct = <T extends { id: string }>(before: T[], after: T[]) => [...new Map([...before, ...after].map(row => [row.id, row])).values()];

function useBrowserExpansion(memory: SessionBrowserExpansion, key: string, fallback: boolean, defaultSlot?: string) {
  const [open, setOpen] = useState(() => memory.read(key, fallback, defaultSlot));
  return [open, (value: boolean) => { memory.set(key, value); setOpen(value); }] as const;
}

/** Presentation-only navigation. Each expanded folder owns a bounded metadata request. */
export function SessionBrowser({ t, agents, state, collection, query = '', status, libraryState, attentionIds, refreshKey, renderRows, emptyLabel }: {
  t: Messages; agents: AgentHostApi; state: HostState; collection: 'observed' | 'library'; query?: string;
  status?: SessionBrowserQuery['status']; libraryState?: SessionBrowserQuery['state']; attentionIds?: string[];
  refreshKey?: unknown; renderRows: (rows: SessionBrowserRow[]) => ReactNode; emptyLabel: string;
}) {
  const attentionKey = attentionIds?.length ? JSON.stringify([...attentionIds].sort()) : '';
  const stableAttentionIds = useMemo(() => attentionKey ? JSON.parse(attentionKey) as string[] : undefined, [attentionKey]);
  const filters = useMemo(() => ({ collection, query, ...(status ? { status } : {}), ...(libraryState ? { state: libraryState } : {}), ...(stableAttentionIds ? { attentionIds: stableAttentionIds } : {}) }), [collection, query, status, libraryState, stableAttentionIds]);
  // Live attention is query data, not the identity of the mounted navigation.
  const filterKey = sessionBrowserFilterKey(filters);
  const profileId = state.profile?.id;
  const dataScope = JSON.stringify([state.dataDirectory, state.storage?.dataDirectory]);
  const [scope, setScope] = useState(() => ({ agents, profileId, dataScope, collection, revision: 0, expansion: new SessionBrowserExpansion() }));
  if (scope.agents !== agents || scope.profileId !== profileId || scope.dataScope !== dataScope || scope.collection !== collection) {
    setScope({ agents, profileId, dataScope, collection, revision: scope.revision + 1, expansion: new SessionBrowserExpansion() });
  }
  const [legacyHost, setLegacyHost] = useState<{ agents: AgentHostApi; revision: number }>();
  const remote = Boolean(agents.sessionBrowserGroups && agents.sessionBrowserSessions && !(legacyHost?.agents === agents && legacyHost.revision === scope.revision));
  const unsupported = useCallback(() => setLegacyHost({ agents, revision: scope.revision }), [agents, scope.revision]);
  const snapshotInput = useMemo(() => remote ? undefined : { collection, observed: state.sessions, library: state.library ?? [], workspaces: state.workspaces }, [remote, collection, state.sessions, state.library, state.workspaces]);
  return <div className="session-browser">
    {!remote && <p className="muted small session-browser-compat">{t.sessionBrowser.unavailable}</p>}
    <HarnessList key={`${scope.revision}:${filterKey}:${remote}`} expansion={scope.expansion} t={t} agents={agents} filters={filters} snapshotInput={snapshotInput} unsupported={unsupported} refreshKey={refreshKey} renderRows={renderRows} emptyLabel={emptyLabel} />
  </div>;
}

export function SessionBrowserIndicators({ t, running, unread }: { t: Messages; running?: boolean; unread?: boolean }) {
  return <>{running && <span className="session-browser-spinner spin" role="img" aria-label={t.chat.running} title={t.chat.running} />}{unread && <span className="session-browser-unread" role="img" aria-label={t.sessionBrowser.unread} title={t.sessionBrowser.unread} />}</>;
}

type SnapshotInput = Parameters<typeof buildSessionBrowserSnapshot>[0];
function HarnessList({ t, agents, filters, snapshotInput, unsupported, refreshKey, renderRows, emptyLabel, expansion }: {
  t: Messages; agents: AgentHostApi; filters: SessionBrowserQuery; snapshotInput?: SnapshotInput; unsupported: () => void;
  refreshKey?: unknown; renderRows: (rows: SessionBrowserRow[]) => ReactNode; emptyLabel: string;
  expansion: SessionBrowserExpansion;
}) {
  const [page, setPage] = useState<Page<SessionBrowserGroup>>(empty);
  const version = useRef(0), alive = useRef(true), busyRef = useRef(false);
  const loadedCount = useRef(GROUP_PAGE);
  const invalidate = useCallback(() => { version.current++; }, []);
  const localGroups = useMemo(() => snapshotInput ? buildSessionBrowserHarnessGroups(snapshotInput, filters) : undefined, [snapshotInput, filters]);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (cursor?: string) => {
    if (busyRef.current && cursor) return;
    const request = ++version.current;
    busyRef.current = true;
    setPage(current => ({ ...current, busy: true, error: undefined }));
    try {
      const result = await readSessionBrowserWindow<SessionBrowserGroup>({ cursor, count: loadedCount.current, pageSize: GROUP_PAGE, current: () => alive.current && request === version.current, fetchPage: async (limit, cursor) => {
        const offset = Number(cursor ?? 0);
        if (localGroups) return { items: localGroups.slice(offset, offset + limit), nextCursor: offset + limit < localGroups.length ? String(offset + limit) : undefined };
        const page = await agents.sessionBrowserGroups!({ ...filters, section: 'harnesses', limit, ...(cursor ? { cursor } : {}) });
        return { items: page.groups, nextCursor: page.nextCursor };
      } });
      if (!result) return;
      setPage(current => {
        const items = cursor ? distinct(current.items, result.items) : result.items;
        loadedCount.current = Math.max(loadedCount.current, items.length);
        return { items, cursor: result.cursor, busy: false, ready: true };
      });
    } catch (failure) {
      if (alive.current && request === version.current) { if (!snapshotInput && missingSessionBrowserCapability(failure)) unsupported(); else setPage(current => ({ ...current, busy: false, error: errorMessage(failure) })); }
    } finally { if (request === version.current) busyRef.current = false; }
  }, [agents, filters, localGroups, snapshotInput, unsupported]);
  useEffect(() => { void load(); return invalidate; }, [load, refreshKey, invalidate]);
  return <div className="session-browser-harness-list">
    {page.error && <p className="form-error" role="alert">{page.error} <button type="button" onClick={() => { void load(); }}>{t.sessionBrowser.retry}</button></p>}
    {!page.ready && page.busy && <p className="muted small" role="status">{t.common.loading}</p>}
    {page.ready && !page.items.length && <p className="muted small session-browser-empty">{emptyLabel}</p>}
    {page.items.map((group, index) => <BrowserHarness key={group.id} expansion={expansion} t={t} agents={agents} filters={filters} harness={group} initiallyOpen={index === 0} snapshotInput={snapshotInput} unsupported={unsupported} refreshKey={refreshKey} renderRows={renderRows} emptyLabel={emptyLabel} />)}
    {page.cursor && <button type="button" className="session-browser-more" disabled={page.busy} onClick={() => { void load(page.cursor); }}>{page.busy ? t.common.loading : t.sessionBrowser.moreHarnesses}</button>}
  </div>;
}

function BrowserHarness({ t, agents, filters, harness, initiallyOpen, snapshotInput, unsupported, refreshKey, renderRows, emptyLabel, expansion }: {
  t: Messages; agents: AgentHostApi; filters: SessionBrowserQuery; harness: SessionBrowserGroup; initiallyOpen: boolean;
  snapshotInput?: SnapshotInput; unsupported: () => void; refreshKey?: unknown; renderRows: (rows: SessionBrowserRow[]) => ReactNode; emptyLabel: string;
  expansion: SessionBrowserExpansion;
}) {
  const source = harness.sourceId ?? harness.sourceIds[0] ?? harness.name;
  const [open, setOpen] = useBrowserExpansion(expansion, sessionBrowserNodeKey('harness', source), initiallyOpen, 'initial-harness');
  const scopedFilters = useMemo(() => ({ ...filters, harness: source }), [filters, source]);
  const snapshot = useMemo(() => snapshotInput ? buildSessionBrowserSnapshot(snapshotInput, scopedFilters) : undefined, [snapshotInput, scopedFilters]);
  return <article className={`session-browser-harness${harness.runningCount ? ' is-running' : ''}`}>
    <button type="button" className="session-browser-harness-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron" /><OriginMark mark={observedSource(source).mark} /><span>{sourceLabel(source)}</span><SessionBrowserIndicators t={t} running={Boolean(harness.runningCount)} unread={Boolean(harness.unreadCount)} /><span className="badge">{harness.count}</span></button>
    {open && <div className="session-browser-harness-children">{(['projects', 'unassigned'] as const).map(section => <BrowserSection key={section} expansion={expansion} t={t} agents={agents} filters={scopedFilters} section={section} snapshot={snapshot} unsupported={unsupported} refreshKey={refreshKey} renderRows={renderRows} emptyLabel={emptyLabel} />)}</div>}
  </article>;
}

type Snapshot = ReturnType<typeof buildSessionBrowserSnapshot>;
function BrowserSection({ t, agents, filters, section, snapshot, unsupported, refreshKey, renderRows, emptyLabel, expansion }: {
  t: Messages; agents: AgentHostApi; filters: SessionBrowserQuery; section: 'projects' | 'unassigned'; snapshot?: Snapshot; unsupported: () => void;
  refreshKey?: unknown; renderRows: (rows: SessionBrowserRow[]) => ReactNode; emptyLabel: string;
  expansion: SessionBrowserExpansion;
}) {
  const [open, setOpen] = useBrowserExpansion(expansion, sessionBrowserNodeKey('section', filters.harness ?? '', section), true);
  const [page, setPage] = useState<Page<SessionBrowserGroup>>(empty);
  const [total, setTotal] = useState(0);
  const folderList = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(folderList, TREE_FOLDER_SELECTOR);
  const version = useRef(0);
  const busyRef = useRef(false);
  const alive = useRef(true);
  const loadedCount = useRef(GROUP_PAGE);
  const invalidate = useCallback(() => { version.current++; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const localGroups = useMemo(() => snapshot?.groups.filter(group => section === 'projects' ? Boolean(group.projectPath) : !group.projectPath), [snapshot, section]);
  const load = useCallback(async (cursor?: string) => {
    if (busyRef.current && cursor) return;
    const request = ++version.current;
    busyRef.current = true;
    setPage(current => ({ ...current, busy: true, error: undefined }));
    try {
      const result = await readSessionBrowserWindow<SessionBrowserGroup>({ cursor, count: loadedCount.current, pageSize: GROUP_PAGE, current: () => alive.current && request === version.current, fetchPage: async (limit, cursor) => {
        const offset = Number(cursor ?? 0);
        if (snapshot) return { items: localGroups!.slice(offset, offset + limit), total: localGroups!.reduce((sum, group) => sum + group.count, 0), nextCursor: offset + limit < localGroups!.length ? String(offset + limit) : undefined };
        const page = await agents.sessionBrowserGroups!({ ...filters, section, limit, ...(cursor ? { cursor } : {}) });
        return { items: page.groups, total: page.totalSessions, nextCursor: page.nextCursor };
      } });
      if (!result) return;
      setTotal(result.total ?? 0);
      setPage(current => {
        const items = cursor ? distinct(current.items, result.items) : result.items;
        loadedCount.current = Math.max(loadedCount.current, items.length);
        return { items, cursor: result.cursor, busy: false, ready: true };
      });
    } catch (failure) {
      if (alive.current && request === version.current) { if (!snapshot && missingSessionBrowserCapability(failure)) unsupported(); else setPage(current => ({ ...current, busy: false, error: errorMessage(failure) })); }
    } finally { if (request === version.current) busyRef.current = false; }
  }, [agents, filters, section, snapshot, localGroups, unsupported]);
  // Counts stay current when this section is folded; its session rows stay unmounted.
  useEffect(() => { void load(); return invalidate; }, [load, refreshKey, invalidate]);
  const running = section === 'unassigned' && page.items.some(group => group.runningCount);
  const unread = section === 'unassigned' && page.items.some(group => group.unreadCount);
  if (page.ready && !page.items.length && !page.error) return null;
  return <section className={`session-browser-section${running ? ' is-running' : ''}`}>
    <button type="button" className="session-browser-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron" /><span>{t.sessionBrowser[section]}</span><SessionBrowserIndicators t={t} running={running} unread={unread} />{page.ready && <span className="badge">{total}</span>}</button>
    {open && <div className="session-browser-section-body" ref={folderList}>
      {page.error && <p className="form-error" role="alert">{page.error} <button type="button" onClick={() => { void load(); }}>{t.sessionBrowser.retry}</button></p>}
      {!page.ready && page.busy && <p className="muted small" role="status">{t.common.loading}</p>}
      {page.ready && !page.items.length && <p className="muted small session-browser-empty">{emptyLabel}</p>}
      {page.items.map((group, index) => <BrowserFolder key={group.id} expansion={expansion} t={t} agents={agents} filters={filters} group={group} snapshot={snapshot} unsupported={unsupported} refreshKey={refreshKey} initiallyOpen={index === 0} duplicateName={page.items.some(other => other.id !== group.id && other.name === group.name)} renderRows={renderRows} />)}
      {page.cursor && <button type="button" className="session-browser-more" disabled={page.busy} onClick={() => { void load(page.cursor); }}>{page.busy ? t.common.loading : t.sessionBrowser.showMore}</button>}
    </div>}
  </section>;
}

function BrowserFolder({ t, agents, filters, group, snapshot, unsupported, refreshKey, initiallyOpen, duplicateName, renderRows, expansion }: {
  t: Messages; agents: AgentHostApi; filters: SessionBrowserQuery; group: SessionBrowserGroup; snapshot?: Snapshot; unsupported: () => void; refreshKey?: unknown;
  initiallyOpen: boolean; duplicateName: boolean; renderRows: (rows: SessionBrowserRow[]) => ReactNode;
  expansion: SessionBrowserExpansion;
}) {
  const [open, setOpen] = useBrowserExpansion(expansion, sessionBrowserNodeKey('folder', filters.harness ?? '', group.section, group.id), initiallyOpen, sessionBrowserNodeKey('initial-folder', filters.harness ?? '', group.section));
  const [page, setPage] = useState<Page<SessionBrowserRow>>(empty);
  const rowList = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(rowList, TREE_ROW_SELECTOR);
  const version = useRef(0), alive = useRef(true), busyRef = useRef(false);
  const loadedCount = useRef(SESSION_PAGE);
  const invalidate = useCallback(() => { version.current++; }, []);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const load = useCallback(async (cursor?: string) => {
    if (busyRef.current && cursor) return;
    const request = ++version.current;
    busyRef.current = true;
    setPage(current => ({ ...current, busy: true, error: undefined }));
    try {
      const rows = snapshot?.sessionsByGroup.get(group.id) ?? [];
      const result = await readSessionBrowserWindow<SessionBrowserRow>({ cursor, count: loadedCount.current, pageSize: SESSION_PAGE, current: () => alive.current && request === version.current, fetchPage: async (limit, cursor) => {
        const offset = Number(cursor ?? 0);
        if (snapshot) return { items: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : undefined };
        const page = await agents.sessionBrowserSessions!({ ...filters, groupId: group.id, limit, ...(cursor ? { cursor } : {}) });
        return { items: page.sessions, nextCursor: page.nextCursor };
      } });
      if (!result) return;
      setPage(current => {
        const items = cursor ? distinct(current.items, result.items) : result.items;
        loadedCount.current = Math.max(loadedCount.current, items.length);
        return { items, cursor: result.cursor, busy: false, ready: true };
      });
    } catch (failure) { if (alive.current && request === version.current) { if (!snapshot && missingSessionBrowserCapability(failure)) unsupported(); else setPage(current => ({ ...current, busy: false, error: errorMessage(failure) })); } }
    finally { if (request === version.current) busyRef.current = false; }
  }, [agents, filters, group.id, snapshot, unsupported]);
  useEffect(() => { if (open) void load(); else { version.current++; busyRef.current = false; } return invalidate; }, [open, load, refreshKey, invalidate]);
  // Sessions without a source folder form a single section, rather than another invented folder.
  const folder = Boolean(group.projectPath);
  return <div className={`session-browser-folder${group.runningCount ? ' is-running' : ''}`}>
    {folder && <button type="button" className="session-browser-folder-toggle" aria-expanded={open} title={group.projectPath} onClick={() => setOpen(!open)}><Icon name="chevron" /><Icon name="folder" /><span>{group.name}{duplicateName && <small className="session-browser-folder-path">{group.projectPath}</small>}</span><SessionBrowserIndicators t={t} running={Boolean(group.runningCount)} unread={Boolean(group.unreadCount)} /><small>{group.count}</small></button>}
    {(open || !folder) && <div className="session-browser-rows" ref={rowList}>
      {page.error && <p className="form-error" role="alert">{page.error} <button type="button" onClick={() => { void load(); }}>{t.sessionBrowser.retry}</button></p>}
      {page.busy && !page.ready && <p className="muted small" role="status">{t.common.loading}</p>}
      {renderRows(page.items)}
      {page.cursor && <button type="button" className="session-browser-more" disabled={page.busy} onClick={() => { void load(page.cursor); }}>{page.busy ? t.common.loading : t.sessionBrowser.older}</button>}
    </div>}
  </div>;
}
