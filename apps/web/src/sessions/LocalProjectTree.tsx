import { useMemo, useRef, useState, type ReactNode } from 'react';
import { sourceLabel } from '@extalia/core';
import { sessionBrowserProject, type SessionBrowserProjectIdentity } from '@extalia/platform';
import type { Messages } from '../i18n';
import { Icon } from '../ui/Icon';
import { OriginMark } from '../ui/OriginMark';
import { observedSource } from '../office/agentOrigin';
import './sessionBrowser.css';
import { TREE_FOLDER_SELECTOR, TREE_ROW_SELECTOR, useTreeReorderMotion } from './treeReorderMotion';

type Folder<T> = { id: string; name: string; path?: string; rows: T[] };
/** Discovery supplies metadata; only expanded harness/project nodes mount their bounded rows. */
export function LocalProjectTree<T extends { id: string }>({ t, rows, path, updatedAt, source, projectIdentity, renderRow }: {
  t: Messages; rows: T[]; path: (row: T) => string | undefined; updatedAt: (row: T) => string;
  source?: (row: T) => string | undefined; projectIdentity?: (row: T) => SessionBrowserProjectIdentity | undefined; renderRow: (row: T) => ReactNode;
}) {
  const harnesses = useMemo(() => {
    const result = new Map<string, { id: string; rows: T[] }>();
    for (const row of [...rows].sort((a, b) => updatedAt(b).localeCompare(updatedAt(a)) || a.id.localeCompare(b.id))) {
      const id = source?.(row) || 'unknown';
      let harness = result.get(id);
      if (!harness) { harness = { id, rows: [] }; result.set(id, harness); }
      harness.rows.push(row);
    }
    return [...result.values()];
  }, [rows, source, updatedAt]);
  const [limit, setLimit] = useState(12);
  return <div className="session-browser"><div className="session-browser-harness-list">
    {harnesses.slice(0, limit).map((harness, index) => <LocalHarness key={harness.id} t={t} harness={harness} path={path} projectIdentity={projectIdentity} initiallyOpen={index === 0} renderRow={renderRow} />)}
    {harnesses.length > limit && <button type="button" className="session-browser-more" onClick={() => setLimit(value => value + 12)}>{t.sessionBrowser.showMore}</button>}
  </div></div>;
}
function LocalHarness<T extends { id: string }>({ t, harness, path, projectIdentity, initiallyOpen, renderRow }: {
  t: Messages; harness: { id: string; rows: T[] }; path: (row: T) => string | undefined; projectIdentity?: (row: T) => SessionBrowserProjectIdentity | undefined; initiallyOpen: boolean; renderRow: (row: T) => ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const groups = useMemo(() => {
    const grouped = new Map<string, Folder<T>>();
    for (const row of harness.rows) {
      const project = projectIdentity?.(row) ?? sessionBrowserProject(path(row)), id = project?.id ?? 'unassigned';
      let group = grouped.get(id);
      if (!group) { group = { id, name: project?.name ?? '', ...(project ? { path: project.path } : {}), rows: [] }; grouped.set(id, group); }
      group.rows.push(row);
    }
    return [...grouped.values()];
  }, [harness.rows, path, projectIdentity]);
  return <article className="session-browser-harness">
    <button type="button" className="session-browser-harness-toggle" aria-expanded={open} onClick={() => setOpen(value => !value)}><Icon name="chevron" /><OriginMark mark={observedSource(harness.id).mark} /><span>{sourceLabel(harness.id)}</span><span className="badge">{harness.rows.length}</span></button>
    {open && <div className="session-browser-harness-children">{(['projects', 'unassigned'] as const).map(section => <LocalSection key={section} t={t} section={section} groups={groups.filter(group => section === 'projects' ? Boolean(group.path) : !group.path)} renderRow={renderRow} />)}</div>}
  </article>;
}
function LocalSection<T extends { id: string }>({ t, section, groups, renderRow }: {
  t: Messages; section: 'projects' | 'unassigned'; groups: Folder<T>[]; renderRow: (row: T) => ReactNode;
}) {
  const [open, setOpen] = useState(true), [limit, setLimit] = useState(12);
  const folderList = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(folderList, TREE_FOLDER_SELECTOR);
  if (!groups.length) return null;
  return <section className="session-browser-section"><button type="button" className="session-browser-section-toggle" aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron" /><span>{t.sessionBrowser[section]}</span><span className="badge">{groups.reduce((sum, group) => sum + group.rows.length, 0)}</span></button>
    {open && <div className="session-browser-section-body" ref={folderList}>{groups.slice(0, limit).map((group, index) => <LocalFolder key={group.id} t={t} group={group} initiallyOpen={index === 0} duplicateName={groups.some(other => other.id !== group.id && other.name === group.name)} renderRow={renderRow} />)}{groups.length > limit && <button type="button" className="session-browser-more" onClick={() => setLimit(limit + 12)}>{t.sessionBrowser.showMore}</button>}</div>}
  </section>;
}
function LocalFolder<T extends { id: string }>({ t, group, initiallyOpen, duplicateName, renderRow }: {
  t: Messages; group: Folder<T>; initiallyOpen: boolean; duplicateName: boolean; renderRow: (row: T) => ReactNode;
}) {
  const [open, setOpen] = useState(initiallyOpen), [limit, setLimit] = useState(12);
  const rowList = useRef<HTMLDivElement>(null);
  useTreeReorderMotion(rowList, TREE_ROW_SELECTOR);
  return <div className="session-browser-folder">{group.path && <button type="button" className="session-browser-folder-toggle" title={group.path} aria-expanded={open} onClick={() => setOpen(!open)}><Icon name="chevron" /><Icon name="folder" /><span>{group.name}{duplicateName && <small className="session-browser-folder-path">{group.path}</small>}</span><small>{group.rows.length}</small></button>}
    {(open || !group.path) && <div className="session-browser-rows" ref={rowList}><ul className="candidate-list">{group.rows.slice(0, limit).map(renderRow)}</ul>{group.rows.length > limit && <button type="button" className="session-browser-more" onClick={() => setLimit(limit + 12)}>{t.sessionBrowser.older}</button>}</div>}
  </div>;
}
