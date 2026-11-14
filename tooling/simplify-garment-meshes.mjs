/** Offline helper for simplify-garment-meshes.py; never imported by the renderer. */
import { readFileSync, writeFileSync } from 'node:fs';
import { MeshoptSimplifier } from 'meshoptimizer';

await MeshoptSimplifier.ready;
const job = JSON.parse(readFileSync(process.argv[2], 'utf8'));
function load(path, Type) {
  const bytes = readFileSync(path);
  return new Type(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
}
const [indices, error] = MeshoptSimplifier.simplifyWithAttributes(
  load(job.indices, Uint32Array), load(job.positions, Float32Array), 3,
  load(job.attributes, Float32Array), job.weights.length, job.weights, null,
  job.target, job.error, ['LockBorder'],
);
writeFileSync(job.output, Buffer.from(indices.buffer, indices.byteOffset, indices.byteLength));
process.stdout.write(JSON.stringify({ error, indices: indices.length }));
