import { access, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { runCodexPermissions } from '../src/codexPermissions';
import type { CliHost } from '../src/cli';

const SESSION_ID = '11111111-1111-4111-8111-111111111111';

interface Plan { revision: string; nativeSessionId: string; configPath: string; undoCommand: string; applied: boolean; instructions: string; diff: string }

describe('extalia connect codex-permission CLI', () => {
  let root: string;
  let host: CliHost;
  let out: string[];
  let err: string[];
  let config: string;
  let extaliaHome: string;
  const original = '# Example configuration\nmodel = "example-model"\n';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-cli-codex-permission-'));
    const homeDirectory = path.join(root, 'home');
    extaliaHome = path.join(root, 'extalia-data');
    await mkdir(path.join(homeDirectory, '.codex'), { recursive: true });
    config = path.join(homeDirectory, '.codex', 'config.toml');
    await writeFile(config, original);
    out = []; err = [];
    host = {
      version: '0.0.0-test', out: value => out.push(value), err: value => err.push(value),
      readFile: file => readFile(file, 'utf8'), exists: file => access(file).then(() => true, () => false),
      platform: process.platform, arch: process.arch, nodeVersion: process.version,
      env: { EXTALIA_HOME: extaliaHome }, homeDirectory,
      start: async () => 0, update: async () => 0,
    };
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const args = () => ['--session', SESSION_ID];
  const plan = () => JSON.parse(out.at(-1)!) as Plan;

  it.each([[], ['--dry-run']].map(argv => ({ argv })))('defaults to a read-only scoped JSON preview', async ({ argv }) => {
    expect(await runCodexPermissions(host, [...args(), ...argv])).toBe(0);
    expect(err).toEqual([]);
    expect(plan()).toMatchObject({ nativeSessionId: SESSION_ID, configPath: config, applied: false });
    expect(plan().diff).toContain('--session');
    expect(plan().instructions).toContain(`--apply ${plan().revision}`);
    expect(plan().undoCommand).toContain('--session');
    expect(plan().undoCommand).toContain(SESSION_ID);
    expect(plan().undoCommand).toContain('--codex-home');
    expect(plan().undoCommand).toContain('--undo');
    expect(await readFile(config, 'utf8')).toBe(original);
    await expect(stat(extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses CODEX_HOME when set', async () => {
    const codexHome = path.join(root, 'environment-codex');
    host.env = { ...host.env, CODEX_HOME: codexHome };
    expect(await runCodexPermissions(host, args())).toBe(0);
    expect(plan().configPath).toBe(path.join(codexHome, 'config.toml'));
    await expect(stat(codexHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('uses an explicit absolute Codex home and quotes executable undo arguments', async () => {
    const codexHome = path.join(root, "custom codex's home");
    host.env = { ...host.env, CODEX_HOME: path.join(root, 'unused-codex') };
    expect(await runCodexPermissions(host, [...args(), '--codex-home', codexHome])).toBe(0);
    expect(plan().configPath).toBe(path.join(codexHome, 'config.toml'));
    const quoted = host.platform === 'win32' ? `"${codexHome}"` : `'${codexHome.replace(/'/g, `'\\''`)}'`;
    expect(plan().undoCommand).toContain(`--codex-home ${quoted}`);
  });

  it('applies only the exact reviewed revision and previews undo before applying it', async () => {
    expect(await runCodexPermissions(host, args())).toBe(0);
    const preview = plan();
    expect(await runCodexPermissions(host, [...args(), '--apply', preview.revision])).toBe(0);
    expect(plan().applied).toBe(true);
    const token = await readFile(path.join(extaliaHome, 'hooks', 'codex-permission-token'), 'utf8');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    expect(out.join('\n')).not.toContain(token);
    const installed = await readFile(config, 'utf8');
    expect(installed).toContain(`--session`);
    expect(installed).toContain(SESSION_ID);
    expect(await runCodexPermissions(host, [...args(), '--undo'])).toBe(0);
    const undo = plan();
    expect(undo.applied).toBe(false);
    expect(await readFile(config, 'utf8')).toBe(installed);
    expect(await runCodexPermissions(host, [...args(), '--undo', '--apply', undo.revision])).toBe(0);
    expect(plan().applied).toBe(true);
    expect(await readFile(config, 'utf8')).toBe(original);
    expect(await readFile(path.join(extaliaHome, 'hooks', 'codex-permission-token'), 'utf8')).toBe(token);
  });

  it('refuses a stale revision after configuration changes', async () => {
    await runCodexPermissions(host, args());
    const preview = plan();
    await writeFile(config, `${original}# Changed since preview\n`);
    expect(await runCodexPermissions(host, [...args(), '--apply', preview.revision])).toBe(1);
    expect(err.at(-1)).toContain('Review and approve');
    expect(await readFile(config, 'utf8')).toBe(`${original}# Changed since preview\n`);
    await expect(stat(path.join(extaliaHome, 'hooks', 'codex-permission-token'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses reusing an approved revision for another native conversation', async () => {
    await runCodexPermissions(host, args());
    expect(await runCodexPermissions(host, ['--session', '22222222-2222-4222-8222-222222222222', '--apply', plan().revision])).toBe(1);
    expect(await readFile(config, 'utf8')).toBe(original);
  });

  it.each([
    [], ['--session', 'not-a-uuid'], ['--session'], ['--session', SESSION_ID, '--trust'], ['--session', SESSION_ID, '--yes'],
    ['--session', SESSION_ID, '--session', SESSION_ID], ['--session', SESSION_ID, '--apply', 'invalid-revision'],
    ['--session', SESSION_ID, '--dry-run', '--apply', 'a'.repeat(64)], ['--session', SESSION_ID, '--codex-home', 'relative-directory'],
  ].map(argv => ({ argv })))('rejects invalid or ambiguous arguments without configuration writes', async ({ argv }) => {
    expect(await runCodexPermissions(host, argv)).toBe(2);
    expect(out).toEqual([]);
    expect(err.length).toBe(1);
    expect(await readFile(config, 'utf8')).toBe(original);
    await expect(stat(extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
