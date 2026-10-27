/**
 * The knowledge vault folder setting (W5, ADR 0024 decision 5).
 *
 * - Default: `<data>/vaults/<profile>` (no `--vault-root`). A user may choose another existing
 *   folder, for example an Obsidian vault; the host validates it with the daemon's rules and passes
 *   its canonical path as `--vault-root`.
 * - Accepted only if absolute, an existing readable directory, not a symbolic link, not the disk
 *   root, not the home folder itself, and neither inside the Extalia data folder nor containing it.
 *   A folder with `.obsidian` is an Obsidian vault: expected and fine (`.obsidian` is never indexed
 *   or touched).
 * - The folder is re-checked at every daemon start. A chosen folder that is missing or no longer
 *   valid makes the vault unavailable (knowledge calls refuse with `vault_unavailable`); the host never
 *   falls back to the default vault for it. Choosing it again (or the default) in Settings recovers.
 * - Changing the setting restarts the daemon (stop, then start with the new argument) inside the
 *   knowledge sync queue, then rebuilds the index. It is refused while agent work runs, because
 *   missions are bound to the running daemon process. If the daemon refuses the folder, the
 *   previous setting is restored.
 * - Extalia never deletes or rewrites a user's notes; a user-chosen folder is never deleted.
 */
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { normalizeKnowledgeVaultRoot, type KnowledgeVaultSettings, type KnowledgeVaultWatch } from '@extalia/platform';
import { DaemonUnavailableError, type DaemonSidecar } from './daemon/index.js';
import { KnowledgeError, VaultUnavailableError, type KnowledgeService } from './knowledge.js';

/** A folder that passed the checks. */
export interface VaultRootCheck {
  /** Canonical (`realpath`) absolute path, or `null` when the folder is the default vault. */
  path: string | null;
  /** The folder contains `.obsidian`. */
  obsidian: boolean;
}

export interface VaultRootContext {
  dataDirectory: string;
  homeDirectory: string;
  profile: string;
  platform?: NodeJS.Platform;
}

const sameCase = (platform: NodeJS.Platform) => platform === 'darwin' || platform === 'win32';

