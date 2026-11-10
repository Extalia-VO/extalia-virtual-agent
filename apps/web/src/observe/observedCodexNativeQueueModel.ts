import type { AgentHostApi, ObservedCodexNativeQueueStatus } from '@extalia/platform';

export const CODEX_NATIVE_QUEUE_POLL_MS = 5000;
export const CODEX_NATIVE_QUEUE_LIMITS = { items: 50, text: 16000, bytes: 256 * 1024 } as const;
export interface CodexNativeQueueView {
  phase: 'loading' | 'ready' | 'unavailable' | 'unsupported' | 'private' | 'paused';
  status?: ObservedCodexNativeQueueStatus;
  refreshing: boolean;
}

/** Treat host responses as untrusted display data, including older or mismatched hosts. */
export function validateCodexNativeQueue(value: ObservedCodexNativeQueueStatus, sessionId: string, nativeSessionId: string): ObservedCodexNativeQueueStatus {
  if (!value || value.sessionId !== sessionId || sessionId.length > 256 || !['ready', 'unavailable', 'unsupported', 'private'].includes(value.state)
    || value.threadId !== undefined && (typeof value.threadId !== 'string' || value.threadId.length > 256 || value.threadId !== nativeSessionId)
    || value.truncated !== undefined && typeof value.truncated !== 'boolean') throw new Error('Invalid source queue');
  // Privacy and availability always win over any item body included by a peer.
  if (value.state !== 'ready') return { sessionId, state: value.state, items: [] };
  if (!Array.isArray(value.items) || value.observedAt !== undefined && (typeof value.observedAt !== 'string'
    || value.observedAt.length > 64 || !Number.isFinite(Date.parse(value.observedAt)))) throw new Error('Invalid source queue');
  const encoder = new TextEncoder(), ids = new Set<string>();
  // Match the host budget: raw UTF-8 prompt text, before JSON escaping.
  const size = (text: string) => encoder.encode(text).byteLength;
  const header = { sessionId, state: 'ready' as const,
    ...(value.threadId ? { threadId: value.threadId } : {}), ...(value.observedAt ? { observedAt: value.observedAt } : {}) };
  let remaining: number = CODEX_NATIVE_QUEUE_LIMITS.bytes;
  let truncated = !!value.truncated;
  const items: ObservedCodexNativeQueueStatus['items'] = [];
  for (const item of value.items.slice(0, CODEX_NATIVE_QUEUE_LIMITS.items)) {
    if (!item || typeof item.id !== 'string' || !item.id || item.id.length > 256 || ids.has(item.id)
      || typeof item.text !== 'string' || !Number.isSafeInteger(item.nonTextItems) || item.nonTextItems < 0 || item.nonTextItems > 1024
      || item.truncated !== undefined && typeof item.truncated !== 'boolean') throw new Error('Invalid source queue');
    ids.add(item.id);
    let text = item.text.slice(0, CODEX_NATIVE_QUEUE_LIMITS.text);
    // Remove a split surrogate before enforcing the UTF-8 display budget.
    if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    if (size(text) > remaining) {
      let low = 0, high = text.length;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (size(text.slice(0, middle)) <= remaining) low = middle;
        else high = middle - 1;
      }
      text = text.slice(0, low);
      if (/[\uD800-\uDBFF]$/.test(text)) text = text.slice(0, -1);
    }
    remaining -= size(text);
    const itemTruncated = !!item.truncated || text !== item.text;
    truncated ||= itemTruncated;
    items.push({ id: item.id, text, nonTextItems: item.nonTextItems, ...(itemTruncated ? { truncated: true } : {}) });
    if (remaining <= 0) { truncated ||= items.length < value.items.length; break; }
  }
  truncated ||= value.items.length > items.length;
  return { ...header, items, ...(truncated ? { truncated: true } : {}) };
}

/** Read-only, source-bound snapshot owner. It never calls an outbox or a send API. */
export function createCodexNativeQueueControl(api: AgentHostApi, sessionId: string, nativeSessionId: string) {
  const read = api.observedCodexNativeQueueStatus;
  let view: CodexNativeQueueView = { phase: read ? 'loading' : 'unsupported', refreshing: false };
  let active = false, disabled = false, visible = true, epoch = 0, reading = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const listeners = new Set<() => void>();
  const update = (next: CodexNativeQueueView) => { view = next; listeners.forEach(listener => listener()); };
  function invalidate() { ++epoch; reading = false; clearInterval(timer); timer = undefined; }
  function idlePhase(): CodexNativeQueueView['phase'] { return disabled ? 'paused' : read ? 'loading' : 'unsupported'; }
  function schedule() {
    clearInterval(timer); timer = undefined;
    if (active && !disabled && visible && read && view.phase !== 'unsupported') timer = setInterval(() => { void refresh(); }, CODEX_NATIVE_QUEUE_POLL_MS);
  }
  async function refresh() {
    if (!active || disabled || !visible || !read || reading) return;
    if (api.observedCodexNativeQueueStatus !== read) {
      invalidate(); update({ phase: 'unavailable', refreshing: false }); return;
    }
    const generation = ++epoch; reading = true;
    update({ ...view, refreshing: true });
    try {
      const status = await read.call(api, sessionId);
      if (!active || disabled || !visible || epoch !== generation) return;
      if (api.observedCodexNativeQueueStatus !== read) {
        invalidate(); update({ phase: 'unavailable', refreshing: false }); return;
      }
      const safe = validateCodexNativeQueue(status, sessionId, nativeSessionId);
      update({ phase: safe.state, status: safe, refreshing: false });
      schedule();
    } catch {
      if (active && epoch === generation) update({ phase: 'unavailable', refreshing: false });
    } finally { if (epoch === generation) reading = false; }
  }
  return {
    hasCapability: !!read,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    getSnapshot: () => view,
    start() {
      active = true; schedule(); void refresh();
      return () => { active = false; invalidate(); update({ phase: idlePhase(), refreshing: false }); };
    },
    refresh,
    setDisabled(next: boolean) {
      if (disabled === next) return;
      disabled = next; invalidate(); update({ phase: idlePhase(), refreshing: false }); schedule(); void refresh();
    },
    setVisible(next: boolean) {
      if (visible === next) return;
      visible = next; invalidate(); update({ phase: idlePhase(), refreshing: false }); schedule(); void refresh();
    },
  };
}
export type CodexNativeQueueControl = ReturnType<typeof createCodexNativeQueueControl>;
