import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PromptQueues, type PromptQueueTarget } from '../src/promptQueue.js';
import type { PromptQueueChange } from '@extalia/platform';

const cleanups: Array<() => Promise<void>> = [];
async function waitFor(check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 1000; i++) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 2)); }
  expect(await check()).toBe(true);
}
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never;
async function make(overrides: Partial<Parameters<typeof PromptQueues.create>[0]> = {}) {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-prompt-queue-'));
  const target: PromptQueueTarget = { identity: 'synthetic-source-identity', available: true, ready: false, maxTextLength: 100_000, persist: true };
  const calls: Array<{ id: string; text: string }> = [];
  const options = { dataDirectory: root, target: async (_id: string) => target,
    dispatch: async (id: string, text: string): Promise<'sent' | 'unknown'> => { calls.push({ id, text }); target.ready = false; return 'sent'; },
    pollIntervalMs: 10, drainTimeoutMs: 10, ...overrides };
  let queues = await PromptQueues.create(options);
  const all = [queues];
  cleanups.push(async () => { await Promise.all(all.map(queue => queue.close())); await rm(root, { recursive: true, force: true }); });
  const change = async (input: WithoutRevision<PromptQueueChange>, id = 'session-1') => queues.change(id, { ...input, revision: (await queues.status(id)).revision } as PromptQueueChange);
  return { root, target, calls, queues, options, change,
    async restart() { await queues.close(); queues = await PromptQueues.create(options); all.push(queues); return queues; },
  };
}
afterEach(async () => { await Promise.all(cleanups.splice(0).map(cleanup => cleanup())); });

