import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { authorizeLinuxInstallerUpdate, isLinuxInstallerAppImage } from '../src/linuxInstallerUpdate';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const hash = (data: string) => createHash('sha256').update(data).digest('hex');
function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'extalia-update-'))); roots.push(root);
  const prefix = path.join(root, 'installation'); mkdirSync(prefix, { mode: 0o700 });
  const app = path.join(prefix, 'app.AppImage'); const manifest = path.join(prefix, '.extalia-installer'); const pending = path.join(prefix, '.extalia-update');
  writeFileSync(app, 'original'); writeFileSync(manifest, `extalia-linux-installer-v1\n${hash('original')}\n-\n${hash('desktop')}\n`, { mode: 0o600 });
  const downloadedFile = path.join(root, 'arbitrary-cache-name');
  const update = (data = 'updated') => {
    writeFileSync(downloadedFile, data);
    return { downloadedFile, files: [{ url: 'https://example.com/Extalia-2.0.0.AppImage', sha512: createHash('sha512').update(data).digest('base64'), size: Buffer.byteLength(data) }] };
  };
  return { root, prefix, app, manifest, pending, downloadedFile, update };
}

describe.skipIf(process.platform === 'win32')('verified Linux installer update receipts', () => {
  it('opts in only an AppImage with a local installer marker, including malformed markers', () => {
    const f = fixture(); expect(isLinuxInstallerAppImage(f.app)).toBe(true);
    expect(isLinuxInstallerAppImage(undefined)).toBe(false); expect(isLinuxInstallerAppImage(f.downloadedFile)).toBe(false);
    rmSync(f.manifest); expect(isLinuxInstallerAppImage(f.app)).toBe(false);
    symlinkSync(path.join(f.root, 'missing'), f.manifest); expect(isLinuxInstallerAppImage(f.app)).toBe(true);
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update())).toThrow();
  });
  it('verifies actual payload SHA-512 and writes a private receipt with the original base', () => {
    const f = fixture(); authorizeLinuxInstallerUpdate(f.app, f.update());
    expect(readFileSync(f.pending, 'utf8')).toBe(`extalia-linux-update-v2\n${hash('original')}\n${hash('original')}\n${hash('updated')}\n`);
    expect(readFileSync(f.app, 'utf8')).toBe('original');
  });
  it('accepts successive verified updates while keeping the original manifest base', () => {
    const f = fixture(); authorizeLinuxInstallerUpdate(f.app, f.update()); renameSync(f.downloadedFile, f.app);
    authorizeLinuxInstallerUpdate(f.app, f.update('third')); renameSync(f.downloadedFile, f.app);
    authorizeLinuxInstallerUpdate(f.app, f.update('fourth'));
    expect(readFileSync(f.pending, 'utf8')).toBe(`extalia-linux-update-v2\n${hash('original')}\n${hash('third')}\n${hash('fourth')}\n`);
  });
  it('preserves the verified current image when successive downloads are interrupted before installation', () => {
    const f = fixture(); const manifest = readFileSync(f.manifest);
    authorizeLinuxInstallerUpdate(f.app, f.update()); renameSync(f.downloadedFile, f.app);
    authorizeLinuxInstallerUpdate(f.app, f.update('third'));
    expect(readFileSync(f.app, 'utf8')).toBe('updated');
    // A restart/download retry must still recognize the installed second image.
    authorizeLinuxInstallerUpdate(f.app, f.update('third'));
    authorizeLinuxInstallerUpdate(f.app, f.update('fourth'));
    expect(readFileSync(f.pending, 'utf8')).toBe(`extalia-linux-update-v2\n${hash('original')}\n${hash('updated')}\n${hash('fourth')}\n`);
    expect(readFileSync(f.manifest)).toEqual(manifest);
    writeFileSync(f.app, 'tampered after interrupted update');
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update('fifth'))).toThrow('integrity');
  });
  it('reads an existing v1 receipt and advances it without discarding the verified current hash', () => {
    const f = fixture(); writeFileSync(f.app, 'updated');
    writeFileSync(f.pending, `extalia-linux-update-v1\n${hash('original')}\n${hash('updated')}\n`, { mode: 0o600 });
    authorizeLinuxInstallerUpdate(f.app, f.update('third'));
    expect(readFileSync(f.pending, 'utf8')).toBe(`extalia-linux-update-v2\n${hash('original')}\n${hash('updated')}\n${hash('third')}\n`);
    authorizeLinuxInstallerUpdate(f.app, f.update('third'));
  });
  it.each(['sha512', 'size', 'file bytes', 'ambiguous', 'missing AppImage'])('refuses %s mismatch before creating a receipt', kind => {
    const f = fixture(); const update = f.update();
    if (kind === 'sha512') update.files[0]!.sha512 = createHash('sha512').update('other').digest('base64');
    if (kind === 'size') update.files[0]!.size++;
    if (kind === 'file bytes') writeFileSync(f.downloadedFile, 'tampered');
    if (kind === 'ambiguous') update.files.push({ ...update.files[0]! });
    if (kind === 'missing AppImage') update.files[0]!.url = 'https://example.com/update.deb';
    expect(() => authorizeLinuxInstallerUpdate(f.app, update)).toThrow('integrity');
    expect(() => readFileSync(f.pending)).toThrow();
  });
  it('refuses a modified current binary even when the new payload is valid', () => {
    const f = fixture(); writeFileSync(f.app, 'tampered');
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update())).toThrow('integrity');
  });
  it.each(['empty', 'extra line', 'trailing bytes', 'wrong base', 'wrong next', 'public', 'symlink'])('refuses a %s pending receipt without replacing it', kind => {
    const f = fixture(); authorizeLinuxInstallerUpdate(f.app, f.update()); renameSync(f.downloadedFile, f.app);
    if (kind === 'empty') writeFileSync(f.pending, '');
    if (kind === 'extra line') writeFileSync(f.pending, `${readFileSync(f.pending, 'utf8')}\n`);
    if (kind === 'trailing bytes') writeFileSync(f.pending, `${readFileSync(f.pending, 'utf8')}trailing`);
    if (kind === 'wrong base') writeFileSync(f.pending, `extalia-linux-update-v1\n${hash('other')}\n${hash('updated')}\n`);
    if (kind === 'wrong next') writeFileSync(f.pending, `extalia-linux-update-v1\n${hash('original')}\n${hash('other')}\n`);
    if (kind === 'public') chmodSync(f.pending, 0o644);
    if (kind === 'symlink') { rmSync(f.pending); symlinkSync(f.manifest, f.pending); }
    const before = readFileSync(f.pending);
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update('third'))).toThrow('integrity');
    expect(readFileSync(f.pending)).toEqual(before);
  });
  it.each(['manifest', 'payload', 'download', 'parent'])('refuses a symlink at the %s', kind => {
    const f = fixture(); const update = f.update();
    if (kind === 'parent') {
      const moved = `${f.prefix}-real`; renameSync(f.prefix, moved); symlinkSync(moved, f.prefix);
    } else {
      const file = kind === 'manifest' ? f.manifest : kind === 'payload' ? f.app : f.downloadedFile;
      renameSync(file, `${file}-real`); symlinkSync(`${file}-real`, file);
    }
    expect(() => authorizeLinuxInstallerUpdate(f.app, update)).toThrow('integrity');
  });
  it('refuses unknown owned-prefix files and an active manual installer lock', () => {
    const f = fixture(); writeFileSync(path.join(f.prefix, 'notes'), 'preserved');
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update())).toThrow('integrity');
    rmSync(path.join(f.prefix, 'notes')); mkdirSync(`${f.prefix}.install-lock`);
    expect(() => authorizeLinuxInstallerUpdate(f.app, f.update())).toThrow('integrity');
  });
});
