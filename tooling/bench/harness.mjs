/**
 * Measurement scenarios for `tooling/bench/native-core.mjs` (audit PR 10). Not run directly:
 * the driver bundles this file with esbuild (the host sources are TypeScript) and starts one
 * fresh Node process per scenario:
 *
 *   node --expose-gc <bundle> <scenario> '<json params>'
 *
 * Each scenario prints exactly one line `BENCH_RESULT <json>` on stdout. Only the real code
 * paths are timed: the TypeScript core through `MissionCheckpointStore` (the host's
 * `missions.sqlite` journal, ADR 0013/0014) and `MissionRecords.initialize` (restart
 * recovery); the Rust core through `DaemonSidecar`, `DaemonClient` and `createDaemonMission`
 * (audit PR 8) talking to the release `extalia-daemon` over stdio. Data lives in temporary
 * directories that are removed afterwards. Nothing is estimated: every number is a timer or
 * process reading taken here.
 */
import { spawn, execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { setImmediate as yieldTurn, setTimeout as sleep } from 'node:timers/promises';
import { MissionCheckpointStore } from '../../packages/host/src/missionCheckpoints.ts';
import { MissionRecords } from '../../packages/host/src/mission.ts';
import { DaemonSidecar, createDaemonMission } from '../../packages/host/src/daemon/index.ts';

const WORKSPACE = '00000000-0000-4000-8000-0000000000b1';
const EVENT_SESSION = '00000000-0000-4000-8000-0000000000b2';
const LEAD = '00000000-0000-4000-8000-0000000000b3';
const BUDGET = '00000000-0000-4000-8000-0000000000b4';
const START = '2026-10-22T00:00:00.000Z';

const [scenario, rawParams = '{}'] = process.argv.slice(2);
const params = JSON.parse(rawParams);
const temps = [];
const tempDir = prefix => { const dir = mkdtempSync(path.join(os.tmpdir(), `extalia-bench-${prefix}-`)); temps.push(dir); return dir; };
const cleanup = () => { for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true }); };
const now = () => performance.now();
const gc = () => { if (globalThis.gc) { globalThis.gc(); globalThis.gc(); } };
let sessionCounter = 0;
const sessionId = () => `s_bench${process.pid.toString(36)}${(sessionCounter++).toString(36).padStart(4, '0')}`;
let clock = Date.parse(START);
/** Strictly increasing millisecond timestamps, as the runtime's `observedAt`. */
const stamp = () => { clock = Math.max(clock + 1, Date.now()); return new Date(clock).toISOString(); };

// ---------------------------------------------------------------- shared mission shapes

function plan(taskCount) {
  const missionId = randomUUID();
  const tasks = Array.from({ length: taskCount }, (_, index) => ({ alias: `task${index}`, taskId: randomUUID(), agentId: randomUUID() }));
  return { missionId, tasks };
}

function event(shape, body, task) {
  return {
    schemaVersion: 1, id: randomUUID(), workspaceId: WORKSPACE, sessionId: EVENT_SESSION, missionId: shape.missionId,
    ...(task ? { taskId: task.taskId, agentId: task.agentId } : { agentId: LEAD }),
    source: { runtime: 'extalia-native', channel: 'system' }, observedAt: stamp(), confidence: 'reported', body,
  };
}
const ACTIVITIES = [
  { type: 'agent.state', state: 'working', activity: 'read' },
  { type: 'tool.started', tool: 'read_file', kind: 'read', label: 'read_file' },
  { type: 'tool.completed', tool: 'read_file', kind: 'read', label: 'read_file', ok: true },
  { type: 'agent.state', state: 'working', activity: 'search' },
];
const activity = (shape, n) => event(shape, ACTIVITIES[n % ACTIVITIES.length], shape.tasks[n % shape.tasks.length]);

// ---------------------------------------------------------------- TypeScript core

/** The host's `HostMissionRun` checkpoint of a mission (as `MissionRecords` saves it). */
function hostRun(shape, session, taskState) {
  return {
    id: shape.missionId, sessionId: session, workspaceId: WORKSPACE, title: 'Benchmark mission', state: 'running',
    createdAt: START, updatedAt: START, transient: false,
    tasks: shape.tasks.map(task => ({ id: task.alias, taskId: task.taskId, agentId: task.agentId, title: `Benchmark ${task.alias}`, dependsOn: [],
      connectionId: 'connection', model: 'model-a', state: taskState, evidenceIds: [] })),
  };
}

