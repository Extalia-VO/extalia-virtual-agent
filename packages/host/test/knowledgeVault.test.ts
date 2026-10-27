import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it } from 'vitest';
import { DAEMON_OPS, createDaemonFrameReader, encodeDaemonFrame, type DaemonFrame, type DaemonRequest } from '@extalia/protocol';
import { KNOWLEDGE_EVENT_SESSION_ID, type AgentHostApi, type KnowledgeVaultSettings } from '@extalia/platform';
import type { ExtaliaEvent } from '@extalia/protocol';
import type { DaemonProcess } from '../src/daemon/index.js';
import { validateVaultRoot } from '../src/knowledgeVault.js';
import { createAgentHost, type AgentHostOptions } from '../src/service.js';
import { DAEMON_BINARY, HAS_DAEMON } from './daemonBackend.js';

const roots: string[] = [];
const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closes.length) await closes.pop()!();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'extalia-vault-'))); roots.push(root);
  return root;
}

describe('vault folder validation', () => {
  it('accepts an existing folder outside the data folder and reports an Obsidian vault', async () => {
    const root = await tempRoot();
    const context = { dataDirectory: path.join(root, 'data'), homeDirectory: path.join(root, 'home'), profile: 'default' };
    await mkdir(path.join(root, 'home'), { recursive: true });
    await mkdir(path.join(root, 'data', 'state'), { recursive: true });
    await mkdir(path.join(root, 'notes', '.obsidian'), { recursive: true });
    await mkdir(path.join(root, 'plain'), { recursive: true });
    expect(await validateVaultRoot(path.join(root, 'notes'), context)).toEqual({ path: path.join(root, 'notes'), obsidian: true });
    expect(await validateVaultRoot(path.join(root, 'plain'), context)).toEqual({ path: path.join(root, 'plain'), obsidian: false });
    // The default vault itself means "use the default".
    await mkdir(path.join(root, 'data', 'vaults', 'default'), { recursive: true });
    expect(await validateVaultRoot(path.join(root, 'data', 'vaults', 'default'), context)).toEqual({ path: null, obsidian: false });
  });

  it('refuses relative, missing, file, symbolic link, disk root, home, data-folder and enclosing folders', async () => {
    const root = await tempRoot();
    const home = path.join(root, 'home'), data = path.join(home, 'extalia-data');
    const context = { dataDirectory: data, homeDirectory: home, profile: 'default' };
    await mkdir(path.join(data, 'state'), { recursive: true });
    await mkdir(path.join(root, 'notes'), { recursive: true });
    await writeFile(path.join(root, 'file.md'), '# not a folder\n');
    await symlink(path.join(root, 'notes'), path.join(root, 'link'));
    const refused = (folder: string) => validateVaultRoot(folder, context).then(() => '', (error: Error) => `${error.name}: ${error.message}`);
    expect(await refused('notes')).toMatch(/UserError: Enter the full path/);
    expect(await refused(path.join(root, 'missing'))).toMatch(/does not exist/);
    expect(await refused(path.join(root, 'file.md'))).toMatch(/not a folder/);
    expect(await refused(path.join(root, 'link'))).toMatch(/symbolic link/);
    expect(await refused(path.parse(root).root)).toMatch(/whole disk/);
    expect(await refused(home)).toMatch(/not the home folder itself/);
    expect(await refused(path.join(data, 'state'))).toMatch(/outside the Extalia data folder/);
    expect(await refused(data)).toMatch(/outside the Extalia data folder/);
    expect(await refused(root)).toMatch(/contains the Extalia data folder/);
  });
});

/** A scripted knowledge daemon on in-memory pipes: answers hello, status and sync; records its arguments. */
class FakeDaemon extends EventEmitter implements DaemonProcess {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly requests: DaemonRequest[] = [];
  private exited = false;
  private generation = 0;
  private readonly reader = createDaemonFrameReader();
  constructor(readonly args: string[], refuse: boolean) {
    super();
    if (refuse) { setImmediate(() => this.exit(2)); return; }
    const vaultRoot = args.includes('--vault-root') ? `custom:${path.basename(args[args.indexOf('--vault-root') + 1]!)}` : 'vaults/default';
    this.stdin.on('data', (chunk: Buffer) => {
      for (const read of this.reader.push(chunk)) {
        if (!read.ok || read.frame.kind !== 'request') continue;
        const request = read.frame;
        this.requests.push(request);
        const respond = (result: unknown) => this.stdout.write(encodeDaemonFrame({ schemaVersion: 1, kind: 'response', requestId: request.requestId, op: request.op, result } as DaemonFrame));
        if (request.op === 'hello') respond({ daemonVersion: '0.0.0', capabilities: [...DAEMON_OPS], maxFrameBytes: 1024 * 1024 });
        else if (request.op === 'knowledge.status') respond({ state: 'ready', vaultRoot, vaultPresent: true, generation: this.generation });
        else if (request.op === 'knowledge.sync') {
          this.generation++;
          const mode = (request.params as { mode: 'incremental' | 'rebuild' }).mode;
          respond({ mode, at: new Date().toISOString(), generation: this.generation, notes: 1, added: 1, updated: 0, removed: 0, unchanged: 0, unresolvedLinks: 0, renamed: [], renamedTotal: 0, skipped: [], skippedTotal: 0, vaultCreated: false });
        }
      }
    });
    this.stdin.on('finish', () => this.exit(0));
  }
  kill(): boolean { this.exit(null); return true; }
  exit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    setImmediate(() => this.emit('close', code, null));
  }
}

