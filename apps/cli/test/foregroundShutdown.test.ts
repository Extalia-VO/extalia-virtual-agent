import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

interface Message { kind: string; url?: string; code?: number }

describe.skipIf(process.platform === 'win32')('foreground Bridge terminal shutdown', () => {
  let directory: string, bundle: string;
  const children = new Set<ChildProcess>();
  beforeAll(async () => {
    directory = await mkdtemp(path.join(tmpdir(), 'extalia-foreground-'));
    await mkdir(path.join(directory, 'web'));
    await writeFile(path.join(directory, 'web', 'index.html'), '<html><head></head><body>Temporary Bridge</body></html>');
    bundle = path.join(directory, 'foreground.mjs');
    await build({
      stdin: { sourcefile: 'foreground-fixture.ts', resolveDir: path.dirname(fileURLToPath(import.meta.url)), contents: `
        import path from 'node:path';
        import { startBridge } from ${JSON.stringify(fileURLToPath(new URL('../src/start.ts', import.meta.url)))};
        const root = process.env.EXTALIA_HOME;
        const send = value => process.send?.(value);
        const code = await startBridge({ port: Number(process.argv[2]), open: false, updateCheck: false }, {
          version: '1.0.0', env: process.env, dataDirectory: root, webRoot: path.join(root, 'web'), signals: process,
          out(line) {
            if (line.includes('is running at ')) send({kind:'ready',url:line.split('is running at ')[1]});
            if (line === 'Stopping Extalia…') send({kind:'stopping'});
          },
          err(line) { process.stderr.write(line+'\\n'); }, openBrowser() { throw new Error('Browser disabled'); },
          createAgentHost: async options => {
            if (options.dataDirectory !== root) throw new Error('Profile was not isolated');
            const keepAlive = setInterval(() => {}, 1000);
            return { host: { subscribe() { send({kind:'subscribed'}); return () => send({kind:'unsubscribed'}); } },
              isBusy: () => false, onIdle: () => () => {},
              async close() { await new Promise(resolve => setTimeout(resolve, Number(process.env.EXTALIA_TEST_CLOSE_MS ?? 20))); clearInterval(keepAlive); send({kind:'host-closed'}); } };
          },
          updater: { status: () => ({state:'unsupported',current:'1.0.0',channel:'stable'}) },
          relaunch: { execPath: process.execPath, execArgv: [], binPath: 'unused', args: [] },
          spawn() { throw new Error('No update expected'); },
        });
        await new Promise(resolve => process.send({kind:'done',code}, resolve));
        process.exitCode = code;
        process.disconnect();
      ` },
      outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent',
      banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
    });
  });
  afterAll(async () => {
    for (const child of children) { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
    await Promise.all([...children].map(child => child.exitCode !== null || child.signalCode !== null ? undefined : once(child, 'exit')));
    await rm(directory, { recursive: true, force: true });
  });

  function launch(port: number, closeMs = 20) {
    const messages: Message[] = [];
    const child = spawn(process.execPath, [bundle, String(port)], {
      env: { ...process.env, EXTALIA_HOME: directory, EXTALIA_TEST_CLOSE_MS: String(closeMs) }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    });
    children.add(child);
    let errors = '';
    child.stderr!.on('data', chunk => { errors += String(chunk); });
    child.on('message', message => messages.push(message as Message));
    const exited = once(child, 'exit');
    const waitFor = async (kind: string) => {
      await vi.waitFor(() => expect(messages.find(message => message.kind === kind), errors).toBeDefined(), { timeout: 5000 });
      return messages.find(message => message.kind === kind)!;
    };
    return { child, messages, waitFor, exited };
  }

  it('closes the listening port and open SSE stream on SIGINT, drains the host, and restarts on the same port', async () => {
    const first = launch(0), ready = await first.waitFor('ready'), url = new URL(ready.url!);
    const html = await fetch(url).then(response => response.text());
    const token = /<meta name="extalia-bridge" content="([a-f0-9]{64})">/.exec(html)?.[1];
    expect(token).toBeDefined();
    const req = request(new URL(`/api/events?token=${token}`, url));
    req.on('error', () => undefined);
    const responseReady = once(req, 'response'); req.end();
    const [stream] = await responseReady;
    stream.resume();
    stream.on('error', () => undefined); // Closing a live SSE socket aborts its unfinished response.
    const streamClosed = new Promise<void>(resolve => stream.once('close', resolve));
    await first.waitFor('subscribed');
    first.child.kill('SIGINT');
    await streamClosed;
    await first.waitFor('unsubscribed'); await first.waitFor('host-closed');
    expect(await first.exited).toEqual([0, null]);
    await expect(fetch(url, { signal: AbortSignal.timeout(1000) })).rejects.toThrow();
    const restarted = launch(Number(url.port));
    expect((await restarted.waitFor('ready')).url).toBe(url.href);
    expect(await fetch(url).then(response => response.status)).toBe(200);
    restarted.child.kill('SIGINT');
    expect(await restarted.exited).toEqual([0, null]);
    // No real profile is involved, even in the child process.
    expect(await readFile(path.join(directory, 'web', 'index.html'), 'utf8')).toContain('Temporary Bridge');
  });

  it('coalesces a second real SIGINT while the host is still draining', async () => {
    const running = launch(0, 200);
    await running.waitFor('ready');
    running.child.kill('SIGINT');
    await running.waitFor('stopping');
    running.child.kill('SIGINT');
    await running.waitFor('host-closed');
    expect(await running.exited).toEqual([0, null]);
    expect(running.messages.filter(message => message.kind === 'stopping')).toHaveLength(1);
    expect(running.messages.filter(message => message.kind === 'host-closed')).toHaveLength(1);
  });
});
