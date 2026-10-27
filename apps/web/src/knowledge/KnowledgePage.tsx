import {
  KNOWLEDGE_UI_LIMITS, isKnowledgeIndexEvent, type AgentHostApi, type KnowledgeGraph, type KnowledgeLink, type KnowledgeLinkPage, type KnowledgeNode, type KnowledgeNodeRef,
  type KnowledgeNoteResult, type KnowledgeOverview, type KnowledgeSearchResult, type KnowledgeStatus,
} from '@extalia/platform';
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Markdown, type WikilinkNode } from '../chat/Markdown';
import { errorMessage } from '../host/remote';
import type { Messages } from '../i18n';
import { useLoad, type Loaded } from '../inspect/useLoad';
import { Icon } from '../ui/Icon';
import { isUnsupportedMessage, knowledgeMethodsPresent, layoutGraph, linkKey, linksByTarget, nodeLabel, overviewMethodPresent, pageNodes, shortLabel, type KnowledgeApi } from './knowledgeModel';
import { VaultGraphView } from './vault/VaultGraphView';
import { useKnowledgeEditing, type KnowledgeEditSlots } from './KnowledgeEdit';

/**
 * Knowledge (W5): search the profile's vault index, read a note with clickable wikilinks, see its
 * links, backlinks and a bounded local graph. The host scopes everything to the caller's profile;
 * a link the profile may not see reads "not found", exactly like a missing note (AC-24). Note
 * content is untrusted: the body goes through the safe chat Markdown renderer (no raw HTML), and
 * front matter verification is shown as declared only.
 */

/** Whether the host serves the knowledge methods. Desktop and the Bridge forward every method name, so one probe decides. */
export function useKnowledgeSupport(agents: Partial<AgentHostApi> | undefined): boolean {
  const present = knowledgeMethodsPresent(agents);
  const [probe, setProbe] = useState<{ agents: unknown; supported: boolean } | null>(null);
  useEffect(() => {
    if (!knowledgeMethodsPresent(agents)) return;
    let active = true;
    agents.knowledgeStatus().then(
      () => { if (active) setProbe({ agents, supported: true }); },
      // Any other failure (daemon down, network) still shows the page, which explains the error.
      failure => { if (active) setProbe({ agents, supported: !isUnsupportedMessage(errorMessage(failure)) }); },
    );
    return () => { active = false; };
  }, [agents]);
  return present && probe?.agents === agents && probe.supported;
}

const SEARCH_DELAY_MS = 220;

function formatWhen(iso: string, language: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const minutes = Math.round((date.getTime() - Date.now()) / 60_000);
  const relative = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  if (Math.abs(minutes) < 24 * 60) return relative.format(Math.round(minutes / 60), 'hour');
  return new Intl.DateTimeFormat(language, { day: 'numeric', month: 'short', year: 'numeric' }).format(date);
}

/** Status bar: vault label, counts, last sync, Sync now, and the files the last sync skipped. */
export function KnowledgeStatusBar({ t, language, status, syncing, syncError, onSync }: {
  t: Messages; language: string; status: KnowledgeStatus; syncing: boolean; syncError?: string | undefined; onSync: () => void;
}) {
  const k = t.knowledge;
  const counts = status.counts;
  const skippedTotal = Math.max(counts?.skipped ?? 0, status.lastSync?.skipped ?? 0, status.skipped.length);
  return (
    <section className="card knowledge-status" aria-label={k.vault}>
      <div className="knowledge-status-row">
        <span className="knowledge-vault"><Icon name="files" /><span className="muted">{k.vault}</span> <code>{status.vaultRoot}</code></span>
        {counts && <span className="muted small">{k.notes(counts.notes)}</span>}
        {counts && counts.unresolvedLinks > 0 && <span className="muted small">{k.unresolved(counts.unresolvedLinks)}</span>}
        <span className="muted small" role="status">{syncing ? k.syncing : status.lastSync ? k.lastSync(formatWhen(status.lastSync.at, language), k.syncModes[status.lastSync.mode]) : k.neverSynced}</span>
        <button type="button" className="button small knowledge-sync" disabled={syncing} onClick={onSync}>
          <Icon name="refresh" />{syncing ? k.syncing : k.syncNow}
        </button>
      </div>
      {syncError && <p className="form-error" role="alert"><Icon name="alert" />{syncError}</p>}
      {skippedTotal > 0 && (
        <details className="knowledge-skipped">
          <summary><Icon name="alert" />{k.skipped(skippedTotal)}</summary>
          <ul>
            {status.skipped.map(item => (
              <li key={item.path}><code>{item.path}</code><span className="muted">{k.skipReasons[item.reason] ?? item.reason}</span></li>
            ))}
          </ul>
          {status.skipped.length < skippedTotal && <p className="muted small">{k.skippedListHint}</p>}
        </details>
      )}
    </section>
  );
}

