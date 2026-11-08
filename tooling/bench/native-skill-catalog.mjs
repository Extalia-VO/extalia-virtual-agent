#!/usr/bin/env node
/** Resource-contract probe with a synthetic registry transport; no provider or real scanner. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/cli/package.json'));
const { build } = require('esbuild');
const directory = await mkdtemp(path.join(os.tmpdir(), 'extalia-skill-catalog-'));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const sourceFiles = ['packages/host/src/skills.ts', 'packages/host/src/skillRegistry.ts', 'packages/runtime/src/prompt.ts'];
try {
  const entry = path.join(directory, 'entry.ts');
  await writeFile(entry, [
    `export {SkillRegistry,SKILL_REGISTRY_OPS} from ${JSON.stringify(path.join(root, sourceFiles[1]))};`,
    `export {buildAgentSkillCatalog,createSkillTools} from ${JSON.stringify(path.join(root, sourceFiles[0]))};`,
    `export {buildSystemPrompt} from ${JSON.stringify(path.join(root, sourceFiles[2]))};`,
  ].join('\n'));
  const bundle = path.join(directory, 'catalog.mjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { SkillRegistry, SKILL_REGISTRY_OPS, buildAgentSkillCatalog, createSkillTools, buildSystemPrompt } = await import(pathToFileURL(bundle).href);
  const hash = createHash('sha256');
  for (const file of sourceFiles) hash.update(file).update('\0').update(await readFile(path.join(root, file))).update('\0');
  const report = {
    benchmark: 'native-skill-catalog-contract', sourceFiles, sourceSha256: hash.digest('hex'),
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    scope: 'Synthetic in-process registry transport. Counts and serialized payload sizes, not production scanner readiness, IPC latency, process RSS, model quality or measured tokens/cost.',
    scenarios: [],
  };
  for (const count of [16, 128, 1000, 2048, 2049]) {
    const name = index => `skill-${String(index).padStart(4, '0')}`;
    const content = index => `---\nname: ${name(index)}\ndescription: ${index === count - 1 ? 'Needle migration procedure' : 'Example procedure'}\n---\n${'Synthetic instruction. '.repeat(200)}`;
    const revisions = Array.from({ length: count }, (_, index) => ({
      packageId: name(index), revisionId: `skr_${index.toString(16).padStart(64, '0')}`, origin: 'imported', version: '1.0.0',
      treeSha256: 'a'.repeat(64), skillMdSha256: sha256(content(index)), state: 'active', riskClass: 'declarative',
      manifestInferred: true, permissionDigest: 'b'.repeat(64), permissions: [], active: true,
      createdAt: '2026-11-08T00:00:00.000Z', updatedAt: '2026-11-08T00:00:00.000Z',
    }));
    const byRevision = new Map(revisions.map((revision, index) => [revision.revisionId, index]));
    const cursorOffsets = new Map(revisions.map((revision, index) => [`${revision.packageId}/${revision.revisionId}`, index + 1]));
    const calls = { lists: 0, reads: 0 };
    const client = { capabilities: SKILL_REGISTRY_OPS, async request(op, input) {
      if (op === 'skill.list') {
        calls.lists++;
        const offset = input.cursor ? cursorOffsets.get(input.cursor) : 0;
        if (offset === undefined) throw new Error('Invalid fixture cursor.');
        const page = revisions.slice(offset, offset + input.limit);
        return { revisions: page, indexGeneration: 1, ...(offset + page.length < count ? { nextCursor: `${page.at(-1).packageId}/${page.at(-1).revisionId}` } : {}) };
      }
      if (op !== 'skill.read') throw new Error('Unexpected fixture operation.');
      calls.reads++;
      const index = byRevision.get(input.revisionId);
      if (index === undefined) throw new Error('Unknown fixture revision.');
      const bytes = content(index), revision = revisions[index];
      return { revisionId: revision.revisionId, packageId: revision.packageId, path: 'SKILL.md', content: bytes, size: Buffer.byteLength(bytes), sha256: revision.skillMdSha256 };
    } };
    const registry = new SkillRegistry({ daemon: { connect: async () => client }, dataDirectory: directory, profile: 'example', workspaceRoot: () => directory });
    const inventory = await registry.activeCatalog();
    const initialReads = calls.reads, initialLists = calls.lists;
    const catalog = await buildAgentSkillCatalog(inventory.skills, { incomplete: inventory.incomplete, reloadMany: selected => registry.reloadMany(selected) });
    const tools = createSkillTools(catalog);
    const prompt = buildSystemPrompt({ workspace: { name: 'Example', root: '<workspace>' }, platform: { os: 'example', shell: 'example' }, skills: catalog.skills.map(({ name, description }) => ({ name, description })), skillCatalog: { omitted: catalog.omitted, incomplete: catalog.incomplete } });
    const block = prompt.match(/<skill-catalog>\n([\s\S]*?)\n<\/skill-catalog>/)?.[0];
    if (!block || block.length > 4000) throw new Error('Unbounded prompt catalog.');
    const previewReads = calls.reads - initialReads, previewLists = calls.lists - initialLists;
    const result = await tools.find(tool => tool.name === 'skill_search').run({ query: 'needle', limit: 10 });
    if (!result.ok || result.output.length > 4000) throw new Error('Invalid discovery result.');
    const found = JSON.parse(result.output);
    const externalPreview = catalog.skills.filter(skill => skill.source !== 'builtin');
    const retainedBodyCharacters = [...inventory.skills, ...externalPreview].reduce((sum, skill) => sum + (skill.body?.length ?? 0), 0);
    if (retainedBodyCharacters || externalPreview.length > 8) throw new Error('External instruction retention exceeded its contract.');
    report.scenarios.push({ registryRows: count, inventoryRows: inventory.skills.length, inventoryIncomplete: inventory.incomplete,
      initialRegistryReads: initialReads, initialIndexPages: initialLists, previewRegistryReads: previewReads, previewIndexPages: previewLists,
      externalPreviewRows: externalPreview.length, promptCatalogCharacters: block.length,
      toolSchemaCharacters: JSON.stringify(tools.map(({ name, description, parameters }) => ({ name, description, parameters }))).length,
      serializedInventoryBytes: Buffer.byteLength(JSON.stringify(inventory.skills)), retainedExternalBodyCharacters: retainedBodyCharacters,
      searchTargetFound: found.skills.some(skill => skill.name === name(count - 1)), searchIncomplete: found.incomplete,
      searchOutputCharacters: result.output.length, searchRegistryReads: calls.reads - initialReads - previewReads,
    });
  }
  console.log(JSON.stringify(report, null, 2));
} finally { await rm(directory, { recursive: true, force: true }); }
