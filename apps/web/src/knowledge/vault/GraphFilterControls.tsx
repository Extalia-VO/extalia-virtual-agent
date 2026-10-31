import { useId, type ReactNode } from 'react';
import type { Messages } from '../../i18n';
import { facetFromSelect, facetSelectValue, hasGraphFilters, type GraphFacetFilters, type GraphFacetOptions } from './graphFilters';

export interface GraphFilterControlsProps {
  t: Messages;
  options: GraphFacetOptions;
  filters: GraphFacetFilters;
  onChange: (filters: GraphFacetFilters) => void;
  onClear: () => void;
}

/** Native labelled selects keep one explicit choice per dimension, including missing choices. */
export function GraphFilterControls({ t, options, filters, onChange, onClear }: GraphFilterControlsProps) {
  const k = t.knowledge.vaultGraph;
  const id = useId();
  const folder = filters.folder === null ? '' : filters.folder;
  const kind = filters.kind ?? '', tag = filters.tag ?? '';
  const missingFolder = filters.folder !== '' && !options.folders.includes(folder);
  const missingKind = filters.kind !== '' && !options.kinds.includes(kind);
  const missingTag = filters.tag !== '' && !options.tags.includes(tag);
  return <div className="vault-graph-filters" role="group" aria-label={k.filters}>
    <label htmlFor={`${id}-folder`}>{k.filterFolder}
      <select id={`${id}-folder`} value={facetSelectValue(filters.folder, 'folder')} onChange={event => {
        const value = facetFromSelect(event.target.value, 'folder');
        if (value !== undefined) onChange({ ...filters, folder: value });
      }}>
        <option value="">{k.allFolders}</option>
        {missingFolder && <option value={facetSelectValue(filters.folder, 'folder')}>{k.filterUnavailable(folder || k.root)}</option>}
        {options.folders.map(value => <option key={value} value={facetSelectValue(value || null, 'folder')}>{value || k.root}</option>)}
      </select>
    </label>
    <label htmlFor={`${id}-kind`}>{k.filterKind}
      <select id={`${id}-kind`} value={facetSelectValue(filters.kind, 'kind')} onChange={event => { const value = facetFromSelect(event.target.value, 'kind'); if (value !== undefined) onChange({ ...filters, kind: value }); }}>
        <option value="">{k.allKinds}</option>
        {missingKind && <option value={facetSelectValue(filters.kind, 'kind')}>{k.filterUnavailable(kind || k.noKind)}</option>}
        {options.kinds.map(value => <option key={value} value={facetSelectValue(value || null, 'kind')}>{value || k.noKind}</option>)}
      </select>
    </label>
    <label htmlFor={`${id}-tag`}>{k.filterTag}
      <select id={`${id}-tag`} value={facetSelectValue(filters.tag, 'tag')} onChange={event => { const value = facetFromSelect(event.target.value, 'tag'); if (value !== undefined) onChange({ ...filters, tag: value }); }}>
        <option value="">{k.allTags}</option>
        {missingTag && <option value={facetSelectValue(filters.tag, 'tag')}>{k.filterUnavailable(tag || k.noTags)}</option>}
        {options.tags.map(value => <option key={value} value={facetSelectValue(value || null, 'tag')}>{value || k.noTags}</option>)}
      </select>
    </label>
    <button type="button" className="chip-button" disabled={!hasGraphFilters(filters)} onClick={onClear}>{k.clearFilters}</button>
    {(missingFolder || missingKind || missingTag) && <p className="muted small vault-graph-filter-status" role="status">
      {[missingFolder && k.filterUnavailable(folder || k.root), missingKind && k.filterUnavailable(kind || k.noKind), missingTag && k.filterUnavailable(tag || k.noTags)].filter(Boolean).join(' · ')}
    </p>}
  </div>;
}

/** Keep selection latent when hidden, without mounting filtered note content. */
export function GraphSelectedNotePanel({ t, visible, onClose, children }: { t: Messages; visible: boolean; onClose: () => void; children: ReactNode }) {
  const k = t.knowledge.vaultGraph;
  return <aside className="vault-graph-panel" aria-label={t.knowledge.title}>
    {visible ? children : <div className="vault-graph-selected-filtered"><p role="status">{k.selectedFiltered}</p><button type="button" className="chip-button" onClick={onClose}>{k.closeFilteredNote}</button></div>}
  </aside>;
}
