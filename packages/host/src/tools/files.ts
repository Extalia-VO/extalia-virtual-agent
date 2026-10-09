import type { Dirent } from 'node:fs';
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { safeLabel, safeText } from '@extalia/core';
import type { AnyTool, ToolDefinition } from '@extalia/runtime';
import { isNotFound } from '../jsonStore.js';
import { IGNORED_DIRECTORIES, isCredentialPath, resolveInside, type ResolvedPath } from '../workspaceFs.js';
import { bound, failure, formatBytes, guard, integer, isBinary, OUTPUT_LIMIT, plural, text } from './shared.js';

const MAX_READ_BYTES = 5 * 1024 * 1024;
const MAX_SEARCH_BYTES = 1024 * 1024;
const MAX_LINE_LENGTH = 2000;
const MATCH_TEXT_LENGTH = 300;
const MAX_SEARCH_FILES = 20_000;
const MAX_WRITE_CHARACTERS = 5_000_000;

export interface FileToolOptions {
  /** A regular expression can take exponential time; searches run in a worker that is stopped after this long. */
  searchTimeoutMs?: number;
}

type ListInput = { path?: string; depth?: number; limit?: number };
type ReadInput = { path: string; offset?: number; limit?: number };
type SearchInput = { pattern: string; path?: string; glob?: string; case_sensitive?: boolean; limit?: number };
type WriteInput = { path: string; content: string };
type EditInput = { path: string; old_text: string; new_text: string; replace_all?: boolean };

const pathLabel = (value: unknown, fallback = '.') => safeLabel(text(value, fallback) || fallback, 80);

function splitLines(content: string): string[] {
  const lines = content.split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  return lines;
}

// ---------------------------------------------------------------------------
// list_files

interface TreeNode { name: string; directory: boolean; note?: string; children?: TreeNode[] }

function compareEntries(a: Dirent, b: Dirent): number {
  if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1;
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}

/** Breadth-first, so a limited listing shows every top-level entry before deep ones. */
async function buildTree(start: string, depth: number, limit: number, signal: AbortSignal): Promise<{ nodes: TreeNode[]; truncated: boolean }> {
  const nodes: TreeNode[] = [];
  let level: { absolute: string; children: TreeNode[] }[] = [{ absolute: start, children: nodes }];
  let count = 0;
  for (let current = 1; current <= depth && level.length; current++) {
    const next: typeof level = [];
    for (const directory of level) {
      signal.throwIfAborted();
      let entries: Dirent[];
      try { entries = await readdir(directory.absolute, { withFileTypes: true }); }
      catch { directory.children.push({ name: '(not readable)', directory: false }); continue; }
      for (const entry of entries.sort(compareEntries)) {
        if (count >= limit) return { nodes, truncated: true };
        count++;
        const node: TreeNode = { name: entry.name, directory: entry.isDirectory() };
        directory.children.push(node);
        if (entry.isSymbolicLink()) node.note = 'symbolic link';
        if (!node.directory) continue;
        if (IGNORED_DIRECTORIES.has(entry.name) || isCredentialPath(entry.name)) { node.note = 'not listed'; continue; }
        if (current < depth) {
          node.children = [];
          next.push({ absolute: path.join(directory.absolute, entry.name), children: node.children });
        }
      }
    }
    level = next;
  }
  return { nodes, truncated: false };
}

function renderTree(nodes: TreeNode[], indent: number, lines: string[]): void {
  for (const node of nodes) {
    lines.push(`${'  '.repeat(indent)}${node.name}${node.directory ? '/' : ''}${node.note ? `  (${node.note})` : ''}`);
    if (node.children) renderTree(node.children, indent + 1, lines);
  }
}

