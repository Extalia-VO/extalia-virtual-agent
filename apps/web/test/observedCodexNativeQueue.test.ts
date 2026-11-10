import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, ObservedCodexNativeQueueStatus, SessionSummary } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { ObservedCodexNativeQueue, ObservedCodexNativeQueueContent } from '../src/observe/ObservedCodexNativeQueue';
import { CODEX_NATIVE_QUEUE_LIMITS, createCodexNativeQueueControl, validateCodexNativeQueue } from '../src/observe/observedCodexNativeQueueModel';

const id = 'observed', threadId = '11111111-1111-4111-8111-111111111111';
const status = (patch: Partial<ObservedCodexNativeQueueStatus> = {}): ObservedCodexNativeQueueStatus => ({ sessionId: id, threadId,
  state: 'ready', items: [{ id: 'entry', text: 'Original prompt', nonTextItems: 0 }], ...patch });
const settle = async () => { await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
const stops: Array<() => void> = [];
function setup(initial = status()) {
  const api = { observedCodexNativeQueueStatus: vi.fn(async () => initial), queueObservedCodexMessage: vi.fn(), changePromptQueue: vi.fn(), sendPrompt: vi.fn() };
  const control = createCodexNativeQueueControl(api as unknown as AgentHostApi, id, threadId);
  stops.push(control.start()); return { api, control };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('polls only the original persisted queue every five seconds, with no mutation APIs', async () => {
  vi.useFakeTimers(); const { api, control } = setup(); await settle();
  expect(control.getSnapshot()).toMatchObject({ phase: 'ready', refreshing: false, status: status() });
  await vi.advanceTimersByTimeAsync(4999); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledExactlyOnceWith(id);
  await vi.advanceTimersByTimeAsync(1); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(2);
  await control.refresh(); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(3);
  expect(api.queueObservedCodexMessage).not.toHaveBeenCalled(); expect(api.changePromptQueue).not.toHaveBeenCalled(); expect(api.sendPrompt).not.toHaveBeenCalled();
});

it('stops automatic polling after unsupported and permits a manual retry', async () => {
  vi.useFakeTimers(); const { api, control } = setup(status({ state: 'unsupported', items: [] })); await settle();
  expect(control.hasCapability).toBe(true);
  await vi.advanceTimersByTimeAsync(20000); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(1);
  await control.refresh(); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(10000); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(2);
  api.observedCodexNativeQueueStatus.mockResolvedValue(status()); await control.refresh();
  expect(control.getSnapshot().phase).toBe('ready');
  await vi.advanceTimersByTimeAsync(5000); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(4);
});

it('offers manual retry for a backend unsupported response, but no button without the capability', () => {
  const { control } = setup(status({ state: 'unsupported', items: [] }));
  const present = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t: MESSAGES.en, control, view: { phase: 'unsupported', refreshing: false } }));
  expect(present).toContain(MESSAGES.en.observedCodexNativeQueue.refresh); expect(present).toContain('<button');
  const missing = createCodexNativeQueueControl({} as AgentHostApi, id, threadId);
  expect(missing.hasCapability).toBe(false);
  const absent = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t: MESSAGES.en, control: missing, view: missing.getSnapshot() }));
  expect(absent).not.toContain('<button');
});

it('stops while hidden or paused, clears contents immediately, and fetches again on resume', async () => {
  vi.useFakeTimers(); const { api, control } = setup(); await settle();
  control.setVisible(false); expect(control.getSnapshot().status).toBeUndefined();
  await vi.advanceTimersByTimeAsync(15000); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(1);
  control.setVisible(true); await settle(); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(2);
  control.setDisabled(true); expect(control.getSnapshot()).toEqual({ phase: 'paused', refreshing: false });
  await vi.advanceTimersByTimeAsync(10000); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(2);
  control.setDisabled(false); await settle(); expect(api.observedCodexNativeQueueStatus).toHaveBeenCalledTimes(3);
});

