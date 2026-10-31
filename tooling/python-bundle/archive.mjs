import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { open, mkdir, chmod, copyFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createGunzip } from 'node:zlib';

const LIMITS = Object.freeze({ archive: 64 * 1024 * 1024, expanded: 512 * 1024 * 1024,
  headers: 16384, sourceEntries: 8192, file: 128 * 1024 * 1024,
  files: 4096, directories: 4096, entries: 8192 });
const fail = (message) => { throw new Error(`Python archive: ${message}`); };

function portablePart(part) {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(part) || part === '.' || part === '..' || part.endsWith('.')
      || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part)) fail('non-portable path component');
}

function archiveName(raw, directory) {
  const name = directory && raw.endsWith('/') ? raw.slice(0, -1) : raw;
  const parts = name.split('/');
  if (name.length > 512 || parts.length > 16 || parts[0] !== 'python'
      || (parts.length === 1 && !directory)) fail('path must be inside python/');
  parts.forEach(portablePart);
  return name;
}

function linkTarget(entry) {
  const raw = entry.link;
  if (!raw || raw.length > 512 || raw.startsWith('/') || /[^\x20-\x7e]|[\\:]/.test(raw)) fail('invalid link target');
  const parts = entry.type === 'symlink' ? entry.path.split('/').slice(0, -1) : [];
  for (const part of raw.split('/')) {
    if (part === '.') continue;
    if (part === '..') {
      if (parts.length <= 1) fail('link escapes python/');
      parts.pop();
    } else {
      portablePart(part);
      parts.push(part);
    }
  }
  return archiveName(parts.join('/'), true);
}

function stringField(header, start, length) {
  const field = header.subarray(start, start + length);
  const nul = field.indexOf(0);
  const value = nul < 0 ? field : field.subarray(0, nul);
  if (value.some((byte) => byte < 32 || byte > 126)) fail('invalid tar text field');
  return value.toString('ascii');
}

function octal(header, start, length) {
  const value = header.subarray(start, start + length).toString('latin1');
  if (!/^ *[0-7]+[\0 ]*$/.test(value)) fail('invalid tar octal field');
  const number = Number.parseInt(value.trim().replace(/\0.*$/, ''), 8);
  if (!Number.isSafeInteger(number)) fail('oversized tar number');
  return number;
}

// Retains only the current zlib chunk. Payloads are delivered as bounded slices.
class ByteReader {
  constructor(stream) { this.iterator = stream[Symbol.asyncIterator](); this.chunk = Buffer.alloc(0); this.offset = 0; this.total = 0; }
  async nextChunk() {
    const next = await this.iterator.next();
    if (next.done) return false;
    this.chunk = next.value;
    this.offset = 0;
    this.total += this.chunk.length;
    if (this.total > LIMITS.expanded) fail('decompressed byte limit exceeded');
    return true;
  }
  async consume(length, visitor) {
    while (length > 0) {
      if (this.offset === this.chunk.length && !await this.nextChunk()) fail('truncated tar');
      const take = Math.min(length, this.chunk.length - this.offset);
      const piece = this.chunk.subarray(this.offset, this.offset + take);
      if (visitor) await visitor(piece);
      this.offset += take;
      length -= take;
    }
  }
  async block() {
    const block = Buffer.alloc(512);
    let position = 0;
    await this.consume(512, (piece) => { piece.copy(block, position); position += piece.length; });
    return block;
  }
  async finish() {
    do {
      if (this.chunk.subarray(this.offset).some((byte) => byte !== 0)) fail('nonzero data after tar end');
      this.offset = this.chunk.length;
    } while (await this.nextChunk());
  }
}

function validatePin(pin) {
  if (!pin || !Number.isSafeInteger(pin.bytes) || pin.bytes <= 0 || pin.bytes > LIMITS.archive
      || !/^[0-9a-f]{64}$/.test(pin.sha256)) fail('invalid archive pin');
}

