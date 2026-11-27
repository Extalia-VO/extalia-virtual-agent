import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { createAgentHost } from '../src/service.js';
import { createCommandTool } from '../src/tools/command.js';
import { WorkerLeaseError, WorkerLeaseRegistry } from '../src/workerLease.js';
import { useTempDirs } from './helpers.js';

const tempDir = useTempDirs();

describe('WorkerLeaseRegistry', () => {
  it('issues monotonic fencing tokens across reopen and rejects duplicate active acquires', async () => {
    const root = await tempDir('extalia-worker-lease-');
    const registryFile = path.join(root, 'state', 'worker-leases.json');
    const clock = 10_000;

    const registryA = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-a',
      defaultTtlMs: 60_000,
      now: () => clock,
    });
    const first = await registryA.acquire({
      taskId: 'task-1',
      sessionId: 'ses-1',
      missionId: 'mis-1',
      worktreeId: 'w-000000000001',
    });
    expect(first.leaseId).toMatch(/^wl-[0-9a-f]{12}$/);
    expect(first.fencingToken).toBe(1);
    expect(first.status).toBe('active');
    expect(first.ownerId).toBe('host-a');

    // Duplicate active taskId or worktreeId is refused.
    await expect(registryA.acquire({ taskId: 'task-1' })).rejects.toMatchObject({ code: 'already_leased' });
    await expect(registryA.acquire({ taskId: 'task-other', worktreeId: 'w-000000000001' })).rejects.toMatchObject({
      code: 'already_leased',
    });

    await registryA.settle(first.leaseId, first.fencingToken, 'completed');

    // Same ownerId reopens and continues monotonic fencing tokens.
    const registryB = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-a',
      defaultTtlMs: 60_000,
      now: () => clock + 1_000,
    });
    const second = await registryB.acquire({ taskId: 'task-1', worktreeId: 'w-000000000001' });
    expect(second.fencingToken).toBe(2);
    expect(registryB.list().map(item => item.leaseId)).toEqual([second.leaseId, first.leaseId]);
  });

  it('requires active matching fencing token for attachProcess, heartbeat, assertFenced, and settle', async () => {
    const root = await tempDir('extalia-worker-lease-fence-');
    const registryFile = path.join(root, 'worker-leases.json');
    let clock = 50_000;

    const registry = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-1',
      defaultTtlMs: 1_000,
      now: () => clock,
    });

    const lease = await registry.acquire({ taskId: 'task-fence' });
    expect(() => registry.assertFenced(lease.leaseId, lease.fencingToken)).not.toThrow();
    expect(() => registry.assertFenced(lease.leaseId, lease.fencingToken + 1)).toThrowError(WorkerLeaseError);

    await expect(registry.attachProcess(lease.leaseId, lease.fencingToken + 1, { pid: 1234 })).rejects.toMatchObject({
      code: 'fenced',
    });
    const attached = await registry.attachProcess(lease.leaseId, lease.fencingToken, {
      pid: 4321,
      processGroupId: 4321,
    });
    expect(attached.pid).toBe(4321);
    expect(attached.processGroupId).toBe(4321);

    clock += 500;
    const pulsed = await registry.heartbeat(lease.leaseId, lease.fencingToken, 2_000);
    expect(Date.parse(pulsed.leaseExpiresAt)).toBe(clock + 2_000);
    await expect(registry.heartbeat(lease.leaseId, 999)).rejects.toMatchObject({ code: 'fenced' });

    // Expiry fences synchronous checks and mutations.
    clock += 2_000;
    expect(() => registry.assertFenced(lease.leaseId, lease.fencingToken)).toThrowError(WorkerLeaseError);
    await expect(registry.attachProcess(lease.leaseId, lease.fencingToken, { pid: 4322 })).rejects.toMatchObject({
      code: 'fenced',
    });
    await expect(registry.heartbeat(lease.leaseId, lease.fencingToken)).rejects.toMatchObject({
      code: 'fenced',
    });
    await expect(registry.settle(lease.leaseId, lease.fencingToken, 'completed')).rejects.toMatchObject({
      code: 'fenced',
    });
  });

  it('quarantines prior-host and expired active leases on open without blindly killing PIDs or replaying', async () => {
    const root = await tempDir('extalia-worker-lease-recovery-');
    const registryFile = path.join(root, 'worker-leases.json');
    let clock = 100_000;

    const priorHost = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-old',
      defaultTtlMs: 60_000,
      now: () => clock,
    });
    const priorLease = await priorHost.acquire({
      taskId: 'task-crash',
      worktreeId: 'w-0000000000aa',
    });
    await priorHost.attachProcess(priorLease.leaseId, priorLease.fencingToken, {
      pid: 999_991,
      processGroupId: 999_991,
    });

    // Ensure startup crash recovery NEVER invokes process.kill on persisted PIDs.
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw new Error('process.kill must not be called on startup recovery');
    });
    try {
      clock += 1_000;
      const newHost = await WorkerLeaseRegistry.open({
        registryFile,
        ownerId: 'host-new',
        defaultTtlMs: 60_000,
        now: () => clock,
      });

      const recovered = newHost.get(priorLease.leaseId);
      expect(recovered).toMatchObject({
        leaseId: priorLease.leaseId,
        status: 'quarantined',
        settlement: 'unknown',
        quarantineReason: 'host_restarted_before_settlement',
      });
      expect(killSpy).not.toHaveBeenCalled();

      // Zero blind replay: acquiring same taskId or worktreeId is refused with 'quarantined'.
      await expect(newHost.acquire({ taskId: 'task-crash' })).rejects.toMatchObject({ code: 'quarantined' });
      await expect(newHost.acquire({ taskId: 'task-other', worktreeId: 'w-0000000000aa' })).rejects.toMatchObject({
        code: 'quarantined',
      });

      // Explicit acknowledgement settles status while preserving settlement: 'unknown', unblocking acquire.
      const acknowledged = await newHost.acknowledgeQuarantine(priorLease.leaseId);
      expect(acknowledged).toMatchObject({
        leaseId: priorLease.leaseId,
        status: 'settled',
        settlement: 'unknown',
        quarantineReason: 'host_restarted_before_settlement',
      });
      expect(acknowledged.settledAt).toBe(new Date(clock).toISOString());

      await expect(newHost.acknowledgeQuarantine(priorLease.leaseId)).rejects.toMatchObject({
        code: 'not_quarantined',
      });
      await expect(newHost.acknowledgeQuarantine('wl-000000000000')).rejects.toMatchObject({
        code: 'not_found',
      });

      const reacquired = await newHost.acquire({ taskId: 'task-crash', worktreeId: 'w-0000000000aa' });
      expect(reacquired.status).toBe('active');
      expect(reacquired.fencingToken).toBe(priorLease.fencingToken + 1);
    } finally {
      killSpy.mockRestore();
    }

    // Same owner reopening after expiry also quarantines with lease_expired_before_settlement.
    clock += 120_000;
    const reopenedExpired = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-new',
      defaultTtlMs: 60_000,
      now: () => clock,
    });
    const list = reopenedExpired.list();
    expect(list[0]).toMatchObject({
      status: 'quarantined',
      settlement: 'unknown',
      quarantineReason: 'lease_expired_before_settlement',
    });
  });

  it('reapAndSettleLive settles cancelled on clean reap and quarantines unknown when reap fails', async () => {
    const root = await tempDir('extalia-worker-lease-reap-');
    const registryFile = path.join(root, 'worker-leases.json');
    const clock = 200_000;

    const registry = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-live',
      now: () => clock,
    });

    const leaseA = await registry.acquire({ taskId: 'task-reap-ok' });
    await registry.attachProcess(leaseA.leaseId, leaseA.fencingToken, { pid: 5001, processGroupId: 5001 });
    const signalsA: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const settledA = await registry.reapAndSettleLive(leaseA.leaseId, leaseA.fencingToken, {
      signalGroup: (pid, signal) => { signalsA.push({ pid, signal }); },
      reaped: Promise.resolve(true),
    });
    expect(signalsA).toEqual([{ pid: 5001, signal: 'SIGTERM' }]);
    expect(settledA).toMatchObject({ status: 'settled', settlement: 'cancelled' });

    const leaseB = await registry.acquire({ taskId: 'task-reap-fail' });
    await registry.attachProcess(leaseB.leaseId, leaseB.fencingToken, { pid: 5002 });
    const signalsB: Array<{ pid: number; signal: NodeJS.Signals }> = [];
    const settledB = await registry.reapAndSettleLive(leaseB.leaseId, leaseB.fencingToken, {
      signalGroup: (pid, signal) => { signalsB.push({ pid, signal }); },
      reaped: Promise.resolve(false),
    });
    expect(signalsB).toEqual([{ pid: 5002, signal: 'SIGTERM' }]);
    expect(settledB).toMatchObject({
      status: 'quarantined',
      settlement: 'unknown',
      quarantineReason: 'process_reap_failed',
    });

    // Fenced check refuses stale token.
    const leaseC = await registry.acquire({ taskId: 'task-reap-fenced' });
    await expect(registry.reapAndSettleLive(leaseC.leaseId, leaseC.fencingToken + 1)).rejects.toMatchObject({
      code: 'fenced',
    });
  });

  it('bounds retention at 256 leases by evicting oldest settled first and never evicting active/quarantined', async () => {
    const root = await tempDir('extalia-worker-lease-cap-');
    const registryFile = path.join(root, 'worker-leases.json');
    let clock = 1_000;

    const registry = await WorkerLeaseRegistry.open({
      registryFile,
      ownerId: 'host-cap',
      defaultTtlMs: 1_000_000,
      now: () => clock,
    });

    const first = await registry.acquire({ taskId: 'settled-0' });
    await registry.settle(first.leaseId, first.fencingToken, 'completed');
    clock += 10;

    for (let index = 1; index < 256; index++) {
      const lease = await registry.acquire({ taskId: `unresolved-${index}` });
      if (index % 2 === 0) {
        await registry.settle(lease.leaseId, lease.fencingToken, 'unknown', 'uncertain');
      }
      clock += 10;
    }
    expect(registry.list()).toHaveLength(256);

    // 257th acquire evicts the single settled lease (first).
    const replacement = await registry.acquire({ taskId: 'unresolved-256' });
    expect(registry.list()).toHaveLength(256);
    expect(registry.get(first.leaseId)).toBeUndefined();
    expect(registry.get(replacement.leaseId)?.status).toBe('active');

    // Now all 256 are active or quarantined -> 257th must be refused rather than evicting unresolved state.
    await expect(registry.acquire({ taskId: 'overflow' })).rejects.toMatchObject({ code: 'invalid' });
  });

  it('refuses to overwrite corrupt registry files on open', async () => {
    const root = await tempDir('extalia-worker-lease-corrupt-');
    const registryFile = path.join(root, 'worker-leases.json');
    await writeFile(registryFile, '{not valid json', 'utf8');

    await expect(WorkerLeaseRegistry.open({ registryFile, ownerId: 'host-corrupt' })).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(await readFile(registryFile, 'utf8')).toBe('{not valid json');
  });

  it.skipIf(process.platform === 'win32')('reports spawned child pid and processGroupId via command tool onChildSpawned', async () => {
    const root = await tempDir('extalia-command-pid-');
    const seen: Array<{ pid?: number; processGroupId?: number }> = [];
    const tool = createCommandTool(root, {
      onChildSpawned: info => { seen.push(info); },
    });
    const outcome = await tool.run(
      { command: 'echo ok' },
      { signal: new AbortController().signal, toolCallId: 'call-pid', emit: () => {} },
    );
    expect(outcome.ok).toBe(true);
    expect(seen).toHaveLength(1);
    expect(typeof seen[0]?.pid).toBe('number');
    expect(seen[0]?.pid).toBeGreaterThan(0);
    expect(seen[0]?.processGroupId).toBe(seen[0]?.pid);
  });
});

