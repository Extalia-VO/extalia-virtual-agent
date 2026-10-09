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
