import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { environmentValue, executablePathDirectories, findExecutable, isExecutableFile } from '../src/executableDiscovery.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'extalia-executable-discovery-')); roots.push(root);
  const file = async (...parts: string[]) => {
    const target = path.join(root, ...parts); await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, 'temporary executable fixture', { mode: 0o755 }); return target;
  };
  return { root, file, check: (target: string) => target.startsWith(root + path.sep) ? isExecutableFile(target) : Promise.resolve(false) };
}

describe('filesystem-only executable discovery', () => {
  it('handles Windows environment casing, quoted PATH entries, PATHEXT and a directory containing spaces', async () => {
    const expected = String.raw`C:\Tools Folder\hermes.cmd`, seen: string[] = [];
    expect(await findExecutable('hermes', { platform: 'win32', env: { Path: String.raw`relative;;"C:\Tools Folder"`, PathExt: '.EXE;.CMD' }, includeFallbacks: false,
      check: async candidate => { seen.push(candidate); return candidate === expected; } })).toBe(expected);
    expect(seen.every(candidate => candidate.startsWith('C:\\Tools Folder\\'))).toBe(true);
    expect(environmentValue({ Path: 'one' }, 'PATH', 'win32')).toBe('one');
    expect(environmentValue({ Path: 'one' }, 'PATH', 'linux')).toBeUndefined();
  });

  it('honors valid explicit overrides and refuses invalid ones instead of falling back', async () => {
    const f = await fixture(), expected = await f.file('bin', 'hermes');
    const options = { env: { PATH: path.dirname(expected) }, platform: process.platform, check: f.check };
    expect(await findExecutable('hermes', { ...options, override: expected })).toBe(expected);
    expect(await findExecutable('hermes', { ...options, override: path.join(f.root, 'missing') })).toBeUndefined();
    expect(await findExecutable('hermes', { ...options, override: 'relative' })).toBeUndefined();
    expect(await findExecutable('hermes', { ...options, override: '' })).toBeUndefined();
  });

  it.each(['npm_config_prefix', 'PNPM_HOME', 'BUN_INSTALL', 'UV_TOOL_BIN_DIR', 'PIPX_BIN_DIR', 'PIP_USER_BASE'])('finds GUI-installed commands under %s without executing a probe', async manager => {
    const f = await fixture(), base = path.join(f.root, 'manager');
    const suffix = ['npm_config_prefix', 'BUN_INSTALL', 'PIP_USER_BASE'].includes(manager) ? ['bin'] : [];
    const expected = await f.file('manager', ...suffix, 'example-cli');
    expect(await findExecutable('example-cli', { env: { [manager]: base, HOME: path.join(f.root, 'home') }, platform: 'linux', check: f.check })).toBe(expected);
  });

  it.each([
    ['hermes', String.raw`C:\Local\hermes\bin\hermes.exe`],
    ['hermes', String.raw`C:\Roaming\npm\hermes.cmd`],
    ['hermes', String.raw`C:\Local\hermes\hermes-agent\venv\Scripts\hermes.exe`],
    ['codex', String.raw`C:\Local\pnpm\codex.cmd`],
    ['node', String.raw`C:\Program Files\nodejs\node.exe`],
  ])('finds a known Windows GUI installation for %s at %s', async (name, expected) => {
    expect((await findExecutable(name, { env: { LocalAppData: String.raw`C:\Local`, AppData: String.raw`C:\Roaming`, ProgramFiles: String.raw`C:\Program Files` },
      platform: 'win32', check: async target => target.toLowerCase() === expected.toLowerCase() }))?.toLowerCase()).toBe(expected.toLowerCase());
  });

  it('keeps PATH precedence over GUI fallbacks and excludes relative/current-directory lookups', async () => {
    const f = await fixture(), expected = await f.file('first', 'example-cli');
    await f.file('home', '.local', 'bin', 'example-cli');
    expect(await findExecutable('example-cli', { env: { PATH: ['', '.', 'relative', path.dirname(expected)].join(path.delimiter) },
      platform: process.platform, homeDirectory: path.join(f.root, 'home'), check: f.check })).toBe(expected);
    expect(executablePathDirectories({ PATH: 'relative:.:/tmp/example' }, 'linux')).toEqual(['/tmp/example']);
  });

  it('recognizes extensionless Windows executables but never accepts a directory as an executable', async () => {
    const expected = String.raw`C:\Tools\hermes`;
    expect(await findExecutable('hermes', { env: { Path: String.raw`C:\Tools`, PATHEXT: '' }, platform: 'win32', includeFallbacks: false,
      check: async candidate => candidate === expected })).toBe(expected);
    const f = await fixture();
    expect(await isExecutableFile(f.root)).toBe(false);
  });

  it('honors a custom Windows npm prefix without using a shell or probing npm configuration', async () => {
    const expected = String.raw`D:\Custom npm\codex.cmd`;
    expect(await findExecutable('codex', { env: { NPM_CONFIG_PREFIX: String.raw`D:\Custom npm` }, platform: 'win32',
      check: async candidate => candidate === expected })).toBe(expected);
  });

  it.each(['named-profile', 'managed-venv', 'home-localappdata'] as const)('finds a Hermes GUI executable using %s without opening profile files', async source => {
    const f = await fixture(), home = path.join(f.root, 'home');
    const expected = source === 'home-localappdata' ? await f.file('home', 'AppData', 'Local', 'hermes', 'bin', 'hermes.exe')
      : source === 'managed-venv' ? await f.file('custom', 'hermes-agent', 'venv', 'Scripts', 'hermes.exe')
        : await f.file('custom', 'bin', 'hermes.exe');
    const HERMES_HOME = source === 'home-localappdata' ? undefined : path.join(f.root, 'custom', 'profiles', 'example');
    expect((await findExecutable('hermes', { env: { HERMES_HOME }, platform: 'win32', homeDirectory: home, check: f.check }))?.toLowerCase()).toBe(expected.toLowerCase());
  });

  it.skipIf(process.platform === 'win32')('ignores a file without executable permission on POSIX', async () => {
    const f = await fixture(), target = await f.file('bin', 'hermes'); await chmod(target, 0o644);
    expect(await findExecutable('hermes', { env: { PATH: path.dirname(target) }, platform: process.platform, includeFallbacks: false })).toBeUndefined();
  });
});
