import { createHash, randomUUID } from 'node:crypto';
import { constants, closeSync, fstatSync, lstatSync, mkdirSync, openSync, opendirSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { lstat, open, realpath, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { checkSessionId } from './sessions.js';
import { MAX_INLINE_IMAGE_BYTES, type StepAttachment, type TranscriptStep } from '@extalia/importers';
import { detectImageMimeType, isCredentialFileName, sanitizeAttachmentName, type AttachmentPreview, type ImageMimeType } from '@extalia/platform';

export const OBSERVED_IMAGE_BUDGET = { files: 128, bytes: 64 * 1024 * 1024, bindings: 256, attempts: 512, pixels: 40_000_000, edge: 16_384 } as const;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const refOf = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value) && value.length === 64;
const within = (root: string, selected: string) => { const relative = path.relative(root, selected); return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative); };
const unchanged = (a: { dev: number; ino: number; size: number; mtimeMs: number }, b: { dev: number; ino: number; size: number; mtimeMs: number }) => a.dev === b.dev && a.ino === b.ino && a.size === b.size && a.mtimeMs === b.mtimeMs;

/** Header dimensions bound browser decode work. No image decoder or executable format enters this path. */
export function observedImageMime(bytes: Buffer): ImageMimeType | undefined {
  if (bytes.length === 0 || bytes.length > MAX_INLINE_IMAGE_BYTES) return undefined;
  const mime = detectImageMimeType(bytes);
  let width = 0, height = 0;
  if (mime === 'image/png' && bytes.length >= 33 && bytes.toString('ascii', 12, 16) === 'IHDR') { width = bytes.readUInt32BE(16); height = bytes.readUInt32BE(20); }
  if (mime === 'image/gif' && bytes.length >= 13) { width = bytes.readUInt16LE(6); height = bytes.readUInt16LE(8); }
  if (mime === 'image/jpeg') {
    let offset = 2;
    for (let count = 0; count < 1024 && offset + 3 < bytes.length; count++) {
      if (bytes[offset] !== 0xff) break;
      while (bytes[offset] === 0xff) offset++;
      const marker = bytes[offset++]!;
      if (marker === 0xd9 || marker === 0xda) break;
      if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
      if (offset + 2 > bytes.length) break;
      const size = bytes.readUInt16BE(offset);
      if (size < 2 || offset + size > bytes.length) break;
      if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker) && size >= 8) {
        height = bytes.readUInt16BE(offset + 3); width = bytes.readUInt16BE(offset + 5); break;
      }
      offset += size;
    }
  }
  if (mime === 'image/webp' && bytes.length >= 30) {
    const kind = bytes.toString('ascii', 12, 16);
    if (kind === 'VP8X') { width = 1 + bytes.readUIntLE(24, 3); height = 1 + bytes.readUIntLE(27, 3); }
    else if (kind === 'VP8 ' && bytes[23] === 0x9d && bytes[24] === 0x01 && bytes[25] === 0x2a) { width = bytes.readUInt16LE(26) & 0x3fff; height = bytes.readUInt16LE(28) & 0x3fff; }
    else if (kind === 'VP8L' && bytes[20] === 0x2f && bytes.length >= 25) {
      const packed = bytes.readUInt32LE(21); width = (packed & 0x3fff) + 1; height = ((packed >>> 14) & 0x3fff) + 1;
    }
  }
  return mime && width > 0 && height > 0 && width <= OBSERVED_IMAGE_BUDGET.edge && height <= OBSERVED_IMAGE_BUDGET.edge
    && width * height <= OBSERVED_IMAGE_BUDGET.pixels ? mime : undefined;
}

interface FileEntry { ref: string; size: number; mimeType: ImageMimeType; encodedSha256?: string }
interface LegacyEntry { ref: string; size: number }
interface Manifest { files: FileEntry[]; bindings: Record<string, string>; legacy?: LegacyEntry[] }

/** Per-session private content store, with durable bounded call bindings and no source paths in its manifest. */
export class ObservedImageStore {
  private manifest?: Manifest;
  private blocked = false;
  private pending = false;
  private cursor = 0;
  private sourceRevision?: string;
  get hasPending(): boolean { return this.pending; }
  private readonly attempts = new Set<string>();
  constructor(private readonly directory: string, private readonly sessionId: string) { checkSessionId(sessionId); }

