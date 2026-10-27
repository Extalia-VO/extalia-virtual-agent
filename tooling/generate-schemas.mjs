#!/usr/bin/env node
/**
 * Emit the JSON Schema (draft 2020-12) contract files derived from @extalia/protocol
 * into packages/protocol/schemas/ (ADR 0021), plus `transitions.json`, the shared task
 * and mission state transition tables. The Rust daemon and `cargo test` read these
 * committed files; the TypeScript validators and tables remain the reference.
 *
 *   node tooling/generate-schemas.mjs          write the files
 *   node tooling/generate-schemas.mjs --check  fail when committed files differ (drift)
 *
 * Loads the TypeScript sources directly, so it needs Node's type stripping.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import module from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROOT } from './workspace.mjs';

if (!process.features.typescript) {
  // Node versions before default type stripping still support the flag.
  const child = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(child.status ?? 1);
}

// Package sources import siblings as `./name.js`; resolve those to the `.ts` files.
function resolve(specifier, context, next) {
  if (specifier.startsWith('.') && specifier.endsWith('.js') && context.parentURL?.endsWith('.ts')) {
    const source = new URL(specifier.replace(/\.js$/, '.ts'), context.parentURL);
    if (existsSync(fileURLToPath(source))) return next(source.href, context);
  }
  return next(specifier, context);
}
if (module.registerHooks) module.registerHooks({ resolve });
else module.register(`data:text/javascript,${encodeURIComponent(`import { existsSync } from 'node:fs'; import { fileURLToPath } from 'node:url'; export ${resolve.toString().replace('function resolve', 'async function resolve')}`)}`);

const check = process.argv.includes('--check');
const OUT = path.join(ROOT, 'packages/protocol/schemas');
const { protocolContractFiles } = await import(pathToFileURL(path.join(ROOT, 'packages/protocol/src/protocolSchemas.ts')).href);
const expected = new Map(Object.entries(protocolContractFiles()));
const present = existsSync(OUT) ? (await readdir(OUT)).filter(file => file.endsWith('.json')) : [];
const stale = present.filter(file => !expected.has(file));

if (check) {
  const problems = stale.map(file => `${file}: no longer generated`);
  for (const [file, text] of expected) {
    const current = present.includes(file) ? await readFile(path.join(OUT, file), 'utf8') : undefined;
    if (current === undefined) problems.push(`${file}: missing`);
    else if (current !== text) problems.push(`${file}: differs from the generated file`);
  }
  if (problems.length) {
    console.error(`Schema drift (run node tooling/generate-schemas.mjs):\n- ${problems.join('\n- ')}`);
    process.exit(1);
  }
  console.log(`Schemas current (${expected.size} files).`);
} else {
  await mkdir(OUT, { recursive: true });
  for (const file of stale) await rm(path.join(OUT, file));
  for (const [file, text] of expected) await writeFile(path.join(OUT, file), text);
  console.log(`Wrote ${expected.size} contract files to ${path.relative(ROOT, OUT)}.`);
}
