import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parse } from 'smol-toml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CODEX_PERMISSION_FORWARDER_SOURCE, codexPermissionTokenFile } from '../src/connect/codexPermissionForwarder.js';
import {
  applyCodexPermissionHookSetup, CODEX_PERMISSION_BEGIN_MARKER, previewCodexPermissionHookSetup, previewCodexPermissionHookUndo, undoCodexPermissionHookSetup,
  type CodexPermissionHookSetupOptions,
} from '../src/connect/codexPermissionHookSetup.js';
import { quoteArgument } from '../src/connect/util.js';

describe('Codex synchronous permission hook setup', () => {
  let root: string;
  let options: CodexPermissionHookSetupOptions;
  let config: string;
  const original = '# User configuration\nmodel = "example-model"\n\n[[hooks.PermissionRequest]]\nmatcher = "Bash"\nhooks = [{type="command",command="notify-example",async=true,timeout=5}]\n\n[hooks.state."existing-hook"]\ntrusted_hash = "existing-trust"\n';
  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'extalia-permission-setup-'));
    options = { extaliaHome: path.join(root, 'data'), codexHome: path.join(root, 'codex'), nodePath: process.execPath, platform: process.platform, nativeSessionId: '11111111-1111-4111-8111-111111111111' };
    await mkdir(options.codexHome);
    config = path.join(options.codexHome, 'config.toml');
    await writeFile(config, original);
  });
  afterEach(async () => { await rm(root, { force: true, recursive: true }); });

  it('previews exact configuration and stable standalone script without creating data or token files', async () => {
    const preview = await previewCodexPermissionHookSetup(options);
    expect(preview.changed).toBe(true);
    expect(preview.needsTrust).toBe(true);
    expect(preview.diff).toContain('async = false, timeout = 65');
    expect(preview.diff).toContain('codex-permission.mjs');
    expect(preview.nativeSessionId).toBe(options.nativeSessionId);
    expect(preview.diff).toContain('--session');
    expect(preview.diff).toContain(options.nativeSessionId);
    expect(preview.diff).not.toMatch(/^\+.*trusted_hash =/m);
    expect(preview.createsPermissionToken).toBe(true);
    expect(await readFile(config, 'utf8')).toBe(original);
    await expect(stat(options.extaliaHome)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('requires the exact approved revision and refuses later edits', async () => {
    const preview = await previewCodexPermissionHookSetup(options);
    await expect(applyCodexPermissionHookSetup(options, '')).rejects.toThrow('Review and approve');
    await writeFile(config, `${original}# Concurrent edit\n`);
    await expect(applyCodexPermissionHookSetup(options, preview.revision)).rejects.toThrow('Review and approve');
    expect(await readFile(config, 'utf8')).toBe(`${original}# Concurrent edit\n`);
    await expect(stat(codexPermissionTokenFile(options.extaliaHome))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps unrelated credential context out of install and removal previews', async () => {
    const source = `${original}\n[mcp_servers.example.env]\nEXAMPLE_SECRET = "synthetic-private-credential"\n`;
    await writeFile(config, source);
    const preview = await previewCodexPermissionHookSetup(options);
    expect(preview.diff).not.toContain('synthetic-private-credential');
    await applyCodexPermissionHookSetup(options, preview.revision);
    const removal = await previewCodexPermissionHookUndo(options);
    expect(removal.diff).not.toContain('synthetic-private-credential');
    await undoCodexPermissionHookSetup(options, removal.revision);
    expect(await readFile(config, 'utf8')).toBe(source);
  });

  it.each(['', 'native-session', '11111111-1111-4111-8111-111111111111 --global', undefined])('refuses missing or malformed native UUID scope', async nativeSessionId => {
    const invalid = { ...options, nativeSessionId } as CodexPermissionHookSetupOptions;
    await expect(previewCodexPermissionHookSetup(invalid)).rejects.toThrow('conversation UUID');
    await expect(applyCodexPermissionHookSetup(invalid, 'unapproved')).rejects.toThrow('conversation UUID');
    expect(await readFile(config, 'utf8')).toBe(original);
  });

  it('binds approval and the installed invocation to the exact selected native conversation', async () => {
    const preview = await previewCodexPermissionHookSetup(options);
    const other = { ...options, nativeSessionId: '22222222-2222-4222-8222-222222222222' };
    expect((await previewCodexPermissionHookSetup(other)).revision).not.toBe(preview.revision);
    await expect(applyCodexPermissionHookSetup(other, preview.revision)).rejects.toThrow('Review and approve');
    await applyCodexPermissionHookSetup(options, preview.revision);
    const parsed = parse(await readFile(config, 'utf8')) as { hooks: { PermissionRequest: Array<{ hooks: Array<{ command: string }> }> } };
    expect(parsed.hooks.PermissionRequest[1]!.hooks[0]!.command).toContain(`--session ${quoteArgument(options.nativeSessionId, options.platform)}`);
    await expect(undoCodexPermissionHookSetup(other)).rejects.toThrow('different native conversation');
  });

  it('preserves telemetry and trust, creates a separate private token and reuses it', async () => {
    const preview = await previewCodexPermissionHookSetup(options);
    await applyCodexPermissionHookSetup(options, preview.revision);
    const current = await readFile(config, 'utf8');
    expect(current.startsWith(original)).toBe(true);
    const parsed = parse(current) as { hooks: { PermissionRequest: Array<{ hooks: Array<{ async: boolean; timeout: number }> }>; state: unknown } };
    expect(parsed.hooks.PermissionRequest).toHaveLength(2);
    expect(parsed.hooks.PermissionRequest[0]!.hooks[0]!.async).toBe(true);
    expect(parsed.hooks.PermissionRequest[1]!.hooks[0]).toMatchObject({ async: false, timeout: 65 });
    expect(parsed.hooks.state).toEqual({ 'existing-hook': { trusted_hash: 'existing-trust' } });
    const token = await readFile(codexPermissionTokenFile(options.extaliaHome), 'utf8');
    expect(token).toMatch(/^[a-f0-9]{64}$/);
    if (process.platform !== 'win32') expect((await stat(codexPermissionTokenFile(options.extaliaHome))).mode & 0o777).toBe(0o600);
    expect(await readFile(preview.forwarderPath, 'utf8')).toBe(CODEX_PERMISSION_FORWARDER_SOURCE);
    expect(await readFile(path.join(preview.backupDirectory, '0.before'), 'utf8')).toBe(original);
    const next = await previewCodexPermissionHookSetup(options);
    expect(next.changed).toBe(false);
    await applyCodexPermissionHookSetup(options, next.revision);
    expect(await readFile(codexPermissionTokenFile(options.extaliaHome), 'utf8')).toBe(token);
    expect((await readdir(path.join(options.extaliaHome, 'connect'))).includes('journal.json')).toBe(false);
  });

  it('keeps independent canonical-profile receipts and selectively undoes each installation', async () => {
    const second = { ...options, codexHome: path.join(root, 'second-profile'), nativeSessionId: '22222222-2222-4222-8222-222222222222' };
    await mkdir(second.codexHome);
    const secondConfig = path.join(second.codexHome, 'config.toml');
    const secondOriginal = '# Independent example profile\nmodel = "another-example-model"\n';
    await writeFile(secondConfig, secondOriginal);
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    await applyCodexPermissionHookSetup(second, (await previewCodexPermissionHookSetup(second)).revision);
    const receiptRoot = path.join(options.extaliaHome, 'connect', 'codex-permissions');
    const receiptIds = await readdir(receiptRoot);
    expect(receiptIds).toHaveLength(2);
    for (const id of receiptIds) expect(id).toMatch(/^[a-f0-9]{64}$/);
    expect((await previewCodexPermissionHookSetup(options)).changed).toBe(false);
    expect((await previewCodexPermissionHookSetup(second)).changed).toBe(false);
    const secondInstalled = await readFile(secondConfig, 'utf8');
    const undo = await previewCodexPermissionHookUndo(options);
    const firstInstalled = await readFile(config, 'utf8');
    await undoCodexPermissionHookSetup(options, undo.revision);
    expect(await readFile(config, 'utf8')).toBe(original);
    expect(await readFile(secondConfig, 'utf8')).toBe(secondInstalled);
    expect(await readFile(path.join(undo.backupDirectory, '0.before'), 'utf8')).toBe(firstInstalled);
    const remaining = await Promise.all(receiptIds.map(id => stat(path.join(receiptRoot, id, 'receipt.json')).then(() => true, () => false)));
    expect(remaining.filter(Boolean)).toHaveLength(1);
    const secondUndo = await previewCodexPermissionHookUndo(second);
    await undoCodexPermissionHookSetup(second, secondUndo.revision);
    expect(await readFile(secondConfig, 'utf8')).toBe(secondOriginal);
  });

  it('uses the same receipt for aliases of the canonical profile directory', async () => {
    if (process.platform === 'win32') return;
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const alias = path.join(root, 'profile-alias');
    await symlink(options.codexHome, alias);
    const aliased = { ...options, codexHome: alias };
    await applyCodexPermissionHookSetup(aliased, (await previewCodexPermissionHookSetup(aliased)).revision);
    expect(await readdir(path.join(options.extaliaHome, 'connect', 'codex-permissions'))).toHaveLength(1);
    const undo = await previewCodexPermissionHookUndo(aliased);
    await undoCodexPermissionHookSetup(aliased, undo.revision);
    expect(await readFile(config, 'utf8')).toBe(original);
  });

  it('previews and applies removal without installation prerequisites', async () => {
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    await writeFile(path.join(options.codexHome, 'hooks.json'), '{"hooks":{}}');
    await writeFile(path.join(options.extaliaHome, 'hooks', 'codex-permission.mjs'), '// Unrecognized local script\n');
    await rm(codexPermissionTokenFile(options.extaliaHome));
    const undoOptions = { extaliaHome: options.extaliaHome, codexHome: options.codexHome, nativeSessionId: options.nativeSessionId, platform: options.platform };
    const undo = await previewCodexPermissionHookUndo(undoOptions);
    expect(undo.changed).toBe(true);
    expect(undo.createsPermissionToken).toBe(false);
    expect(undo.diff).toContain(CODEX_PERMISSION_BEGIN_MARKER);
    await undoCodexPermissionHookSetup(undoOptions, undo.revision);
    expect(await readFile(config, 'utf8')).toBe(original);
    expect(await readFile(path.join(options.codexHome, 'hooks.json'), 'utf8')).toBe('{"hooks":{}}');
  });

  it('retains the configuration-target guard within a canonical profile receipt', async () => {
    if (process.platform === 'win32') return;
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const other = path.join(root, 'other-config.toml');
    await writeFile(other, original);
    await rm(config);
    await symlink(other, config);
    await expect(previewCodexPermissionHookUndo(options)).rejects.toThrow('link target changed');
    const preview = await previewCodexPermissionHookSetup(options);
    await expect(applyCodexPermissionHookSetup(options, preview.revision)).rejects.toThrow('link target changed');
    expect(await readFile(other, 'utf8')).toBe(original);
  });

  it('refuses removing an extant scoped block without its matching profile receipt', async () => {
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const edited = `${await readFile(config, 'utf8')}\n# Preserve settings added after installation\n`;
    await writeFile(config, edited);
    const other = { ...options, extaliaHome: path.join(root, 'other-extalia-data'), nativeSessionId: '22222222-2222-4222-8222-222222222222' };
    await expect(previewCodexPermissionHookUndo(other)).rejects.toThrow('original EXTALIA_HOME');
    await expect(undoCodexPermissionHookSetup(other, 'unreviewed')).rejects.toThrow('receipt');
    expect(await readFile(config, 'utf8')).toBe(edited);
    const receiptRoot = path.join(options.extaliaHome, 'connect', 'codex-permissions');
    const [profile] = await readdir(receiptRoot);
    await rm(path.join(receiptRoot, profile!, 'receipt.json'));
    await expect(previewCodexPermissionHookUndo({ ...options, nativeSessionId: other.nativeSessionId })).rejects.toThrow('receipt');
    await expect(previewCodexPermissionHookUndo(options)).rejects.toThrow('receipt');
    expect(await readFile(config, 'utf8')).toBe(edited);
  });

  it('previews removal, requires its current revision, and restores original bytes', async () => {
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const installed = await readFile(config, 'utf8');
    const undo = await undoCodexPermissionHookSetup(options);
    expect(undo.changed).toBe(true);
    expect(await readFile(config, 'utf8')).toBe(installed);
    await expect(undoCodexPermissionHookSetup(options, 'not-approved')).rejects.toThrow('Review and approve');
    await undoCodexPermissionHookSetup(options, undo.revision);
    expect(await readFile(config, 'utf8')).toBe(original);
    // Existing in-flight hooks can finish; no token rotation or script removal during undo.
    expect(await readFile(codexPermissionTokenFile(options.extaliaHome), 'utf8')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('removes only the dedicated handler when the user edited other configuration', async () => {
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    await writeFile(config, `${await readFile(config, 'utf8')}\n# Added later\n`);
    const undo = await undoCodexPermissionHookSetup(options);
    await undoCodexPermissionHookSetup(options, undo.revision);
    const after = await readFile(config, 'utf8');
    expect(after).not.toContain(CODEX_PERMISSION_BEGIN_MARKER);
    expect(after).toContain('# Added later');
    expect(after).toContain('notify-example');
  });

  it('preserves user changes across a later setup apply and exact undo', async () => {
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    await writeFile(config, `${await readFile(config, 'utf8')}\n# Added between installations\n`);
    // Changing the Node path requires replacing the hook definition and reviewing it again.
    options.nodePath = path.join(root, 'new-node');
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const undo = await undoCodexPermissionHookSetup(options);
    await undoCodexPermissionHookSetup(options, undo.revision);
    expect(await readFile(config, 'utf8')).toContain('# Added between installations');
    expect(await readFile(config, 'utf8')).not.toContain(CODEX_PERMISSION_BEGIN_MARKER);
  });

  it('removes a newly created config on exact undo', async () => {
    await rm(config);
    await applyCodexPermissionHookSetup(options, (await previewCodexPermissionHookSetup(options)).revision);
    const undo = await undoCodexPermissionHookSetup(options);
    await undoCodexPermissionHookSetup(options, undo.revision);
    await expect(stat(config)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('refuses a hooks.json layer with concrete migration instructions', async () => {
    await writeFile(path.join(options.codexHome, 'hooks.json'), '{"hooks":{}}');
    await expect(previewCodexPermissionHookSetup(options)).rejects.toThrow('Move its hooks into config.toml');
    expect(await readFile(config, 'utf8')).toBe(original);
  });

  it.each(['model = [', `${original}\n${CODEX_PERMISSION_BEGIN_MARKER}\n`, `${original}\n# manual codex-permission.mjs hook\n`])('refuses invalid or ambiguous configuration', async text => {
    await writeFile(config, text);
    await expect(previewCodexPermissionHookSetup(options)).rejects.toThrow();
    expect(await readFile(config, 'utf8')).toBe(text);
  });

  it('binds approval to the symlink target', async () => {
    if (process.platform === 'win32') return;
    const first = path.join(root, 'first.toml'), second = path.join(root, 'second.toml');
    await writeFile(first, original);
    await writeFile(second, original);
    await rm(config);
    await symlink(first, config);
    const preview = await previewCodexPermissionHookSetup(options);
    await rm(config);
    await symlink(second, config);
    await expect(applyCodexPermissionHookSetup(options, preview.revision)).rejects.toThrow('Review and approve');
    expect(await readFile(second, 'utf8')).toBe(original);
  });
});
