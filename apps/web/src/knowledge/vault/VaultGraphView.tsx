import type { KnowledgeOverview } from '@extalia/platform';
import { Component, lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Messages } from '../../i18n';
import type { Loaded } from '../../inspect/useLoad';
import { Icon } from '../../ui/Icon';
import {
  assignColours, COLOUR_MODES, GRAPH_OTHER_COLOUR, prepareVaultGraph, rankSearch, TIME_WINDOWS, timeMask, type ColourMode, type TimeWindow, type VaultGraph,
} from './vaultGraphModel';

/**
 * The whole-vault graph: toolbar (search, time filter, colour mode, labels, glow), the lazily
 * loaded 3D canvas, a legend, an accessible list (top hubs and matches) and the note panel. The
 * shell is plain DOM; three.js and the simulation load only when this view opens.
 */
const VaultGraphCanvas = lazy(() => import('./VaultGraphCanvas'));

const HUB_LIST = 25;
const RESULT_LIST = 8;

/** The canvas failed (no WebGL): say so; the list view still works. */
class CanvasBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback : this.props.children; }
}

const devFlag = (name: string): string | null => (import.meta.env.DEV && typeof location !== 'undefined' ? new URLSearchParams(location.search).get(name) : null);

/** Dev-only stress data (`?graphnodes=N`, Vite dev server only) for measuring frame rate at size. */
function useStressOverview(): KnowledgeOverview | null {
  const [stress, setStress] = useState<KnowledgeOverview | null>(null);
  useEffect(() => {
    const size = Number(devFlag('graphnodes'));
    if (!import.meta.env.DEV || !Number.isInteger(size) || size < 1) return;
    let active = true;
    void import('./synthOverview').then(({ synthOverview }) => { if (active) setStress(synthOverview(Math.min(size, 2000), { edgesPerNode: 3, now: Date.now() })); });
    return () => { active = false; };
  }, []);
  return stress;
}

const reducedMotionQuery = () => (typeof window !== 'undefined' && typeof window.matchMedia === 'function' ? window.matchMedia('(prefers-reduced-motion: reduce)') : null);
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() => reducedMotionQuery()?.matches ?? false);
  useEffect(() => {
    const query = reducedMotionQuery();
    if (!query) return;
    const change = () => setReduced(query.matches);
    query.addEventListener('change', change);
    return () => query.removeEventListener('change', change);
  }, []);
  return reduced;
}

export interface VaultGraphViewProps {
  t: Messages;
  overview: Loaded<KnowledgeOverview>;
  selectedId: string | null;
  onOpen: (nodeId: string) => void;
  onClose: () => void;
  /** The existing note view, shown in the side panel (bottom sheet on phones) while a note is selected. */
  notePanel: ReactNode;
  /** For tests: the clock of the time filter. */
  now?: number;
}

export function VaultGraphView(props: VaultGraphViewProps) {
  const k = props.t.knowledge.vaultGraph;
  const stress = useStressOverview();
  const overview = stress ?? props.overview.value;
  if (!overview) {
    return props.overview.error
      ? <section className="card"><p className="form-error" role="alert"><Icon name="alert" />{props.overview.error}</p></section>
      : <section className="card"><p className="muted" role="status">{k.loading}</p></section>;
  }
  if (!overview.nodes.length) return <section className="card empty-state" data-state="vault-empty"><p className="muted">{k.empty}</p></section>;
  return <VaultGraphLoaded {...props} overview={overview} />;
}