type VaultHost = AgentHostApi & Required<Pick<AgentHostApi, 'knowledgeSettings' | 'setKnowledgeVaultRoot' | 'knowledgeStatus' | 'syncKnowledge'>>;

async function fakeHost(options: { refuseVaultRoot?: boolean; config?: Record<string, unknown> } = {}) {
  const root = await tempRoot();
  const home = path.join(root, 'home'), data = path.join(root, 'data');
  await mkdir(home, { recursive: true });
  if (options.config) {
    await mkdir(path.join(data, 'config'), { recursive: true });
    await writeFile(path.join(data, 'config', 'extalia.json'), JSON.stringify({ schema: 'extalia.host-config.v1', setupComplete: false, profile: { id: 'default', name: 'Personal' }, connections: [], workspaces: [], ...options.config }));
  }
  const spawned: FakeDaemon[] = [];
  const runtime = await createAgentHost({
    kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
    env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: process.execPath },
    daemon: {
      log: () => undefined,
      spawn: (_binary, args) => { const daemon = new FakeDaemon(args, Boolean(options.refuseVaultRoot && args.includes('--vault-root'))); spawned.push(daemon); return daemon; },
    },
    knowledge: { autoSyncAfterMs: Number.POSITIVE_INFINITY, watcher: false },
  });
  closes.push(() => runtime.close());
  const events: ExtaliaEvent[] = [];
  runtime.host.subscribe(event => { events.push(event); });
  const config = async () => JSON.parse(await readFile(path.join(data, 'config', 'extalia.json'), 'utf8')) as { knowledge?: { vaultRoot?: string } };
  return { root, home, data, host: runtime.host as VaultHost, spawned, events, config };
}

describe('knowledge vault setting on the host', () => {
  it('is absent with the TypeScript core', async () => {
    const root = await tempRoot();
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: path.join(root, 'data'), homeDirectory: root, importHome: root, observationIntervalMs: 60_000,
      env: { EXTALIA_SECRET_STORE: 'memory', HOME: root, PATH: '', EXTALIA_NATIVE_CORE: 'typescript' },
    });
    closes.push(() => runtime.close());
    expect(runtime.host.knowledgeSettings).toBeUndefined();
    expect(runtime.host.setKnowledgeVaultRoot).toBeUndefined();
  });

  it('persists a chosen folder, restarts the daemon with --vault-root, rebuilds, and goes back to the default', async () => {
    const { root, data, host, spawned, events, config } = await fakeHost();
    const notes = path.join(root, 'Obsidian Vault');
    await mkdir(path.join(notes, '.obsidian'), { recursive: true });
    expect(await host.knowledgeSettings()).toEqual<KnowledgeVaultSettings>({ kind: 'default', label: 'vaults/default', available: true, obsidian: false, watch: 'off' });
    await host.knowledgeStatus();
    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.args).toEqual(['--data-dir', data, '--profile', 'default']);

    const chosen = await host.setKnowledgeVaultRoot(notes);
    expect(chosen).toMatchObject({ kind: 'custom', label: 'custom:Obsidian Vault', path: notes, available: true, obsidian: true });
    expect((await config()).knowledge).toEqual({ vaultRoot: notes });
    // Stop, then start with the new root; the index is rebuilt from that vault.
    expect(spawned).toHaveLength(2);
    expect(spawned[1]!.args).toEqual(['--data-dir', data, '--profile', 'default', '--vault-root', notes]);
    expect(spawned[1]!.requests.filter(request => request.op === 'knowledge.sync').map(request => request.params)).toEqual([{ mode: 'rebuild' }]);
    expect((await host.knowledgeStatus()).vaultRoot).toBe('custom:Obsidian Vault');
    expect(events.some(event => event.sessionId === KNOWLEDGE_EVENT_SESSION_ID && event.body.type === 'session.updated')).toBe(true);

    expect(await host.setKnowledgeVaultRoot(null)).toMatchObject({ kind: 'default', label: 'vaults/default' });
    expect((await config()).knowledge).toBeUndefined();
    expect(spawned).toHaveLength(3);
    expect(spawned[2]!.args).toEqual(['--data-dir', data, '--profile', 'default']);
  });

  it('refuses an invalid folder before anything changes', async () => {
    const { root, host, spawned } = await fakeHost();
    await expect(host.setKnowledgeVaultRoot('relative/notes')).rejects.toThrow(/full path/);
    await expect(host.setKnowledgeVaultRoot(path.join(root, 'missing'))).rejects.toMatchObject({ name: 'UserError', message: expect.stringMatching(/does not exist/) });
    await expect(host.setKnowledgeVaultRoot(path.join(root, 'data', 'state'))).rejects.toThrow(/outside the Extalia data folder/);
    expect(spawned).toHaveLength(0);
  });

  it('restores the previous setting when the daemon refuses the folder', async () => {
    const { root, data, host, spawned, config } = await fakeHost({ refuseVaultRoot: true });
    await mkdir(path.join(root, 'notes'), { recursive: true });
    await expect(host.setKnowledgeVaultRoot(path.join(root, 'notes'))).rejects.toThrow(/did not accept this folder/);
    expect((await config()).knowledge).toBeUndefined();
    expect(await host.knowledgeSettings()).toMatchObject({ kind: 'default' });
    // The native core is usable again, on the default vault.
    expect((await host.knowledgeStatus()).state).toBe('ready');
    expect(spawned.at(-1)!.args).toEqual(['--data-dir', data, '--profile', 'default']);
  });

  it('keeps a saved folder that went missing unavailable, never the default vault', async () => {
    const root = await tempRoot();
    const gone = path.join(root, 'gone-vault');
    const { host, spawned } = await fakeHost({ config: { nativeCore: 'rust', knowledge: { vaultRoot: gone } } });
    const status = await host.knowledgeStatus();
    expect(status).toMatchObject({ state: 'unavailable', reason: 'vault_unavailable', vaultRoot: 'custom:gone-vault', vaultPresent: false });
    expect(spawned[0]!.args).not.toContain('--vault-root');
    await expect(host.syncKnowledge()).rejects.toThrow(/vault folder is missing or cannot be used/);
    expect(spawned[0]!.requests.some(request => request.op === 'knowledge.sync')).toBe(false);
    expect(await host.knowledgeSettings()).toMatchObject({ kind: 'custom', path: gone, available: false, problem: expect.stringMatching(/does not exist/) });
    // Choosing it again once it is back recovers.
    await mkdir(gone);
    expect(await host.setKnowledgeVaultRoot(gone)).toMatchObject({ available: true });
    expect((await host.knowledgeStatus()).state).toBe('ready');
  });
});