async function verifyArchive(handle, pin) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size !== pin.bytes) fail('archive byte size does not match pin');
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(64 * 1024);
  let position = 0;
  while (position < pin.bytes) {
    const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, pin.bytes - position), position);
    if (!bytesRead) fail('archive changed during verification');
    hash.update(buffer.subarray(0, bytesRead));
    position += bytesRead;
  }
  if (hash.digest('hex') !== pin.sha256) fail('archive sha256 does not match pin');
}

async function parseArchive(handle, pin, writeEntry) {
  const compressed = handle.createReadStream({ start: 0, end: pin.bytes - 1, autoClose: false, highWaterMark: 64 * 1024 });
  const gunzip = createGunzip({ chunkSize: 64 * 1024 });
  const compressedHash = createHash('sha256');
  let compressedBytes = 0;
  compressed.on('data', (chunk) => { compressedHash.update(chunk); compressedBytes += chunk.length; });
  compressed.on('error', (error) => gunzip.destroy(error));
  compressed.pipe(gunzip);
  const reader = new ByteReader(gunzip);
  const entries = [];
  let headers = 0;
  let finished = false;
  try {
    while (true) {
      if (++headers > LIMITS.headers) fail('tar header limit exceeded');
      const header = await reader.block();
      if (header.every((byte) => byte === 0)) {
        if (++headers > LIMITS.headers) fail('tar header limit exceeded');
        if ((await reader.block()).some((byte) => byte !== 0)) fail('tar requires two zero end blocks');
        await reader.finish();
        break;
      }
      const checksum = octal(header, 148, 8);
      let actual = 0;
      for (let index = 0; index < 512; index++) actual += index >= 148 && index < 156 ? 32 : header[index];
      if (checksum !== actual) fail('tar checksum mismatch');
      if (stringField(header, 257, 6) !== 'ustar' || header.toString('ascii', 263, 265) !== '00') fail('unsupported tar format');
      const flag = header[156];
      const type = flag === 0 || flag === 48 ? 'file' : flag === 53 ? 'directory'
        : flag === 50 ? 'symlink' : flag === 49 ? 'hardlink' : undefined;
      if (!type) fail('unsupported tar entry type or metadata');
      const bytes = octal(header, 124, 12);
      const mode = octal(header, 100, 8);
      if (bytes > LIMITS.file || (type !== 'file' && bytes !== 0)) fail('invalid entry byte size');
      const prefix = stringField(header, 345, 155);
      const name = stringField(header, 0, 100);
      const path = archiveName(prefix ? `${prefix}/${name}` : name, type === 'directory');
      const link = stringField(header, 157, 100);
      if ((type === 'file' || type === 'directory') && link) fail('unexpected link target');
      const entry = { path, type, bytes, executable: !!(mode & 0o111), link };
      entries.push(entry);
      if (entries.length > LIMITS.sourceEntries) fail('source entry limit exceeded');
      const hash = createHash('sha256');
      const consume = (visitor) => reader.consume(bytes, async (piece) => { hash.update(piece); if (visitor) await visitor(piece); });
      if (type === 'file' && writeEntry) await writeEntry(entry, consume);
      else await consume();
      entry.sha256 = hash.digest('hex');
      await reader.consume((512 - bytes % 512) % 512, (piece) => {
        if (piece.some((byte) => byte !== 0)) fail('nonzero tar padding');
      });
    }
    if (compressedBytes !== pin.bytes || compressedHash.digest('hex') !== pin.sha256
        || (await handle.stat()).size !== pin.bytes) fail('archive changed during parsing');
    finished = true;
    return entries;
  } finally {
    if (!finished) compressed.destroy();
    gunzip.destroy();
  }
}