/** One wikilink in a note body: resolved (opens the note), ambiguous (a small picker) or not found (muted). */
export function WikiLinkView({ t, link, edge, nodes, open, pickerId, onToggle, onOpen }: {
  t: Messages; link: WikilinkNode; edge: KnowledgeLink | undefined; nodes: ReadonlyMap<string, KnowledgeNodeRef>; open: boolean; pickerId: string;
  onToggle: (open: boolean) => void; onOpen: (nodeId: string) => void;
}) {
  const k = t.knowledge;
  const label = link.display ?? (link.heading ? `${link.target} › ${link.heading}` : link.target);
  const embed = link.embed ? <Icon name="file" className="wikilink-embed" /> : null;
  if (edge?.status === 'resolved' && edge.targetNodeId) {
    const target = edge.targetNodeId;
    const where = nodeLabel(nodes, target).path;
    return (
      <button type="button" className="wikilink" data-link="resolved" title={[where, link.embed ? k.embed : ''].filter(Boolean).join(' · ') || undefined} onClick={() => onOpen(target)}>
        {embed}{label}
      </button>
    );
  }
  const candidates = edge?.status === 'ambiguous' ? edge.candidates ?? [] : [];
  if (candidates.length) {
    const close = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); onToggle(false); } };
    return (
      <span className="wikilink-ambiguous" onKeyDown={close}>
        <button type="button" className="wikilink" data-link="ambiguous" aria-expanded={open} aria-controls={open ? pickerId : undefined}
          title={k.ambiguousTitle(candidates.length)} onClick={() => onToggle(!open)}>
          {embed}{label}<span className="wikilink-count">{k.ambiguous(candidates.length)}</span>
        </button>
        {open && (
          <span className="wikilink-picker" id={pickerId} role="group" aria-label={k.candidates}>
            <span className="wikilink-picker-head muted small">{k.ambiguousTitle(candidates.length)}</span>
            {candidates.map(candidate => {
              const shown = nodeLabel(nodes, candidate);
              return (
                <button key={candidate} type="button" className="wikilink-candidate" data-candidate={candidate} onClick={() => { onToggle(false); onOpen(candidate); }}>
                  <span className="wikilink-candidate-title">{shown.title}</span>
                  {shown.path && <span className="muted small">{shown.path}</span>}
                </button>
              );
            })}
          </span>
        )}
      </span>
    );
  }
  // Missing, or not in the index yet: never says whether another profile has such a note.
  return <span className="wikilink missing" data-link="missing" title={k.missingTitle}>{embed}{label}<span className="visually-hidden"> ({k.missing})</span></span>;
}

function WikiLink(props: Omit<Parameters<typeof WikiLinkView>[0], 'open' | 'onToggle' | 'pickerId'>) {
  const [open, setOpen] = useState(false);
  const pickerId = useId();
  const root = useRef<HTMLSpanElement>(null);
  const toggle = (next: boolean) => {
    setOpen(next);
    // Back to the link after Escape or a choice, so keyboard users keep their place.
    if (!next) requestAnimationFrame(() => root.current?.querySelector<HTMLButtonElement>('button.wikilink')?.focus());
  };
  return <span ref={root} className="wikilink-slot"><WikiLinkView {...props} open={open} pickerId={pickerId} onToggle={toggle} /></span>;
}