describe('PromptQueues', () => {
  it('scopes paused drafts and uncertain delivery by session without starting or changing either queue', async () => {
    const calls: string[] = [];
    const fixture = await make({ pollIntervalMs: 0, dispatch: async id => { calls.push(id); return 'unknown'; } });
    const paused = await fixture.change({ action: 'add', text: 'paused first workspace' });
    fixture.target.ready = true;
    await fixture.change({ action: 'add', text: 'uncertain second workspace', start: true }, 'session-2');
    await waitFor(async () => (await fixture.queues.status('session-2')).items[0]?.state === 'unknown');
    await waitFor(() => !fixture.queues.isBusy);
    const unknown = await fixture.queues.status('session-2');
    const before = await readFile(path.join(fixture.root, 'state', 'prompt-queues.json'), 'utf8');
    expect(paused.paused).toBe(true);
    expect(unknown.paused).toBe(true);
    expect(fixture.queues.hasUnfinishedWorkMatching(id => id === 'session-1')).toBe(true);
    expect(fixture.queues.hasUnfinishedWorkMatching(id => id === 'session-2')).toBe(true);
    expect(fixture.queues.hasUnfinishedWorkMatching(id => id === 'session-other')).toBe(false);
    expect(fixture.queues.hasUnfinishedWorkMatching(() => false)).toBe(false);
    expect(calls).toEqual(['session-2']);
    expect(await readFile(path.join(fixture.root, 'state', 'prompt-queues.json'), 'utf8')).toBe(before);
    const unchanged = await fixture.queues.status('session-1');
    expect(unchanged).toEqual(paused);
    expect(await fixture.queues.status('session-2')).toEqual(unknown);
  });

  it('includes an actual reserved send through receipt persistence, then excludes only the settled sent receipt', async () => {
    let entered = false, release!: () => void, holdReceipt = false;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await make({ pollIntervalMs: 0, persist: async write => {
      const result = await write();
      if (holdReceipt && JSON.parse(await readFile(path.join(fixture.root, 'state', 'prompt-queues.json'), 'utf8')).queues[0]?.items[0]?.state === 'sent') {
        entered = true; await gate;
      }
      return result;
    } });
    await fixture.change({ action: 'add', text: 'one reserved dispatch' });
    fixture.target.ready = true; holdReceipt = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => { fixture.queues.wake('session-1'); return entered; });
    expect(fixture.queues.hasUnfinishedWork).toBe(false);
    expect(fixture.queues.isBusy).toBe(true);
    expect(fixture.queues.hasUnfinishedWorkMatching(id => id === 'session-1')).toBe(true);
    expect(fixture.queues.hasUnfinishedWorkMatching(id => id === 'session-2')).toBe(false);
    release();
    await waitFor(() => !fixture.queues.isBusy);
    const completed = await fixture.queues.status('session-1');
    expect(completed.items[0]!.state).toBe('sent');
    expect(fixture.queues.hasUnfinishedWorkMatching(() => true)).toBe(false);
    expect(fixture.calls).toEqual([{ id: 'session-1', text: 'one reserved dispatch' }]);
  });

  it('atomically starts an explicit composer addition and refuses it without adding behind uncertainty', async () => {
    const fixture = await make({ dispatch: async () => 'unknown' });
    fixture.target.ready = true;
    await fixture.change({ action: 'add', text: 'composer submit', start: true });
    await waitFor(async () => (await fixture.queues.status('session-1')).items[0]?.state === 'unknown');
    await expect(fixture.change({ action: 'add', text: 'must remain in composer', start: true })).rejects.toThrow('acknowledge');
    expect((await fixture.queues.status('session-1')).items).toHaveLength(1);
    expect(await fixture.change({ action: 'add', text: 'explicit paused draft' })).toMatchObject({ paused: true, items: [{ state: 'unknown' }, { state: 'pending' }] });
  });

  it('reserves an exact pending steer durably, serializes competing requests and never uses idle dispatch', async () => {
    let entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await make({ pollIntervalMs: 0 });
    fixture.target.steering = { identity: 'live-run-1', async send(text) {
      expect(text).toBe('steer this run');
      const raw = JSON.parse(await readFile(path.join(fixture.root, 'state', 'prompt-queues.json'), 'utf8'));
      expect(raw.queues[0].items[0].state).toBe('sending');
      entered = true; await gate; return 'sent';
    } };
    const queue = await fixture.change({ action: 'add', text: 'steer this run' });
    expect(queue.canSteer).toBe(true);
    const steering = fixture.queues.change('session-1', { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id });
    await waitFor(() => entered);
    await expect(fixture.queues.change('session-1', { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id })).rejects.toThrow('changed');
    expect((await fixture.queues.status('session-1')).canSteer).toBe(false);
    release();
    expect(await steering).toMatchObject({ paused: true, items: [{ state: 'sent' }] });
    expect(fixture.calls).toEqual([]);
  });

  it('returns a reservation to pending when the live turn binding changes before steer handoff', async () => {
    let hold = false, entered = false, release!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await make({ pollIntervalMs: 0, persist: async write => { if (hold) { entered = true; await gate; } return write(); } });
    fixture.target.steering = { identity: 'original-turn', async send() { calls++; return 'sent'; } };
    const queue = await fixture.change({ action: 'add', text: 'original turn only' });
    hold = true;
    const steering = fixture.queues.change('session-1', { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id });
    await waitFor(() => entered);
    fixture.target.steering = { identity: 'replacement-turn', async send() { calls++; return 'sent'; } };
    release();
    expect(await steering).toMatchObject({ items: [{ state: 'pending' }] });
    expect(calls).toBe(0);
  });

  it('keeps an ambiguous steer as an unknown receipt through restart without replay', async () => {
    let calls = 0;
    const fixture = await make({ pollIntervalMs: 0 });
    fixture.target.steering = { identity: 'same-turn', async send() { calls++; throw new Error('Transport disconnected after write'); } };
    const queue = await fixture.change({ action: 'add', text: 'ambiguous steering' });
    const result = await fixture.queues.change('session-1', { revision: queue.revision, action: 'steer', itemId: queue.items[0]!.id });
    expect(result).toMatchObject({ paused: true, canSteer: false, items: [{ state: 'unknown' }] });
    await expect(fixture.change({ action: 'steer', itemId: queue.items[0]!.id })).rejects.toThrow('acknowledge');
    expect(await (await fixture.restart()).status('session-1')).toMatchObject({ paused: true, canSteer: false, items: [{ state: 'unknown' }] });
    expect(calls).toBe(1); expect(fixture.calls).toEqual([]);
  });

  it('keeps drafts paused, edits/reorders/deletes pending items and dispatches in order only when idle', async () => {
    const fixture = await make();
    const first = await fixture.change({ action: 'add', text: 'first' });
    const a = first.items[0]!.id;
    const second = await fixture.change({ action: 'add', text: 'second' });
    const b = second.items[1]!.id;
    const third = await fixture.change({ action: 'add', text: 'third' });
    const c = third.items[2]!.id;
    await fixture.change({ action: 'edit', itemId: a, text: 'first edited' });
    await fixture.change({ action: 'reorder', itemIds: [c, a, b] });
    await fixture.change({ action: 'delete', itemId: b });
    expect(fixture.calls).toEqual([]);
    await fixture.change({ action: 'pause', paused: false });
    expect(fixture.calls).toEqual([]);
    fixture.target.ready = true; fixture.queues.wake('session-1');
    await waitFor(() => fixture.calls.length === 1);
    expect(fixture.calls).toEqual([{ id: 'session-1', text: 'third' }]);
    await waitFor(async () => (await fixture.queues.status('session-1')).items.some(item => item.id === c && item.state === 'sent'));
    await expect(fixture.change({ action: 'edit', itemId: c, text: 'cannot edit sent' })).rejects.toThrow('pending');
    await expect(fixture.change({ action: 'delete', itemId: c })).rejects.toThrow('pending');
    fixture.target.ready = true; fixture.queues.wake('session-1');
    await waitFor(() => fixture.calls.length === 2);
    expect(fixture.calls[1]).toEqual({ id: 'session-1', text: 'first edited' });
  });

  it('serializes CAS races and rejects partial, duplicate or foreign pending permutations', async () => {
    const { queues, change } = await make();
    const status = await change({ action: 'add', text: 'original' });
    const itemId = status.items[0]!.id;
    const results = await Promise.allSettled(['one', 'two'].map(text => queues.change('session-1', { revision: status.revision, action: 'edit', itemId, text })));
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    await expect(change({ action: 'reorder', itemIds: [] })).rejects.toThrow('exactly once');
    await expect(change({ action: 'reorder', itemIds: [itemId, itemId] })).rejects.toThrow('exactly once');
    await expect(change({ action: 'reorder', itemIds: ['foreign-item'] })).rejects.toThrow('exactly once');
    await expect(change({ action: 'edit', itemId, text: ' ' })).rejects.toThrow('characters');
  });

  it('pauses on unknown delivery and never retries without explicit receipt acknowledgement and Start', async () => {
    let calls = 0;
    const fixture = await make({ dispatch: async () => { calls++; throw new Error('Synthetic transport uncertainty'); } });
    await fixture.change({ action: 'add', text: 'uncertain first' });
    await fixture.change({ action: 'add', text: 'later' });
    fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(async () => (await fixture.queues.status('session-1')).items[0]?.state === 'unknown');
    const status = await fixture.queues.status('session-1');
    expect(status.paused).toBe(true); expect(calls).toBe(1);
    await expect(fixture.change({ action: 'pause', paused: false })).rejects.toThrow('acknowledge');
    await expect(fixture.change({ action: 'delete', itemId: status.items[0]!.id })).rejects.toThrow('pending');
    await fixture.change({ action: 'acknowledge', itemId: status.items[0]!.id });
    expect(calls).toBe(1);
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => calls === 2);
  });

  it('durably reserves sending before handoff and seals a hung dispatcher on close without late writes', async () => {
    let release!: (result: 'sent') => void, calls = 0;
    const gate = new Promise<'sent'>(resolve => { release = resolve; });
    const fixture = await make({ dispatch: async () => { calls++; return gate; } });
    await fixture.change({ action: 'add', text: 'reserved first' });
    await fixture.change({ action: 'add', text: 'never automatically replayed' });
    fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => calls === 1);
    const file = path.join(fixture.root, 'state', 'prompt-queues.json');
    const interrupted = await readFile(file, 'utf8');
    expect(JSON.parse(interrupted).queues[0].items[0].state).toBe('sending');
    await fixture.queues.close();
    const sealed = await readFile(file, 'utf8');
    expect(JSON.parse(sealed).queues[0]).toMatchObject({ paused: true, items: [{ text: 'reserved first', state: 'unknown' }, { text: 'never automatically replayed', state: 'pending' }] });
    release('sent'); await new Promise(resolve => setTimeout(resolve, 20));
    expect(await readFile(file, 'utf8')).toBe(sealed);
    // Restore the write-ahead snapshot to model a crash before any receipt was recorded.
    await writeFile(file, interrupted, { mode: 0o600 });
    const restored = await fixture.restart();
    expect(await restored.status('session-1')).toMatchObject({ paused: true, items: [{ state: 'unknown' }, { state: 'pending' }] });
    expect(calls).toBe(1);
  });

  it('suspends before a delayed write-ahead reservation can invoke dispatch', async () => {
    let hold = false, entered = false, release!: () => void, calls = 0;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const fixture = await make({ persist: async write => { if (hold) { entered = true; await gate; } return write(); }, dispatch: async () => { calls++; return 'sent'; } });
    await fixture.change({ action: 'add', text: 'keep as draft' });
    await fixture.change({ action: 'pause', paused: false });
    fixture.target.ready = true; hold = true; fixture.queues.wake('session-1');
    await waitFor(() => entered);
    const suspended = fixture.queues.suspend('session-1');
    release(); await suspended;
    await waitFor(async () => (await fixture.queues.status('session-1')).items[0]?.state === 'pending');
    expect(calls).toBe(0);
    expect((await fixture.queues.status('session-1')).paused).toBe(true);
  });

  it('rejects an older Start mutation still awaiting its source when suspend revokes it', async () => {
    let hold = false, entered = false, release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const target: PromptQueueTarget = { identity: 'stable-source', ready: true, available: true, persist: true, maxTextLength: 100_000 };
    const fixture = await make({ pollIntervalMs: 0, target: async () => { if (hold) { entered = true; await gate; } return target; } });
    await fixture.change({ action: 'add', text: 'not started after suspension' });
    const revision = (await fixture.queues.status('session-1')).revision;
    hold = true;
    const starting = fixture.queues.change('session-1', { revision, action: 'pause', paused: false });
    const rejection = expect(starting).rejects.toThrow(/changed|suspended/);
    await waitFor(() => entered);
    const paused = fixture.queues.suspend('session-1'); release();
    await rejection; await paused;
    expect(await fixture.queues.status('session-1')).toMatchObject({ paused: true, items: [{ state: 'pending' }] });
    expect(fixture.calls).toEqual([]);
  });

  it('preserves drafts when source identity changes and never retargets them', async () => {
    const { queues, target, change, calls } = await make();
    await change({ action: 'add', text: 'original source only' });
    await change({ action: 'pause', paused: false });
    target.identity = 'replacement-source'; target.ready = true;
    expect(await queues.status('session-1')).toMatchObject({ supported: false, paused: true, items: [{ text: 'original source only', state: 'pending' }] });
    await expect(change({ action: 'edit', itemId: (await queues.status('session-1')).items[0]!.id, text: 'no retarget' })).rejects.toThrow('unavailable');
    expect(calls).toEqual([]);
    const old = (await queues.status('session-1')).items[0]!;
    expect(await change({ action: 'delete', itemId: old.id })).toMatchObject({ supported: true, paused: true, items: [] });
    expect(await change({ action: 'add', text: 'explicit replacement draft' })).toMatchObject({ paused: true, items: [{ text: 'explicit replacement draft' }] });
    expect(calls).toEqual([]);
  });

  it('durably upgrades a host-verified legacy identity after restart while keeping pending prompts paused', async () => {
    const fixture = await make({ pollIntervalMs: 0 });
    const before = await fixture.change({ action: 'add', text: 'preserved upgrade prompt' });
    await fixture.change({ action: 'pause', paused: false });
    const legacy = fixture.target.identity;
    fixture.target.identity = 'scoped-source-identity'; fixture.target.compatibleIdentities = [legacy]; fixture.target.ready = true;
    const restored = await fixture.restart();
    const status = await restored.status('session-1');
    expect(status).toMatchObject({ supported: true, paused: true, items: before.items });
    expect(status.revision).not.toBe(before.revision);
    const file = path.join(fixture.root, 'state', 'prompt-queues.json');
    expect(JSON.parse(await readFile(file, 'utf8')).queues[0]).toMatchObject({ identity: fixture.target.identity, paused: true, items: before.items });
    expect(fixture.calls).toEqual([]);
    // Compatibility is no longer needed after the local identity migration is durable.
    delete fixture.target.compatibleIdentities;
    expect(await (await fixture.restart()).status('session-1')).toMatchObject({ supported: true, paused: true, items: before.items });
    expect(fixture.calls).toEqual([]);
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => fixture.calls.length === 1);
    expect(fixture.calls).toEqual([{ id: 'session-1', text: 'preserved upgrade prompt' }]);
  });

  it.each([true, false])('preserves an existing paused=%s state during a verified identity upgrade without inspection dispatch', async paused => {
    const fixture = await make({ pollIntervalMs: 0 });
    await fixture.change({ action: 'add', text: 'existing start state' });
    if (!paused) await fixture.change({ action: 'pause', paused: false });
    // Finish any already scheduled readiness lookup before changing the identity.
    await fixture.queues.status('session-1');
    fixture.target.compatibleIdentities = [fixture.target.identity]; fixture.target.identity = 'upgraded-source';
    expect(await fixture.queues.status('session-1')).toMatchObject({ supported: true, paused, items: [{ state: 'pending' }] });
    expect(fixture.calls).toEqual([]);
  });

  it.each([{ compatible: undefined }, { compatible: ['another-original-identity'] }])('keeps incompatible persisted identities blocked with compatibility $compatible', async ({ compatible }) => {
    const fixture = await make({ pollIntervalMs: 0 });
    const before = await fixture.change({ action: 'add', text: 'original grants only' });
    const legacy = fixture.target.identity;
    fixture.target.identity = 'different-source'; fixture.target.compatibleIdentities = compatible; fixture.target.ready = true;
    const restored = await fixture.restart();
    expect(await restored.status('session-1')).toMatchObject({ supported: false, paused: true, items: before.items });
    const file = path.join(fixture.root, 'state', 'prompt-queues.json');
    expect(JSON.parse(await readFile(file, 'utf8')).queues[0].identity).toBe(legacy);
    expect(fixture.calls).toEqual([]);
  });

  it('never upgrades sending or unknown deliveries even when the host verifies the old identity', async () => {
    let entered = false, release!: (result: 'sent') => void;
    const held = new Promise<'sent'>(resolve => { release = resolve; });
    const fixture = await make({ pollIntervalMs: 0, dispatch: async () => { entered = true; return held; } });
    await fixture.change({ action: 'add', text: 'uncertain original handoff' });
    await fixture.change({ action: 'add', text: 'later pending prompt' });
    fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => { fixture.queues.wake('session-1'); return entered; });
    const legacy = fixture.target.identity;
    fixture.target.compatibleIdentities = [legacy]; fixture.target.identity = 'scoped-source';
    const sending = await fixture.queues.status('session-1');
    expect(sending).toMatchObject({ supported: false, paused: true, items: [{ state: 'sending' }, { state: 'pending' }] });
    const file = path.join(fixture.root, 'state', 'prompt-queues.json');
    expect(JSON.parse(await readFile(file, 'utf8')).queues[0].identity).toBe(legacy);
    const restored = await fixture.restart();
    release('sent');
    expect(await restored.status('session-1')).toMatchObject({ supported: false, paused: true, items: [{ state: 'unknown' }, { state: 'pending' }] });
    expect(JSON.parse(await readFile(file, 'utf8')).queues[0].identity).toBe(legacy);
    await expect(fixture.change({ action: 'pause', paused: false })).rejects.toThrow('unavailable');
    expect(fixture.calls).toEqual([]);
  });

  it.each([Array.from({ length: 5 }, (_, index) => `legacy-${index}`), ['x'.repeat(4097)], ['bad\0identity']].map(compatible => ({ compatible })))(
    'refuses unbounded or invalid compatibility declarations', async ({ compatible }) => {
      const fixture = await make({ pollIntervalMs: 0 });
      await fixture.change({ action: 'add', text: 'bounded compatibility' });
      fixture.target.compatibleIdentities = compatible;
      expect(await fixture.queues.status('session-1')).toMatchObject({ supported: false, paused: true, items: [{ state: 'pending' }] });
      expect(fixture.calls).toEqual([]);
    });

  it('never persists history-off text and restores all saved queues paused', async () => {
    const fixture = await make();
    fixture.target.persist = false;
    await fixture.change({ action: 'add', text: 'EPHEMERAL_QUEUE_TEXT' });
    const file = path.join(fixture.root, 'state', 'prompt-queues.json');
    expect(await readFile(file, 'utf8')).not.toContain('EPHEMERAL_QUEUE_TEXT');
    const restored = await fixture.restart();
    expect((await restored.status('session-1')).items).toEqual([]);
    fixture.target.persist = true;
    await fixture.change({ action: 'add', text: 'saved draft' });
    await fixture.change({ action: 'pause', paused: false });
    await expect((await fixture.restart()).status('session-1')).resolves.toMatchObject({ paused: true, items: [{ text: 'saved draft' }] });
  });

  it('does not allocate durable queues merely by visiting empty sessions and enforces pending limits', async () => {
    const { queues, root, change } = await make({ pollIntervalMs: 0 });
    for (let i = 0; i < 140; i++) expect((await queues.status(`view-${i}`)).items).toEqual([]);
    await expect(readFile(path.join(root, 'state', 'prompt-queues.json'))).rejects.toMatchObject({ code: 'ENOENT' });
    for (let i = 0; i < 50; i++) await change({ action: 'add', text: `pending-${i}` });
    await expect(change({ action: 'add', text: 'overflow' })).rejects.toThrow('50');
    await expect(change({ action: 'edit', itemId: (await queues.status('session-1')).items[0]!.id, text: 'x'.repeat(100_001) })).rejects.toThrow('characters');
    expect((await queues.status('session-1')).items).toHaveLength(50);
    expect(queues.isBusy).toBe(false);
  });

  it('drops a hung handoff without allowing its later completion to recreate the deleted queue', async () => {
    let release!: (result: 'sent') => void, entered = false;
    const gate = new Promise<'sent'>(resolve => { release = resolve; });
    const fixture = await make({ dispatch: async () => { entered = true; return gate; } });
    await fixture.change({ action: 'add', text: 'deleted owner' }); fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(() => entered);
    await fixture.queues.drop('session-1');
    const file = path.join(fixture.root, 'state', 'prompt-queues.json'), before = await readFile(file, 'utf8');
    expect(JSON.parse(before).queues).toEqual([]);
    release('sent'); await new Promise(resolve => setTimeout(resolve, 20));
    expect(await readFile(file, 'utf8')).toBe(before);
    expect(await fixture.queues.status('session-1')).toMatchObject({ supported: false, items: [] });
  });

  it('retains at most twenty sent receipts while preserving pending delivery order', async () => {
    let calls = 0;
    const fixture = await make({ dispatch: async () => { calls++; return 'sent'; } });
    for (let i = 0; i < 23; i++) await fixture.change({ action: 'add', text: `receipt-${i}` });
    fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    await waitFor(async () => calls === 23 && (await fixture.queues.status('session-1')).items.every(item => item.state === 'sent'));
    const status = await fixture.queues.status('session-1');
    expect(status.items).toHaveLength(20);
    expect(status.items.map(item => item.text)).toEqual(Array.from({ length: 20 }, (_, i) => `receipt-${i + 3}`));
    await fixture.change({ action: 'acknowledge', itemId: status.items[0]!.id });
    expect(calls).toBe(23);
  });

  it('reports idle after removing the last reserved handoff and ignores read-only inspections', async () => {
    let callbacks = 0, release!: (result: 'sent') => void;
    const callbackBusy: boolean[] = [];
    const gate = new Promise<'sent'>(resolve => { release = resolve; });
    const fixture: Awaited<ReturnType<typeof make>> = await make({ pollIntervalMs: 0, dispatch: async () => gate, onIdle: () => { callbacks++; callbackBusy.push(fixture.queues.isBusy); } });
    const inspection = fixture.queues.status('only-viewed');
    expect(fixture.queues.isBusy).toBe(false);
    await inspection;
    fixture.queues.wake('only-viewed');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callbacks).toBe(0);
    await fixture.change({ action: 'add', text: 'one reserved handoff' });
    fixture.target.ready = true;
    await fixture.change({ action: 'pause', paused: false });
    // A previous empty inspection may still own the wake slot; retry explicitly.
    await waitFor(() => { fixture.queues.wake('session-1'); return fixture.queues.isBusy; });
    release('sent');
    await waitFor(() => callbacks === 1);
    expect(callbackBusy).toEqual([false]);
    expect(fixture.queues.isBusy).toBe(false);
    fixture.queues.wake('session-1');
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(callbacks).toBe(1);
  });
});
