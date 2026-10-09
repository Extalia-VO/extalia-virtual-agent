import { mkdir, readFile, truncate, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { createFileTools, globMatcher } from '../src/tools/files.js';
import { findTool, runTool, useTempDirs } from './helpers.js';

const tempDir = useTempDirs();
let root: string;
let tools: ReturnType<typeof createFileTools>;

async function put(relative: string, content: string | Buffer): Promise<void> {
  const file = path.join(root, relative);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, content);
}

beforeEach(async () => {
  root = await tempDir('extalia-files-');
  tools = createFileTools(root, { searchTimeoutMs: 5000 });
  await put('package.json', '{ "name": "demo" }\n');
  await put('README.md', '# Demo\n');
  await put('src/index.ts', 'export const answer = 42;\nexport function loadConfig() {\n  return answer;\n}\n');
  await put('src/app.tsx', 'export function App() { return loadConfig(); }\n');
  await put('src/util/helpers.ts', 'export const LOADING = true;\n');
  await put('node_modules/pkg/index.js', 'module.exports = loadConfig;\n');
  await put('.env', 'API_TOKEN=loadConfig-value\n');
  await put('assets/logo.bin', Buffer.from([0x89, 0x50, 0x00, 0x01, 0x6c, 0x6f, 0x61, 0x64]));
});

describe('tool definitions', () => {
  it('declares access, kind and schemas', () => {
    expect(tools.map(tool => [tool.name, tool.access, tool.kind])).toEqual([
      ['list_files', 'read', 'read'],
      ['read_file', 'read', 'read'],
      ['search_files', 'read', 'search'],
      ['write_file', 'write', 'edit'],
      ['edit_file', 'write', 'edit'],
    ]);
    for (const tool of tools) expect(tool.parameters.type).toBe('object');
    expect(findTool(tools, 'read_file').parameters.required).toEqual(['path']);
  });

  it('describes calls with short, redacted labels', () => {
    expect(findTool(tools, 'read_file').describe({ path: 'src/index.ts' })).toMatchObject({ label: 'Reading src/index.ts', target: 'src/index.ts' });
    expect(findTool(tools, 'list_files').describe({})).toMatchObject({ label: 'Listing .' });
    expect(findTool(tools, 'search_files').describe({ pattern: 'token=abcdefghijkl' }).label).toBe('Searching for token=[redacted]');
    expect(findTool(tools, 'edit_file').describe({ path: 'a.ts', old_text: 'x', new_text: 'y' }).detail).toBe('Replace:\nx\nWith:\ny');
  });
});

describe('list_files', () => {
  it('shows a sorted tree with directories first and ignored directories unexpanded', async () => {
    const result = await runTool(tools, 'list_files', {});
    expect(result.ok).toBe(true);
    expect(result.output.split('\n')).toEqual([
      'assets/',
      '  logo.bin',
      'node_modules/  (not listed)',
      'src/',
      '  util/',
      '  app.tsx',
      '  index.ts',
      '.env',
      'README.md',
      'package.json',
    ]);
  });

  it('honors depth, path and limit', async () => {
    expect((await runTool(tools, 'list_files', { depth: 1 })).output).not.toContain('index.ts');
    expect((await runTool(tools, 'list_files', { path: 'src', depth: 3 })).output.split('\n')).toEqual(['util/', '  helpers.ts', 'app.tsx', 'index.ts']);
    const limited = await runTool(tools, 'list_files', { limit: 2 });
    expect(limited.output.split('\n')).toHaveLength(3);
    expect(limited.output).toContain('listing stopped after 2 entries');
  });

  it('reports files, empty directories and paths outside the workspace', async () => {
    expect(await runTool(tools, 'list_files', { path: 'README.md' })).toMatchObject({ ok: false, output: expect.stringContaining('use read_file'.replace('use', 'Use')) });
    await mkdir(path.join(root, 'empty'));
    expect((await runTool(tools, 'list_files', { path: 'empty' })).output).toBe('"empty" is empty.');
    expect(await runTool(tools, 'list_files', { path: '..' })).toMatchObject({ ok: false, output: expect.stringContaining('outside the workspace') });
    expect(await runTool(tools, 'list_files', { path: 'missing' })).toMatchObject({ ok: false, output: '"missing" does not exist.' });
  });
});

