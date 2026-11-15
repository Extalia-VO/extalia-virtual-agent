import { spawn } from 'node:child_process';
import { mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createCavemanContextOptimizer, type CavemanContextOptimizerOptions, type CavemanProcessOptions } from '../src/cavemanContextOptimizer.js';

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(directory => rm(directory, { recursive: true, force: true }))); });
const evidence = `Decision: retain the first duplicate; limit 73.\n${'INFO: polling worker\n'.repeat(600)}Pending: test empty input.\n`;
const request = (signal = new AbortController().signal) => ({ name: 'read_logs', content: evidence, query: 'What remains?', signal, maxCharacters: 2000,
  recovery: { reference: 'a'.repeat(64), messageIndex: 2, resultIndex: 0, readToolName: 'context_archive_read' } });

// A deliberately small subprocess fixture speaks the pinned upstream CLI contract.
// It tests Extalia's actual pipes, deadlines, environments, and cleanup, not an engine
// quality benchmark. Real Caveman verification is a separate opt-in local exercise.
async function fixture(mode = 'compress', extra: Partial<CavemanContextOptimizerOptions> = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-caveman-contract-')); directories.push(root);
  const script = path.join(root, 'engine-fixture.mjs');
  await writeFile(script, `import fs from 'node:fs';
const mode = ${JSON.stringify(mode)};
const command = process.argv[2];
if (mode === 'hang') setInterval(() => {}, 1000);
else if (command === 'compress') {
  const input = fs.readFileSync(0);
  fs.writeFileSync(process.env.CAVEMAN_CCR_DB, input, { mode: 0o600 });
  if (mode === 'overflow') { process.stdout.write('x'.repeat(700000)); }
  else if (mode === 'invalid') { process.stderr.write('not a JSON report'); process.stdout.write('small'); }
  else {
    const lines = input.toString().trimEnd().split('\\n');
    const output = mode === 'passthrough' ? input : Buffer.from(lines[0] + '\\n[Repeated polling omitted.]\\n' + lines.at(-1) + '\\n');
    process.stdout.write(output);
    process.stderr.write(JSON.stringify({ content_type: 'log', tokens_before: Math.ceil(input.length / 4), tokens_after: Math.ceil(output.length / 4),
      token_count_basis: 'approx-chars/4', basis: 'inferred', method: 'log',
      recovery_handle: mode === 'handle' ? '../outside' : 'ccr_' + 'b'.repeat(32) }) + '\\n');
  }
} else if (command === 'retrieve') {
  process.stdout.write(mode === 'mismatch' ? Buffer.from('Different source') : fs.readFileSync(process.env.CAVEMAN_CCR_DB));
} else process.exit(2);
`, { mode: 0o600 });
  const calls: { args: readonly string[]; options: CavemanProcessOptions; closed: boolean }[] = [];
  const options: CavemanContextOptimizerOptions = { executable: process.execPath, directory: path.join(root, 'private'), assertCurrent: () => undefined,
    spawn: (_binary, args, options) => {
      const call = { args: [...args], options, closed: false }; calls.push(call);
      const child = spawn(process.execPath, [script, ...args], { ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      child.on('close', () => { call.closed = true; });
      return child;
    }, ...extra };
  return { root, calls, options, optimizer: createCavemanContextOptimizer(options) };
}

describe('optional local Caveman Engine adapter', () => {
  it('uses compress/retrieve with private CCR, verifies exact recovery and clears it before publishing', async () => {
    const f = await fixture('compress', { env: { LANG: 'C.UTF-8', OPENAI_API_KEY: 'synthetic-provider-credential',
      HTTP_PROXY: 'http://example.com', NODE_OPTIONS: '--inspect', PATH: 'UNTRUSTED_SEARCH_PATH', CAVEMAN_CCR_DB: 'UNTRUSTED_SHARED_STORE' } });
    const result = await f.optimizer(request());
    expect(result).toMatchObject({ status: 'compressed', method: 'log', tokenCountBasis: 'approx-chars/4' });
    expect(result.content).toContain('limit 73'); expect(result.content).toContain('Pending: test empty input.');
    expect(f.calls.map(call => call.args)).toEqual([['compress'], ['retrieve', `ccr_${'b'.repeat(32)}`]]);
    expect(f.calls.every(call => call.closed)).toBe(true);
    // The adapter uses the canonical parent, which can expand a Windows short temp path.
    const privateDirectory = await realpath(f.options.directory);
    for (const call of f.calls) {
      expect(path.dirname(call.options.cwd)).toBe(privateDirectory);
      expect(path.basename(call.options.cwd)).toMatch(/^caveman-/);
      expect(call.options.env.CAVEMAN_CCR_DB).toBe(path.join(call.options.cwd, 'recovery.db'));
      expect(call.options.env.CAVEMAN_HOME).toBe(call.options.cwd);
      expect(call.options.env.HOME).toBe(call.options.cwd);
      expect(call.options.env.LANG).toBe('C.UTF-8');
      for (const key of ['OPENAI_API_KEY', 'HTTP_PROXY', 'NODE_OPTIONS', 'PATH']) expect(call.options.env[key]).toBeUndefined();
    }
    expect(new Set(f.calls.map(call => call.options.cwd)).size).toBe(1);
    expect(await readdir(f.options.directory)).toEqual([]);
  });

  it('sanitizes input before even temporary persistence', async () => {
    const f = await fixture();
    const secret = `sk-${'a'.repeat(40)}`;
    const result = await f.optimizer({ ...request(), content: `Decision: retain ${secret} safely.\n${evidence}` });
    expect(result.status).toBe('compressed'); expect(result.content).toContain('[redacted]'); expect(result.content).not.toContain(secret);
  });

  it('reports pass-through without claiming a transform or running unnecessary retrieval', async () => {
    const f = await fixture('passthrough');
    expect(await f.optimizer(request())).toMatchObject({ status: 'unchanged', reason: 'engine-pass-through' });
    expect(f.calls).toHaveLength(1);
    expect(await readdir(f.options.directory)).toEqual([]);
  });

  it('refuses missing/relative binaries and invalid recovery receipts before starting a process', async () => {
    for (const executable of ['caveman-engine', path.join(os.tmpdir(), 'missing-caveman-fixture-engine')]) {
      const f = await fixture('compress', { executable });
      expect(await f.optimizer(request())).toMatchObject({ status: 'unavailable' });
      expect(f.calls).toEqual([]);
    }
    const f = await fixture();
    expect(await f.optimizer({ ...request(), recovery: { ...request().recovery, reference: '../outside' } }))
      .toMatchObject({ status: 'unavailable', reason: 'recovery-receipt-required' });
    expect(f.calls).toEqual([]);
  });

  it('rejects malformed reports, unsafe handles, mismatched recovery and excessive output, with cleanup', async () => {
    const cases = [['invalid', 'invalid-engine-report'], ['handle', 'invalid-engine-transform'],
      ['mismatch', 'engine-recovery-mismatch'], ['overflow', 'engine-output-limit']] as const;
    for (const [mode, reason] of cases) {
      const f = await fixture(mode);
      expect(await f.optimizer(request())).toMatchObject({ status: 'unavailable', reason });
      expect(f.calls.every(call => call.closed)).toBe(true);
      expect(await readdir(f.options.directory)).toEqual([]);
    }
  });

  it('bounds input before spawning and does not admit output beyond its projection budget', async () => {
    const f = await fixture();
    expect(await f.optimizer({ ...request(), content: 'x'.repeat(512 * 1024 + 1) }))
      .toMatchObject({ status: 'unavailable', reason: 'engine-input-limit' });
    expect(f.calls).toEqual([]);
    expect(await f.optimizer({ ...request(), maxCharacters: 20 })).toMatchObject({ status: 'unavailable', reason: 'invalid-engine-transform' });
    expect(f.calls).toHaveLength(1);
  });

  it('waits for terminated subprocesses and clears their store on deadline or cancellation', async () => {
    const timed = await fixture('hang', { timeoutMs: 80 });
    expect(await timed.optimizer(request())).toMatchObject({ status: 'unavailable', reason: 'engine-timeout' });
    expect(timed.calls.every(call => call.closed)).toBe(true);
    expect(await readdir(timed.options.directory)).toEqual([]);
    const controller = new AbortController();
    const cancelled = await fixture('hang');
    const pending = cancelled.optimizer(request(controller.signal));
    const timer = setTimeout(() => controller.abort(), 80);
    try { await expect(pending).rejects.toThrow(); } finally { clearTimeout(timer); }
    expect(cancelled.calls.every(call => call.closed)).toBe(true);
    expect(await readdir(cancelled.options.directory)).toEqual([]);
  });

  it('discards the transform when scope is revoked between compression and retrieval', async () => {
    let allowed = true;
    const f = await fixture('compress', { assertCurrent: () => { if (!allowed) throw new Error('Revoked'); } });
    const actualSpawn = f.options.spawn!;
    const optimizer = createCavemanContextOptimizer({ ...f.options, spawn: (binary, args, options) => {
      const child = actualSpawn(binary, args, options);
      child.on('close', () => { allowed = false; }); return child;
    } });
    expect(await optimizer(request())).toMatchObject({ status: 'unavailable', reason: 'scope-unavailable' });
    expect(f.calls).toHaveLength(1); expect(f.calls[0]!.closed).toBe(true);
    expect(await readdir(f.options.directory)).toEqual([]);
  });
});
