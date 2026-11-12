/**
 * When Desktop checks, downloads and restarts into updates. Pure and free of
 * Electron so the rules can be unit tested; `updater.ts` connects it to
 * electron-updater.
 */
import type { UpdateChannel, UpdateStatus } from '@extalia/platform';
import { safeMessage } from './ipc';

export const RESTART_DELAY_SECONDS = 10;
export const WAITING_FOR_AGENTS = 'Restarts when the running agents finish.';

/** electron-updater events, reduced to what the policy needs. */
export type UpdaterEvent =
  | { type: 'checking' }
  | { type: 'available'; version: string }
  | { type: 'not-available'; version?: string }
  | { type: 'progress'; percent: number }
  | { type: 'downloaded'; version: string }
  | { type: 'error'; error: unknown };

export interface UpdateDriver {
  /** Ask the release feed without downloading or installing anything. */
  check(): Promise<void>;
  /** Download only the exact candidate approved by the user. */
  download(version: string): Promise<void>;
  /** Quit, install the downloaded update and start the new version. */
  quitAndInstall(): void;
}

/** Agent activity: an update never restarts the app while an agent is working. */
export interface WorkState {
  isBusy(): boolean;
  onIdle(listener: () => void): () => void;
}

export interface UpdatePolicyOptions {
  current: string;
  channel: UpdateChannel;
  /** Missing when this build cannot update itself. */
  driver?: UpdateDriver;
  unsupportedDetail?: string;
  work: WorkState;
  onStatus(status: UpdateStatus): void;
  restartDelaySeconds?: number;
}

export function updateChannel(value: string | undefined): UpdateChannel {
  return value?.trim().toLowerCase() === 'beta' ? 'beta' : 'stable';
}

/** Ad-hoc macOS previews are installed manually; only notarized builds use Squirrel updates. */
export function supportsPackagedUpdates(packaged: boolean, smokeTest: boolean, platform: string, macReleaseMode: unknown): boolean {
  return packaged && !smokeTest && (platform !== 'darwin' || macReleaseMode === 'notarized');
}

