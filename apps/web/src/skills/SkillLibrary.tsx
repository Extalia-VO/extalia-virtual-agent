import { Select } from '../ui/Select';
import './skillLibrary.css';
import type { AgentHostApi, BuiltinSkillInfo, HostState, SkillRegistryReport } from '@extalia/platform';
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { Messages } from '../i18n';
import { errorMessage } from '../host/remote';
import { paginateBookText } from './skillBookMotion';
import { SkillBookNavigation } from './BookNavigationPanel';
import { bookPageIndex } from './skillBookNavigation';
import { CATALOG_FILTERS, type CatalogFilter } from './builtinCatalogModel';
import { loadSkillCatalogBatch, SkillCatalogChanged } from './skillCatalogLoading';
import { SkillCatalogPagination } from './SkillCatalogPagination';
import { BOOK_COLORS, BOOKS_PER_SHELF, DEFAULT_LIST_PAGE_SIZE, LIST_PAGE_SIZES, catalogPage, catalogPageForAnchor, createSkillBookIndex, filterSkillBookIndex, skillBooks, type BookSource, type SkillBook } from './skillLibraryModel';

const ShelfCanvas = lazy(() => import('./SkillShelfCanvas'));

export function SkillLibrary({ t, agents, state, builtin, refresh }: {
  t: Messages; agents: AgentHostApi; state: HostState; builtin: readonly BuiltinSkillInfo[]; refresh: number;
}) {
  const [loaded, setLoaded] = useState<{ agents: AgentHostApi; key: string; epoch: number; books: SkillBook[]; errors: string[]; registry?: SkillRegistryReport; cursor?: string }>();
  const [reload, setReload] = useState(0);
  const [busyEpoch, setBusyEpoch] = useState<number | null>(null);
  const epoch = useRef(0);
  const pendingEpoch = useRef<number | null>(null);
  const workspaceKey = JSON.stringify([state.profile.id, state.workspaces.map(workspace => [workspace.id, workspace.name, workspace.projectLocation])]);
  const requestKey = JSON.stringify([workspaceKey, refresh, reload]);
  useEffect(() => {
    let live = true;
    const requestEpoch = ++epoch.current;
    void (async () => {
      const errors: string[] = [];
      const registry = typeof agents.skillRegistry === 'function' ? await agents.skillRegistry().catch(error => { errors.push(errorMessage(error)); return undefined; }) : undefined;
      if (registry?.status === 'unavailable') errors.push(t.skillCenter.unavailable(registry.unavailableReason ?? 'unavailable'));
      const projects = registry?.mode === 'registry' || typeof agents.workspaceSkills !== 'function' ? []
        : (await Promise.all(state.workspaces.filter(workspace => workspace.projectLocation).map(async workspace => {
          try { return { name: workspace.name, report: await agents.workspaceSkills(workspace.id) }; }
          catch (error) { errors.push(`${workspace.name}: ${errorMessage(error)}`); return null; }
        }))).filter(item => item !== null);
      const cursor = registry?.nextCursor && typeof agents.skillRegistryPage === 'function' ? registry.nextCursor : undefined;
      if (registry?.truncated && !cursor) errors.push(t.skillCenter.truncated);
      if (live) setLoaded({ agents, key: requestKey, epoch: requestEpoch, books: skillBooks([], projects, registry), errors, ...(registry ? { registry: { ...registry, revisions: [] } } : {}), ...(cursor ? { cursor } : {}) });
    })();
    return () => { live = false; if (epoch.current === requestEpoch) epoch.current = requestEpoch + 1; };
    // Workspaces are keyed by identity, display name and location; unrelated live events do not reload.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agents, workspaceKey, refresh, reload, t]);
  const current = loaded?.agents === agents && loaded.key === requestKey ? loaded : undefined;
  const books = useMemo(() => [...skillBooks(builtin, []), ...(current?.books ?? [])], [builtin, current]);
  const loadMore = async () => {
    const selectedCatalog = current;
    if (!selectedCatalog?.cursor || !selectedCatalog.registry || !agents.skillRegistryPage || pendingEpoch.current === selectedCatalog.epoch) return;
    const token = selectedCatalog.epoch;
    pendingEpoch.current = token; setBusyEpoch(token);
    try {
      const generation = selectedCatalog.registry.indexGeneration;
      if (generation === undefined) throw new SkillCatalogChanged();
      const batch = await loadSkillCatalogBatch(cursor => agents.skillRegistryPage!({ cursor }), selectedCatalog.cursor, generation, () => epoch.current === token);
      if (!batch || epoch.current !== token) return;
      const additions = skillBooks([], [], { ...selectedCatalog.registry, revisions: batch.revisions });
      setLoaded(previous => {
        if (!previous || previous.epoch !== token) return previous;
        const unique = new Map(previous.books.map(book => [book.id, book]));
        for (const book of additions) unique.set(book.id, book);
        return { ...previous, books: [...unique.values()], cursor: batch.nextCursor, errors: [] };
      });
    } catch (error) {
      if (epoch.current === token) setLoaded(previous => previous?.epoch === token ? { ...previous, errors: [error instanceof SkillCatalogChanged ? t.skillLibrary.catalogChanged : errorMessage(error)] } : previous);
    } finally {
      if (pendingEpoch.current === token) pendingEpoch.current = null;
      if (epoch.current === token) setBusyEpoch(null);
    }
  };
  return <SkillLibraryView key={workspaceKey} t={t} books={books} loading={!current} errors={current?.errors ?? []} onRefresh={() => setReload(value => value + 1)} onLoadMore={current?.cursor ? loadMore : undefined} moreLoading={!!current && busyEpoch === current.epoch} />;
}

export function SkillLibraryView({ t, books, loading = false, errors = [], onRefresh, onLoadMore, moreLoading = false }: { t: Messages; books: readonly SkillBook[]; loading?: boolean; errors?: readonly string[]; onRefresh?: () => void; onLoadMore?: () => void; moreLoading?: boolean }) {
  const p = t.skillLibrary;
  const [view, setView] = useState<'shelf' | 'list'>('shelf');
  const [listPageSize, setListPageSize] = useState<number>(DEFAULT_LIST_PAGE_SIZE);
  const [query, setQuery] = useState('');
  const [source, setSource] = useState<BookSource | 'all'>('all');
  const [category, setCategory] = useState<CatalogFilter>('all');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState<string | null>(null);
  const searchIndex = useMemo(() => createSkillBookIndex(books), [books]);
  const shown = useMemo(() => filterSkillBookIndex(searchIndex, query, source, category), [searchIndex, query, source, category]);
  const pageSize = view === 'shelf' ? BOOKS_PER_SHELF : listPageSize;
  const pagination = catalogPage(shown.length, page, pageSize);
  const currentPage = pagination.page;
  const shelf = useMemo(() => shown.slice(pagination.start, pagination.end), [shown, pagination.start, pagination.end]);
  const selected = shown.find(book => book.id === selection);
  const [readingShelf, setReadingShelf] = useState<readonly SkillBook[] | null>(null);
  // Finish reading/closing on the same shelf; reveal appended covers after it rests.
  const displayShelf = view === 'shelf' && readingShelf && (selected || selection === null) ? readingShelf : shelf;
  const stage = useRef<HTMLDivElement>(null);
  const origin = useRef<HTMLElement | null>(null);
  const [readPage, setReadPage] = useState(0);
  const [compact, setCompact] = useState(false);
  const [webgl, setWebgl] = useState(true);
  const [textView, setTextView] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(false);
  const navigationButton = useRef<HTMLButtonElement>(null);
  const navigationId = useId();
  const selectedId = selected?.id;
  const hasBooks = shown.length > 0;
  useEffect(() => {
    if (!stage.current) return;
    const observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width ?? 0;
      if (width > 0) setCompact(width < 620);
    });
    observer.observe(stage.current);
    return () => observer.disconnect();
  }, [hasBooks]);
  const close = () => {
    setSelection(null); setTextView(false); setNavigationOpen(false);
    requestAnimationFrame(() => {
      const target = origin.current?.isConnected ? origin.current : stage.current;
      target?.focus({ preventScroll: true });
    });
  };
  const choose = (id: string) => {
    const focused = document.activeElement;
    origin.current = focused instanceof HTMLElement && focused.matches('.skill-book-choice, .skill-shelf-picker') ? focused : stage.current;
    if (origin.current === stage.current) stage.current?.focus({ preventScroll: true });
    if (view === 'shelf') setReadingShelf(displayShelf);
    setSelection(id); setReadPage(0); setTextView(false); setNavigationOpen(false);
  };
  const switchView = (next: 'shelf' | 'list') => {
    const anchor = selected ? shown.findIndex(book => book.id === selection) : pagination.start;
    setPage(catalogPageForAnchor(anchor, next === 'shelf' ? BOOKS_PER_SHELF : listPageSize));
    const nextPage = catalogPageForAnchor(anchor, BOOKS_PER_SHELF);
    setReadingShelf(next === 'shelf' && selected ? shown.slice(nextPage * BOOKS_PER_SHELF, (nextPage + 1) * BOOKS_PER_SHELF) : null);
    setNavigationOpen(false); setView(next);
  };
  const resizeList = (next: number) => {
    const anchor = selected ? shown.findIndex(book => book.id === selection) : pagination.start;
    setListPageSize(next); setPage(catalogPageForAnchor(anchor, next));
  };
  const clear = () => { setQuery(''); setCategory('all'); setSource('all'); setPage(0); setSelection(null); setReadingShelf(null); };
  const status = (book: SkillBook) => p.statuses[book.status] ?? t.skillCenter.states[book.status] ?? book.status;
  const label = selected ? status(selected) : '';
  const pages = useMemo(() => selected ? paginateBookText([
    selected.title, selected.description,
    `${p.source}: ${p.sources[selected.source]}\n${label}\n${p.category}: ${t.skillsPage.builtinCategories[selected.category]}`,
    selected.workspace ? `${p.workspace}: ${selected.workspace}` : '',
    selected.revision ? `${p.revision}: ${selected.revision}` : '',
    selected.digest ? `SHA-256: ${selected.digest}` : '',
    p.instructions, selected.body ?? p.metadataOnly,
  ].filter(Boolean).join('\n\n')) : [], [selected, p, label, t.skillsPage.builtinCategories]);
  const firstPage = bookPageIndex(readPage, pages.length, compact);
  const step = compact ? 1 : 2;
  const turn = (direction: -1 | 1) => {
    setReadPage(current => Math.max(0, Math.min(pages.length - 1, current + direction * step)));
  };
  const closeNavigation = () => {
    setNavigationOpen(false);
    requestAnimationFrame(() => navigationButton.current?.focus({ preventScroll: true }));
  };
  const jump = (target: number) => {
    setReadPage(bookPageIndex(target, pages.length, compact)); setNavigationOpen(false);
    requestAnimationFrame(() => stage.current?.focus({ preventScroll: true }));
  };
  const reader = useMemo(() => ({ id: selectedId ?? null, pages, page: firstPage, pageLabel: p.page }), [selectedId, pages, firstPage, p.page]);
  const fallback = view === 'list' || !webgl || textView;
  const visiblePages = compact ? [pages[firstPage]] : [pages[firstPage], pages[firstPage + 1]];
  return <section className="skill-library card" aria-labelledby="skill-library-title" onKeyDown={event => { if (event.key === 'Escape' && selectedId) { event.preventDefault(); if (navigationOpen) closeNavigation(); else close(); } }}>
    <div className="section-head"><div><p className="skill-library-eyebrow">{p.eyebrow}</p><h2 id="skill-library-title">{p.title}</h2><p className="muted small">{p.lead}</p></div>
      <div className="segmented" role="group" aria-label={p.view}>{(['shelf', 'list'] as const).map(item => <button key={item} type="button" className="chip-button" aria-pressed={view === item} onClick={() => switchView(item)}>{p.views[item]}</button>)}</div>
    </div>
    <div className="skill-library-tools">
      <label className="field"><span>{p.search}</span><input type="search" value={query} maxLength={200} placeholder={p.search} onChange={event => { setQuery(event.target.value); setPage(0); setSelection(null); setReadingShelf(null); }} /></label>
      <div className="field"><span>{p.source}</span><Select aria-label={p.source} value={source} onChange={value => { setSource(value); setPage(0); setSelection(null); setReadingShelf(null); }} options={(['all', 'builtin', 'project', 'registry'] as const).map(item => ({ value: item, label: p.sources[item] }))} /></div>
      <div className="field"><span>{p.category}</span><Select aria-label={p.category} value={category} onChange={value => { setCategory(value); setPage(0); setSelection(null); setReadingShelf(null); }} options={CATALOG_FILTERS.map(item => ({ value: item, label: t.skillsPage.builtinCategories[item] }))} /></div>
      {view === 'list' && <div className="field skill-page-size"><span>{p.pageSize}</span><Select aria-label={p.pageSize} value={String(listPageSize)} onChange={value => resizeList(Number(value))} options={LIST_PAGE_SIZES.map(size => ({ value: String(size), label: String(size) }))} /></div>}
      {view === 'shelf' && displayShelf.length > 0 && <div className="field"><span>{p.books}</span><Select aria-label={p.books} className="skill-shelf-picker" value={selected?.id ?? ''} placeholder={p.books} onChange={choose} options={displayShelf.map(book => ({ value: book.id, label: `${book.title} · ${book.workspace ?? p.sources[book.source]} · ${status(book)}` }))} /></div>}
      {(query || category !== 'all' || source !== 'all') && <button type="button" className="button small" onClick={clear}>{t.skillsPage.clearBuiltinFilters}</button>}
    </div>
    <div className="skill-catalog-load">{onRefresh && <button type="button" className="button small" disabled={loading || moreLoading} onClick={onRefresh}>{p.refreshCatalog}</button>}{onLoadMore && <><button type="button" className="button small" disabled={moreLoading} onClick={onLoadMore}>{moreLoading ? p.loadingMore : p.loadMore}</button><span className="muted small">{p.moreAvailable}</span></>}</div>
    <p className="muted small" role="status">{p.count(shown.length, books.length)}{shown.length > 0 ? ` · ${p.catalogRange(pagination.start + 1, pagination.start + displayShelf.length)}` : ''}{loading ? ` · ${t.skillsPage.loading}` : ''}</p>
    {!webgl && view === 'list' && <p className="note" role="status">{p.unavailable}</p>}
    {errors.map((error, index) => <p key={index} className="form-error" role="alert">{error}</p>)}
    {shown.length === 0 ? <p className="note">{loading ? t.skillsPage.loading : p.empty}</p> : <>
      <div ref={stage} data-compact={compact} className={`skill-shelf-stage ${selected ? 'reading' : ''}`} hidden={view === 'list' && !selected} tabIndex={-1}
        role="region" aria-label={selected ? p.details(selected.title) : p.views.shelf}
        onKeyDown={event => {
          if ((event.target as HTMLElement).closest('.skill-book-navigation')) return;
          if (!selectedId || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || !(event.key === 'ArrowLeft' || event.key === 'ArrowRight')) return;
          event.preventDefault(); turn(event.key === 'ArrowRight' ? 1 : -1);
        }}>
        {view === 'shelf' && <Suspense fallback={<p role="status">{t.common.loading}</p>}><ShelfCanvas key={displayShelf.map(book => book.id).join('\n')}
          books={displayShelf} reader={reader} onSelect={choose} onTurn={turn} onClose={close} onShelfRest={() => setReadingShelf(null)} onAvailability={ready => { setWebgl(ready); if (!ready) switchView('list'); }} /></Suspense>}
        {selected ? <>
          <div className="skill-book-toolbar"><div><strong>{selected.title}</strong><span>{p.sources[selected.source]} · {label}</span></div>
            <div className="skill-book-toolbar-actions"><button ref={navigationButton} type="button" className="button small" aria-expanded={navigationOpen} aria-controls={navigationId} onClick={() => setNavigationOpen(value => !value)}>{p.navigate}</button>
            <button type="button" className="button small" onClick={close}>{p.close}</button></div></div>
          {navigationOpen && <div id={navigationId}><SkillBookNavigation t={t} pages={pages} page={firstPage} compact={compact} onJump={jump} onClose={closeNavigation} /></div>}
          {fallback && <article className="skill-book-text" aria-label={p.instructions}>
            {visiblePages.map((page, index) => page ? <pre key={firstPage + index} className="skill-paper-text" tabIndex={0}>{page.text}</pre> : <div key="blank" className="skill-paper-text blank" aria-hidden="true" />)}
          </article>}
          <div className="skill-book-controls">
            <button type="button" className="button small" disabled={firstPage === 0} onClick={() => turn(-1)}>{p.previous}</button>
            <span className="small" role="status">{p.pageRange(firstPage + 1, Math.min(firstPage + step, pages.length), pages.length)}</span>
            <button type="button" className="button small" disabled={firstPage + step >= pages.length} onClick={() => turn(1)}>{p.next}</button>
            {view === 'shelf' && webgl && <button type="button" className="button small" aria-pressed={textView} onClick={() => setTextView(current => !current)}>{textView ? p.backToBook : p.readableText}</button>}
          </div>
          <p className="visually-hidden">{visiblePages.map(page => page?.text ?? '').join('\n\n')}</p>
        </> : <span className="skill-shelf-caption">{p.shelfHint}</span>}
      </div>
      {view === 'list' && <ul className="skill-book-index list" aria-label={p.books}>
        {shelf.map((book, index) => <li key={book.id}><button type="button" className="skill-book-choice" data-book-id={book.id} aria-pressed={selected?.id === book.id} onClick={() => choose(book.id)} style={{ borderInlineStartColor: BOOK_COLORS[book.category] }}>
          <span className="skill-book-number">{String(pagination.start + index + 1).padStart(2, '0')}</span><span><strong>{book.title}</strong><span className="muted small">{book.workspace ?? p.sources[book.source]} · {status(book)}</span></span>
        </button></li>)}
      </ul>}
      <SkillCatalogPagination t={t} page={currentPage} pageCount={pagination.pageCount} onPage={next => { setPage(next); setSelection(null); setNavigationOpen(false); setReadingShelf(null); }} />
    </>}
    <p className="note small">{p.readOnly}</p>
  </section>;
}
