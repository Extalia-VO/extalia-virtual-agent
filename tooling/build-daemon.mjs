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
 * Builds `cargo build --release --locked -p extalia-daemon --bin extalia-daemon --target <triple>` with symbols
 * stripped (an explicit --target keeps these builds out of the developers' target/release),
 * checks that the result is an executable of the requested OS/architecture, and copies it
 * to apps/desktop/build-resources/daemon/<os>-<arch>/ (git-ignored), from where
 * electron-builder's `extraResources` puts it at `<resources>/daemon/`. Prints size and SHA-256;
 * a binary for this machine must also answer `hello` with the lockstep version.
 */
import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, copyFile, mkdir, readFile, rename, rm, stat } from 'node:fs/promises';
import { constants, existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { DAEMON_TARGETS, daemonBinaryName, daemonHello, findTarget, readExecutableKind, stagedBinary } from './daemon.mjs';
import { ROOT } from './workspace.mjs';
import { SCANNER_BINDING, copyScannerBundle, createScannerBinding, verifyScannerBinding, verifyScannerBundle, verifyScannerSignatures, writeScannerBinding } from './scanner-distribution.mjs';

const { values } = parseArgs({
  options: {
    target: { type: 'string', multiple: true, default: [] },
    'desktop-targets': { type: 'boolean', default: false },
    from: { type: 'string' },
    out: { type: 'string' },
    'scanner-bundle': { type: 'string' },
    'require-scanner': { type: 'boolean', default: false },
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
  if (values['scanner-bundle'] && targets.length !== 1) fail('--scanner-bundle is target-specific; pass exactly one --target.');
  return targets;
}

async function scannerFor(target) {
  const binary = values.from ? path.resolve(values.from) : undefined;
  const adjacent = binary ? path.join(path.dirname(binary), 'skillspector') : undefined;
  const configured = values['scanner-bundle'] ? path.resolve(values['scanner-bundle']) : adjacent;
  if (!configured || !existsSync(configured)) {
    if (configured && values['scanner-bundle']) fail('the explicitly selected scanner bundle is missing.');
    if (binary && existsSync(path.join(path.dirname(binary), SCANNER_BINDING))) fail('the prebuilt daemon scanner bundle is missing.');
    if (values['require-scanner']) fail('a verified --scanner-bundle is required for this build.');
    return undefined;
  }
  const verified = await verifyScannerBundle(configured, target);
  if (binary) await verifyScannerBinding({ binary, bundle: configured, bindingFile: path.join(path.dirname(binary), SCANNER_BINDING), target });
  await verifyScannerSignatures(configured, target, process.env.EXTALIA_MAC_RELEASE_MODE === 'notarized');
  return { root: configured, manifestSha256: verified.manifestSha256 };
}

function ensureRustTarget(triple) {
  const installed = output(exe('rustup'), ['target', 'list', '--installed'], cargoEnv());
  if (installed?.split(/\r?\n/).includes(triple)) return;
  // Adds the target to the toolchain pinned in rust-toolchain.toml (contributor machines and CI only).
  run(exe('rustup'), ['target', 'add', triple], cargoEnv());
}

async function build(target, scanner) {
  if (target.triple !== hostTriple()) ensureRustTarget(target.triple);
  const env = { ...cargoEnv(), CARGO_PROFILE_RELEASE_STRIP: 'symbols' };
  // A caller's ambient value is never accepted as a verified production pin.
  delete env.EXTALIA_SKILLSPECTOR_MANIFEST_SHA256;
  if (scanner) env.EXTALIA_SKILLSPECTOR_MANIFEST_SHA256 = scanner.manifestSha256;
  run(exe('cargo'), ['build', '--release', '--locked', '-p', 'extalia-daemon', '--bin', 'extalia-daemon', '--target', target.triple], env);
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

async function stage(target, binary, scanner) {
  const kind = await readExecutableKind(binary).catch(error => fail(`cannot read ${binary}: ${error.message}`));
  if (kind?.platform !== target.platform || kind.arch !== target.arch) fail(`${binary} is ${kind ? `${kind.platform}-${kind.arch ?? 'unknown'}` : 'not an executable'}, expected ${target.platform}-${target.arch}.`);
  if (kind.platform === 'darwin') checkMacSignature(binary);
  const destinations = [];
  if (target.desktop) destinations.push({ binary: stagedBinary(target), scanner: path.join(ROOT, 'apps', 'desktop', 'build-resources', 'skillspector', `${target.builderOs}-${target.arch}`) });
  if (values.out) {
    const directory = path.resolve(values.out, `${target.platform}-${target.arch}`);
    destinations.push({ binary: path.join(directory, daemonBinaryName(target.platform)), scanner: path.join(directory, 'skillspector') });
  }
  for (const destination of destinations) {
    const directory = path.dirname(destination.binary);
    if (!scanner && (existsSync(destination.scanner) || existsSync(path.join(directory, SCANNER_BINDING)))) fail('a previous scanner distribution exists; rebuild with its verified --scanner-bundle or use a fresh output directory.');
    const destinationFile = destination.binary;
    const temporary = `${destinationFile}.${randomUUID()}.tmp`;
    await mkdir(directory, { recursive: true });
    let ownsTemporary = false;
    try {
      try { await copyFile(binary, temporary, constants.COPYFILE_EXCL); ownsTemporary = true; }
      catch (error) { if (error.code !== 'EEXIST') ownsTemporary = true; throw error; }
      await chmod(temporary, 0o755);
      await rename(temporary, destinationFile);
    } finally { if (ownsTemporary) await rm(temporary, { force: true }); }
    if (scanner) {
      await copyScannerBundle(scanner.root, destination.scanner, target, scanner.manifestSha256);
      await writeScannerBinding(path.join(directory, SCANNER_BINDING), await createScannerBinding(destinationFile, destination.scanner, target));
    }
  }
  const { size } = await stat(binary);
  const sha256 = createHash('sha256').update(await readFile(binary)).digest('hex');
  console.log(`extalia-daemon ${target.triple}: ${size} bytes (${(size / 1024 / 1024).toFixed(2)} MiB), sha256 ${sha256}`);
  for (const destination of destinations) console.log(`  staged ${path.relative(ROOT, destination.binary)}`);
  if (scanner) console.log(`  scanner manifest ${scanner.manifestSha256}`);
  // A binary for this machine must answer `hello` with the lockstep version (artifact downloads lose the
  // executable bit, so the staged copy is the one to run).
  const runnable = destinations[0]?.binary ?? (values.from ? undefined : binary);
  if (runnable && target.platform === process.platform && target.arch === process.arch) {
    const { version } = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
    const hello = await daemonHello(runnable).catch(error => fail(`hello failed: ${error.message}`));
    if (hello.daemonVersion !== version) fail(`daemon reports ${hello.daemonVersion}, expected ${version}.`);
    console.log(`  hello ok (daemonVersion ${hello.daemonVersion})`);
  }
}

for (const target of requestedTargets()) {
  const scanner = await scannerFor(target);
  await stage(target, values.from ? path.resolve(values.from) : await build(target, scanner), scanner);
}