const MISSING_RELEASE = ['ERR_UPDATER_NO_PUBLISHED_VERSIONS', 'ERR_UPDATER_LATEST_VERSION_NOT_FOUND', 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND'];

/** electron-updater errors can carry stacks or whole release feeds; keep a short, readable reason. */
export function updateErrorDetail(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (MISSING_RELEASE.includes(code)) return 'No release is published for this platform yet.';
  if (/net::ERR_|ENOTFOUND|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EAI_AGAIN/.test(message)) return 'The update server could not be reached.';
  if (/code ?signature/i.test(message)) return 'This build is not code-signed, so it cannot install updates.';
  return safeMessage(error, 'The update failed.').slice(0, 160);
}

const BUSY_STATES: readonly UpdateStatus['state'][] = ['checking', 'available', 'downloading', 'ready', 'installing'];

export class UpdatePolicy {
  private current: UpdateStatus;
  private countdown: ReturnType<typeof setInterval> | undefined;
  private stopWaiting: (() => void) | undefined;
  private postponed = false;
  private approvedVersion: string | undefined;
  private disposed = false;

  constructor(private readonly options: UpdatePolicyOptions) {
    const base = { current: options.current, channel: options.channel };
    this.current = options.driver ? { ...base, state: 'idle' } : { ...base, state: 'unsupported', detail: options.unsupportedDetail ?? 'Updates are not supported here.' };
  }

  status(): UpdateStatus {
    return { ...this.current };
  }

  handle(event: UpdaterEvent): void {
    if (this.disposed || !this.options.driver) return;
    const latest = this.current.latest;
    switch (event.type) {
      case 'checking':
        if (this.approvedVersion || this.current.state === 'available') return;
        return this.set({ state: 'checking', latest });
      case 'available':
        if (this.approvedVersion) return;
        return this.set({ state: 'available', latest: event.version });
      case 'not-available':
        if (this.approvedVersion || this.current.state === 'available') return;
        return this.set({ state: 'up-to-date', latest: event.version ?? latest });
      case 'progress':
        if (!this.approvedVersion || this.current.state !== 'downloading') return;
        return this.set({ state: 'downloading', latest, progress: Math.min(1, Math.max(0, event.percent / 100)) || 0 });
      case 'downloaded':
        if (event.version !== this.approvedVersion || this.current.state !== 'downloading') return;
        this.set({ state: 'ready', latest: event.version });
        return this.scheduleRestart();
      case 'error':
        this.stopTimers();
        this.approvedVersion = undefined;
        return this.set({ state: 'error', latest, detail: updateErrorDetail(event.error) });
    }
  }

  async check(): Promise<UpdateStatus> {
    const { driver } = this.options;
    if (this.disposed || !driver || BUSY_STATES.includes(this.current.state)) return this.status();
    this.set({ state: 'checking', latest: this.current.latest });
    try {
      await driver.check();
    } catch (error) {
      // electron-updater normally reports failures as events too; keep the first reason.
      if (this.current.state !== 'error') this.handle({ type: 'error', error });
    }
    return this.status();
  }

  /** Approve and download the available version, or restart into an approved download. */
  async install(expectedVersion?: string): Promise<void> {
    if (this.disposed) return;
    if (!this.options.driver) throw new Error(this.current.detail ?? 'Updates are not supported here.');
    if (expectedVersion !== undefined && expectedVersion !== this.current.latest) throw new Error('The available update changed. Review the latest version before updating.');
    const { state } = this.current;
    if (state === 'installing' || state === 'downloading') return;
    if (state === 'available' && this.current.latest) {
      const version = this.current.latest;
      this.approvedVersion = version;
      this.postponed = false;
      this.set({ state: 'downloading', latest: version, progress: 0 });
      try {
        await this.options.driver.download(version);
      } catch (error) {
        if (!this.disposed && this.approvedVersion === version && this.current.state === 'downloading') this.handle({ type: 'error', error });
      }
      return;
    }
    if (state !== 'ready') throw new Error('No update is ready to install.');
    if (!this.approvedVersion || this.approvedVersion !== this.current.latest) throw new Error('This update has not been approved.');
    this.postponed = false;
    if (this.options.work.isBusy()) return this.scheduleRestart();
    this.restartNow();
  }

  /** Keep the approved download, but require another explicit restart action. */
  postpone(): void {
    if (this.current.state !== 'ready') return;
    this.postponed = true;
    this.stopTimers();
    this.set({ state: 'ready', latest: this.current.latest });
  }

  dispose(): void {
    this.disposed = true;
    this.stopTimers();
  }

  private scheduleRestart(): void {
    this.stopTimers();
    if (this.disposed || this.postponed || !this.approvedVersion || this.current.state !== 'ready') return;
    const latest = this.current.latest;
    const { work } = this.options;
    if (work.isBusy()) {
      this.set({ state: 'ready', latest, detail: WAITING_FOR_AGENTS });
      this.stopWaiting = work.onIdle(() => this.scheduleRestart());
      return;
    }
    let remaining = this.options.restartDelaySeconds ?? RESTART_DELAY_SECONDS;
    this.set({ state: 'ready', latest, restartInSeconds: remaining });
    this.countdown = setInterval(() => {
      remaining -= 1;
      if (remaining > 0) return this.set({ state: 'ready', latest, restartInSeconds: remaining });
      // An agent may have started during the countdown: wait for it, then count down again.
      if (work.isBusy()) return this.scheduleRestart();
      this.restartNow();
    }, 1000);
  }

  private restartNow(): void {
    this.stopTimers();
    this.set({ state: 'installing', latest: this.current.latest });
    try {
      this.options.driver?.quitAndInstall();
    } catch (error) {
      this.handle({ type: 'error', error });
    }
  }

  private stopTimers(): void {
    if (this.countdown) clearInterval(this.countdown);
    this.countdown = undefined;
    this.stopWaiting?.();
    this.stopWaiting = undefined;
  }

  private set(next: Omit<UpdateStatus, 'current' | 'channel'>): void {
    const status: UpdateStatus = { current: this.options.current, channel: this.options.channel, ...next };
    // Drop undefined fields so the renderer receives the same shape over IPC and in tests.
    for (const key of Object.keys(status) as (keyof UpdateStatus)[]) if (status[key] === undefined) delete status[key];
    this.current = status;
    this.options.onStatus(this.status());
  }
}
