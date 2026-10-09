#!/usr/bin/env node
/**
 * Enforce directional dependencies between workspace packages (PRD: "dependencies
 * must remain directional and avoid UI/runtime coupling").
 *
 * - Every workspace package must have a rule below; new packages declare their place.
 * - Packages never depend on apps.
 * - Imports of other workspace packages must be allowed and declared in package.json.
 * - Domain packages stay free of UI frameworks, renderers, Electron and Node built-ins.
 * - Relative imports never reach into another package's files.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { ROOT, sourceFiles, workspacePackages } from './workspace.mjs';

const DOMAIN_FORBIDDEN = [/^react(-dom)?(\/|$)/, /^three(\/|$)/, /^@react-three\//, /^electron$/, /^node:/, /^(fs|path|os|child_process|http|https|net)$/];

const RULES = {
  '@extalia/protocol': { allow: [], forbid: DOMAIN_FORBIDDEN },
  '@extalia/core': { allow: ['@extalia/protocol'], forbid: DOMAIN_FORBIDDEN },
  '@extalia/platform': { allow: ['@extalia/protocol', '@extalia/core'], forbid: DOMAIN_FORBIDDEN },
  // Pure parsers for native agent histories: data in, portable sessions out.
  '@extalia/importers': { allow: ['@extalia/core'], forbid: DOMAIN_FORBIDDEN },
  // Pure agent loop and model providers: runs in any JavaScript host.
  '@extalia/runtime': { allow: ['@extalia/protocol', '@extalia/core'], forbid: DOMAIN_FORBIDDEN },
  // Spatial office contracts, room semantics, and presence projection.
  '@extalia/office': { allow: ['@extalia/protocol'], forbid: DOMAIN_FORBIDDEN },
  // Node host for the runtime: files, commands, credentials. No UI or Electron.
  '@extalia/host': { allow: ['@extalia/protocol', '@extalia/core', '@extalia/platform', '@extalia/runtime', '@extalia/importers'], forbid: [/^react(-dom)?(\/|$)/, /^three(\/|$)/, /^electron$/] },
  '@extalia/web': { allow: ['@extalia/protocol', '@extalia/core', '@extalia/platform', '@extalia/office'], forbid: [/^electron$/, /^node:/] },
  '@extalia/desktop': { allow: ['@extalia/protocol', '@extalia/core', '@extalia/platform', '@extalia/runtime', '@extalia/host'], forbid: [/^react(-dom)?(\/|$)/, /^three(\/|$)/] },
  // The CLI is published to npm as `extalia-vo` (bin: `extalia`).
  'extalia-vo': { allow: ['@extalia/protocol', '@extalia/core', '@extalia/platform', '@extalia/runtime', '@extalia/host'], forbid: [/^react(-dom)?(\/|$)/, /^three(\/|$)/, /^electron$/] },
};

const IMPORT = /(?:^|[^\w.$])(?:import|export)\s+(?:type\s+)?(?:[^'"`;]*?\sfrom\s*)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g;

const problems = [];
const packages = await workspacePackages();
const appNames = new Set(packages.filter(item => item.group === 'apps').map(item => item.manifest.name));

for (const { group, dir, manifest } of packages) {
  const name = manifest.name;
  const rule = RULES[name];
  const where = path.relative(ROOT, dir);
  if (!rule) { problems.push(`${where}: ${name} has no boundary rule in tooling/check-boundaries.mjs.`); continue; }
  const declared = { ...manifest.dependencies, ...manifest.devDependencies, ...manifest.peerDependencies };
  for (const dependency of Object.keys(declared)) {
    if (group === 'packages' && appNames.has(dependency)) problems.push(`${where}: packages must not depend on apps (${dependency}).`);
    if (dependency.startsWith('@extalia/') && !rule.allow.includes(dependency)) problems.push(`${where}: ${name} may not depend on ${dependency}.`);
  }
  for (const file of await sourceFiles(dir)) {
    const text = await readFile(file, 'utf8');
    for (const match of text.matchAll(IMPORT)) {
      const specifier = match[1] ?? match[2];
      if (!specifier) continue;
      const at = `${path.relative(ROOT, file)}: ${specifier}`;
      if (specifier.startsWith('.')) {
        const target = path.resolve(path.dirname(file), specifier);
        if (!target.startsWith(dir + path.sep)) problems.push(`${at} reaches outside ${where}; import the package instead.`);
        continue;
      }
      if (specifier.startsWith('@extalia/')) {
        const pkg = specifier.split('/').slice(0, 2).join('/');
        if (!rule.allow.includes(pkg)) problems.push(`${at} is not an allowed dependency of ${name}.`);
        else if (!(pkg in declared)) problems.push(`${at} is used but not declared in ${where}/package.json.`);
        continue;
      }
      if (rule.forbid.some(pattern => pattern.test(specifier))) problems.push(`${at} is forbidden in ${name}.`);
    }
  }
}

if (problems.length) {
  console.error(`Boundary check failed (${problems.length}):\n- ${problems.join('\n- ')}`);
  process.exit(1);
}
console.log(`Boundary check passed for ${packages.length} workspace packages.`);
