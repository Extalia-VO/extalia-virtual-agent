#!/usr/bin/env node
/**
 * Generate the per-platform npm packages that carry `extalia-daemon` for the CLI
 * (ADR 0021, owner decision 9), and optionally a publish-ready `extalia-vo` folder.
 * Nothing is published here; release CI packs the folders as artifacts.
 *
 *   node apps/cli/npm/generate.mjs --binaries <dir> [--out <dir>] [--require-all] [--cli]
 *
 * <dir> holds `<platform>-<arch>/extalia-daemon[.exe]` (the layout of
 * `tooling/build-daemon.mjs --out <dir>` and of the release artifacts). Each package
 * `@extalia/daemon-<platform>-<arch>` declares `os`/`cpu` (and `libc` on Linux), so npm
 * installs only the matching one, and its main module exports the binary's absolute path.
 * Versions are the root version (lockstep). Default output: apps/cli/npm/dist/ (git-ignored).
 *
 * `--cli` also writes <out>/extalia-vo/: the built CLI (`apps/cli/dist`, README, LICENSE)
 * with a manifest that lists every platform package as an optional dependency at the same
 * version and drops the workspace-only `dependencies` (esbuild bundles them). The repository
 * manifest does not list the optional dependencies yet: the `@extalia` npm scope is not
 * reserved, and an unresolvable optional dependency would let whoever claims it ship code
 * into every contributor's `pnpm install`.
 */
import { spawnSync } from 'node:child_process';
import { chmod, copyFile, cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DAEMON_TARGETS, daemonBinaryName, npmPackageName, readExecutableKind } from '../../../tooling/daemon.mjs';
import { ROOT } from '../../../tooling/workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..');
const { values } = parseArgs({
  options: {
    binaries: { type: 'string' },
    out: { type: 'string', default: path.join(HERE, 'dist') },
    'require-all': { type: 'boolean', default: false },
    cli: { type: 'boolean', default: false },
  },
});
function fail(message) { console.error(`npm generate: ${message}`); process.exit(1); }
if (!values.binaries) fail('--binaries <dir> is required.');

const root = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));
const cli = JSON.parse(await readFile(path.join(CLI, 'package.json'), 'utf8'));
const version = root.version;
if (cli.version !== version) fail(`apps/cli is ${cli.version}, root is ${version}; run node tooling/check-versions.mjs.`);
const repository = { type: 'git', url: 'git+https://github.com/Extalia-VO/extalia-virtual-agent.git' };
const fill = (text, values) => text.replace(/\{\{(\w+)\}\}/g, (_, key) => values[key] ?? fail(`template field ${key} has no value`));
const templates = {
  index: await readFile(path.join(HERE, 'platform', 'index.js.template'), 'utf8'),
  readme: await readFile(path.join(HERE, 'platform', 'README.md.template'), 'utf8'),
};

const out = path.resolve(values.out);
await mkdir(out, { recursive: true });
const generated = [];
for (const target of DAEMON_TARGETS) {
  const binaryName = daemonBinaryName(target.platform);
  const source = path.resolve(values.binaries, `${target.platform}-${target.arch}`, binaryName);
  if (!(await stat(source).catch(() => undefined))?.isFile()) {
    if (values['require-all']) fail(`missing ${path.relative(process.cwd(), source)}`);
    console.log(`skip ${npmPackageName(target)}: no binary at ${path.relative(process.cwd(), source)}`);
    continue;
  }
  const kind = await readExecutableKind(source);
  if (kind?.platform !== target.platform || kind.arch !== target.arch) fail(`${source} is ${kind ? `${kind.platform}-${kind.arch}` : 'not an executable'}, expected ${target.platform}-${target.arch}`);

  const name = npmPackageName(target);
  const dir = path.join(out, `daemon-${target.platform}-${target.arch}`);
  await rm(dir, { recursive: true, force: true });
  await mkdir(path.join(dir, 'bin'), { recursive: true });
  const fields = { name, version, platform: target.platform, arch: target.arch, triple: target.triple, binary: binaryName };
  const manifest = {
    name,
    version,
    description: `The extalia-daemon binary for ${target.platform}-${target.arch}. Installed by extalia-vo; not meant to be used directly.`,
    license: 'MIT',
    repository: { ...repository, directory: 'crates/extalia-daemon' },
    os: [target.platform],
    cpu: [target.arch],
    // The Linux builds link glibc; npm and pnpm skip them on musl systems.
    ...(target.platform === 'linux' ? { libc: ['glibc'] } : {}),
    main: 'index.js',
    exports: { '.': './index.js', './package.json': './package.json' },
    files: ['index.js', 'bin', 'README.md', 'LICENSE'],
    preferUnplugged: true,
  };
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  await writeFile(path.join(dir, 'index.js'), fill(templates.index, fields));
  await writeFile(path.join(dir, 'README.md'), fill(templates.readme, fields));
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
  await copyFile(source, path.join(dir, 'bin', binaryName));
  // npm keeps the executable bit in the tarball (as other per-platform binary packages rely on).
  await chmod(path.join(dir, 'bin', binaryName), 0o755);
  generated.push(name);
  console.log(`generated ${name}@${version} in ${path.relative(process.cwd(), dir)}`);
}

if (values.cli) {
  const dist = path.join(CLI, 'dist');
  if (!(await stat(path.join(dist, 'extalia.mjs')).catch(() => undefined))) fail('apps/cli/dist/extalia.mjs is missing; run pnpm build first.');
  const checked = spawnSync(process.execPath, [path.join(ROOT, 'tooling', 'check-no-models.mjs'), dist], { stdio: 'inherit' });
  if (checked.status !== 0) process.exit(checked.status ?? 1);
  const dir = path.join(out, 'extalia-vo');
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await cp(dist, path.join(dir, 'dist'), { recursive: true });
  await copyFile(path.join(CLI, 'README.md'), path.join(dir, 'README.md'));
  await copyFile(path.join(ROOT, 'LICENSE'), path.join(dir, 'LICENSE'));
  // `private` is kept from the repository manifest: publishing stays a maintainer decision (ADR 0006).
  const { dependencies: _bundled, devDependencies: _dev, scripts: _scripts, ...rest } = cli;
  const optionalDependencies = Object.fromEntries(DAEMON_TARGETS.map(target => [npmPackageName(target), version]));
  await writeFile(path.join(dir, 'package.json'), `${JSON.stringify({ ...rest, files: ['dist', 'README.md', 'LICENSE'], optionalDependencies }, null, 2)}\n`);
  console.log(`generated extalia-vo@${version} in ${path.relative(process.cwd(), dir)} (optional dependencies: ${Object.keys(optionalDependencies).join(', ')})`);
}

if (!generated.length && !values.cli) fail('nothing generated.');