/** One TypeScript-core mission: checkpoint and event commit through `writeSession`, as `MissionRecords.commitEvent`. */
class TsMission {
  constructor(store, shape, session, run) { Object.assign(this, { store, shape, session, run, events: 0 }); }
  static create(store, taskCount) {
    const shape = plan(taskCount), session = sessionId();
    const run = hostRun(shape, session, 'running');
    store.writeSession(session, [run]);
    const mission = new TsMission(store, shape, session, run);
    mission.commit(event(shape, { type: 'mission.state', state: 'running' }));
    for (const task of shape.tasks) mission.commit(event(shape, { type: 'task.state', state: 'running' }, task));
    return mission;
  }
  /** Like the service's `advance`: the checkpoint moves to the event's `observedAt`. */
  commit(raw) {
    this.run = { ...this.run, updatedAt: raw.observedAt };
    const acknowledged = this.store.writeSession(this.session, [this.run], { event: raw });
    if (!acknowledged?.sequence) throw new Error('no acknowledgement');
    this.events++;
    return acknowledged.sequence;
  }
}

async function tsStore(dir) { return MissionCheckpointStore.open(path.join(dir, 'state', 'missions.sqlite')); }

/**
 * Missions for `slots` commit loops of `perSlot` commits each, all created before any timing.
 * Each mission takes at most `segment` activity events, so every series samples the same
 * journal depths (0 to `segment` events per mission) whatever its concurrency.
 */
async function pool(create, slots, perSlot, segment) {
  const lists = [];
  for (let slot = 0; slot < slots; slot++) {
    const list = [];
    for (let i = 0; i < Math.max(1, Math.ceil(perSlot / segment)); i++) list.push({ mission: await create(), used: 0 });
    lists.push(list);
  }
  let n = 0;
  return {
    next(slot) {
      const list = lists[slot];
      while (list.length > 1 && list[0].used >= segment) list.shift();
      const entry = list[0];
      entry.used++;
      const raw = activity(entry.mission.shape, n++);
      return () => entry.mission.commit(raw);
    },
  };
}

// ---------------------------------------------------------------- Rust core

function daemonBinary() {
  if (!params.binary) throw new Error('missing binary');
  return params.binary;
}

/** A host-style sidecar on `dir`, with the spawned child exposed for RSS readings and crash injection. */
function sidecar(dir, log = []) {
  const children = [];
  const side = new DaemonSidecar({
    binary: daemonBinary, dataDirectory: dir, profile: 'default', clientVersion: 'bench', env: process.env,
    log: line => { log.push(line); },
    spawn: (binary, args, options) => { const child = spawn(binary, args, { ...options, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true }); children.push(child); return child; },
  });
  return { side, children, log };
}

function graphOf(shape) {
  const mission = { schemaVersion: 1, id: shape.missionId, workspaceId: WORKSPACE, leadAgentId: LEAD, budgetId: BUDGET, state: 'queued', createdAt: START, updatedAt: START, version: 1 };
  const graph = { schemaVersion: 1, missionId: shape.missionId, tasks: shape.tasks.map(task => ({
    schemaVersion: 1, id: task.taskId, missionId: shape.missionId, dependsOn: [], assignedAgentId: task.agentId, state: 'queued', attempt: 0,
    requirements: ['Benchmark read-only task'], evidenceIds: [] })) };
  return { mission, graph };
}

/** One Rust-core mission through `createDaemonMission` (task state changes become `task.transition`). */
class RustMission {
  constructor(core, shape) { Object.assign(this, { core, shape, events: 0 }); }
  static async create(client, taskCount) {
    const shape = plan(taskCount);
    const core = await createDaemonMission(client, graphOf(shape));
    const mission = new RustMission(core, shape);
    await mission.commit(event(shape, { type: 'mission.state', state: 'running' }));
    for (const task of shape.tasks) await mission.commit(event(shape, { type: 'task.state', state: 'running' }, task));
    return mission;
  }
  async commit(raw) {
    const sequence = await this.core.commit(raw);
    this.events++;
    return sequence;
  }
}

