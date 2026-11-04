import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentAppId } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { commitConfigWrites } from '../src/connect/configTransaction.js';
import { inspectInterruptedOperation, withConnectOperation } from '../src/connect/operationJournal.js';
import { createConnectService, type ConnectContext } from '../src/connect/service.js';
import { writableTarget, writeConfigFile } from '../src/connect/util.js';

let root: string;
let home: string;
let data: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'extalia-connect-journal-'));
  home = path.join(root, 'home'); data = path.join(root, 'data');
  await mkdir(home);
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

const relative: Record<AgentAppId, string> = {
  codex: '.codex/config.toml', claude: '.claude/settings.json', gemini: '.gemini/settings.json',
  antigravity: '.gemini/config/hooks.json', hermes: '.hermes/config.yaml',
};
const original = (app: AgentAppId) => app === 'hermes' ? 'model: example\n' : app === 'codex' ? 'model = "example"\n' : '{"theme":"example"}\n';
const service = (extra: Partial<ConnectContext> = {}) => createConnectService({
  platform: 'linux', env: { EXTALIA_HOME: data }, extaliaHome: data, homeDirectory: home,
  nodePath: process.execPath, findBinary: async () => undefined, managedClaudeSettings: [],
  now: () => new Date('2026-10-29T12:00:00Z'), fetch: async () => new Response(null, { status: 204 }), ...extra,
});
async function seed(app: AgentAppId) {
  const file = path.join(home, relative[app]);
  await mkdir(path.dirname(file), { recursive: true }); await writeFile(file, original(app));
  return file;
}
const connectDirectory = () => path.join(data, 'connect');
const journalFile = () => path.join(connectDirectory(), 'journal.json');
const lockFile = () => path.join(connectDirectory(), 'operation.lock');
const exists = (file: string) => stat(file).then(() => true, () => false);
const options = { recoverCommand: 'extalia connections --recover' };

/** Simulates a process that died after writing: journal recorded, files written, never completed. */
async function interrupt(app: AgentAppId, entries: { file: string; before: string | undefined; after: string | undefined; write?: boolean }[]) {
  await expect(withConnectOperation(connectDirectory(), { kind: 'connect', app }, options, async journal => {
    for (const entry of entries) {
      await journal.record(entry.file, entry.before, entry.after);
      if (entry.write === false) continue;
      if (entry.after === undefined) await rm(entry.file, { force: true });
      else await writeFile(entry.file, entry.after);
    }
    throw new Error('process died');
  })).rejects.toThrow('process died');
}

describe('connect lock and journal lifecycle', () => {
  it('leaves no journal, snapshots or lock after a successful apply and disconnect', async () => {
    await seed('codex');
    const connect = service();
    await connect.apply('codex');
    await connect.disconnect('codex');
    expect(await exists(journalFile())).toBe(false);
    expect(await exists(path.join(connectDirectory(), 'journal'))).toBe(false);
    expect(await exists(lockFile())).toBe(false);
  });

  it('leaves no connect folder behind when a refused apply created none', async () => {
    const file = await seed('gemini');
    const connect = service();
    const plan = await connect.plan('gemini');
    await expect(connect.apply('gemini', { expectedPreviewDigest: `${plan.previewDigest}0` })).rejects.toThrow('preview changed');
    expect(await exists(connectDirectory())).toBe(false);
    expect(await readFile(file, 'utf8')).toBe(original('gemini'));
  });

  describe('busy lock', () => {
    const writeLock = async (pid: number) => {
      await mkdir(connectDirectory(), { recursive: true });
      await writeFile(lockFile(), `${JSON.stringify({ schema: 'extalia.connect-lock.v1', id: 'x', pid, operation: 'connect:codex', startedAt: new Date().toISOString() })}\n`);
    };
    it('refuses while a live other process holds the lock', async () => {
      const file = await seed('codex');
      await writeLock(process.pid + 1);
      await expect(service({ alive: () => true }).apply('codex')).rejects.toThrow('Another Extalia connection change is in progress');
      expect(await readFile(file, 'utf8')).toBe(original('codex'));
    });
    it('replaces a stale lock of a dead process', async () => {
      await seed('codex');
      await writeLock(process.pid + 1);
      const result = await service({ alive: () => false }).apply('codex');
      expect(result.changed).toBe(true);
      expect(await exists(lockFile())).toBe(false);
    });
  });

  it('serializes concurrent applies of different apps in one process', async () => {
    await seed('codex'); await seed('gemini');
    const connect = service();
    await Promise.all([connect.apply('codex'), connect.apply('gemini')]);
    const manifest = JSON.parse(await readFile(path.join(connectDirectory(), 'manifest.json'), 'utf8')) as { apps: Record<string, unknown> };
    expect(Object.keys(manifest.apps).sort()).toEqual(['codex', 'gemini']);
  });

  it('refuses to proceed past a corrupt journal and does not delete it', async () => {
    const file = await seed('codex');
    await mkdir(connectDirectory(), { recursive: true });
    await writeFile(journalFile(), '{not json');
    await expect(service().apply('codex')).rejects.toThrow('cannot be read');
    expect(await readFile(journalFile(), 'utf8')).toBe('{not json');
    expect(await readFile(file, 'utf8')).toBe(original('codex'));
  });
});

