import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { AgentHostApi, PromptQueueItem, PromptQueueStatus } from '@extalia/platform';
import { afterEach, expect, it, vi } from 'vitest';
import { MESSAGES } from '../src/i18n';
import { PromptQueueContent } from '../src/chat/PromptQueueControls';
import { createPromptQueueControl } from '../src/chat/promptQueueModel';

const item = (id: string, state: PromptQueueItem['state'] = 'pending'): PromptQueueItem => ({ id, state, text: `Prompt ${id}`, createdAt: '2030-01-01T00:00:00Z' });
const status = (items: PromptQueueItem[] = [], patch: Partial<PromptQueueStatus> = {}): PromptQueueStatus => ({ sessionId: 'session', revision: 'r1', supported: true, paused: true, maxTextLength: 16000, items, ...patch });
const stops: Array<() => void> = [];
const settle = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };
const deferred = <T,>() => { let resolve!: (value: T) => void; const promise = new Promise<T>(done => { resolve = done; }); return { promise, resolve }; };
function setup(initial = status()) {
  const api = { promptQueueStatus: vi.fn(async () => initial), changePromptQueue: vi.fn(async () => status([], { revision: 'r2' })) };
  const model = createPromptQueueControl(api as unknown as AgentHostApi, 'session');
  stops.push(model.start()); return { api, model };
}
afterEach(() => { stops.splice(0).forEach(stop => stop()); vi.useRealTimers(); });

it('polls a closed queue without writing or starting; explicit add binds the exact revision and target', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); await vi.advanceTimersByTimeAsync(2500);
  expect(api.changePromptQueue).not.toHaveBeenCalled(); expect(model.getSnapshot().status?.paused).toBe(true);
  model.setDraft('First\nqueued prompt'); await model.add();
  expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'add', text: 'First\nqueued prompt' });
  expect(model.getSnapshot().draft).toBe('');
});

it('rejects a stale displayed revision without writing or losing the draft', async () => {
  const { api, model } = setup(); await settle(); model.setDraft('Keep draft');
  api.promptQueueStatus.mockResolvedValueOnce(status([item('new')], { revision: 'r2' }));
  await model.add(); expect(api.changePromptQueue).not.toHaveBeenCalled();
  expect(model.getSnapshot()).toMatchObject({ draft: 'Keep draft', notice: 'stale', status: { revision: 'r2' } });
});

it('edits only the exact pending item; backend failure preserves edit and add drafts', async () => {
  const original = item('a'); const { api, model } = setup(status([original])); await settle();
  model.setDraft('unsent add'); model.beginEdit(original); model.setEditDraft('edited pending prompt');
  api.changePromptQueue.mockRejectedValueOnce(new Error('Internal details must not reach UI'));
  await model.save(); expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'edit', itemId: 'a', text: 'edited pending prompt' });
  expect(model.getSnapshot()).toMatchObject({ draft: 'unsent add', edit: { text: 'edited pending prompt' }, notice: 'failed' });
  expect(JSON.stringify(model.getSnapshot())).not.toContain('Internal details');
});

it('keeps an editor draft when polling reports that its prompt was handed off', async () => {
  const original = item('a'); const { api, model } = setup(status([original])); await settle();
  model.beginEdit(original); model.setEditDraft('retain edited draft');
  api.promptQueueStatus.mockResolvedValueOnce(status([item('a', 'sending')], { revision: 'r2' })); await model.refresh();
  expect(model.getSnapshot().edit?.text).toBe('retain edited draft'); expect(model.canSave()).toBe(false);
  await model.save(); expect(api.changePromptQueue).not.toHaveBeenCalled();
});

it('reorders using the entire pending ID permutation and never includes receipt IDs', async () => {
  const a = item('a'), b = item('b'), c = item('c'); const { api, model } = setup(status([item('sent', 'sent'), a, item('unknown', 'unknown'), b, c])); await settle();
  await model.move(b, -1);
  expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'reorder', itemIds: ['b', 'a', 'c'] });
});

