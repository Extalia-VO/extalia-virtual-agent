import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveNodePath, type NodeRuntimeOptions } from '../src/connect/nodeRuntime.js';
import { isExecutable } from '../src/connect/util.js';

describe('Node discovery for GUI hook commands', () => {
  let root: string;
  let home: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-node-discovery-'));
    home = path.join(root, 'home');
    await mkdir(home);
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  async function node(file: string) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, 'temporary executable fixture', { mode: 0o755 });
    return file;
  }
  function options(overrides: Partial<NodeRuntimeOptions> = {}): NodeRuntimeOptions {
    return {
      electron: true, execPath: path.join(root, 'Extalia'), env: {}, platform: 'darwin', homeDirectory: home,
      // Tests must not discover Node installed on the machine running them.
      executable: file => file.startsWith(`${root}${path.sep}`) ? isExecutable(file) : Promise.resolve(false),
      ...overrides,
    };
  }

  it('prefers an absolute PATH executable to known GUI locations and skips relative PATH entries', async () => {
    const expected = await node(path.join(root, 'path-bin', 'node'));
    await node(path.join(home, '.local', 'bin', 'node'));
    expect(await resolveNodePath(options({ platform: process.platform, env: { PATH: ['relative', path.dirname(expected)].join(path.delimiter), PATHEXT: '' } }))).toBe(expected);
  });

  it('finds Herd in a path containing spaces and prefers the newest exact semver', async () => {
    const versions = path.join(home, 'Library', 'Application Support', 'Herd', 'config', 'nvm', 'versions', 'node');
    await node(path.join(versions, 'v9.99.99', 'bin', 'node'));
    await node(path.join(versions, 'v22.9.0', 'bin', 'node'));
    const expected = await node(path.join(versions, 'v22.12.0', 'bin', 'node'));
    await node(path.join(versions, 'v99.0.0-preview', 'bin', 'node'));
    expect(await resolveNodePath(options())).toBe(expected);
  });

  it('finds a normal nvm installation', async () => {
    const expected = await node(path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin', 'node'));
    expect(await resolveNodePath(options())).toBe(expected);
  });

  it('honors an absolute NVM_DIR before the default nvm home', async () => {
    const configured = path.join(root, 'custom nvm');
    const expected = await node(path.join(configured, 'versions', 'node', 'v22.1.0', 'bin', 'node'));
    await node(path.join(home, '.nvm', 'versions', 'node', 'v24.1.0', 'bin', 'node'));
    expect(await resolveNodePath(options({ env: { NVM_DIR: configured } }))).toBe(expected);
  });

  it('honors an absolute VOLTA_HOME and checks known Homebrew paths first', async () => {
    const volta = path.join(root, 'volta');
    const expected = await node(path.join(volta, 'bin', 'node'));
    expect(await resolveNodePath(options({ env: { VOLTA_HOME: volta } }))).toBe(expected);
    const systemNode = path.join('/opt/homebrew/bin', 'node');
    expect(await resolveNodePath(options({ env: { VOLTA_HOME: volta }, executable: async file => file === systemNode || file === expected }))).toBe(systemNode);
  });

  it('ignores a non-executable candidate and continues discovery', async () => {
    const blocked = await node(path.join(home, '.volta', 'bin', 'node'));
    if (process.platform !== 'win32') await chmod(blocked, 0o644);
    const expected = await node(path.join(home, '.local', 'bin', 'node'));
    expect(await resolveNodePath(options({ executable: file => file === blocked ? Promise.resolve(false) : file.startsWith(`${root}${path.sep}`) ? isExecutable(file) : Promise.resolve(false) }))).toBe(expected);
  });

  it('returns undefined when no Node exists and ignores relative manager overrides', async () => {
    expect(await resolveNodePath(options({ env: { NVM_DIR: 'relative', VOLTA_HOME: 'relative' } }))).toBeUndefined();
  });

  it('preserves the existing runtime for a non-Electron host', async () => {
    const execPath = path.join(root, 'bridge-node');
    expect(await resolveNodePath(options({ electron: false, execPath }))).toBe(execPath);
  });

  it('does not inspect macOS fallback locations on another platform', async () => {
    await node(path.join(home, '.local', 'bin', 'node'));
    expect(await resolveNodePath(options({ platform: 'linux' }))).toBeUndefined();
  });

  it('rejects the Electron executable when it is also a PATH candidate', async () => {
    const execPath = await node(path.join(root, 'node'));
    expect(await resolveNodePath(options({ platform: process.platform, execPath, env: { PATH: root, PATHEXT: '' } }))).toBeUndefined();
  });

  it.skipIf(process.platform === 'win32')('rejects Electron even when a PATH node symlink points to it', async () => {
    const execPath = await node(path.join(root, 'electron'));
    const directory = path.join(root, 'bin');
    await mkdir(directory);
    await symlink(execPath, path.join(directory, 'node'));
    expect(await resolveNodePath(options({ execPath, env: { PATH: directory } }))).toBeUndefined();
  });
});
