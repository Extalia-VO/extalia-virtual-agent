import { PROTOCOL_VERSION } from '@extalia/protocol';
import { describe, expect, it } from 'vitest';
import { DEFAULT_PORT, parseStartArgs, run, type CliHost, type StartOptions, type UpdateOptions } from '../src/cli';

function host(files: Record<string, string> = {}, overrides: Partial<CliHost> = {}) {
  const out: string[] = [], err: string[] = [];
  const started: StartOptions[] = [], updated: UpdateOptions[] = [];
  const value: CliHost = {
    version: '0.0.0-test',
    out: line => out.push(line),
    err: line => err.push(line),
    readFile: async path => { if (path in files) return files[path] as string; throw new Error('not found'); },
    exists: async () => false,
    platform: 'linux',
    arch: 'x64',
    nodeVersion: 'v24.1.0',
    env: {},
    homeDirectory: '/home/someone',
    start: async options => { started.push(options); return 0; },
    update: async options => { updated.push(options); return 0; },
    ...overrides,
  };
  return { value, out, err, started, updated };
}

const event = (body: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({
  v: PROTOCOL_VERSION, id: `e-${Math.random()}`, at: '2026-01-31T12:00:00.000Z', sessionId: 's', source: { runtime: 'demo', channel: 'stream' }, ...extra, body,
});

describe('extalia CLI', () => {
  it('prints help and version', async () => {
    const help = host();
    expect(await run(['help'], help.value)).toBe(0);
    expect(help.out.join('\n')).toContain('Usage: extalia');
    const version = host();
    expect(await run(['--version'], version.value)).toBe(0);
    expect(version.out).toEqual(['0.0.0-test']);
  });

  it('reports diagnostics and fails on unsupported Node versions', async () => {
    const ok = host();
    expect(await run(['doctor'], ok.value)).toBe(0);
    expect(ok.out.join('\n')).toContain('User data         /home/someone/.extalia-vo  (not created yet)');
    expect(ok.out.join('\n')).not.toContain('Previous data');
    const legacy = host({}, { exists: async file => file === '/home/someone/.local/share/extalia' });
    expect(await run(['doctor'], legacy.value)).toBe(0);
    expect(legacy.out.join('\n')).toContain('Previous data     /home/someone/.local/share/extalia  (copied into the folder above when Extalia next starts)');
    const migrated = host({ '/home/someone/.extalia-vo/state/migrated-from.json': '{"from":"/home/someone/.local/share/extalia","at":"2026-10-01T00:00:00.000Z"}' }, { exists: async () => true });
    expect(await run(['doctor'], migrated.value)).toBe(0);
    expect(migrated.out.join('\n')).toContain('(copied on 2026-10-01T00:00:00.000Z; safe to remove after checking)');
    const old = host({}, { nodeVersion: 'v20.10.0' });
    expect(await run(['doctor'], old.value)).toBe(1);
    const flaggedSqlite = host({}, { nodeVersion: 'v22.12.0' });
    expect(await run(['doctor'], flaggedSqlite.value)).toBe(1);
    expect(flaggedSqlite.out.join('\n')).toContain('requires 22.13 or newer; Node 23 needs 23.4+');
    expect(await run(['doctor'], host({}, { nodeVersion: 'v22.13.0' }).value)).toBe(0);
    expect(await run(['doctor'], host({}, { nodeVersion: 'v23.3.0' }).value)).toBe(1);
    expect(await run(['doctor'], host({}, { nodeVersion: 'v23.4.0' }).value)).toBe(0);
  });

  it('validates JSON Lines events line by line', async () => {
    const io = host({ 'events.jsonl': [event({ type: 'model.thinking' }), event({ type: 'agent.state', state: 'idle' })].join('\n') });
    expect(await run(['validate', 'events.jsonl'], io.value)).toBe(1);
    expect(io.err.join('\n')).toMatch(/line 2: invalid: agentId/);
    expect(io.out.at(-1)).toContain('1 of 2');
  });

  it('validates a JSON array of events', async () => {
    const io = host({ 'events.json': `[${event({ type: 'model.delta', text: 'hi' })}]` });
    expect(await run(['validate', 'events.json'], io.value)).toBe(0);
  });

  it('validates portable sessions and reports likely credentials', async () => {
    const session = {
      format: 'extalia.session.v1', title: 'Demo', importMode: 'imported',
      provenance: { sourceId: 'demo', sourceSessionId: '1', exportedAt: '2026-01-31T12:00:00.000Z' },
      messages: [{ index: 0, role: 'user', content: 'password=hunter22', createdAt: '2026-01-31T12:00:00.000Z' }],
      startedAt: '2026-01-31T12:00:00.000Z', lastMessageAt: '2026-01-31T12:00:00.000Z',
    };
    const io = host({ 'sessions.json': JSON.stringify([session]) });
    expect(await run(['validate', 'sessions.json'], io.value)).toBe(0);
    expect(io.out.join('\n')).toMatch(/1 portable session\(s\) valid; 1 likely credential/);
  });

  it('returns usage errors for missing files and unknown commands', async () => {
    expect(await run(['validate'], host().value)).toBe(2);
    expect(await run(['validate', 'missing.json'], host().value)).toBe(2);
    expect(await run(['launch-rockets'], host().value)).toBe(2);
  });

  it('starts the Bridge by default and with start options', async () => {
    const plain = host();
    expect(await run([], plain.value)).toBe(0);
    expect(plain.started).toEqual([{ port: DEFAULT_PORT, open: true, updateCheck: true }]);
    const flags = host();
    expect(await run(['--port', '4400', '--no-open'], flags.value)).toBe(0);
    expect(await run(['start', '--port=0', '--no-update-check', '--host', 'localhost'], flags.value)).toBe(0);
    expect(flags.started).toEqual([{ port: 4400, open: false, updateCheck: true }, { port: 0, open: true, updateCheck: false }]);
  });

  it('honors EXTALIA_NO_UPDATE_CHECK', () => {
    expect(parseStartArgs([], { EXTALIA_NO_UPDATE_CHECK: '1' })).toMatchObject({ updateCheck: false });
    expect(parseStartArgs([], { EXTALIA_NO_UPDATE_CHECK: '0' })).toMatchObject({ updateCheck: true });
  });

  it('rejects invalid start options and non-loopback hosts', async () => {
    for (const args of [['--port', 'abc'], ['--port', '70000'], ['--port'], ['--host', '0.0.0.0'], ['--host=192.168.1.2'], ['--open-sesame'], ['--no-open=yes']]) {
      const io = host();
      expect(await run(['start', ...args], io.value)).toBe(2);
      expect(io.started).toEqual([]);
    }
    const io = host();
    await run(['start', '--host', '0.0.0.0'], io.value);
    expect(io.err.join('\n')).toMatch(/only listens on this computer/);
  });

  it('runs update with --check and rejects unknown update options', async () => {
    const io = host();
    expect(await run(['update'], io.value)).toBe(0);
    expect(await run(['update', '--check'], io.value)).toBe(0);
    expect(io.updated).toEqual([{ check: false }, { check: true }]);
    expect(await run(['update', '--force'], io.value)).toBe(2);
  });
});
