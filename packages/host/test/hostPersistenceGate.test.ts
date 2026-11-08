import { describe, expect, it, vi } from 'vitest';
import { HostPersistenceClosedError, HostPersistenceGate } from '../src/hostPersistenceGate.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

describe('host local persistence admission', () => {
  it('admits before deferred work starts and drains admitted writes after sealing', async () => {
    const gate = new HostPersistenceGate();
    const release = deferred(), write = vi.fn();
    const admitted = gate.run(async () => { await release.promise; write(); });
    gate.seal();
    let drained = false;
    const draining = gate.drain().then(() => { drained = true; });
    await Promise.resolve();
    expect(drained).toBe(false);
    await expect(gate.run(async () => write())).rejects.toBeInstanceOf(HostPersistenceClosedError);
    release.resolve();
    await Promise.all([admitted, draining]);
    expect(write).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
  });

  it('does not grant nested or ambient write authority to a previously admitted operation', async () => {
    const gate = new HostPersistenceGate();
    const release = deferred(), nested = vi.fn();
    const admitted = gate.run(async () => {
      await release.promise;
      await expect(gate.run(async () => nested())).rejects.toBeInstanceOf(HostPersistenceClosedError);
    });
    gate.seal();
    release.resolve();
    await gate.drain();
    await admitted;
    expect(nested).not.toHaveBeenCalled();
  });

  it('drains failures without leaking reservations and refuses any subsequent admission', async () => {
    const gate = new HostPersistenceGate();
    const failed = gate.run(async () => { throw new Error('Write failed.'); });
    await expect(failed).rejects.toThrow('Write failed.');
    gate.seal();
    await gate.drain();
    await expect(gate.run(async () => undefined)).rejects.toBeInstanceOf(HostPersistenceClosedError);
  });

  it('reports pending local work and notifies idle only after the last admitted promise settles', async () => {
    const gate = new HostPersistenceGate(), idle = vi.fn();
    const first = deferred(), second = deferred();
    gate.onIdle(idle);
    const a = gate.run(() => first.promise), b = gate.run(() => second.promise);
    expect(gate.isBusy).toBe(true);
    first.resolve();
    await a;
    expect(gate.isBusy).toBe(true);
    expect(idle).not.toHaveBeenCalled();
    second.resolve();
    await b;
    expect(gate.isBusy).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
  });
});
