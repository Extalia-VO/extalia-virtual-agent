import { useId } from 'react';
import type { Messages } from '../i18n';

/** A bounded catalog pager: no button/option for every page in a growing library. */
export function SkillCatalogPagination({ t, page, pageCount, onPage }: {
  t: Messages; page: number; pageCount: number; onPage: (page: number) => void;
}) {
  const p = t.skillLibrary;
  const id = useId();
  return <div className="skill-catalog-pagination" role="group" aria-label={p.catalogNavigation}>
    <button type="button" className="button small" disabled={page === 0} onClick={() => onPage(page - 1)}>{p.previous}</button>
    <form onSubmit={event => {
      event.preventDefault();
      const input = event.currentTarget.elements.namedItem('catalogPage') as HTMLInputElement | null;
      const target = input?.valueAsNumber;
      if (target !== undefined && Number.isInteger(target) && target >= 1 && target <= pageCount) onPage(target - 1);
    }}>
      <label htmlFor={id} className="visually-hidden">{p.catalogPage}</label>
      <input key={page} id={id} name="catalogPage" type="number" min={1} max={pageCount} step={1} required defaultValue={page + 1} />
      <span className="muted small">{p.ofPages(pageCount)}</span>
      <button type="submit" className="button small">{p.goToPage}</button>
    </form>
    <button type="button" className="button small" disabled={page + 1 >= pageCount} onClick={() => onPage(page + 1)}>{p.next}</button>
  </div>;
}