function listFiles(root: string): ToolDefinition<ListInput> {
  return {
    name: 'list_files',
    description: 'List files and directories in the workspace as an indented tree. Directories end with "/". Generated and vendored directories such as node_modules and .git are named but not expanded.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Directory relative to the workspace root. Defaults to ".".' },
        depth: { type: 'integer', description: 'How many directory levels to show (1-6). Defaults to 2.', minimum: 1, maximum: 6 },
        limit: { type: 'integer', description: 'Maximum number of entries (1-2000). Defaults to 400.', minimum: 1, maximum: 2000 },
      },
      additionalProperties: false,
    },
    access: 'read',
    kind: 'read',
    describe: input => ({ label: `Listing ${pathLabel(input.path)}`, target: pathLabel(input.path) }),
    run: (input, context) => guard(pathLabel(input.path), async () => {
      const resolved = await resolveInside(root, text(input.path, '.'), 'read');
      const info = await stat(resolved.absolute);
      if (!info.isDirectory()) return failure(`"${resolved.relative}" is a file. Use read_file to read it.`);
      const limit = integer(input.limit, 400, 1, 2000);
      const { nodes, truncated } = await buildTree(resolved.absolute, integer(input.depth, 2, 1, 6), limit, context.signal);
      if (!nodes.length) return { ok: true, output: `"${resolved.relative}" is empty.` };
      const lines: string[] = [];
      renderTree(nodes, 0, lines);
      if (truncated) lines.push(`… listing stopped after ${limit} entries. List a subdirectory or lower the depth to see more.`);
      return { ok: true, output: bound(lines.join('\n')) };
    }),
  };
}

// ---------------------------------------------------------------------------
// read_file

function readFileTool(root: string): ToolDefinition<ReadInput> {
  return {
    name: 'read_file',
    description: 'Read a text file from the workspace. Lines are numbered ("  12<TAB>code"); use offset and limit to page through long files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        offset: { type: 'integer', description: 'First line to show (1-based). Defaults to 1.', minimum: 1 },
        limit: { type: 'integer', description: 'Maximum number of lines (1-2000). Defaults to 400.', minimum: 1, maximum: 2000 },
      },
      required: ['path'],
      additionalProperties: false,
    },
    access: 'read',
    kind: 'read',
    describe: input => ({ label: `Reading ${pathLabel(input.path)}`, target: pathLabel(input.path) }),
    run: (input, context) => guard(pathLabel(input.path), async () => {
      const resolved = await resolveInside(root, text(input.path), 'read');
      const name = resolved.relative;
      const info = await stat(resolved.absolute);
      if (info.isDirectory()) return failure(`"${name}" is a directory. Use list_files to see its contents.`);
      if (!info.isFile()) return failure(`"${name}" is not a regular file.`);
      if (info.size > MAX_READ_BYTES) return failure(`"${name}" is ${formatBytes(info.size)}, more than the 5 MB read limit. Use search_files to find the relevant lines.`);
      const buffer = await readFile(resolved.absolute);
      context.emit({ type: 'file.read', path: name });
      if (isBinary(buffer)) return { ok: true, output: `"${name}" is a binary file (${formatBytes(buffer.length)}); its contents are not shown.` };
      const lines = splitLines(buffer.toString('utf8'));
      if (!lines.length) return { ok: true, output: `"${name}" is empty.` };
      const offset = integer(input.offset, 1, 1, Number.MAX_SAFE_INTEGER);
      if (offset > lines.length) return failure(`"${name}" has ${plural(lines.length, 'line')}; offset ${offset} is past the end.`);
      const end = Math.min(lines.length, offset - 1 + integer(input.limit, 400, 1, 2000));
      const width = Math.max(4, String(end).length);
      const output: string[] = [];
      let size = 0;
      let shown = offset - 1;
      for (let index = offset - 1; index < end; index++) {
        let line = lines[index]!;
        if (line.length > MAX_LINE_LENGTH) line = `${line.slice(0, MAX_LINE_LENGTH)}… [line clipped, ${line.length} characters]`;
        const entry = `${String(index + 1).padStart(width)}\t${line}`;
        if (output.length && size + entry.length + 1 > OUTPUT_LIMIT) break;
        output.push(entry);
        size += entry.length + 1;
        shown = index + 1;
      }
      const remaining = lines.length - shown;
      if (remaining > 0) output.push(`… ${plural(remaining, 'more line')} (continue with offset ${shown + 1}).`);
      return { ok: true, output: output.join('\n') };
    }),
  };
}

// ---------------------------------------------------------------------------
// search_files

