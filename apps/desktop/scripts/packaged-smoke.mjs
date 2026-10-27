/**
 * Packaged smoke test and "clean machine" gate for Extalia Desktop (audit PR 9).
 * Run after `pnpm dist:dir` (or a full `electron-builder` build), from apps/desktop:
 *
 *   node scripts/packaged-smoke.mjs [--app <unpacked dir or .app>] [--allow-missing-daemon] [--daemon-only]
 *
 * Everything runs in an environment with no developer toolchain reachable (PATH is an
 * empty folder, HOME is fresh; see `cleanMachineEnv` in tooling/daemon.mjs): no Rust,
 * Python, Node or npm. It checks that
 * 1. `<resources>/daemon/extalia-daemon[.exe]` exists, matches this OS/arch and answers
 *    `hello` (temporary `--data-dir`) with the app's version;
 * 2. the packaged app passes its own `--smoke-test` with the daemon present;
 * 3. it still passes with the daemon folder moved away (the daemon flag is off by default
 *    and a missing binary is ignored), after which the folder is restored.
 * `--allow-missing-daemon` (local builds without Rust) skips 1 and 3 when no binary was packaged.
 */
import { spawn } from 'node:child_process';
import { readFile, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { cleanMachineEnv, daemonBinaryName, daemonHello, readExecutableKind, resolvableCommands } from '../../../tooling/daemon.mjs';

const DESKTOP = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    'allow-missing-daemon': { type: 'boolean', default: false },
    'daemon-only': { type: 'boolean', default: false },
  },
});
// Throws, so `finally` blocks restore the package and remove temporary folders.
function fail(message) { throw new Error(message); }
const exists = file => stat(file).then(() => true, () => false);

const { version } = JSON.parse(await readFile(path.join(DESKTOP, 'package.json'), 'utf8'));
const productName = 'Extalia';

/** electron-builder's unpacked folders (output: release/). */
const UNPACKED = {
  darwin: { arm64: ['mac-arm64', 'mac-universal'], x64: ['mac', 'mac-universal'] },
  win32: { x64: ['win-unpacked'], arm64: ['win-arm64-unpacked'] },
  linux: { x64: ['linux-unpacked'], arm64: ['linux-arm64-unpacked'] },
}[process.platform]?.[process.arch] ?? [];

async function locate() {
  let dir = values.app ? path.resolve(values.app) : undefined;
  if (!dir) {
    for (const name of UNPACKED) if (await exists(path.join(DESKTOP, 'release', name))) { dir = path.join(DESKTOP, 'release', name); break; }
    if (!dir) fail(`no unpacked app in release/ (looked for ${UNPACKED.join(', ')}); run pnpm dist:dir first or pass --app.`);
  }
  if (process.platform === 'darwin') {
    const app = dir.endsWith('.app') ? dir : path.join(dir, `${productName}.app`);
    return { executable: path.join(app, 'Contents', 'MacOS', productName), resources: path.join(app, 'Contents', 'Resources') };
  }
  const executable = path.join(dir, process.platform === 'win32' ? `${productName}.exe` : 'extalia-desktop');
  return { executable, resources: path.join(dir, 'resources') };
}

function runApp(executable, env) {
  return new Promise(resolve => {
    const child = spawn(executable, ['--smoke-test'], { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let output = '';
    const collect = chunk => { output = (output + chunk).slice(-20_000); };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    const timer = setTimeout(() => { output += '\n[packaged-smoke: timed out after 180 s]'; child.kill(); }, 180_000);
    child.once('error', error => { clearTimeout(timer); resolve({ code: -1, output: `${output}\n${error.message}` }); });
    child.once('exit', code => { clearTimeout(timer); resolve({ code, output }); });
  });
}

const { env, cleanup } = await cleanMachineEnv();
const report = { ok: false, toolchainOnPath: resolvableCommands(env) };
try {
  const { executable, resources } = await locate();
  if (!(await exists(executable))) fail(`missing app executable ${executable}`);
  report.executable = executable;
  const daemonDir = path.join(resources, 'daemon');
  const binary = path.join(daemonDir, daemonBinaryName(process.platform));
  if (report.toolchainOnPath.length) fail(`toolchain still reachable in the clean environment: ${report.toolchainOnPath.join(', ')}`);

  const hasDaemon = await exists(binary);
  if (!hasDaemon && !values['allow-missing-daemon']) fail(`no daemon in the package: ${binary} (run node tooling/build-daemon.mjs before packaging)`);
  if (hasDaemon) {
    const kind = await readExecutableKind(binary);
    if (kind?.platform !== process.platform || (kind.arch !== process.arch && kind.arch !== 'universal')) fail(`${binary} is ${kind ? `${kind.platform}-${kind.arch}` : 'not an executable'}, expected ${process.platform}-${process.arch}`);
    report.daemon = { binary, size: (await stat(binary)).size, hello: await daemonHello(binary, { env }) };
    if (report.daemon.hello.daemonVersion !== version) fail(`packaged daemon reports ${report.daemon.hello.daemonVersion}, app is ${version}`);
  } else {
    report.daemon = 'absent (allowed)';
  }

  if (!values['daemon-only']) {
    const withDaemon = await runApp(executable, env);
    report.appWithDaemon = withDaemon.code;
    if (withDaemon.code !== 0) fail(`packaged app smoke failed (exit ${withDaemon.code}):\n${withDaemon.output}`);
    if (hasDaemon) {
      const hidden = `${daemonDir}.hidden-by-smoke`;
      await rename(daemonDir, hidden);
      try {
        const withoutDaemon = await runApp(executable, env);
        report.appWithoutDaemon = withoutDaemon.code;
        if (withoutDaemon.code !== 0) fail(`packaged app smoke without the daemon failed (exit ${withoutDaemon.code}):\n${withoutDaemon.output}`);
      } finally {
        await rename(hidden, daemonDir);
      }
    }
  }
  report.ok = true;
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  console.error(`packaged-smoke: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
}