describe('read_file', () => {
  it('returns numbered lines and emits file.read', async () => {
    const result = await runTool(tools, 'read_file', { path: 'src/index.ts' });
    expect(result.ok).toBe(true);
    expect(result.output).toBe('   1\texport const answer = 42;\n   2\texport function loadConfig() {\n   3\t  return answer;\n   4\t}');
    expect(result.events).toEqual([{ type: 'file.read', path: 'src/index.ts' }]);
  });

  it('pages with offset and limit and says how many lines remain', async () => {
    await put('long.txt', Array.from({ length: 1000 }, (_, index) => `line ${index + 1}`).join('\n'));
    const result = await runTool(tools, 'read_file', { path: 'long.txt', offset: 10, limit: 5 });
    expect(result.output.split('\n')).toEqual(['  10\tline 10', '  11\tline 11', '  12\tline 12', '  13\tline 13', '  14\tline 14', '… 986 more lines (continue with offset 15).']);
    expect((await runTool(tools, 'read_file', { path: 'long.txt' })).output).toContain('600 more lines (continue with offset 401)');
    expect(await runTool(tools, 'read_file', { path: 'long.txt', offset: 2000 })).toMatchObject({ ok: false, output: expect.stringContaining('past the end') });
  });

  it('clips long lines and bounds the total output', async () => {
    await put('wide.txt', `${'x'.repeat(5000)}\nshort\n`);
    const wide = await runTool(tools, 'read_file', { path: 'wide.txt' });
    expect(wide.output).toContain('[line clipped, 5000 characters]');
    expect(wide.output.split('\n')[0]!.length).toBeLessThan(2100);
    await put('huge.txt', Array.from({ length: 2000 }, () => 'y'.repeat(1500)).join('\n'));
    const huge = await runTool(tools, 'read_file', { path: 'huge.txt', limit: 2000 });
    expect(huge.output.length).toBeLessThanOrEqual(30_100);
    expect(huge.output).toMatch(/more lines \(continue with offset \d+\)\.$/);
  });

  it('reports binary, empty, oversized and credential files instead of reading them', async () => {
    expect((await runTool(tools, 'read_file', { path: 'assets/logo.bin' })).output).toMatch(/binary file/);
    await put('empty.txt', '');
    expect((await runTool(tools, 'read_file', { path: 'empty.txt' })).output).toBe('"empty.txt" is empty.');
    await put('big.log', '');
    await truncate(path.join(root, 'big.log'), 6 * 1024 * 1024);
    expect(await runTool(tools, 'read_file', { path: 'big.log' })).toMatchObject({ ok: false, output: expect.stringContaining('5 MB read limit') });
    expect(await runTool(tools, 'read_file', { path: '.env' })).toMatchObject({ ok: false, output: expect.stringContaining('credential file') });
    expect(await runTool(tools, 'read_file', { path: 'src' })).toMatchObject({ ok: false, output: expect.stringContaining('is a directory') });
    expect(await runTool(tools, 'read_file', { path: 'nope.ts' })).toMatchObject({ ok: false, output: '"nope.ts" does not exist.' });
  });
});

