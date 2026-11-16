#!/usr/bin/env node
/** Source ownership inventory, not a packaged-runtime compliance certificate.
 * Default: concise report. --json: full evidence. --check-baseline: reviewed
 * migration baseline. --strict: fail on every remaining backend/review item.
 * --write-baseline is an explicit review operation; never run it automatically
 * from a check. --root and --baseline support disposable fixtures.
 */
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const VERSION = 1;
const SOURCE = /\.(?:[cm]?[jt]sx?)(?:\.template)?$/;
const DECLARATION = /\.d\.[cm]?ts$/;
const OMIT_DIRECTORIES = new Set(['node_modules', 'dist', 'release', '.vite', 'coverage', 'local-assets', '.git']);
// Desktop packaging stages native binaries and vendored worker payloads here.
// Their presence is artifact evidence, not authored product source (see .gitignore).
const GENERATED_DIRECTORIES = new Set(['apps/desktop/build-resources']);
// Exact reviewed build tools: a new executable next to them is not exempt.
const BUILD_TOOLS = new Set([
  'apps/cli/build.mjs', 'apps/cli/npm/generate.mjs', 'apps/web/vite.config.ts', 'apps/desktop/build.mjs',
  ...['after-pack', 'after-sign', 'create-linux-installer', 'installer-artwork', 'installer-assets', 'installer-copy',
    'linux-installer', 'packaged-smoke', 'release', 'render-installer-art', 'skip-node-modules'].map(name => `apps/desktop/scripts/${name}.mjs`),
]);
const BUILTINS = new Set(builtinModules.map(name => name.replace(/^node:/, '')));
const DEBT = new Set(['legacy-backend', 'shared-backend-review', 'unclassified-review']);
const ENTRYPOINTS = ['apps/cli/src/bin.ts', 'apps/desktop/src/main.ts', 'apps/desktop/src/preload.ts', 'apps/desktop/src/installer/preload.ts'];
const hash = value => createHash('sha256').update(value).digest('hex');
const builtin = name => name?.startsWith('node:') || BUILTINS.has(name);
const packageName = specifier => specifier.startsWith('@') ? specifier.split('/').slice(0, 2).join('/') : specifier.split('/')[0];
const bundledAsset = specifier => /^(?:\.?\.?\/)/.test(specifier)
  && /\.(?:css|json|svg|png|jpg|jpeg|webp|glb|gltf|woff2?|mp4|wav|mp3)(?:\?(?:url|raw|inline))?$/.test(specifier);
const runtimeSignature = file => hash(JSON.stringify({
  imports: file.imports.filter(edge => !edge.typeOnly).map(({ kind, specifier, target, unresolved, external, asset }) => ({ kind, specifier, target, unresolved, external, asset })),
  effects: file.effects.map(({ kind, detail }) => ({ kind, detail })),
}));

function excluded(file) {
  if (DECLARATION.test(file)) return 'declaration-only source (no emitted implementation)';
  if (/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)/.test(file) || /\.(?:test|spec)\.[cm]?[jt]sx?$/.test(file)) return 'test or fixture source';
  if (BUILD_TOOLS.has(file)) return 'explicit build/release/development tool';
  return undefined;
}

function backendOwner(file) {
  if (/^packages\/(?:host|runtime|importers)\//.test(file)) return true;
  return /^apps\/(?:cli|desktop)\//.test(file) && file !== 'apps/desktop/src/installer/renderer.mjs';
}

function typeOnlyStatement(node) {
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEmptyStatement(node)) return true;
  if (node.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.DeclareKeyword)) return true;
  // verbatimModuleSyntax preserves `import { type T }` / `export { type T }
  // from ...` as empty runtime imports/exports, including module side effects.
  if (ts.isImportDeclaration(node)) return Boolean(node.importClause?.isTypeOnly);
  if (ts.isExportDeclaration(node)) return Boolean(node.isTypeOnly || (!node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)
    && (!node.exportClause.elements.length || node.exportClause.elements.every(item => item.isTypeOnly))));
  if (ts.isImportEqualsDeclaration(node)) return node.isTypeOnly;
  return false;
}

