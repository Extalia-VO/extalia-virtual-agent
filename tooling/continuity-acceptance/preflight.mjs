import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, mkdtemp, mkdir, open, realpath, rm, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { NATIVE_COMPACTION_CAPABILITIES } from './evaluate.mjs';

const DEFAULT_EXECUTABLES = { codex: 'codex', gemini: 'gemini', 'claude-code': 'claude' };
const MAX_EXECUTABLE = 1024 * 1024 * 1024;
const sameFile = (before, after) => before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeMs === after.mtimeMs;
async function hashExecutable(file) {
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > MAX_EXECUTABLE) throw new Error('Executable exceeds the 1 GiB regular-file limit.');
    const hash = createHash('sha256'), buffer = Buffer.alloc(64 * 1024); let size = 0;
    while (true) {
      const read = await handle.read(buffer, 0, buffer.length, null);
      if (!read.bytesRead) break;
      size += read.bytesRead;
      if (size > MAX_EXECUTABLE) throw new Error('Executable grew beyond the hash limit.');
      hash.update(buffer.subarray(0, read.bytesRead));
    }
    if (size !== before.size || !sameFile(before, await handle.stat()) || !sameFile(before, await stat(file))) throw new Error('Executable changed while hashing.');
    return { digest: hash.digest('hex'), identity: before };
  } finally { await handle.close(); }
}
function versionProbe(executable, home, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ['--version'], { cwd: home, env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = 0, output = '', problem, finished = false, forced;
    const finish = (error, value) => {
      if (finished) return; finished = true; clearTimeout(timer); clearTimeout(forced);
      if (error) reject(error); else resolve(value);
    };
    const stop = reason => {
      if (problem) return; problem = reason;
      try { if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); } catch { child.kill('SIGKILL'); }
      forced = setTimeout(() => {
        child.stdout.destroy(); child.stderr.destroy();
        finish(new Error(`${reason} Process/pipe termination could not be confirmed.`));
      }, 500);
    };
    const timer = setTimeout(() => stop('Version probe timed out.'), 5000);
    child.stdout.on('data', data => { bytes += data.length; if (bytes > 64 * 1024) stop('Version probe output exceeded its limit.'); else output += data.toString('utf8'); });
    child.stderr.on('data', data => { bytes += data.length; if (bytes > 64 * 1024) stop('Version probe output exceeded its limit.'); });
    child.once('error', () => finish(new Error('Version probe could not start.')));
    child.once('close', (code, signal) => finish(problem || code !== 0 || signal ? new Error(problem ?? 'Version probe failed.') : undefined, output.trim()));
  });
}
async function resolveExecutable(selected) {
  const choices = path.isAbsolute(selected) ? [selected] : (process.env.PATH ?? '').split(path.delimiter).filter(Boolean).map(folder => path.join(folder, selected));
  for (const candidate of choices) try {
    const file = await realpath(candidate); await access(file, constants.X_OK);
    if ((await stat(file)).isFile()) return file;
  } catch { /* Try the next PATH entry. */ }
  return undefined;
}

/** Only --version is invoked. Provider inference, auth setup and real profile writes are never performed. */
export async function preflight({ executables = {} } = {}) {
  const root = await mkdtemp(path.join(await realpath(os.tmpdir()), 'extalia-continuity-preflight-'));
  const runtimes = [];
  try {
    for (const [runtime, defaultName] of Object.entries(DEFAULT_EXECUTABLES)) {
      const requested = executables[runtime] ?? defaultName;
      if (typeof requested !== 'string' || !requested || requested.includes('\0')) throw new Error('Executable names must be nonempty strings.');
      const executable = await resolveExecutable(requested);
      const observation = { decoder: NATIVE_COMPACTION_CAPABILITIES[runtime], installedVersion: 'unverified' };
      if (!executable) { runtimes.push({ runtime, available: false, compaction: observation, problem: 'Executable unavailable.' }); continue; }
      let executableHash;
      try { executableHash = await hashExecutable(executable); }
      catch (error) { runtimes.push({ runtime, available: true, probeSucceeded: false, executable, compaction: observation, problem: error.message }); continue; }
      const executableSha256 = executableHash.digest;
      const home = path.join(root, runtime); await mkdir(home, { mode: 0o700 });
      const env = { PATH: process.env.PATH ?? '', HOME: home, USERPROFILE: home, TMPDIR: home, TMP: home, TEMP: home,
        XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
        CODEX_HOME: path.join(home, 'codex'), CLAUDE_CONFIG_DIR: path.join(home, 'claude'), LANG: 'C.UTF-8' };
      if (process.platform === 'win32' && process.env.SystemRoot) env.SystemRoot = process.env.SystemRoot;
      try {
        const version = await versionProbe(executable, home, env);
        if (!sameFile(executableHash.identity, await stat(executable))) throw new Error('Executable changed during the version probe.');
        runtimes.push({ runtime, available: true, probeSucceeded: Boolean(version), executable, executableSha256, version, compaction: observation,
          ...(version ? {} : { problem: 'Version probe returned no version.' }) });
      } catch (error) {
        runtimes.push({ runtime, available: true, probeSucceeded: false, executable, executableSha256, compaction: observation, problem: error.message });
      }
    }
  } finally { await rm(root, { recursive: true, force: true }); }
  return { schemaVersion: 1, status: 'blocked', inferenceCalls: 0, runtimes,
    blockers: ['Gemini native compaction observation has not been verified.', 'Installed runtime versions and live four-hop evidence still require review and collection.'] };
}

async function main() {
  const args = process.argv.slice(2), executables = {};
  for (let index = 0; index < args.length; index += 2) {
    const runtime = { '--codex': 'codex', '--gemini': 'gemini', '--claude': 'claude-code' }[args[index]];
    if (!runtime || !args[index + 1]) throw new Error('Usage: node tooling/continuity-acceptance/preflight.mjs [--codex <executable>] [--gemini <executable>] [--claude <executable>]');
    executables[runtime] = args[index + 1];
  }
  const result = await preflight({ executables });
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`); process.exitCode = 2;
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1; });
}
