/**
 * Vault watcher (W5): notices notes edited outside Extalia (for example in Obsidian) and runs an
 * incremental knowledge sync, so the index follows the vault without a manual "Sync now".
 *
 * - Runs only while the Rust core daemon is running and the vault folder exists. It never starts the
 *   daemon: changes seen while it is down wait until it runs again (checked on a slow tick).
 * - `fs.watch` with `recursive` on macOS and Windows; elsewhere, or when recursive watching is not
 *   available, a polling scan (names and mtimes of `*.md` files) at a bounded interval.
 * - Hidden folders and files (`.obsidian/`, `.trash/`, `.git/`) and non-Markdown files are ignored.
 *   A rename without an extension may be a folder (its notes moved), so it counts.
 * - Debounced: a sync starts after `quietMs` without changes, or at most `maxWaitMs` after the first
 *   change of a burst. Syncs go through the knowledge sync queue (`KnowledgeService.syncChanges`), one
 *   watcher sync at a time; changes during a sync schedule exactly one more.
 * - A failed sync backs off exponentially (`retryBaseMs` to `retryMaxMs`) and keeps the change pending.
 * - Cheap when idle: no work without changes besides the slow tick (and the scan when polling); timers
 *   do not keep the process alive. `stop()` with the host.
 */
import { watch as fsWatch, type FSWatcher } from 'node:fs';
import { lstat, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { KnowledgeSyncReport, KnowledgeVaultWatch } from '@extalia/platform';

export type VaultWatchMode = 'auto' | 'watch' | 'poll';

export interface VaultWatcherOptions {
  /** The vault folder to follow now, or `undefined` (none: not configured, unusable, or being switched). */
  root(): string | undefined;
  /** Whether the daemon runs; the watcher never starts it. */
  active(): boolean;
  /** One incremental sync through the knowledge sync queue. */
  sync(): Promise<KnowledgeSyncReport>;
  /** A sync of the watcher changed the index (notes added, updated, removed or renamed). */
  onIndexed?(report: KnowledgeSyncReport): void;
  /** `auto` (default): native recursive watching on macOS and Windows, polling elsewhere. */
  mode?: VaultWatchMode;
  platform?: NodeJS.Platform;
  quietMs?: number;
  maxWaitMs?: number;
  /** Polling interval, clamped to 1–120 s. */
  pollMs?: number;
  /** How often the watcher checks that the daemon runs and the folder exists. */
  tickMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  /** Entries a polling scan reads at most; a larger vault is not polled (the index refuses it too). */
  maxScanEntries?: number;
  log?(line: string): void;
  /** Injected for tests. */
  watch?: typeof fsWatch;
}

export const VAULT_WATCH_DEFAULTS = { quietMs: 1_500, maxWaitMs: 10_000, pollMs: 10_000, tickMs: 15_000, retryBaseMs: 5_000, retryMaxMs: 5 * 60_000, maxScanEntries: 200_000 } as const;
const MAX_DEPTH = 64;

/** Whether one change event may change the index: Markdown notes, possible folders; never hidden paths. */
export function isVaultChange(eventType: string, filename: string | null | undefined): boolean {
  if (!filename) return true;
  const parts = filename.split(/[\\/]+/).filter(Boolean);
  if (!parts.length) return true;
  if (parts.some(part => part.startsWith('.'))) return false;
  const name = parts[parts.length - 1]!;
  if (/\.md$/i.test(name)) return true;
  return eventType === 'rename' && !path.extname(name);
}

/** `*.md` files below `root` (hidden names and symbolic links skipped) with their mtime and size; `undefined` above `maxEntries`. */
export async function scanVault(root: string, maxEntries: number): Promise<Map<string, string> | undefined> {
  const files = new Map<string, string>();
  let entries = 0;
  const walk = async (folder: string, depth: number): Promise<boolean> => {
    if (depth > MAX_DEPTH) return true;
    let items;
    try { items = await readdir(folder, { withFileTypes: true }); } catch { return true; }
    for (const item of items) {
      if (++entries > maxEntries) return false;
      if (item.name.startsWith('.')) continue;
      const full = path.join(folder, item.name);
      if (item.isDirectory()) { if (!(await walk(full, depth + 1))) return false; }
      else if (item.isFile() && /\.md$/i.test(item.name)) {
        try { const info = await stat(full); files.set(path.relative(root, full), `${info.mtimeMs}:${info.size}`); } catch { /* removed meanwhile */ }
      }
    }
    return true;
  };
  return (await walk(root, 0)) ? files : undefined;
}

function sameScan(a: Map<string, string>, b: Map<string, string>): boolean {
  if (a.size !== b.size) return false;
  for (const [file, stamp] of a) if (b.get(file) !== stamp) return false;
  return true;
}

const unref = (timer: ReturnType<typeof setTimeout>) => { (timer as { unref?: () => void }).unref?.(); return timer; };

export class VaultWatcher {
  private readonly quietMs: number;
  private readonly maxWaitMs: number;
  private readonly pollMs: number;
  private readonly tickMs: number;
  private stopped = true;
  private watching: { root: string; kind: 'watching' | 'polling'; close(): void } | undefined;
  private tickTimer: ReturnType<typeof setTimeout> | undefined;
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  /** When the first change of the current burst was seen. */
  private firstChangeAt: number | undefined;
  private pending = false;
  private inFlight: Promise<void> | undefined;
  private failures = 0;
  private retryAt = 0;

  constructor(private readonly options: VaultWatcherOptions) {
    this.quietMs = Math.max(0, options.quietMs ?? VAULT_WATCH_DEFAULTS.quietMs);
    this.maxWaitMs = Math.max(this.quietMs, options.maxWaitMs ?? VAULT_WATCH_DEFAULTS.maxWaitMs);
    this.pollMs = Math.min(120_000, Math.max(1_000, options.pollMs ?? VAULT_WATCH_DEFAULTS.pollMs));
    this.tickMs = Math.max(1_000, options.tickMs ?? VAULT_WATCH_DEFAULTS.tickMs);
  }

  /** How edits reach the index right now. */
  state(): KnowledgeVaultWatch { return this.watching?.kind ?? 'off'; }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    void this.refresh();
  }

  stop(): void {
    this.stopped = true;
    clearTimeout(this.tickTimer); clearTimeout(this.flushTimer);
    this.tickTimer = this.flushTimer = undefined;
    this.close();
    this.pending = false; this.firstChangeAt = undefined;
  }

  /** Follow the current root and daemon state now (also on every tick). Never starts the daemon. */
  async refresh(): Promise<void> {
    if (this.stopped) return;
    clearTimeout(this.tickTimer);
    this.tickTimer = unref(setTimeout(() => { void this.refresh(); }, this.tickMs));
    const root = this.options.root();
    const usable = Boolean(root) && this.options.active() && await isFolder(root!);
    if (this.stopped) return;
    if (!usable || this.watching?.root !== root) this.close();
    if (usable && !this.watching) this.open(root!);
    // Changes seen while the daemon was down are synced once it runs.
    if (this.pending && !this.flushTimer && !this.inFlight && this.options.active()) this.schedule(0);
  }

  /** One change event (exposed for tests). */
  notify(eventType: string, filename: string | null | undefined): void {
    if (this.stopped || !isVaultChange(eventType, filename)) return;
    this.changed();
  }

  private changed(): void {
    this.pending = true;
    const now = Date.now();
    this.firstChangeAt ??= now;
    if (this.inFlight) return;
    this.schedule(Math.max(0, Math.min(this.quietMs, this.firstChangeAt + this.maxWaitMs - now)));
  }

  private schedule(delay: number): void {
    clearTimeout(this.flushTimer);
    this.flushTimer = unref(setTimeout(() => { this.flushTimer = undefined; void this.flush(); }, Math.max(delay, this.retryAt - Date.now(), 0)));
  }

  private async flush(): Promise<void> {
    if (this.stopped || !this.pending || this.inFlight) return;
    // Never start the daemon: keep the change until a tick sees it running.
    if (!this.options.active()) return;
    this.pending = false;
    this.firstChangeAt = undefined;
    const run = (async () => {
      try {
        const report = await this.options.sync();
        this.failures = 0; this.retryAt = 0;
        if (report.added + report.updated + report.removed + report.renamedTotal > 0) this.options.onIndexed?.(report);
      } catch {
        this.failures++;
        const base = this.options.retryBaseMs ?? VAULT_WATCH_DEFAULTS.retryBaseMs, max = this.options.retryMaxMs ?? VAULT_WATCH_DEFAULTS.retryMaxMs;
        this.retryAt = Date.now() + Math.min(max, base * 2 ** (this.failures - 1));
        this.pending = true;
        if (this.failures === 1) this.options.log?.('Knowledge: the vault changed but the index could not be updated; retrying later.');
      }
    })();
    this.inFlight = run;
    await run;
    this.inFlight = undefined;
    if (this.stopped || !this.pending) return;
    // Changes during the sync (or a failed one): exactly one more, after the quiet period or the back-off.
    this.firstChangeAt ??= Date.now();
    this.schedule(this.quietMs);
  }

  private open(root: string): void {
    const platform = this.options.platform ?? process.platform;
    const mode = this.options.mode ?? 'auto';
    const native = mode === 'watch' || (mode === 'auto' && (platform === 'darwin' || platform === 'win32'));
    if (native) {
      try {
        const watcher: FSWatcher = (this.options.watch ?? fsWatch)(root, { recursive: true, persistent: false }, (eventType, filename) => this.notify(eventType, filename === null ? null : String(filename)));
        watcher.on('error', () => {
          // The folder went away or the watch broke: close it; the next tick opens it again if it can.
          if (this.watching?.root === root) this.close();
          this.changed();
        });
        this.watching = { root, kind: 'watching', close: () => watcher.close() };
        return;
      } catch {
        // Recursive watching is not available here: poll instead.
      }
    }
    this.watching = this.poller(root);
  }

  private poller(root: string): { root: string; kind: 'polling'; close(): void } {
    let closed = false, timer: ReturnType<typeof setTimeout> | undefined, previous: Map<string, string> | undefined, warned = false;
    const max = this.options.maxScanEntries ?? VAULT_WATCH_DEFAULTS.maxScanEntries;
    const scan = async () => {
      const current = await scanVault(root, max);
      if (closed) return;
      if (!current) {
        if (!warned) { warned = true; this.options.log?.('Knowledge: the vault is too large to poll for changes; use Sync now.'); }
      } else {
        if (previous && !sameScan(previous, current)) this.changed();
        previous = current;
      }
      timer = unref(setTimeout(() => { void scan(); }, this.pollMs));
    };
    void scan();
    return { root, kind: 'polling', close: () => { closed = true; clearTimeout(timer); } };
  }

  private close(): void {
    const watching = this.watching;
    this.watching = undefined;
    try { watching?.close(); } catch { /* already closed */ }
  }
}

async function isFolder(folder: string): Promise<boolean> {
  try { return (await lstat(folder)).isDirectory(); } catch { return false; }
}
