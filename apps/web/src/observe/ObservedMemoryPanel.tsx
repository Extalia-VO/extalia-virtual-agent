import type { AgentHostApi, ObservedMemoryEpisode, ObservedMemoryPage, ObservedMemorySearchResult, SessionSummary } from '@extalia/platform';
import { useEffect, useId, useLayoutEffect, useState, useSyncExternalStore } from 'react';
import type { Messages } from '../i18n';
import { isUnsupportedMessage } from '../knowledge/knowledgeModel';
import { observedSource } from '../office/agentOrigin';

export type ObservedMemoryMessages = Messages['observedMemory'];
export interface ObservedMemoryViewState {
  query: string; unsupported?: boolean; busy?: 'search' | 'read'; result?: ObservedMemorySearchResult; page?: ObservedMemoryPage; error?: 'search' | 'read';
}
const QUERY_LIMIT = 500, SEARCH_LIMIT = 8, PAGE_LIMIT = 20;
const sourceKey = (session: SessionSummary, scopeKey = '') => JSON.stringify([scopeKey, session.id, session.workspaceId, session.connectionId, session.observation?.sourceId, session.observation?.nativeSessionId, session.observation?.projectPath]);
const sameEpisode = (a: ObservedMemoryEpisode, b: ObservedMemoryEpisode) => a.id === b.id && a.revision === b.revision
  && (['profileId', 'workspaceId', 'sessionId', 'sourceId', 'nativeSessionId', 'boundary'] as const).every(key => a.scope[key] === b.scope[key]);