/** The note body: the chat Markdown renderer with wikilinks matched to the note's outgoing links. */
export function NoteBody({ t, body, links, onOpen }: { t: Messages; body: string; links: KnowledgeLinkPage | undefined; onOpen: (nodeId: string) => void }) {
  const byTarget = useMemo(() => linksByTarget(links?.links ?? []), [links]);
  const nodes = useMemo(() => pageNodes(links), [links]);
  return <Markdown text={body} wikilink={(link, key) => <WikiLink key={key} t={t} link={link} edge={byTarget.get(linkKey(link.target))} nodes={nodes} onOpen={onOpen} />} />;
}

/** Kind, id, tags, aliases, and provenance shown as declared (never as trust). */
export function NoteMeta({ t, language, node }: { t: Messages; language: string; node: KnowledgeNode }) {
  const k = t.knowledge;
  return (
    <div className="knowledge-meta">
      <div className="knowledge-chips">
        <span className="chip">{node.kind}</span>
        <span className="badge warn" data-verification={node.declaredVerification ?? 'none'}>
          <Icon name="shield" />{node.declaredVerification ? k.declared(node.declaredVerification) : k.noVerification}
        </span>
        <span className="badge subtle" title={k.untrustedTitle}>{k.untrusted}</span>
        {node.declaredRevision !== undefined && <span className="badge subtle">{k.revision(node.declaredRevision)}</span>}
        {node.tags.map(tag => <span key={tag} className="badge subtle">#{tag}</span>)}
      </div>
      <dl className="history-meta">
        <div><dt>{k.noteId}</dt><dd>{node.idFromFrontMatter ? <code>{node.nodeId}</code> : <span className="muted">{k.pathId}</span>}</dd></div>
        {node.aliases.length > 0 && <div><dt>{k.aliases}</dt><dd>{node.aliases.join(', ')}</dd></div>}
        {node.declaredSourceTaskIds.length > 0 && <div><dt>{k.sourceTasks}</dt><dd>{node.declaredSourceTaskIds.map(id => <code key={id}>{id}</code>)}</dd></div>}
        {node.sourceModifiedAt && <div><dt>{k.modified}</dt><dd>{formatWhen(node.sourceModifiedAt, language)}</dd></div>}
      </dl>
    </div>
  );
}

function LinkTarget({ t, link, nodes, onOpen }: { t: Messages; link: KnowledgeLink; nodes: ReadonlyMap<string, KnowledgeNodeRef>; onOpen: (nodeId: string) => void }) {
  const k = t.knowledge;
  const written = link.display ?? link.target;
  if (link.status === 'resolved' && link.targetNodeId) {
    const target = link.targetNodeId;
    return <><button type="button" className="link-button" onClick={() => onOpen(target)}>{nodeLabel(nodes, target).title}</button>{link.via && <span className="muted small">{k.via[link.via]}</span>}</>;
  }
  const candidates = link.status === 'ambiguous' ? link.candidates ?? [] : [];
  if (!candidates.length) return <><span className="wikilink missing">{written}</span><span className="badge subtle">{k.missing}</span></>;
  return (
    <>
      <span>{written}</span><span className="badge warn">{k.ambiguous(candidates.length)}</span>
      <span className="knowledge-candidates">
        {candidates.map(candidate => {
          const shown = nodeLabel(nodes, candidate);
          return <button key={candidate} type="button" className="link-button small" title={shown.title} onClick={() => onOpen(candidate)}>{shown.path ?? shown.title}</button>;
        })}
      </span>
    </>
  );
}

export function LinkList({ t, title, empty, page, backlinks, onOpen }: {
  t: Messages; title: string; empty: string; page: Loaded<KnowledgeLinkPage>; backlinks?: boolean; onOpen: (nodeId: string) => void;
}) {
  const k = t.knowledge;
  const list = page.value?.links ?? [];
  const nodes = pageNodes(page.value);
  return (
    <section className="knowledge-links" aria-label={title}>
      <h3>{title}{page.value && <span className="muted small"> · {list.length}{page.value.nextCursor !== undefined ? '+' : ''}</span>}</h3>
      {page.error ? <p className="form-error" role="alert"><Icon name="alert" />{page.error}</p>
        : !page.value ? <p className="muted small" role="status">{t.common.loading}</p>
          : list.length === 0 ? <p className="muted small">{empty}</p>
            : (
              <ul>
                {list.map(link => (
                  <li key={`${link.sourceNodeId}:${link.ordinal}`}>
                    <span className="badge subtle">{k.edgeTypes[link.edgeType]}</span>
                    {backlinks
                      ? <button type="button" className="link-button" onClick={() => onOpen(link.sourceNodeId)}>{nodeLabel(nodes, link.sourceNodeId).title}</button>
                      : <LinkTarget t={t} link={link} nodes={nodes} onOpen={onOpen} />}
                    <span className="muted small">{k.line(link.line)}</span>
                  </li>
                ))}
              </ul>
            )}
      {page.value?.nextCursor !== undefined && <p className="muted small">{k.moreLinks}</p>}
    </section>
  );
}

/** The local graph as SVG: a radial layout without a physics simulation, each note a focusable button. */
export function GraphView({ t, graph, title, onOpen }: { t: Messages; graph: KnowledgeGraph; title: string; onOpen: (nodeId: string) => void }) {
  const k = t.knowledge;
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  if (layout.points.length <= 1) return <p className="muted small">{k.graphEmpty}</p>;
  const key = (nodeId: string) => (event: KeyboardEvent) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(nodeId); } };
  return (
    <>
      <svg className="knowledge-graph" viewBox={`0 0 ${layout.size} ${layout.size}`} role="group" aria-label={k.graphLabel(title)}>
        {layout.lines.map(line => (
          <line key={`${line.source}-${line.target}-${line.edgeType}`} x1={line.x1} y1={line.y1} x2={line.x2} y2={line.y2} className={`graph-edge ${line.edgeType === 'links_to' ? '' : 'typed'}`}>
            <title>{k.edgeTypes[line.edgeType]}</title>
          </line>
        ))}
        {layout.points.map(point => point.depth === 0 ? (
          <g key={point.id} className="graph-node root" transform={`translate(${point.x} ${point.y})`} aria-current="true">
            <title>{point.title}</title>
            <circle r={11} />
            <text y={27} textAnchor="middle">{shortLabel(point.title)}</text>
          </g>
        ) : (
          <g key={point.id} className="graph-node" transform={`translate(${point.x} ${point.y})`} role="button" tabIndex={0} aria-label={k.open(point.title)}
            onClick={() => onOpen(point.id)} onKeyDown={key(point.id)}>
            <title>{point.title}</title>
            <circle r={8} />
            <text y={22} textAnchor="middle">{shortLabel(point.title)}</text>
          </g>
        ))}
      </svg>
      {(graph.truncated || layout.hidden > 0) && <p className="muted small">{k.graphTruncated(Math.max(layout.hidden, 1))}</p>}
    </>
  );
}

