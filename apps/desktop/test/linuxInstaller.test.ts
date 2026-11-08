import { createHash } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { access, chmod, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { buildLinuxInstaller, verifyLinuxInstaller } from '../scripts/linux-installer.mjs';
import { authorizeLinuxInstallerUpdate } from '../src/linuxInstallerUpdate';

const temporary: string[] = [];
const version = '1.2.3';
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(iconIncluded = true) {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'extalia-linux-installer-')));
  temporary.push(root);
  const home = path.join(root, 'home'); const data = path.join(home, 'data with spaces');
  const prefix = path.join(data, 'Extalia with spaces'); const appImage = path.join(root, 'source.AppImage');
  const icon = iconIncluded ? path.join(root, 'source.png') : undefined;
  const output = path.join(root, 'Extalia.run'); const bin = path.join(root, 'bin');
  await mkdir(home); await mkdir(bin);
  await writeFile(appImage, '#!/usr/bin/env bash\nprintf launched > "$EXTALIA_TEST_LAUNCH"\n');
  if (icon) await writeFile(icon, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0xff]));
  await buildLinuxInstaller({ appImage, output, icon, version });
  const env = { ...process.env, HOME: home, XDG_DATA_HOME: data, TMPDIR: root, DISPLAY: '', WAYLAND_DISPLAY: '', PATH: `${bin}${path.delimiter}${process.env.PATH}`, EXTALIA_TEST_LAUNCH: path.join(root, 'launched'), EXTALIA_TEST_PREFIX: prefix, EXTALIA_TEST_LOG: path.join(root, 'dialogs') };
  const run = (args = ['--yes', '--prefix', prefix], overrides: Record<string, string> = {}) => spawnSync('/bin/bash', [output, ...args], { env: { ...env, ...overrides }, encoding: 'utf8', timeout: 10_000 });
  const desktop = path.join(data, 'applications', 'extalia.desktop');
  return { root, home, data, prefix, appImage, icon, output, bin, env, run, desktop };
}
async function absent(file: string) { await expect(access(file)).rejects.toThrow(); }
async function dialog(f: Awaited<ReturnType<typeof fixture>>, kind: 'zenity' | 'kdialog') {
  const script = `#!/bin/bash
printf '%s\\n' "$*" >> "$EXTALIA_TEST_LOG"
for argument in "$@"; do
  case "$argument" in
    --entry|--inputbox) printf '%s\\n' "$EXTALIA_TEST_PREFIX"; exit 0 ;;
    --question|--yesno) exit "${'$'}{EXTALIA_TEST_CANCEL:-0}" ;;
    --list|--checklist) if [ "${'$'}{EXTALIA_TEST_SELECT:-0}" = 1 ]; then ${kind === 'zenity' ? `printf '%s\\n' "${'$'}{!#}"` : 'echo launch'}; fi; exit 0 ;;
  esac
done
exit 2
`;
  const file = path.join(f.bin, kind); await writeFile(file, script); await chmod(file, 0o755);
}

describe('Linux offline installer generation', () => {
  it('builds an executable and verifies its exact version, AppImage, icon and header without execution', async () => {
    const f = await fixture();
    if (process.platform !== 'win32') expect((await stat(f.output)).mode & 0o111).toBe(0o111);
    await verifyLinuxInstaller({ installer: f.output, appImage: f.appImage, icon: f.icon, version });
    await absent(f.env.EXTALIA_TEST_LAUNCH);
    await expect(verifyLinuxInstaller({ installer: f.output, appImage: f.appImage, icon: f.icon, version: '1.2.4' })).rejects.toThrow('match this release');
    const bytes = await readFile(f.output); bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1; await writeFile(f.output, bytes);
    await expect(verifyLinuxInstaller({ installer: f.output, appImage: f.appImage, icon: f.icon, version })).rejects.toThrow('corrupted');
  });
  it.skipIf(process.platform === 'win32')('rejects empty and symbolic-link payloads and invalid versions', async () => {
    const f = await fixture(); await writeFile(f.appImage, '');
    await expect(buildLinuxInstaller({ ...f, version })).rejects.toThrow('nonempty regular file');
    await rm(f.appImage); await symlink(f.output, f.appImage);
    await expect(buildLinuxInstaller({ ...f, version })).rejects.toThrow('nonempty regular file');
    await expect(buildLinuxInstaller({ ...f, version: '1.2.3;exit' })).rejects.toThrow('Invalid installer version');
  });
  it.skipIf(process.platform === 'win32')('prints English help without extracting or installing files', async () => {
    const f = await fixture(); const result = f.run(['--help']);
    expect(result.status).toBe(0); expect(result.stdout).toContain('Usage:'); expect(result.stdout).toContain('--cli');
    expect(await readdir(f.home)).toEqual([]); await absent(f.env.EXTALIA_TEST_LAUNCH);
  });
  it.skipIf(process.getuid?.() !== 0)('refuses installation as root, including --yes', async () => {
    const f = await fixture(); const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toContain('sudo'); expect(await readdir(f.home)).toEqual([]);
  });
});