/** TypeScript compiler syntax trees distinguish runtime edges from type edges. */
export function inspectSource(file, content) {
  const tree = ts.createSourceFile(file.replace(/\.template$/, ''), content, ts.ScriptTarget.Latest, true);
  const imports = [], effects = [];
  const line = node => tree.getLineAndCharacterOfPosition(node.getStart(tree)).line + 1;
  const add = (node, kind, expression, typeOnly = false) => {
    const specifier = expression && (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) ? expression.text : null;
    imports.push({ line: line(node), kind, specifier, typeOnly, ...(specifier === null ? { unresolved: 'nonliteral module expression' } : {}) });
    if (!typeOnly && builtin(specifier)) effects.push({ line: line(node), kind: 'node-builtin', detail: specifier });
    if (!typeOnly && specifier === 'electron') effects.push({ line: line(node), kind: 'privileged-shell', detail: 'electron' });
  };
  function visit(node) {
    if (ts.isImportDeclaration(node)) add(node, 'import', node.moduleSpecifier, typeOnlyStatement(node));
    else if (ts.isExportDeclaration(node) && node.moduleSpecifier) add(node, 'export', node.moduleSpecifier, typeOnlyStatement(node));
    else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)) add(node, 'import-equals', node.moduleReference.expression, node.isTypeOnly);
    else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)) add(node, 'import-type', node.argument.literal, true);
    else if (ts.isCallExpression(node)) {
      const name = node.expression.getText(tree);
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) add(node, 'dynamic-import', node.arguments[0]);
      else if (name === 'require' || name === 'module.require' || name === 'require.resolve') add(node, name, node.arguments[0]);
      if (['eval', 'Function', 'fetch', 'setInterval', 'setTimeout'].includes(name)) effects.push({ line: line(node), kind: 'runtime-call', detail: name });
    } else if (ts.isNewExpression(node) && ['Worker', 'SharedWorker', 'Function', 'WebSocket'].includes(node.expression.getText(tree))) {
      effects.push({ line: line(node), kind: 'runtime-constructor', detail: node.expression.getText(tree) });
    }
    // Embedded worker source is evidence even though it is not an import edge.
    if ((ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node) || ts.isTemplateExpression(node))
      && /\brequire\s*\(['"]node:|\bimport\s*\(['"]node:/.test(node.getText(tree))) {
      effects.push({ line: line(node), kind: 'embedded-backend-source', detail: 'string contains Node module execution' });
    }
    ts.forEachChild(node, visit);
  }
  visit(tree);
  return { imports, effects, typeOnly: tree.statements.every(typeOnlyStatement), parseErrors: tree.parseDiagnostics.map(error => ({
    line: tree.getLineAndCharacterOfPosition(error.start ?? 0).line + 1,
    message: ts.flattenDiagnosticMessageText(error.messageText, ' '),
  })) };
}

