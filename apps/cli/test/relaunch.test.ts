import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AgentHostRuntime } from '@extalia/host';
import type { AgentHostApi, UpdateStatus } from '@extalia/platform';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { TOKEN_HEADER } from '../src/bridge/server';
import { RELAUNCH_TOKEN_ENV, exitCodeFor, relaunchPlan, supervise, takeRelaunchToken, type SupervisedChild } from '../src/relaunch';
import { startBridge, type StartDeps } from '../src/start';
import { browserCommand } from '../src/system';
import type { Updater } from '../src/update';

const TOKEN = 'ab'.repeat(32);

class FakeChild extends EventEmitter {
  signals: string[] = [];
  kill(signal?: NodeJS.Signals) { this.signals.push(signal ?? 'SIGTERM'); return true; }
  // EventEmitter's generic listener signature does not match the narrow child contract structurally.
  get asChild(): SupervisedChild { return this as unknown as SupervisedChild; }
}

class Signals extends EventEmitter {
  count(signal: string) { return this.listenerCount(signal); }
}

describe('relaunch decisions', () => {
  it('relaunches the same bin and arguments without opening another tab', () => {
    const plan = relaunchPlan({ execPath: '/usr/bin/node', execArgv: ['--enable-source-maps'], binPath: '/usr/lib/node_modules/extalia-vo/dist/extalia.mjs', args: ['--port', '4400'], env: { PATH: '/usr/bin' }, token: TOKEN });
    expect(plan).toEqual({
      command: '/usr/bin/node',
      args: ['--enable-source-maps', '/usr/lib/node_modules/extalia-vo/dist/extalia.mjs', '--port', '4400', '--no-open'],
      env: { PATH: '/usr/bin', [RELAUNCH_TOKEN_ENV]: TOKEN },
    });
    expect(relaunchPlan({ execPath: 'node', execArgv: [], binPath: 'bin', args: ['start', '--no-open'], env: {}, token: TOKEN }).args).toEqual(['bin', 'start', '--no-open']);
  });

  it('takes a well-formed relaunch token once and removes it from the environment', () => {
    const env: Record<string, string | undefined> = { [RELAUNCH_TOKEN_ENV]: TOKEN, OTHER: '1' };
    expect(takeRelaunchToken(env)).toBe(TOKEN);
    expect(env).toEqual({ OTHER: '1' });
    expect(takeRelaunchToken(env)).toBeUndefined();
    const forged: Record<string, string | undefined> = { [RELAUNCH_TOKEN_ENV]: 'not-a-token' };
    expect(takeRelaunchToken(forged)).toBeUndefined();
    expect(forged).toEqual({});
  });

  it('maps child exits to exit codes', () => {
    expect(exitCodeFor(0, null)).toBe(0);
    expect(exitCodeFor(3, null)).toBe(3);
    expect(exitCodeFor(null, 'SIGINT')).toBe(130);
    expect(exitCodeFor(null, 'SIGTERM')).toBe(143);
    expect(exitCodeFor(null, null)).toBe(1);
  });

  it('forwards signals to the child and exits with its code', async () => {
    const child = new FakeChild(), signals = new Signals();
    const done = supervise(child.asChild, signals);
    signals.emit('SIGINT');
    signals.emit('SIGTERM');
    expect(child.signals).toEqual(['SIGINT', 'SIGTERM']);
    child.emit('exit', 7, null);
    expect(await done).toBe(7);
    expect(signals.count('SIGINT') + signals.count('SIGTERM')).toBe(0);
  });

  it('fails cleanly when the child cannot start', async () => {
    const child = new FakeChild(), signals = new Signals(), errors: string[] = [];
    const done = supervise(child.asChild, signals, error => errors.push(error.message));
    child.emit('error', new Error('spawn ENOENT'));
    expect(await done).toBe(1);
    expect(errors).toEqual(['spawn ENOENT']);
  });

  it('opens the browser with the platform command', () => {
    const url = 'http://127.0.0.1:4310/';
    expect(browserCommand('darwin', url)).toMatchObject({ command: 'open', args: [url] });
    expect(browserCommand('win32', url)).toMatchObject({ command: 'cmd', args: ['/c', 'start', '""', url], options: { windowsVerbatimArguments: true } });
    expect(browserCommand('linux', url)).toMatchObject({ command: 'xdg-open', args: [url] });
  });
});