function globSource(glob: string): string {
  let source = '';
  for (let index = 0; index < glob.length; index++) {
    const char = glob[index]!;
    if (char === '*' && glob[index + 1] === '*') {
      index++;
      if (glob[index + 1] === '/') { index++; source += '(?:.*/)?'; }
      else source += '.*';
    } else if (char === '*') source += '[^/]*';
    else if (char === '?') source += '[^/]';
    else if (char === '{' && glob.indexOf('}', index) > index) {
      const close = glob.indexOf('}', index);
      source += `(?:${glob.slice(index + 1, close).split(',').map(globSource).join('|')})`;
      index = close;
    } else source += char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return source;
}

/** Simple glob matcher: `*`, `?`, `**`, `{a,b}`. Globs without `/` match the file name only. */
export function globMatcher(glob: string): (relative: string) => boolean {
  const normalized = glob.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  const pattern = new RegExp(`^${globSource(normalized)}$`);
  if (!normalized.includes('/')) return relative => pattern.test(relative.slice(relative.lastIndexOf('/') + 1));
  return relative => pattern.test(relative);
}

interface SearchFile { absolute: string; relative: string }
interface SearchResult { matches: string[]; searched: number; skipped: number; truncated: boolean }

// Plain JavaScript, evaluated in a worker thread so a slow regular expression cannot block the host.
const SEARCH_WORKER = `
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const { pattern, flags, files, limit, maxBytes, clip } = workerData;
const regex = new RegExp(pattern, flags);
const matches = [];
let searched = 0, skipped = 0, truncated = false;
search: for (const file of files) {
  let buffer;
  try {
    if (fs.statSync(file.absolute).size > maxBytes) { skipped++; continue; }
    buffer = fs.readFileSync(file.absolute);
  } catch { continue; }
  if (buffer.subarray(0, 8000).includes(0)) continue;
  searched++;
  const lines = buffer.toString('utf8').split(/\\r?\\n/);
  for (let index = 0; index < lines.length; index++) {
    if (!regex.test(lines[index])) continue;
    let line = lines[index].trim();
    if (line.length > clip) line = line.slice(0, clip - 1) + '\\u2026';
    matches.push(file.relative + ':' + (index + 1) + ': ' + line);
    if (matches.length >= limit) { truncated = true; break search; }
  }
}
parentPort.postMessage({ matches, searched, skipped, truncated });
`;

function runSearch(data: Record<string, unknown>, timeoutMs: number, signal: AbortSignal): Promise<SearchResult | 'timeout' | 'cancelled'> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(SEARCH_WORKER, { eval: true, workerData: data });
    let settled = false;
    const settle = (finish: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      void worker.terminate();
      finish();
    };
    const onAbort = () => settle(() => resolve('cancelled'));
    const timer = setTimeout(() => settle(() => resolve('timeout')), timeoutMs);
    signal.addEventListener('abort', onAbort, { once: true });
    worker.once('message', (result: SearchResult) => settle(() => resolve(result)));
    worker.once('error', error => settle(() => reject(error)));
    worker.once('exit', () => settle(() => reject(new Error('The search stopped unexpectedly.'))));
  });
}

