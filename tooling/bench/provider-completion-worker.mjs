#!/usr/bin/env node
/** Isolated production-provider workload; the driver owns HTTP fixtures and RSS sampling. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** Keep the actual production child for kill/close settlement; only Python argv are substituted. */
export function completionCommand(config, binary, args) {
  if (config.backend !== 'python') return { binary, args };
  if (!config.python?.executable || !config.python?.script || args.length !== 2 || args[0] !== '--provider-worker'
    || !/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(args[1])) throw new Error('Invalid Python worker launch.');
  return { binary: config.python.executable, args: ['-I', '-B', '-u', config.python.script, ...args] };
}

/** Preserve the credential-free environment supplied by the real host port. */
export function spawnCompletionChild(config, binary, args, options, spawnChild = spawn, diagnosticFile) {
  const command = completionCommand(config, binary, args);
  const spawnOptions = { ...options, shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] };
  if (!diagnosticFile) return spawnChild(command.binary, command.args, spawnOptions);
  const flags = process.platform === 'darwin' ? ['-l', '-o', diagnosticFile] : ['-v', '-o', diagnosticFile];
  return spawnChild('/usr/bin/time', [...flags, command.binary, ...command.args], spawnOptions);
}

export async function runBenchmarkWorker(config) {
const hash = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const send = value => process.send?.(value);
const importStart = performance.now();
const module = await import(pathToFileURL(config.module));
const importMs = performance.now() - importStart;
if (config.prewarmFetch) await (await fetch(`${config.baseUrl}/health`)).arrayBuffer();
const diagnosticFiles = [];
let active = 0, maximumActiveChildren = 0, spawnedChildren = 0;
const track = child => {
  spawnedChildren++;
  maximumActiveChildren = Math.max(maximumActiveChildren, ++active);
  send({ event: 'child-spawn', pid: child.pid });
  child.once('close', () => { active--; send({ event: 'child-close', pid: child.pid }); });
  return child;
};
const observedSpawn = (binary, args, options) => track(spawnCompletionChild(config, binary, args, options));
const instrumentedSpawn = (binary, args, options) => {
  const file = path.join(config.directory, `time-${diagnosticFiles.length}.txt`);
  diagnosticFiles.push(file);
  return track(spawnCompletionChild(config, binary, args, options, spawn, file));
};
const native = config.backend !== 'typescript' ? new module.RustCompletion({
  binary: () => config.backend === 'python' ? config.python.executable : config.binary, directory: config.directory, clientVersion: 'provider-completion-benchmark',
  maxActive: 32, timeoutMs: 30_000,
  // /usr/bin/time is used ONLY by separate successful diagnostic runs, never latency or cancellation.
  spawn: config.diagnostic ? instrumentedSpawn : observedSpawn,
}) : undefined;
let lastPending, maximumPending = 0;
const publishPending = () => {
  const count = native?.pendingCount ?? 0;
  maximumPending = Math.max(maximumPending, count);
  if (count !== lastPending) { lastPending = count; send({ event: 'native-pending', count }); }
};
const pendingPoll = native ? setInterval(publishPending, 2) : undefined;
const provider = module.createOpenAIChatProvider({
  baseUrl: config.baseUrl, model: config.scenario,
  headers: { 'x-benchmark-run': config.runId },
  ...(native ? { completion: (...args) => {
    const done = native.complete(...args);
    publishPending();
    return done.finally(publishPending);
  } } : {}),
});
const tools = [{ name: 'lookup', description: 'Synthetic lookup', parameters: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] } }];
const history = [
  { role: 'user', text: config.scenario === 'history-2mib' ? 'h'.repeat(2 * 1024 * 1024) : 'Look up the attached sample.', images: [{ mimeType: 'image/png', data: 'c3ludGhldGlj' }] },
  { role: 'assistant', text: '', toolCalls: [{ id: 'previous', name: 'lookup', input: { zeta: 'last', query: 'sample', alpha: 'first' } }] },
  { role: 'tool', results: [{ toolCallId: 'previous', name: 'lookup', content: 'Synthetic prior result', isError: false }] },
  { role: 'user', text: 'Continue.' },
];
const invoke = async () => {
  const controller = new AbortController();
  const start = performance.now();
  const timeout = setTimeout(() => controller.abort(new Error('Benchmark request timed out.')), 30_000);
  let firstTokenMs, deltaCount = 0, abortAt;
  const deltas = createHash('sha256');
  let result, cancelled = false;
  try {
    result = await provider.complete({ system: 'Synthetic benchmark system.', messages: history, tools, signal: controller.signal,
      onText(delta) {
        firstTokenMs ??= performance.now() - start;
        const bytes = Buffer.from(delta);
        deltas.update(String(bytes.length)).update(':').update(bytes);
        deltaCount++;
        if (config.scenario === 'cancellation') { abortAt = performance.now(); controller.abort(); }
      },
    });
  } catch (error) {
    if (config.scenario !== 'cancellation' || abortAt === undefined || !controller.signal.aborted) throw error;
    cancelled = true;
  } finally {
    clearTimeout(timeout);
  }
  if (config.scenario === 'cancellation' && !cancelled) throw new Error('Cancellation resolved successfully.');
  return {
    totalMs: performance.now() - start, firstTokenMs: firstTokenMs ?? null,
    cancellationSettlementMs: abortAt === undefined ? null : performance.now() - abortAt,
    resultSha256: hash(JSON.stringify(canonical(cancelled ? { cancelled: true } : result))),
    deltaSha256: deltas.digest('hex'), deltaCount, cancelled,
  };
};
const memory = () => ({ rssKiB: process.memoryUsage().rss / 1024, heapUsedKiB: process.memoryUsage().heapUsed / 1024 });
const idleBefore = memory();
send({ phase: 'idle-before' });
await sleep(100);
send({ phase: 'warmup' });
let coldFirstRequestMs;
for (let i = 0; i < config.warmup; i++) {
  const sample = await invoke();
  coldFirstRequestMs ??= sample.totalMs;
}
const beforeCpu = process.cpuUsage();
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
eventLoop.enable();
const start = performance.now();
const samples = [];
send({ phase: 'measured' });
for (let batch = 0; batch < config.batches; batch++) {
  send({ event: 'batch-start', concurrency: config.concurrency });
  samples.push(...await Promise.all(Array.from({ length: config.concurrency }, invoke)));
  send({ event: 'batch-end' });
}
const measuredWallMs = performance.now() - start;
eventLoop.disable();
const cpu = process.cpuUsage(beforeCpu);
if (pendingPoll) clearInterval(pendingPoll);
send({ phase: 'post-work' });
const postWork = memory();
let idleResident, idleAfterTtl, activeAfterIdleTtl, idleCpu;
if (config.completionMode === 'persistent') {
  const idleCpuStart = process.cpuUsage();
  send({ phase: 'idle-resident' });
  await sleep(100);
  idleResident = memory();
  send({ phase: 'idle-wait-ttl' });
  await sleep(1100);
  idleAfterTtl = memory();
  activeAfterIdleTtl = active;
  if (active !== 0) throw new Error('Persistent child survived the default idle TTL observation window.');
  send({ phase: 'idle-after-ttl' });
  await sleep(100);
  idleCpu = process.cpuUsage(idleCpuStart);
}
await native?.close();
if (native && (native.pendingCount !== 0 || native.reservedBytes !== 0)) throw new Error('Host port retained work after close.');
send({ phase: 'post-close' });
await sleep(100);
const postClose = memory();
const usage = process.resourceUsage();
const childDiagnostics = [];
for (const file of diagnosticFiles) {
  const output = await readFile(file, 'utf8');
  if (process.platform === 'darwin') {
    const cpu = /([\d.]+) real\s+([\d.]+) user\s+([\d.]+) sys/.exec(output);
    const peak = /([\d]+)\s+maximum resident set size/.exec(output);
    if (!cpu || !peak) throw new Error('Could not parse macOS /usr/bin/time.');
    childDiagnostics.push({ userCpuMs: Number(cpu[2]) * 1000, systemCpuMs: Number(cpu[3]) * 1000, osPeakRssKiB: Number(peak[1]) / 1024 });
  } else {
    const field = name => Number(new RegExp(`${name}:\\s*([\\d.]+)`).exec(output)?.[1]);
    const entry = { userCpuMs: field('User time \\(seconds\\)') * 1000, systemCpuMs: field('System time \\(seconds\\)') * 1000, osPeakRssKiB: field('Maximum resident set size \\(kbytes\\)') };
    if (!Object.values(entry).every(Number.isFinite)) throw new Error('Could not parse Linux /usr/bin/time.');
    childDiagnostics.push(entry);
  }
}
const report = { backend: config.backend, diagnostic: config.diagnostic, importMs, coldFirstRequestMs,
  samples, warmup: config.warmup, measuredWallMs, parentCpuMs: { user: cpu.user / 1000, system: cpu.system / 1000 },
  eventLoopDelayMs: { count: eventLoop.count, p95: eventLoop.count ? eventLoop.percentile(95) / 1e6 : null, max: eventLoop.count ? eventLoop.max / 1e6 : null },
  parentOsPeakRssKiB: usage.maxRSS, idleBefore, postWork, postClose,
  parentLifetimeCpuMs: { user: usage.userCPUTime / 1000, system: usage.systemCPUTime / 1000 },
  ...(idleResident ? { idleResident, idleAfterTtl, activeAfterIdleTtl, idleObservationMs: 1300,
    parentIdleCpuMs: { user: idleCpu.user / 1000, system: idleCpu.system / 1000 } } : {}),
  pendingAfterClose: native?.pendingCount ?? 0, reservedBytesAfterClose: native?.reservedBytes ?? 0,
  spawnedChildren, maximumActiveChildren, maximumPending,
  ...(config.diagnostic ? { childDiagnostics } : {}),
};
send({ phase: 'done', report });
process.disconnect?.();

}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmarkWorker(JSON.parse(await readFile(process.argv[2], 'utf8')));
}