describe('search_files', () => {
  it('finds matches with path:line: text, skipping ignored directories, credential and binary files', async () => {
    const result = await runTool(tools, 'search_files', { pattern: 'load' });
    expect(result.ok).toBe(true);
    expect(result.output.split('\n')).toEqual([
      'src/app.tsx:1: export function App() { return loadConfig(); }',
      'src/index.ts:2: export function loadConfig() {',
      'src/util/helpers.ts:1: export const LOADING = true;',
    ]);
  });

  it('honors case sensitivity, path, glob and limit', async () => {
    expect((await runTool(tools, 'search_files', { pattern: 'load', case_sensitive: true })).output).not.toContain('LOADING');
    expect((await runTool(tools, 'search_files', { pattern: 'load', glob: '*.tsx' })).output).toBe('src/app.tsx:1: export function App() { return loadConfig(); }');
    expect((await runTool(tools, 'search_files', { pattern: 'load', glob: 'src/**/*.ts' })).output.split('\n')).toHaveLength(2);
    expect((await runTool(tools, 'search_files', { pattern: 'load', glob: '*.{ts,tsx}', path: 'src/util' })).output).toBe('src/util/helpers.ts:1: export const LOADING = true;');
    expect((await runTool(tools, 'search_files', { pattern: 'answer', path: 'src/index.ts' })).output.split('\n')).toHaveLength(2);
    const limited = await runTool(tools, 'search_files', { pattern: 'export', limit: 2 });
    expect(limited.output.split('\n')).toHaveLength(3);
    expect(limited.output).toContain('stopped at 2 matches');
  });

  it('clips long matching lines and skips files over 1 MB', async () => {
    await put('wide.txt', `needle ${'z'.repeat(1000)}\n`);
    await put('large.txt', `needle\n${'q'.repeat(1_100_000)}`);
    const result = await runTool(tools, 'search_files', { pattern: 'needle' });
    expect(result.output.split('\n')[0]!.length).toBeLessThanOrEqual('wide.txt:1: '.length + 300);
    expect(result.output).not.toContain('large.txt:');
    expect(result.output).toContain('1 file over 1 MB was skipped.');
  });

  it('reports no matches, invalid expressions and refused paths', async () => {
    expect((await runTool(tools, 'search_files', { pattern: 'does-not-occur' })).output).toMatch(/^No matches for \/does-not-occur\/ in \d+ files\.$/);
    expect(await runTool(tools, 'search_files', { pattern: '(unclosed' })).toMatchObject({ ok: false, output: expect.stringContaining('Invalid regular expression') });
    expect(await runTool(tools, 'search_files', { pattern: 'x', path: '../' })).toMatchObject({ ok: false, output: expect.stringContaining('outside the workspace') });
  });

  it('stops a regular expression that takes too long', async () => {
    const slow = createFileTools(root, { searchTimeoutMs: 300 });
    await put('slow.txt', `${'a'.repeat(40)}!\n`);
    const started = Date.now();
    const result = await runTool(slow, 'search_files', { pattern: '^(a+)+$', path: 'slow.txt' });
    expect(result).toMatchObject({ ok: false, output: expect.stringContaining('was stopped') });
    expect(Date.now() - started).toBeLessThan(3000);
  });

  it('matches simple globs', () => {
    expect(globMatcher('*.ts')('src/a/b.ts')).toBe(true);
    expect(globMatcher('*.ts')('src/a/b.tsx')).toBe(false);
    expect(globMatcher('src/**/*.tsx')('src/app.tsx')).toBe(true);
    expect(globMatcher('src/**/*.tsx')('src/a/b/c.tsx')).toBe(true);
    expect(globMatcher('src/**/*.tsx')('lib/app.tsx')).toBe(false);
    expect(globMatcher('test?.js')('test1.js')).toBe(true);
    expect(globMatcher('*.{md,txt}')('notes.txt')).toBe(true);
  });
});