describe('interrupted operation review', () => {
  it('blocks changes, warns for that app only, previews without writing and rolls back exactly', async () => {
    const file = await seed('codex'); await seed('gemini');
    const connect = service();
    const changed = 'model = "changed"\n';
    await interrupt('codex', [{ file, before: original('codex'), after: changed }]);

    await expect(connect.apply('codex')).rejects.toThrow('did not finish');
    await expect(connect.disconnect('codex')).rejects.toThrow('did not finish');
    await expect(connect.apply('gemini')).rejects.toThrow('did not finish');
    expect(await readFile(file, 'utf8')).toBe(changed);

    const list = await connect.connections();
    expect(list.find(item => item.app === 'codex')?.warnings.join('\n')).toContain('connections --recover');
    expect(list.find(item => item.app === 'gemini')?.warnings.join('\n') ?? '').not.toContain('connections --recover');

    const preview = await connect.recover('preview');
    expect(preview.resolved).toBe(false);
    expect(preview.operation?.app).toBe('codex');
    expect(preview.operation?.entries).toEqual([{ target: path.resolve(file), state: 'applied' }]);
    expect(await readFile(file, 'utf8')).toBe(changed);
    expect(await exists(journalFile())).toBe(true);

    const report = await connect.recover('rollback');
    expect(report).toMatchObject({ resolved: true, restored: [path.resolve(file)] });
    expect(await readFile(file, 'utf8')).toBe(original('codex'));
    expect(await exists(journalFile())).toBe(false);
    expect(await exists(path.join(connectDirectory(), 'journal'))).toBe(false);

    expect((await connect.apply('codex')).changed).toBe(true);
  });

  it('removes a file that did not exist before when rolling back', async () => {
    const created = path.join(root, 'created.txt');
    await interrupt('codex', [{ file: created, before: undefined, after: 'new file' }]);
    expect(await readFile(created, 'utf8')).toBe('new file');
    const report = await service().recover('rollback');
    expect(report).toMatchObject({ resolved: true, restored: [path.resolve(created)] });
    expect(await exists(created)).toBe(false);
    expect(await exists(journalFile())).toBe(false);
  });

  it('refuses rollback when a file changed to third content, and keep resolves without touching files', async () => {
    const file = path.join(root, 'tracked.txt');
    await writeFile(file, 'before');
    await interrupt('codex', [{ file, before: 'before', after: 'after' }]);
    await writeFile(file, 'third');
    const connect = service();
    expect((await connect.recover('preview')).operation?.entries[0]?.state).toBe('changed');
    await expect(connect.recover('rollback')).rejects.toThrow('cannot roll it back safely');
    expect(await readFile(file, 'utf8')).toBe('third');
    expect(await exists(journalFile())).toBe(true);

    const kept = await connect.recover('keep');
    expect(kept).toMatchObject({ resolved: true, restored: [] });
    expect(await readFile(file, 'utf8')).toBe('third');
    expect(await exists(journalFile())).toBe(false);
  });

  it('treats a write that never happened as not-applied and leaves the file', async () => {
    const file = path.join(root, 'untouched.txt');
    await writeFile(file, 'before');
    await interrupt('codex', [{ file, before: 'before', after: 'after', write: false }]);
    const connect = service();
    expect((await connect.recover('preview')).operation?.entries[0]?.state).toBe('not-applied');
    const report = await connect.recover('rollback');
    expect(report).toMatchObject({ resolved: true, restored: [] });
    expect(await readFile(file, 'utf8')).toBe('before');
    expect(await exists(journalFile())).toBe(false);
  });
});