/** Resident set size (KiB) and CPU time (s) of a process, from `ps` (macOS/Linux only). */
function processStats(pid) {
  if (process.platform === 'win32') return undefined;
  const [rss, time] = execFileSync('ps', ['-o', 'rss=', '-o', 'time=', '-p', String(pid)], { encoding: 'utf8' }).trim().split(/\s+/);
  const parts = time.split(':').map(Number);
  const seconds = parts.reduce((sum, part) => sum * 60 + part, 0);
  return { rssKiB: Number(rss), cpuSeconds: seconds };
}

// ---------------------------------------------------------------- scenarios

/**
 * Sequential or N-concurrent event commits (one loop per mission, each commits as soon as its
 * previous commit is acknowledged). `latencies`: issue → acknowledgement, including waiting for
 * other missions (the daemon serves one request at a time; the TypeScript store runs on the
 * host thread, so a mission waits while another mission's commit blocks it). `callLatencies`:
 * the commit call alone, i.e. for TypeScript the time the host thread is blocked per commit.
 */
async function commitSeries(backend) {
  const { iterations, warmup, concurrency, segment } = params;
  const dir = tempDir(`${backend}-commit`);
  const perSlot = Math.ceil(warmup / concurrency) + Math.ceil(iterations / concurrency);
  let close, source;
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    source = await pool(async () => TsMission.create(store, 1), concurrency, perSlot, segment);
    close = async () => store.close();
  } else {
    const { side } = sidecar(dir);
    const client = await side.connect();
    source = await pool(() => RustMission.create(client, 1), concurrency, perSlot, segment);
    close = () => side.stop();
  }
  const run = async (total, record) => {
    const perSlot = Math.ceil(total / concurrency);
    const latencies = [], callLatencies = [];
    const loop = async slot => {
      for (let i = 0; i < perSlot && slot + i * concurrency < total; i++) {
        const commit = source.next(slot);
        const issued = now();
        // Missions share the host thread: a ready TypeScript commit waits for its turn.
        if (backend === 'typescript' && concurrency > 1) await yieldTurn();
        const start = now();
        await commit();
        const end = now();
        latencies.push(end - issued); callLatencies.push(end - start);
      }
    };
    const start = now();
    await Promise.all(Array.from({ length: concurrency }, (_, slot) => loop(slot)));
    const wallMs = now() - start;
    return record ? { latencies, callLatencies, wallMs } : undefined;
  };
  await run(warmup, false);
  const result = await run(iterations, true);
  await close();
  return { ...result, commits: result.latencies.length };
}

/** Mission creation: TS = first checkpoint of a new run (new session); Rust = `mission.create`. */
async function createSeries(backend) {
  const { iterations, warmup, tasks } = params;
  const dir = tempDir(`${backend}-create`);
  const latencies = [];
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    for (let i = 0; i < warmup + iterations; i++) {
      const shape = plan(tasks), session = sessionId(), run = hostRun(shape, session, 'queued');
      const start = now();
      store.writeSession(session, [run]);
      if (i >= warmup) latencies.push(now() - start);
    }
    store.close();
  } else {
    const { side } = sidecar(dir);
    const client = await side.connect();
    for (let i = 0; i < warmup + iterations; i++) {
      const created = graphOf(plan(tasks));
      const start = now();
      await createDaemonMission(client, created);
      if (i >= warmup) latencies.push(now() - start);
    }
    await side.stop();
  }
  return { latencies };
}

/** Burst throughput: TS = tight synchronous loop; Rust = all commits pipelined on the one connection. */
async function burstSeries(backend) {
  const { burst, repetitions, warmup } = params;
  const dir = tempDir(`${backend}-burst`);
  const bursts = [];
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    const warm = TsMission.create(store, 1);
    for (let i = 0; i < warmup; i++) warm.commit(activity(warm.shape, i));
    for (let r = 0; r < repetitions; r++) {
      const mission = TsMission.create(store, 1);
      const events = Array.from({ length: burst }, (_, n) => activity(mission.shape, n));
      const start = now();
      for (const raw of events) mission.commit(raw);
      bursts.push({ commits: burst, wallMs: now() - start });
    }
    store.close();
  } else {
    const { side } = sidecar(dir);
    const client = await side.connect();
    const warm = await RustMission.create(client, 1);
    for (let i = 0; i < warmup; i++) await warm.commit(activity(warm.shape, i));
    for (let r = 0; r < repetitions; r++) {
      const mission = await RustMission.create(client, 1);
      const events = Array.from({ length: burst }, (_, n) => activity(mission.shape, n));
      const start = now();
      await Promise.all(events.map(raw => mission.commit(raw)));
      bursts.push({ commits: burst, wallMs: now() - start });
    }
    await side.stop();
  }
  return { bursts };
}

