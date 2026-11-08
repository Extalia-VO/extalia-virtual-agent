import type * as React from 'react';
import { isValidElement, type ReactElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeOverview, KnowledgeOverviewNode } from '@extalia/platform';
import { MESSAGES } from '../src/i18n';
import { GraphExploreControls, type GraphExploreControlsProps } from '../src/knowledge/vault/GraphExploreControls';
import { GraphFilterControls, GraphSelectedNotePanel } from '../src/knowledge/vault/GraphFilterControls';
import { VaultGraphView, type VaultGraphViewProps } from '../src/knowledge/vault/VaultGraphView';
import { EMPTY_GRAPH_FILTERS } from '../src/knowledge/vault/graphFilters';
import type { VaultGraphCanvasProps } from '../src/knowledge/vault/VaultGraphCanvas';

// Exercise the real view state and event handlers without requiring a WebGL DOM.
const hooks = vi.hoisted(() => ({ index: 0, dirty: false, state: [] as unknown[], memo: new Map<number, { deps: unknown[]; value: unknown }>(), effects: new Map<number, { deps: unknown[]; cleanup?: () => void }>(), pending: [] as (() => void)[] }));
vi.mock('react', async original => {
  const same = (a: unknown[] | undefined, b: unknown[]) => a?.length === b.length && a.every((item, i) => Object.is(item, b[i]));
  return { ...await original<typeof React>(),
    useState: (initial: unknown) => {
      const id = hooks.index++;
      if (!(id in hooks.state)) hooks.state[id] = typeof initial === 'function' ? initial() : initial;
      return [hooks.state[id], (next: unknown) => {
        const value = typeof next === 'function' ? next(hooks.state[id]) : next;
        if (!Object.is(value, hooks.state[id])) { hooks.state[id] = value; hooks.dirty = true; }
      }];
    },
    useMemo: (compute: () => unknown, deps: unknown[]) => {
      const id = hooks.index++, prior = hooks.memo.get(id);
      if (!prior || !same(prior.deps, deps)) hooks.memo.set(id, { deps, value: compute() });
      return hooks.memo.get(id)!.value;
    },
    useRef: (initial: unknown) => { const id = hooks.index++; return hooks.state[id] ??= { current: initial }; },
    useEffect: (run: () => void | (() => void), deps: unknown[]) => {
      const id = hooks.index++, prior = hooks.effects.get(id);
      if (same(prior?.deps, deps)) return;
      const entry = { deps } as { deps: unknown[]; cleanup?: () => void };
      hooks.effects.set(id, entry);
      hooks.pending.push(() => { prior?.cleanup?.(); entry.cleanup = run() || undefined; });
    },
    useId: () => 'explore-test',
  };
});

function elements(node: ReactNode): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<Record<string, unknown>>(node)) return [];
  return [node, ...elements(node.props.children as ReactNode)];
}
const text = (node: ReactNode): string => typeof node === 'string' || typeof node === 'number' ? String(node)
  : Array.isArray(node) ? node.map(text).join('') : isValidElement<{ children?: ReactNode }>(node) ? text(node.props.children) : '';
const at = '2026-11-08T00:00:00Z';
const note = (nodeId: string, title: string, folder: string): KnowledgeOverviewNode => ({ nodeId, title, path: `${folder}/${nodeId}.md`, folder, tags: [], degree: 1, inDegree: 0, outDegree: 1, modifiedAt: at });
const overview = (): KnowledgeOverview => ({ generation: 1, totalNodes: 3, totalEdges: 1, truncated: false,
  nodes: [note('a', 'Alpha note', 'Notes'), note('b', 'Beta note', 'Notes'), note('c', 'Other note', 'Other')], edges: [{ source: 'a', target: 'b', type: 'links_to' }] });
const listeners = new Map<string, (event: unknown) => void>();

