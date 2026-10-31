#!/usr/bin/env node
/** Developer-only pinned staging. No production packaging or automatic downloads. */
import { createHash } from 'node:crypto';
import { chmod, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { materializePythonArchive } from './archive.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const REFUSAL = () => new Error('Python staging refused.');
async function optionalStat(file) {
  try { return await lstat(file); }
  catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
}
export async function candidatePins() { return JSON.parse(await readFile(path.join(HERE, 'runtime-pins.json'), 'utf8')); }
async function cleanOwned(directory) {
  const meta = await optionalStat(directory);
  if (!meta) return;
  if (meta.isDirectory() && !meta.isSymbolicLink()) {
    await chmod(directory, 0o700);
    for (const item of await readdir(directory)) await cleanOwned(path.join(directory, item));
  }
  await rm(directory, { recursive: true, force: true });
}
async function downloadArchive(pin, destination) {
  const output = await open(destination, 'wx', 0o600);
  try {
    const response = await fetch(pin.url, { signal: AbortSignal.timeout(60_000) });
    if (!response.ok || !response.body) throw REFUSAL();
    let bytes = 0; const digest = createHash('sha256');
    for await (const chunk of response.body) {
      bytes += chunk.length; if (bytes > pin.bytes) throw REFUSAL();
      digest.update(chunk);
      let offset = 0;
      while (offset < chunk.length) {
        const result = await output.write(chunk, offset, chunk.length - offset);
        if (!result.bytesWritten) throw REFUSAL();
        offset += result.bytesWritten;
      }
    }
    if (bytes !== pin.bytes || digest.digest('hex') !== pin.sha256) throw REFUSAL();
  } catch { throw REFUSAL(); } finally { await output.close(); }
}

/** Out must be absent. Archives/outputs are trusted developer paths, never model input. */
export async function buildPythonBundle({ target, out, archive, download = false }) {
  if (typeof target !== 'string' || typeof out !== 'string' || !path.isAbsolute(out)
      || (archive !== undefined && (typeof archive !== 'string' || !path.isAbsolute(archive)))
      || typeof download !== 'boolean' || Number(archive !== undefined) + Number(download) !== 1) throw REFUSAL();
  const catalog = await candidatePins();
  const pin = catalog.assets.find(item => `${item.target.os}-${item.target.arch}` === target);
  if (!pin) throw REFUSAL();
  // This exclusive reservation is the only directory that failure cleanup may own.
  await mkdir(out, { mode: 0o700 });
  let staging; let success = false;
  try {
    staging = await mkdtemp(path.join(path.dirname(out), '.extalia-python-stage-'));
    const input = archive ?? path.join(staging, 'source.tar.gz');
    if (download) await downloadArchive(pin, input);
    const temporaryPayload = path.join(staging, 'payload');
    const inventory = await materializePythonArchive(input, pin, temporaryPayload);
    const interpreter = pin.target.os === 'windows' ? 'python/python.exe' : 'python/bin/python3.13';
    if (!inventory.materialized.some(item => item.path === interpreter)) throw REFUSAL();
    const worker = path.join(temporaryPayload, 'worker'); await mkdir(worker, { mode: 0o700 });
    const records = inventory.materialized.map(item => ({ path: item.path, role: item.path === interpreter ? 'interpreter' : 'support', bytes: item.bytes, sha256: item.sha256 }));
    for (const [name, source] of [['probe.py', path.join(HERE, 'probe.py')], ['reference_worker.py', path.join(HERE, '../worker-protocol/reference_worker.py')]]) {
      const bytes = await readFile(source); await writeFile(path.join(worker, name), bytes, { flag: 'wx', mode: 0o444 });
      records.push({ path: `worker/${name}`, role: name === 'probe.py' ? 'entry_script' : 'support', bytes: bytes.length, sha256: hash(bytes) });
    }
    await chmod(worker, 0o555);
    records.sort((a,b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
    if (records.length > 4096 || records.reduce((sum,item)=>sum+item.bytes,0) > 536870912) throw REFUSAL();
    const directories = new Set();
    for (const record of records) {
      const parts = record.path.split('/');
      for (let depth = 1; depth < parts.length; depth++) directories.add(parts.slice(0, depth).join('/'));
    }
    if (directories.size > 4096 || directories.size + records.length > 8192) throw REFUSAL();
    const manifest = { schema_version: 1, target: pin.target, runtime_version: pin.runtime_version,
      worker_version: '0.0.0-reference', operations: ['health'], interpreter, entry_script: 'worker/probe.py', files: records };
    const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
    if (bytes.length > 1048576) throw REFUSAL();
    // Relocation is intentional: the original payload pathname no longer exists before probing.
    await rename(temporaryPayload, path.join(out, 'payload'));
    await writeFile(path.join(out, 'bundle-manifest.json'), bytes, { flag: 'wx', mode: 0o444 });
    const summary = { status: 'development-candidate', target: pin.target, runtime_version: pin.runtime_version,
      archive_sha256: pin.sha256, archive_bytes: pin.bytes, manifest_sha256: hash(bytes),
      file_count: records.length, total_bytes: records.reduce((sum,item)=>sum+item.bytes,0),
      relocated: true, original_payload_removed: !(await optionalStat(temporaryPayload)),
      source: catalog.source, production_ready: false, scanner_ready: false };
    await writeFile(path.join(out, 'source-record.json'), JSON.stringify(summary,null,2)+'\n', { flag: 'wx', mode: 0o444 });
    await cleanOwned(staging); staging = undefined;
    success = true; return summary;
  } finally {
    try { if (staging) await cleanOwned(staging); }
    finally { if (!success) await cleanOwned(out); }
  }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({ options: { target: { type: 'string' }, out: { type: 'string' }, archive: { type: 'string' }, download: { type: 'boolean', default: false } } });
    console.log(JSON.stringify(await buildPythonBundle(values)));
  } catch { console.error('Python staging refused; check explicit target, archive pin and an absent output directory.'); process.exitCode = 2; }
}