/** Commit latency as the mission's journal grows (one mission, one session), in buckets. */
async function depthSeries(backend) {
  const { events, bucket } = params;
  const dir = tempDir(`${backend}-depth`);
  const latencies = [];
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    const mission = TsMission.create(store, 1);
    for (let n = 0; n < events; n++) { const raw = activity(mission.shape, n); const start = now(); mission.commit(raw); latencies.push(now() - start); }
    store.close();
  } else {
    const { side } = sidecar(dir);
    const mission = await RustMission.create(await side.connect(), 1);
    for (let n = 0; n < events; n++) { const raw = activity(mission.shape, n); const start = now(); await mission.commit(raw); latencies.push(now() - start); }
    await side.stop();
  }
  const buckets = [];
  for (let from = 0; from < latencies.length; from += bucket) buckets.push({ from, to: Math.min(latencies.length, from + bucket), latencies: latencies.slice(from, from + bucket) });
  return { buckets };
}

/** Cold start. TS: `MissionCheckpointStore.open` (first in this process); Rust: spawn → `hello` ready. */
async function coldStart(backend) {
  const { existing } = params; // existing: a populated data folder copied in by the driver
  const dir = existing ?? tempDir(`${backend}-cold`);
  if (backend === 'typescript') {
    const start = now();
    const store = await tsStore(dir);
    const ms = now() - start;
    store.close();
    return { ms };
  }
  const { runs, warmup } = params;
  const samples = [];
  for (let i = 0; i < warmup + runs; i++) {
    const target = existing ? copyDir(existing, `rust-cold-run`) : tempDir('rust-cold-run');
    const { side } = sidecar(target);
    const start = now();
    await side.connect();
    const ms = now() - start;
    await side.stop();
    rmSync(target, { recursive: true, force: true });
    if (i >= warmup) samples.push(ms);
  }
  return { samples };
}

function copyDir(source, prefix) {
  const target = tempDir(prefix);
  cpSync(source, target, { recursive: true });
  return target;
}

/** A populated store: `missions` missions with `history` events each (for "existing store" cold starts). */
async function populate(backend) {
  const { dir, missions, history } = params;
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    for (let m = 0; m < missions; m++) {
      const mission = TsMission.create(store, 1);
      for (let n = 0; n < history; n++) mission.commit(activity(mission.shape, n));
    }
    store.close();
  } else {
    const { side } = sidecar(dir);
    const client = await side.connect();
    for (let m = 0; m < missions; m++) {
      const mission = await RustMission.create(client, 1);
      for (let n = 0; n < history; n++) await mission.commit(activity(mission.shape, n));
    }
    await side.stop();
  }
  return {};
}

/**
 * Crash with `inFlight` running tasks (16 per mission, the host's per-run limit) and
 * `history` activity events per mission, then stop without any shutdown: TS exits this
 * process with SIGKILL, Rust SIGKILLs the daemon.
 */
async function restartSetup(backend) {
  const { dir, inFlight, history } = params;
  const sizes = [];
  for (let left = inFlight; left > 0; left -= 16) sizes.push(Math.min(16, left));
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    const sessions = [];
    for (const size of sizes) {
      const mission = TsMission.create(store, size);
      for (let n = 0; n < history; n++) mission.commit(activity(mission.shape, n));
      sessions.push(mission.session);
    }
    // Report first, then die like a crashed host (no close, no WAL checkpoint).
    process.stdout.write(`BENCH_RESULT ${JSON.stringify({ sessions, missions: sizes.length })}\n`, () => process.kill(process.pid, 'SIGKILL'));
    await new Promise(() => undefined);
  }
  const { side, children } = sidecar(dir);
  const client = await side.connect();
  for (const size of sizes) {
    const mission = await RustMission.create(client, size);
    for (let n = 0; n < history; n++) await mission.commit(activity(mission.shape, n));
  }
  const child = children[0];
  const exited = new Promise(resolve => child.once('close', resolve));
  child.kill('SIGKILL');
  await exited;
  await side.stop();
  return { missions: sizes.length };
}

