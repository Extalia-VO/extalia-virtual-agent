#!/usr/bin/env node
/**
 * Native core benchmark gate (audit PR 10, ADR 0021 decision 6): the TypeScript mission
 * journal (`missions.sqlite`, in the host process) against the Rust core daemon
 * (`extalia-daemon`, a stdio sidecar), measured on this machine with temporary data folders.
 *
 *   node tooling/bench/native-core.mjs                 full run, Markdown table on stdout
 *   node tooling/bench/native-core.mjs --json          JSON on stdout instead
 *   node tooling/bench/native-core.mjs --quick         smoke variant (small counts)
 *   node tooling/bench/native-core.mjs --iterations 5000
 *   … --out <file.json>                               also write the JSON result to a file
 *   … --daemon <binary>                               use this daemon build instead of building one
 *
 * The daemon is built like a release artifact (`cargo build --release --locked
 * -p extalia-daemon --target <host>` with symbols stripped, as `tooling/build-daemon.mjs`).
 * The host sources are bundled with esbuild into a temporary file and every scenario runs in a
 * fresh Node process (see `harness.mjs`). Only measured values are reported; a metric that
 * cannot be measured on this OS is reported as null. Not part of `pnpm check` (too slow).
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { daemonHello } from '../daemon.mjs';
import { ROOT } from '../workspace.mjs';

const { values } = parseArgs({
  options: {
    json: { type: 'boolean', default: false },
    quick: { type: 'boolean', default: false },
    iterations: { type: 'string' },
    out: { type: 'string' },
    daemon: { type: 'string' },
  },
});

const quick = values.quick;
const iterations = values.iterations ? Number(values.iterations) : quick ? 200 : 2_000;
if (!Number.isSafeInteger(iterations) || iterations < 10) fail('--iterations must be an integer >= 10.');
/** Fixed counts; `--iterations` scales the commit series, the others follow from it. */
const PARAMS = {
  iterations,
  warmup: quick ? 20 : 200,
  concurrency: [1, 3, 8],
  /** Activity events per mission in the commit series: every series samples journal depths 0–segment. */
  segment: 250,
  createIterations: Math.max(50, Math.round(iterations / 10)),
  createTasks: 4,
  burst: Math.max(100, Math.round(iterations / 2)),
  burstRepetitions: quick ? 3 : 5,
  coldRuns: quick ? 3 : 15,
  coldWarmup: quick ? 1 : 2,
  populatedMissions: quick ? 4 : 16,
  populatedHistory: quick ? 50 : 500,
  restartInFlight: quick ? [16] : [1, 16, 64],
  restartHistory: quick ? 50 : 200,
  restartRuns: quick ? 3 : 10,
  restartWarmup: 1,
  memoryCommits: Math.max(500, iterations * 2),
  memorySettleMs: quick ? 200 : 1_000,
  memoryIdleMs: quick ? 500 : 3_000,
  depthEvents: quick ? 0 : 8_000,
  depthBucket: 1_000,
};

function fail(message) { console.error(`bench: ${message}`); process.exit(1); }
const log = message => { if (!values.json || process.stderr.isTTY) console.error(message); };
const exe = name => (process.platform === 'win32' ? `${name}.exe` : name);
const output = (command, args, options = {}) => {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', ...options });
  return result.status === 0 ? result.stdout.trim() : undefined;
};

// ---------------------------------------------------------------- environment

async function environment() {
  const cpus = os.cpus();
  const env = {
    date: new Date().toISOString(),
    cpu: cpus[0]?.model?.trim() ?? null,
    logicalCores: cpus.length,
    memoryGiB: Math.round(os.totalmem() / 1024 ** 3 * 10) / 10,
    platform: `${process.platform}-${process.arch}`,
    os: osVersion(),
    node: process.version,
    rustc: output(exe('rustc'), ['--version'], { env: cargoEnv() }) ?? null,
    git: gitState(),
  };
  if (process.platform === 'darwin') {
    const perf = output('sysctl', ['-n', 'hw.perflevel0.physicalcpu']), eff = output('sysctl', ['-n', 'hw.perflevel1.physicalcpu']);
    if (perf) env.coreClusters = `${perf} performance + ${eff ?? 0} efficiency`;
    const power = output('pmset', ['-g', 'batt']);
    if (power) env.power = /AC Power/.test(power) ? 'AC' : /Battery Power/.test(power) ? 'battery' : null;
  }
  return env;
}

