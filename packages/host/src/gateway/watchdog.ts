/**
 * Independent External Host Watchdog for Universal Gateway v2 (Milestone M5, Issue #143).
 *
 * Monitors a Host-written lease file and optional external health probe without
 * trusting Host self-reports, classifying health states and deduplicating
 * `host_down` / `recovered` alerts per outage episode (GW-AT-076, GW-AT-098, GW-AT-099).
 */
import {
  validateHostWatchdogLeaseSnapshot,
  type HostWatchdogAlertEvent,
  type HostWatchdogHealthState,
  type HostWatchdogLeaseSnapshot,
  type HostWatchdogStatus,
} from '@extalia/platform';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

export type ReadHostWatchdogLeaseResult =
  | { readonly ok: true; readonly snapshot: HostWatchdogLeaseSnapshot }
  | { readonly ok: false; readonly kind: 'missing' | 'invalid'; readonly reason: string };

export interface HostWatchdogMonitorOptions {
  leaseFilePath: string;
  staleAfterMs: number;
  downAfterMs: number;
  alertCooldownMs?: number;
  probeHealth?: () => Promise<boolean>;
  onAlert?: (event: HostWatchdogAlertEvent) => Promise<void> | void;
  now?: () => number;
}

/**
 * Atomically writes a validated Host Watchdog lease snapshot to disk using a
 * sibling temporary file followed by rename.
 */
