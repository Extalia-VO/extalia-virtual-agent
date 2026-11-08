/** Integrity handoff between the offline Linux installer and electron-updater. */
import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, openSync, readSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const MANIFEST = '.extalia-installer';
const PENDING = '.extalia-update';
const HASH = '[a-f0-9]{64}';
const MANIFEST_PATTERN = new RegExp(`^extalia-linux-installer-v1\\n(${HASH})\\n(${HASH}|-)\\n(${HASH})\\n$`);
const LEGACY_PENDING_PATTERN = new RegExp(`^extalia-linux-update-v1\\n(${HASH})\\n(${HASH})\\n$`);
const PENDING_PATTERN = new RegExp(`^extalia-linux-update-v2\\n(${HASH})\\n(${HASH})\\n(${HASH})\\n$`);

export interface LinuxDownloadedUpdate {
  downloadedFile: string;
  files: readonly { url: string; sha512: string; size?: number }[];
}

function fail(): never { throw new Error('The Linux installation or downloaded update failed integrity verification.'); }
function exists(file: string): boolean {
  try { lstatSync(file); return true; } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}

/** A marker's presence opts in even when it is corrupt or a dangling link. */
export function isLinuxInstallerAppImage(appImage: string | undefined): appImage is string {
  return Boolean(appImage && path.isAbsolute(appImage) && path.basename(appImage) === 'app.AppImage'
    && (exists(path.join(path.dirname(appImage), MANIFEST)) || exists(path.join(path.dirname(appImage), PENDING))));
}

function safeDirectory(directory: string): void {
  if (!path.isAbsolute(directory) || path.normalize(directory) !== directory) fail();
  let current = path.parse(directory).root;
  for (const part of directory.slice(current.length).split(path.sep)) {
    if (!part) continue;
    current = path.join(current, part);
    const entry = lstatSync(current);
    if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
  }
  const entry = lstatSync(directory);
  if (entry.uid !== process.getuid?.() || (entry.mode & 0o022) !== 0) fail();
}

/** Read through an owned regular-file descriptor, refusing links and replacement. */
function withFile<T>(file: string, privateFile: boolean, use: (fd: number, size: number) => T): T {
  const entry = lstatSync(file);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || entry.nlink !== 1
    || (privateFile && (entry.mode & 0o777) !== 0o600)) fail();
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = fstatSync(fd);
    if (before.dev !== entry.dev || before.ino !== entry.ino) fail();
    const result = use(fd, before.size);
    const after = fstatSync(fd); const current = lstatSync(file);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs
      || current.dev !== before.dev || current.ino !== before.ino || current.isSymbolicLink()) fail();
    return result;
  } finally { closeSync(fd); }
}

function text(file: string, privateFile = false): string {
  return withFile(file, privateFile, (fd, size) => {
    if (size > 512) fail();
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, 0) !== size) fail();
    return bytes.toString('utf8');
  });
}

function hashes(file: string): { sha256: string; sha512: string; size: number } {
  return withFile(file, false, (fd, size) => {
    if (size === 0) fail();
    const sha256 = createHash('sha256'); const sha512 = createHash('sha512');
    const buffer = Buffer.alloc(1024 * 1024);
    let offset = 0;
    for (;;) {
      const count = readSync(fd, buffer, 0, buffer.length, offset);
      if (count === 0) break;
      sha256.update(buffer.subarray(0, count)); sha512.update(buffer.subarray(0, count)); offset += count;
    }
    if (offset !== size) fail();
    return { sha256: sha256.digest('hex'), sha512: sha512.digest('base64'), size };
  });
}

function installation(appImage: string): { base: string; current: string; state: string } {
  const prefix = path.dirname(appImage);
  safeDirectory(prefix);
  if (exists(`${prefix}.install-lock`)) fail();
  const manifest = text(path.join(prefix, MANIFEST));
  const match = MANIFEST_PATTERN.exec(manifest);
  if (!match || match[0] !== manifest) fail();
  const base = match[1]!; const icon = match[2]!;
  const receipt = exists(path.join(prefix, PENDING)) ? text(path.join(prefix, PENDING), true) : '';
  const pending = receipt ? PENDING_PATTERN.exec(receipt) ?? LEGACY_PENDING_PATTERN.exec(receipt) : undefined;
  if (receipt && (!pending || pending[0] !== receipt || pending[1] !== base)) fail();
  // An empty receipt is invalid too.
  if (!receipt && exists(path.join(prefix, PENDING))) fail();
  const current = hashes(appImage).sha256;
  if (current !== base && current !== pending?.[2] && current !== pending?.[3]) fail();
  const allowed = new Set(['app.AppImage', MANIFEST]);
  if (icon !== '-') {
    if (hashes(path.join(prefix, 'icon.png')).sha256 !== icon) fail();
    allowed.add('icon.png');
  }
  if (receipt) allowed.add(PENDING);
  if (readdirSync(prefix).some(entry => !allowed.has(entry))) fail();
  return { base, current, state: `${manifest}${receipt}${current}` };
}

/**
 * Synchronous deliberately: BaseUpdater registers its quit handler immediately
 * after emitting update-downloaded. No quit can interleave with this handoff.
 */
export function authorizeLinuxInstallerUpdate(appImage: string, update: LinuxDownloadedUpdate): void {
  if (!isLinuxInstallerAppImage(appImage)) fail();
  const before = installation(appImage);
  const candidates = update.files.filter(file => {
    try { return /\.AppImage$/i.test(new URL(file.url, 'https://example.com/').pathname); } catch { return false; }
  });
  if (candidates.length !== 1 || !path.isAbsolute(update.downloadedFile)) fail();
  const expected = candidates[0]!;
  const actual = hashes(update.downloadedFile);
  // Compare bytes to feed metadata, never to the downloaded filename or version.
  if (actual.sha512 !== expected.sha512 || (expected.size !== undefined && actual.size !== expected.size)) fail();
  if (installation(appImage).state !== before.state) fail();
  const destination = path.join(path.dirname(appImage), PENDING);
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    // Preserve the verified running image if this download is never installed.
    writeFileSync(temporary, `extalia-linux-update-v2\n${before.base}\n${before.current}\n${actual.sha256}\n`, { flag: 'wx', mode: 0o600 });
    renameSync(temporary, destination);
  } finally { rmSync(temporary, { force: true }); }
}
