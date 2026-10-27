#!/usr/bin/env node
/**
 * Release gate "clean machine" for the CLI (owner decision 9): install the packed
 * `extalia-vo` and this machine's `@extalia/daemon-<platform>-<arch>` with
 * `npm install -g` into a throwaway prefix, then run them with no developer toolchain
 * reachable (see `cleanMachineEnv` in tooling/daemon.mjs): `extalia version`/`doctor`
 * must work, and the daemon path exported by the platform package, resolved from the
 * installed CLI, must answer `hello` with the same version.
 *
 *   node tooling/clean-machine-smoke.mjs --npm <dir>
 *
 * <dir> is the output of `node apps/cli/npm/generate.mjs --cli` (extalia-vo/ and
 * daemon-<platform>-<arch>/). Node itself stays available to the CLI, by absolute path
 * (and as the only command on PATH for the `extalia` launcher): it is the CLI's runtime.
 * The packaged Desktop app has its own gate in apps/desktop/scripts/packaged-smoke.mjs.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { cleanMachineEnv, daemonHello, findTarget, npmPackageName, resolvableCommands, TOOLCHAIN_COMMANDS } from './daemon.mjs';
import { ROOT } from './workspace.mjs';

const { values } = parseArgs({ options: { npm: { type: 'string' } } });
// Throws, so `finally` removes the temporary folders.
function fail(message) { throw new Error(message); }
if (!values.npm) { console.error('clean-machine: --npm <dir> is required (output of apps/cli/npm/generate.mjs --cli).'); process.exit(2); }

const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const target = findTarget(`${process.platform}-${process.arch}`) ?? fail(`no daemon target for ${process.platform}-${process.arch}`);
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const source = path.resolve(values.npm);

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: process.platform === 'win32' && command.endsWith('.cmd'), ...options });
  if (result.error) fail(`${path.basename(command)} ${args.join(' ')} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${path.basename(command)} ${args.join(' ')} exited ${result.status}:\n${result.stdout ?? ''}${result.stderr ?? ''}`);
  return result.stdout.trim();
}

const work = await mkdtemp(path.join(os.tmpdir(), 'extalia-clean-npm-'));
const { env, cleanup } = await cleanMachineEnv();
try {
  const reachable = resolvableCommands(env);
  if (reachable.length) fail(`toolchain still reachable in the clean environment: ${reachable.join(', ')}`);

  // Pack exactly what npm would publish, then install it like a user would.
  const packs = path.join(work, 'packs');
  await mkdir(packs);
  for (const dir of ['extalia-vo', `daemon-${target.platform}-${target.arch}`]) run(npm, ['pack', '--pack-destination', packs, path.join(source, dir)], { cwd: work });
  const tarballs = (await readdir(packs)).map(file => path.join(packs, file));
  const prefix = path.join(work, 'prefix');
  run(npm, ['install', '-g', '--prefix', prefix, '--no-audit', '--no-fund', ...tarballs], { cwd: work });
  const globalModules = process.platform === 'win32' ? path.join(prefix, 'node_modules') : path.join(prefix, 'lib', 'node_modules');
  const cliDir = path.join(globalModules, 'extalia-vo');

  const cli = args => run(process.execPath, [path.join(cliDir, 'dist', 'extalia.mjs'), ...args], { env, cwd: work });
  if (cli(['version']) !== version) fail(`extalia version did not print ${version}`);
  cli(['doctor']);
  if (process.platform !== 'win32') {
    // The installed launcher (`#!/usr/bin/env node`) with node as the only command on PATH.
    const nodeOnly = path.join(work, 'node-only');
    await mkdir(nodeOnly);
    await symlink(process.execPath, path.join(nodeOnly, 'node'));
    const launcherEnv = { ...env, PATH: `${nodeOnly}${path.delimiter}${env.PATH}` };
    const extra = resolvableCommands(launcherEnv, TOOLCHAIN_COMMANDS.filter(command => command !== 'node'));
    if (extra.length) fail(`toolchain reachable next to node: ${extra.join(', ')}`);
    if (run(path.join(prefix, 'bin', 'extalia'), ['version'], { env: launcherEnv, cwd: work }) !== version) fail('installed extalia launcher did not print the version');
  }

  // Resolve the platform package the way the CLI does: from the installed CLI's location.
  const name = npmPackageName(target);
  const daemon = run(process.execPath, ['-p', `require(require.resolve(${JSON.stringify(name)}, { paths: [${JSON.stringify(cliDir)}] }))`], { env, cwd: work });
  const hello = await daemonHello(daemon, { env });
  if (hello.daemonVersion !== version) fail(`daemon from ${name} reports ${hello.daemonVersion}, expected ${version}`);
  console.log(JSON.stringify({ ok: true, version, cli: 'extalia version/doctor ok', daemonPackage: name, daemon, hello, path: env.PATH }, null, 2));
} catch (error) {
  console.error(`clean-machine: ${error.message}`);
  process.exitCode = 1;
} finally {
  await cleanup();
  await rm(work, { recursive: true, force: true });
}