async function collectFiles(start: ResolvedPath, isDirectory: boolean, include: (fromStart: string, fromRoot: string) => boolean, signal: AbortSignal): Promise<{ files: SearchFile[]; capped: boolean }> {
  const files: SearchFile[] = [];
  if (!isDirectory) return { files: [{ absolute: start.absolute, relative: start.relative }], capped: false };
  const prefix = start.relative === '.' ? '' : `${start.relative}/`;
  let capped = false;
  const walk = async (absolute: string, fromStart: string): Promise<void> => {
    signal.throwIfAborted();
    let entries: Dirent[];
    try { entries = await readdir(absolute, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (files.length >= MAX_SEARCH_FILES) { capped = true; return; }
      const relative = fromStart ? `${fromStart}/${entry.name}` : entry.name;
      // Symbolic links are not followed: they could lead outside the workspace or loop.
      if (entry.isDirectory()) {
        if (!IGNORED_DIRECTORIES.has(entry.name) && !isCredentialPath(entry.name)) await walk(path.join(absolute, entry.name), relative);
      } else if (entry.isFile() && !isCredentialPath(prefix + relative) && include(relative, prefix + relative)) {
        files.push({ absolute: path.join(absolute, entry.name), relative: prefix + relative });
      }
    }
  };
  await walk(start.absolute, '');
  return { files, capped };
}

function searchFiles(root: string, timeoutMs: number): ToolDefinition<SearchInput> {
  return {
    name: 'search_files',
    description: 'Search file contents in the workspace with a JavaScript regular expression. Returns "path:line: text" lines. Skips node_modules, .git and similar directories, binary files and files over 1 MB.',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'JavaScript regular expression, for example "function\\s+load".' },
        path: { type: 'string', description: 'File or directory to search, relative to the workspace root. Defaults to ".".' },
        glob: { type: 'string', description: 'Only search matching files, for example "*.ts" or "src/**/*.tsx".' },
        case_sensitive: { type: 'boolean', description: 'Defaults to false.' },
        limit: { type: 'integer', description: 'Maximum number of matches (1-1000). Defaults to 100.', minimum: 1, maximum: 1000 },
      },
      required: ['pattern'],
      additionalProperties: false,
    },
    access: 'read',
    kind: 'search',
    describe: input => ({ label: safeLabel(`Searching for ${text(input.pattern)}`), target: pathLabel(input.path) }),
    run: (input, context) => guard(pathLabel(input.path), async () => {
      const pattern = text(input.pattern);
      if (!pattern) return failure('The pattern is empty.');
      const flags = input.case_sensitive === true ? '' : 'i';
      try { new RegExp(pattern, flags); }
      catch (error) { return failure(`Invalid regular expression: ${error instanceof Error ? error.message : String(error)}`); }
      const glob = text(input.glob).trim();
      let include: (fromStart: string, fromRoot: string) => boolean = () => true;
      if (glob) {
        const matches = globMatcher(glob);
        include = (fromStart, fromRoot) => matches(fromStart) || matches(fromRoot);
      }
      const resolved = await resolveInside(root, text(input.path, '.'), 'read');
      const info = await stat(resolved.absolute);
      const { files, capped } = await collectFiles(resolved, info.isDirectory(), include, context.signal);
      const limit = integer(input.limit, 100, 1, 1000);
      const result = await runSearch({ pattern, flags, files, limit, maxBytes: MAX_SEARCH_BYTES, clip: MATCH_TEXT_LENGTH }, timeoutMs, context.signal);
      if (result === 'cancelled') return failure('The search was cancelled.');
      if (result === 'timeout') return failure(`The search took longer than ${Math.round(timeoutMs / 1000)} s and was stopped. Simplify the pattern or narrow the path or glob.`);
      const notes: string[] = [];
      if (result.truncated) notes.push(`… stopped at ${plural(limit, 'match')}. Narrow the pattern, path or glob to see the rest.`);
      if (capped) notes.push(`Only the first ${MAX_SEARCH_FILES} files were searched.`);
      if (result.skipped) notes.push(`${plural(result.skipped, 'file')} over 1 MB ${result.skipped === 1 ? 'was' : 'were'} skipped.`);
      if (!result.matches.length) return { ok: true, output: [`No matches for /${pattern}/ in ${plural(result.searched, 'file')}.`, ...notes].join('\n') };
      return { ok: true, output: bound([...result.matches, ...notes].join('\n')) };
    }),
  };
}

// ---------------------------------------------------------------------------
// write_file and edit_file

async function existingKind(absolute: string): Promise<'file' | 'directory' | 'other' | undefined> {
  try {
    const info = await stat(absolute);
    return info.isFile() ? 'file' : info.isDirectory() ? 'directory' : 'other';
  } catch (error) {
    if (isNotFound(error)) return undefined;
    throw error;
  }
}

function writeFileTool(root: string): ToolDefinition<WriteInput> {
  return {
    name: 'write_file',
    description: 'Create a file or replace its entire content. Parent directories are created. Prefer edit_file for changes to existing files.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        content: { type: 'string', description: 'The complete new file content.' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
    access: 'write',
    kind: 'edit',
    describe: input => ({ label: `Writing ${pathLabel(input.path)}`, target: pathLabel(input.path), detail: safeText(text(input.content), 600), risk: 'low' }),
    run: input => guard(pathLabel(input.path), async () => {
      if (typeof input.content !== 'string') return failure('"content" must be a string.');
      const content = input.content;
      if (content.length > MAX_WRITE_CHARACTERS) return failure('The content is larger than the 5 MB write limit.');
      const resolved = await resolveInside(root, text(input.path), 'write');
      if (resolved.relative === '.') return failure('Give a file path, not the workspace folder.');
      const existing = await existingKind(resolved.absolute);
      if (existing && existing !== 'file') return failure(`"${resolved.relative}" exists and is not a regular file.`);
      await mkdir(path.dirname(resolved.absolute), { recursive: true });
      await writeFile(resolved.absolute, content, 'utf8');
      const change = existing ? 'update' : 'add';
      return {
        ok: true,
        output: `${existing ? 'Updated' : 'Created'} ${resolved.relative} (${plural(splitLines(content).length, 'line')}, ${formatBytes(Buffer.byteLength(content))}).`,
        files: [{ path: resolved.relative, change }],
      };
    }),
  };
}

