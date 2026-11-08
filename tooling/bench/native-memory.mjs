#!/usr/bin/env node
/** Compare alphabetical metadata with bounded lexical recall; never calls a provider. */
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(ROOT, 'apps/cli/package.json'));
const { build } = require('esbuild');
const { values } = parseArgs({ options: { iterations: { type: 'string', default: '20' }, warmup: { type: 'string', default: '2' }, json: { type: 'boolean', default: false } } });
const iterations = Number(values.iterations), warmup = Number(values.warmup);
if (!Number.isSafeInteger(iterations) || iterations < 10 || iterations > 200 || !Number.isSafeInteger(warmup) || warmup < 1 || warmup > 20) throw new Error('Use iterations10–200 and warmup1–20.');
const cases = [
  { name: 'filename-en', prompt: 'Recall the cache policy before planning.', expected: 'z-cache-policy' },
  { name: 'filename-id', prompt: 'Tolong ingat aturan cache untuk tugas ini.', expected: 'z-cache-policy' },
  { name: 'summary-en', prompt: 'Which migration conventions were confirmed?', expected: 'z-decision' },
  { name: 'summary-id', prompt: 'Apa konvensi migrasi yang sudah dikonfirmasi?', expected: 'z-decision' },
  { name: 'no-match', prompt: 'Underwater painting and botanical illustration.', expected: null },
  { name: 'greeting', prompt: 'Hi, please help me.', expected: null },
];
const percentile = (samples, fraction) => [...samples].sort((a, b) => a - b)[Math.min(samples.length - 1, Math.ceil(samples.length * fraction) - 1)];
const temp = await mkdtemp(path.join(os.tmpdir(), 'extalia-memory-recall-'));
try {
  const entry = path.join(temp, 'entry.ts');
  await writeFile(entry, `export {MemoryStore} from ${JSON.stringify(path.join(ROOT, 'packages/host/src/memory.ts'))};\nexport {buildSystemPrompt} from ${JSON.stringify(path.join(ROOT, 'packages/runtime/src/prompt.ts'))};\n`);
  const bundle = path.join(temp, 'memory.mjs');
  await build({ entryPoints: [entry], outfile: bundle, bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'silent' });
  const { MemoryStore, buildSystemPrompt } = await import(pathToFileURL(bundle).href);
  const sourceHash = createHash('sha256');
  for (const file of ['packages/host/src/memory.ts', 'packages/runtime/src/prompt.ts']) sourceHash.update(file).update('\0').update(await readFile(path.join(ROOT, file))).update('\0');
  const report = {
    benchmark: 'native-memory-recall', sourceSha256: sourceHash.digest('hex'), sourceFiles: ['packages/host/src/memory.ts', 'packages/runtime/src/prompt.ts'],
    environment: { node: process.version, platform: process.platform, arch: process.arch, cpuModel: os.cpus()[0]?.model?.trim() ?? null },
    iterations, warmup, measurement: 'Repeated local reads; OS cache not reset; fixture creation excluded. No provider calls or measured token/cost savings.',
    scope: 'Metadata hit at8, not semantic retrieval or model answer quality. Named matches beyond128 are eligible; summary-only matches beyond128 can remain absent and must be reported incomplete.',
    scenarios: [],
  };
  const block = result => {
    const system = buildSystemPrompt({ workspace: { name: 'Example', root: '<workspace>' }, platform: { os: 'example', shell: 'example' },
      memory: result.notes.map(({ name, summary }) => ({ name, summary })), memoryCatalog: { omitted: result.omitted, incomplete: result.incomplete } });
    const match = system.match(/<memory-catalog>\n([\s\S]*?)\n<\/memory-catalog>/);
    if (!match || match[0].length > 2000) throw new Error('Prompt metadata exceeded its bound.');
    return { characters: match[0].length, bytes: Buffer.byteLength(match[0]), names: JSON.parse(match[1]).notes.map(note => note.name) };
  };
  for (const count of [16, 128, 1000]) {
    const directory = path.join(temp, `notes-${count}`); await mkdir(directory);
    for (let i = 0; i < count - 2; i++) await writeFile(path.join(directory, `a-note-${String(i).padStart(4, '0')}.md`), `# Ordinary note ${i}\nA synthetic project fact unrelated to the evaluated topics.\n`);
    await writeFile(path.join(directory, 'z-cache-policy.md'), '# Cache policy / aturan cache\nReuse stable prefixes only when explicitly configured.\n');
    await writeFile(path.join(directory, 'z-decision.md'), '# Migration conventions / konvensi migrasi\nA confirmed synthetic database decision.\n');
    const store = new MemoryStore(directory);
    for (const item of cases) {
      const timings = { alphabetical: [], recall: [] }; let baseline, candidate;
      const invoke = async kind => {
        const start = performance.now();
        const result = kind === 'alphabetical' ? await store.catalog({ limit: 8 }) : await store.recallCatalog(item.prompt, { limit: 8 });
        return { result, elapsed: performance.now() - start };
      };
      for (let i = 0; i < warmup + iterations; i++) {
        for (const kind of i % 2 ? ['recall', 'alphabetical'] : ['alphabetical', 'recall']) {
          const sample = await invoke(kind);
          if (i >= warmup) timings[kind].push(sample.elapsed);
          if (kind === 'alphabetical') baseline = sample.result; else candidate = sample.result;
        }
      }
      const baselineBlock = block(baseline), candidateBlock = block(candidate);
      report.scenarios.push({ notes: count, case: item.name, expected: item.expected,
        alphabetical: { p50Ms: percentile(timings.alphabetical, .5), p95Ms: percentile(timings.alphabetical, .95), hitAt8: item.expected === null ? null : baselineBlock.names.includes(item.expected), promptCharacters: baselineBlock.characters, promptBytes: baselineBlock.bytes, omitted: baseline.omitted, incomplete: baseline.incomplete },
        recall: { p50Ms: percentile(timings.recall, .5), p95Ms: percentile(timings.recall, .95), hitAt8: item.expected === null ? null : candidateBlock.names.includes(item.expected), promptCharacters: candidateBlock.characters, promptBytes: candidateBlock.bytes, omitted: candidate.omitted, incomplete: candidate.incomplete, diagnostics: candidate.diagnostics },
      });
    }
  }
  console.log(values.json ? JSON.stringify(report, null, 2) : JSON.stringify(report));
} finally { await rm(temp, { recursive: true, force: true }); }