it.each(['pause', 'hide', 'unmount'] as const)('ignores a late result after %s', async action => {
  const pending = deferred<ObservedCodexNativeQueueStatus>(); const { api, control } = setup(); await settle();
  api.observedCodexNativeQueueStatus.mockReturnValueOnce(pending.promise); const read = control.refresh();
  if (action === 'pause') control.setDisabled(true);
  if (action === 'hide') control.setVisible(false);
  if (action === 'unmount') stops.pop()!();
  pending.resolve(status({ items: [{ id: 'late', text: 'Late secret', nonTextItems: 0 }] })); await read;
  expect(control.getSnapshot().status).toBeUndefined();
});

it('a stale response cannot overwrite a newer resumed source snapshot', async () => {
  const old = deferred<ObservedCodexNativeQueueStatus>(); const { api, control } = setup(); await settle();
  api.observedCodexNativeQueueStatus.mockReturnValueOnce(old.promise); const pending = control.refresh();
  control.setDisabled(true); control.setDisabled(false); await settle();
  old.resolve(status({ items: [{ id: 'old', text: 'Stale', nonTextItems: 0 }] })); await pending;
  expect(control.getSnapshot().status?.items[0]?.text).toBe('Original prompt');
});

it('source navigation starts empty and rejects session or native thread mismatches', async () => {
  const { api, control } = setup(); await settle();
  const next = createCodexNativeQueueControl(api as unknown as AgentHostApi, 'next-observed', 'next-thread');
  expect(next.getSnapshot().status).toBeUndefined(); stops.push(next.start()); await settle();
  expect(next.getSnapshot().phase).toBe('unavailable'); expect(next.getSnapshot().status).toBeUndefined();
  api.observedCodexNativeQueueStatus.mockResolvedValueOnce(status({ threadId: 'other-thread' }));
  await control.refresh(); expect(control.getSnapshot()).toEqual({ phase: 'unavailable', refreshing: false });
});

it('invalidates a pending result when the API binding changes', async () => {
  const pending = deferred<ObservedCodexNativeQueueStatus>(); const { api, control } = setup(); await settle();
  api.observedCodexNativeQueueStatus.mockReturnValueOnce(pending.promise); const read = control.refresh();
  api.observedCodexNativeQueueStatus = vi.fn(async () => status({ items: [] }));
  pending.resolve(status()); await read;
  expect(control.getSnapshot()).toEqual({ phase: 'unavailable', refreshing: false });
});

it.each(['private', 'unavailable', 'unsupported'] as const)('clears a previous body on %s without treating it as an empty queue', async state => {
  const { api, control } = setup(); await settle();
  api.observedCodexNativeQueueStatus.mockResolvedValueOnce(status({ state })); await control.refresh();
  expect(control.getSnapshot()).toMatchObject({ phase: state, status: { state, items: [] } });
  expect(JSON.stringify(control.getSnapshot())).not.toContain('Original prompt');
});

it('does not expose host error details and supports older hosts without reading', async () => {
  const { api, control } = setup(); await settle();
  api.observedCodexNativeQueueStatus.mockRejectedValueOnce(new Error('private diagnostic')); await control.refresh();
  expect(control.getSnapshot()).toEqual({ phase: 'unavailable', refreshing: false });
  const unsupported = createCodexNativeQueueControl({} as AgentHostApi, id, threadId); stops.push(unsupported.start());
  await unsupported.refresh(); expect(unsupported.getSnapshot()).toEqual({ phase: 'unsupported', refreshing: false });
});

it('bounds item count, text length and combined UTF-8 display data', () => {
  const many = status({ items: Array.from({ length: 60 }, (_, n) => ({ id: `item-${n}`, text: '界'.repeat(17000), nonTextItems: 2 })) });
  const safe = validateCodexNativeQueue(many, id, threadId);
  expect(safe.items.length).toBeLessThanOrEqual(50); expect(safe.truncated).toBe(true);
  expect(safe.items.every(item => item.text.length <= 16000)).toBe(true);
  expect(safe.items.reduce((bytes, item) => bytes + new TextEncoder().encode(item.text).byteLength, 0)).toBeLessThanOrEqual(CODEX_NATIVE_QUEUE_LIMITS.bytes);
  expect(validateCodexNativeQueue(status({ items: many.items.map(item => ({ ...item, text: '' })) }), id, threadId).items).toHaveLength(50);
});

