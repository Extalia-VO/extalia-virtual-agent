#!/usr/bin/env node
/**
 * Rust gate (ADR 0021, part of `pnpm check`): formatting, clippy with warnings denied
 * and the test suites, all against the committed Cargo.lock. Uses cargo from PATH or
 * from rustup's default location; rust-toolchain.toml selects the pinned toolchain.
 *
 * `--build-daemon` only builds the debug `extalia-daemon`, which `pnpm check` runs before
 * Vitest so the host suites also run against the real daemon (audit PR 8).
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT } from './workspace.mjs';

const executable = process.platform === 'win32' ? 'cargo.exe' : 'cargo';

function findCargo() {
  if (spawnSync(executable, ['--version'], { stdio: 'ignore' }).status === 0) return { cargo: executable, bin: undefined };
  const bin = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin');
  const candidate = path.join(bin, executable);
  return existsSync(candidate) ? { cargo: candidate, bin } : undefined;
}

if (!existsSync(path.join(ROOT, 'Cargo.toml'))) {
  console.log('No Cargo workspace; Rust checks skipped.');
  process.exit(0);
}
const found = findCargo();
if (!found) {
  console.error([
    'Rust checks need cargo, which was not found on PATH or in ~/.cargo/bin.',
    'Install rustup from https://rustup.rs (Windows: rustup-init.exe), then run this check again;',
    'rust-toolchain.toml installs the pinned toolchain with rustfmt and clippy on first use.',
  ].join('\n'));
  process.exit(1);
}

// rustup's proxies (rustc, rustfmt, clippy-driver) live next to cargo.
const env = { ...process.env, ...(found.bin ? { PATH: `${found.bin}${path.delimiter}${process.env.PATH ?? ''}` } : {}) };
if (process.platform === 'darwin' && !env.CC) env.CC = 'clang';
const buildOnly = process.argv.includes('--build-daemon');
const steps = buildOnly ? [['build', '-p', 'extalia-daemon', '--locked']] : [
  ['fmt', '--all', '--check'],
  ['clippy', '--workspace', '--all-targets', '--locked', '--features', 'extalia-daemon/test-fixtures', '--', '-D', 'warnings'],
  ['test', '--workspace', '--locked', '--features', 'extalia-daemon/test-fixtures'],
];
for (const args of steps) {
  console.log(`$ cargo ${args.join(' ')}`);
  const result = spawnSync(found.cargo, args, { cwd: ROOT, env, stdio: 'inherit' });
  if (result.error) { console.error(`cargo ${args[0]} could not start: ${result.error.message}`); process.exit(1); }
  if (result.status !== 0) { console.error(`Rust check failed: cargo ${args[0]}.`); process.exit(result.status ?? 1); }
}
console.log(buildOnly ? 'Debug daemon built.' : 'Rust checks passed.');
