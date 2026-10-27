import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { KnowledgeSyncReport } from '@extalia/platform';
import { VaultWatcher, isVaultChange, scanVault, type VaultWatcherOptions } from '../src/vaultWatcher.js';

const roots: string[] = [];
const watchers: VaultWatcher[] = [];
afterEach(async () => {
  vi.useRealTimers();
  while (watchers.length) watchers.pop()!.stop();
  while (roots.length) await rm(roots.pop()!, { recursive: true, force: true });
});

async function vault(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), 'extalia-watch-'))); roots.push(root);
  return root;
}

function report(patch: Partial<KnowledgeSyncReport> = {}): KnowledgeSyncReport {
  return { mode: 'incremental', at: new Date().toISOString(), generation: 1, notes: 1, added: 0, updated: 1, removed: 0, unchanged: 0, unresolvedLinks: 0, renamed: [], renamedTotal: 0, skipped: [], skippedTotal: 0, vaultCreated: false, ...patch };
}

function harness(root: string | undefined, patch: Partial<VaultWatcherOptions> = {}) {
  const calls: number[] = [];
  const indexed: KnowledgeSyncReport[] = [];
  let active = true;
  let result: () => Promise<KnowledgeSyncReport> = async () => report();
  const watcher = new VaultWatcher({
    root: () => root, active: () => active, mode: 'poll', pollMs: 60_000, tickMs: 60_000, quietMs: 1_500, maxWaitMs: 10_000, retryBaseMs: 5_000, retryMaxMs: 40_000,
    sync: () => { calls.push(Date.now()); return result(); }, onIndexed: value => { indexed.push(value); }, ...patch,
  });
  watchers.push(watcher);
  return { watcher, calls, indexed, setActive: (value: boolean) => { active = value; }, setResult: (next: () => Promise<KnowledgeSyncReport>) => { result = next; } };
}

describe('vault change filter', () => {
  it('counts Markdown notes and possible folders, never hidden paths or other files', () => {
    expect(isVaultChange('change', 'Notes/Idea.md')).toBe(true);
    expect(isVaultChange('rename', 'Idea.MD')).toBe(true);
    expect(isVaultChange('rename', 'Projects')).toBe(true);
    expect(isVaultChange('change', null)).toBe(true);
    expect(isVaultChange('change', '.obsidian/workspace.json')).toBe(false);
    expect(isVaultChange('rename', '.trash/Old.md')).toBe(false);
    expect(isVaultChange('change', 'Notes/.draft.md')).toBe(false);
    expect(isVaultChange('change', '.git\\index')).toBe(false);
    expect(isVaultChange('change', 'Images/photo.png')).toBe(false);
    expect(isVaultChange('change', 'Projects')).toBe(false);
  });

  it('scans names, sizes and mtimes of visible Markdown notes only, bounded', async () => {
    const root = await vault();
    await mkdir(path.join(root, 'A', '.hidden'), { recursive: true });
    await mkdir(path.join(root, '.obsidian'), { recursive: true });
    await writeFile(path.join(root, 'A', 'One.md'), '# One');
    await writeFile(path.join(root, 'A', '.hidden', 'Two.md'), '# Two');
    await writeFile(path.join(root, '.obsidian', 'app.json'), '{}');
    await writeFile(path.join(root, 'picture.png'), 'x');
    expect([...(await scanVault(root, 100))!.keys()]).toEqual([path.join('A', 'One.md')]);
    expect(await scanVault(root, 2)).toBeUndefined();
  });
});

