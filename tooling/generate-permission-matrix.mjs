#!/usr/bin/env node
/**
 * Write the `decide()` parity matrix (audit PR 7, ADR 0026) to
 * packages/runtime/test/fixtures/permission/decide-matrix.json. Vitest
 * (`permissionMatrix.test.ts`) and `cargo test` (extalia-daemon `tests/permissions.rs`)
 * both read the committed file; Vitest fails when it differs from live `decide()` output.
 *
 *   node tooling/generate-permission-matrix.mjs          write the file
 *   node tooling/generate-permission-matrix.mjs --check  fail when the committed file differs
 *
 * Loads the TypeScript sources directly, so it needs Node's type stripping.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
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

const OUT = path.join(ROOT, 'packages/runtime/test/fixtures/permission/decide-matrix.json');
const { buildDecideMatrix, serializeDecideMatrix } = await import(pathToFileURL(path.join(ROOT, 'packages/runtime/test/permissionMatrix.ts')).href);
const matrix = buildDecideMatrix();
const text = serializeDecideMatrix(matrix);

if (process.argv.includes('--check')) {
  const current = existsSync(OUT) ? await readFile(OUT, 'utf8') : undefined;
  if (current !== text) {
    console.error(`Permission matrix drift (run node tooling/generate-permission-matrix.mjs): ${path.relative(ROOT, OUT)} ${current === undefined ? 'is missing' : 'differs'}.`);
    process.exit(1);
  }
  console.log(`Permission matrix current (${matrix.cases.length} cases).`);
} else {
  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, text);
  console.log(`Wrote ${matrix.cases.length} cases to ${path.relative(ROOT, OUT)}.`);
}
