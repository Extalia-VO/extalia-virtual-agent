import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, opendir, rm, type FileHandle } from 'node:fs/promises';
import path from 'node:path';
import { countSecrets, redact, safeLabel } from '@extalia/core';
import type { AnyTool, ToolDefinition } from '@extalia/runtime';
import { isNotFound, writeFileAtomic } from './jsonStore.js';
import { failure, text } from './tools/shared.js';

export const MEMORY_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MEMORY_CONTENT_LIMIT = 20_000;
const FILE_BYTES = 80_000;
const SCAN_BYTES = 2 * 1024 * 1024;
const DIRECTORY_ENTRIES = 4096;
const SEARCH_CANDIDATES = 128;
const READ_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0) | (constants.O_NOCTTY ?? 0);
const UNAVAILABLE = 'Memory note is unavailable or unsafe to read.';

export interface MemoryNote {
  name: string;
  /** First non-empty line, without Markdown heading marks, at most 120 code points. */
  summary: string;
  updatedAt: string;
}

export interface MemoryCatalog {
  notes: MemoryNote[];
  /** Known source candidates not represented in this page; an incomplete directory may contain more. */
  omitted: number;
  incomplete: boolean;
  nextOffset?: number;
}

interface LoadedNote { note: MemoryNote; content: string; sourceOffset: number }
interface Scan { notes: LoadedNote[]; omitted: number; incomplete: boolean; nextOffset?: number }
interface SearchHit extends MemoryNote { excerpt: string }
interface SearchResult { hits: SearchHit[]; incomplete: boolean; nextScanOffset?: number; nextHitOffset?: number; omittedHits: number }

function checkName(name: string): string {
  if (typeof name !== 'string' || !MEMORY_NAME_PATTERN.test(name) || redact(name) !== name) {
    throw new Error('Memory note names use lowercase letters, numbers and hyphens (up to 64 characters), for example "project-setup".');
  }
  return name;
}

function integer(value: unknown, fallback: number, min: number, max: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error('Invalid memory pagination value.');
  return value;
}

function slice(value: string, offset: number, limit: number): string {
  return Array.from(value).slice(offset, offset + limit).join('');
}

/** Redact the complete text before any excerpt, summary, matching, or page boundary is selected. */
function safeContent(content: string): string {
  // eslint-disable-next-line no-control-regex
  const normalized = redact(content).replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '');
  // Removing controls can join a previously separated credential pattern.
  return redact(normalized);
}