function osVersion() {
  if (process.platform === 'darwin') return `macOS ${output('sw_vers', ['-productVersion']) ?? '?'} (Darwin ${os.release()})`;
  if (process.platform === 'linux') {
    const pretty = output('sh', ['-c', '. /etc/os-release && printf %s "$PRETTY_NAME"']);
    return `${pretty ?? 'Linux'} (kernel ${os.release()})`;
  }
  return `${os.version?.() ?? process.platform} ${os.release()}`;
}

function gitState() {
  const sha = output('git', ['rev-parse', '--short', 'HEAD']);
  if (!sha) return null;
  // Untracked files count: a crate or harness that is not committed yet changes the build too.
  const dirty = (output('git', ['status', '--porcelain']) ?? '').length > 0;
  return { sha, dirty };
}

let toolEnv;
function cargoEnv() {
  if (toolEnv) return toolEnv;
  if (spawnSync(exe('cargo'), ['--version'], { stdio: 'ignore' }).status === 0) return (toolEnv = { ...process.env });
  const bin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin');
  toolEnv = existsSync(path.join(bin, exe('cargo'))) ? { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH ?? ''}` } : { ...process.env };
  return toolEnv;
}

// ---------------------------------------------------------------- daemon and harness builds

async function daemonBuild() {
  if (values.daemon) {
    const file = path.resolve(values.daemon);
    if (!existsSync(file)) fail(`--daemon ${values.daemon} does not exist.`);
    return { file, label: path.basename(file), built: false, triple: null };
  }
  const triple = /^host:\s*(\S+)/m.exec(output(exe('rustc'), ['-vV'], { env: cargoEnv() }) ?? '')?.[1];
  if (!triple) fail('cannot read the host target from `rustc -vV` (is the Rust toolchain installed?).');
  log(`bench: building extalia-daemon (release, stripped, ${triple})…`);
  const build = spawnSync(exe('cargo'), ['build', '--release', '--locked', '-p', 'extalia-daemon', '--target', triple],
    { cwd: ROOT, env: { ...cargoEnv(), CARGO_PROFILE_RELEASE_STRIP: 'symbols' }, stdio: ['ignore', 'ignore', 'inherit'] });
  if (build.status !== 0) fail('cargo build failed.');
  const file = path.join(ROOT, 'target', triple, 'release', exe('extalia-daemon'));
  return { file, label: path.relative(ROOT, file).split(path.sep).join('/'), built: true, triple };
}

async function bundleHarness(dir) {
  // esbuild is the CLI's bundler (apps/cli devDependency); the host sources are TypeScript.
  let esbuild;
  try { esbuild = createRequire(path.join(ROOT, 'apps', 'cli', 'package.json'))('esbuild'); } catch { fail('esbuild not found; run `pnpm install`.'); }
  const outfile = path.join(dir, 'harness.bundle.mjs');
  await esbuild.build({
    entryPoints: [path.join(ROOT, 'tooling', 'bench', 'harness.mjs')], outfile, bundle: true, platform: 'node', format: 'esm', target: 'node22',
    external: ['@extalia/daemon-*'], logLevel: 'warning',
    banner: { js: "import { createRequire as __benchRequire } from 'node:module'; const require = __benchRequire(import.meta.url);" },
  });
  return outfile;
}

// ---------------------------------------------------------------- scenario runner

let harness, binary;
function scenario(name, backend, params = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--expose-gc', harness, name, JSON.stringify({ backend, binary, ...params })], { cwd: os.tmpdir(), stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    child.once('error', reject);
    child.once('close', (code, signal) => {
      const line = stdout.split('\n').find(text => text.startsWith('BENCH_RESULT '));
      if (line && (code === 0 || name === 'restartSetup' && signal === 'SIGKILL')) resolve(JSON.parse(line.slice('BENCH_RESULT '.length)));
      else reject(new Error(`${name}/${backend} failed (code ${code}, signal ${signal}): ${stderr.trim()}`));
    });
  });
}

// ---------------------------------------------------------------- statistics

const round = (value, digits = 3) => value === null || value === undefined || Number.isNaN(value) ? null : Math.round(value * 10 ** digits) / 10 ** digits;
/** Nearest-rank percentiles; all in milliseconds. */
function summary(samples) {
  const sorted = [...samples].sort((a, b) => a - b);
  const pick = p => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p / 100 * sorted.length) - 1))];
  return { n: sorted.length, min: round(sorted[0]), p50: round(pick(50)), p95: round(pick(95)), p99: round(pick(99)), max: round(sorted.at(-1)), mean: round(sorted.reduce((a, b) => a + b, 0) / sorted.length) };
}

// ---------------------------------------------------------------- measurements

async function measure(backend) {
  const result = { commit: {}, commitThroughput: {} };
  for (const concurrency of PARAMS.concurrency) {
    log(`bench: ${backend} commit latency, ${concurrency} mission(s)…`);
    const series = await scenario('commitSeries', backend, { iterations: PARAMS.iterations, warmup: PARAMS.warmup, concurrency, segment: PARAMS.segment });
    result.commit[concurrency] = summary(series.latencies);
    result.commitCall ??= {};
    result.commitCall[concurrency] = summary(series.callLatencies);
    result.commitThroughput[concurrency] = round(series.commits / (series.wallMs / 1000), 1);
  }
  log(`bench: ${backend} mission create…`);
  result.create = summary((await scenario('createSeries', backend, { iterations: PARAMS.createIterations, warmup: PARAMS.warmup, tasks: PARAMS.createTasks })).latencies);
  log(`bench: ${backend} burst…`);
  const { bursts } = await scenario('burstSeries', backend, { burst: PARAMS.burst, repetitions: PARAMS.burstRepetitions, warmup: PARAMS.warmup });
  const rates = bursts.map(item => item.commits / (item.wallMs / 1000));
  result.burst = { commits: PARAMS.burst, repetitions: bursts.length, commitsPerSecond: { min: round(Math.min(...rates), 1), median: round(rates.sort((a, b) => a - b)[Math.floor((rates.length - 1) / 2)], 1), max: round(Math.max(...rates), 1) } };
  if (PARAMS.depthEvents) {
    log(`bench: ${backend} latency vs journal depth…`);
    const { buckets } = await scenario('depthSeries', backend, { events: PARAMS.depthEvents, bucket: PARAMS.depthBucket });
    result.depth = buckets.map(item => ({ from: item.from, to: item.to, ...summary(item.latencies) }));
  }
  log(`bench: ${backend} cold start…`);
  result.coldStart = { fresh: await coldStart(backend, undefined) };
  const populated = await mkdtemp(path.join(os.tmpdir(), `extalia-bench-${backend}-populated-`));
  try {
    await scenario('populate', backend, { dir: populated, missions: PARAMS.populatedMissions, history: PARAMS.populatedHistory });
    result.coldStart.populated = { missions: PARAMS.populatedMissions, eventsPerMission: PARAMS.populatedHistory, ...await coldStart(backend, populated) };
  } finally { await rm(populated, { recursive: true, force: true }); }
  result.restart = {};
  for (const inFlight of PARAMS.restartInFlight) {
    log(`bench: ${backend} restart recovery, ${inFlight} in-flight task(s)…`);
    result.restart[inFlight] = await restartRecovery(backend, inFlight);
  }
  log(`bench: ${backend} memory…`);
  result.memory = await scenario('memory', backend, { commits: PARAMS.memoryCommits, settleMs: PARAMS.memorySettleMs, idleMs: PARAMS.memoryIdleMs });
  return result;
}

/** TS: one fresh process per sample (the store opens once per host process); Rust: one daemon per sample. */
async function coldStart(backend, populated) {
  if (backend === 'rust') return summary((await scenario('coldStart', 'rust', { runs: PARAMS.coldRuns, warmup: PARAMS.coldWarmup, ...(populated ? { existing: populated } : {}) })).samples);
  const samples = [];
  for (let i = 0; i < PARAMS.coldWarmup + PARAMS.coldRuns; i++) {
    const copy = populated ? await copyDir(populated, 'ts-cold-run') : undefined;
    try {
      const { ms } = await scenario('coldStart', 'typescript', copy ? { existing: copy } : {});
      if (i >= PARAMS.coldWarmup) samples.push(ms);
    } finally { if (copy) await rm(copy, { recursive: true, force: true }); }
  }
  return summary(samples);
}

async function copyDir(source, prefix) {
  const target = await mkdtemp(path.join(os.tmpdir(), `extalia-bench-${prefix}-`));
  await cp(source, target, { recursive: true });
  return target;
}

async function restartRecovery(backend, inFlight) {
  const setup = await mkdtemp(path.join(os.tmpdir(), `extalia-bench-${backend}-crashed-`));
  try {
    const crashed = await scenario('restartSetup', backend, { dir: setup, inFlight, history: PARAMS.restartHistory });
    const shape = { inFlight, missions: crashed.missions, eventsPerMission: PARAMS.restartHistory };
    if (backend === 'rust') {
      const { samples } = await scenario('restart', 'rust', { setup, inFlight, runs: PARAMS.restartRuns, warmup: PARAMS.restartWarmup });
      return { ...shape, ...summary(samples) };
    }
    const samples = [];
    for (let i = 0; i < PARAMS.restartWarmup + PARAMS.restartRuns; i++) {
      const copy = await copyDir(setup, 'ts-restart-run');
      try {
        const { ms } = await scenario('restart', 'typescript', { setup: copy, inFlight, sessions: crashed.sessions });
        if (i >= PARAMS.restartWarmup) samples.push(ms);
      } finally { await rm(copy, { recursive: true, force: true }); }
    }
    return { ...shape, ...summary(samples) };
  } finally { await rm(setup, { recursive: true, force: true }); }
}

// ---------------------------------------------------------------- report

const fmt = (value, unit = '') => value === null || value === undefined ? 'n/a' : `${value}${unit}`;
const ratio = (ts, rust) => ts && rust ? `${round(rust / ts, 2)}×` : 'n/a';

function markdown(report) {
  const { typescript: ts, rust } = report.results;
  const rows = [];
  const row = (metric, a, b, r = ratio(a, b), unit = ' ms') => rows.push(`| ${metric} | ${fmt(a, unit)} | ${fmt(b, unit)} | ${r} |`);
  for (const c of report.params.concurrency) {
    for (const p of ['p50', 'p95', 'p99']) row(`Event commit ${p}, ${c} mission${c > 1 ? 's' : ''} concurrent`, ts.commit[c][p], rust.commit[c][p]);
    // TypeScript commits run synchronously on the host thread; the daemon client only encodes and writes (not timed separately).
    if (c > 1) for (const p of ['p50', 'p95']) rows.push(`| Host thread blocked per commit ${p}, ${c} missions | ${fmt(ts.commitCall[c][p], ' ms')} | n/a (async request) | — |`);
    row(`Event commit throughput, ${c} mission${c > 1 ? 's' : ''} (commits/s)`, ts.commitThroughput[c], rust.commitThroughput[c], ratio(ts.commitThroughput[c], rust.commitThroughput[c]), '');
  }
  for (const p of ['p50', 'p95', 'p99']) row(`Mission create (${report.params.createTasks} tasks) ${p}`, ts.create[p], rust.create[p]);
  row(`Burst of ${ts.burst.commits} commits, median (commits/s)`, ts.burst.commitsPerSecond.median, rust.burst.commitsPerSecond.median, ratio(ts.burst.commitsPerSecond.median, rust.burst.commitsPerSecond.median), '');
  for (const p of ['p50', 'p95']) row(`Cold start, empty data folder ${p}`, ts.coldStart.fresh[p], rust.coldStart.fresh[p]);
  for (const p of ['p50', 'p95']) row(`Cold start, ${ts.coldStart.populated.missions} missions × ${ts.coldStart.populated.eventsPerMission} events ${p}`, ts.coldStart.populated[p], rust.coldStart.populated[p]);
  for (const k of report.params.restartInFlight) for (const p of ['p50', 'p95']) row(`Restart recovery, ${k} in-flight task${k > 1 ? 's' : ''} ${p}`, ts.restart[k][p], rust.restart[k][p]);
  const d = rust.memory.daemon;
  rows.push(`| Daemon idle RSS | — | ${fmt(d && round(d.idleRssKiB / 1024, 1), ' MiB')} | — |`);
  rows.push(`| Daemon RSS after ${rust.memory.commits} commits | — | ${fmt(d && round(d.afterCommitsRssKiB / 1024, 1), ' MiB')} | — |`);
  rows.push(`| Daemon CPU time while idle (${d ? d.idleWindowMs / 1000 : '?'} s window, 10 ms resolution) | — | ${fmt(d && round(d.idleCpuSeconds * 1000, 0), ' ms')} | — |`);
  rows.push(`| Host Node RSS Δ after open | ${fmt(round(ts.memory.hostOpen.rssKiB / 1024, 1), ' MiB')} | ${fmt(round(rust.memory.hostOpen.rssKiB / 1024, 1), ' MiB')} | — |`);
  rows.push(`| Host Node RSS Δ after ${ts.memory.commits} commits | ${fmt(round(ts.memory.hostAfterCommits.rssKiB / 1024, 1), ' MiB')} | ${fmt(round(rust.memory.hostAfterCommits.rssKiB / 1024, 1), ' MiB')} | — |`);
  rows.push(`| Host Node heapUsed Δ after ${ts.memory.commits} commits | ${fmt(round(ts.memory.hostAfterCommits.heapUsedKiB / 1024, 2), ' MiB')} | ${fmt(round(rust.memory.hostAfterCommits.heapUsedKiB / 1024, 2), ' MiB')} | — |`);
  rows.push(`| Binary size (stripped release) | — (built into Node) | ${fmt(round(report.daemon.bytes / 1024 / 1024, 2), ' MiB')} | — |`);
  const env = report.environment;
  const lines = [
    `Measured ${env.date} · ${env.cpu} (${env.logicalCores} logical cores${env.coreClusters ? `, ${env.coreClusters}` : ''}), ${env.memoryGiB} GiB RAM${env.power ? `, ${env.power} power` : ''} · ${env.os} · Node ${env.node} · ${env.rustc ?? 'rustc n/a'} · git ${env.git ? `${env.git.sha}${env.git.dirty ? ' (dirty)' : ''}` : 'n/a'} · daemon ${report.daemon.label} (${report.daemon.bytes} bytes, sha256 ${report.daemon.sha256.slice(0, 12)}…, daemonVersion ${report.daemon.version})`,
    `Mode ${report.mode}: ${report.params.iterations} commits per series after ${report.params.warmup} warm-up commits, at most ${report.params.segment} activity events per mission. Commit latency = issue → acknowledgement, including the wait behind other missions' commits. Ratio = Rust / TypeScript (below 1× means the daemon is lower).`,
    '',
    '| Metric | TypeScript core | Rust daemon | Ratio |',
    '| --- | ---: | ---: | ---: |',
    ...rows,
  ];
  if (ts.depth && rust.depth) {
    lines.push('', '| Journal depth (events in the mission) | TypeScript p50 / p95 | Rust p50 / p95 |', '| --- | ---: | ---: |');
    ts.depth.forEach((bucket, i) => lines.push(`| ${bucket.from}–${bucket.to} | ${bucket.p50} / ${bucket.p95} ms | ${rust.depth[i].p50} / ${rust.depth[i].p95} ms |`));
  }
  return lines.join('\n');
}

const started = Date.now();
const work = await mkdtemp(path.join(os.tmpdir(), 'extalia-bench-'));
try {
  const daemon = await daemonBuild();
  binary = daemon.file;
  const bytes = (await stat(binary)).size;
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  const hello = await daemonHello(binary).catch(error => fail(`daemon hello failed: ${error.message}`));
  harness = await bundleHarness(work);
  const report = {
    schema: 'extalia.bench.native-core.v1',
    mode: quick ? 'quick' : 'full',
    params: PARAMS,
    environment: await environment(),
    daemon: { label: daemon.label, target: daemon.triple, bytes, sha256, version: hello.daemonVersion, strip: daemon.built ? 'symbols' : 'unknown (prebuilt)' },
    results: { typescript: await measure('typescript'), rust: await measure('rust') },
  };
  report.elapsedSeconds = round((Date.now() - started) / 1000, 1);
  if (values.out) await writeFile(path.resolve(values.out), `${JSON.stringify(report, null, 2)}\n`);
  if (values.json) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  else process.stdout.write(`${markdown(report)}\n\nElapsed: ${report.elapsedSeconds} s\n`);
} finally {
  await rm(work, { recursive: true, force: true });
}