function validEpisode(episode: ObservedMemoryEpisode, workspaceId: string): boolean {
  return !!episode && episode.trust === 'untrusted-observed' && episode.scope?.workspaceId === workspaceId && typeof episode.id === 'string' && !!episode.id
    && typeof episode.revision === 'string' && !!episode.revision
    && (['profileId', 'workspaceId', 'sessionId', 'sourceId', 'nativeSessionId', 'boundary'] as const).every(key => typeof episode.scope[key] === 'string' && !!episode.scope[key])
    && Number.isSafeInteger(episode.entries) && episode.entries >= 0
    && !!episode.coverage && ['partial', 'unknown'].includes(episode.coverage.mode) && Array.isArray(episode.coverage.limits) && episode.coverage.limits.every(limit => typeof limit === 'string');
}
/** UI request ownership only. Scope, storage, retrieval and redaction belong to the host. */
export class ObservedMemoryController {
  value: ObservedMemoryViewState = { query: '' };
  private agents?: AgentHostApi;
  private session?: SessionSummary;
  private key = '';
  private generation = 0;
  private editing = 0;
  private pending = false;
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getSnapshot = () => this.value;
  private publish(next: Partial<ObservedMemoryViewState>) { this.value = { ...this.value, ...next }; for (const listener of this.listeners) listener(); }
  matches(agents: AgentHostApi, session: SessionSummary, scopeKey = '') { return this.agents === agents && this.key === sourceKey(session, scopeKey); }
  bind(agents: AgentHostApi, session: SessionSummary, scopeKey = '') {
    if (this.matches(agents, session, scopeKey)) return;
    this.generation++; this.editing++; this.agents = agents; this.session = session; this.key = sourceKey(session, scopeKey);
    this.value = { query: '', ...(this.pending ? { busy: this.value.busy } : {}) }; this.publish({});
  }
  invalidate() { this.generation++; this.editing++; this.agents = undefined; this.key = ''; }
  edit(query: string) { this.editing++; this.publish({ query, result: undefined, page: undefined, error: undefined }); }
  async search(): Promise<void> {
    const agents = this.agents, session = this.session, query = this.value.query.trim(), generation = this.generation, editing = this.editing;
    if (!agents?.observedMemorySearch || !agents.observedMemoryRead || !session || this.pending || this.value.unsupported || !query || query.length > QUERY_LIMIT) return;
    this.pending = true; this.publish({ busy: 'search', result: undefined, page: undefined, error: undefined });
    const current = () => generation === this.generation && editing === this.editing;
    try {
      const result = await agents.observedMemorySearch(session.workspaceId, { query, limit: SEARCH_LIMIT });
      if (!current()) return;
      if (!Array.isArray(result?.hits) || result.hits.length > SEARCH_LIMIT || result.hits.some(hit => !validEpisode(hit.episode, session.workspaceId) || typeof hit.excerpt !== 'string')) throw new Error();
      this.publish({ result });
    } catch (failure) { if (current()) this.publish(isUnsupportedMessage(failure instanceof Error ? failure.message : '') ? { unsupported: true, error: undefined } : { error: 'search' }); }
    finally { this.pending = false; if (this.agents) this.publish({ busy: undefined }); }
  }
  async read(id: string, more = false): Promise<void> {
    const agents = this.agents, session = this.session, generation = this.generation, editing = this.editing;
    const hit = this.value.result?.hits.find(item => item.episode.id === id), episode = hit?.episode, previous = this.value.page;
    const authorizedSessionId = hit && 'sessionId' in hit && typeof hit.sessionId === 'string' && hit.sessionId ? hit.sessionId : episode?.scope.sessionId;
    if (!agents?.observedMemoryRead || !session || !episode || this.pending || this.value.unsupported || more && (!previous || !sameEpisode(previous.episode, episode) || previous.nextOffset === undefined)) return;
    const offset = more ? previous!.nextOffset! : 0;
    this.pending = true; this.publish({ busy: 'read', page: undefined, error: undefined });
    const current = () => generation === this.generation && editing === this.editing;
    try {
      const page = await agents.observedMemoryRead(session.workspaceId, { sessionId: authorizedSessionId!, episodeId: episode.id, revision: episode.revision, offset, limit: PAGE_LIMIT });
      if (!current()) return;
      if (!validEpisode(page?.episode, session.workspaceId) || !sameEpisode(page.episode, episode) || !Array.isArray(page.entries)
        || page.entries.length > PAGE_LIMIT || page.offset !== offset || !Number.isSafeInteger(page.total) || page.total < offset + page.entries.length
        || page.nextOffset !== undefined && (!Number.isSafeInteger(page.nextOffset) || page.nextOffset <= offset || page.nextOffset > page.total) || page.entries.some(entry => !entry || typeof entry.text !== 'string' || !['user', 'assistant', 'tool', 'file', 'status'].includes(entry.kind))) throw new Error();
      this.publish({ page });
    } catch (failure) { if (current()) this.publish(isUnsupportedMessage(failure instanceof Error ? failure.message : '') ? { unsupported: true, error: undefined } : { error: 'read' }); }
    finally { this.pending = false; if (this.agents) this.publish({ busy: undefined }); }
  }
}
export function ObservedMemoryPanel({ agents, session, t, disabled, scopeKey }: {
  agents: AgentHostApi; session: SessionSummary; t: ObservedMemoryMessages; disabled?: boolean; scopeKey?: string;
}) {
  const [controller] = useState(() => new ObservedMemoryController());
  const owned = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);
  const current = controller.matches(agents, session, scopeKey);
  useLayoutEffect(() => { controller.bind(agents, session, scopeKey); }, [controller, agents, session, scopeKey]);
  useEffect(() => () => controller.invalidate(), [controller]);
  return <ObservedMemoryPanelView t={t} value={current ? owned : { query: '' }} disabled={disabled}
    supported={typeof agents.observedMemorySearch === 'function' && typeof agents.observedMemoryRead === 'function'}
    onQuery={query => controller.edit(query)} onSearch={() => { void controller.search(); }} onRead={(id, more) => { void controller.read(id, more); }} />;
}
export function ObservedMemoryPanelView({ t, value, supported, disabled, onQuery, onSearch, onRead }: {
  t: ObservedMemoryMessages; value: ObservedMemoryViewState; supported: boolean; disabled?: boolean;
  onQuery(query: string): void; onSearch(): void; onRead(id: string, more?: boolean): void;
}) {
  const id = useId(), blocked = Boolean(disabled || value.busy);
  const coverage = (episode: ObservedMemoryEpisode) => <>
    <p className="muted small">{t.coverage[episode.coverage.mode]} · {t.entries}: {episode.entries}{episode.coverage.omittedEntries > 0 && <> · {t.omittedEntries}: {episode.coverage.omittedEntries}</>}{episode.coverage.truncated && <> · {t.truncated}</>}</p>
    {episode.coverage.limits.length > 0 && <ul className="muted small">{episode.coverage.limits.map((limit, index) => <li key={index}>{limit}</li>)}</ul>}
  </>;
  return <details className="observed-codex-entry" style={{ minWidth: 0, overflowWrap: 'anywhere' }}>
    <summary>{t.title}</summary>
    <p className="muted small">{t.claims}</p>
    {!supported || value.unsupported ? <p className="muted small" role="status">{t.unsupported}</p> : <>
      <p className="muted small">{t.consent}</p>
      <form onSubmit={event => { event.preventDefault(); if (!blocked && value.query.trim()) onSearch(); }}>
        <label className="field" htmlFor={`${id}-query`}>{t.query}<input id={`${id}-query`} type="search" value={value.query} maxLength={QUERY_LIMIT} placeholder={t.placeholder} disabled={Boolean(disabled)} onChange={event => onQuery(event.target.value)} style={{ width: '100%', minWidth: 0, boxSizing: 'border-box' }} /></label>
        <button type="submit" className="button small" aria-busy={value.busy === 'search'} disabled={blocked || !value.query.trim() || value.query.trim().length > QUERY_LIMIT}>{value.busy === 'search' ? t.searching : t.search}</button>
      </form>
      {value.error && <p className="form-error" role="alert">{value.error === 'search' ? t.searchFailed : t.readFailed}</p>}
      {value.result && <>
        {!value.result.hits.length && <p className="muted small" role="status">{t.empty}</p>}
        {value.result.incomplete && <p className="note small">{t.incomplete}</p>}
        {value.result.omitted > 0 && <p className="muted small">{t.omitted}: {value.result.omitted}</p>}
        <ul style={{ paddingLeft: 18 }}>{value.result.hits.map(({ episode, excerpt }) => <li key={episode.id}>
          <p className="small"><strong>{observedSource(episode.scope.sourceId).label || episode.scope.sourceId}</strong> · <time dateTime={episode.capturedAt}>{episode.capturedAt}</time></p>
          <p className="small">{excerpt}</p>{coverage(episode)}
          <button type="button" className="button small" disabled={blocked} onClick={() => onRead(episode.id)}>{t.read}</button>
        </li>)}</ul>
      </>}
      {value.busy === 'read' && <p className="muted small" role="status">{t.reading}</p>}
      {value.page && <section aria-label={t.evidence}>
        <h4>{t.evidence}</h4>{coverage(value.page.episode)}
        <p className="muted small">{t.entries}: {value.page.entries.length ? value.page.offset + 1 : value.page.offset}–{value.page.offset + value.page.entries.length} / {value.page.total}</p>
        <ol start={value.page.offset + 1} style={{ paddingLeft: 18 }}>{value.page.entries.map(entry => <li key={entry.id}><strong className="small">{t.kinds[entry.kind]}</strong>
          <pre className="small" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 240, overflow: 'auto' }}>{entry.text}</pre>
        </li>)}</ol>
        {value.page.nextOffset !== undefined && <button type="button" className="button small" disabled={blocked} onClick={() => onRead(value.page!.episode.id, true)}>{t.more}</button>}
      </section>}
    </>}
  </details>;
}
