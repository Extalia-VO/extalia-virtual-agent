import type { UpdateCapability, UpdateStatus } from '@extalia/platform';
import { describe, expect, it, vi } from 'vitest';
import { subscribeUpdateStatus } from '../src/updates/updateStatusFeed';

const initial: UpdateStatus = { state: 'idle', current: '1.0.0', channel: 'stable' };
const available: UpdateStatus = { ...initial, state: 'available', latest: '2.0.0' };
function setup() {
  let push!: (value: UpdateStatus) => void;
  let resolve!: (value: UpdateStatus) => void;
  let reject!: (reason: Error) => void;
  const remove = vi.fn(), receive = vi.fn();
  const updater: UpdateCapability = {
    onStatus: (listener: typeof push) => { push = listener; return remove; },
    status: () => new Promise<UpdateStatus>((yes, no) => { resolve = yes; reject = no; }),
    check: async () => available,
    install: async () => undefined,
    postpone: async () => undefined,
  };
  const stop = subscribeUpdateStatus(updater, receive);
  return { push, resolve, reject, stop, remove, receive };
}
describe('launch update status delivery', () => {
  it('hydrates an available release detected before the renderer subscribed', async () => {
    const h = setup(); h.resolve(available); await Promise.resolve();
    expect(h.receive).toHaveBeenCalledExactlyOnceWith(available);
  });
  it('does not replace a pushed release with a stale initial response', async () => {
    const h = setup(); h.push(available); h.resolve(initial); await Promise.resolve();
    expect(h.receive).toHaveBeenCalledExactlyOnceWith(available);
  });
  it('ignores late reads and callbacks after unmount', async () => {
    const h = setup(); h.stop(); h.push(available); h.resolve(available); await Promise.resolve();
    expect(h.remove).toHaveBeenCalledOnce(); expect(h.receive).not.toHaveBeenCalled();
  });
  it('recovers through later status events after a failed initial read', async () => {
    const h = setup(); h.reject(new Error('offline')); await Promise.resolve(); h.push(available);
    expect(h.receive).toHaveBeenCalledExactlyOnceWith(available);
  });
});