export interface KnowledgeViewProps {
  t: Messages;
  language: string;
  status: Loaded<KnowledgeStatus>;
  query: string;
  onQuery: (query: string) => void;
  /** `null` while the search box is empty. */
  results: Loaded<KnowledgeSearchResult> | null;
  selectedId: string | null;
  onOpen: (nodeId: string) => void;
  onClose: () => void;
  note: Loaded<KnowledgeNoteResult | null>;
  links: Loaded<KnowledgeLinkPage>;
  backlinks: Loaded<KnowledgeLinkPage>;
  graphOpen: boolean;
  onGraphOpen: (open: boolean) => void;
  depth: 1 | 2;
  onDepth: (depth: 1 | 2) => void;
  graph: Loaded<KnowledgeGraph>;
  syncing: boolean;
  syncError?: string | undefined;
  onSync: () => void;
  /** Local (search, note, local 2D graph; the default) or the whole-vault 3D graph. The switch shows only with `onScope`. */
  scope?: KnowledgeScope;
  onScope?: ((scope: KnowledgeScope) => void) | undefined;
  overview?: Loaded<KnowledgeOverview>;
  /** Note editing (`KnowledgeEdit.tsx`), when the host serves it. */
  editing?: KnowledgeEditSlots;
}
export type KnowledgeScope = 'local' | 'vault';