it('accepts JSON escaping without treating it as raw prompt bytes', () => {
  const escaped = status({ items: Array.from({ length: 16 }, (_, n) => ({ id: `item-${n}`, text: '\0'.repeat(16000), nonTextItems: 0 })) });
  const safe = validateCodexNativeQueue(escaped, id, threadId);
  expect(safe.truncated).toBeUndefined(); expect(safe.items).toEqual(escaped.items);
  expect(new TextEncoder().encode(JSON.stringify(safe)).byteLength).toBeGreaterThan(CODEX_NATIVE_QUEUE_LIMITS.bytes);
});

it.each([
  { items: [{ id: 'entry', text: 'body', nonTextItems: -1 }] },
  { items: [{ id: 'entry', text: 'body', nonTextItems: 1.5 }] },
  { items: [{ id: 'entry', text: 'body', nonTextItems: 1025 }] },
  { observedAt: 'invalid date' },
  { items: [{ id: 'same', text: '', nonTextItems: 0 }, { id: 'same', text: '', nonTextItems: 0 }] },
])('rejects malformed source data', patch => {
  expect(() => validateCodexNativeQueue(status(patch), id, threadId)).toThrow();
});

it.each(['en', 'id'] as const)('renders escaped plain text and metadata, read-only with honest snapshot copy (%s)', language => {
  const { control } = setup(); const t = MESSAGES[language];
  const source = status({ observedAt: '2026-11-09T00:00:00Z', items: [{ id: 'item', text: '<script>private()</script>\n[link](https://example.com/file)', nonTextItems: 2 }] });
  const html = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t, control, view: { phase: 'ready', status: source, refreshing: false } }));
  expect(html).toContain(t.observedCodexNativeQueue.helper); expect(html).toContain('&lt;script&gt;');
  expect(html).toContain('[link](https://example.com/file)'); expect(html).toContain(t.observedCodexNativeQueue.nonText.replace('{count}', '2'));
  expect(html).not.toMatch(/<(?:script|a|img|textarea|input)\b/); expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('dateTime="2026-11-09T00:00:00Z"');
});

it('masks ready contents synchronously when paused, and non-Codex/managed sources never mount the reader', () => {
  const { api, control } = setup();
  const html = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t: MESSAGES.en, control, disabled: true, view: { phase: 'ready', status: status(), refreshing: false } }));
  expect(html).not.toContain('Original prompt'); expect(html).toContain(MESSAGES.en.observedCodexNativeQueue.states.paused);
  api.observedCodexNativeQueueStatus.mockClear();
  for (const session of [{ id, control: 'managed' }, { id, control: 'observed', observation: { sourceId: 'hermes' } }]) {
    expect(renderToStaticMarkup(createElement(ObservedCodexNativeQueue, { t: MESSAGES.en, agents: api as unknown as AgentHostApi, session: session as SessionSummary }))).toBe('');
  }
  expect(api.observedCodexNativeQueueStatus).not.toHaveBeenCalled();
});

it('renders ready empty differently from unavailable, private and unsupported', () => {
  const { control } = setup(); const t = MESSAGES.en;
  const empty = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t, control, view: { phase: 'ready', status: status({ items: [] }), refreshing: false } }));
  expect(empty).toContain(t.observedCodexNativeQueue.empty);
  for (const phase of ['unavailable', 'private', 'unsupported'] as const) {
    const html = renderToStaticMarkup(createElement(ObservedCodexNativeQueueContent, { t, control, view: { phase, refreshing: false } }));
    expect(html).not.toContain(t.observedCodexNativeQueue.empty); expect(html).toContain(t.observedCodexNativeQueue.states[phase]);
  }
});
