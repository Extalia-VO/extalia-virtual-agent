import { link, mkdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { buildSystemPrompt } from '@extalia/runtime';
import { MemoryConflictError, MemoryStore } from '../src/memory.js';
import { useTempDirs } from './helpers.js';

const temp = useTempDirs();

async function fixture() {
  const root = await temp();
  const directory = path.join(root, 'memory');
  await mkdir(directory);
  return { root, directory, store: new MemoryStore(directory) };
}

describe('bounded prompt-relevant memory recall', () => {
  it('ranks a later summary above the first eight using OR terms, without changing catalog or literal-AND search', async () => {
    const { store } = await fixture();
    for (let i = 0; i < 12; i++) await store.write(`a-${String(i).padStart(2, '0')}`, '# Routine convention\nMigration database release '.repeat(20));
    await store.write('z-decision', '# Migration decision\nKeep this body out of the automatic catalog.');
    const baseline = await store.catalog();
    expect(baseline.notes).toHaveLength(8);
    expect(baseline.notes.some(note => note.name === 'z-decision')).toBe(false);
    const recall = await store.recallCatalog('Find the migration decision and an unmatchedtopic.');
    expect(recall.notes[0]!.name).toBe('z-decision');
    expect(recall).toMatchObject({ omitted: 5, incomplete: true, diagnostics: { knownNames: 13, candidateCount: 13, loadedCount: 13 } });
    expect(JSON.stringify(recall)).not.toContain('Keep this body');
    expect(await store.catalog()).toEqual(baseline);
    expect((await store.search({ query: 'migration unmatchedtopic' })).hits).toEqual([]);
  });

  it('finds filename matches outside the 128-note baseline and reports unknown title-only coverage honestly', async () => {
    const { directory, store } = await fixture();
    await Promise.all(Array.from({ length: 140 }, (_, i) => writeFile(path.join(directory, `a-${String(i).padStart(3, '0')}.md`), '# Routine')));
    await writeFile(path.join(directory, 'z-release.md'), '# Deployment decision');
    await writeFile(path.join(directory, 'z-title-only.md'), '# Migration decision');
    const recall = await store.recallCatalog('release');
    expect(recall.notes[0]!.name).toBe('z-release');
    expect(recall).toMatchObject({ omitted: 134, incomplete: true, diagnostics: { knownNames: 142, candidateCount: 128, loadedCount: 128 } });
    const unknown = await store.recallCatalog('migration');
    expect(unknown.notes.some(note => note.name === 'z-title-only')).toBe(false);
    expect(unknown.incomplete).toBe(true);
    expect(unknown.diagnostics.loadedCount).toBe(128);
  });

  it('normalizes Indonesian and Unicode terms and removes common English/Indonesian filler', async () => {
    const { store } = await fixture();
    await store.write('a-unrelated', '# Current defaults');
    await store.write('z-pengetahuan', '# Café 日本語 migrasi');
    const recall = await store.recallCatalog('Tolong saya dan anda perlu mencari CAFE\u0301 日本語 tentang migrasi untuk kita.');
    expect(recall.notes[0]!.name).toBe('z-pengetahuan');
    expect(recall.diagnostics.termCount).toBeLessThanOrEqual(12);
    const filler = await store.recallCatalog('Please the and with you your tolong saya dan anda untuk kita yang ini itu.');
    expect(filler.diagnostics.termCount).toBe(0);
    expect(filler.notes.map(note => note.name)).toEqual(['a-unrelated', 'z-pengetahuan']);
  });

  it('derives at most twelve bounded head/tail terms, giving the final question a chance after a long preamble', async () => {
    const { store } = await fixture();
    await store.write('a-baseline', '# Other');
    await store.write('z-finaltarget', '# Important decision');
    const longPrompt = Array.from({ length: 2000 }, (_, i) => `preamble${i}`).join(' ') + ' finaltarget';
    const recall = await store.recallCatalog(longPrompt);
    expect(recall.notes[0]!.name).toBe('z-finaltarget');
    expect(recall.diagnostics.termCount).toBe(12);
    const excludedMiddle = 'x'.repeat(2048) + ' finaltarget ' + 'y'.repeat(2048);
    const baseline = await store.recallCatalog(excludedMiddle);
    expect(baseline.diagnostics.termCount).toBe(0);
    expect(baseline.notes[0]!.name).toBe('a-baseline');
  });

  it('returns an alphabetical baseline for empty/nonmatching prompts, with deterministic metadata ties and no body ranking', async () => {
    const { store } = await fixture();
    await store.write('b-note', '# Topic\nneedle '.repeat(100));
    await store.write('a-note', '# Topic\nOther');
    await store.write('c-note', '# Topic\nOther');
    for (const prompt of ['', 'the dan untuk', 'unmatchedtopic', 'needle']) {
      const first = await store.recallCatalog(prompt);
      expect(first.notes.map(note => note.name)).toEqual(['a-note', 'b-note', 'c-note']);
      const repeated = await store.recallCatalog(prompt);
      expect(repeated.notes).toEqual(first.notes);
      expect(repeated.omitted).toBe(first.omitted);
      expect(repeated.incomplete).toBe(first.incomplete);
      expect(first.incomplete).toBe(false);
      expect(first.omitted).toBe(0);
    }
  });

  it('redacts complete metadata and never logs or returns the prompt, derived queries, raw bodies, or paths', async () => {
    const { root, directory, store } = await fixture();
    const secret = 'sk-' + 'q'.repeat(30);
    await writeFile(path.join(directory, 'safe-note.md'), `# Credential ${secret}\nUnrelated full-body details.`);
    await writeFile(path.join(directory, `${secret}.md`), '# Unsafe filename');
    const logger = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const prompt = 'ephemeralquery privateinstructions ' + secret;
      const recall = await store.recallCatalog(prompt);
      expect(recall.notes).toHaveLength(1);
      expect(recall.notes[0]!.summary).toContain('[redacted]');
      const encoded = JSON.stringify(recall);
      for (const value of [secret, 'ephemeralquery', 'privateinstructions', 'Unrelated full-body', root]) expect(encoded).not.toContain(value);
      expect(logger).not.toHaveBeenCalled();
      expect(await readFile(path.join(directory, 'safe-note.md'), 'utf8')).toContain(secret);
      expect(recall).toMatchObject({ omitted: 1, incomplete: true });
    } finally { logger.mockRestore(); }
  });

  it('reloads changed/deleted notes on every call and preserves revision conflicts for stale follow-up reads', async () => {
    const { store } = await fixture();
    await store.write('decision', '# Migration decision\nOriginal.');
    const old = (await store.recallCatalog('migration')).notes[0]!;
    await store.write('decision', '# Deployment decision\nNew content.', { expectedRevision: old.revision });
    const fresh = (await store.recallCatalog('deployment')).notes[0]!;
    expect(fresh.summary).toBe('Deployment decision');
    expect(fresh.revision).not.toBe(old.revision);
    await expect(store.readPage('decision', { expectedRevision: old.revision })).rejects.toBeInstanceOf(MemoryConflictError);
    await store.delete('decision', { expectedRevision: fresh.revision });
    expect(await store.recallCatalog('deployment')).toMatchObject({ notes: [], omitted: 0, incomplete: false, diagnostics: { loadedCount: 0, bytesRead: 0 } });
    await expect(store.readPage('decision', { expectedRevision: fresh.revision })).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('reuses only redacted metadata across stores, with zero content reads on unchanged hits and no mutable cache aliases', async () => {
    const { directory, store } = await fixture();
    const secret = 'sk-' + 'q'.repeat(30);
    await writeFile(path.join(directory, 'decision.md'), `# Deployment ${secret}\nFresh content stays outside cached metadata.`);
    const first = await store.recallCatalog('deployment');
    expect(first.diagnostics).toMatchObject({ cacheHits: 0, loadedCount: 1 });
    expect(first.diagnostics.bytesRead).toBeGreaterThan(0);
    const again = await new MemoryStore(directory).recallCatalog('deployment');
    expect(again.notes).toEqual(first.notes);
    expect(again.diagnostics).toMatchObject({ cacheHits: 1, bytesRead: 0 });
    expect(JSON.stringify(again)).not.toContain(secret);
    expect(JSON.stringify(again)).not.toContain('Fresh content');
    again.notes[0]!.summary = 'Caller changed its copy';
    expect((await store.recallCatalog('deployment')).notes).toEqual(first.notes);
    const freshRead = (await store.readNote('decision'))!;
    expect(Object.keys(freshRead).sort()).toEqual(['content', 'revision', 'updatedAt']);
    expect(freshRead.content).toContain('Fresh content');
    expect((await store.readPage('decision', { expectedRevision: first.notes[0]!.revision }))!.text).toContain('Fresh content');
    expect((await store.search({ query: 'content' })).hits[0]!.excerpt).toContain('content');
  });

  it('invalidates same-sized in-place edits and replacements even when the modification time is preserved', async () => {
    const { directory, store } = await fixture();
    const file = path.join(directory, 'decision.md');
    await writeFile(file, '# Before');
    const original = await store.recallCatalog('decision');
    const before = await stat(file);
    await writeFile(file, '# After!');
    await utimes(file, before.atime, before.mtime);
    const edited = await store.recallCatalog('decision');
    expect(edited.notes[0]!.summary).toBe('After!');
    expect(edited.notes[0]!.revision).not.toBe(original.notes[0]!.revision);
    expect(edited.diagnostics).toMatchObject({ cacheHits: 0, bytesRead: 8 });
    await writeFile(path.join(directory, 'replacement.md'), '# Fresh!');
    await utimes(path.join(directory, 'replacement.md'), before.atime, before.mtime);
    await rename(path.join(directory, 'replacement.md'), file);
    const replaced = await store.recallCatalog('decision');
    expect(replaced.notes[0]!.summary).toBe('Fresh!');
    expect(replaced.diagnostics).toMatchObject({ cacheHits: 0, bytesRead: 8 });
    await expect(store.readPage('decision', { expectedRevision: edited.notes[0]!.revision })).rejects.toBeInstanceOf(MemoryConflictError);
  });

  it('invalidates deletion/recreation and keeps metadata caches separate across workspaces', async () => {
    const { root, directory, store } = await fixture();
    const saved = await store.write('decision', '# Workspace A');
    await store.recallCatalog('decision');
    await store.delete('decision');
    expect((await store.recallCatalog('decision')).notes).toEqual([]);
    const recreated = await store.write('decision', '# Workspace A', { expectedRevision: null });
    const recall = await store.recallCatalog('decision');
    expect(recall.diagnostics.cacheHits).toBe(0);
    expect(recall.notes[0]!.revision).toBe(recreated.revision);
    expect(recreated.revision).not.toBe(saved.revision);
    const other = new MemoryStore(path.join(root, 'other'));
    await other.write('decision', '# Workspace B');
    const foreign = await other.recallCatalog('decision');
    expect(foreign.diagnostics.cacheHits).toBe(0);
    expect(foreign.notes[0]!.summary).toBe('Workspace B');
    expect((await new MemoryStore(directory).recallCatalog('decision')).notes[0]!.summary).toBe('Workspace A');
  });

  it.skipIf(process.platform === 'win32')('rejects warmed metadata after symlink, hardlink, oversized and invalid-UTF8 replacements', async () => {
    const { root, directory, store } = await fixture();
    const file = path.join(directory, 'decision.md');
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, '# External contents');
    const replacements = [
      () => symlink(outside, file),
      () => link(outside, file),
      () => writeFile(file, 'x'.repeat(80_001)),
      () => writeFile(file, Buffer.from([0xff, 0xfe])),
    ];
    for (const replace of replacements) {
      await writeFile(file, '# Original');
      await store.recallCatalog('decision');
      await rm(file);
      await replace();
      expect(await store.recallCatalog('decision')).toMatchObject({ notes: [], omitted: 1, incomplete: true, diagnostics: { cacheHits: 0 } });
      await expect(store.readNote('decision')).rejects.toThrow(/unavailable or unsafe/);
      await rm(file);
    }
    expect(await readFile(outside, 'utf8')).toBe('# External contents');
  });

  it('bounds the global metadata LRU to 512 entries and retains the most recently used workspace', async () => {
    const root = await temp();
    const stores = Array.from({ length: 5 }, (_, i) => new MemoryStore(path.join(root, `workspace-${i}`)));
    for (const store of stores) {
      await mkdir(store.directory);
      await Promise.all(Array.from({ length: 128 }, (_, i) => writeFile(path.join(store.directory, `target-${String(i).padStart(3, '0')}.md`), '# Target metadata')));
      expect((await store.recallCatalog('target')).diagnostics.cacheHits).toBe(0);
    }
    expect((await stores[4]!.recallCatalog('target')).diagnostics).toMatchObject({ cacheHits: 128, bytesRead: 0 });
    expect((await stores[0]!.recallCatalog('target')).diagnostics).toMatchObject({ cacheHits: 0, loadedCount: 128 });
  });

  it('treats empty and greeting-only prompts as a cheap bounded alphabetical baseline', async () => {
    const { directory, store } = await fixture();
    await Promise.all(Array.from({ length: 20 }, (_, i) => writeFile(path.join(directory, `note-${String(i).padStart(2, '0')}.md`), '# Routine')));
    const first = await store.recallCatalog('Hi, help me. Halo hai bantu saya.');
    expect(first.diagnostics).toMatchObject({ termCount: 0, candidateCount: 8, loadedCount: 8, cacheHits: 0 });
    expect(first.notes.map(note => note.name)).toEqual(Array.from({ length: 8 }, (_, i) => `note-${String(i).padStart(2, '0')}`));
    expect((await store.recallCatalog('')).diagnostics).toMatchObject({ termCount: 0, candidateCount: 8, cacheHits: 8, bytesRead: 0 });
  });

  it('honors the aggregate byte budget and per-note safety ceiling while reporting unrepresented candidates', async () => {
    const { directory, store } = await fixture();
    await Promise.all(Array.from({ length: 30 }, (_, i) => writeFile(path.join(directory, `large-${String(i).padStart(2, '0')}.md`), '# Target\n' + 'x'.repeat(79_991))));
    await writeFile(path.join(directory, 'z-oversized.md'), 'x'.repeat(80_001));
    const recall = await store.recallCatalog('target');
    expect(recall).toMatchObject({ omitted: 23, incomplete: true, diagnostics: { knownNames: 31, candidateCount: 27, loadedCount: 26, bytesRead: 2_080_000 } });
    expect(recall.diagnostics.bytesRead).toBeLessThanOrEqual(2 * 1024 * 1024);
    const oversized = await store.recallCatalog('oversized');
    expect(oversized.notes.some(note => note.name === 'z-oversized')).toBe(false);
    expect(oversized.incomplete).toBe(true);
  });

  it.skipIf(process.platform === 'win32')('uses the guarded loader for links and preserves unrelated workspace isolation', async () => {
    const { root, directory, store } = await fixture();
    const outside = path.join(root, 'outside.md');
    await writeFile(outside, '# Secret external note');
    await symlink(outside, path.join(directory, 'target.md'));
    expect(await store.recallCatalog('target')).toMatchObject({ notes: [], omitted: 1, incomplete: true });
    const other = new MemoryStore(path.join(root, 'other'));
    await other.write('target', '# Other workspace');
    expect((await store.recallCatalog('target')).notes).toEqual([]);
    expect((await other.recallCatalog('target')).notes[0]!.summary).toBe('Other workspace');
  });

  it('retains the existing 2k metadata-only prompt budget with relevance-selected entries', async () => {
    const { store } = await fixture();
    for (let i = 0; i < 12; i++) await store.write(`note-${i}`, '# Target ' + '<'.repeat(120) + '\nNever insert full note bodies.');
    const recall = await store.recallCatalog('target');
    const system = buildSystemPrompt({ workspace: { name: 'Example', root: '/projects/example' }, platform: { os: 'Linux', shell: 'sh' }, memory: recall.notes, memoryCatalog: recall });
    const block = system.match(/<memory-catalog>\n([\s\S]*?)\n<\/memory-catalog>/)![0];
    expect(block.length).toBeLessThanOrEqual(2000);
    expect(block).not.toContain('Never insert full note bodies');
    expect(block).not.toContain('diagnostics');
    expect(block).not.toContain('revision');
  });

  it('bounds output limits and discovers no more than 4096 directory entries', async () => {
    const { directory, store } = await fixture();
    for (let offset = 0; offset < 4097; offset += 128) {
      await Promise.all(Array.from({ length: Math.min(128, 4097 - offset) }, (_, i) => writeFile(path.join(directory, `note-${String(offset + i).padStart(4, '0')}.md`), '# Note')));
    }
    const recall = await store.recallCatalog('', { limit: 3 });
    expect(recall).toMatchObject({ omitted: 4093, incomplete: true, diagnostics: { knownNames: 4096, candidateCount: 3, loadedCount: 3 } });
    expect(recall.notes).toHaveLength(3);
    for (const limit of [0, 9, 1.5, NaN]) await expect(store.recallCatalog('note', { limit })).rejects.toThrow(/pagination/);
  });
  it('offers only positively matching metadata in relevant-only mode, without alphabetical filler', async () => {
    const { store } = await fixture();
    await store.write('a-unrelated', '# Unrelated convention');
    await store.write('migration-decision', '# Migration decision\nFull note body is not a preview.');
    await store.write('release-plan', '# Release schedule');
    const relevant = await store.recallCatalog('migration', { limit: 4, relevantOnly: true });
    expect(relevant.notes.map(note => note.name)).toEqual(['migration-decision']);
    expect(JSON.stringify(relevant)).not.toContain('Full note body');
    expect(relevant.omitted).toBe(2);
    expect((await store.recallCatalog('unmatchedtopic', { relevantOnly: true })).notes).toEqual([]);
    const filler = await store.recallCatalog('the dan untuk', { relevantOnly: true });
    expect(filler).toMatchObject({ notes: [], omitted: 3, incomplete: true, diagnostics: { candidateCount: 0, bytesRead: 0 } });
    expect((await store.recallCatalog('unmatchedtopic')).notes).toHaveLength(3);
  });

});
