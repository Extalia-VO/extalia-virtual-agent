import { useId, useMemo, useState } from 'react';
import type { Messages } from '../i18n';
import type { SkillBookPage } from './skillBookMotion';
import { bookContents, searchBookPages } from './skillBookNavigation';

/** A local reader tool. Titles and snippets stay literal, untrusted display text. */
export function SkillBookNavigation({ t, pages, page, compact, onJump, onClose }: {
  t: Messages; pages: readonly SkillBookPage[]; page: number; compact: boolean;
  onJump: (page: number) => void; onClose: () => void;
}) {
  const p = t.skillLibrary;
  const [query, setQuery] = useState('');
  const id = useId();
  const contents = useMemo(() => bookContents(pages), [pages]);
  const results = useMemo(() => searchBookPages(pages, query), [pages, query]);
  const searching = query.trim().length > 0;
  const visible = (target: number) => target >= page && target < page + (compact ? 1 : 2);
  return <aside className="skill-book-navigation" aria-label={p.bookNavigation}>
    <div className="skill-navigation-heading"><strong>{p.bookNavigation}</strong><button type="button" className="button small" aria-label={p.closeNavigation} onClick={onClose}>×</button></div>
    <form className="skill-page-jump" onSubmit={event => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('page') as HTMLInputElement | null;
      const target = input?.valueAsNumber;
      if (target !== undefined && Number.isFinite(target) && target >= 1 && target <= pages.length && Number.isInteger(target)) onJump(target - 1);
    }}>
      <label htmlFor={`${id}-page`}>{p.pageNumber}</label>
      <div><input key={page} id={`${id}-page`} name="page" type="number" min={1} max={pages.length} step={1} required defaultValue={page + 1} /><button type="submit" className="button small">{p.goToPage}</button></div>
    </form>
    <label className="skill-book-find" htmlFor={`${id}-search`}>{p.findInBook}<input id={`${id}-search`} type="search" maxLength={400} value={query} onChange={event => setQuery(Array.from(event.target.value).slice(0, 200).join(''))} /></label>
    {searching ? <>
      <p className="muted small" role="status">{results.total ? p.matchingPages(results.total) : p.noPageMatches}{results.truncated ? ` · ${p.navigationLimit(results.matches.length, results.total)}` : ''}</p>
      <ol className="skill-navigation-list" aria-label={p.findInBook}>{results.matches.map(match => <li key={match.page}><button type="button" aria-current={visible(match.page) ? 'page' : undefined} onClick={() => onJump(match.page)}><span>{p.pageNumberLabel(match.page + 1)}</span><span>{match.snippet}</span></button></li>)}</ol>
    </> : <>
      <strong className="small">{p.contents}</strong>
      {contents.total === 0 && <p className="muted small">{p.noHeadings}</p>}
      {contents.truncated && <p className="muted small">{p.navigationLimit(contents.entries.length, contents.total)}</p>}
      <ol className="skill-navigation-list" aria-label={p.contents}>{contents.entries.map((entry, index) => <li key={`${entry.page}:${index}`}><button type="button" aria-current={visible(entry.page) ? 'page' : undefined} onClick={() => onJump(entry.page)} style={{ paddingInlineStart: 10 + (entry.level - 1) * 10 }}><span>{p.pageNumberLabel(entry.page + 1)}</span><span>{entry.title}</span></button></li>)}</ol>
    </>}
  </aside>;
}