function indexEntries(entries, pin) {
  const names = new Map();
  const spelling = new Map();
  const sourceDirectories = new Set();
  const nodes = new Map();
  for (const entry of entries) {
    if (names.has(entry.path)) fail('duplicate entry name');
    names.set(entry.path, entry);
    const parts = entry.path.split('/');
    for (let depth = 1; depth <= parts.length; depth++) {
      const path = parts.slice(0, depth).join('/');
      const lower = path.toLowerCase();
      if (spelling.has(lower) && spelling.get(lower) !== path) fail('case-fold path collision');
      spelling.set(lower, path);
      const directory = depth < parts.length || entry.type === 'directory';
      if (nodes.has(path) && nodes.get(path) !== directory) fail('file or link used as ancestor');
      nodes.set(path, directory);
      if (directory) sourceDirectories.add(path);
    }
  }
  if (sourceDirectories.size > LIMITS.directories) fail('derived directory limit exceeded');
  const materialized = [];
  const directories = new Set();
  let total = 0;
  for (const entry of entries) {
    if (entry.type === 'directory') continue;
    let source = entry;
    const seen = new Set();
    let hops = 0;
    while (source.type !== 'file') {
      if (source.type === 'directory') fail('link targets a directory');
      if (seen.has(source.path) || ++hops > 16) fail('link cycle or chain limit exceeded');
      seen.add(source.path);
      const target = linkTarget(source);
      source = names.get(target);
      if (!source) fail('link target is missing');
    }
    total += source.bytes;
    materialized.push({ path: entry.path, bytes: source.bytes, sha256: source.sha256,
      executable: source.executable, source: source.path });
    const parts = entry.path.split('/');
    for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
    if (total > LIMITS.expanded || materialized.length > LIMITS.files) fail('materialized file limit exceeded');
  }
  if (materialized.length + directories.size > LIMITS.entries) fail('materialized entry limit exceeded');
  return { archiveBytes: pin.bytes, archiveSha256: pin.sha256, entries, materialized, directories: [...directories].sort() };
}

async function withArchive(archivePath, pin, operation) {
  validatePin(pin);
  const handle = await open(archivePath, constants.O_RDONLY | constants.O_NOFOLLOW
    | constants.O_NONBLOCK | (constants.O_NOCTTY ?? 0));
  try { await verifyArchive(handle, pin); return await operation(handle); }
  finally { await handle.close(); }
}

export async function inspectPythonArchive(archivePath, pin) {
  return withArchive(archivePath, pin, async (handle) => indexEntries(await parseArchive(handle, pin), pin));
}

export async function materializePythonArchive(archivePath, pin, destination) {
  return withArchive(archivePath, pin, async (handle) => {
    const index = indexEntries(await parseArchive(handle, pin), pin);
    // No destination or payload write occurs until the entire graph is validated.
    await mkdir(destination, { mode: 0o700 });
    let success = false;
    try {
      await chmod(destination, 0o700);
      for (const directory of index.directories) await mkdir(join(destination, directory), { mode: 0o700 });
      await verifyArchive(handle, pin);
      const second = await parseArchive(handle, pin, async (entry, consume) => {
        const file = await open(join(destination, entry.path), 'wx', 0o600);
        try {
          await consume(async (piece) => {
            let offset = 0;
            while (offset < piece.length) {
              const result = await file.write(piece, offset, piece.length - offset);
              if (!result.bytesWritten) fail('short output write');
              offset += result.bytesWritten;
            }
          });
        } finally { await file.close(); }
      });
      if (JSON.stringify(second) !== JSON.stringify(index.entries)) fail('archive entries changed between passes');
      for (const entry of index.materialized) {
        const target = join(destination, entry.path);
        if (entry.source !== entry.path) await copyFile(join(destination, entry.source), target, constants.COPYFILE_EXCL);
        await chmod(target, entry.executable ? 0o555 : 0o444);
      }
      // The private container remains writable for cleanup; payload directories are read-only.
      for (const directory of [...index.directories].sort((a, b) => b.length - a.length)) await chmod(join(destination, directory), 0o555);
      success = true;
      return { archiveBytes: pin.bytes, archiveSha256: pin.sha256,
        materialized: index.materialized.map(({ source: _source, ...entry }) => entry) };
    } finally {
      if (!success) {
        for (const directory of [...index.directories].sort((a, b) => a.length - b.length)) {
          await chmod(join(destination, directory), 0o700).catch(() => {});
        }
        await rm(destination, { recursive: true, force: true });
      }
    }
  });
}