function moduleTarget(from, specifier, files, packages) {
  let base;
  if (specifier.startsWith('.')) base = path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  else {
    const name = packageName(specifier);
    const pkg = packages.get(name);
    if (!pkg) return undefined;
    const subpath = specifier.slice(name.length);
    const key = subpath ? `.${subpath}` : '.';
    const exported = typeof pkg.exports === 'string' ? (key === '.' ? pkg.exports : undefined) : pkg.exports?.[key];
    const direct = typeof exported === 'string' ? exported : exported?.import ?? exported?.default;
    base = direct ? path.posix.join(pkg.directory, direct) : path.posix.join(pkg.directory, subpath || 'src/index');
  }
  const stem = base.replace(/\.[cm]?jsx?$/, '');
  const candidates = [base, ...['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].map(extension => stem + extension),
    ...['.ts', '.tsx', '.js', '.mjs', '.cjs'].map(extension => `${base}/index${extension}`)];
  return candidates.find(candidate => files.has(candidate));
}

function categoryFor(record, reached) {
  const privileged = record.effects.some(effect => ['node-builtin', 'privileged-shell', 'embedded-backend-source'].includes(effect.kind));
  if (backendOwner(record.path)) return ['legacy-backend', 'product backend ownership; purity or absence of Node imports does not exempt it'];
  if (privileged) return ['legacy-backend', 'privileged runtime effect/import outside a backend directory'];
  if (record.parseErrors.length || record.imports.some(edge => !edge.typeOnly && edge.unresolved)) return ['unclassified-review', 'unresolved runtime module edge or syntax requires review'];
  if (record.typeOnly) return ['boundary-contract', 'only erased declarations and type-only imports/exports'];
  if (reached) return ['shared-backend-review', 'runtime-reachable from backend source; includes conservative barrel exports'];
  if (record.path.startsWith('apps/web/') || record.path === 'apps/desktop/src/installer/renderer.mjs') return ['ui', 'browser/UI source; privileged imports separately checked'];
  if (/^packages\/(?:protocol|core|platform|office)\//.test(record.path)) return ['shared-backend-review', 'shared executable contracts/domain logic require ownership review; no blanket purity exemption'];
  return ['unclassified-review', 'new or unknown product source requires explicit ownership review'];
}

export async function inventory(root = ROOT) {
  const records = new Map(), packages = new Map(), packageOwners = [], exclusions = [], issues = [];
  async function walk(directory) {
    let entries;
    try { entries = await readdir(path.join(root, directory), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' && ['apps', 'packages'].includes(directory)) return; throw error; }
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const file = `${directory}/${entry.name}`;
      if (entry.isSymbolicLink()) { issues.push({ path: file, reason: 'symlink is not followed; ownership requires review' }); continue; }
      if (entry.isDirectory()) {
        if (OMIT_DIRECTORIES.has(entry.name) || GENERATED_DIRECTORIES.has(file)) exclusions.push({ path: `${file}/`, reason: 'dependency, generated output or local asset directory; packaged contents not audited' });
        else await walk(file);
        continue;
      }
      if (entry.name === 'package.json') {
        const manifest = JSON.parse(await readFile(path.join(root, file), 'utf8'));
        const dependencies = new Map();
        for (const section of ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']) {
          for (const name of Object.keys(manifest[section] ?? {})) if (!dependencies.has(name)) dependencies.set(name, section);
        }
        const owner = { directory, exports: manifest.exports, dependencies };
        packageOwners.push(owner);
        if (manifest.name) packages.set(manifest.name, owner);
      }
      if (!SOURCE.test(file)) continue;
      const bytes = await readFile(path.join(root, file));
      const content = bytes.toString('utf8');
      records.set(file, { path: file, sha256: hash(bytes), bytes: bytes.length,
        loc: content ? content.split(/\r?\n/).length - (content.endsWith('\n') ? 1 : 0) : 0,
        nonblankLoc: content.split(/\r?\n/).filter(value => value.trim()).length,
        exclusion: excluded(file), ...inspectSource(file, content) });
    }
  }
  await walk('apps'); await walk('packages');
  packageOwners.sort((a, b) => b.directory.length - a.directory.length);
  for (const record of records.values()) for (const edge of record.imports) {
    if (!edge.specifier || builtin(edge.specifier)) continue;
    edge.target = moduleTarget(record.path, edge.specifier, records, packages);
    if (edge.target) continue;
    if (bundledAsset(edge.specifier)) { edge.asset = 'bundled non-code asset'; continue; }
    const name = packageName(edge.specifier);
    const owner = packageOwners.find(pkg => record.path.startsWith(`${pkg.directory}/`));
    if (packages.has(name) || edge.specifier.startsWith('@extalia/')) edge.unresolved = 'workspace source target not resolved';
    else if (edge.specifier.startsWith('.') || edge.specifier.startsWith('/')) edge.unresolved = 'relative or absolute source target not found';
    else if (owner?.dependencies.has(name)) edge.external = { package: name, declaredIn: `${owner.directory}/package.json`, section: owner.dependencies.get(name) };
    else edge.unresolved = 'bare module or alias is unresolved and not a declared external dependency';
  }
  // Anything imported by production is production, even under test/build paths.
  const included = new Set([...records.values()].filter(item => !item.exclusion).map(item => item.path));
  const productionQueue = [...included];
  for (let index = 0; index < productionQueue.length; index++) {
    for (const edge of records.get(productionQueue[index]).imports) {
      if (!edge.typeOnly && edge.target && !included.has(edge.target)) { included.add(edge.target); productionQueue.push(edge.target); }
    }
  }
  const reached = new Map();
  const roots = [...included].filter(file => backendOwner(file) || records.get(file).effects.some(effect => ['node-builtin', 'privileged-shell'].includes(effect.kind)));
  for (const file of roots) reached.set(file, { root: file });
  const queue = [...roots];
  for (let index = 0; index < queue.length; index++) {
    const source = queue[index];
    for (const edge of records.get(source).imports) if (!edge.typeOnly && edge.target && included.has(edge.target) && !reached.has(edge.target)) {
      reached.set(edge.target, { root: reached.get(source).root, via: source, line: edge.line }); queue.push(edge.target);
    }
  }
  const files = [];
  for (const record of records.values()) {
    if (!included.has(record.path)) { exclusions.push({ path: record.path, reason: record.exclusion }); continue; }
    const [category, reason] = categoryFor(record, reached.has(record.path));
    const { exclusion, ...details } = record;
    files.push({ ...details, category, reason, ...(exclusion ? { promotedExclusion: exclusion } : {}), ...(reached.has(record.path) ? { backendReachability: reached.get(record.path) } : {}) });
  }
  files.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  exclusions.sort((a, b) => a.path.localeCompare(b.path, 'en'));
  const categories = {};
  for (const file of files) {
    const counts = categories[file.category] ??= { files: 0, loc: 0, bytes: 0 };
    counts.files++; counts.loc += file.loc; counts.bytes += file.bytes;
  }
  return {
    schemaVersion: VERSION,
    scope: 'Product JavaScript/TypeScript source under apps/ and packages/, including sources outside src and JavaScript templates.',
    policy: 'React remains presentation-only. Backend placement uses measured efficiency and output parity; TypeScript may remain. Strict language mode is diagnostic, not a product migration quota.',
    evidence: ['docs/adr/0069-ui-only-typescript-and-backend-ownership.md', 'docs/architecture/overview.md', 'docs/adr/0053-evidence-based-native-process-partition.md', 'docs/adr/0067-rust-owned-learning-and-profile-artifacts.md', 'apps/cli/build.mjs', 'apps/desktop/build.mjs'],
    entrypoints: ENTRYPOINTS.filter(file => records.has(file)),
    graphPolicy: 'Runtime imports from every backend-owned product source, conservatively including barrel exports; type-only edges do not establish runtime reachability.',
    limitations: [
      'Source classification does not prove packaged runtime language compliance; emitted bundles, native launchers, transitive dependencies and actual processes need separate verification.',
      'Module resolution covers relative sources and workspace exports; aliases, conditional exports, nonliteral imports and reflective loading require review.',
      'Declared external npm dependencies are recorded, not traversed or certified UI-only. Their actual contents, export conditions and bundled behavior require separate dependency/artifact verification.',
      'Effect evidence is syntax-based, not a complete authority or dataflow analysis; imported aliases, embedded code and browser privilege bridges require human review.',
      'Shared executable modules are conservatively debt, including unused barrel exports. No tree-shaking or semantic ownership proof is claimed.',
      'Hash baselines detect source changes and new paths, not correctness or permission/drain parity. Baseline updates require review.',
      'Relocation within inventoried source requires new-path review. Moving execution into excluded generated/build artifacts is outside this source proof and requires packaged artifact/entrypoint verification.',
    ],
    summary: { files: files.length, outstandingFiles: files.filter(file => DEBT.has(file.category)).length, categories, excludedEntries: exclusions.length, unresolvedIssues: issues.length },
    files, exclusions, issues,
  };
}

export function createBaseline(report) {
  return { schemaVersion: VERSION, purpose: 'Reviewed migration baseline only; never a zero-backend-JavaScript certificate.',
    files: report.files.filter(file => DEBT.has(file.category)).map(({ path, category, sha256, loc, bytes, effects, imports }) => ({ path, category, sha256, loc, bytes,
      effectKinds: [...new Set(effects.map(effect => effect.kind))].sort(), unresolvedRuntimeImports: imports.filter(edge => !edge.typeOnly && edge.unresolved).length })),
    // Paths only for UI/contracts: avoid snapshotting unrelated UI contents, while
    // a new/relocated product file still requires explicit classification review.
    reviewedNonDebt: report.files.filter(file => !DEBT.has(file.category)).map(file => ({ path: file.path, category: file.category, runtimeSignature: runtimeSignature(file) })),
    issues: report.issues,
  };
}

export function checkBaseline(report, baseline) {
  if (baseline?.schemaVersion !== VERSION || !Array.isArray(baseline.files) || !Array.isArray(baseline.reviewedNonDebt) || !Array.isArray(baseline.issues)) return ['Invalid or unsupported ownership baseline.'];
  const problems = [], previous = new Map();
  for (const file of baseline.files) {
    if (!file || typeof file.path !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256) || !DEBT.has(file.category)
      || !Number.isSafeInteger(file.loc) || file.loc < 0 || !Number.isSafeInteger(file.bytes) || file.bytes < 0 || previous.has(file.path)) return ['Invalid ownership baseline entry.'];
    previous.set(file.path, file);
  }
  for (const file of baseline.reviewedNonDebt) {
    if (!file || typeof file.path !== 'string' || !['ui', 'boundary-contract'].includes(file.category) || !/^[a-f0-9]{64}$/.test(file.runtimeSignature) || previous.has(file.path)) return ['Invalid non-debt ownership baseline entry.'];
    previous.set(file.path, file);
  }
  for (const file of report.files) {
    const old = previous.get(file.path);
    if (!old) { problems.push(`${file.path}: new product source requires ownership baseline review (${file.category}).`); continue; }
    if (old.category !== file.category) problems.push(`${file.path}: ownership changed ${old.category} -> ${file.category}; review the boundary.`);
    if ((DEBT.has(old.category) || DEBT.has(file.category)) && old.sha256 !== file.sha256) problems.push(`${file.path}: legacy/review source changed (${old.loc} -> ${file.loc} LOC); explicit baseline review required.`);
    if (old.runtimeSignature && old.runtimeSignature !== runtimeSignature(file)) problems.push(`${file.path}: UI/contract runtime imports or effect signature changed; ownership review required.`);
  }
  // Deletions are allowed, but cannot be hidden by adding a build/test exclusion.
  const excludedPaths = new Set(report.exclusions.map(item => item.path));
  const excludedDirectories = report.exclusions.filter(item => item.path.endsWith('/')).map(item => item.path);
  for (const file of baseline.files) if (DEBT.has(file.category)
    && (excludedPaths.has(file.path) || excludedDirectories.some(directory => file.path.startsWith(directory)))) problems.push(`${file.path}: outstanding source became excluded; review required.`);
  const knownIssues = new Set(baseline.issues.map(issue => JSON.stringify(issue)));
  for (const issue of report.issues) if (!knownIssues.has(JSON.stringify(issue))) problems.push(`${issue.path}: ${issue.reason}.`);
  return problems;
}

export function strictProblems(report) {
  return [...report.files.filter(file => DEBT.has(file.category)).map(file => `${file.path}: ${file.category}`),
    ...report.issues.map(issue => `${issue.path}: ${issue.reason}`)];
}

export async function main(argv = process.argv.slice(2)) {
  let root = ROOT, baselinePath, json = false, check = false, strict = false, write = false;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root' || arg === '--baseline') {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a path.`);
      if (arg === '--root') root = path.resolve(value); else baselinePath = path.resolve(value);
    } else if (arg === '--json') json = true;
    else if (arg === '--check-baseline') check = true;
    else if (arg === '--strict') strict = true;
    else if (arg === '--write-baseline') write = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (write && (check || strict)) throw new Error('--write-baseline cannot be combined with a check.');
  baselinePath ??= path.join(root, 'tooling/backend-ownership-baseline.json');
  const report = await inventory(root);
  const problems = [];
  if (write) await writeFile(baselinePath, `${JSON.stringify(createBaseline(report), null, 2)}\n`);
  const baselineProblems = check ? checkBaseline(report, JSON.parse(await readFile(baselinePath, 'utf8'))) : [];
  const ownershipProblems = strict ? strictProblems(report) : [];
  problems.push(...baselineProblems, ...ownershipProblems);
  if (json) console.log(JSON.stringify({ ...report, ...(check || strict ? { check: { mode: strict ? 'strict-source-ownership' : 'migration-baseline', passed: !problems.length, problems } } : {}) }, null, 2));
  else {
    console.log(`Backend ownership source audit: ${report.summary.files} files; ${report.summary.outstandingFiles} outstanding backend/review files.`);
    console.log('Placement policy: measured efficiency; backend TypeScript remains allowed. Strict mode is a language inventory diagnostic.');
    for (const [category, counts] of Object.entries(report.summary.categories)) console.log(`  ${category}: ${counts.files} files, ${counts.loc} LOC`);
    console.log(`  Explicit exclusions: ${report.summary.excludedEntries}; unresolved inventory issues: ${report.summary.unresolvedIssues}.`);
    if (write) console.log('Wrote migration baseline for review; this does not certify language compliance.');
    if (check) console.log(`Migration-baseline ${baselineProblems.length ? 'FAILED' : 'passed'}; this is NOT zero-backend-JavaScript compliance.`);
    if (strict) console.log(`Strict source ownership ${ownershipProblems.length ? 'FAILED' : 'passed'}; packaged runtime verification remains separate.`);
    if (problems.length) console.error(problems.slice(0, 30).map(problem => `- ${problem}`).join('\n') + (problems.length > 30 ? `\n… ${problems.length - 30} more; use --json for all evidence.` : ''));
    if (!check && !strict && !write) console.log('Use --json for paths/hashes/import evidence, --check-baseline for migration review, --strict for the zero-debt source gate.');
  }
  return problems.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }).catch(error => { console.error(`Backend ownership audit failed: ${error.message}`); process.exitCode = 1; });
}
