import type { AgentHostApi, SessionSummary } from '@extalia/platform';

export type ComposerDelivery = 'submitting' | 'accepted' | 'unknown' | 'failed';
export interface ComposerDraftSnapshot { text: string; sending: boolean; delivery?: ComposerDelivery }
export interface ComposerDraftLease { finish(outcome: Exclude<ComposerDelivery, 'submitting'>): void }

/** Actual target identity, excluding hook-hydrated labels, status, model and project path. */
export function composerDraftKey(session?: SessionSummary, workspaceId?: string): string {
  return session ? JSON.stringify(['session', session.id, session.control ?? 'managed',
    session.observation?.sourceId ?? '', session.observation?.nativeSessionId ?? ''])
    : JSON.stringify(['new', workspaceId ?? '']);
}

class ComposerDraftEntry {
  private snapshot: ComposerDraftSnapshot = { text: '', sending: false };
  private revision = 0;
  private operation = 0;
  private listeners = new Set<() => void>();
  constructor(private changed: () => void) {}
  getSnapshot = (): ComposerDraftSnapshot => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private update(next: ComposerDraftSnapshot) {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
    this.changed();
  }
  setText = (next: string | ((current: string) => string)) => {
    const text = typeof next === 'function' ? next(this.snapshot.text) : next;
    if (text === this.snapshot.text) return;
    this.revision++;
    this.update({ ...this.snapshot, text });
  };
  beginSend = (): ComposerDraftLease | undefined => {
    if (this.snapshot.sending || this.snapshot.delivery === 'unknown') return undefined;
    const revision = this.revision, operation = ++this.operation;
    this.update({ ...this.snapshot, sending: true, delivery: 'submitting' });
    let settled = false;
    return { finish: outcome => {
      if (settled || operation !== this.operation) return;
      settled = true;
      const text = outcome === 'accepted' && this.revision === revision ? '' : this.snapshot.text;
      this.update({ text, sending: false, delivery: outcome });
    } };
  };
  /** Explicit user acknowledgement only; checking a source alone is not proof of non-delivery. */
  allowRetry = () => { if (!this.snapshot.sending) this.update({ ...this.snapshot, delivery: undefined }); };
}

/** App-lifetime text only: never localStorage, disk, host history or another host's drafts. */
export class ComposerDraftStore {
  private entries = new Map<string, ComposerDraftEntry>();
  private listeners = new Set<() => void>();
  private dirty = 0;
  hasDrafts = (): boolean => this.dirty > 0;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private changed() {
    this.dirty = [...this.entries.values()].filter(item => {
      const value = item.getSnapshot(); return !!value.text.trim() || value.sending || value.delivery === 'unknown';
    }).length;
    for (const listener of this.listeners) listener();
  }
  entry(key: string): ComposerDraftEntry {
    let entry = this.entries.get(key);
    if (!entry) {
      entry = new ComposerDraftEntry(() => this.changed());
      this.entries.set(key, entry);
    }
    return entry;
  }
  /** Follow this input's own freshly-created session before selection or upload. */
  bindSession(workspaceId: string, sessionId: string): boolean {
    if (!sessionId.trim()) return false;
    const from = composerDraftKey(undefined, workspaceId), to = composerDraftKey({ id: sessionId, control: 'managed' } as SessionSummary);
    const entry = this.entries.get(from), existing = this.entries.get(to)?.getSnapshot();
    if (!entry || !entry.getSnapshot().sending || existing && (existing.text || existing.sending || existing.delivery === 'unknown')) return false;
    this.entries.set(to, entry); this.entries.delete(from); this.changed(); return true;
  }
}
const drafts = new WeakMap<AgentHostApi, ComposerDraftStore>();
export function composerDraftStore(agents: AgentHostApi): ComposerDraftStore {
  let store = drafts.get(agents);
  if (!store) { store = new ComposerDraftStore(); drafts.set(agents, store); }
  return store;
}