/** Local / Whole vault: shown only when the host serves the vault overview. */
function ScopeSwitch({ t, scope, onScope }: { t: Messages; scope: KnowledgeScope; onScope: (scope: KnowledgeScope) => void }) {
  const k = t.knowledge.vaultGraph;
  return (
    <div className="segmented knowledge-scope" role="group" aria-label={k.scope}>
      {(['local', 'vault'] as const).map(item => (
        <button key={item} type="button" className="chip-button" aria-pressed={scope === item} onClick={() => onScope(item)}>{item === 'local' ? k.local : k.whole}</button>
      ))}
    </div>
  );
}

function NotePanel(props: KnowledgeViewProps) {
  const { t, language, note, links, backlinks, onOpen, onClose, graphOpen, onGraphOpen, depth, onDepth, graph } = props;
  const k = t.knowledge;
  const back = <button type="button" className="button small back-to-list" onClick={onClose}><Icon name="chevron" className="flip" />{t.inspect.backToList}</button>;
  const value = note.value;
  if (note.error || !value) {
    return (
      <article className="card history-viewer knowledge-note">
        {back}
        {note.error ? <p className="form-error" role="alert"><Icon name="alert" />{note.error}</p>
          : value === null ? <p className="note">{k.notFound}</p>
            : <p className="muted" role="status">{t.common.loading}</p>}
      </article>
    );
  }
  const node = value.node;
  return (
    <article className="card history-viewer knowledge-note" aria-labelledby="knowledge-note-title">
      {back}
      <header className="viewer-head">
        <h2 id="knowledge-note-title" className="viewer-title">{node.title}</h2>
        <code className="muted small knowledge-path">{node.path}</code>
      </header>
      <NoteMeta t={t} language={language} node={node} />
      {props.editing?.noteTools}
      {value.bodyStatus === 'changed' && <p className="note"><Icon name="refresh" />{k.bodyChanged}</p>}
      {value.bodyTruncated && <p className="note">{k.truncated}</p>}
      {value.body !== undefined && value.bodyStatus !== 'unavailable'
        ? <div className="knowledge-body"><NoteBody t={t} body={value.body} links={links.value} onOpen={onOpen} /></div>
        : <p className="muted">{k.bodyUnavailable}</p>}
      <div className="knowledge-graph-panel">
        <div className="knowledge-graph-head">
          <h3>{k.graph}</h3>
          {graphOpen && (
            <div className="segmented" role="group" aria-label={k.depth}>
              {([1, 2] as const).map(level => <button key={level} type="button" className="chip-button" aria-pressed={depth === level} onClick={() => onDepth(level)}>{k.depth} {level}</button>)}
            </div>
          )}
          <button type="button" className="button small" aria-expanded={graphOpen} onClick={() => onGraphOpen(!graphOpen)}>{graphOpen ? k.hideGraph : k.showGraph}</button>
        </div>
        {graphOpen && (graph.error ? <p className="form-error" role="alert"><Icon name="alert" />{graph.error}</p>
          : !graph.value ? <p className="muted small" role="status">{k.graphLoading}</p>
            : <GraphView t={t} graph={graph.value} title={node.title} onOpen={onOpen} />)}
      </div>
      <LinkList t={t} title={k.links} empty={k.noLinks} page={links} onOpen={onOpen} />
      <LinkList t={t} title={k.backlinks} empty={k.noBacklinks} page={backlinks} backlinks onOpen={onOpen} />
    </article>
  );
}

