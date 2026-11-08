import { Select } from '../../ui/Select';
import './vaultGraph.css';
import type { KnowledgeOverview } from '@extalia/platform';
import { Component, lazy, Suspense, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { Messages } from '../../i18n';
import type { Loaded } from '../../inspect/useLoad';
import { Icon } from '../../ui/Icon';
import { GraphAppearanceControls } from './GraphAppearanceControls';
import { GraphExploreControls } from './GraphExploreControls';
import { createGraphExploreState, projectGraphExplore, reduceGraphExplore, type GraphExploreAction } from './graphExplore';
import { GRAPH_PRESETS, type GraphAppearance } from './graphAppearance';
import { GraphFocusTrail, GraphSelectionTools } from './GraphSelectionTools';
import { GraphFilterControls, GraphSelectedNotePanel } from './GraphFilterControls';
import { EMPTY_GRAPH_FILTERS, graphFacetMask, graphFacetOptions, hasGraphFilters, visibleGraphDegrees, type GraphFacetFilters } from './graphFilters';
import { focusGraph, visibleColourLegend, visibleLinkCount, type FocusHops } from './graphFocus';
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
  return <VaultGraphLoaded {...props} overview={overview} />;
}

function VaultGraphLoaded({ t, overview, selectedId, onOpen, onClose, notePanel, now: givenNow }: Omit<VaultGraphViewProps, 'overview'> & { overview: KnowledgeOverview }) {
  const k = t.knowledge.vaultGraph;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState<string | null>(null);
  const [focusRoot, setFocusRoot] = useState<{ nodeId: string } | null>(null);
  const [focusHops, setFocusHops] = useState<FocusHops>(1);
  const [colourMode, setColourMode] = useState<ColourMode>('cluster');
  const [timeWindow, setTimeWindow] = useState<TimeWindow>('all');
  const [filters, setFilters] = useState<GraphFacetFilters>(() => ({ ...EMPTY_GRAPH_FILTERS }));
  const [appearance, setAppearance] = useState<GraphAppearance>(() => ({ ...GRAPH_PRESETS.nebula }));
  const [dimensions, setDimensions] = useState<2 | 3>(3);
  const [explore, setExplore] = useState(createGraphExploreState);
  const [exploreReadId, setExploreReadId] = useState<string | null>(null);
  // Keep the user's dimension preference intact during the temporary 3D tour.
  const effectiveDimensions = explore.enabled ? 3 : dimensions;
  const [controlsOpen, setControlsOpen] = useState(() => typeof window !== 'undefined' && window.innerWidth >= 1000);
  const [expanded, setExpanded] = useState(false);
  const explorer = useRef<HTMLElement>(null);
  // Glass surfaces establish their own fixed containing block. Measure its actual
  // top so expanded camera controls stay in view below the mobile navigation too.
  useEffect(() => {
    const element = explorer.current;
    if (!expanded || !element) return;
    const fit = () => element.style.setProperty('--graph-expanded-height', `${Math.max(180, window.innerHeight - element.getBoundingClientRect().top - 16)}px`);
    fit();
    window.addEventListener('resize', fit);
    window.addEventListener('scroll', fit, true);
    const observer = new MutationObserver(fit);
    observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'data-material', 'class'] });
    return () => { observer.disconnect(); window.removeEventListener('resize', fit); window.removeEventListener('scroll', fit, true); element.style.removeProperty('--graph-expanded-height'); };
  }, [expanded]);
  const [cameraAction, setCameraAction] = useState<{ kind: 'fit' | 'in' | 'out'; revision: number }>({ kind: 'fit', revision: 0 });
  const camera = (kind: 'fit' | 'in' | 'out') => setCameraAction(current => ({ kind, revision: current.revision + 1 }));
  const [showLabels, setShowLabels] = useState(true);
  const [showHalos, setShowHalos] = useState(true);
  const [returnToLayout, setReturnToLayout] = useState(true);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const [now] = useState(() => givenNow ?? Date.now());
  const reducedMotion = usePrefersReducedMotion();
  const [showFps] = useState(() => devFlag('graphfps') !== null);
  const search = useRef<HTMLInputElement>(null);
  const listId = useId();
  const controlsId = useId();

  const graph: VaultGraph = useMemo(() => prepareVaultGraph(overview), [overview]);
  const colours = useMemo(() => assignColours(graph.nodes, colourMode, graph), [graph, colourMode]);
  const filterOptions = useMemo(() => graphFacetOptions(graph.nodes), [graph]);
  const baseMask = useMemo(() => graphFacetMask(graph.nodes, filters, timeMask(graph.nodes, timeWindow, now)), [graph, filters, timeWindow, now]);
  const focus = useMemo(() => focusGraph(graph, baseMask, focusRoot?.nodeId ?? null, focusHops), [graph, baseMask, focusRoot?.nodeId, focusHops]);
  const mask = focus.mask;
  const exploration = useMemo(() => projectGraphExplore(explore, graph, mask), [explore, graph, mask]);
  const exploreAction = (action: GraphExploreAction) => {
    setExplore(current => reduceGraphExplore(current, action, { graph, mask }));
    setExploreReadId(null);
  };
  const chooseNote = (nodeId: string, jump = false) => {
    if (explore.enabled) exploreAction({ type: 'navigate', nodeId, jump });
    else onOpen(nodeId);
  };
  const exploreNote = (index: number) => ({ nodeId: graph.nodes[index]!.nodeId, title: graph.nodes[index]!.title });
  const legend = useMemo(() => visibleColourLegend(colours, mask), [colours, mask]);
  const shownCount = useMemo(() => mask.reduce((sum, value) => sum + value, 0), [mask]);
  const visibleDegrees = useMemo(() => visibleGraphDegrees(graph, mask), [graph, mask]);
  const results = useMemo(() => (query.trim() ? rankSearch(graph, query, 50, mask) : null), [graph, query, mask]);
  const selected = selectedId !== null ? graph.indexById.get(selectedId) ?? null : null;
  const activeCandidate = active === null ? undefined : graph.indexById.get(active);
  const activeIndex = activeCandidate !== undefined && results?.slice(0, RESULT_LIST).includes(activeCandidate) ? activeCandidate : null;
  const selectedNode = selected !== null && baseMask[selected] === 1 ? graph.nodes[selected]! : null;
  const selectedVisible = selected !== null && mask[selected] === 1;
  const rootTitle = focus.status === 'active' && focus.root !== null ? graph.nodes[focus.root]!.title : null;
  const focusSelected = () => {
    if (selectedVisible && selectedNode) {
      setFocusRoot({ nodeId: selectedNode.nodeId });
      setActive(null);
    }
  };

  // Explore owns Escape from graph controls and search. Editing fields and
  // unrelated dialogs keep their own Escape; Backspace also requires graph focus.
  useEffect(() => {
    const key = (event: globalThis.KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = !!target && (target.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName));
      if (event.key === '/' && !typing && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); search.current?.focus(); return; }
      if (event.key === 'Escape' && !event.defaultPrevented) {
        if (explore.enabled) {
          if (!target || !explorer.current?.contains(target) || (typing && target !== search.current)) return;
          event.preventDefault();
          setExplore(current => reduceGraphExplore(current, { type: 'exit' }, { graph, mask }));
          setExploreReadId(null);
          return;
        }
        if (selectedId !== null) { onClose(); return; }
        if (expanded) { setExpanded(false); return; }
        if (target === search.current && query) { setQuery(''); setActive(null); }
      }
      if (event.key === 'Backspace' && explore.enabled && !typing && !event.defaultPrevented && !event.metaKey && !event.ctrlKey && !event.altKey
        && target && explorer.current?.contains(target) && !target.closest('.vault-graph-panel') && exploration.canGoBack) {
        event.preventDefault();
        setExplore(current => reduceGraphExplore(current, { type: 'back' }, { graph, mask }));
        setExploreReadId(null);
      }
    };
    globalThis.addEventListener('keydown', key);
    return () => globalThis.removeEventListener('keydown', key);
  }, [selectedId, onClose, query, expanded, explore.enabled, exploration.canGoBack, graph, mask]);

  const onSearchKey = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!results?.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      const reachable = results.slice(0, RESULT_LIST);
      const current = activeIndex === null ? -1 : reachable.indexOf(activeIndex);
      const next = current < 0 ? (step > 0 ? 0 : reachable.length - 1) : (current + step + reachable.length) % reachable.length;
      setActive(graph.nodes[reachable[next]!]!.nodeId);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      chooseNote(graph.nodes[activeIndex ?? results[0]!]!.nodeId, true);
    }
  };

  const groupLabel = (key: string) => colourMode === 'cluster' ? k.clusterGroup(key) : key || (colourMode === 'folder' ? k.root : k.none);
  const row = (index: number, extra?: string) => {
    const node = graph.nodes[index]!;
    return (
      <li key={index}>
        <button type="button" className={`vault-graph-row ${extra ?? ''}`} aria-current={index === (explore.enabled ? exploration.current : selected) ? 'true' : undefined} onClick={() => chooseNote(node.nodeId, true)}>
          <span className="vault-graph-dot" style={{ background: colours.colours[index] }} aria-hidden="true" />
          <span className="vault-graph-row-title">{node.title}</span>
          <span className="muted small">{node.folder || k.root} · {k.links(visibleDegrees[index]!)}</span>
        </button>
      </li>
    );
  };
  const hubs = graph.hubs.filter(index => mask[index]).slice(0, HUB_LIST);
  const linkCount = useMemo(() => visibleLinkCount(graph, mask), [graph, mask]);

  // Keep the rooted view mounted when sync removes every note, so the user can
  // still see why the focus is unavailable and explicitly clear it.
  if (!graph.nodes.length && focusRoot === null && selectedId === null && !hasGraphFilters(filters) && !explore.enabled) return <section className="card empty-state" data-state="vault-empty"><p className="muted">{k.empty}</p></section>;

  const showNotePanel = selectedId !== null && (!explore.enabled || exploreReadId === selectedId);

  return (
    <section ref={explorer} tabIndex={-1} className={`vault-graph vault-graph-explorer ${showNotePanel ? 'has-selection' : ''} ${explore.enabled ? 'is-exploring' : ''} ${expanded ? 'expanded' : ''}`} aria-label={k.whole}>
      <GraphFocusTrail t={t} status={focus.status} rootTitle={rootTitle} hops={focusHops}
        onHops={depth => { setFocusHops(depth); setActive(null); }}
        onClear={() => { setFocusRoot(null); setActive(null); }} />
      <GraphExploreControls t={t} status={exploration.status} currentTitle={exploration.current === null ? null : graph.nodes[exploration.current]!.title}
        trail={exploration.trail.map(exploreNote)} neighbours={exploration.neighbours.map(exploreNote)} canGoBack={exploration.canGoBack}
        onBack={() => exploreAction({ type: 'back' })} onRelease={() => exploreAction({ type: 'release' })} onExit={() => exploreAction({ type: 'exit' })}
        onNavigate={nodeId => chooseNote(nodeId)} onOpen={() => {
          if (exploration.current === null) return;
          const nodeId = graph.nodes[exploration.current]!.nodeId;
          setExploreReadId(nodeId);
          onOpen(nodeId);
        }} />
      <div className="vault-graph-body">
        <div className="vault-graph-stage" role="group" aria-label={k.canvasLabel(shownCount, linkCount)}>
      <div className="vault-graph-toolbar">
        <div className="vault-graph-search" role="search">
          <input ref={search} type="search" className="search" value={query} placeholder={`${k.search}  /`} aria-label={k.search} maxLength={200}
            role="combobox" aria-expanded={Boolean(results?.length)} aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={activeIndex !== null ? `${listId}-${activeIndex}` : undefined}
            onChange={event => { setQuery(event.target.value); setActive(null); }} onKeyDown={onSearchKey} />
          {results && (
            <ul className="vault-graph-results" id={listId} role="listbox" aria-label={k.results}>
              {results.length === 0 && <li className="muted small" role="presentation">{k.noMatches(query.trim())}</li>}
              {results.slice(0, RESULT_LIST).map(index => (
                <li key={index} id={`${listId}-${index}`} role="option" aria-selected={index === activeIndex}>
                  <button type="button" tabIndex={-1} className="vault-graph-row" onMouseEnter={() => setActive(graph.nodes[index]!.nodeId)} onClick={() => chooseNote(graph.nodes[index]!.nodeId, true)}>
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
        <div className="segmented graph-dimensions" role="group" aria-label={k.dimensions} aria-description={explore.enabled ? k.exploreDimensions : undefined} title={explore.enabled ? k.exploreDimensions : undefined}>
          {([2, 3] as const).map(value => <button key={value} type="button" className="chip-button" disabled={explore.enabled} aria-pressed={effectiveDimensions === value} onClick={() => setDimensions(value)}>{value}D</button>)}
        </div>
        <button type="button" className="chip-button graph-explore-toggle" aria-pressed={explore.enabled}
          onClick={() => exploreAction(explore.enabled ? { type: 'exit' } : { type: 'enter', ...(selectedVisible && selectedNode ? { nodeId: selectedNode.nodeId } : {}) })}>{k.explore}</button>
        <button type="button" className="chip-button graph-control-button" aria-expanded={controlsOpen} aria-controls={controlsId} onClick={() => setControlsOpen(value => !value)}><Icon name="settings" />{k.controls}</button>
        <button type="button" className="chip-button graph-expand" aria-pressed={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? k.collapse : k.expand}</button>
      </div>
      {controlsOpen && <aside id={controlsId} className="graph-control-panel" aria-label={k.controls}>
        <div className="graph-control-title"><strong>{k.appearance}</strong><button type="button" className="chip-button" aria-label={k.closeControls} onClick={() => setControlsOpen(false)}>×</button></div>
        <div className="segmented vault-graph-time" role="group" aria-label={k.time}>
          {TIME_WINDOWS.map(item => (
            <button key={item} type="button" className="chip-button" aria-pressed={timeWindow === item} title={k.timeTitles[item]} onClick={() => { setTimeWindow(item); setActive(null); }}>{k.timeWindows[item]}</button>
          ))}
        </div>
        <details className="graph-control-group"><summary>{k.filters}</summary><GraphFilterControls t={t} options={filterOptions} filters={filters} onChange={next => { setFilters(next); setActive(null); }}
          onClear={() => { setFilters({ ...EMPTY_GRAPH_FILTERS }); setActive(null); }} /></details>
        <div className="graph-colour-select"><span>{k.colour}</span><Select aria-label={k.colour} value={colourMode} onChange={setColourMode}
          options={COLOUR_MODES.map(mode => ({ value: mode, label: k.colourModes[mode] }))} /></div>
        <GraphAppearanceControls t={t} value={appearance} onChange={setAppearance} />
        <div className="vault-graph-toggles">
          <button type="button" className="chip-button" aria-pressed={showLabels} onClick={() => setShowLabels(value => !value)}>{k.labels}</button>
          <button type="button" className="chip-button" aria-pressed={showHalos} onClick={() => setShowHalos(value => !value)}>{k.halos}</button>
          <button type="button" className="chip-button" aria-pressed={returnToLayout} title={k.returnHint} onClick={() => setReturnToLayout(value => !value)}>{k.returnToLayout}</button>
          <button type="button" className="chip-button" title={k.restoreHint} onClick={() => setRestoreRevision(value => value + 1)}>{k.restoreLayout}</button>
        </div>
        {focus.status === 'none' && !selectedVisible && <p className="graph-cluster-note">{k.focusHint}</p>}
        <p className="graph-cluster-note">{k.clusterHint}</p>
      </aside>}
        <p className="muted small vault-graph-counts">
          {k.counts(shownCount, linkCount)}
          {graph.truncated && <> · {k.truncated(graph.nodes.length, graph.totalNodes)}</>}
          {shownCount < graph.nodes.length && <> · {k.hidden(graph.nodes.length - shownCount)}</>}
        </p>
        <p className="visually-hidden" role="status">{results ? (results.length ? k.matches(results.length) : k.noMatches(query.trim())) : ''}</p>
          <CanvasBoundary fallback={<p className="vault-graph-webgl">{k.webgl}</p>}>
            <Suspense fallback={<p className="vault-graph-webgl" role="status">{k.loading}</p>}>
              <VaultGraphCanvas graph={graph} colours={colours.colours} mask={mask} selected={selected} highlight={results} activeResult={activeIndex}
                showLabels={showLabels} showHalos={showHalos} reducedMotion={reducedMotion} showFps={showFps}
                appearance={appearance} dimensions={effectiveDimensions} cameraAction={cameraAction}
                explore={explore.enabled ? { current: exploration.current, revision: explore.revision } : null}
                returnToLayout={returnToLayout} restoreRevision={restoreRevision}
                onSelect={index => chooseNote(graph.nodes[index]!.nodeId)} />
            </Suspense>
          </CanvasBoundary>
          <details className="vault-graph-legend"><summary>{k.groups}</summary><ul aria-label={k.colour}>
            {legend.legend.map(group => <li key={group.key}><span className="vault-graph-dot" style={{ background: group.colour }} aria-hidden="true" />{groupLabel(group.key)}<span>{group.count}</span></li>)}
            {legend.other > 0 && <li><span className="vault-graph-dot" style={{ background: colourMode === 'cluster' ? 'linear-gradient(135deg, #7c9cff, #5eead4, #f472b6)' : GRAPH_OTHER_COLOUR }} aria-hidden="true" />{k.other}<span>{legend.other}</span></li>}
          </ul></details>
          <div className="graph-camera-tools" role="group" aria-label={k.camera}>
            <button type="button" className="chip-button" title={k.zoomIn} aria-label={k.zoomIn} onClick={() => camera('in')}>+</button>
            <button type="button" className="chip-button" title={k.zoomOut} aria-label={k.zoomOut} onClick={() => camera('out')}>−</button>
            <button type="button" className="chip-button" onClick={() => camera('fit')}>{k.fit}</button>
          </div>
          <p className="vault-graph-hint" aria-hidden="true">{explore.enabled ? (exploration.current === null ? k.exploreChoose : k.exploreCanvasHint) : dimensions === 2 ? k.hint2d : k.hint}</p>
        </div>
        {showNotePanel && <GraphSelectedNotePanel t={t} visible={selectedVisible} onClose={onClose}>
          {selectedVisible && selectedNode && <GraphSelectionTools t={t} title={selectedNode.title}
            focused={focusRoot?.nodeId === selectedNode.nodeId} onFocus={focusSelected} onClose={onClose} />}
          {notePanel}
        </GraphSelectedNotePanel>}
      </div>
      <details className="card vault-graph-list">
        <summary><Icon name="logs" />{k.listView}</summary>
        <p className="muted small">{explore.enabled ? k.exploreSearchHint : k.searchHint}</p>
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