function summarize(content: string): string {
  const line = content.split('\n').map(item => item.replace(/^#+\s*/, '').trim()).find(Boolean) ?? '';
  return slice(line.replace(/[\p{Cc}\p{Cf}\s]+/gu, ' '), 0, 120);
}

function regular(info: Stats): boolean { return info.isFile() && info.nlink === 1 && info.size <= FILE_BYTES; }
function same(a: Stats, b: Stats): boolean {
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.nlink === b.nlink && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
}

/** Workspace Markdown notes only. Root/ancestors must be trusted and quiescent; these checks are not an adversarial atomic-filesystem guarantee. */
export class MemoryStore {
  constructor(readonly directory: string) {}

  private file(name: string): string { return path.join(this.directory, `${checkName(name)}.md`); }

  private async root(): Promise<boolean> {
    try {
      const info = await lstat(this.directory);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error(UNAVAILABLE);
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      // eslint-disable-next-line preserve-caught-error -- Do not expose filesystem paths through memory errors.
      throw new Error(UNAVAILABLE);
    }
  }

  private async names(): Promise<{ names: string[]; incomplete: boolean }> {
    if (!await this.root()) return { names: [], incomplete: false };
    const names: string[] = [];
    let count = 0;
    let incomplete = false;
    try {
      const directory = await opendir(this.directory);
      for await (const entry of directory) {
        if (count++ === DIRECTORY_ENTRIES) { incomplete = true; break; }
        const name = entry.name.endsWith('.md') ? entry.name.slice(0, -3) : '';
        if (MEMORY_NAME_PATTERN.test(name)) names.push(name);
      }
      return { names: names.sort(), incomplete };
    } catch { throw new Error(UNAVAILABLE); }
  }

  private async load(name: string, budget: { remaining: number }): Promise<{ content: string; updatedAt: string } | 'missing' | 'unsafe' | 'budget'> {
    const file = this.file(name);
    let handle: FileHandle | undefined;
    try {
      const before = await lstat(file);
      if (!regular(before)) return 'unsafe';
      if (before.size > budget.remaining) return 'budget';
      handle = await open(file, READ_FLAGS);
      const opened = await handle.stat();
      if (!regular(opened) || !same(before, opened)) return 'unsafe';
      const buffer = Buffer.alloc(opened.size);
      let position = 0;
      while (position < buffer.length) {
        const { bytesRead } = await handle.read(buffer, position, buffer.length - position, position);
        budget.remaining -= bytesRead;
        if (!bytesRead) return 'unsafe';
        position += bytesRead;
      }
      const [after, current] = await Promise.all([handle.stat(), lstat(file)]);
      if (!same(opened, after) || !same(after, current) || !regular(current)) return 'unsafe';
      const content = new TextDecoder('utf-8', { fatal: true }).decode(buffer);
      return { content: safeContent(content), updatedAt: after.mtime.toISOString() };
    } catch (error) {
      return isNotFound(error) ? 'missing' : 'unsafe';
    } finally { await handle?.close().catch(() => undefined); }
  }

  private async scan(offset: number, limit: number): Promise<Scan> {
    const directory = await this.names();
    const notes: LoadedNote[] = [];
    const budget = { remaining: SCAN_BYTES };
    let cursor = Math.min(offset, directory.names.length);
    let incomplete = directory.incomplete;
    const end = Math.min(directory.names.length, cursor + limit);
    while (cursor < end) {
      const name = directory.names[cursor]!;
      if (redact(name) !== name) { incomplete = true; cursor++; continue; }
      const loaded = await this.load(name, budget);
      if (loaded === 'budget') { incomplete = true; break; }
      if (typeof loaded === 'string') incomplete = true;
      else notes.push({ note: { name, summary: summarize(loaded.content), updatedAt: loaded.updatedAt }, content: loaded.content, sourceOffset: cursor });
      cursor++;
    }
    if (cursor < directory.names.length) incomplete = true;
    return { notes, omitted: directory.names.length - notes.length, incomplete, ...(cursor < directory.names.length ? { nextOffset: cursor } : {}) };
  }

  async catalog(options: { offset?: number; limit?: number } = {}): Promise<MemoryCatalog> {
    const result = await this.scan(integer(options.offset, 0, 0, DIRECTORY_ENTRIES), integer(options.limit, 8, 1, 128));
    return { ...result, notes: result.notes.map(item => item.note) };
  }

  async list(): Promise<MemoryNote[]> { return (await this.catalog({ limit: 128 })).notes; }

  /** Bounded JSON listing; resume before any metadata removed by the output budget. */
  async listPage(options: { offset?: number; limit?: number } = {}): Promise<MemoryCatalog> {
    const result = await this.scan(integer(options.offset, 0, 0, DIRECTORY_ENTRIES), integer(options.limit, 20, 1, 50));
    const notes = [...result.notes];
    let nextOffset = result.nextOffset;
    const page = (): MemoryCatalog => ({ notes: notes.map(item => item.note), omitted: result.omitted + result.notes.length - notes.length, incomplete: result.incomplete || notes.length < result.notes.length, ...(nextOffset !== undefined ? { nextOffset } : {}) });
    while (JSON.stringify(page()).length > 6000 && notes.length) nextOffset = notes.pop()!.sourceOffset;
    return page();
  }

  async search(options: { query: string; limit?: number; scan_offset?: number; hit_offset?: number }): Promise<SearchResult> {
    if (typeof options.query !== 'string' || !options.query.trim() || options.query.length > 200) throw new Error('Memory search needs a query of 1–200 characters and at most eight literal terms.');
    const queryTerms = options.query.trim().normalize('NFC').toLowerCase().split(/\s+/u);
    if (queryTerms.length > 8) throw new Error('Memory search accepts at most eight literal terms.');
    const terms = [...new Set(queryTerms)];
    const limit = integer(options.limit, 5, 1, 10);
    const hitOffset = integer(options.hit_offset, 0, 0, SEARCH_CANDIDATES);
    const scan = await this.scan(integer(options.scan_offset, 0, 0, DIRECTORY_ENTRIES), SEARCH_CANDIDATES);
    const ranked: { hit: SearchHit; score: number }[] = [];
    for (const { note, content } of scan.notes) {
      const name = note.name.toLowerCase();
      const summary = note.summary.normalize('NFC').toLowerCase();
      const body = content.normalize('NFC').toLowerCase();
      if (!terms.every(term => name.includes(term) || summary.includes(term) || body.includes(term))) continue;
      const score = terms.reduce((sum, term) => sum + (name.includes(term) ? 10_000 : summary.includes(term) ? 100 : 1), 0);
      const match = Math.min(...terms.map(term => body.indexOf(term)).filter(index => index >= 0));
      const start = Number.isFinite(match) ? Math.max(0, Array.from(body.slice(0, match)).length - 40) : 0;
      const available = Math.max(0, 240 - Array.from(note.name + note.summary + note.updatedAt).length);
      // Match positions refer to this normalized lowercase representation, not the original text.
      ranked.push({ hit: { ...note, excerpt: slice(body, start, available) }, score });
    }
    ranked.sort((a, b) => b.score - a.score || (a.hit.name < b.hit.name ? -1 : a.hit.name > b.hit.name ? 1 : 0));
    const hits = ranked.slice(hitOffset, hitOffset + limit).map(item => item.hit);
    const page = (): SearchResult => {
      const next = hitOffset + hits.length;
      const omittedHits = Math.max(0, ranked.length - next);
      return { hits, incomplete: scan.incomplete, ...(scan.nextOffset !== undefined ? { nextScanOffset: scan.nextOffset } : {}), ...(omittedHits ? { nextHitOffset: next } : {}), omittedHits };
    };
    while (JSON.stringify(page()).length > 4000 && hits.length) hits.pop();
    return page();
  }

  async read(name: string): Promise<string | undefined> {
    checkName(name);
    if (!await this.root()) return undefined;
    const result = await this.load(name, { remaining: FILE_BYTES });
    if (result === 'missing') return undefined;
    if (typeof result === 'string') throw new Error(UNAVAILABLE);
    return result.content;
  }

  /** Save a note. Returns how many likely credentials were masked. */
  async write(name: string, content: string): Promise<{ masked: number }> {
    const file = this.file(name);
    if (typeof content !== 'string' || !content.trim()) throw new Error('A memory note needs content.');
    if (content.length > MEMORY_CONTENT_LIMIT) throw new Error(`A memory note is limited to ${MEMORY_CONTENT_LIMIT} characters; this one has ${content.length}. Keep notes short and specific.`);
    const stored = safeContent(content);
    if (stored.length > MEMORY_CONTENT_LIMIT) throw new Error(`A sanitized memory note is limited to ${MEMORY_CONTENT_LIMIT} characters. Keep the note shorter.`);
    try {
      await this.root();
      await mkdir(this.directory, { recursive: true, mode: 0o700 });
      await this.root();
      try { if (!regular(await lstat(file))) throw new Error(UNAVAILABLE); }
      catch (error) { if (!isNotFound(error)) throw error; }
      const masked = countSecrets(content);
      await writeFileAtomic(file, stored);
      return { masked };
    } catch { throw new Error('Memory note could not be saved safely.'); }
  }

  async delete(name: string): Promise<void> {
    const file = this.file(name);
    if (!await this.root()) return;
    try {
      if (!regular(await lstat(file))) throw new Error(UNAVAILABLE);
      await rm(file);
    } catch (error) {
      if (!isNotFound(error)) {
        // eslint-disable-next-line preserve-caught-error -- Do not expose filesystem paths through memory errors.
        throw new Error('Memory note could not be deleted safely.');
      }
    }
  }
}

type PageInput = { offset?: number; limit?: number };
type NameInput = PageInput & { name: string };
type WriteInput = { name: string; content: string };

/** Progressive memory lookup; memory_write remains the only model-facing writer. */
export function createMemoryTools(store: MemoryStore): AnyTool[] {
  const nameProperty = { type: 'string', description: 'Note name: lowercase letters, numbers and hyphens, for example "build-commands".' } as const;
  const offset = { type: 'integer', minimum: 0, maximum: DIRECTORY_ENTRIES, description: 'Source-candidate offset from the previous response.' } as const;
  const list: ToolDefinition<PageInput> = {
    name: 'memory_list',
    description: 'List a bounded page of workspace memory metadata as JSON; use nextOffset for more. Omitted and incomplete identify preview limits.',
    parameters: { type: 'object', properties: { offset, limit: { type: 'integer', minimum: 1, maximum: 50 } }, additionalProperties: false },
    access: 'memory', kind: 'knowledge',
    describe: () => ({ label: 'Listing memory notes' }),
    run: async input => {
      try { return { ok: true, output: JSON.stringify(await store.listPage(input)) }; }
      catch { return failure('Memory metadata is unavailable or pagination is invalid.'); }
    },
  };
  const search: ToolDefinition<{ query: string; limit?: number; scan_offset?: number; hit_offset?: number }> = {
    name: 'memory_search',
    description: 'Search workspace memory with up to eight literal terms (no regex). Returns ranked metadata and short NFC-normalized lowercase excerpts, not verbatim quotations or full notes. OmittedHits counts remaining matches in this source page. Exhaust nextHitOffset by passing it as hit_offset with the same query and scan_offset before advancing to nextScanOffset; reset hit_offset to zero for a new source page. Offsets assume unchanged notes between calls. Incomplete scans do not prove absence.',
    parameters: { type: 'object', properties: { query: { type: 'string', description: '1–200 characters; up to eight whitespace-separated literal terms.' }, limit: { type: 'integer', minimum: 1, maximum: 10 }, scan_offset: offset, hit_offset: { type: 'integer', minimum: 0, maximum: SEARCH_CANDIDATES, description: 'Ranked-hit offset for the current scan_offset, from nextHitOffset.' } }, required: ['query'], additionalProperties: false },
    access: 'memory', kind: 'knowledge',
    describe: () => ({ label: 'Searching memory notes' }),
    run: async input => {
      try { return { ok: true, output: JSON.stringify(await store.search(input)) }; }
      catch { return failure('Memory search is unavailable or its query/pagination is invalid. Use 1–200 characters and at most eight literal terms.'); }
    },
  };
  const read: ToolDefinition<NameInput> = {
    name: 'memory_read',
    description: 'Read a workspace note. Supply offset or limit for a bounded JSON page in Unicode code points after redaction (default 2000, maximum 8000); without either, read the full normal note.',
    parameters: { type: 'object', properties: { name: nameProperty, offset: { type: 'integer', minimum: 0, maximum: FILE_BYTES }, limit: { type: 'integer', minimum: 1, maximum: 8000 } }, required: ['name'], additionalProperties: false },
    access: 'memory', kind: 'knowledge',
    describe: input => ({ label: `Reading memory ${safeLabel(input.name, 64)}`, target: safeLabel(input.name, 64) }),
    run: async input => {
      try {
        const name = checkName(input.name);
        const start = integer(input.offset, 0, 0, FILE_BYTES);
        const limit = integer(input.limit, 2000, 1, 8000);
        const content = await store.read(name);
        if (content === undefined) return failure('Memory note was not found. Use memory_search to find relevant note names.');
        if (input.offset === undefined && input.limit === undefined) {
          if (content.length > MEMORY_CONTENT_LIMIT) return failure('This external memory note needs a bounded page. Supply offset and limit to memory_read.');
          return { ok: true, output: content };
        }
        const points = Array.from(content);
        const end = Math.min(points.length, start + limit);
        return { ok: true, output: JSON.stringify({ name, offset: start, ...(end < points.length ? { nextOffset: end } : {}), totalCharacters: points.length, text: points.slice(start, end).join(''), truncated: start > 0 || end < points.length, offsetUnit: 'unicode-code-points' }) };
      } catch { return failure('Memory note is unavailable, unsafe, or its name/pagination is invalid. Use memory_search for available metadata.'); }
    },
  };
  const write: ToolDefinition<WriteInput> = {
    name: 'memory_write',
    description: `Create or replace a workspace memory note (Markdown, up to ${MEMORY_CONTENT_LIMIT} characters). Save only durable, explicitly confirmed facts. Never capture transcripts automatically or save credentials; credentials are masked.`,
    parameters: { type: 'object', properties: { name: nameProperty, content: { type: 'string', description: 'Full note content. The first line is used as its summary.' } }, required: ['name', 'content'], additionalProperties: false },
    access: 'memory', kind: 'knowledge',
    describe: input => ({ label: `Saving memory ${safeLabel(input.name, 64)}`, target: safeLabel(input.name, 64) }),
    run: async input => {
      try {
        const { masked } = await store.write(text(input.name), text(input.content));
        return { ok: true, output: `Saved memory note "${safeLabel(input.name, 64)}".${masked ? ` ${masked} likely credential(s) were masked.` : ''}` };
      } catch (error) { return failure(error instanceof Error ? error.message : 'Memory note could not be saved safely.'); }
    },
  };
  return [list, search, read, write];
}