function countOccurrences(haystack: string, needle: string): number {
  let count = 0;
  for (let index = haystack.indexOf(needle); index !== -1; index = haystack.indexOf(needle, index + needle.length)) count++;
  return count;
}

function editFileTool(root: string): ToolDefinition<EditInput> {
  return {
    name: 'edit_file',
    description: 'Replace exact text in a file. old_text must match the file exactly, including whitespace, and be unique unless replace_all is true. Read the file first.',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the workspace root.' },
        old_text: { type: 'string', description: 'Exact text to replace. Include enough surrounding lines to make it unique.' },
        new_text: { type: 'string', description: 'Replacement text.' },
        replace_all: { type: 'boolean', description: 'Replace every occurrence. Defaults to false.' },
      },
      required: ['path', 'old_text', 'new_text'],
      additionalProperties: false,
    },
    access: 'write',
    kind: 'edit',
    describe: input => ({
      label: `Editing ${pathLabel(input.path)}`,
      target: pathLabel(input.path),
      detail: `Replace:\n${safeText(text(input.old_text), 400)}\nWith:\n${safeText(text(input.new_text), 400)}`,
      risk: 'low',
    }),
    run: input => guard(pathLabel(input.path), async () => {
      let oldText = text(input.old_text);
      let newText = text(input.new_text);
      if (!oldText) return failure('old_text is empty. Use write_file to create a file.');
      if (oldText === newText) return failure('old_text and new_text are identical; nothing to change.');
      const resolved = await resolveInside(root, text(input.path), 'write');
      const name = resolved.relative;
      const existing = await existingKind(resolved.absolute);
      if (!existing) return failure(`"${name}" does not exist. Use write_file to create it.`);
      if (existing !== 'file') return failure(`"${name}" is not a regular file.`);
      const buffer = await readFile(resolved.absolute);
      if (buffer.length > MAX_READ_BYTES) return failure(`"${name}" is larger than the 5 MB edit limit.`);
      if (isBinary(buffer)) return failure(`"${name}" is a binary file and cannot be edited as text.`);
      const content = buffer.toString('utf8');
      let count = countOccurrences(content, oldText);
      // Models usually send "\n" line endings; match Windows line endings in the file.
      if (!count && content.includes('\r\n') && /(?<!\r)\n/.test(oldText)) {
        const crlf = (value: string) => value.replace(/\r?\n/g, '\r\n');
        if (countOccurrences(content, crlf(oldText))) { oldText = crlf(oldText); newText = crlf(newText); count = countOccurrences(content, oldText); }
      }
      if (!count) return failure(`old_text was not found in "${name}". Read the file again and copy the exact text, including indentation.`);
      const replaceAll = input.replace_all === true;
      if (count > 1 && !replaceAll) return failure(`old_text matches ${count} times in "${name}". Add surrounding lines to make it unique, or set replace_all to true.`);
      let updated: string;
      if (replaceAll) updated = content.split(oldText).join(newText);
      else {
        const index = content.indexOf(oldText);
        updated = content.slice(0, index) + newText + content.slice(index + oldText.length);
      }
      await writeFile(resolved.absolute, updated, 'utf8');
      const removed = splitLines(oldText).length, added = splitLines(newText).length;
      return {
        ok: true,
        output: `Edited ${name}: replaced ${plural(replaceAll ? count : 1, 'occurrence')} (-${plural(removed, 'line')}, +${plural(added, 'line')}).`,
        files: [{ path: name, change: 'update' }],
      };
    }),
  };
}

/** Workspace file tools. Every path is checked with `resolveInside`; output is bounded. */
export function createFileTools(root: string, options: FileToolOptions = {}): AnyTool[] {
  const timeoutMs = options.searchTimeoutMs ?? 20_000;
  return [listFiles(root), readFileTool(root), searchFiles(root, timeoutMs), writeFileTool(root), editFileTool(root)];
}