function harness(language: 'en' | 'id' = 'en', selectedId: string | null = 'a') {
  const props: VaultGraphViewProps = { t: MESSAGES[language], overview: { loading: false, value: overview() }, selectedId, onOpen: vi.fn(), onClose: vi.fn(), notePanel: 'NOTE CONTENT', now: Date.parse(at) };
  const root = { contains: (target: { owned?: boolean }) => target.owned === true };
  const render = () => {
    let tree!: ReactNode;
    do {
      hooks.index = 0; hooks.dirty = false;
      const shell = VaultGraphView(props) as ReactElement<Record<string, unknown>>;
      tree = typeof shell.type === 'function' ? (shell.type as (props: Record<string, unknown>) => ReactNode)(shell.props) : shell;
      const ref = (tree as ReactElement<{ ref: { current: unknown } }>).props.ref;
      if (ref) ref.current = root;
      for (const run of hooks.pending.splice(0)) run();
    } while (hooks.dirty);
    return tree;
  };
  const controls = () => elements(render()).find(node => node.type === GraphExploreControls)!.props as unknown as GraphExploreControlsProps;
  const canvas = () => elements(render()).find(node => node.props.graph && typeof node.props.onSelect === 'function')!.props as unknown as VaultGraphCanvasProps;
  const button = (label: string) => {
    const found = elements(render()).find(node => node.type === 'button' && text(node.props.children as ReactNode) === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found.props;
  };
  const click = (label: string) => (button(label).onClick as () => void)();
  const controlClick = (label: string) => {
    const button = elements(GraphExploreControls(controls())).find(node => node.type === 'button' && text(node.props.children as ReactNode) === label);
    if (!button) throw new Error(`Missing Explore button ${label}`);
    (button.props.onClick as () => void)();
  };
  const selectCanvas = (id: string) => { const view = canvas(); view.onSelect(view.graph.indexById.get(id)!); };
  const key = (key: string, target: unknown) => { const event = { key, target, preventDefault: vi.fn(), defaultPrevented: false }; listeners.get('keydown')!(event); return event; };
  return { props, render, controls, canvas, button, click, controlClick, selectCanvas, key };
}

beforeEach(() => {
  hooks.index = 0; hooks.dirty = false; hooks.state = []; hooks.memo.clear(); hooks.effects.clear(); hooks.pending = []; listeners.clear();
  vi.stubGlobal('addEventListener', (name: string, listener: (event: unknown) => void) => listeners.set(name, listener));
  vi.stubGlobal('removeEventListener', (name: string, listener: (event: unknown) => void) => { if (listeners.get(name) === listener) listeners.delete(name); });
});
afterEach(() => { for (const value of hooks.effects.values()) value.cleanup?.(); vi.unstubAllGlobals(); });

describe('graph Explore view navigation', () => {
  it.each(['en', 'id'] as const)('travels without opening notes, opens only explicitly, and restores 2D in %s', language => {
    const h = harness(language), k = h.props.t.knowledge.vaultGraph;
    h.click('2D'); h.click(k.explore);
    expect(h.canvas().dimensions).toBe(3);
    expect(h.canvas().explore?.current).toBe(h.canvas().graph.indexById.get('a'));
    expect(h.button('2D').disabled).toBe(true);
    expect(elements(h.render()).some(node => node.type === GraphSelectedNotePanel)).toBe(false);
    expect(h.controls().neighbours.map(note => note.nodeId)).toEqual(['b']);
    const controls = GraphExploreControls(h.controls());
    const travel = elements(controls).find(node => node.props['aria-label'] === k.exploreTravel('Beta note'))!;
    (travel.props.onClick as () => void)();
    expect(h.controls().currentTitle).toBe('Beta note');
    expect(h.props.onOpen).not.toHaveBeenCalled();
    h.controlClick(k.exploreBack); expect(h.controls().currentTitle).toBe('Alpha note');
    h.controlClick(k.exploreOpen); expect(h.props.onOpen).toHaveBeenCalledExactlyOnceWith('a');
    expect(elements(h.render()).some(node => node.type === GraphSelectedNotePanel)).toBe(true);
    h.controls().onNavigate('b');
    expect(elements(h.render()).some(node => node.type === GraphSelectedNotePanel)).toBe(false);
    h.controlClick(k.exploreExit); expect(h.canvas().dimensions).toBe(2); expect(h.canvas().explore).toBeNull();
  });

  it('waits for an explicit visible starting choice and distinguishes canvas hops from search/list jumps', () => {
    const h = harness('en', null), k = h.props.t.knowledge.vaultGraph;
    h.click(k.explore); expect(h.controls().status).toBe('choosing'); expect(h.canvas().explore?.current).toBeNull();
    h.selectCanvas('a'); expect(h.controls().currentTitle).toBe('Alpha note');
    h.selectCanvas('c'); expect(h.controls().currentTitle).toBe('Alpha note');
    const input = () => elements(h.render()).find(node => node.type === 'input' && node.props.type === 'search')!.props;
    (input().onChange as (event: unknown) => void)({ target: { value: 'Other' } });
    (input().onKeyDown as (event: unknown) => void)({ key: 'Enter', preventDefault: vi.fn() });
    expect(h.controls().currentTitle).toBe('Other note');
    h.click('Alpha noteNotes · 1 link'); expect(h.controls().currentTitle).toBe('Alpha note');
    expect(h.props.onOpen).not.toHaveBeenCalled();
    h.controlClick(k.exploreRelease); expect(h.controls().status).toBe('choosing'); expect(h.controls().trail).toEqual([]);
  });

  it.each(['en', 'id'] as const)('keeps filtered and removed current notes recoverable without hidden titles in %s', language => {
    const h = harness(language), k = h.props.t.knowledge.vaultGraph;
    h.click(k.explore);
    h.controlClick(k.exploreOpen);
    h.click(k.controls);
    const filters = elements(h.render()).find(node => node.type === GraphFilterControls)!.props;
    (filters.onChange as (next: unknown) => void)({ ...EMPTY_GRAPH_FILTERS, folder: 'Other' });
    expect(h.controls().status).toBe('filtered'); expect(h.canvas().explore?.current).toBeNull();
    const filtered = renderToStaticMarkup(GraphExploreControls(h.controls()));
    expect(filtered).toContain(k.exploreFiltered); expect(filtered).not.toContain('Alpha note'); expect(filtered).not.toContain(k.exploreOpen);
    const panel = elements(h.render()).find(node => node.type === GraphSelectedNotePanel)!.props;
    expect(panel.visible).toBe(false);
    expect(renderToStaticMarkup(GraphSelectedNotePanel(panel as unknown as Parameters<typeof GraphSelectedNotePanel>[0]))).not.toContain('NOTE CONTENT');
    h.controlClick(k.exploreRelease); h.selectCanvas('c'); expect(h.controls().currentTitle).toBe('Other note');
    h.props.overview = { loading: false, value: { ...overview(), nodes: [], edges: [] } };
    expect(h.controls().status).toBe('missing');
    const missing = renderToStaticMarkup(GraphExploreControls(h.controls()));
    expect(missing).toContain(k.exploreMissing); expect(missing).not.toContain('Other note'); expect(missing).toContain(k.exploreRelease); expect(missing).toContain(k.exploreExit);
  });

  it('leaves Backspace editing and unrelated focus alone, and gives Escape priority over note closure', () => {
    const h = harness(), k = h.props.t.knowledge.vaultGraph;
    h.click(k.explore); h.selectCanvas('b'); h.render();
    const target = (patch: Record<string, unknown> = {}) => ({ tagName: 'BUTTON', owned: true, closest: () => null, ...patch });
    for (const patch of [{ tagName: 'INPUT' }, { tagName: 'TEXTAREA' }, { tagName: 'SELECT' }, { isContentEditable: true }, { owned: false }, { closest: () => ({}) }]) {
      expect(h.key('Backspace', target(patch)).preventDefault).not.toHaveBeenCalled(); expect(h.controls().currentTitle).toBe('Beta note');
    }
    expect(h.key('Backspace', target()).preventDefault).toHaveBeenCalledOnce(); expect(h.controls().currentTitle).toBe('Alpha note');
    h.key('Escape', target()); expect(h.controls().status).toBe('off'); expect(h.props.onClose).not.toHaveBeenCalled();
  });

  it('preserves editors and outside dialogs on Escape, while graph search can exit Explore', () => {
    const h = harness(), k = h.props.t.knowledge.vaultGraph;
    h.click(k.explore); h.controlClick(k.exploreOpen); h.render();
    for (const target of [
      { tagName: 'TEXTAREA', owned: true },
      { tagName: 'INPUT', owned: true },
      { tagName: 'DIV', owned: true, isContentEditable: true },
      { tagName: 'BUTTON', owned: false },
      { tagName: 'TEXTAREA', owned: false },
    ]) {
      expect(h.key('Escape', target).preventDefault).not.toHaveBeenCalled();
      expect(h.controls().status).toBe('active');
      expect(elements(h.render()).some(node => node.type === GraphSelectedNotePanel)).toBe(true);
      expect(h.props.onClose).not.toHaveBeenCalled();
    }
    const search = elements(h.render()).find(node => node.type === 'input' && node.props.type === 'search')!;
    const target = { tagName: 'INPUT', owned: true };
    (search.props.ref as { current: unknown }).current = target;
    expect(h.key('Escape', target).preventDefault).toHaveBeenCalledOnce();
    expect(h.controls().status).toBe('off');
    expect(h.props.onClose).not.toHaveBeenCalled();
  });

  it.each(['en', 'id'] as const)('renders compact accessible trail and isolated-note feedback in %s', language => {
    const h = harness(language, null), k = h.props.t.knowledge.vaultGraph;
    h.click(k.explore); h.selectCanvas('c');
    const html = renderToStaticMarkup(GraphExploreControls(h.controls()));
    for (const label of [k.exploreTrail, k.exploreNeighbours, k.exploreNoNeighbours, k.exploreBack, k.exploreOpen, k.exploreExit]) expect(html).toContain(label);
    expect(html).toContain('aria-current="step"'); expect(html).toContain('disabled=""');
  });
});