/** `child` is `parent` or below it. Case-insensitive on macOS and Windows. */
function within(child: string, parent: string, platform: NodeJS.Platform): boolean {
  const fold = (value: string) => (sameCase(platform) ? value.toLowerCase() : value);
  const relative = path.relative(fold(parent), fold(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

async function canonical(folder: string): Promise<string> {
  try { return await realpath(folder); } catch { return path.resolve(folder); }
}

async function isDirectory(folder: string): Promise<boolean> {
  try { return (await lstat(folder)).isDirectory(); } catch { return false; }
}

/** Validate a user-chosen vault folder; throws `KnowledgeError` with a message safe to show (never another path). */
export async function validateVaultRoot(input: string, context: VaultRootContext): Promise<VaultRootCheck> {
  const platform = context.platform ?? process.platform;
  if (!path.isAbsolute(input)) throw new KnowledgeError('Enter the full path of the vault folder.');
  let info;
  try { info = await lstat(input); } catch { throw new KnowledgeError('That folder does not exist.'); }
  if (info.isSymbolicLink()) throw new KnowledgeError('Choose the folder itself, not a symbolic link to it.');
  if (!info.isDirectory()) throw new KnowledgeError('That is a file, not a folder.');
  const real = await canonical(input);
  if (path.parse(real).root === real) throw new KnowledgeError('Choose a folder, not the whole disk.');
  const home = await canonical(context.homeDirectory);
  if (within(real, home, platform) && within(home, real, platform)) throw new KnowledgeError('Choose a folder inside your home folder, not the home folder itself.');
  const data = await canonical(context.dataDirectory);
  const defaultVault = path.join(data, 'vaults', context.profile);
  if (within(real, defaultVault, platform) && within(defaultVault, real, platform)) return { path: null, obsidian: await isDirectory(path.join(real, '.obsidian')) };
  if (within(real, data, platform)) throw new KnowledgeError('Choose a folder outside the Extalia data folder.');
  if (within(data, real, platform)) throw new KnowledgeError('That folder contains the Extalia data folder. Choose a folder that does not.');
  try { await access(real, constants.R_OK | constants.X_OK); } catch { throw new KnowledgeError('Extalia cannot read that folder.'); }
  return { path: real, obsidian: await isDirectory(path.join(real, '.obsidian')) };
}

export interface KnowledgeVaultOptions extends VaultRootContext {
  /** The saved folder (`config/extalia.json` `knowledge.vaultRoot`), or `undefined` for the default vault. */
  configured(): string | undefined;
  log?(line: string): void;
}

/** What switching the folder needs; attached once the host has built them. */
export interface KnowledgeVaultParts {
  daemon: DaemonSidecar;
  knowledge: KnowledgeService;
  /** Save the folder (`undefined`: the default vault). */
  persist(root: string | undefined): Promise<void>;
  /** True while agent work runs (missions are bound to the running daemon). */
  busy(): boolean;
  /** How outside edits reach the index now (the vault watcher). */
  watch?(): KnowledgeVaultWatch;
  /** The vault folder changed (the watcher follows it; the page refreshes). */
  changed?(): void;
}

/** The vault folder setting of one host: what the daemon is started with, and switching it. */
export class KnowledgeVault {
  /** The folder the daemon was last started with (`undefined`: the default vault). */
  private applied: string | undefined;
  /** Why the chosen folder could not be used at the last daemon start. */
  private blocked: string | undefined;
  private switching = false;
  private parts: KnowledgeVaultParts | undefined;

  /** Built with the daemon sidecar (its `vaultRoot` asks `startArgument()`), before the rest of the host. */
  constructor(private readonly options: KnowledgeVaultOptions) {}

  attach(parts: KnowledgeVaultParts): void { this.parts = parts; }

  /** The default vault folder of this profile. */
  defaultRoot(): string { return path.join(this.options.dataDirectory, 'vaults', this.options.profile); }

  /** `--vault-root` for a daemon start: the chosen folder when it still passes the checks. */
  async startArgument(): Promise<string | undefined> {
    const configured = this.options.configured();
    this.applied = undefined; this.blocked = undefined;
    if (!configured) return undefined;
    try {
      const checked = await validateVaultRoot(configured, this.options);
      this.applied = checked.path ?? undefined;
      return this.applied;
    } catch (error) {
      this.blocked = error instanceof Error ? error.message : 'The vault folder cannot be used.';
      this.options.log?.('Knowledge: the chosen vault folder cannot be used; the vault is unavailable until it is chosen again.');
      return undefined;
    }
  }

  /** For `KnowledgeService`: refuse while the chosen folder is unusable (never the default vault instead). */
  check(): void {
    if (this.blocked) throw new VaultUnavailableError(`The vault folder is missing or cannot be used: ${this.blocked} Choose it again, or use the default vault, in Settings. (vault_unavailable)`);
  }

  /** The root label as the daemon reports it. */
  label(): string {
    const configured = this.options.configured();
    return configured ? `custom:${path.basename(configured)}` : `vaults/${this.options.profile}`;
  }

  /** The folder the watcher follows: the running daemon's vault, or none while the chosen one is unusable. */
  watchRoot(): string | undefined {
    if (this.blocked || this.switching) return undefined;
    return this.applied ?? (this.options.configured() ? undefined : this.defaultRoot());
  }

  async settings(): Promise<KnowledgeVaultSettings> {
    const configured = this.options.configured();
    const watch = this.parts?.watch?.() ?? 'off';
    if (!configured) return { kind: 'default', label: this.label(), available: true, obsidian: await isDirectory(path.join(this.defaultRoot(), '.obsidian')), watch };
    let problem = this.blocked;
    let obsidian = false;
    try { obsidian = (await validateVaultRoot(configured, this.options)).obsidian; } catch (error) { problem ??= error instanceof Error ? error.message : 'The vault folder cannot be used.'; }
    return { kind: 'custom', label: this.label(), path: configured, available: !problem, ...(problem ? { problem } : {}), obsidian, watch };
  }

  /** Use `raw` (validated by the platform rules, then here) or the default vault; restarts the daemon and rebuilds the index. */
  async set(raw: unknown): Promise<KnowledgeVaultSettings> {
    let requested: string | null;
    try { requested = normalizeKnowledgeVaultRoot(raw); } catch (error) { throw new KnowledgeError(error instanceof Error ? error.message : 'Invalid folder.'); }
    const next = requested === null ? undefined : (await validateVaultRoot(requested, this.options)).path ?? undefined;
    const parts = this.parts;
    if (!parts) throw new KnowledgeError('The knowledge index is not ready yet. Try again in a moment.');
    if (this.switching) throw new KnowledgeError('The vault folder is already being changed. Try again in a moment.');
    if (parts.busy()) throw new KnowledgeError('Agent work is running. Change the vault folder when it has finished, or stop it first.');
    const previous = this.options.configured();
    this.switching = true;
    parts.changed?.();
    try {
      await parts.persist(next);
      try {
        await parts.knowledge.switchVault(async () => {
          await parts.daemon.restart();
          try {
            await parts.daemon.connect();
          } catch (error) {
            if (!(error instanceof DaemonUnavailableError) || error.code !== 'invalid_arguments' || next === undefined) throw error;
            // The daemon refused the folder (or does not know `--vault-root`): restore the previous setting.
            await parts.persist(previous);
            await parts.daemon.restart();
            throw new KnowledgeError('The native core did not accept this folder, so the vault folder was not changed. Update Extalia, or choose another folder.');
          }
        });
      } catch (error) {
        if (error instanceof KnowledgeError) throw error;
        // The setting is saved; the index is rebuilt by the next sync.
        this.options.log?.('Knowledge: the vault folder changed, but the index could not be rebuilt yet.');
      }
    } finally {
      this.switching = false;
      parts.changed?.();
    }
    return this.settings();
  }
}
