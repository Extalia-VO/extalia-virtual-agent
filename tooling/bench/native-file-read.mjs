#!/usr/bin/env node
/** Compare the frozen native read_file tool with the current implementation. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'apps/cli/package.json'));
const { build } = require('esbuild');
const { values } = parseArgs({ options: {
  'baseline-module': { type: 'string' },
  iterations: { type: 'string', default: '100' },
  warmup: { type: 'string', default: '5' },
  json: { type: 'boolean', default: false },
} });
const baseline = values['baseline-module'] && path.resolve(values['baseline-module']);
const iterations = Number(values.iterations), warmup = Number(values.warmup);
if (!baseline) fail('Pass --baseline-module <frozen createFileTools bundle>.');
if (!Number.isSafeInteger(iterations) || iterations < 100) fail('--iterations must be an integer >= 100.');
if (!Number.isSafeInteger(warmup) || warmup < 1) fail('--warmup must be an integer >= 1.');

function fail(message) { console.error(`native-file-read: ${message}`); process.exit(1); }
const sha256 = data => createHash('sha256').update(data).digest('hex');
function run(command, args) {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(result.stderr || `${command} exited with ${result.status}`);
  const line = result.stdout.split(/\r?\n/).find(value => value.startsWith('BENCH_RESULT '));
  if (!line) throw new Error(`Worker emitted no BENCH_RESULT. ${result.stderr}`);
  return JSON.parse(line.slice('BENCH_RESULT '.length));
}

const temp = await mkdtemp(path.join(os.tmpdir(), 'extalia-native-file-read-'));
try {
  const fixtureRoot = path.join(temp, 'fixtures');
  await mkdir(fixtureRoot);
  const bytes = 5 * 1024 * 1024;
  const ordinaryLine = `${'x'.repeat(199)}\n`;
  // Fixtures are generated before either worker starts and excluded from timings/RSS.
  await writeFile(path.join(fixtureRoot, 'newline-dense.txt'), Buffer.from('x\n'.repeat(bytes / 2)));
  await writeFile(path.join(fixtureRoot, 'ordinary-200-char-lines.txt'), Buffer.from(ordinaryLine.repeat(Math.floor(bytes / ordinaryLine.length))));
  await writeFile(path.join(fixtureRoot, 'huge-line.txt'), Buffer.from('x'.repeat(bytes)));
  const fixtureBytes = Object.fromEntries(await Promise.all(['newline-dense', 'ordinary-200-char-lines', 'huge-line'].map(async shape => [
    shape, (await stat(path.join(fixtureRoot, `${shape}.txt`))).size,
  ])));

  const candidate = path.join(temp, 'candidate-tools.mjs');
  await build({
    absWorkingDir: ROOT,
    entryPoints: ['packages/host/src/tools/files.ts'],
    outfile: candidate,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node22',
    logLevel: 'silent',
  });
  const [baselineBytes, candidateBytes, fileSource, pageSource] = await Promise.all([
    readFile(baseline), readFile(candidate),
    readFile(path.join(ROOT, 'packages/host/src/tools/files.ts')),
    readFile(path.join(ROOT, 'packages/host/src/tools/readTextPage.ts')),
  ]);
  const candidateSourceHash = createHash('sha256')
    .update('packages/host/src/tools/files.ts\0').update(fileSource)
    .update('\0packages/host/src/tools/readTextPage.ts\0').update(pageSource).digest('hex');

  const worker = path.join(ROOT, 'tooling/bench/native-file-read-worker.mjs');
  const report = {
    benchmark: 'native-file-read',
    environment: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      cpuModel: os.cpus()[0]?.model?.trim() ?? null,
      logicalCores: os.cpus().length,
      totalMemoryBytes: os.totalmem(),
    },
    provenance: {
      baselineModuleSha256: sha256(baselineBytes),
      candidateBundleSha256: sha256(candidateBytes),
      candidateSourceSha256: candidateSourceHash,
      candidateSourceFiles: ['packages/host/src/tools/files.ts', 'packages/host/src/tools/readTextPage.ts'],
    },
    fixtureBytes,
    samplesPerScenario: iterations,
    warmupPerScenario: warmup,
    concurrency: [1, 3, 8],
    // Node documents process.resourceUsage().maxRSS in KiB on supported platforms.
    rssUnit: 'KiB',
    scenarios: [],
  };
  for (const shape of ['newline-dense', 'ordinary-200-char-lines', 'huge-line']) {
    for (const page of ['first10', 'deep-page']) {
      for (const concurrency of [1, 3, 8]) {
        const args = [worker, '', fixtureRoot, shape, page, String(concurrency), String(iterations), String(warmup)];
        // Alternate process order across scenarios to limit systematic cache/order bias.
        const variants = (report.scenarios.length % 2 === 0) ? [['baseline', baseline], ['candidate', candidate]] : [['candidate', candidate], ['baseline', baseline]];
        const pair = {};
        for (const [label, moduleFile] of variants) {
          const result = run(process.execPath, ['--expose-gc', ...args.map((value, index) => index === 1 ? moduleFile : value)]);
          pair[label] = result;
        }
        if (pair.baseline.outputDigest !== pair.candidate.outputDigest) {
          throw new Error(`Output parity failed for ${shape}/${page}/concurrency=${concurrency}.`);
        }
        report.scenarios.push({ shape, page, concurrency, baseline: pair.baseline, candidate: pair.candidate, outputParity: true });
        if (!values.json) {
          const b = pair.baseline, c = pair.candidate;
          console.log(`${shape} ${page} c=${concurrency}: p50 ${b.p50Ms.toFixed(2)}→${c.p50Ms.toFixed(2)} ms; p95 ${b.p95Ms.toFixed(2)}→${c.p95Ms.toFixed(2)} ms; maxRSS ${b.maxRss}→${c.maxRss} ${report.rssUnit}`);
        }
      }
    }
  }
  if (values.json) console.log(JSON.stringify(report, null, 2));
  else console.log(`Verified identical output digests for ${report.scenarios.length} scenarios (${iterations} measured operations each).`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
