import { Select } from '../../ui/Select';
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

/** Labelled choices keep one explicit value per dimension, including missing choices. */
export function GraphFilterControls({ t, options, filters, onChange, onClear }: GraphFilterControlsProps) {
  const k = t.knowledge.vaultGraph;
  const id = useId();
  const folder = filters.folder === null ? '' : filters.folder;
  const kind = filters.kind ?? '', tag = filters.tag ?? '';
  const missingFolder = filters.folder !== '' && !options.folders.includes(folder);
  const missingKind = filters.kind !== '' && !options.kinds.includes(kind);
  const missingTag = filters.tag !== '' && !options.tags.includes(tag);
  return <div className="vault-graph-filters" role="group" aria-label={k.filters}>
    <Select id={`${id}-folder`} label={k.filterFolder} value={facetSelectValue(filters.folder, 'folder')} onChange={selected => {
      const value = facetFromSelect(selected, 'folder');
      if (value !== undefined) onChange({ ...filters, folder: value });
    }} options={[
      { value: '', label: k.allFolders },
      ...(missingFolder ? [{ value: facetSelectValue(filters.folder, 'folder'), label: k.filterUnavailable(folder || k.root) }] : []),
      ...options.folders.map(value => ({ value: facetSelectValue(value || null, 'folder'), label: value || k.root })),
    ]} />
    <Select id={`${id}-kind`} label={k.filterKind} value={facetSelectValue(filters.kind, 'kind')} onChange={selected => {
      const value = facetFromSelect(selected, 'kind');
      if (value !== undefined) onChange({ ...filters, kind: value });
    }} options={[
      { value: '', label: k.allKinds },
      ...(missingKind ? [{ value: facetSelectValue(filters.kind, 'kind'), label: k.filterUnavailable(kind || k.noKind) }] : []),
      ...options.kinds.map(value => ({ value: facetSelectValue(value || null, 'kind'), label: value || k.noKind })),
    ]} />
    <Select id={`${id}-tag`} label={k.filterTag} value={facetSelectValue(filters.tag, 'tag')} onChange={selected => {
      const value = facetFromSelect(selected, 'tag');
      if (value !== undefined) onChange({ ...filters, tag: value });
    }} options={[
      { value: '', label: k.allTags },
      ...(missingTag ? [{ value: facetSelectValue(filters.tag, 'tag'), label: k.filterUnavailable(tag || k.noTags) }] : []),
      ...options.tags.map(value => ({ value: facetSelectValue(value || null, 'tag'), label: value || k.noTags })),
    ]} />
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