describe('write_file', () => {
  it('creates files with parent directories and reports the change', async () => {
    const result = await runTool(tools, 'write_file', { path: 'docs/guide/intro.md', content: '# Intro\n\nHello\n' });
    expect(result).toMatchObject({ ok: true, files: [{ path: 'docs/guide/intro.md', change: 'add' }] });
    expect(result.output).toBe('Created docs/guide/intro.md (3 lines, 15 B).');
    expect(await readFile(path.join(root, 'docs/guide/intro.md'), 'utf8')).toBe('# Intro\n\nHello\n');
    const update = await runTool(tools, 'write_file', { path: 'docs/guide/intro.md', content: 'new' });
    expect(update).toMatchObject({ ok: true, files: [{ path: 'docs/guide/intro.md', change: 'update' }] });
  });

  it('refuses credential files, .git, directories and paths outside the workspace', async () => {
    expect(await runTool(tools, 'write_file', { path: '.env.local', content: 'X=1' })).toMatchObject({ ok: false, output: expect.stringContaining('credential file') });
    expect(await runTool(tools, 'write_file', { path: '.git/config', content: '' })).toMatchObject({ ok: false, output: expect.stringContaining('inside .git') });
    expect(await runTool(tools, 'write_file', { path: 'src', content: '' })).toMatchObject({ ok: false, output: expect.stringContaining('not a regular file') });
    expect(await runTool(tools, 'write_file', { path: '../escape.txt', content: '' })).toMatchObject({ ok: false, output: expect.stringContaining('outside the workspace') });
    expect(await runTool(tools, 'write_file', { path: 'a.txt', content: 5 })).toMatchObject({ ok: false });
  });
});

describe('edit_file', () => {
  it('replaces a unique exact match', async () => {
    const result = await runTool(tools, 'edit_file', { path: 'src/index.ts', old_text: 'answer = 42', new_text: 'answer = 43' });
    expect(result).toMatchObject({ ok: true, files: [{ path: 'src/index.ts', change: 'update' }] });
    expect(result.output).toBe('Edited src/index.ts: replaced 1 occurrence (-1 line, +1 line).');
    expect(await readFile(path.join(root, 'src/index.ts'), 'utf8')).toContain('answer = 43;');
  });

  it('refuses missing and ambiguous matches unless replace_all is set', async () => {
    expect(await runTool(tools, 'edit_file', { path: 'src/index.ts', old_text: 'nothing like this', new_text: 'x' })).toMatchObject({ ok: false, output: expect.stringContaining('was not found') });
    const ambiguous = await runTool(tools, 'edit_file', { path: 'src/index.ts', old_text: 'answer', new_text: 'result' });
    expect(ambiguous).toMatchObject({ ok: false, output: expect.stringContaining('matches 2 times') });
    const all = await runTool(tools, 'edit_file', { path: 'src/index.ts', old_text: 'answer', new_text: 'result', replace_all: true });
    expect(all.output).toContain('replaced 2 occurrences');
    expect(await readFile(path.join(root, 'src/index.ts'), 'utf8')).not.toContain('answer');
  });

  it('inserts replacement text literally and handles Windows line endings', async () => {
    await runTool(tools, 'edit_file', { path: 'README.md', old_text: 'Demo', new_text: 'Price $& $1' });
    expect(await readFile(path.join(root, 'README.md'), 'utf8')).toBe('# Price $& $1\n');
    await put('crlf.txt', 'one\r\ntwo\r\nthree\r\n');
    const result = await runTool(tools, 'edit_file', { path: 'crlf.txt', old_text: 'one\ntwo', new_text: 'uno\ndos' });
    expect(result.ok).toBe(true);
    expect(await readFile(path.join(root, 'crlf.txt'), 'utf8')).toBe('uno\r\ndos\r\nthree\r\n');
  });

  it('refuses missing files, binary files, credential files and no-op edits', async () => {
    expect(await runTool(tools, 'edit_file', { path: 'missing.ts', old_text: 'a', new_text: 'b' })).toMatchObject({ ok: false, output: expect.stringContaining('does not exist') });
    expect(await runTool(tools, 'edit_file', { path: 'assets/logo.bin', old_text: 'load', new_text: 'b' })).toMatchObject({ ok: false, output: expect.stringContaining('binary') });
    expect(await runTool(tools, 'edit_file', { path: '.env', old_text: 'API', new_text: 'b' })).toMatchObject({ ok: false, output: expect.stringContaining('credential file') });
    expect(await runTool(tools, 'edit_file', { path: 'README.md', old_text: 'Demo', new_text: 'Demo' })).toMatchObject({ ok: false, output: expect.stringContaining('identical') });
    expect(await runTool(tools, 'edit_file', { path: 'README.md', old_text: '', new_text: 'x' })).toMatchObject({ ok: false, output: expect.stringContaining('empty') });
  });
});
