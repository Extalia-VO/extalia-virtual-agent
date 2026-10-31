import type { BuiltinSkillInfo } from '@extalia/platform';
import { useMemo, useState } from 'react';
import type { Messages } from '../i18n';
import { builtinCatalogCounts, catalogCategory, CATALOG_FILTERS, filterBuiltinCatalog, type CatalogFilter } from './builtinCatalogModel';

export function BuiltinSkillsCatalog({ t, skills }: { t: Messages; skills: readonly BuiltinSkillInfo[] }) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<CatalogFilter>('all');
  return <BuiltinSkillsCatalogView t={t} skills={skills} query={query} category={category} onQuery={setQuery} onCategory={setCategory}
    onClear={() => { setQuery(''); setCategory('all'); }} />;
}

export interface BuiltinSkillsCatalogViewProps {
  t: Messages;
  skills: readonly BuiltinSkillInfo[];
  query: string;
  category: CatalogFilter;
  onQuery: (query: string) => void;
  onCategory: (category: CatalogFilter) => void;
  onClear: () => void;
}

/** Plain text disclosures: browsing never calls a runtime, imports or activates a skill. */
export function BuiltinSkillsCatalogView({ t, skills, query, category, onQuery, onCategory, onClear }: BuiltinSkillsCatalogViewProps) {
  const p = t.skillsPage;
  const counts = useMemo(() => builtinCatalogCounts(skills), [skills]);
  const shown = useMemo(() => filterBuiltinCatalog(skills, query, category, p.builtinCategories), [skills, query, category, p.builtinCategories]);
  return (
    <div className="builtin-catalog">
      <div className="builtin-catalog-search" role="search" aria-label={p.builtinSearch}>
        <input type="search" className="search" value={query} maxLength={200} aria-label={p.builtinSearch} placeholder={p.builtinSearch}
          onChange={event => onQuery(event.target.value)} />
        {(query || category !== 'all') && <button type="button" className="button small" onClick={onClear}>{p.clearBuiltinFilters}</button>}
      </div>
      <div className="builtin-catalog-categories" role="group" aria-label={p.builtinCategory}>
        {CATALOG_FILTERS.map(kind => <button key={kind} type="button" className="chip-button" aria-pressed={category === kind}
          disabled={kind !== 'all' && counts[kind] === 0} onClick={() => onCategory(kind)}>{p.builtinCategories[kind]} <span>({counts[kind]})</span></button>)}
      </div>
      <p className="muted small" role="status">{p.builtinCount(shown.length, skills.length)}</p>
      <p className="note small">{p.builtinBrowseOnly}</p>
      {shown.length === 0 ? <p className="muted small">{skills.length === 0 ? p.noBuiltins : p.noBuiltinMatches}</p> : (
        <ul className="skills-builtin-list">
          {shown.map(skill => (
            <li key={skill.name} className="skills-builtin-item">
              <div className="builtin-catalog-heading">
                <code className="skills-builtin-name">{skill.name}</code>
                <span className="badge">{p.builtinCategories[catalogCategory(skill)]}</span>
              </div>
              <p className="small">{skill.description}</p>
              <details className="builtin-catalog-details">
                <summary>{p.readBuiltinInstructions}<span className="visually-hidden">: {skill.name}</span></summary>
                {skill.body === undefined ? <p className="muted small">{p.builtinInstructionsUnavailable}</p>
                  : <pre className="builtin-catalog-body" tabIndex={0} aria-label={p.builtinInstructionsFor(skill.name)}>{skill.body}</pre>}
              </details>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
