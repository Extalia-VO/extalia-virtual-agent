import { describe, expect, it, vi } from 'vitest';
import type { AgentHostApi } from '@extalia/platform';
import { createEvent, type EventBody, type ExtaliaEvent } from '@extalia/protocol';
import { sessionEventFeed, type SessionEventFeedState } from '../src/chat/sessionEventFeed';

function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: Error) => void;
  const promise = new Promise<T>((done, failed) => { resolve = done; reject = failed; });
  return { promise, resolve, reject };
}
const event = (id: string, body: EventBody, sessionId = 'observed') => createEvent({ id, sessionId,
  at: '2026-11-11T00:00:00.000Z', source: { runtime: 'codex', channel: 'hook' }, agentId: 'primary', body });
const tool = event('hook-completion', { type: 'tool.completed', tool: 'view_image', toolCallId: 'image-call', kind: 'read', label: 'Viewed an image', ok: true });
const updated = () => event('revision-hint', { type: 'session.updated', revision: 'source-2', messageCount: 1 });
function fixture() {
  let listener!: (event: ExtaliaEvent) => void;
  const reads: ReturnType<typeof deferred<ExtaliaEvent[]>>[] = [];
  const unsubscribe = vi.fn();
  const host: Pick<AgentHostApi, 'sessionEvents' | 'subscribe'> = {
    subscribe: next => { listener = next; return unsubscribe; },
    sessionEvents: vi.fn(async () => { const read = deferred<ExtaliaEvent[]>(); reads.push(read); return read.promise; }),
  };
  const states: SessionEventFeedState[] = [];
  const stop = sessionEventFeed(host, 'observed', state => states.push(state));
  return { host, reads, states, stop, unsubscribe, emit: (value: ExtaliaEvent) => listener(value) };
}
const tick = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

describe('authoritative observed session refresh', () => {
  it('subscribes before history and merges early live events once', async () => {
    const f = fixture();
    f.emit(tool); f.reads[0]!.resolve([tool]); await tick();
    expect(f.states.at(-1)?.events).toEqual([tool]);
    f.stop(); expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('hydrates same-ID hook rows and removes obsolete media on later authoritative refresh', async () => {
    const f = fixture(); f.reads[0]!.resolve([tool]); await tick();
    const enriched = { ...tool, body: { ...tool.body, attachments: [{ name: 'image.png', kind: 'image' as const, size: 1024, ref: 'a'.repeat(64) }] } } as ExtaliaEvent;
    f.emit(updated()); f.reads[1]!.resolve([enriched]); await tick();
    expect(f.states.at(-1)?.events).toEqual([enriched]);
    f.emit(updated()); f.reads[2]!.resolve([tool]); await tick();
    expect(f.states.at(-1)?.events).toEqual([tool]);
    f.stop();
  });

  it('coalesces refresh hints and keeps stream events arriving during a read', async () => {
    const f = fixture();
    f.emit(updated()); f.emit(updated()); f.emit(updated());
    expect(f.reads).toHaveLength(1);
    f.reads[0]!.resolve([tool]); await tick();
    expect(f.reads).toHaveLength(2);
    const reply = event('reply', { type: 'model.completed', text: 'Done.' });
    f.emit(reply); f.reads[1]!.resolve([tool]); await tick();
    expect(f.states.at(-1)?.events).toEqual([tool, reply]);
    expect(f.reads).toHaveLength(2);
    f.stop();
  });

  it('clears obsolete history on refresh failure and retries on the next hint', async () => {
    const f = fixture(); f.reads[0]!.resolve([tool]); await tick();
    f.emit(updated()); f.reads[1]!.reject(new Error('Offline')); await tick();
    expect(f.states.at(-1)).toMatchObject({ events: [], error: 'Offline', loading: false });
    f.emit(updated()); f.reads[2]!.resolve([tool]); await tick();
    expect(f.states.at(-1)?.error).toBeNull();
    f.stop();
  });

  it('suppresses pre-privacy responses and buffered media when a redaction refresh fails', async () => {
    const f = fixture();
    const privateResult = { ...tool, body: { ...tool.body, attachments: [{ name: 'private.png', kind: 'image' as const, size: 1024, ref: 'a'.repeat(64) }] } } as ExtaliaEvent;
    f.emit(privateResult);
    f.emit(updated());
    f.reads[0]!.resolve([privateResult]); await tick();
    expect(f.states).toEqual([]);
    expect(f.reads).toHaveLength(2);
    f.reads[1]!.reject(new Error('Refresh failed')); await tick();
    expect(f.states.at(-1)).toEqual({ events: [], error: 'Refresh failed', loading: false });
    f.emit(updated()); f.reads[2]!.resolve([tool]); await tick();
    expect(f.states.at(-1)?.events).toEqual([tool]);
    f.stop();
  });

  it('ignores unrelated hints and old-session results after cleanup', async () => {
    const f = fixture();
    f.emit(event('other', { type: 'session.updated', revision: 'x', messageCount: 0 }, 'other'));
    expect(f.reads).toHaveLength(1);
    f.stop(); f.reads[0]!.resolve([tool]); await tick();
    expect(f.states).toEqual([]);
    expect(f.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
