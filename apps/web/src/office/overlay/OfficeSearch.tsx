import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { Messages } from '../../i18n';
import { Icon } from '../../ui/Icon';
import { isSearchShortcut, moveActive, searchOffice, type ActivitySearchItem, type AgentSearchItem, type RoomSearchItem, type SearchHit } from './search';
import { useDismiss } from './useDismiss';

export interface OfficeSearchSource {
  agents: readonly AgentSearchItem[];
  rooms: readonly RoomSearchItem[];
  activity: readonly ActivitySearchItem[];
}

const GROUPS = ['agent', 'room', 'activity'] as const;

/**
 * Search the office: agents (name, status, project), rooms and recent activity.
 * `/` focuses it, arrow keys move through the results, Enter opens one.
 */
export function OfficeSearch({ t, source, onAgent, onRoom }: {
  t: Messages;
  source: OfficeSearchSource;
  /** An agent or an activity result (by its character id). */
  onAgent(characterId: string): void;
  onRoom(roomId: string): void;
}) {
  const o = t.officeOverlay;
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const listId = useId();
  const hits = useMemo(() => searchOffice(query, source), [query, source]);
  const showList = open && query.trim().length > 0;
  const activeIndex = Math.min(active, Math.max(0, hits.length - 1));
  const close = useCallback(() => setOpen(false), []);
  useDismiss(showList, root, close);
  useEffect(() => {
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (!isSearchShortcut(event, Boolean(document.querySelector('[aria-modal="true"]')))) return;
      event.preventDefault();
      input.current?.focus();
      input.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const optionId = (index: number) => `${listId}-${index}`;
  const choose = (hit: SearchHit) => {
    if (hit.kind === 'room') onRoom(hit.id);
    else onAgent(hit.kind === 'activity' ? hit.item.characterId : hit.id);
    setQuery(''); setOpen(false); setActive(0);
    input.current?.blur();
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setOpen(true);
      setActive(moveActive(activeIndex, event.key === 'ArrowDown' ? 1 : -1, hits.length));
    } else if (event.key === 'Enter') {
      const hit = hits[activeIndex];
      if (showList && hit) { event.preventDefault(); choose(hit); }
    } else if (event.key === 'Escape') {
      if (showList) { event.stopPropagation(); setOpen(false); }
      else if (query) { event.stopPropagation(); setQuery(''); }
      else input.current?.blur();
    }
  };
  const grouped = GROUPS.map(kind => ({ kind, items: hits.map((hit, index) => ({ hit, index })).filter(item => item.hit.kind === kind) })).filter(group => group.items.length > 0);

  return <div className="office-search" ref={root} role="search">
    <Icon name="search" />
    <input ref={input} type="search" role="combobox" autoComplete="off" spellCheck={false} value={query}
      aria-label={o.search.label} aria-autocomplete="list" aria-expanded={showList} aria-controls={listId}
      aria-activedescendant={showList && hits.length ? optionId(activeIndex) : undefined}
      placeholder={o.search.placeholder} title={o.search.shortcut}
      onChange={event => { setQuery(event.target.value); setActive(0); setOpen(true); }}
      onFocus={() => setOpen(true)} onKeyDown={onKeyDown} />
    <kbd className="office-search-key" aria-hidden="true">/</kbd>
    <span className="visually-hidden" role="status" aria-live="polite">{showList && hits.length ? o.search.results(hits.length) : ''}</span>
    {showList && <div className="office-search-popup" id={listId} role="listbox" aria-label={o.search.label}>
      {!hits.length && <p className="office-search-empty">{o.search.none(query.trim())}</p>}
      {grouped.map(group => <div key={group.kind} role="group" aria-label={o.search.groups[group.kind]}>
        <p className="office-search-group" aria-hidden="true">{o.search.groups[group.kind]}</p>
        {group.items.map(({ hit, index }) => <div key={`${hit.kind}-${hit.id}`} id={optionId(index)} role="option" aria-selected={index === activeIndex}
          className={`office-search-hit ${index === activeIndex ? 'active' : ''}`}
          onMouseDown={event => event.preventDefault()} onMouseMove={() => setActive(index)} onClick={() => choose(hit)}>
          {hit.kind === 'agent' && <>
            <span className={`office-dot tone-${hit.item.tone}`} aria-hidden="true" />
            <span className="office-search-text"><strong>{hit.item.name}</strong><small>{[hit.item.status, hit.item.project].filter(Boolean).join(' · ')}</small></span>
          </>}
          {hit.kind === 'room' && <>
            <Icon name="pin" />
            <span className="office-search-text"><strong>{hit.item.label}</strong><small>{hit.item.meta}</small></span>
          </>}
          {hit.kind === 'activity' && <>
            <Icon name="logs" />
            <span className="office-search-text"><strong>{hit.item.name}</strong><small>{hit.item.kind}{hit.item.text ? ` · ${hit.item.text}` : ''}</small></span>
          </>}
        </div>)}
      </div>)}
    </div>}
  </div>;
}