describe('commitConfigWrites with a journal', () => {
  async function writes() {
    const first = path.join(root, 'first'), second = path.join(root, 'second');
    await writeFile(first, 'original first'); await writeFile(second, 'original second');
    return Promise.all([first, second].map(async (file, index) => ({ file, target: await writableTarget(file), before: `original ${index ? 'second' : 'first'}`, after: `new ${index}` })));
  }
  const run = async (entries: Awaited<ReturnType<typeof writes>>, conflict: boolean) => {
    let message = '';
    await withConnectOperation(connectDirectory(), { kind: 'connect', app: 'codex' }, options, async journal => {
      try {
        await commitConfigWrites(entries, async (file, after, mode) => {
          if (file === entries[1]!.target) {
            if (conflict) await writeFile(entries[0]!.target, 'concurrent user edit');
            throw new Error('simulated write failure');
          }
          await writeConfigFile(file, after, mode);
        }, journal, ' Review it with `recover`.');
      } catch (error) { message = (error as Error).message; }
    });
    return message;
  };

  it('keeps the journal when rollback is incomplete because of a concurrent edit', async () => {
    const entries = await writes();
    const message = await run(entries, true);
    expect(message).toContain('rollback is incomplete');
    expect(message).toContain('Review it with `recover`.');
    expect(await readFile(entries[0]!.file, 'utf8')).toBe('concurrent user edit');
    expect(await exists(journalFile())).toBe(true);
    expect(await exists(lockFile())).toBe(false);
    expect(await readdir(path.join(connectDirectory(), 'journal'))).toHaveLength(2);
  });

  it('removes the journal after a clean rollback', async () => {
    const entries = await writes();
    const message = await run(entries, false);
    expect(message).toContain('rolled back');
    for (const entry of entries) expect(await readFile(entry.file, 'utf8')).toBe(entry.before);
    expect(await exists(journalFile())).toBe(false);
    expect(await exists(path.join(connectDirectory(), 'journal'))).toBe(false);
  });
});

describe('interrupted-operation liveness (independent review findings)', () => {
  it('does not report an operation still running in this process as interrupted', async () => {
    const file = await seed('codex'), target = await writableTarget(file);
    let seenDuring: unknown = 'unset';
    await withConnectOperation(connectDirectory(), { kind: 'connect', app: 'codex' }, options, async journal => {
      await journal.record(target, original('codex'), 'model = "changed"\n');
      seenDuring = await inspectInterruptedOperation(connectDirectory(), () => true);
      await journal.complete();
    });
    expect(seenDuring).toBeUndefined();
  });

  it('reports a journal whose lock predates the last boot even when the pid is alive again', async () => {
    const file = await seed('codex'), target = await writableTarget(file);
    await mkdir(connectDirectory(), { recursive: true });
    const pid = process.pid + 1;
    await writeFile(journalFile(), JSON.stringify({
      schema: 'extalia.connect-journal.v1', id: 'j', operation: 'connect', app: 'codex', pid, startedAt: '2001-01-01T00:00:00.000Z',
      entries: [{ target, existed: false, afterSha256: null }],
    }));
    await writeFile(lockFile(), JSON.stringify({ schema: 'extalia.connect-lock.v1', id: 'l', pid, operation: 'connect:codex', startedAt: '2001-01-01T00:00:00.000Z' }));
    const interrupted = await inspectInterruptedOperation(connectDirectory(), () => true);
    expect(interrupted?.app).toBe('codex');
    expect(await service({ alive: () => true }).recover('preview')).toMatchObject({ operation: { app: 'codex' } });
  });
});
