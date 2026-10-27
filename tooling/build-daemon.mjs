#!/usr/bin/env node
/**
 * Build `extalia-daemon` for release and stage it for packaging (ADR 0021, audit PR 9).
 *
 *   node tooling/build-daemon.mjs                       host target
 *   node tooling/build-daemon.mjs --target x86_64-apple-darwin [--target …]
 *   node tooling/build-daemon.mjs --desktop-targets     every arch electron-builder packages on this OS
 *   node tooling/build-daemon.mjs --target linux-x64 --from <binary>   stage a prebuilt binary (release CI)
 *   … --out <dir>                                       also copy to <dir>/<platform>-<arch>/
 *
 * Builds `cargo build --release --locked -p extalia-daemon --target <triple>` with symbols
 * stripped (an explicit --target keeps these builds out of the developers' target/release),
 * checks that the result is an executable of the requested OS/architecture, and copies it
 * to apps/desktop/build-resources/daemon/<os>-<arch>/ (git-ignored), from where
 * electron-builder's `extraResources` puts it at `<resources>/daemon/`. Prints size and SHA-256;
 * a binary for this machine must also answer `hello` with the lockstep version.
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DAEMON_TARGETS, daemonBinaryName, daemonHello, findTarget, readExecutableKind, stagedBinary } from './daemon.mjs';
import { ROOT } from './workspace.mjs';

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true, default: [] },
    'desktop-targets': { type: 'boolean', default: false },
    from: { type: 'string' },
    out: { type: 'string' },
  },
});

function fail(message) { console.error(`build-daemon: ${message}`); process.exit(1); }

const exe = name => (process.platform === 'win32' ? `${name}.exe` : name);
function findCargo() {
  if (spawnSync(exe('cargo'), ['--version'], { stdio: 'ignore' }).status === 0) return { bin: undefined };
  const bin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin');
  return existsSync(path.join(bin, exe('cargo'))) ? { bin } : undefined;
}

function run(command, args, env) {
  console.log(`$ ${command} ${args.join(' ')}`);
  const result = spawnSync(command, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) fail(`${command} could not start: ${result.error.message}`);
  if (result.status !== 0) fail(`${command} ${args[0]} failed (exit ${result.status}).`);
}

function output(command, args, env) {
  const result = spawnSync(command, args, { cwd: ROOT, env, encoding: 'utf8' });
  return result.status === 0 ? result.stdout : undefined;
}

let toolEnv;
function cargoEnv() {
  if (toolEnv) return toolEnv;
  const found = findCargo();
  if (!found) fail('cargo was not found on PATH or in ~/.cargo/bin. Install rustup (https://rustup.rs); rust-toolchain.toml selects the pinned toolchain.');
  toolEnv = found.bin ? { ...process.env, PATH: `${found.bin}${path.delimiter}${process.env.PATH ?? ''}` } : { ...process.env };
  if (process.platform === 'darwin' && !toolEnv.CC) toolEnv.CC = 'clang';
  return toolEnv;
}

function hostTriple() {
  const host = /^host:\s*(\S+)/m.exec(output(exe('rustc'), ['-vV'], cargoEnv()) ?? '')?.[1];
  if (!host) fail('cannot read the host target from `rustc -vV`.');
  return host;
}

function requestedTargets() {
  const names = [...values.target];
  if (values['desktop-targets']) {
    const builderOs = { darwin: 'mac', win32: 'win', linux: 'linux' }[process.platform];
    // electron-builder.yml: macOS arm64 + x64, Windows x64, Linux x64.
    names.push(...DAEMON_TARGETS.filter(target => target.desktop && target.builderOs === builderOs).map(target => target.triple));
  }
  if (!names.length) names.push(hostTriple());
  const targets = [...new Set(names)].map(name => findTarget(name) ?? fail(`unknown target ${name}; known: ${DAEMON_TARGETS.map(target => target.triple).join(', ')}`));
  if (values.from && targets.length !== 1) fail('--from stages one prebuilt binary; pass exactly one --target.');
  return targets;
}

function ensureRustTarget(triple) {
  const installed = output(exe('rustup'), ['target', 'list', '--installed'], cargoEnv());
  if (installed?.split(/\r?\n/).includes(triple)) return;
  // Adds the target to the toolchain pinned in rust-toolchain.toml (contributor machines and CI only).
  run(exe('rustup'), ['target', 'add', triple], cargoEnv());
}

async function build(target) {
  if (target.triple !== hostTriple()) ensureRustTarget(target.triple);
  run(exe('cargo'), ['build', '--release', '--locked', '-p', 'extalia-daemon', '--target', target.triple], { ...cargoEnv(), CARGO_PROFILE_RELEASE_STRIP: 'symbols' });
  return path.join(ROOT, 'target', target.triple, 'release', daemonBinaryName(target.platform));
}

/**
 * macOS refuses to run arm64 code without a valid signature. arm64 links are ad-hoc signed by the
 * linker, x86_64 links are not; sign ad hoc when needed (release signing replaces it with the app's identity).
 */
function checkMacSignature(file) {
  if (process.platform !== 'darwin') return;
  if (spawnSync('codesign', ['--verify', file], { stdio: 'ignore' }).status === 0) return;
  console.log('build-daemon: no valid signature; signing ad hoc.');
  run('codesign', ['--force', '--sign', '-', file], process.env);
}

async function stage(target, binary) {
  const kind = await readExecutableKind(binary).catch(error => fail(`cannot read ${binary}: ${error.message}`));
  if (kind?.platform !== target.platform || kind.arch !== target.arch) fail(`${binary} is ${kind ? `${kind.platform}-${kind.arch ?? 'unknown'}` : 'not an executable'}, expected ${target.platform}-${target.arch}.`);
  checkMacSignature(binary);
  const destinations = [];
  if (target.desktop) destinations.push(stagedBinary(target));
  if (values.out) destinations.push(path.resolve(values.out, `${target.platform}-${target.arch}`, daemonBinaryName(target.platform)));
  for (const destination of destinations) {
    await rm(path.dirname(destination), { recursive: true, force: true });
    await mkdir(path.dirname(destination), { recursive: true });
    await copyFile(binary, destination);
    await chmod(destination, 0o755);
  }
  const { size } = await stat(binary);
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  console.log(`extalia-daemon ${target.triple}: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB), sha256 ${sha256}`);
  for (const destination of destinations) console.log(`  staged ${path.relative(ROOT, destination)}`);
  // A binary for this machine must answer `hello` with the lockstep version (artifact downloads lose the
  // executable bit, so the staged copy is the one to run).
  const runnable = destinations[0] ?? (values.from ? undefined : binary);
  if (runnable && target.platform === process.platform && target.arch === process.arch) {
    const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const hello = await daemonHello(runnable).catch(error => fail(`hello failed: ${error.message}`));
    if (hello.daemonVersion !== version) fail(`daemon reports ${hello.daemonVersion}, expected ${version}.`);
    console.log(`  hello ok (daemonVersion ${hello.daemonVersion})`);
  }
}

for (const target of requestedTargets()) {
  await stage(target, values.from ? path.resolve(values.from) : await build(target));
}