  private folder(create = false): string {
    const base = realpathSync(this.directory);
    let current = base;
    for (const segment of ['observed-files', this.sessionId]) {
      current = path.join(current, segment);
      if (create) { try { mkdirSync(current, { mode: 0o700 }); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; } }
      const info = lstatSync(current);
      if (!info.isDirectory() || info.isSymbolicLink() || realpathSync(current) !== current) throw new Error('The private image folder changed.');
    }
    return current;
  }

  private load(): Manifest {
    if (this.manifest) return this.manifest;
    let stored: Manifest = { files: [], bindings: {} };
    try {
      let folder: string;
      try { folder = this.folder(); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.manifest = stored; throw error; }
      const file = path.join(folder, 'index.json');
      let info;
      try { info = lstatSync(file); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        // Older releases kept only content-addressed blobs. Reconcile a bounded inventory
        // rather than resetting their disk quota or trusting an arbitrary renderer hash.
        const directory = opendirSync(folder); let visited = 0, bytes = 0;
        stored.legacy = [];
        try {
          for (let entry = directory.readSync(); entry; entry = directory.readSync()) {
            if (++visited > OBSERVED_IMAGE_BUDGET.files || !refOf(entry.name) || !entry.isFile() || entry.isSymbolicLink()) throw new Error('Legacy image store cannot be reconciled.', { cause: error });
            const info = lstatSync(path.join(folder, entry.name)); bytes += info.size;
            if (!info.isFile() || info.isSymbolicLink() || !observedSize(info.size) || bytes > OBSERVED_IMAGE_BUDGET.bytes)
              throw new Error('Legacy image store cannot be reconciled.', { cause: error });
            stored.legacy.push({ ref: entry.name, size: info.size });
          }
        } finally { directory.closeSync(); }
        if (stored.legacy.length) this.persist(stored);
        return this.manifest = stored;
      }
      if (!info.isFile() || info.isSymbolicLink() || info.size > 100_000) throw new Error('Invalid image index.');
      const handle = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW);
      let raw: unknown;
      try { raw = JSON.parse(readBoundedSync(handle, 100_000).toString('utf8')); } finally { closeSync(handle); }
      const value = raw as Manifest;
      if (!Array.isArray(value.files) || value.files.length > OBSERVED_IMAGE_BUDGET.files || !value.bindings || typeof value.bindings !== 'object'
        || Object.keys(value.bindings).length > OBSERVED_IMAGE_BUDGET.bindings) throw new Error('Invalid image index.');
      const files = value.files.filter(entry => entry && refOf(entry.ref) && observedSize(entry.size) && ['image/png', 'image/jpeg', 'image/gif', 'image/webp'].includes(entry.mimeType) && (entry.encodedSha256 === undefined || refOf(entry.encodedSha256)));
      if (files.length !== value.files.length || new Set(files.map(entry => entry.ref)).size !== files.length
        || files.reduce((total, entry) => total + entry.size, 0) > OBSERVED_IMAGE_BUDGET.bytes) throw new Error('Invalid image index.');
      const legacy = value.legacy ?? [];
      if (!Array.isArray(legacy) || legacy.some(entry => !entry || !refOf(entry.ref) || !observedSize(entry.size))
        || files.length + legacy.length > OBSERVED_IMAGE_BUDGET.files
        || new Set([...files, ...legacy].map(entry => entry.ref)).size !== files.length + legacy.length
        || [...files, ...legacy].reduce((total, entry) => total + entry.size, 0) > OBSERVED_IMAGE_BUDGET.bytes) throw new Error('Invalid legacy image inventory.');
      const bindings = Object.fromEntries(Object.entries(value.bindings).filter(([key, ref]) => refOf(key) && refOf(ref) && files.some(entry => entry.ref === ref)));
      if (Object.keys(bindings).length !== Object.keys(value.bindings).length) throw new Error('Invalid image bindings.');
      stored = { files, bindings, ...(legacy.length ? { legacy } : {}) };
    } catch { this.blocked = true; stored = { files: [], bindings: {} }; }
    this.manifest = stored;
    return stored;
  }

  private persist(next: Manifest): void {
    if (this.blocked) throw new Error('The private image index is unavailable.');
    const folder = this.folder(true), temporary = path.join(folder, `.index-${randomUUID()}`);
    try {
      writeFileSync(temporary, JSON.stringify(next), { flag: 'wx', mode: 0o600 });
      renameSync(temporary, path.join(folder, 'index.json'));
      this.manifest = next;
    } catch (error) { rmSync(temporary, { force: true }); throw error; }
  }

  private known(data: string): string | undefined {
    if (!data.length || data.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 4) return undefined;
    const encodedSha256 = hash(data);
    return this.load().files.find(entry => entry.encodedSha256 === encodedSha256)?.ref;
  }
  private canKeep(size?: number): boolean {
    const manifest = this.load(), inventory = [...manifest.files, ...(manifest.legacy ?? [])];
    const amount = size ?? 1;
    const legacyMayMatch = manifest.legacy?.some(entry => size === undefined || entry.size === size);
    return !this.blocked && observedSize(amount) && (Boolean(legacyMayMatch) || inventory.length < OBSERVED_IMAGE_BUDGET.files
      && inventory.reduce((total, entry) => total + entry.size, 0) + amount <= OBSERVED_IMAGE_BUDGET.bytes);
  }

  keep(data: string): string | undefined {
    const manifest = this.load();
    if (this.blocked || !data.length || data.length > Math.ceil(MAX_INLINE_IMAGE_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data)) return undefined;
    const known = this.known(data); if (known) return known;
    const bytes = Buffer.from(data, 'base64'), mimeType = observedImageMime(bytes);
    if (!mimeType || bytes.toString('base64') !== data) return undefined;
    const ref = hash(bytes);
    if (manifest.files.some(entry => entry.ref === ref)) {
      try { this.persist({ ...manifest, files: manifest.files.map(entry => entry.ref === ref ? { ...entry, encodedSha256: hash(data) } : entry), bindings: { ...manifest.bindings } }); } catch { /* Existing durable content remains valid. */ }
      return ref;
    }
    const legacy = manifest.legacy ?? [], existingLegacy = legacy.find(entry => entry.ref === ref);
    const inventory = [...manifest.files, ...legacy];
    if (!existingLegacy && (inventory.length >= OBSERVED_IMAGE_BUDGET.files || inventory.reduce((total, entry) => total + entry.size, 0) + bytes.length > OBSERVED_IMAGE_BUDGET.bytes)) return undefined;
    let created: string | undefined;
    try {
      const target = path.join(this.folder(true), ref);
      // Existing entries are not overwritten. A source copy must match exactly before it is registered.
      try { writeFileSync(target, bytes, { flag: 'wx', mode: 0o600 }); created = target; }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const info = lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink() || info.size !== bytes.length) return undefined;
        const fd = openSync(target, constants.O_RDONLY | constants.O_NOFOLLOW);
        try { if (hash(readBoundedSync(fd, MAX_INLINE_IMAGE_BYTES)) !== ref) return undefined; } finally { closeSync(fd); }
      }
      this.persist({ files: [...manifest.files, { ref, size: bytes.length, mimeType, encodedSha256: hash(data) }], bindings: { ...manifest.bindings }, legacy: legacy.filter(entry => entry.ref !== ref) });
      return ref;
    } catch { if (created) { try { rmSync(created); } catch { /* Failed cleanup keeps no admission authority. */ } } return undefined; }
  }

  async preview(ref: string): Promise<AttachmentPreview | undefined> {
    if (!refOf(ref) || !this.load().files.some(entry => entry.ref === ref)) return undefined;
    let handle;
    try {
      const target = path.join(this.folder(), ref), before = await lstat(target);
      if (!before.isFile() || before.isSymbolicLink() || !observedSize(before.size)) return undefined;
      handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      const opened = await handle.stat();
      if (!unchanged(before, opened)) return undefined;
      const bytes = await readBounded(handle, opened.size), after = await handle.stat();
      const mimeType = observedImageMime(bytes);
      if (!unchanged(opened, after) || !mimeType || hash(bytes) !== ref) return undefined;
      return { mimeType, data: bytes.toString('base64') };
    } catch { return undefined; } finally { await handle?.close(); }
  }

  private rememberAttempt(key: string): void {
    this.attempts.add(key);
    while (this.attempts.size > OBSERVED_IMAGE_BUDGET.attempts) this.attempts.delete(this.attempts.values().next().value!);
  }

  private persistBinding(key: string, ref: string): string | undefined {
    const current = this.load(), bindings = { ...current.bindings, [key]: ref };
    for (const old of Object.keys(bindings).slice(0, Math.max(0, Object.keys(bindings).length - OBSERVED_IMAGE_BUDGET.bindings))) delete bindings[old];
    try { this.persist({ ...current, files: [...current.files], bindings }); return ref; } catch { return undefined; }
  }

  /** Retain images referenced by leading `[Attached file: name (path)]` tags inside Extalia's session staging folder. */
  async materializePromptAttachments(text: string, stagedAttachmentsRoot: string): Promise<StepAttachment[]> {
    const parsed = parseAttachedFilePaths(text);
    if (this.blocked || !parsed.length || !stagedAttachmentsRoot) return [];
    const results: StepAttachment[] = [];
    for (const entry of parsed.slice(0, 10)) {
      const key = hash(JSON.stringify(['prompt-staged', this.sessionId, entry.filePath]));
      let ref = this.load().bindings[key];
      if (!ref && !this.attempts.has(key) && this.canKeep()) {
        this.rememberAttempt(key);
        const bytes = await readCandidate(entry.filePath, { extraRoots: [stagedAttachmentsRoot] }, MAX_INLINE_IMAGE_BYTES);
        if (bytes && bytes !== 'deferred') {
          ref = this.keep(bytes.toString('base64'));
          if (ref) ref = this.persistBinding(key, ref);
        }
      }
      if (!ref) continue;
      const stored = this.load().files.find(item => item.ref === ref);
      if (stored) {
        results.push({ name: sanitizeAttachmentName(entry.name), kind: 'image', size: stored.size, mimeType: stored.mimeType, ref });
      }
    }
    return results;
  }

  async materialize(steps: readonly TranscriptStep[], options: { sourceId: string; projectRoot?: string; temporaryRoot: string; stagedAttachmentsRoot?: string; revision?: string }): Promise<TranscriptStep[]> {
    if (!this.pending || options.revision !== this.sourceRevision || this.cursor >= steps.length) this.cursor = 0;
    this.sourceRevision = options.revision;
    const start = this.cursor;
    this.pending = false;
    const calls = new Map<string, Extract<TranscriptStep, { type: 'tool.call' }>>();
    const result: TranscriptStep[] = [];
    let bytesThisRead = 0, attemptsThisRead = 0, deferredAt: number | undefined;
    const defer = (index: number) => { this.pending = true; deferredAt ??= index; };
    for (const [stepIndex, step] of steps.entries()) {
      const callKey = `${step.agentId ?? 'primary'}:${step.type === 'tool.call' || step.type === 'tool.result' ? step.callId ?? '' : ''}`;
      if (step.type === 'tool.call') { if (step.callId) calls.set(callKey, step); result.push(step); continue; }
      if (step.type === 'prompt') {
        if (!this.blocked && options.stagedAttachmentsRoot && !(step.attachments?.some(file => file.ref))) {
          const stagedImages = await this.materializePromptAttachments(step.text, options.stagedAttachmentsRoot);
          if (stagedImages.length) {
            result.push({ ...step, attachments: [...(step.attachments ?? []), ...stagedImages].slice(0, 10) });
            continue;
          }
        }
        result.push(step);
        continue;
      }
      if (step.type !== 'tool.result') { result.push(step); continue; }
      const call = calls.get(callKey); calls.delete(callKey);
      const files: StepAttachment[] = [];
      if (step.ok) for (const [index, file] of (step.attachments ?? []).slice(0, 10).entries()) {
        const { data, ref: _untrustedRef, ...metadata } = file;
        let ref: string | undefined;
        if (data) {
          ref = this.known(data);
          const key = hash(JSON.stringify(['inline', step.agentId, step.pos, step.callId, index, hash(data)]));
          if (!ref && stepIndex >= start && !this.attempts.has(key) && this.canKeep(file.size)) {
            if (bytesThisRead + file.size <= MAX_INLINE_IMAGE_BYTES * 2 && attemptsThisRead < 16) {
              bytesThisRead += file.size; attemptsThisRead++; ref = this.keep(data);
              this.rememberAttempt(key);
            } else defer(stepIndex);
          }
        }
        files.push({ ...metadata, name: sanitizeAttachmentName(file.name), ...(ref ? { ref } : {}) });
      }
      if (!this.blocked && step.ok && !files.some(file => file.ref) && options.sourceId === 'codex' && call && call.callId && /^(?:functions\.)?view_image$/.test(call.tool)
        && (!step.tool || step.tool === call.tool) && call.imagePath && step.imagePath === call.imagePath) {
        const key = hash(JSON.stringify([options.sourceId, this.sessionId, step.agentId, step.pos, step.callId, step.at, call.imagePath]));
        const remembered = this.load().bindings[key];
        let ref = remembered;
        if (!ref && stepIndex >= start && !this.attempts.has(key) && this.canKeep()) {
          if (attemptsThisRead >= 16 || bytesThisRead >= MAX_INLINE_IMAGE_BYTES * 2) defer(stepIndex);
          else {
          attemptsThisRead++;
          const bytes = await readCandidate(call.imagePath, { ...options, completedAt: step.at }, MAX_INLINE_IMAGE_BYTES * 2 - bytesThisRead);
          if (bytes === 'deferred') defer(stepIndex);
          else this.rememberAttempt(key);
          if (bytes && bytes !== 'deferred') {
            bytesThisRead += bytes.length; ref = this.keep(bytes.toString('base64'));
            if (ref) {
              const current = this.load(), bindings = { ...current.bindings, [key]: ref };
              for (const old of Object.keys(bindings).slice(0, Math.max(0, Object.keys(bindings).length - OBSERVED_IMAGE_BUDGET.bindings))) delete bindings[old];
              try { this.persist({ ...current, files: [...current.files], bindings }); } catch { ref = undefined; }
            }
          }
          }
        }
        if (ref) {
          const stored = this.load().files.find(entry => entry.ref === ref);
          if (stored) files.splice(0, files.length, { name: sanitizeAttachmentName(call.imagePath), kind: 'image', size: stored.size, mimeType: stored.mimeType, ref });
        }
      }
      const { attachments: _attachments, imagePath: _path, ...base } = step;
      result.push({ ...base, ...(files.length ? { attachments: files } : {}) });
    }
    this.cursor = deferredAt ?? 0;
    return result;
  }
}