/** The page without state, for tests and for the stateful page below. */
export function KnowledgeView(props: KnowledgeViewProps) {
  const { t, language, status, query, onQuery, results, selectedId, onOpen, syncing, syncError, onSync } = props;
  const k = t.knowledge;
  const header = <header className="page-header"><h1>{k.title}</h1><p className="lead">{k.lead}</p></header>;
  if (status.error && !status.value) return <div className="page knowledge">{header}<section className="card"><p className="form-error" role="alert"><Icon name="alert" />{status.error}</p></section></div>;
  if (!status.value) return <div className="page knowledge">{header}<section className="card"><p className="muted" role="status">{t.common.loading}</p></section></div>;
  const current = status.value;
  const bar = <><KnowledgeStatusBar t={t} language={language} status={current} syncing={syncing} syncError={syncError} onSync={onSync} />{props.editing?.toolbar}</>;
  const editor = props.editing?.editor;
  if (current.state === 'unavailable') {
    return (
      <div className="page knowledge">{header}{bar}
        <section className="card empty-state" data-state="unavailable">
          <p className="note"><Icon name="alert" />{k.unavailable}</p>
          {current.reason && <p className="muted small">{k.unavailableReason(current.reason)}</p>}
        </section>
      </div>
    );
  }
  if (!current.counts?.notes) {
    return (
      <div className="page knowledge">{header}{bar}
        <section className="card empty-state" data-state="empty">
          <h2>{k.emptyTitle}</h2>
          <p>{k.emptyBody} <code>{current.vaultRoot}</code></p>
          <p className="muted">{current.vaultPresent ? k.emptyHint : k.vaultMissing}</p>
        </section>
        {editor}
      </div>
    );
  }
  const scope = props.onScope ? props.scope ?? 'local' : 'local';
  const scopeSwitch = props.onScope ? <ScopeSwitch t={t} scope={scope} onScope={props.onScope} /> : null;
  if (scope === 'vault') {
    return (
      <div className="page knowledge knowledge-vault-page">
        {header}
        {bar}
        {scopeSwitch}
        <VaultGraphView t={t} overview={props.overview ?? { loading: true }} selectedId={selectedId} onOpen={onOpen} onClose={props.onClose}
          notePanel={editor ?? (selectedId ? <NotePanel {...props} /> : null)} />
      </div>
    );
  }
  const hits = results?.value?.hits ?? [];
  return (
    <div className="page knowledge">
      {header}
      {bar}
      {scopeSwitch}
      <div className={`history knowledge-layout ${selectedId || editor ? 'has-selection' : ''}`}>
        <section className="card history-list knowledge-search" aria-label={k.results}>
          <form className="history-tools" role="search" onSubmit={event => event.preventDefault()}>
            <input type="search" className="search" value={query} placeholder={k.search} aria-label={k.search} maxLength={200} onChange={event => onQuery(event.target.value)} />
          </form>
          {!results ? <p className="muted small">{k.searchHint}</p>
            : results.error ? <p className="form-error" role="alert"><Icon name="alert" />{results.error}</p>
              : !results.value ? <p className="muted small" role="status">{t.common.loading}</p>
                : hits.length === 0 ? <p className="muted small">{k.noResults(query.trim())}</p>
                  : (
                    <ul className="session-list knowledge-results">
                      {hits.map(hit => (
                        <li key={hit.nodeId} className={`session-row ${selectedId === hit.nodeId ? 'active' : ''}`}>
                          <button type="button" className="session-select knowledge-hit" aria-current={selectedId === hit.nodeId ? 'true' : undefined} onClick={() => onOpen(hit.nodeId)}>
                            <span className="session-title">{hit.title}</span>
                            <span className="session-meta knowledge-hit-path">{hit.path}</span>
                            {hit.snippet && <span className="knowledge-snippet">{hit.snippet}</span>}
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
          {hits.length >= KNOWLEDGE_UI_LIMITS.searchResults && <p className="muted small">{k.moreResults}</p>}
        </section>
        {editor ?? (selectedId
          ? <NotePanel {...props} />
          : <section className="card history-viewer placeholder"><p className="muted">{k.select}</p></section>)}
      </div>
    </div>
  );
}

/** The Knowledge page with its state. Mounted only when the host serves the knowledge methods. */
export function KnowledgePage({ t, language, agents }: { t: Messages; language: string; agents: AgentHostApi }) {
  const api = agents as AgentHostApi & KnowledgeApi;
  const [status, setStatus] = useState<Loaded<KnowledgeStatus>>({ loading: true });
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string>();
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [graphOpen, setGraphOpen] = useState(false);
  const [depth, setDepth] = useState<1 | 2>(1);
  const [scope, setScope] = useState<KnowledgeScope>('local');

  useEffect(() => {
    let active = true;
    const load = () => api.knowledgeStatus().then(value => { if (active) setStatus({ value, loading: false }); }, failure => { if (active) setStatus({ error: errorMessage(failure), loading: false }); });
    void load();
    // The vault watcher indexed an outside edit (or the vault folder changed): a new generation refreshes what is shown.
    const stop = api.subscribe(event => { if (active && isKnowledgeIndexEvent(event)) void load(); });
    return () => { active = false; stop(); };
  }, [api]);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [query]);

  // The index generation keys every read, so a sync that changed the index refreshes what is on screen.
  const generation = String(status.value?.generation ?? 0);
  const noteKey = selectedId ? `${generation}\n${selectedId}` : null;
  const searched = useLoad(debounced ? `${generation}\n${debounced}` : null, 0, () => api.searchKnowledge(debounced));
  const note = useLoad(noteKey, 0, () => api.knowledgeNode({ nodeId: selectedId! }));
  const links = useLoad(noteKey, 0, () => api.knowledgeLinks(selectedId!));
  const backlinks = useLoad(noteKey, 0, () => api.knowledgeBacklinks(selectedId!));
  // Lazy: the graph loads only while it is open.
  const graph = useLoad(selectedId && graphOpen ? `${generation}\n${selectedId}\n${depth}` : null, 0, () => api.knowledgeGraph(selectedId!, depth));
  // The whole-vault graph loads only while it is open; a host that turns out not to serve it hides the switch.
  const vaultCapable = overviewMethodPresent(agents);
  const overview = useLoad(vaultCapable && scope === 'vault' ? generation : null, 0, () => (agents.knowledgeOverview as () => Promise<KnowledgeOverview>)());
  const vaultSupported = vaultCapable && !(overview.error && isUnsupportedMessage(overview.error));

  const sync = async () => {
    setSyncing(true); setSyncError(undefined);
    try { setStatus({ value: (await api.syncKnowledge('incremental')).status, loading: false }); }
    catch (failure) { setSyncError(errorMessage(failure)); }
    finally { setSyncing(false); }
  };
  // A note opened from a link or the graph shows from its top once it has loaded.
  const pendingScroll = useRef(false);
  const open = (nodeId: string) => { pendingScroll.current = true; setSelectedId(nodeId); };
  const shownId = note.value?.node.nodeId;
  useEffect(() => {
    if (!shownId || !pendingScroll.current) return;
    pendingScroll.current = false;
    document.querySelector('.knowledge-note')?.scrollIntoView({ block: 'start' });
  }, [shownId]);
  // Editing (W5 slice 2b): asks before an unsaved draft is left, so the page opens and closes notes through it.
  const editing = useKnowledgeEditing({ t, language, agents, status, onStatus: value => setStatus({ value, loading: false }), note, open, close: () => setSelectedId(null) });

  return (
    <KnowledgeView t={t} language={language} status={status} query={query} onQuery={setQuery}
      results={debounced ? searched : null} selectedId={selectedId} onOpen={editing.onOpen} onClose={editing.onClose} editing={editing}
      note={note} links={links} backlinks={backlinks} graphOpen={graphOpen} onGraphOpen={setGraphOpen} depth={depth} onDepth={setDepth} graph={graph}
      syncing={syncing} syncError={syncError} onSync={() => void sync()}
      scope={vaultSupported ? scope : 'local'} onScope={vaultSupported ? setScope : undefined} overview={overview} />
  );
}