it('stops stale reorder when the pending set changes while obtaining the fresh snapshot', async () => {
  const a = item('a'), b = item('b'); const { api, model } = setup(status([a, b])); await settle();
  const pending = deferred<PromptQueueStatus>(); api.promptQueueStatus.mockReturnValueOnce(pending.promise);
  const move = model.move(b, -1); await settle(); pending.resolve(status([a, b, item('new')], { revision: 'r2' })); await move;
  expect(api.changePromptQueue).not.toHaveBeenCalled(); expect(model.getSnapshot().notice).toBe('stale');
});

it('receipts cannot be edited, deleted or moved; only sent or unknown can be explicitly acknowledged', async () => {
  const sending = item('sending', 'sending'), sent = item('sent', 'sent'), unknown = item('unknown', 'unknown');
  const { api, model } = setup(status([sending, sent, unknown])); await settle();
  for (const receipt of [sending, sent, unknown]) { model.beginEdit(receipt); await model.delete(receipt); await model.move(receipt, -1); }
  await model.acknowledge(sending); await model.setPaused(false);
  expect(api.changePromptQueue).not.toHaveBeenCalled(); expect(model.getSnapshot().edit).toBeUndefined();
  await model.acknowledge(unknown);
  expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'acknowledge', itemId: 'unknown' });
});

it('start and pause are explicit revision-bound changes', async () => {
  const { api, model } = setup(status([item('a')])); await settle();
  await model.setPaused(false); expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'pause', paused: false });
  api.promptQueueStatus.mockResolvedValue(status([item('a')], { revision: 'r2', paused: false })); await model.refresh();
  await model.setPaused(true); expect(api.changePromptQueue).toHaveBeenLastCalledWith('session', { revision: 'r2', action: 'pause', paused: true });
});

it('does not overlap reads or repeat a mutation; preserves newer add text while the first add finishes', async () => {
  vi.useFakeTimers(); const { api, model } = setup(); await settle(); model.setDraft('first');
  const reading = deferred<PromptQueueStatus>(); api.promptQueueStatus.mockReturnValueOnce(reading.promise);
  const read = model.refresh(); await vi.advanceTimersByTimeAsync(3000); expect(api.promptQueueStatus).toHaveBeenCalledTimes(2);
  const writing = deferred<PromptQueueStatus>(); api.changePromptQueue.mockReturnValueOnce(writing.promise);
  const add = model.add(); await model.add(); reading.resolve(status()); await read; await settle();
  expect(api.changePromptQueue).toHaveBeenCalledTimes(1); model.setDraft('second'); writing.resolve(status([item('first')], { revision: 'r2' })); await add;
  expect(model.getSnapshot().draft).toBe('second');
});

it('navigation and disable invalidate pending checks before any mutation', async () => {
  const first = setup(); await settle(); first.model.setDraft('old session');
  const reading = deferred<PromptQueueStatus>(); first.api.promptQueueStatus.mockReturnValueOnce(reading.promise);
  const add = first.model.add(); await settle(); stops.pop()!(); reading.resolve(status()); await add;
  expect(first.api.changePromptQueue).not.toHaveBeenCalled();
  const next = setup(); await settle(); next.model.setDraft('paused UI');
  const paused = deferred<PromptQueueStatus>(); next.api.promptQueueStatus.mockReturnValueOnce(paused.promise);
  const later = next.model.add(); await settle(); next.model.setDisabled(true); paused.resolve(status()); await later;
  expect(next.api.changePromptQueue).not.toHaveBeenCalled(); expect(next.model.getSnapshot().draft).toBe('paused UI');
});

it('honors the target text limit without clipping oversized drafts and rejects foreign status', async () => {
  const { api, model } = setup(status([], { maxTextLength: 4 })); await settle(); model.setDraft('12345');
  expect(model.canAdd()).toBe(false); await model.add(); expect(model.getSnapshot().draft).toBe('12345');
  api.promptQueueStatus.mockResolvedValueOnce(status([], { sessionId: 'foreign' })); await model.refresh();
  expect(model.getSnapshot().phase).toBe('error'); expect(api.changePromptQueue).not.toHaveBeenCalled();
});

