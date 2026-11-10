import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import { checkBaseline, createBaseline, inspectSource, inventory, strictProblems } from '../backend-ownership.mjs';

const temporary: string[] = [];
const run = promisify(execFile);
const script = fileURLToPath(new URL('../backend-ownership.mjs', import.meta.url));
afterEach(async () => { await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function put(root: string, file: string, content: string) {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), content);
}
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'extalia-backend-ownership-'));
  temporary.push(root);
  for (const [file, content] of Object.entries(files)) await put(root, file, content);
  return root;
}

describe('backend ownership migration inventory', () => {
  it('counts pure runtime and importer algorithms as backend without Node imports', async () => {
    const root = await fixture({
      'packages/runtime/src/loop.ts': 'export function loop() { return 1; }\n',
      'packages/importers/parse.js': 'export const parse = text => JSON.parse(text);\n',
      'apps/web/public/boot-appearance.js': 'document.body.dataset.theme = "dark";\n',
    });
    const report = await inventory(root);
    expect(report.files.map(file => [file.path, file.category])).toEqual([
      ['apps/web/public/boot-appearance.js', 'ui'],
      ['packages/importers/parse.js', 'legacy-backend'],
      ['packages/runtime/src/loop.ts', 'legacy-backend'],
    ]);
    expect(report.summary.outstandingFiles).toBe(2);
    expect(strictProblems(report)).toHaveLength(2);
  });

  it('finds JS variants and runtime templates outside src; new paths fail baseline', async () => {
    const root = await fixture({ 'packages/host/src/index.ts': 'export const ready = true;\n' });
    const baseline = createBaseline(await inventory(root));
    for (const file of ['apps/cli/launch.mjs', 'apps/desktop/helper.cjs', 'packages/host/worker.js', 'apps/cli/npm/platform/index.js.template']) await put(root, file, 'module.exports = {};\n');
    const report = await inventory(root);
    expect(report.files).toHaveLength(5);
    expect(checkBaseline(report, baseline)).toHaveLength(4);
  });

  it('separates type-only import/export edges from static, dynamic and require effects', () => {
    const evidence = inspectSource('contracts.ts', [
      'import type { Stats } from "node:fs";',
      'import { type View } from "./view.js";',
      'export type { View } from "./view.js";',
      'export { type View } from "./view.js";',
      'type Mod = import("./types.js").Mod;',
      'const fs = require("node:fs");',
      'const mod = import("./runtime.js");',
      'const unknown = import(variable);',
    ].join('\n'));
    expect(evidence.imports.map(edge => edge.typeOnly)).toEqual([true, false, true, false, true, false, false, false]);
    expect(evidence.effects.filter(effect => effect.kind === 'node-builtin')).toEqual([{ line: 6, kind: 'node-builtin', detail: 'node:fs' }]);
    expect(evidence.imports.at(-1)?.unresolved).toBe('nonliteral module expression');
  });

  it('retains erased contracts but treats shared computations as outstanding review', async () => {
    const root = await fixture({
      'packages/core/src/contract.ts': 'export interface View { name: string }\n',
      'packages/core/src/reducer.ts': 'export function reduce(a, b) { return a + b; }\n',
      'packages/host/src/index.ts': 'import type { View } from "../../core/src/contract.js"; import { reduce } from "../../core/src/reducer.js";\n',
    });
    const report = await inventory(root);
    const contract = report.files.find(file => file.path.endsWith('/contract.ts'));
    const reducer = report.files.find(file => file.path.endsWith('/reducer.ts'));
    expect(contract?.category).toBe('boundary-contract');
    expect(contract?.backendReachability).toBeUndefined();
    expect(reducer?.category).toBe('shared-backend-review');
    expect(reducer?.backendReachability).toMatchObject({ via: 'packages/host/src/index.ts', line: 1 });
  });

  it('resolves workspace export graphs and includes production imports of excluded fixtures', async () => {
    const root = await fixture({
      'packages/core/package.json': JSON.stringify({ name: '@extalia/core', exports: { '.': './src/index.ts' } }),
      'packages/core/src/index.ts': 'export { parse } from "../test/fixture.js";\n',
      'packages/core/test/fixture.ts': 'export const parse = value => JSON.parse(value);\n',
      'packages/core/test/unreferenced.test.ts': 'throw new Error("test only");\n',
      'apps/cli/src/bin.ts': 'import { parse } from "@extalia/core";\n',
      'apps/cli/build.mjs': 'import "node:fs";\n',
      'apps/desktop/build-resources/vendor/worker.js': 'require("node:fs");\n',
    });
    const report = await inventory(root);
    expect(report.files.find(file => file.path.endsWith('/fixture.ts'))).toMatchObject({ category: 'shared-backend-review', promotedExclusion: 'test or fixture source' });
    expect(report.files.find(file => file.path.endsWith('/bin.ts'))?.imports[0].target).toBe('packages/core/src/index.ts');
    expect(report.exclusions).toEqual(expect.arrayContaining([
      { path: 'apps/cli/build.mjs', reason: 'explicit build/release/development tool' },
      { path: 'packages/core/test/unreferenced.test.ts', reason: 'test or fixture source' },
      { path: 'apps/desktop/build-resources/', reason: 'dependency, generated output or local asset directory; packaged contents not audited' },
    ]));
  });

  it('keeps nonliteral dynamic imports unresolved and strict-failing in UI paths', async () => {
    const root = await fixture({ 'apps/web/src/load.ts': 'export const load = value => import(value);\n' });
    const report = await inventory(root);
    expect(report.files[0].category).toBe('unclassified-review');
    expect(strictProblems(report)).toHaveLength(1);
  });

  it('fails strict for unresolved bare aliases instead of silently classifying them as UI', async () => {
    const root = await fixture({
      'apps/web/package.json': JSON.stringify({ name: '@extalia/web', dependencies: { react: '*' } }),
      'apps/web/src/load.ts': 'import { run } from "@/runtime/provider"; export const invoke = run;\n',
    });
    const report = await inventory(root);
    expect(report.files[0].category).toBe('unclassified-review');
    expect(report.files[0].imports[0].unresolved).toContain('not a declared external dependency');
    expect(strictProblems(report)).toHaveLength(1);
  });

  it('records declared external dependencies including subpaths without claiming their implementation is audited', async () => {
    const root = await fixture({
      'apps/web/package.json': JSON.stringify({ name: '@extalia/web', dependencies: { react: '*' }, peerDependencies: { '@example/components': '*' } }),
      'apps/web/src/view.ts': 'import "react/jsx-runtime"; import "@example/components/button"; import "./theme.css?inline";\n',
    });
    const report = await inventory(root);
    expect(report.files[0].category).toBe('ui');
    expect(report.files[0].imports[0].external).toEqual({ package: 'react', declaredIn: 'apps/web/package.json', section: 'dependencies' });
    expect(report.files[0].imports[1].external).toEqual({ package: '@example/components', declaredIn: 'apps/web/package.json', section: 'peerDependencies' });
    expect(report.files[0].imports[2].asset).toBe('bundled non-code asset');
    expect(strictProblems(report)).toEqual([]);
    expect(report.limitations.join('\n')).toContain('not traversed or certified UI-only');
  });

  it('does not borrow another package dependencies to excuse an unresolved alias', async () => {
    const root = await fixture({
      'apps/other/package.json': JSON.stringify({ name: '@extalia/other', dependencies: { 'runtime-alias': '*' } }),
      'apps/web/package.json': JSON.stringify({ name: '@extalia/web' }),
      'apps/web/src/view.ts': 'import "runtime-alias";\n',
    });
    const report = await inventory(root);
    expect(report.files[0].category).toBe('unclassified-review');
    expect(strictProblems(report)).toHaveLength(1);
  });

  it('requires review for changed debt, even same-size code; accepts actual deletion', async () => {
    const root = await fixture({ 'packages/runtime/src/loop.ts': 'export const limit = 1;\n' });
    const baseline = createBaseline(await inventory(root));
    await put(root, 'packages/runtime/src/loop.ts', 'export const limit = 2;\n');
    expect(checkBaseline(await inventory(root), baseline).join('\n')).toContain('legacy/review source changed');
    await rm(path.join(root, 'packages/runtime/src/loop.ts'));
    expect(checkBaseline(await inventory(root), baseline)).toEqual([]);
  });

  it('does not treat an excluded ancestor directory as proof of backend deletion', async () => {
    const root = await fixture({ 'packages/runtime/src/loop.ts': 'export const limit = 1;\n' });
    const report = await inventory(root);
    const baseline = createBaseline(report);
    const hiddenReport = { ...report, files: [], exclusions: [{ path: 'packages/runtime/', reason: 'new exclusion rule' }] };
    expect(checkBaseline(hiddenReport, baseline).join('\n')).toContain('outstanding source became excluded');
  });

  it('rejects relocation to UI and new browser network effects in reviewed UI', async () => {
    const root = await fixture({
      'packages/runtime/src/loop.ts': 'export const limit = 1;\n',
      'apps/web/src/display.ts': 'export const title = "Office";\n',
    });
    const baseline = createBaseline(await inventory(root));
    await rm(path.join(root, 'packages/runtime/src/loop.ts'));
    await put(root, 'apps/web/src/relocated.ts', 'export const limit = 1;\n');
    await put(root, 'apps/web/src/display.ts', 'export const title = "Office"; fetch("https://example.com");\n');
    const problems = checkBaseline(await inventory(root), baseline);
    expect(problems.join('\n')).toContain('new product source');
    expect(problems.join('\n')).toContain('runtime imports or effect signature changed');
  });

  it('records embedded Node worker source instead of hiding it in a string', () => {
    const evidence = inspectSource('files.ts', 'const code = `const fs = require("node:fs");`; new Worker(code, {eval: true});');
    expect(evidence.effects).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'embedded-backend-source' }),
      expect.objectContaining({ kind: 'runtime-constructor', detail: 'Worker' }),
    ]));
  });

  it('fails closed on invalid baselines and syntax errors rather than hiding files', async () => {
    const root = await fixture({ 'apps/web/src/broken.ts': 'export const = ;\n' });
    const report = await inventory(root);
    expect(report.files[0].parseErrors.length).toBeGreaterThan(0);
    expect(strictProblems(report)).toHaveLength(1);
    expect(checkBaseline(report, { schemaVersion: 99 })).toEqual(['Invalid or unsupported ownership baseline.']);
  });

  it('CLI baseline passes honestly while strict exits nonzero for the same tree', async () => {
    const root = await fixture({ 'packages/runtime/src/loop.ts': 'export const loop = () => 1;\n' });
    const baseline = path.join(root, 'baseline.json');
    await run(process.execPath, [script, '--root', root, '--baseline', baseline, '--write-baseline']);
    const result = await run(process.execPath, [script, '--root', root, '--baseline', baseline, '--check-baseline']);
    expect(result.stdout).toContain('Migration-baseline passed');
    expect(result.stdout).toContain('NOT zero-backend-JavaScript compliance');
    await expect(run(process.execPath, [script, '--root', root, '--strict'])).rejects.toMatchObject({ code: 1, stdout: expect.stringContaining('Strict source ownership FAILED') });
    expect(JSON.parse(await readFile(baseline, 'utf8')).files).toHaveLength(1);
  });
});
