#!/usr/bin/env node
/** Real loopback parity/efficiency benchmark. No provider credentials or user profile are used. */
import { execFile, execFileSync, fork } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const { values } = parseArgs({ options: { binary: { type: 'string' }, python: { type: 'string' }, json: { type: 'boolean' }, quick: { type: 'boolean' }, output: { type: 'string' }, mode: { type: 'string', default: 'persistent' } } });
if (!['persistent', 'one-shot', 'python'].includes(values.mode)) throw new Error('--mode must be persistent, one-shot or python.');
if (values.python && values.mode !== 'python') throw new Error('--python requires --mode python.');
const candidateBackend = values.mode === 'python' ? 'python' : 'rust';
const persistent = values.mode !== 'one-shot';
const pythonScript = 'tooling/bench/python/provider_worker.py';
if (!['darwin', 'linux'].includes(process.platform)) throw new Error('Process-tree measurement currently requires macOS or Linux.');
const binary = path.resolve(values.binary ?? path.join(ROOT, 'target/release/extalia-daemon'));
if (candidateBackend === 'rust' && binary.split(path.sep).includes('debug')) throw new Error('Use a release Rust binary; debug performance is not evidence.');
const baseline = path.join(ROOT, 'tooling/bench/fixtures/openai-ts-v242.mjs');
const require = createRequire(path.join(ROOT, 'apps/cli/package.json'));
const { build, version: esbuildVersion } = require('esbuild');
const execAsync = promisify(execFile);
const sha = value => createHash('sha256').update(value).digest('hex');
const canonical = value => value && typeof value === 'object'
  ? Array.isArray(value) ? value.map(canonical) : Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const percentile = (values, p) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * p) - 1] : null;