// The real daemon learns `--vault-root` in a parallel change; until its binary knows the flag this stays skipped.
const SUPPORTS_VAULT_ROOT = HAS_DAEMON && readFileSync(DAEMON_BINARY).includes('--vault-root');
if (!SUPPORTS_VAULT_ROOT) console.warn('knowledgeVault.test.ts: real-daemon vault folder case skipped: the built extalia-daemon does not support --vault-root yet (rebuild it with `cargo build -p extalia-daemon` once it does).');

describe.skipIf(!SUPPORTS_VAULT_ROOT)('knowledge vault folder over the Rust core daemon', () => {
  it('indexes a user-chosen Obsidian vault and leaves .obsidian alone', async () => {
    const root = await tempRoot();
    const home = path.join(root, 'home'), data = path.join(root, 'data'), vault = path.join(root, 'Vault');
    await mkdir(home, { recursive: true });
    await mkdir(path.join(vault, '.obsidian'), { recursive: true });
    await writeFile(path.join(vault, '.obsidian', 'app.json'), '{}');
    await writeFile(path.join(vault, 'Idea.md'), '# Idea\nSee [[Other]].\n');
    await writeFile(path.join(vault, 'Other.md'), '# Other\n');
    const runtime = await createAgentHost({
      kind: 'bridge', version: 'test', dataDirectory: data, homeDirectory: home, importHome: home, observationIntervalMs: 60_000,
      env: { EXTALIA_SECRET_STORE: 'memory', HOME: home, PATH: '', EXTALIA_NATIVE_CORE: 'rust', EXTALIA_DAEMON_PATH: DAEMON_BINARY },
      daemon: { log: () => undefined }, knowledge: { autoSyncAfterMs: Number.POSITIVE_INFINITY, watcher: false } satisfies AgentHostOptions['knowledge'],
    });
    closes.push(() => runtime.close());
    const host = runtime.host as VaultHost;
    expect(await host.setKnowledgeVaultRoot(vault)).toMatchObject({ kind: 'custom', label: 'custom:Vault', obsidian: true, available: true });
    const status = await host.knowledgeStatus();
    expect(status).toMatchObject({ state: 'ready', vaultRoot: 'custom:Vault', vaultPresent: true, counts: { notes: 2 } });
    expect(await readFile(path.join(vault, '.obsidian', 'app.json'), 'utf8')).toBe('{}');
  });
});