function VaultGraphLoaded({ t, overview, selectedId, onOpen, onClose, notePanel, now: givenNow }: Omit<VaultGraphViewProps, 'overview'> & { overview: KnowledgeOverview }) {
  const k = t.knowledge.vaultGraph;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<number | null>(null);
  const [colourMode, setColourMode] = useState<ColourMode>('folder');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [showLabels, setShowLabels] = useState(true);
  const [showHalos, setShowHalos] = useState(true);
  const [now] = useState(() => givenNow ?? Date.now());
  const reducedMotion = usePrefersReducedMotion();
  const [showFps] = useState(() => devFlag('graphfps') !== null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();

  const graph: VaultGraph = useMemo(() => prepareVaultGraph(overview), [overview]);
  const colours = useMemo(() => assignColours(graph.nodes, colourMode), [graph, colourMode]);
  const mask = useMemo(() => timeMask(graph.nodes, timeWindow, now), [graph, timeWindow, now]);
  const shownCount = useMemo(() => mask.reduce((sum, value) => sum + value, 0), [mask]);
  const results = useMemo(() => (query.trim() ? rankSearch(graph, query, 50, mask) : null), [graph, query, mask]);
  const selected = selectedId !== null ? graph.indexById.get(selectedId) ?? null : null;
  const activeIndex = results && active !== null ? results[active] ?? null : null;

  // `/` focuses the search; Escape closes the note (or clears the search when no note is open).
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); search.current?.focus(); return; }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (selectedId !== null) { onClose(); return; }
        if (target === search.current && query) { setQuery(''); setActive(null); }
      }
    };
    globalThis.addEventListener('keydown', key);
    return () => globalThis.removeEventListener('keydown', key);
  }, [selectedId, onClose, query]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!results?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive(current => (current === null ? (step > 0 ? 0 : results.length - 1) : (current + step + results.length) % results.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      onOpen(graph.nodes[activeIndex ?? results[0]!]!.nodeId);
    }
  };

  const groupLabel = (key: string) => key || (colourMode === 'folder' ? k.root : k.none);
  const row = (index: number, extra?: string) => {
    const node = graph.nodes[index]!;
    return (
      <li key={index}>
        <button type="button" className={`vault-graph-row ${extra ?? ''}`} aria-current={index === selected ? 'true' : undefined} onClick={() => onOpen(node.nodeId)}>
          <span className="vault-graph-dot" style={{ background: colours.colours[index] }} aria-hidden="true" />
          <span className="vault-graph-row-title">{node.title}</span>
          <span className="muted small">{node.folder || k.root} · {k.links(graph.degree[index]!)}</span>
        </button>
      </li>
    );
  };
  const hubs = graph.hubs.filter(index => mask[index]).slice(0, HUB_LIST);
  const linkCount = graph.edges.length / 2;

  return (
    <section className={`vault-graph ${selectedId ? 'has-selection' : ''}`} aria-label={k.whole}>
      <div className="card vault-graph-toolbar">
        <div className="vault-graph-search" role="search">
          <input ref={search} type="search" className="search" value={query} placeholder={`${k.search}  /`} aria-label={k.search} maxLength={200}
            role="combobox" aria-expanded={Boolean(results?.length)} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={activeIndex !== null ? `${listId}-${activeIndex}` : undefined}
            onChange={event => { setQuery(event.target.value); setActive(null); }} onKeyDown={onSearchKey} />
          {results && (
            <ul className="vault-graph-results" id={listId} role="listbox" aria-label={k.results}>
              {results.length === 0 && <li className="muted small" role="presentation">{k.noMatches(query.trim())}</li>}
              {results.slice(0, RESULT_LIST).map((index, at) => (
                <li key={index} id={`${listId}-${index}`} role="option" aria-selected={at === active}>
                  <button type="button" tabIndex={-1} className="vault-graph-row" onMouseEnter={() => setActive(at)} onClick={() => onOpen(graph.nodes[index]!.nodeId)}>
                    <span className="vault-graph-dot" style={{ background: colours.colours[index] }} aria-hidden="true" />
                    <span className="vault-graph-row-title">{graph.nodes[index]!.title}</span>
                    <span className="muted small">{graph.nodes[index]!.folder || k.root}</span>
                  </button>
                </li>
              ))}
              {results.length > RESULT_LIST && <li className="muted small" role="presentation">{k.matches(results.length)}</li>}
            </ul>
          )}
        </div>
        <div className="segmented vault-graph-time" role="group" aria-label={k.time}>
          {TIME_WINDOWS.map(item => (
            <button key={item} type="button" className="chip-button" aria-pressed={timeWindow === item} title={k.timeTitles[item]} onClick={() => setTimeWindow(item)}>{k.timeWindows[item]}</button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label={k.colour}>
          {COLOUR_MODES.map(mode => <button key={mode} type="button" className="chip-button" aria-pressed={colourMode === mode} onClick={() => setColourMode(mode)}>{k.colourModes[mode]}</button>)}
        </div>
        <div className="vault-graph-toggles">
          <button type="button" className="chip-button" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}>{k.labels}</button>
          <button type="button" className="chip-button" aria-pressed={showHalos} onClick={() => setShowHalos(value => !value)}>{k.halos}</button>
        </div>
        <p className="muted small vault-graph-counts">
          {k.counts(shownCount, linkCount)}
          {graph.truncated && <> · {k.truncated(graph.nodes.length, graph.totalNodes)}</>}
          {shownCount < graph.nodes.length && <> · {k.hidden(graph.nodes.length - shownCount)}</>}
        </p>
        <p className="visually-hidden" role="status">{results ? (results.length ? k.matches(results.length) : k.noMatches(query.trim())) : ''}</p>
      </div>
      <div className="vault-graph-body">
        <div className="vault-graph-stage" role="group" aria-label={k.canvasLabel(shownCount, linkCount)}>
          <CanvasBoundary fallback={<p className="vault-graph-webgl">{k.webgl}</p>}>
            <Suspense fallback={<p className="vault-graph-webgl" role="status">{k.loading}</p>}>
              <VaultGraphCanvas graph={graph} colours={colours.colours} mask={mask} selected={selected} highlight={results} activeResult={activeIndex}
                showLabels={showLabels} showHalos={showHalos} reducedMotion={reducedMotion} showFps={showFps}
                onSelect={index => onOpen(graph.nodes[index]!.nodeId)} />
            </Suspense>
          </CanvasBoundary>
          <ul className="vault-graph-legend" aria-label={k.colour}>
            {colours.legend.map(group => <li key={group.key}><span className="vault-graph-dot" style={{ background: group.colour }} aria-hidden="true" />{groupLabel(group.key)}<span>{group.count}</span></li>)}
            {colours.other > 0 && <li><span className="vault-graph-dot" style={{ background: GRAPH_OTHER_COLOUR }} aria-hidden="true" />{k.other}<span>{colours.other}</span></li>}
          </ul>
          <p className="vault-graph-hint" aria-hidden="true">{k.hint}</p>
        </div>
        {selectedId && <aside className="vault-graph-panel" aria-label={t.knowledge.title}>{notePanel}</aside>}
      </div>
      <details className="card vault-graph-list">
        <summary><Icon name="logs" />{k.listView}</summary>
        <p className="muted small">{k.searchHint}</p>
        {results && results.length > 0 && (
          <section aria-label={k.results}>
            <h3>{k.results}</h3>
            <ul>{results.slice(0, HUB_LIST).map(index => row(index))}</ul>
          </section>
        )}
        <section aria-label={k.hubs}>
          <h3>{k.hubs}</h3>
          <ul>{hubs.map(index => row(index))}</ul>
        </section>
      </details>
    </section>
  );
}