async function readBounded(handle: FileHandle, size: number): Promise<Buffer> {
  if (!Number.isSafeInteger(size) || size < 0 || size > MAX_INLINE_IMAGE_BYTES) throw new Error('Image size refused.');
  const buffer = Buffer.alloc(size + 1); let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  if (offset !== size) throw new Error('Image changed while reading.');
  return buffer.subarray(0, offset);
}

function readBoundedSync(handle: number, maximum: number): Buffer {
  const before = fstatSync(handle);
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > maximum) throw new Error('Private image size refused.');
  const buffer = Buffer.alloc(before.size + 1); let offset = 0;
  while (offset < buffer.length) { const count = readSync(handle, buffer, offset, buffer.length - offset, offset); if (!count) break; offset += count; }
  if (offset !== before.size || !unchanged(before, fstatSync(handle))) throw new Error('Private image changed.');
  return buffer.subarray(0, offset);
}

function observedSize(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 && value <= MAX_INLINE_IMAGE_BYTES; }

function parseAttachedFilePaths(text: string): Array<{ name: string; filePath: string }> {
  const results: Array<{ name: string; filePath: string }> = [];
  for (const rawLine of text.split(/\r?\n/)) {
    if (!rawLine.trim()) continue;
    if (!rawLine.startsWith('[Attached file: ') || !rawLine.endsWith(']')) break;
    const inside = rawLine.slice('[Attached file: '.length, -1);
    const paren = inside.lastIndexOf(' (');
    if (paren <= 0 || !inside.endsWith(')')) continue;
    const name = inside.slice(0, paren);
    const filePath = inside.slice(paren + 2, -1);
    if (!name || !filePath) continue;
    results.push({ name, filePath });
    if (results.length >= 16) break;
  }
  return results;
}