describe.skipIf(process.platform === 'win32' || process.getuid?.() === 0)('Linux installer shell contract in temporary homes', () => {
  it.each(['corrupted', 'truncated'])('rejects a %s payload before any destination writes', async mutation => {
    const f = await fixture(); const bytes = await readFile(f.output);
    if (mutation === 'corrupted') { bytes[bytes.length - 2] = bytes[bytes.length - 2]! ^ 1; await writeFile(f.output, bytes); }
    else await writeFile(f.output, bytes.subarray(0, bytes.length - 2));
    const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toMatch(/incomplete|corrupted/); expect(await readdir(f.home)).toEqual([]);
  });
  it('installs offline with spaces, preserves payload bytes, and never auto launches with --yes', async () => {
    const f = await fixture(); const result = f.run(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(await readFile(path.join(f.prefix, 'app.AppImage'))).toEqual(await readFile(f.appImage));
    expect(await readFile(path.join(f.prefix, 'icon.png'))).toEqual(await readFile(f.icon!));
    expect((await stat(path.join(f.prefix, 'app.AppImage'))).mode & 0o777).toBe(0o755);
    const desktop = await readFile(f.desktop, 'utf8'); expect(desktop).toContain(`Exec="${f.prefix}/app.AppImage"`);
    expect(desktop).toContain('Name=Extalia\n'); expect(desktop).toContain('X-Extalia-Version=1.2.3');
    await absent(f.env.EXTALIA_TEST_LAUNCH);
    expect((await readdir(f.data)).sort()).toEqual(['Extalia with spaces', 'applications']);
  });
  it('upgrades only unchanged owned files and preserves a modified installation', async () => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    await writeFile(f.appImage, '#!/bin/bash\n# replacement AppImage\n');
    await buildLinuxInstaller({ ...f, version: '1.2.4' }); expect(f.run().status).toBe(0);
    expect(await readFile(path.join(f.prefix, 'app.AppImage'))).toEqual(await readFile(f.appImage));
    await writeFile(path.join(f.prefix, 'app.AppImage'), 'user changes');
    const before = await readFile(f.desktop); expect(f.run().status).toBe(1);
    expect(await readFile(path.join(f.prefix, 'app.AppImage'), 'utf8')).toBe('user changes'); expect(await readFile(f.desktop)).toEqual(before);
  });
  it('accepts verified automatic updates before a later offline installer and resets their receipt', async () => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const installed = path.join(f.prefix, 'app.AppImage');
    const downloadedFile = path.join(f.root, 'cached.AppImage');
    for (const payload of ['automatic update two', 'automatic update three']) {
      await writeFile(downloadedFile, payload);
      authorizeLinuxInstallerUpdate(installed, { downloadedFile, files: [{ url: 'Extalia.AppImage', sha512: createHash('sha512').update(payload).digest('base64') }] });
      await rename(downloadedFile, installed);
    }
    await writeFile(f.appImage, '#!/bin/bash\n# offline release four\n');
    await buildLinuxInstaller({ ...f, version: '1.2.4' });
    const result = f.run(); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(await readFile(installed)).toEqual(await readFile(f.appImage)); await absent(path.join(f.prefix, '.extalia-update'));
    expect(f.run().status).toBe(0);
  });
  it.each([false, true])('accepts the current verified app after an interrupted successive download (tamper=%s)', async tampered => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const installed = path.join(f.prefix, 'app.AppImage'); const manifest = path.join(f.prefix, '.extalia-installer');
    const beforeManifest = await readFile(manifest); const downloadedFile = path.join(f.root, 'cached.AppImage');
    const authorize = async (payload: string) => {
      await writeFile(downloadedFile, payload);
      authorizeLinuxInstallerUpdate(installed, { downloadedFile, files: [{ url: 'Extalia.AppImage', sha512: createHash('sha512').update(payload).digest('base64') }] });
    };
    await authorize('automatic update two'); await rename(downloadedFile, installed);
    await authorize('automatic update three');
    // Simulate restart/retry with v3 still only downloaded, leaving v2 installed.
    await authorize('automatic update three');
    expect(await readFile(installed, 'utf8')).toBe('automatic update two'); expect(await readFile(manifest)).toEqual(beforeManifest);
    if (tampered) await writeFile(installed, 'unverified modification');
    const before = await readFile(installed); const beforeDesktop = await readFile(f.desktop);
    await writeFile(f.appImage, '#!/bin/bash\n# offline release four\n'); await buildLinuxInstaller({ ...f, version: '1.2.4' });
    const result = f.run(); expect(result.status).toBe(tampered ? 1 : 0);
    if (tampered) { expect(await readFile(installed)).toEqual(before); expect(await readFile(f.desktop)).toEqual(beforeDesktop); }
    else { expect(await readFile(installed)).toEqual(await readFile(f.appImage)); await absent(path.join(f.prefix, '.extalia-update')); }
  });
  it('accepts a valid legacy v1 receipt during an offline upgrade', async () => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const installed = path.join(f.prefix, 'app.AppImage'); const base = createHash('sha256').update(await readFile(installed)).digest('hex');
    const payload = 'legacy verified automatic update'; await writeFile(installed, payload);
    const next = createHash('sha256').update(payload).digest('hex');
    await writeFile(path.join(f.prefix, '.extalia-update'), `extalia-linux-update-v1\n${base}\n${next}\n`, { mode: 0o600 });
    expect(f.run().status).toBe(0); await absent(path.join(f.prefix, '.extalia-update'));
  });
  it.each(['malformed', 'wrong base', 'wrong next', 'trailing bytes', 'public', 'symlink'])('refuses a %s automatic-update receipt and preserves installed bytes', async kind => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const pending = path.join(f.prefix, '.extalia-update'); const app = path.join(f.prefix, 'app.AppImage');
    const downloadedFile = path.join(f.root, 'cached.AppImage'); const payload = 'verified update'; await writeFile(downloadedFile, payload);
    authorizeLinuxInstallerUpdate(app, { downloadedFile, files: [{ url: 'Extalia.AppImage', sha512: createHash('sha512').update(payload).digest('base64') }] });
    await rename(downloadedFile, app);
    const receipt = await readFile(pending, 'utf8'); const lines = receipt.split('\n');
    if (kind === 'malformed') await writeFile(pending, 'corrupt\n');
    if (kind === 'wrong base') { lines[1] = '0'.repeat(64); await writeFile(pending, lines.join('\n')); }
    if (kind === 'wrong next') { lines[3] = '0'.repeat(64); await writeFile(pending, lines.join('\n')); }
    if (kind === 'trailing bytes') await writeFile(pending, `${receipt}trailing`);
    if (kind === 'public') await chmod(pending, 0o644);
    if (kind === 'symlink') { await rename(pending, `${pending}-target`); await symlink(`${pending}-target`, pending); }
    const beforeDesktop = await readFile(f.desktop);
    expect(f.run().status).toBe(1); expect(await readFile(app, 'utf8')).toBe(payload); expect(await readFile(f.desktop)).toEqual(beforeDesktop);
  });
  it.each(['equal', 'ancestor', 'descendant'])('rejects a prefix that is an %s launcher path before destination writes', async relation => {
    const f = await fixture();
    const prefix = relation === 'equal' ? f.desktop : relation === 'ancestor' ? path.dirname(f.desktop) : path.join(f.desktop, 'nested');
    expect(f.run(['--yes', '--prefix', prefix]).status).toBe(1); expect(await readdir(f.home)).toEqual([]); await absent(f.desktop);
    await dialog(f, 'zenity');
    expect(f.run(['--prefix', prefix], { DISPLAY: ':synthetic', EXTALIA_TEST_CANCEL: '1', EXTALIA_TEST_PREFIX: prefix }).status).toBe(0);
    expect(await readdir(f.home)).toEqual([]); await absent(f.desktop);
  });
  it('permits a distinct prefix sharing only the launcher name prefix', async () => {
    const f = await fixture(); const prefix = `${f.desktop}-app`;
    expect(f.run(['--yes', '--prefix', prefix]).status).toBe(0); expect((await stat(f.desktop)).isFile()).toBe(true);
    expect(await readFile(path.join(prefix, 'app.AppImage'))).toEqual(await readFile(f.appImage));
  });
  it('restores both previous app and launcher when the launcher swap fails', async () => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const previousApp = await readFile(path.join(f.prefix, 'app.AppImage')); const previousDesktop = await readFile(f.desktop);
    await writeFile(f.appImage, '#!/bin/bash\n# new release\n'); await buildLinuxInstaller({ ...f, version: '1.2.4' });
    const shim = path.join(f.bin, 'mv');
    await writeFile(shim, '#!/bin/bash\nif [ "${!#}" = "$EXTALIA_TEST_DESKTOP" ] && [ -z "${EXTALIA_TEST_FAILED:-}" ]; then export EXTALIA_TEST_FAILED=1; case "$*" in *.previous*) ;; *) exit 1 ;; esac; fi\nexec /bin/mv "$@"\n'); await chmod(shim, 0o755);
    const result = f.run(undefined, { EXTALIA_TEST_DESKTOP: f.desktop }); expect(result.status).toBe(1);
    expect(await readFile(path.join(f.prefix, 'app.AppImage'))).toEqual(previousApp); expect(await readFile(f.desktop)).toEqual(previousDesktop);
    expect((await readdir(f.data)).sort()).toEqual(['Extalia with spaces', 'applications']);
  });
  it.skipIf(process.platform !== 'linux')('blocks an update while an AppImage process advertises the installed path', async () => {
    const f = await fixture(); expect(f.run().status).toBe(0);
    const child = spawn('/bin/sleep', ['20'], { env: { ...f.env, APPIMAGE: path.join(f.prefix, 'app.AppImage') }, stdio: 'ignore' });
    await once(child, 'spawn');
    try { const result = f.run(); expect(result.status).toBe(1); expect(result.stderr).toContain('Close'); }
    finally { const exited = once(child, 'exit'); child.kill(); await exited; }
  });
  it('refuses existing unowned folders and launchers', async () => {
    const f = await fixture(); await mkdir(f.prefix, { recursive: true }); await writeFile(path.join(f.prefix, 'notes'), 'preserved');
    expect(f.run().status).toBe(1); expect(await readFile(path.join(f.prefix, 'notes'), 'utf8')).toBe('preserved');
    await rm(f.prefix, { recursive: true }); await mkdir(path.dirname(f.desktop)); await writeFile(f.desktop, 'unrelated launcher');
    expect(f.run().status).toBe(1); expect(await readFile(f.desktop, 'utf8')).toBe('unrelated launcher'); await absent(f.prefix);
  });
  it.each(['prefix', 'parent', 'desktop', 'manifest', 'payload'])('refuses a symbolic-link %s without changing its target', async location => {
    const f = await fixture(); const target = path.join(f.root, 'preserved'); await mkdir(target); await writeFile(path.join(target, 'sentinel'), 'preserved');
    if (location === 'manifest' || location === 'payload') {
      expect(f.run().status).toBe(0); const file = path.join(f.prefix, location === 'manifest' ? '.extalia-installer' : 'app.AppImage'); await rm(file); await symlink(path.join(target, 'sentinel'), file);
    } else if (location === 'desktop') { await mkdir(path.dirname(f.desktop), { recursive: true }); await symlink(path.join(target, 'sentinel'), f.desktop); }
    else if (location === 'parent') await symlink(target, f.data);
    else { await mkdir(f.data, { recursive: true }); await symlink(target, f.prefix); }
    expect(f.run().status).toBe(1); expect(await readFile(path.join(target, 'sentinel'), 'utf8')).toBe('preserved'); expect(await readdir(target)).toEqual(['sentinel']);
  });
  it('quotes Desktop Exec arguments and escapes percent field codes', async () => {
    const f = await fixture(false); const prefix = path.join(f.data, 'quotes " dollar $ tick ` percent % slash \\');
    expect(f.run(['--yes', '--prefix', prefix]).status).toBe(0);
    const desktop = await readFile(f.desktop, 'utf8');
    const suffix = 'quotes \\\\" dollar \\\\$ tick \\\\` percent %% slash \\\\\\\\/app.AppImage';
    expect(desktop).toContain(`Exec="${f.data}/${suffix}"\n`); expect(desktop).toContain('Icon=extalia\n');
  });
  it('cancels Zenity without destination writes and leaves launch unchecked on success', async () => {
    const f = await fixture(); await dialog(f, 'zenity');
    const cancel = f.run([], { DISPLAY: ':synthetic', EXTALIA_TEST_CANCEL: '1' }); expect(cancel.status).toBe(0); expect(cancel.stdout).toContain('cancelled'); expect(await readdir(f.home)).toEqual([]);
    const install = f.run([], { DISPLAY: ':synthetic' }); expect(install.status).toBe(0); await absent(f.env.EXTALIA_TEST_LAUNCH);
    const dialogs = await readFile(f.env.EXTALIA_TEST_LOG, 'utf8'); expect(dialogs).toContain('--question'); expect(dialogs).toContain('--column=Action FALSE ');
  });
  it('launches its verified fake payload only after an explicit checked finish choice', async () => {
    const f = await fixture(); await dialog(f, 'zenity');
    expect(f.run([], { DISPLAY: ':synthetic', EXTALIA_TEST_SELECT: '1' }).status).toBe(0);
    await expect.poll(async () => readFile(f.env.EXTALIA_TEST_LAUNCH, 'utf8'), { timeout: 2000 }).toBe('launched');
  });
  it('falls back to KDialog and leaves its launch choice unchecked', async () => {
    const f = await fixture(); await dialog(f, 'kdialog');
    // An isolated tool path prevents a host-installed Zenity from taking precedence.
    for (const name of ['tail', 'head', 'sha256sum', 'shasum', 'cut', 'wc', 'tr', 'grep', 'readlink', 'mkdir', 'mktemp', 'chmod', 'mv', 'rm', 'rmdir', 'uname', 'stat']) {
      try { const executable = execFileSync('which', [name], { encoding: 'utf8' }).trim(); if (executable) await symlink(executable, path.join(f.bin, name)); } catch { /* sha256sum or shasum can be absent. */ }
    }
    const result = f.run([], { DISPLAY: ':synthetic', PATH: f.bin }); expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    expect(await readFile(f.env.EXTALIA_TEST_LOG, 'utf8')).toMatch(/launch .+ off/); await absent(f.env.EXTALIA_TEST_LAUNCH);
  });
  it('forces terminal interaction with --cli and refuses a noninteractive implicit install', async () => {
    const f = await fixture(); await dialog(f, 'zenity');
    const result = f.run(['--cli'], { DISPLAY: ':synthetic' }); expect(result.status).toBe(1); expect(result.stderr).toContain('terminal'); await absent(f.env.EXTALIA_TEST_LOG); expect(await readdir(f.home)).toEqual([]);
  });
  it.skipIf(spawnSync('python3', ['--version']).status !== 0)('installs through an English terminal and leaves launch declined', async () => {
    const f = await fixture();
    // Python only supplies a PTY in this optional test; the installer needs Bash and core utilities.
    const python = `import os, pty, select, subprocess, sys, time
master, slave = pty.openpty()
child = subprocess.Popen(['/bin/bash', sys.argv[1], '--cli', '--prefix', sys.argv[2]], stdin=slave, stdout=slave, stderr=slave)
os.close(slave)
os.write(master, b'y\\nn\\n')
output = b''
deadline = time.monotonic() + 8
try:
    while time.monotonic() < deadline:
        ready, _, _ = select.select([master], [], [], 0.1)
        if ready:
            try:
                data = os.read(master, 65536)
            except OSError:
                break
            if not data:
                break
            output += data
        elif child.poll() is not None:
            break
    if child.poll() is None:
        child.kill()
    code = child.wait()
finally:
    os.close(master)
sys.stdout.buffer.write(output)
sys.exit(code)
`;
    const result = spawnSync('python3', ['-c', python, f.output, f.prefix], { env: f.env, encoding: 'utf8', timeout: 10_000 });
    expect(result.stderr).toBe(''); expect(result.status).toBe(0); expect(result.stdout).toContain('Extalia Setup'); expect(result.stdout).toContain('[y/N]');
    expect(await readFile(path.join(f.prefix, 'app.AppImage'))).toEqual(await readFile(f.appImage)); await absent(f.env.EXTALIA_TEST_LAUNCH);
  });
});
