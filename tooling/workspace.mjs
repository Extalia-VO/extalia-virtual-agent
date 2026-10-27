import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Workspace packages under apps/ and packages/, with their manifests. */
export async function workspacePackages() {
  const result = [];
  for (const group of ['apps', 'packages']) {
    let entries;
    try { entries = await readdir(path.join(ROOT, group), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = path.join(ROOT, group, entry.name);
      try {
        const manifest = JSON.parse(await readFile(path.join(dir, 'package.json'), 'utf8'));
        result.push({ group, dir, manifest, manifestPath: path.join(dir, 'package.json') });
      } catch { /* not a package */ }
    }
  }
  return result;
}

/** Body range of a TOML table such as `[package]`: from its header to the next header. */
function tomlTable(text, header) {
  const match = new RegExp(`^\\[${header.replace(/[.[\]]/g, '\\$&')}\\][^\\S\\n]*\\r?$`, 'm').exec(text);
  if (!match) return undefined;
  const start = match.index + match[0].length;
  const next = /^\[/m.exec(text.slice(start));
  return { start, end: next ? start + next.index : text.length };
}
const VERSION_LINE = /^(version\s*=\s*")([^"]*)(")/m;

/** The `version = "…"` of a TOML table, or undefined (for example `version.workspace = true`). */
export function tomlVersion(text, header) {
  const table = tomlTable(text, header);
  return table ? VERSION_LINE.exec(text.slice(table.start, table.end))?.[2] : undefined;
}

/** Replace the `version = "…"` of a TOML table; unchanged text when it has none. */
export function setTomlVersion(text, header, version) {
  const table = tomlTable(text, header);
  if (!table) return text;
  const body = text.slice(table.start, table.end).replace(VERSION_LINE, `$1${version}$3`);
  return text.slice(0, table.start) + body + text.slice(table.end);
}

/** Cargo.lock entry pattern of a workspace crate (no `source`, so path dependencies only). */
export const lockEntry = name => new RegExp(`(\\[\\[package\\]\\]\\r?\\nname = "${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"\\r?\\nversion = ")([^"]*)(")`);

/** Rust workspace crates under crates/, whose versions follow the root version. */
export async function rustCrates() {
  const result = [];
  let entries;
  try { entries = await readdir(path.join(ROOT, 'crates'), { withFileTypes: true }); } catch { return result; }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(ROOT, 'crates', entry.name, 'Cargo.toml');
    let text;
    try { text = await readFile(manifestPath, 'utf8'); } catch { continue; }
    const table = tomlTable(text, 'package');
    const name = table && /^name\s*=\s*"([^"]+)"/m.exec(text.slice(table.start, table.end))?.[1];
    if (!name) continue;
    const inherited = table && /^version\.workspace\s*=\s*true\s*$/m.test(text.slice(table.start, table.end));
    result.push({ name, manifestPath, text, inherited: Boolean(inherited), version: tomlVersion(text, 'package') });
  }
  return result;
}

export async function sourceFiles(dir) {
  const files = [];
  async function walk(current) {
    let entries;
    try { entries = await readdir(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (['node_modules', 'dist', '.vite'].includes(entry.name)) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (/\.(c|m)?tsx?$/.test(entry.name)) files.push(full);
    }
  }
  await walk(dir);
  return files;
}