describe('AgentHost worker lease RPCs', () => {
  it('quarantines prior-host active leases at startup, validates inputs, and reconciles on acknowledge', async () => {
    const root = await tempDir('extalia-host-leases-');
    const data = path.join(root, 'data');
    const home = path.join(root, 'home');
    const stateDir = path.join(data, 'state');
    await mkdir(home, { recursive: true });
    await mkdir(stateDir, { recursive: true });

    const prePopulated = {
      schema: 'extalia.worker-leases.v1',
      nextFencingToken: 4,
      leases: [
        {
          leaseId: 'wl-abcdef123456',
          ownerId: 'prior-dead-host',
          taskId: 'task-prior',
          sessionId: 'ses-prior',
          missionId: 'mis-prior',
          worktreeId: 'w-1234567890ab',
          fencingToken: 3,
          pid: 987654,
          processGroupId: 987654,
          status: 'active',
          acquiredAt: '2026-11-26T10:00:00.000Z',
          heartbeatAt: '2026-11-26T10:01:00.000Z',
          leaseExpiresAt: '2026-11-26T10:05:00.000Z',
        },
      ],
    };
    const registryFile = path.join(stateDir, 'worker-leases.json');
    await writeFile(registryFile, JSON.stringify(prePopulated, null, 2), 'utf8');

    const runtime = await createAgentHost({
      kind: 'desktop',
      version: '0.0.0-test',
      dataDirectory: data,
      homeDirectory: home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: home },
      knowledge: { autoSyncAfterMs: Infinity, watcher: false },
    });

    try {
      const leases = await runtime.host.listWorkerLeases!();
      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({
        leaseId: 'wl-abcdef123456',
        status: 'quarantined',
        settlement: 'unknown',
        quarantineReason: 'host_restarted_before_settlement',
      });

      // Input validation rejects invalid lease ids and unsupported actions.
      await expect(runtime.host.reconcileWorkerLease!('bad-id', 'acknowledge')).rejects.toThrow(/Invalid worker lease id/);
      await expect(
        runtime.host.reconcileWorkerLease!('wl-abcdef123456', 'replay' as 'acknowledge'),
      ).rejects.toThrow(/Unsupported worker lease reconciliation action/);

      // Explicit acknowledgement settles the lease while preserving settlement: 'unknown'.
      const reconciled = await runtime.host.reconcileWorkerLease!('wl-abcdef123456', 'acknowledge');
      expect(reconciled).toMatchObject({
        leaseId: 'wl-abcdef123456',
        status: 'settled',
        settlement: 'unknown',
        quarantineReason: 'host_restarted_before_settlement',
      });
      expect(reconciled.settledAt).toBeTruthy();

      // Re-acknowledging is rejected cleanly.
      await expect(runtime.host.reconcileWorkerLease!('wl-abcdef123456', 'acknowledge')).rejects.toThrow(
        /Only quarantined worker leases/,
      );
    } finally {
      await runtime.close();
    }

    // Reopening confirms reconciled state persisted durably.
    const reopened = await createAgentHost({
      kind: 'desktop',
      version: '0.0.0-test',
      dataDirectory: data,
      homeDirectory: home,
      env: { EXTALIA_SECRET_STORE: 'memory', PATH: process.env.PATH, HOME: home },
      knowledge: { autoSyncAfterMs: Infinity, watcher: false },
    });
    try {
      const leases = await reopened.host.listWorkerLeases!();
      expect(leases).toHaveLength(1);
      expect(leases[0]).toMatchObject({
        leaseId: 'wl-abcdef123456',
        status: 'settled',
        settlement: 'unknown',
      });
    } finally {
      await reopened.close();
    }
  });
});