/** Read exactly a matched image path within admitted project, temp or per-session staging roots. */
async function readCandidate(selected: string, options: { projectRoot?: string; temporaryRoot?: string; extraRoots?: readonly string[]; completedAt?: string }, maximumBytes: number): Promise<Buffer | 'deferred' | undefined> {
  if (!selected || selected.length > 4096 || /[\0\r\n]/.test(selected) || (/^[a-z][a-z0-9+.-]*:/i.test(selected) && !/^[a-z]:[\\/]/i.test(selected) || /^\\\\/.test(selected)) || isCredentialFileName(selected)
    || selected.split(/[\\/]/).includes('..')) return undefined;
  let handle;
  try {
    const requested = path.isAbsolute(selected) ? path.resolve(selected) : options.projectRoot ? path.resolve(options.projectRoot, selected) : undefined;
    if (!requested) return undefined;
    const canonical = await realpath(requested);
    let admitted: string | undefined;
    let lineage: { file: string; dev: number; ino: number; directory: boolean }[] = [];
    let leaf: { dev: number; ino: number; size: number; mtimeMs: number } | undefined;
    for (const configuredRoot of [options.projectRoot, options.temporaryRoot, ...(options.extraRoots ?? [])]) {
      if (!configuredRoot || !path.isAbsolute(configuredRoot)) continue;
      const root = await realpath(configuredRoot).catch(() => undefined);
      if (!root || root === path.parse(root).root) continue;
      const lexicalRoot = within(path.resolve(configuredRoot), requested) ? path.resolve(configuredRoot) : within(root, requested) ? root : undefined;
      if (!lexicalRoot) continue;
      const relative = path.relative(lexicalRoot, requested);
      const rootInfo = await lstat(root);
      if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) continue;
      const inspected = [{ file: root, dev: rootInfo.dev, ino: rootInfo.ino, directory: true }];
      let cursor = root, valid = true, lastInfo = rootInfo;
      for (const segment of relative.split(path.sep)) {
        cursor = path.join(cursor, segment);
        const info = await lstat(cursor);
        if (info.isSymbolicLink()) { valid = false; break; }
        inspected.push({ file: cursor, dev: info.dev, ino: info.ino, directory: info.isDirectory() }); lastInfo = info;
      }
      if (valid && cursor === canonical && within(root, canonical)) { admitted = root; lineage = inspected; leaf = lastInfo; break; }
    }
    if (!admitted) return undefined;
    const before = await lstat(canonical);
    if (!before.isFile() || before.isSymbolicLink() || !observedSize(before.size) || !leaf || !unchanged(before, leaf)) return undefined;
    const completedAt = options.completedAt ? Date.parse(options.completedAt) : NaN;
    // A reused screenshot path must not substitute newer pixels for a recorded historical view.
    // Unknown source time stays unverified; already captured bindings bypass this filesystem fallback.
    if (Number.isFinite(completedAt) && before.mtimeMs > completedAt + 1_000) return undefined;
    if (before.size > maximumBytes) return 'deferred';
    handle = await open(canonical, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!unchanged(before, opened)) return undefined;
    const bytes = await readBounded(handle, opened.size), after = await handle.stat();
    if (!unchanged(opened, after) || bytes.length !== opened.size || !observedImageMime(bytes) || await realpath(requested) !== canonical) return undefined;
    for (const expected of lineage) {
      const actual = await lstat(expected.file);
      if (actual.isSymbolicLink() || actual.dev !== expected.dev || actual.ino !== expected.ino || actual.isDirectory() !== expected.directory) return undefined;
    }
    return bytes;
  } catch { return undefined; } finally { await handle?.close(); }
}