/** Restart recovery. TS: `MissionRecords.initialize` (store open + checks + recovery write); Rust: spawn → recover → `hello`. */
async function restart(backend) {
  const { setup, inFlight } = params;
  if (backend === 'typescript') {
    const { sessions } = params;
    const dir = setup; // a fresh copy made by the driver for this process
    const records = new MissionRecords(path.join(dir, 'sessions'), path.join(dir, 'state', 'missions.sqlite'));
    const list = sessions.map(id => ({ id, workspaceId: WORKSPACE, connectionId: 'connection', title: 'Benchmark', createdAt: START, lastActiveAt: START }));
    const start = now();
    await records.initialize(list);
    const ms = now() - start;
    const recovered = sessions.flatMap(id => records.list(id)).filter(run => run.state === 'recovering').flatMap(run => run.tasks).filter(task => task.state === 'unknown').length;
    records.close();
    if (recovered !== inFlight) throw new Error(`recovered ${recovered} tasks, expected ${inFlight}`);
    return { ms, recovered };
  }
  const { runs, warmup } = params;
  const samples = [];
  let recovered;
  for (let i = 0; i < warmup + runs; i++) {
    const target = copyDir(setup, 'rust-restart-run');
    const { side, log } = sidecar(target);
    const start = now();
    await side.connect();
    const ms = now() - start;
    await side.stop();
    rmSync(target, { recursive: true, force: true });
    const line = log.find(text => /recovered \d+ mission\(s\) and \d+ task\(s\)/.test(text));
    recovered = Number(/and (\d+) task/.exec(line ?? '')?.[1] ?? NaN);
    if (recovered !== inFlight) throw new Error(`daemon recovered ${recovered} tasks, expected ${inFlight}`);
    if (i >= warmup) samples.push(ms);
  }
  return { samples, recovered };
}

/** Memory: daemon RSS idle and after M commits (plus idle CPU); host-side Node RSS and heap deltas. */
async function memory(backend) {
  const { commits, settleMs, idleMs } = params;
  const dir = tempDir(`${backend}-memory`);
  gc();
  const host0 = process.memoryUsage();
  const result = {};
  if (backend === 'typescript') {
    const store = await tsStore(dir);
    gc();
    const host1 = process.memoryUsage();
    const source = await pool(async () => TsMission.create(store, 1), 1, commits, 4_000);
    for (let i = 0; i < commits; i++) source.next(0)();
    gc();
    const host2 = process.memoryUsage();
    store.close();
    Object.assign(result, { hostOpen: delta(host0, host1), hostAfterCommits: delta(host0, host2) });
  } else {
    const { side, children } = sidecar(dir);
    const client = await side.connect();
    const pid = children[0].pid;
    await sleep(settleMs);
    const idle0 = processStats(pid);
    await sleep(idleMs);
    const idle1 = processStats(pid);
    gc();
    const host1 = process.memoryUsage();
    const source = await pool(() => RustMission.create(client, 1), 1, commits, 4_000);
    for (let i = 0; i < commits; i++) await source.next(0)();
    await sleep(settleMs);
    const after = processStats(pid);
    gc();
    const host2 = process.memoryUsage();
    await side.stop();
    Object.assign(result, {
      daemon: idle0 && { idleRssKiB: idle0.rssKiB, idleCpuSeconds: idle1.cpuSeconds - idle0.cpuSeconds, idleWindowMs: idleMs, afterCommitsRssKiB: after.rssKiB },
      hostOpen: delta(host0, host1), hostAfterCommits: delta(host0, host2),
    });
  }
  return { commits, ...result };
}
const delta = (a, b) => ({ rssKiB: Math.round((b.rss - a.rss) / 1024), heapUsedKiB: Math.round((b.heapUsed - a.heapUsed) / 1024), externalKiB: Math.round((b.external - a.external) / 1024) });

const SCENARIOS = { commitSeries, createSeries, burstSeries, depthSeries, coldStart, populate, restartSetup, restart, memory };

try {
  const run = SCENARIOS[scenario];
  if (!run || !['typescript', 'rust'].includes(params.backend)) throw new Error(`unknown scenario ${scenario}/${params.backend}`);
  const result = await run(params.backend);
  process.stdout.write(`BENCH_RESULT ${JSON.stringify(result)}\n`);
} finally {
  cleanup();
}
