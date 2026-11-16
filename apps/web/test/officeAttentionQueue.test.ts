import { describe, expect, it } from 'vitest';
import { createOfficeAttentionQueue, type OfficeAttentionRequest } from '../src/office/officeAttentionQueue';

const eligible = { active: true, blocked: false };
const request = (key: string, overrides: Partial<OfficeAttentionRequest> = {}): OfficeAttentionRequest => ({
  key, kind: 'input', sessionId: 'session', requestId: key, ...overrides,
});

describe('Office attention popup queue', () => {
  it('does not consume requests while inactive or blocked', () => {
    const queue = createOfficeAttentionQueue();
    const pending = request('input');
    expect(queue.take([pending], { active: false, blocked: false })).toBeUndefined();
    expect(queue.take([pending], { active: true, blocked: true })).toBeUndefined();
    expect(queue.take([pending], eligible)).toBe(pending);
  });

  it('does not reopen a dismissed request after polling, reordering or temporary disappearance', () => {
    const queue = createOfficeAttentionQueue();
    const first = request('a');
    const second = request('b', { kind: 'approval' });
    expect(queue.take([second, first], eligible)).toBe(first);
    expect(queue.take([first, second], { active: true, blocked: true })).toBeUndefined();
    expect(queue.take([second, first], eligible)).toBe(second);
    expect(queue.take([first, second], eligible)).toBeUndefined();
    expect(queue.take([], eligible)).toBeUndefined();
    expect(queue.take([{ ...second }, { ...first }], eligible)).toBeUndefined();
  });

  it('takes successive requests only after the modal gate clears', () => {
    const queue = createOfficeAttentionQueue();
    const first = request('a');
    const second = request('b');
    expect(queue.take([first, second], eligible)).toBe(first);
    expect(queue.take([first, second], { active: true, blocked: true })).toBeUndefined();
    expect(queue.take([first, second], eligible)).toBe(second);
  });

  it('drops canceled requests instead of retaining an earlier pending snapshot', () => {
    const queue = createOfficeAttentionQueue();
    const canceled = request('a');
    const remaining = request('b');
    expect(queue.take([canceled, remaining], { active: true, blocked: true })).toBeUndefined();
    expect(queue.take([remaining], eligible)).toBe(remaining);
    expect(queue.take([], eligible)).toBeUndefined();
  });

  it('orders valid timestamps chronologically, then stable keys, with unknown dates last', () => {
    const pending = [
      request('unknown'), request('invalid', { requestedAt: 'invalid' }),
      request('b', { requestedAt: '2026-01-01T00:00:00Z' }),
      request('a', { requestedAt: '2026-01-01T01:00:00+01:00' }),
      request('older', { requestedAt: '2025-12-31T23:00:00Z' }),
    ];
    for (const input of [pending, [...pending].reverse()]) {
      const queue = createOfficeAttentionQueue();
      expect(input.map(() => queue.take(input, eligible)?.key)).toEqual(['older', 'a', 'b', 'invalid', 'unknown']);
      expect(input).toHaveLength(5);
    }
  });

  it('deduplicates stable keys and admits a revised request through its new key', () => {
    const queue = createOfficeAttentionQueue();
    const original = request('revision-1', { requestId: 'same-request' });
    expect(queue.take([original, { ...original }], eligible)).toBe(original);
    expect(queue.take([{ ...original }], eligible)).toBeUndefined();
    const revised = { ...original, key: 'revision-2' };
    expect(queue.take([original, revised], eligible)).toBe(revised);
    expect(queue.take([revised], eligible)).toBeUndefined();
  });

  it('resets handled state when the parent creates a queue for a new scope', () => {
    const pending = request('input');
    const queue = createOfficeAttentionQueue();
    expect(queue.take([pending], eligible)).toBe(pending);
    expect(queue.take([pending], eligible)).toBeUndefined();
    expect(createOfficeAttentionQueue().take([pending], eligible)).toBe(pending);
  });

  it('retries only a released claim without reopening another shown key', () => {
    const queue = createOfficeAttentionQueue();
    const shown = request('a-shown');
    const unavailable = request('b-unavailable');
    const pending = [shown, unavailable];
    expect(queue.take(pending, eligible)).toBe(shown);
    expect(queue.take(pending, eligible)).toBe(unavailable);
    expect(queue.take(pending, eligible)).toBeUndefined();
    queue.release(unavailable.key);
    expect(queue.take(pending, eligible)).toBe(unavailable);
    expect(queue.take(pending, eligible)).toBeUndefined();
    expect(queue.take([shown], eligible)).toBeUndefined();
  });

  it('keeps a released claim eligible through inactive and blocked calls', () => {
    const queue = createOfficeAttentionQueue();
    const pending = request('input');
    expect(queue.take([pending], eligible)).toBe(pending);
    queue.release(pending.key);
    queue.release('unknown');
    expect(queue.take([pending], { active: false, blocked: false })).toBeUndefined();
    expect(queue.take([pending], { active: true, blocked: true })).toBeUndefined();
    expect(queue.take([pending], eligible)).toBe(pending);
    expect(queue.take([pending], eligible)).toBeUndefined();
  });

  it('bounds disappeared history and only reopens an old request after eviction', () => {
    const queue = createOfficeAttentionQueue();
    const requests = Array.from({ length: 2049 }, (_, index) => request(`request-${index}`));
    for (const pending of requests) expect(queue.take([pending], eligible)).toBe(pending);
    expect(queue.take([requests[2048]!], eligible)).toBeUndefined();
    expect(queue.take([requests[0]!], eligible)).toBe(requests[0]);
  });

  it('pins every unresolved key even beyond the history bound and prunes after resolution', () => {
    const queue = createOfficeAttentionQueue();
    const pending = Array.from({ length: 2050 }, (_, index) => request(`request-${String(index).padStart(4, '0')}`));
    for (const next of pending) expect(queue.take(pending, eligible)).toBe(next);
    expect(queue.take([...pending].reverse(), eligible)).toBeUndefined();
    expect(queue.take([], eligible)).toBeUndefined();
    expect(queue.take([pending[0]!], eligible)).toBe(pending[0]);
    expect(queue.take([pending[2049]!], eligible)).toBeUndefined();
  });
});
