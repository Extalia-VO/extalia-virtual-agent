import { execFileSync } from 'node:child_process';
import { link, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { createMemoryTools, MemoryStore } from '../src/memory.js';
import { runTool, useTempDirs } from './helpers.js';

const temp = useTempDirs();
const posix = process.platform !== 'win32';

async function fixture() {
  const root = await temp();
  const directory = path.join(root, 'memory');
  await mkdir(directory);
  const store = new MemoryStore(directory);
  return { root, directory, store, tools: createMemoryTools(store) };
}

async function external(directory: string, name: string, content: string | Buffer) {
  await writeFile(path.join(directory, `${name}.md`), content);
}

function data(output: string): Record<string, unknown> { return JSON.parse(output) as Record<string, unknown>; }

describe('progressive workspace memory', () => {
  it('keeps normal read/write/list/delete behavior and adds bounded catalog pages', async () => {
    const { store, tools } = await fixture();
    for (let i = 0; i < 12; i++) await store.write(`note-${String(i).padStart(2, '0')}`, `# Decision ${i}\nCurrent convention.`);
    expect(await store.catalog()).toMatchObject({ omitted: 4, incomplete: true, nextOffset: 8 });
    const first = await store.catalog();
    expect(first.notes.map(note => note.name)).toEqual(Array.from({ length: 8 }, (_, i) => `note-0${i}`));
    const second = await store.catalog({ offset: first.nextOffset });
    expect(second.notes).toHaveLength(4);
    expect(second.nextOffset).toBeUndefined();
    expect(await store.list()).toHaveLength(12);
    expect((await runTool(tools, 'memory_read', { name: 'note-00' })).output).toBe('# Decision 0\nCurrent convention.');
    await store.delete('note-00');
    expect(await store.read('note-00')).toBeUndefined();
    expect(await store.list()).toHaveLength(11);
    await store.delete('missing');
    expect(tools.map(tool => tool.name)).toEqual(['memory_list', 'memory_search', 'memory_read', 'memory_write']);
    expect(tools.every(tool => tool.access === 'memory')).toBe(true);
  });

  it('ranks literal matches in names, summaries, then bodies and limits excerpt metadata', async () => {
    const { store, tools } = await fixture();
    await store.write('deploy', '# Unrelated\nUnrelated details.');
    await store.write('summary', '# Deploy convention\nDetails.');
    await store.write('body-a', '# Current workflow\nUse deploy after checks.');
    await store.write('body-b', '# Current workflow\nUse deploy after checks.');
    const result = await runTool(tools, 'memory_search', { query: 'DEPLOY' });
    expect(result.ok).toBe(true);
    const page = JSON.parse(result.output) as { hits: { name: string; summary: string; updatedAt: string; excerpt: string }[]; omittedHits: number };
    expect(page.hits.map(hit => hit.name)).toEqual(['deploy', 'summary', 'body-a', 'body-b']);
    for (const hit of page.hits) expect(Array.from(hit.name + hit.summary + hit.updatedAt + hit.excerpt).length).toBeLessThanOrEqual(240);
    expect(result.output.length).toBeLessThanOrEqual(4000);
    expect(page.omittedHits).toBe(0);
    expect(data((await runTool(tools, 'memory_search', { query: 'deploy', limit: 1 })).output).omittedHits).toBe(3);
  });

  it('searches subsequent source pages rather than repeatedly returning the first matching names', async () => {
    const { directory, tools } = await fixture();
    await Promise.all(Array.from({ length: 140 }, (_, i) => external(directory, `note-${String(i).padStart(3, '0')}`, i >= 128 ? '# Needle\nLater source.' : '# Other')));
    const first = data((await runTool(tools, 'memory_search', { query: 'needle' })).output);
    expect(first).toMatchObject({ hits: [], incomplete: true, nextScanOffset: 128 });
    const second = data((await runTool(tools, 'memory_search', { query: 'needle', scan_offset: first.nextScanOffset, limit: 10 })).output);
    expect((second.hits as unknown[])).toHaveLength(10);
    expect(second).toMatchObject({ incomplete: false, omittedHits: 2, nextHitOffset: 10 });
    expect(second.nextScanOffset).toBeUndefined();
    const final = data((await runTool(tools, 'memory_search', { query: 'needle', scan_offset: first.nextScanOffset, hit_offset: second.nextHitOffset, limit: 10 })).output);
    expect(final).toMatchObject({ incomplete: false, omittedHits: 0 });
    expect(final.nextHitOffset).toBeUndefined();
    const names = [...second.hits as { name: string }[], ...final.hits as { name: string }[]].map(hit => hit.name);
    expect(names).toEqual(Array.from({ length: 12 }, (_, i) => `note-${128 + i}`));
  });

  it('keeps hits dropped by the JSON budget reachable within the same scanned source page', async () => {
    const { directory, tools } = await fixture();
    const names = Array.from({ length: 12 }, (_, i) => `note-${String(i).padStart(2, '0')}-${'a'.repeat(56)}`);
    await Promise.all(names.map(name => external(directory, name, '# Target ' + '"'.repeat(113))));
    const found: string[] = [];
    let hitOffset = 0;
    for (let i = 0; i < 12; i++) {
      const result = await runTool(tools, 'memory_search', { query: 'target', scan_offset: 0, hit_offset: hitOffset, limit: 10 });
      expect(result.ok).toBe(true);
      expect(result.output.length).toBeLessThanOrEqual(4000);
      const page = data(result.output);
      const hits = page.hits as { name: string }[];
      if (i === 0) expect(hits.length).toBeLessThan(10);
      found.push(...hits.map(hit => hit.name));
      expect(page.omittedHits).toBe(names.length - found.length);
      expect(page.nextScanOffset).toBeUndefined();
      if (page.nextHitOffset === undefined) break;
      expect(page.nextHitOffset).toBeGreaterThan(hitOffset);
      expect(page.nextHitOffset).toBe(hitOffset + hits.length);
      hitOffset = page.nextHitOffset as number;
    }
    expect(found).toEqual(names);
  });

  it('redacts externally edited complete text before matching, summaries, or page slicing', async () => {
    const { directory, store, tools } = await fixture();
    const credential = 'sk-' + 'q'.repeat(30);
    await external(directory, 'edited', '# ' + 'x'.repeat(113) + ` ${credential}\nsecond\u0000\r\nline\tkept\u0007\nto\u0000ken=hidden-secret-value`);
    const all = await store.read('edited');
    expect(all).toContain('[redacted]');
    expect(all).not.toContain(credential);
    expect(all).toContain('second\nline\tkept');
    expect(all).not.toContain('hidden-secret-value');
    const catalog = await store.catalog();
    expect(catalog.notes[0]!.summary).not.toContain('qqqq');
    expect((await store.search({ query: credential })).hits).toEqual([]);
    expect((await store.search({ query: '[redacted]' })).hits.map(hit => hit.name)).toEqual(['edited']);
    const part = data((await runTool(tools, 'memory_read', { name: 'edited', offset: 112, limit: 12 })).output);
    expect(part.text).toBe(Array.from(all!).slice(112, 124).join(''));
    expect(part.text).not.toContain('qqqq');
    expect(await readFile(path.join(directory, 'edited.md'), 'utf8')).toContain(credential);
  });

  it('selects search excerpts from the normalized representation whose match positions were found', async () => {
    const { store } = await fixture();
    await store.write('decomposed', '# Topic\n' + 'e\u0301'.repeat(1000) + ' needle');
    const result = await store.search({ query: 'needle' });
    expect(result.hits).toHaveLength(1);
    expect(result.hits[0]!.excerpt).toContain('needle');
    expect(result.hits[0]!.excerpt).not.toContain('e\u0301');
  });

  it('rejects redaction expansion beyond the managed size limit before writing', async () => {
    const { directory, store, tools } = await fixture();
    const expands = 'x'.repeat(19_987) + ' token=abcdef';
    expect(expands.length).toBe(20_000);
    await expect(store.write('expands', expands)).rejects.toThrow(/sanitized memory note is limited/);
    await expect(readFile(path.join(directory, 'expands.md'))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.write('existing', 'Keep the existing note.');
    await expect(store.write('existing', expands)).rejects.toThrow(/sanitized memory note is limited/);
    expect(await store.read('existing')).toBe('Keep the existing note.');
    await store.write('at-boundary', 'x'.repeat(19_983) + ' token=abcdef');
    const read = await runTool(tools, 'memory_read', { name: 'at-boundary' });
    expect(read.ok).toBe(true);
    expect(read.output.length).toBe(20_000);
    expect(read.output).toContain('token=[redacted]');
  });

  it('pages in Unicode code points after redaction without splitting emoji or UTF-8 characters', async () => {
    const { store, tools } = await fixture();
    await store.write('unicode', '日本語 🪨 café\n🪨 selesai');
    const all = (await store.read('unicode'))!;
    const first = data((await runTool(tools, 'memory_read', { name: 'unicode', limit: 5 })).output);
    expect(first).toMatchObject({ name: 'unicode', offset: 0, nextOffset: 5, totalCharacters: Array.from(all).length, text: '日本語 🪨', truncated: true, offsetUnit: 'unicode-code-points' });
    const rest = data((await runTool(tools, 'memory_read', { name: 'unicode', offset: first.nextOffset, limit: 8000 })).output);
    expect(String(first.text) + String(rest.text)).toBe(all);
    expect(rest.nextOffset).toBeUndefined();
    expect(rest.text).not.toContain('�');
    const empty = data((await runTool(tools, 'memory_read', { name: 'unicode', offset: 100 })).output);
    expect(empty.text).toBe('');
  });

  it('preserves a full normal 20k read while asking for pages for larger external notes', async () => {
    const { directory, store, tools } = await fixture();
    const normal = 'x'.repeat(20_000);
    await store.write('normal', normal);
    expect((await runTool(tools, 'memory_read', { name: 'normal' })).output).toBe(normal);
    await expect(store.write('too-large', normal + 'x')).rejects.toThrow(/limited/);
    await external(directory, 'external', '🪨'.repeat(15_000));
    const full = await runTool(tools, 'memory_read', { name: 'external' });
    expect(full).toMatchObject({ ok: false });
    expect(full.output).toContain('offset and limit');
    const paged = data((await runTool(tools, 'memory_read', { name: 'external', offset: 0, limit: 8000 })).output);
    expect(paged).toMatchObject({ totalCharacters: 15_000, nextOffset: 8000 });
    expect(Array.from(String(paged.text))).toHaveLength(8000);
  });

  it('enforces the 80k byte file ceiling, including multibyte text, and refuses invalid UTF-8', async () => {
    const { directory, store } = await fixture();
    await external(directory, 'at-limit', 'a'.repeat(80_000));
    await external(directory, 'over-limit', 'a'.repeat(80_001));
    await external(directory, 'unicode-over', '🪨'.repeat(20_001));
    await external(directory, 'bad-utf8', Buffer.from([0xff, 0xfe, 0xfd]));
    expect((await store.read('at-limit'))!.length).toBe(80_000);
    await expect(store.read('over-limit')).rejects.toThrow(/unavailable or unsafe/);
    await expect(store.read('unicode-over')).rejects.toThrow(/unavailable or unsafe/);
    await expect(store.read('bad-utf8')).rejects.toThrow(/unavailable or unsafe/);
    expect(await store.catalog({ limit: 128 })).toMatchObject({ notes: [{ name: 'at-limit' }], omitted: 3, incomplete: true });
  });

  it('stops at the 2MiB scan budget and resumes at the first unconsumed source candidate', async () => {
    const { directory, store } = await fixture();
    await Promise.all(Array.from({ length: 30 }, (_, i) => external(directory, `large-${String(i).padStart(2, '0')}`, '# Target\n' + 'x'.repeat(79_991))));
    const first = await store.catalog({ limit: 128 });
    expect(first.notes).toHaveLength(26);
    expect(first).toMatchObject({ omitted: 4, incomplete: true, nextOffset: 26 });
    const rest = await store.catalog({ limit: 128, offset: first.nextOffset });
    expect(rest.notes).toHaveLength(4);
    expect(rest.incomplete).toBe(false);
    expect(new Set([...first.notes, ...rest.notes].map(note => note.name)).size).toBe(30);
    const search = await store.search({ query: 'target', limit: 10 });
    expect(search).toMatchObject({ nextScanOffset: 26, incomplete: true, omittedHits: 16 });
  });

  it.skipIf(!posix)('rejects links, hardlinks, directories and FIFOs without blocking, while consuming their offsets', async () => {
    const { root, directory, store, tools } = await fixture();
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, '# Never read this linked note');
    await symlink(outside, path.join(directory, 'a-symlink.md'));
    await link(outside, path.join(directory, 'b-hardlink.md'));
    await mkdir(path.join(directory, 'c-directory.md'));
    execFileSync('mkfifo', [path.join(directory, 'd-fifo.md')]);
    await external(directory, 'e-regular', '# Current note');
    expect(await store.catalog({ limit: 2 })).toEqual({ notes: [], omitted: 5, incomplete: true, nextOffset: 2 });
    expect(await store.catalog({ offset: 2, limit: 3 })).toMatchObject({ notes: [{ name: 'e-regular' }], omitted: 4, incomplete: true });
    for (const name of ['a-symlink', 'b-hardlink', 'c-directory', 'd-fifo']) {
      await expect(store.read(name)).rejects.toThrow(/unavailable or unsafe/);
      expect((await runTool(tools, 'memory_read', { name })).ok).toBe(false);
      await expect(store.write(name, 'Replacement')).rejects.toThrow(/safely/);
    }
    expect(await readFile(outside, 'utf8')).toBe('# Never read this linked note');
  });

  it.skipIf(!posix)('refuses a symlinked memory root for both reads and writes', async () => {
    const root = await temp();
    const target = path.join(root, 'target');
    await mkdir(target);
    await external(target, 'note', 'Keep this note.');
    const directory = path.join(root, 'linked-memory');
    await symlink(target, directory);
    const store = new MemoryStore(directory);
    await expect(store.catalog()).rejects.toThrow(/unavailable/);
    await expect(store.read('note')).rejects.toThrow(/unavailable/);
    await expect(store.write('note', 'Changed')).rejects.toThrow(/safely/);
    expect(await readFile(path.join(target, 'note.md'), 'utf8')).toBe('Keep this note.');
  });

  it('caps directory discovery and reports that known omissions are only a lower bound', async () => {
    const { directory, store } = await fixture();
    for (let offset = 0; offset < 4097; offset += 128) {
      await Promise.all(Array.from({ length: Math.min(128, 4097 - offset) }, (_, index) => external(directory, `note-${String(offset + index).padStart(4, '0')}`, '')));
    }
    const page = await store.catalog();
    expect(page.notes).toHaveLength(8);
    expect(page).toMatchObject({ omitted: 4088, incomplete: true, nextOffset: 8 });
    const end = await store.catalog({ offset: 4096 });
    expect(end).toMatchObject({ notes: [], omitted: 4096, incomplete: true });
    expect(end.nextOffset).toBeUndefined();
  });

  it('bounds JSON listing output and resumes before metadata removed by the output limit', async () => {
    const { directory, tools } = await fixture();
    await Promise.all(Array.from({ length: 50 }, (_, i) => external(directory, `note-${String(i).padStart(2, '0')}-${'a'.repeat(50)}`, '# ' + '"'.repeat(120))));
    const first = await runTool(tools, 'memory_list', { limit: 50 });
    expect(first.output.length).toBeLessThanOrEqual(6000);
    const page = data(first.output);
    const names = (page.notes as { name: string }[]).map(note => note.name);
    expect(names.length).toBeLessThan(50);
    expect(page).toMatchObject({ omitted: 50 - names.length, incomplete: true, nextOffset: names.length });
    const next = data((await runTool(tools, 'memory_list', { offset: page.nextOffset, limit: 50 })).output);
    expect((next.notes as { name: string }[])[0]!.name).not.toBe(names[0]);
    expect(names).not.toContain((next.notes as { name: string }[])[0]!.name);
  });

  it('matches literal regex/JSON syntax safely and rejects invalid query or pagination values', async () => {
    const { store, tools } = await fixture();
    await store.write('literal', '# Literal pattern\nKeep .* [a-z] and "}, {"scope":"other" as text.');
    const literal = await runTool(tools, 'memory_search', { query: '.* [a-z]' });
    expect((data(literal.output).hits as unknown[])).toHaveLength(1);
    expect((data((await runTool(tools, 'memory_search', { query: '^not-a-regex$' })).output).hits as unknown[])).toHaveLength(0);
    for (const query of ['', '   ', 'x'.repeat(201), 'a b c d e f g h i', 'a a a a a a a a a', 9, null]) expect((await runTool(tools, 'memory_search', { query })).ok).toBe(false);
    for (const value of [-1, 1.5, '2', null, Infinity, NaN]) {
      expect((await runTool(tools, 'memory_list', { offset: value })).ok).toBe(false);
      expect((await runTool(tools, 'memory_search', { query: 'literal', scan_offset: value })).ok).toBe(false);
      expect((await runTool(tools, 'memory_search', { query: 'literal', hit_offset: value })).ok).toBe(false);
      expect((await runTool(tools, 'memory_read', { name: 'literal', offset: value })).ok).toBe(false);
    }
    expect((await runTool(tools, 'memory_read', { name: 'literal', limit: 8001 })).ok).toBe(false);
    expect((await runTool(tools, 'memory_list', { limit: 51 })).ok).toBe(false);
    expect((await runTool(tools, 'memory_search', { query: 'literal', limit: 11 })).ok).toBe(false);
    expect((await runTool(tools, 'memory_search', { query: 'literal', hit_offset: 129 })).ok).toBe(false);
    await expect(store.catalog({ offset: 4097 })).rejects.toThrow(/pagination/);
  });

  it('never enumerates unrelated note names in missing-note errors or leaks raw filesystem paths', async () => {
    const { root, store, tools } = await fixture();
    await store.write('private-topic', '# A local note');
    const missing = await runTool(tools, 'memory_read', { name: 'missing' });
    expect(missing.ok).toBe(false);
    expect(missing.output).toContain('memory_search');
    expect(missing.output).not.toContain('private-topic');
    expect(missing.output).not.toContain(root);
    const bad = await runTool(tools, 'memory_read', { name: '../escape' });
    expect(bad.ok).toBe(false);
    expect(bad.output).not.toContain(root);
    const notDirectory = path.join(root, 'not-directory');
    await writeFile(notDirectory, 'A file.');
    const unavailable = await runTool(createMemoryTools(new MemoryStore(notDirectory)), 'memory_list', {});
    expect(unavailable.ok).toBe(false);
    expect(unavailable.output).not.toContain(notDirectory);
  });

  it('keeps independent workspace stores isolated and handles an absent directory without creating it', async () => {
    const root = await temp();
    const a = new MemoryStore(path.join(root, 'a'));
    const b = new MemoryStore(path.join(root, 'b'));
    expect(await a.catalog()).toEqual({ notes: [], omitted: 0, incomplete: false });
    expect(await a.read('missing')).toBeUndefined();
    await b.write('other-workspace', '# Confidential project fact');
    expect((await a.search({ query: 'Confidential' })).hits).toEqual([]);
    expect(await a.read('other-workspace')).toBeUndefined();
    expect((await b.search({ query: 'Confidential' })).hits).toHaveLength(1);
  });
});