const summary = values => ({ p50: percentile(values, 0.5), p95: percentile(values, 0.95) });
let python;
if (candidateBackend === 'python') {
  const selected = values.python ?? 'python3';
  const probeEnv = {};
  for (const key of ['PATH', 'SystemRoot', 'windir', 'TMPDIR', 'TEMP', 'TMP']) if (process.env[key]) probeEnv[key] = process.env[key];
  const probe = JSON.parse(execFileSync(selected, ['-I', '-B', '-S', '-c', 'import json,platform,sys; print(json.dumps({"executable":sys.executable,"version":platform.python_version(),"implementation":platform.python_implementation()}))'], { encoding: 'utf8', env: probeEnv }));
  const executable = await realpath(probe.executable);
  python = { executable, version: probe.version, implementation: probe.implementation };
  const relative = path.relative(ROOT, executable).split(path.sep).join('/');
  const bundled = /^(apps\/desktop\/build-resources\/skillspector\/[^/]+)\/payload\/(.+)$/.exec(relative);
  if (bundled) {
    const pinFile = 'tooling/python-bundle/runtime-pins.json';
    const pinBytes = await readFile(path.join(ROOT, pinFile));
    const manifestBytes = await readFile(path.join(ROOT, bundled[1], 'bundle-manifest.json'));
    const manifest = JSON.parse(manifestBytes);
    const asset = JSON.parse(pinBytes).assets.find(asset => asset.runtime_version === probe.version
      && asset.target.os === manifest.target.os && asset.target.arch === manifest.target.arch);
    const inventory = manifest.files.find(file => file.path === bundled[2]);
    if (!asset || manifest.runtime_version !== probe.version || inventory?.sha256 !== sha(await readFile(executable))) throw new Error('Selected bundled interpreter does not match its manifest and source pin.');
    python.sourcePin = { pinFile, pinFileSha256: sha(pinBytes), bundleManifestSha256: sha(manifestBytes),
      asset: { target: asset.target, runtimeVersion: asset.runtime_version, release: asset.release, name: asset.name, archiveSha256: asset.sha256 },
      executableMatchesManifest: true, verificationScope: 'Interpreter file hash only; the complete bundle inventory is not reverified by this benchmark.' };
  }
}
const temp = await mkdtemp(path.join(os.tmpdir(), 'extalia-provider-completion-'));
let server;
const runs = new Map();
const sse = chunk => `data: ${JSON.stringify(chunk)}\n\n`;
const event = content => sse({ id: 'synthetic-completion', object: 'chat.completion.chunk', created: 1, model: 'synthetic-model', choices: [{ index: 0, delta: { content }, finish_reason: null }] });
const final = sse({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 10 } } }) + 'data: [DONE]\n\n';
try {
  const fixtures = {
    small: [event('Hello '), event('世界🙂'), final],
    'history-2mib': [event('Hello '), event('世界🙂'), final],
    'dense-sse-8kib': [...Array.from({ length: 512 }, () => event('δ'.repeat(4096))), final],
    'dense-sse-tokens': [...Array.from({ length: 8192 }, () => event('a normal streamed text fragment. '.repeat(2))), final],
    tools: [event('Tools:'), sse({ choices: [{ delta: { tool_calls: [
      { index: 1, function: { name: 'broken', arguments: '{invalid' } },
      { index: 0, id: 'good', function: { name: 'look', arguments: '{"query":' } },
    ] } }] }), sse({ choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'up', arguments: '"sample"}' } }] }, finish_reason: 'tool_calls' }] }), final],
    concurrent: [event('Hello '), event('世界🙂'), final],
    'concurrent-delayed': [event('Hello '), event('世界🙂'), final],
    cancellation: [event('cancel-me')],
  };
  const fixtureBuffers = Object.fromEntries(Object.entries(fixtures).map(([name, chunks]) => [name, Buffer.from(chunks.join(''))]));
  await mkdir(path.join(temp, 'fixtures'));
  for (const [name, chunks] of Object.entries(fixtures)) await writeFile(path.join(temp, 'fixtures', `${name}.sse`), chunks.join(''));
  // Fixtures are fully allocated outside both measured process trees.
  server = createServer(async (request, response) => {
    try {
      if (request.url === '/v1/health') { response.writeHead(200).end('ok'); return; }
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const raw = Buffer.concat(chunks);
      const body = JSON.parse(raw);
      const run = runs.get(request.headers['x-benchmark-run']);
      if (!run || request.url !== '/v1/chat/completions' || !fixtures[body.model]) { response.writeHead(400).end(); return; }
      const { stream_options: _negotiation, ...semantic } = body;
      run.requestHashes.push(sha(JSON.stringify(canonical(semantic))));
      run.requestBytes.push(raw.length);
      run.connections.add(request.socket);
      response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
      if (body.model === 'concurrent-delayed') await sleep(200);
      if (body.model === 'cancellation') {
        response.write(fixtures.cancellation[0]);
        const timeout = setTimeout(() => response.end(final), 5000);
        response.once('close', () => { clearTimeout(timeout); run.closedStreams++; });
        return;
      }
      response.end(fixtureBuffers[body.model]);
    } catch { if (!response.destroyed) response.writeHead(500).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
  const candidate = path.join(temp, 'candidate.mjs');
  const portSource = persistent ? 'packages/host/src/daemon/completionWorker.ts' : 'packages/host/src/daemon/completion.ts';
  const portClass = persistent ? 'RustCompletionWorker' : 'RustCompletion';
  const built = await build({ absWorkingDir: ROOT,
    stdin: { contents: `export { ${portClass} as RustCompletion } from './${portSource}';\nexport { createOpenAIChatProvider } from './packages/runtime/src/providers/openai.ts';`, resolveDir: ROOT },
    outfile: candidate, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent', metafile: true,
  });
  const sourceFiles = Object.keys(built.metafile.inputs).filter(file => file !== '<stdin>')
    .map(file => path.relative(ROOT, path.resolve(ROOT, file))).sort();
  if (sourceFiles.some(file => file.startsWith(`..${path.sep}`) || path.isAbsolute(file))) throw new Error('Candidate source provenance must stay repository-relative.');
  const sourcesHash = createHash('sha256');
  for (const file of sourceFiles) sourcesHash.update(file).update('\0').update(await readFile(path.join(ROOT, file))).update('\0');
  // The daemon intentionally has no --version mode. Bind the artifact hash to its build-source version instead.
  const rustSourceVersion = /^version\s*=\s*"([^"]+)"/m.exec(await readFile(path.join(ROOT, 'Cargo.toml'), 'utf8'))?.[1];
  const report = {
    benchmark: 'provider-completion', recordedAt: new Date().toISOString(), mode: values.quick ? 'quick-smoke' : 'full', completionMode: values.mode,
    environment: { node: process.version, v8: process.versions.v8, openssl: process.versions.openssl, esbuild: esbuildVersion,
      platform: process.platform, release: os.release(), arch: process.arch,
      cpu: os.cpus()[0]?.model, logicalCores: os.cpus().length, totalMemoryBytes: os.totalmem() },
    provenance: { baseline: JSON.parse(await readFile(path.join(ROOT, 'tooling/bench/fixtures/openai-ts-v242.json'), 'utf8')),
      baselineBundleSha256: sha(await readFile(baseline)), candidateBundleSha256: sha(await readFile(candidate)),
      candidateSourceSha256: sourcesHash.digest('hex'), candidateSourceFiles: sourceFiles,
      ...(python ? { python: { executable: path.basename(python.executable), flags: ['-I', '-B', '-u'], version: python.version, implementation: python.implementation,
        executableSha256: sha(await readFile(python.executable)), script: pythonScript, scriptSha256: sha(await readFile(path.join(ROOT, pythonScript))),
        dependencies: 'Python standard library only; asyncio HTTP/SSE benchmark prototype.', ...(python.sourcePin ? { sourcePin: python.sourcePin } : {}) } }
        : { releaseBinarySha256: sha(await readFile(binary)), rustSourceVersion, binaryVersionSelfReported: false, rustc: execFileSync('rustc', ['--version'], { encoding: 'utf8' }).trim() }),
      candidatePort: portSource, candidateClass: portClass,
      candidateSelection: 'Explicit host-port injection into the real OpenAI adapter; production-default selection is a separate decision informed by this comparison.',
      harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))), workerSha256: sha(await readFile(path.join(ROOT, 'tooling/bench/provider-completion-worker.mjs'))) },
    methodology: { warmup: values.quick ? 1 : 2, smallSamples: values.quick ? 2 : 20, heavyBatches: values.quick ? 2 : 5,
      serverExcluded: true, sampledTreeIncludesNodeParent: true, targetSamplingIntervalMs: 5,
      nativePendingPollIntervalMs: 2,
      candidateBackend,
      processScope: 'The entire measured Node provider harness plus its native descendants, using the actual production port. This is not the Electron Desktop, 3D Office, or whole Extalia application RSS.',
      networkControls: ['isolated-provider: no prior global fetch in either Node parent', 'shared-fetch-prewarmed: both Node parents fetch an unmeasured loopback health response before idle/warmup; controls for a host that already loaded shared HTTP machinery'],
      fixtureTransport: 'Prebuilt body buffers contain distinct SSE events; HTTP/TCP decides network chunk boundaries. Concurrent-delayed waits 200 ms before tokens to observe eight overlapping provider requests. Cancellation remains open until abort. Other fixtures have no artificial response delay.',
      primaryChildSpawn: python
        ? 'The real RustCompletionWorker transport injects a pass-through spawn of the selected Python interpreter with argv: -I, -B, -u, repository worker script, --provider-worker, worker UUID. It retains the port credential-free environment, original child and actual kill/close events. No shell or wrapper; interpreter startup is included in cold latency.'
        : 'Pass-through observer calls native spawn with the same binary, arguments and production options, reports PID/lifetime only, and returns the original child. No wrapper. Every native startup/close is included in latency.',
      primaryRssSampling: 'Targeted ps queries the Node PID and live native PIDs reported by the pass-through observer; separate instrumented diagnostics discover the wrapper descendants with ps process-tree scanning.',
      childOsDiagnostics: 'Separate successful runs wrap each native child in /usr/bin/time. These timings are excluded from latency and primary tree RSS.',
      nativeLifecycle: persistent ? 'One persistent isolated candidate worker per provider run, multiplexing independently owned requests; default 1000 ms idle TTL. Measured warm requests share the worker after two warmups; cold-first request includes startup. Idle retention and actual TTL close are observed before explicit close.' : 'One native child per completion; each request includes child startup and actual close.',
      ...(python ? { candidateScope: 'One development-only Python stdlib asyncio completion prototype behind the existing TypeScript host transport. This comparison does not measure all Python designs or whole-application backends.' } : {}),
      childDiagnosticCpuResolutionMs: 10,
      sampledChildCpuResolutionMs: process.platform === 'darwin' ? 10 : 1000,
      limitations: [...(python ? ['The Python prototype assumes a host that drains stdout. A nonreading host with a full stdout pipe can block shutdown until the supervising parent kills the child; these fixtures do not exercise that condition. This is not production-readiness evidence.'] : []), 'Synthetic non-TLS loopback fixtures omit real network/provider latency, TLS, authentication, application UI and the rest of the host.',
        'Tree RSS is an observed concurrent sum, never a sum of independent process peaks; ps sampling can miss short child lifetimes and brief peaks.',
        'Polling adds observer load. Actual sampling gaps are reported. Primary child CPU from ps is a quantized lower bound; exact OS child CPU/peak come from separate successful diagnostics.',
        'Cancellation diagnostics intentionally have no time wrapper: native child peak RSS/CPU on a killed short-lived child may be unobserved.',
        'Parent CPU includes identical result/delta hashing in both variants; per-request total latency stops before final result hashing.',
        'OS process RSS includes shared pages; process-tree sum is RSS accounting, not unique physical memory.',
        '/usr/bin/time CPU is rounded to 0.01 s. A zero diagnostic CPU value means below measurement sensitivity, not zero CPU use; primary child CPU is not an exact total.'] },
    fixtureBytes: Object.fromEntries(Object.entries(fixtures).map(([key, chunks]) => [key, Buffer.byteLength(chunks.join(''))])), scenarios: [],
  };

  async function runWorker(backend, scenario, diagnostic = false, prewarmFetch = false) {
    const runId = `${backend}-${scenario}-${prewarmFetch ? 'shared-fetch' : 'isolated'}-${diagnostic ? 'diagnostic' : 'primary'}`;
    const observations = { requestHashes: [], requestBytes: [], connections: new Set(), closedStreams: 0 };
    runs.set(runId, observations);
    const directory = path.join(temp, runId);
    await mkdir(directory);
    const concurrency = scenario.startsWith('concurrent') ? 8 : 1;
    const heavy = !['small', 'tools'].includes(scenario);
    const config = { backend, scenario, runId, directory, baseUrl, diagnostic, binary, prewarmFetch, completionMode: persistent ? 'persistent' : 'one-shot',
      ...(python ? { python: { executable: python.executable, script: path.join(ROOT, pythonScript) } } : {}),
      module: backend === candidateBackend ? candidate : baseline, concurrency,
      warmup: diagnostic ? 0 : values.quick ? 1 : 2,
      batches: values.quick ? 2 : heavy ? 5 : 20 };
    const configPath = path.join(directory, 'config.json');
    await writeFile(configPath, JSON.stringify(config));
    const started = performance.now();
    const child = fork(path.join(ROOT, 'tooling/bench/provider-completion-worker.mjs'), [configPath], { silent: true });
    let stderr = '', phase = 'startup', result, stopped = false, lastSample, inFlight = 0, nativePending = 0;
    const livePids = new Set([child.pid]);
    const points = [], processes = new Map();
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('message', message => {
      if (message.phase) phase = message.phase;
      if (message.report) result = message.report;
      if (message.event === 'child-spawn' && message.pid) livePids.add(message.pid);
      if (message.event === 'child-close') livePids.delete(message.pid);
      if (message.event === 'batch-start') inFlight = message.concurrency;
      if (message.event === 'batch-end') inFlight = 0;
      if (message.event === 'native-pending') nativePending = message.count;
    });
    const exit = new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', code => {
        stopped = true;
        if (code === 0) resolve();
        else reject(new Error(`${runId}: worker exited ${code}: ${stderr}`));
      });
    });
    const monitor = (async () => {
      while (!stopped) {
        const sampleStart = performance.now();
        const queriedPids = new Set(livePids);
        let stdout;
        try {
          const reading = await execAsync('ps', diagnostic ? ['-axo', 'pid=,ppid=,rss=,time=']
            : ['-o', 'pid=,ppid=,rss=,time=', '-p', [...queriedPids].join(',')], { maxBuffer: 8 * 1024 * 1024 });
          stdout = reading.stdout;
        } catch (error) { if (stopped) break; throw error; }
        const rows = stdout.trim().split('\n').map(line => {
          const [pid, ppid, rss, rawCpu] = line.trim().split(/\s+/);
          const cpu = rawCpu?.split(':').map(Number).reduce((total, part) => total * 60 + part, 0) * 1000;
          return { pid: Number(pid), ppid: Number(ppid), rssKiB: Number(rss), cpuMs: cpu };
        });
        const included = diagnostic ? new Set([child.pid]) : queriedPids;
        for (let pass = 0; pass < rows.length; pass++) {
          let changed = false;
          for (const row of rows) if (included.has(row.ppid) && !included.has(row.pid)) { included.add(row.pid); changed = true; }
          if (!changed) break;
        }
        const members = rows.filter(row => included.has(row.pid));
        let rssKiB = 0;
        for (const row of members) {
          const previous = processes.get(row.pid) ?? { role: row.pid === child.pid ? 'node-host' : 'native-descendant', index: processes.size, sampledPeakRssKiB: 0, sampledCpuMs: 0, measuredCpuLowerBoundMs: 0 };
          previous.sampledPeakRssKiB = Math.max(previous.sampledPeakRssKiB, row.rssKiB);
          previous.sampledCpuMs = Math.max(previous.sampledCpuMs, row.cpuMs);
          if (phase === 'measured') {
            previous.firstMeasuredCpuMs ??= row.cpuMs;
            previous.measuredCpuLowerBoundMs = Math.max(previous.measuredCpuLowerBoundMs, row.cpuMs - previous.firstMeasuredCpuMs);
          }
          processes.set(row.pid, previous);
          rssKiB += row.rssKiB;
        }
        points.push({ phase, inFlight, nativePending, rssKiB, processCount: members.length, gapMs: lastSample === undefined ? null : sampleStart - lastSample });
        lastSample = sampleStart;
        await sleep(Math.max(0, 5 - (performance.now() - sampleStart)));
      }
    })();
    try { await exit; } finally { stopped = true; await monitor; }
    if (!result) throw new Error(`${runId}: no result: ${stderr}`);
    const all = result.samples;
    const uniqueResults = [...new Set(all.map(sample => sample.resultSha256))];
    const uniqueDeltas = [...new Set(all.map(sample => sample.deltaSha256))];
    if (uniqueResults.length !== 1 || uniqueDeltas.length !== 1) throw new Error(`${runId}: nondeterministic output.`);
    const expected = config.warmup + config.batches * concurrency;
    if (observations.requestHashes.length !== expected) throw new Error(`${runId}: observed ${observations.requestHashes.length} HTTP requests; expected ${expected}.`);
    if (scenario === 'cancellation' && observations.closedStreams !== expected) throw new Error(`${runId}: cancelled HTTP streams did not all close.`);
    const expectedChildren = persistent ? 1 : expected;
    if (backend === candidateBackend && result.spawnedChildren !== expectedChildren) throw new Error(`${runId}: native child count did not match expected lifecycle.`);
    const expectedActiveProcesses = backend === candidateBackend ? persistent ? 2 : concurrency + 1 : 1;
    const fullyActive = points.filter(p => p.phase === 'measured' && p.inFlight === concurrency
      && (backend !== candidateBackend || p.nativePending === concurrency) && p.processCount === expectedActiveProcesses);
    if (!diagnostic && scenario === 'concurrent-delayed' && fullyActive.length < 5) throw new Error(`${runId}: insufficient samples with all eight requests and expected processes active.`);
    const tree = { sampledPeakConcurrentRssKiB: Math.max(0, ...points.map(point => point.rssKiB)),
      maxObservedConcurrentProcesses: Math.max(0, ...points.map(point => point.processCount)),
      observedProcessCount: processes.size,
      allRequestsActiveConcurrentRssKiB: { sampleCount: fullyActive.length,
        requiredInFlightRequests: concurrency, requiredNativePending: backend === candidateBackend ? concurrency : null, expectedProcessCount: expectedActiveProcesses,
        ...summary(fullyActive.map(p => p.rssKiB)), max: fullyActive.length ? Math.max(...fullyActive.map(p => p.rssKiB)) : null },
      maximumNativePendingObserved: Math.max(0, ...points.map(p => p.nativePending)),
      measuredChildCpuLowerBoundMs: [...processes.values()].filter(p => p.role !== 'node-host').reduce((sum, p) => sum + p.measuredCpuLowerBoundMs, 0),
      sampleCount: points.length, actualSamplingGapMs: { ...summary(points.map(p => p.gapMs).filter(v => v !== null)), max: Math.max(0, ...points.map(p => p.gapMs ?? 0)) },
      phaseRssKiB: Object.fromEntries(['idle-before', 'measured', 'post-work', 'idle-resident', 'idle-after-ttl', 'post-close'].map(name => {
        const values = points.filter(p => p.phase === name).map(p => p.rssKiB);
        return [name, { ...summary(values), max: values.length ? Math.max(...values) : null }];
      })),
      perProcess: [...processes.values()],
    };
    return { ...result, workerLifetimeMs: performance.now() - started,
      totalLatencyMs: summary(all.map(s => s.totalMs)), firstTokenLatencyMs: summary(all.map(s => s.firstTokenMs).filter(v => v !== null)),
      cancellationSettlementMs: summary(all.map(s => s.cancellationSettlementMs).filter(v => v !== null)),
      resultSha256: uniqueResults[0], deltaSha256: uniqueDeltas[0], deltaCount: all[0].deltaCount,
      server: { requestCount: observations.requestHashes.length, requestSha256: [...new Set(observations.requestHashes)],
        requestBytes: summary(observations.requestBytes), observedHttpConnections: observations.connections.size, closedStreams: observations.closedStreams }, tree };
  }

  const cases = [
    ...Object.keys(fixtures).map(name => ({ name, prewarmFetch: false })),
    ...['small', 'history-2mib', 'dense-sse-8kib', 'dense-sse-tokens', 'concurrent', 'concurrent-delayed'].map(name => ({ name, prewarmFetch: true })),
  ];
  for (const { name: scenario, prewarmFetch } of cases) {
    const variants = report.scenarios.length % 2 ? [candidateBackend, 'typescript'] : ['typescript', candidateBackend];
    const pair = {};
    for (const backend of variants) pair[backend] = await runWorker(backend, scenario, false, prewarmFetch);
    const parity = pair.typescript.resultSha256 === pair[candidateBackend].resultSha256 && pair.typescript.deltaSha256 === pair[candidateBackend].deltaSha256
      && JSON.stringify(pair.typescript.server.requestSha256) === JSON.stringify(pair[candidateBackend].server.requestSha256);
    if (!parity) throw new Error(`${scenario}: semantic request/result/delta parity failed. ${JSON.stringify({ typescript: { result: pair.typescript.resultSha256, delta: pair.typescript.deltaSha256, requests: pair.typescript.server.requestSha256 }, [candidateBackend]: { result: pair[candidateBackend].resultSha256, delta: pair[candidateBackend].deltaSha256, requests: pair[candidateBackend].server.requestSha256 } })}`);
    if (scenario !== 'cancellation') pair[`${candidateBackend}ChildOsDiagnostics`] = await runWorker(candidateBackend, scenario, true, prewarmFetch);
    report.scenarios.push({ name: scenario, networkControl: prewarmFetch ? 'shared-fetch-prewarmed' : 'isolated-provider', parity, ...pair });
    if (!values.json) console.log(`${scenario} ${prewarmFetch ? 'shared-fetch' : 'isolated'}: parity passed; total p50 ${pair.typescript.totalLatencyMs.p50.toFixed(2)} → ${pair[candidateBackend].totalLatencyMs.p50.toFixed(2)} ms; sampled tree peak ${pair.typescript.tree.sampledPeakConcurrentRssKiB} → ${pair[candidateBackend].tree.sampledPeakConcurrentRssKiB} KiB`);
  }
  const output = JSON.stringify(report, null, 2) + '\n';
  if (values.output) await writeFile(path.resolve(values.output), output);
  if (values.json) process.stdout.write(output);
  else console.log(`Completed ${report.scenarios.length} scenarios. ${values.quick ? 'Quick mode is smoke evidence only.' : 'Full samples recorded.'}`);
} finally {
  server?.closeAllConnections();
  if (server) await new Promise(resolve => server.close(resolve));
  await rm(temp, { recursive: true, force: true });
}