export async function writeHostWatchdogLease(
  leaseFilePath: string,
  snapshot: HostWatchdogLeaseSnapshot,
): Promise<void> {
  const validation = validateHostWatchdogLeaseSnapshot(snapshot);
  if (!validation.ok) {
    throw new Error(`Invalid host watchdog lease snapshot: ${validation.error}`);
  }

  const directory = path.dirname(leaseFilePath);
  await mkdir(directory, { recursive: true });
  const tempPath = path.join(
    directory,
    `${path.basename(leaseFilePath)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    await writeFile(tempPath, JSON.stringify(validation.value, null, 2), 'utf8');
    await rename(tempPath, leaseFilePath);
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

/**
 * Reads and validates a Host Watchdog lease snapshot without throwing on
 * missing or corrupt files.
 */
export async function readHostWatchdogLease(
  leaseFilePath: string,
): Promise<ReadHostWatchdogLeaseResult> {
  let rawText: string;
  try {
    rawText = await readFile(leaseFilePath, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'ENOENT') {
      return { ok: false, kind: 'missing', reason: 'Host watchdog lease file is missing.' };
    }
    return {
      ok: false,
      kind: 'invalid',
      reason: error instanceof Error ? error.message : 'Unable to read host watchdog lease file.',
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch {
    return { ok: false, kind: 'invalid', reason: 'Host watchdog lease file contains invalid JSON.' };
  }

  const validation = validateHostWatchdogLeaseSnapshot(parsed);
  if (!validation.ok) {
    return { ok: false, kind: 'invalid', reason: validation.error };
  }
  return { ok: true, snapshot: validation.value };
}

async function runSafeProbe(probe: () => Promise<boolean>): Promise<boolean> {
  try {
    return Boolean(await probe());
  } catch {
    return false;
  }
}

/**
 * Independent Host Watchdog Monitor with episode-based alert deduplication.
 */
export class HostWatchdogMonitor {
  private readonly leaseFilePath: string;
  private readonly staleAfterMs: number;
  private readonly downAfterMs: number;
  private readonly alertCooldownMs: number;
  private readonly probeHealth?: () => Promise<boolean>;
  private readonly onAlert?: (event: HostWatchdogAlertEvent) => Promise<void> | void;
  private readonly now: () => number;

  private inOutageEpisode = false;
  private downAlertEmittedForEpisode = false;
  private lastDownAlertAtMs: number | null = null;
  private lastStatus: HostWatchdogStatus | undefined;

  constructor(options: HostWatchdogMonitorOptions) {
    if (!Number.isFinite(options.staleAfterMs) || options.staleAfterMs <= 0) {
      throw new Error('staleAfterMs must be a positive number.');
    }
    if (!Number.isFinite(options.downAfterMs) || options.downAfterMs < options.staleAfterMs) {
      throw new Error('downAfterMs must be greater than or equal to staleAfterMs.');
    }
    const cooldown = options.alertCooldownMs ?? 0;
    if (!Number.isFinite(cooldown) || cooldown < 0) {
      throw new Error('alertCooldownMs must be a non-negative number.');
    }

    this.leaseFilePath = options.leaseFilePath;
    this.staleAfterMs = options.staleAfterMs;
    this.downAfterMs = options.downAfterMs;
    this.alertCooldownMs = cooldown;
    this.probeHealth = options.probeHealth;
    this.onAlert = options.onAlert;
    this.now = options.now ?? (() => Date.now());
  }

  getLastStatus(): HostWatchdogStatus | undefined {
    return this.lastStatus;
  }

  async evaluate(): Promise<HostWatchdogStatus> {
    const nowMs = this.now();
    const checkedAt = new Date(nowMs).toISOString();
    const leaseResult = await readHostWatchdogLease(this.leaseFilePath);

    if (!leaseResult.ok) {
      const status: HostWatchdogStatus = {
        state: 'unknown',
        checkedAt,
        reason: leaseResult.reason,
      };
      this.lastStatus = status;
      return status;
    }

    const { snapshot } = leaseResult;
    const heartbeatMs = Date.parse(snapshot.heartbeatAt);
    const leaseAgeMs = Math.max(0, nowMs - heartbeatMs);
    const probeOk = this.probeHealth ? await runSafeProbe(this.probeHealth) : undefined;

    let state: HostWatchdogHealthState;
    let reason: string;

    if (leaseAgeMs >= this.downAfterMs) {
      state = 'host_down';
      reason = `Host lease age ${leaseAgeMs}ms exceeded down threshold ${this.downAfterMs}ms.`;
    } else if (leaseAgeMs >= this.staleAfterMs && probeOk === false) {
      state = 'host_down';
      reason = `Host lease is stale (${leaseAgeMs}ms) and health probe failed.`;
    } else if (leaseAgeMs >= this.staleAfterMs) {
      state = 'suspected_stalled';
      reason = `Host lease age ${leaseAgeMs}ms exceeded stale threshold ${this.staleAfterMs}ms.`;
    } else if (probeOk === false) {
      state = 'degraded';
      reason = 'Host lease is fresh, but external health probe failed.';
    } else {
      state = 'healthy';
      reason = 'Host lease is fresh and healthy.';
    }

    const status: HostWatchdogStatus = {
      state,
      checkedAt,
      leaseAgeMs,
      heartbeatAt: snapshot.heartbeatAt,
      ...(probeOk !== undefined ? { probeOk } : {}),
      reason,
    };
    this.lastStatus = status;

    if (state === 'host_down') {
      if (!this.inOutageEpisode) {
        this.inOutageEpisode = true;
        const withinCooldown =
          this.alertCooldownMs > 0 &&
          this.lastDownAlertAtMs !== null &&
          nowMs - this.lastDownAlertAtMs < this.alertCooldownMs;

        if (!withinCooldown) {
          this.downAlertEmittedForEpisode = true;
          this.lastDownAlertAtMs = nowMs;
          await this.emitAlert({
            id: randomUUID(),
            kind: 'host_down',
            state,
            at: checkedAt,
            reason,
          });
        }
      }
    } else if (state === 'healthy' && this.inOutageEpisode) {
      const shouldEmitRecovery = this.downAlertEmittedForEpisode;
      this.inOutageEpisode = false;
      this.downAlertEmittedForEpisode = false;
      if (shouldEmitRecovery) {
        await this.emitAlert({
          id: randomUUID(),
          kind: 'recovered',
          state,
          at: checkedAt,
          reason,
        });
      }
    }

    return status;
  }

  private async emitAlert(event: HostWatchdogAlertEvent): Promise<void> {
    if (!this.onAlert) return;
    await this.onAlert(event);
  }
}
