#!/usr/bin/env node
/** One fresh-process scenario for native-file-read.mjs; kept separate for RSS isolation. */
import { createHash } from 'node:crypto';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

const [moduleFile, root, shape, page, rawConcurrency, rawIterations, rawWarmup] = process.argv.slice(2);
if (!moduleFile || !root || !shape || !page) throw new Error('Usage: worker <module> <fixture-root> <shape> <page> <concurrency> <iterations> <warmup>');
const concurrency = Number(rawConcurrency), iterations = Number(rawIterations), warmup = Number(rawWarmup);
const { createFileTools } = await import(pathToFileURL(moduleFile));
const read = createFileTools(root).find(tool => tool.name === 'read_file');
if (!read) throw new Error('Module did not export createFileTools with read_file.');
const file = `${shape}.txt`;
const input = page === 'first10'
  ? { path: file, offset: 1, limit: 10 }
  : shape === 'huge-line' ? { path: file, offset: 2, limit: 10 } : { path: file, offset: 20_001, limit: 10 };
const context = { signal: new AbortController().signal, emit() {}, toolCallId: 'bench' };
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const before = process.memoryUsage();
const invoke = async () => {
  const result = await read.run(input, context);
  if (!result || typeof result.output !== 'string') throw new Error('read_file returned no output text.');
  return digest(result);
};

for (let i = 0; i < warmup; i++) await invoke();
await yieldTurn();
const samples = [];
const eventLoopDelay = monitorEventLoopDelay({ resolution: 1 });
eventLoopDelay.enable();
let expected;
let completed = 0;
const worker = async () => {
  while (true) {
    const index = completed++;
    if (index >= iterations) return;
    const start = performance.now();
    const outputDigest = await invoke();
    samples.push(performance.now() - start);
    if (expected === undefined) expected = outputDigest;
    else if (expected !== outputDigest) throw new Error('read_file output changed within one scenario.');
  }
};
await Promise.all(Array.from({ length: concurrency }, worker));
eventLoopDelay.disable();
samples.sort((a, b) => a - b);
const percentile = p => samples[Math.min(samples.length - 1, Math.ceil(samples.length * p) - 1)];
const usage = process.resourceUsage();
const after = process.memoryUsage();
const delayCount = eventLoopDelay.count;
console.log(`BENCH_RESULT ${JSON.stringify({
  samples: samples.length,
  warmup,
  p50Ms: percentile(0.5),
  p95Ms: percentile(0.95),
  outputDigest: expected,
  maxRss: usage.maxRSS,
  maxRssUnit: 'KiB',
  rssBaselineBytes: before.rss,
  rssEndBytes: after.rss,
  heapUsedBaselineBytes: before.heapUsed,
  heapUsedEndBytes: after.heapUsed,
  externalBaselineBytes: before.external,
  externalEndBytes: after.external,
  eventLoopDelay: {
    count: delayCount,
    p95Ms: delayCount ? eventLoopDelay.percentile(95) / 1e6 : null,
    maxMs: delayCount ? eventLoopDelay.max / 1e6 : null,
  },
})}`);