function post(port: number, target: string, token: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'POST', path: target, headers: { [TOKEN_HEADER]: token } }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk: string) => { body += chunk; });
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('startBridge', () => {
  let dir: string, signals: Signals, out: string[], errors: string[], spawned: { command: string; args: string[]; env: Record<string, string | undefined> }[];
  let child: FakeChild, busy: boolean, idle: (() => void) | undefined, closed: number, opened: string[];

  const runtime: AgentHostRuntime = {
    host: { getState: async () => ({}), subscribe: () => () => undefined } as unknown as AgentHostApi,
    isBusy: () => busy,
    onIdle: listener => { idle = listener; return () => { idle = undefined; }; },
    close: async () => { closed++; },
  };

  function fakeUpdater(state: UpdateStatus['state'], installResult: UpdateStatus['state'] = 'ready'): Updater & { installs: number } {
    let status: UpdateStatus = { current: '1.0.0', latest: '1.1.0', channel: 'stable', state };
    return {
      installs: 0,
      status: () => status,
      check: async () => status,
      async install() {
        this.installs++;
        status = { ...status, state: 'installing' };
        await Promise.resolve();
        return (status = { ...status, state: installResult, ...(installResult === 'error' ? { detail: 'npm exited with code 1.' } : {}) });
      },
    };
  }

  function deps(overrides: Partial<StartDeps> = {}): StartDeps {
    return {
      version: '1.0.0',
      out: line => out.push(line),
      err: line => errors.push(line),
      env: { PATH: '/usr/bin' },
      dataDirectory: path.join(dir, 'data'),
      webRoot: path.join(dir, 'web'),
      createAgentHost: async () => runtime,
      updater: fakeUpdater('up-to-date'),
      openBrowser: url => opened.push(url),
      signals,
      relaunch: { execPath: '/usr/bin/node', execArgv: [], binPath: '/opt/extalia/dist/extalia.mjs', args: ['--port', '0'] },
      spawn: (command, args, options) => { spawned.push({ command, args, env: options.env }); return child.asChild; },
      ...overrides,
    };
  }

  /** Wait until the Bridge printed its URL and return the port. */
  async function bridgePort(): Promise<number> {
    await expect.poll(() => out.find(line => line.includes(' is running at '))).toBeTruthy();
    return Number(/:(\d+)\/$/.exec(out.find(line => line.includes(' is running at '))!)![1]);
  }

  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'extalia-start-'));
    signals = new Signals();
    out = []; errors = []; spawned = []; opened = [];
    child = new FakeChild();
    busy = false; idle = undefined; closed = 0;
  });
  afterEach(() => rm(dir, { recursive: true, force: true }));

  it('starts, opens the browser and stops on SIGINT, closing the agent host', async () => {
    const running = startBridge({ port: 0, open: true, updateCheck: false }, deps());
    const port = await bridgePort();
    expect(opened).toEqual([`http://127.0.0.1:${port}/`]);
    signals.emit('SIGINT');
    signals.emit('SIGINT');
    expect(await running).toBe(0);
    expect(closed).toBe(1);
    expect(signals.count('SIGINT')).toBe(0);
  });

  it('reports an update found by the background check', async () => {
    const running = startBridge({ port: 0, open: false, updateCheck: true }, deps({ updater: fakeUpdater('available') }));
    await bridgePort();
    await expect.poll(() => out).toContain('Extalia 1.1.0 is available. Run: extalia update');
    expect(opened).toEqual([]);
    signals.emit('SIGTERM');
    expect(await running).toBe(0);
  });

  it('keeps serving and explains when agents are unavailable', async () => {
    const running = startBridge({ port: 0, open: false, updateCheck: false }, deps({ createAgentHost: () => Promise.reject(new Error('no runtime yet')) }));
    await bridgePort();
    await expect.poll(() => errors).toContain('Agents are not available: no runtime yet');
    signals.emit('SIGINT');
    expect(await running).toBe(0);
  });

  it('installs an update, closes everything and relaunches with the same token', async () => {
    const updater = fakeUpdater('available');
    const running = startBridge({ port: 0, open: true, updateCheck: false }, deps({ updater, token: TOKEN }));
    const port = await bridgePort();
    const reply = await post(port, '/api/update/install', TOKEN);
    expect(reply.status).toBe(200);
    expect(JSON.parse(reply.body)).toMatchObject({ state: 'installing' });
    await expect.poll(() => spawned.length).toBe(1);
    expect(spawned[0]).toEqual({
      command: '/usr/bin/node',
      args: ['/opt/extalia/dist/extalia.mjs', '--port', '0', '--no-open'],
      env: { PATH: '/usr/bin', [RELAUNCH_TOKEN_ENV]: TOKEN },
    });
    expect(closed).toBe(1);
    // The supervisor forwards signals and exits with the child's code.
    signals.emit('SIGINT');
    expect(child.signals).toEqual(['SIGINT']);
    child.emit('exit', 0, null);
    expect(await running).toBe(0);
  });

  it('refuses installs while agents work and restarts only after they finish', async () => {
    const updater = fakeUpdater('available');
    const running = startBridge({ port: 0, open: false, updateCheck: false }, deps({ updater, token: TOKEN }));
    const port = await bridgePort();
    busy = true;
    const refused = await post(port, '/api/update/install', TOKEN);
    expect(refused.status).toBe(409);
    expect(JSON.parse(refused.body).error).toMatch(/Agents are still working/);
    expect(updater.installs).toBe(0);

    busy = false;
    const original = updater.install.bind(updater);
    // A turn starts while npm runs.
    updater.install = async () => { const result = await original(); busy = true; return result; };
    expect((await post(port, '/api/update/install', TOKEN)).status).toBe(200);
    await expect.poll(() => idle).toBeTypeOf('function');
    expect(spawned).toEqual([]);
    busy = false;
    idle!();
    await expect.poll(() => spawned.length).toBe(1);
    child.emit('exit', null, 'SIGTERM');
    expect(await running).toBe(143);
  });

  it('stays up when the install fails', async () => {
    const running = startBridge({ port: 0, open: false, updateCheck: false }, deps({ updater: fakeUpdater('available', 'error'), token: TOKEN }));
    const port = await bridgePort();
    expect((await post(port, '/api/update/install', TOKEN)).status).toBe(200);
    await expect.poll(() => errors).toContain('npm exited with code 1.');
    expect(spawned).toEqual([]);
    signals.emit('SIGINT');
    expect(await running).toBe(0);
  });

  it('exits with an explanation when the port is taken', async () => {
    const first = startBridge({ port: 0, open: false, updateCheck: false }, deps());
    const port = await bridgePort();
    const secondErrors: string[] = [];
    expect(await startBridge({ port, open: false, updateCheck: false }, deps({ err: line => secondErrors.push(line) }))).toBe(1);
    expect(secondErrors[0]).toMatch(new RegExp(`Port ${port} is already in use`));
    signals.emit('SIGINT');
    expect(await first).toBe(0);
  });
});