it('renders pending controls separately from read-only receipts with an explicit unknown acknowledgement', async () => {
  const { model } = setup(status([item('pending'), item('sending', 'sending'), item('sent', 'sent'), item('unknown', 'unknown')])); await settle();
  for (const language of ['en', 'id'] as const) {
    const t = MESSAGES[language], html = renderToStaticMarkup(createElement(PromptQueueContent, { t, control: model, view: model.getSnapshot() }));
    expect(html).toContain('<details class="prompt-queue">'); expect(html).toContain(t.promptQueue.sourceHint);
    expect(html.match(/>Prompt pending<\/pre>/g)).toHaveLength(1);
    expect(html.split(`>${t.promptQueue.delete}</button>`)).toHaveLength(2);
    expect(html.split(`>${t.promptQueue.acknowledge}</button>`)).toHaveLength(3);
    expect(html).not.toContain('type="file"'); expect(html).not.toContain('maxLength=');
  }
});

it('does not label an ordinary in-flight send as uncertain delivery', async () => {
  const { model } = setup(status([item('sending', 'sending')], { paused: false })); await settle();
  const html = renderToStaticMarkup(createElement(PromptQueueContent, { t: MESSAGES.en, control: model, view: model.getSnapshot() }));
  expect(html).toContain(MESSAGES.en.promptQueue.running);
  expect(html).not.toContain(MESSAGES.en.promptQueue.blocked);
});

it('allows only local deletion and unknown acknowledgement when source identity is unavailable', async () => {
  const pending = item('pending'), unknown = item('unknown', 'unknown');
  const { api, model } = setup(status([pending, unknown], { supported: false })); await settle();
  model.setDraft('keep this draft'); await model.add(); model.beginEdit(pending); await model.move(pending, 1); await model.setPaused(false);
  expect(api.changePromptQueue).not.toHaveBeenCalled();
  await model.delete(pending);
  expect(api.changePromptQueue).toHaveBeenLastCalledWith('session', { action: 'delete', itemId: 'pending', revision: 'r1' });
  api.promptQueueStatus.mockResolvedValue(status([unknown], { supported: false, revision: 'r2' })); await model.refresh();
  await model.acknowledge(unknown);
  expect(api.changePromptQueue).toHaveBeenLastCalledWith('session', { action: 'acknowledge', itemId: 'unknown', revision: 'r2' });
  expect(model.getSnapshot().draft).toBe('keep this draft');
});

it('accepts empty unsupported status without enabling changes, and can refresh after a safe rebind', async () => {
  const { api, model } = setup(status([], { supported: false, revision: '' })); await settle();
  expect(model.getSnapshot().phase).toBe('ready'); model.setDraft('new target'); await model.add(); expect(api.changePromptQueue).not.toHaveBeenCalled();
  api.promptQueueStatus.mockResolvedValue(status([], { revision: 'rebound' })); await model.refresh();
  expect(api.changePromptQueue).not.toHaveBeenCalled(); await model.add();
  expect(api.changePromptQueue).toHaveBeenLastCalledWith('session', { action: 'add', text: 'new target', revision: 'rebound' });
});


it('allows explicit local removal of sent receipts without an uncertain warning or source action', async () => {
  const sent = item('sent', 'sent'); const { api, model } = setup(status([sent], { supported: false })); await settle();
  const html = renderToStaticMarkup(createElement(PromptQueueContent, { t: MESSAGES.en, control: model, view: model.getSnapshot() }));
  expect(html).toContain(MESSAGES.en.promptQueue.acknowledge); expect(html).not.toContain(MESSAGES.en.promptQueue.blocked);
  await model.acknowledge(sent);
  expect(api.changePromptQueue).toHaveBeenCalledExactlyOnceWith('session', { revision: 'r1', action: 'acknowledge', itemId: 'sent' });
});