describe('vault watcher debounce', () => {
  it('syncs once after a quiet period, and at most maxWait after the first change of a burst', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { watcher, calls, indexed } = harness(undefined);
    watcher.start();
    const start = Date.now();
    watcher.notify('change', 'A.md');
    await vi.advanceTimersByTimeAsync(1_000);
    watcher.notify('change', 'B.md');
    await vi.advanceTimersByTimeAsync(1_000);
    expect(calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(600);
    expect(calls).toEqual([start + 2_500]);
    expect(indexed).toHaveLength(1);
    // A steady stream of edits: synced 10 s after its first change, not never.
    const burst = Date.now();
    for (let index = 0; index < 14; index++) { watcher.notify('change', `N${index}.md`); await vi.advanceTimersByTimeAsync(1_000); }
    expect(calls[1]).toBe(burst + 10_000);
    // Ignored paths never schedule anything.
    await vi.advanceTimersByTimeAsync(20_000);
    const count = calls.length;
    watcher.notify('change', '.obsidian/workspace.json');
    watcher.notify('change', 'img.png');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(calls).toHaveLength(count);
  });

  it('coalesces changes during a running sync into exactly one more', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { watcher, calls, setResult } = harness(undefined);
    let finish!: () => void;
    setResult(() => new Promise(resolve => { finish = () => resolve(report()); }));
    watcher.start();
    watcher.notify('change', 'A.md');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(1);
    for (const name of ['B.md', 'C.md', 'D.md']) watcher.notify('change', name);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(calls).toHaveLength(1);
    setResult(async () => report({ updated: 0 }));
    finish();
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(calls).toHaveLength(2);
  });

  it('backs off after failures and keeps the change pending; never syncs while the daemon is down', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const { watcher, calls, setResult, setActive, indexed } = harness(undefined, { tickMs: 15_000 });
    setResult(async () => { throw new Error('vault_unavailable'); });
    watcher.start();
    watcher.notify('change', 'A.md');
    await vi.advanceTimersByTimeAsync(1_500);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(4_900);
    expect(calls).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(calls).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(calls).toHaveLength(3);
    // Daemon down: the pending change waits; the watcher never starts it.
    setActive(false);
    setResult(async () => report());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(calls).toHaveLength(3);
    setActive(true);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(calls).toHaveLength(4);
    expect(indexed).toHaveLength(1);
  });
});

describe('vault watcher on a real folder', () => {
  it('polls when recursive watching is not used, ignoring hidden and non-Markdown files', async () => {
    const root = await vault();
    await writeFile(path.join(root, 'A.md'), '# A');
    const { watcher, calls } = harness(root, { mode: 'poll', pollMs: 1_000, quietMs: 50, maxWaitMs: 100 });
    watcher.start();
    await vi.waitFor(() => expect(watcher.state()).toBe('polling'));
    await new Promise(resolve => setTimeout(resolve, 1_200));
    await mkdir(path.join(root, '.obsidian'));
    await writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}');
    await writeFile(path.join(root, 'image.png'), 'x');
    await new Promise(resolve => setTimeout(resolve, 1_300));
    expect(calls).toHaveLength(0);
    await writeFile(path.join(root, 'B.md'), '# B');
    await vi.waitFor(() => expect(calls).toHaveLength(1), { timeout: 3_000, interval: 50 });
  }, 10_000);

  it.runIf(process.platform === 'darwin' || process.platform === 'win32')('watches recursively on macOS and Windows', async () => {
    const root = await vault();
    await mkdir(path.join(root, 'Notes'));
    const { watcher, calls } = harness(root, { mode: 'auto', quietMs: 50, maxWaitMs: 200 });
    watcher.start();
    await vi.waitFor(() => expect(watcher.state()).toBe('watching'));
    // FSEvents may replay the folder's creation just after the watch starts: let that settle first.
    await new Promise(resolve => setTimeout(resolve, 600));
    const settled = calls.length;
    await mkdir(path.join(root, '.obsidian'));
    await writeFile(path.join(root, '.obsidian', 'workspace.json'), '{}');
    await new Promise(resolve => setTimeout(resolve, 400));
    expect(calls).toHaveLength(settled);
    await writeFile(path.join(root, 'Notes', 'Deep.md'), '# Deep');
    await vi.waitFor(() => expect(calls.length).toBeGreaterThan(settled), { timeout: 3_000, interval: 50 });
  }, 10_000);

  it('follows nothing while the daemon is down or the folder is missing', async () => {
    const root = await vault();
    const { watcher, setActive } = harness(path.join(root, 'missing'), { mode: 'poll' });
    watcher.start();
    await watcher.refresh();
    expect(watcher.state()).toBe('off');
    const other = harness(root, { mode: 'poll' });
    other.setActive(false);
    other.watcher.start();
    await other.watcher.refresh();
    expect(other.watcher.state()).toBe('off');
    setActive(false);
  });
});
