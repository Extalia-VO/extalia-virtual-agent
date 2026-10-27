#!/usr/bin/env node
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
// Source-derived models are local-only (git-ignored); a public clone has none and skips this check.
const directory = new URL('../apps/web/local-assets/avatars/hair/', import.meta.url);
let manifestText;
try {
  manifestText = await readFile(new URL('catalog.json', directory), 'utf8');
} catch (error) {
  if (error?.code !== 'ENOENT') throw error;
  console.log('Hair asset check skipped: no local avatar assets (apps/web/local-assets/avatars). The public build renders the procedural characters.');
  process.exit(0);
}
const manifest = JSON.parse(manifestText);
// Light hair meshes are optional: a machine may ship only detailed (hair-card) styles.
assert(Array.isArray(manifest.assets));
for (const asset of manifest.assets) assert(['male', 'female'].includes(asset.group));
const ids = new Set();
async function checkAsset(asset, seen = ids) {
  assert(!seen.has(asset.id)); seen.add(asset.id);
  const bytes = await readFile(new URL(asset.file, directory));
  assert.equal(bytes.readUInt32LE(0), 0x46546c67);
  assert.equal(bytes.readUInt32LE(4), 2);
  assert.equal(bytes.readUInt32LE(8), bytes.length);
  assert.equal(bytes.length, asset.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), asset.sha256);
  const jsonLength = bytes.readUInt32LE(12);
  const doc = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binaryLength = bytes.readUInt32LE(20 + jsonLength);
  assert.deepEqual(doc.meshes.map(mesh => mesh.name), [asset.mesh]);
  assert.equal(doc.skins.length, 1);
  const joints = doc.skins[0].joints.map(id => doc.nodes[id].name);
  assert.equal(joints.length, 20);
  assert(joints.includes('head')); assert(joints.includes('hips'));
  for (const view of doc.bufferViews) { assert.equal(view.buffer, 0); assert(view.byteOffset % 4 === 0); assert(view.byteOffset + view.byteLength <= binaryLength); }
  const accessor = id => { assert(Number.isInteger(id)); assert(doc.accessors[id]); };
  for (const node of doc.nodes) {
    for (const child of node.children ?? []) assert(doc.nodes[child]);
    if (node.mesh !== undefined) assert(doc.meshes[node.mesh]);
    if (node.skin !== undefined) assert(doc.skins[node.skin]);
  }
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
    Object.values(primitive.attributes).forEach(accessor);
    if (primitive.indices !== undefined) accessor(primitive.indices);
    primitive.targets?.forEach(target => Object.values(target).forEach(accessor));
    if (primitive.material !== undefined) assert(doc.materials[primitive.material]);
  }
  for (const item of doc.accessors) {
    if (item.bufferView !== undefined) assert(doc.bufferViews[item.bufferView]);
    if (item.sparse) { assert(doc.bufferViews[item.sparse.indices.bufferView]); assert(doc.bufferViews[item.sparse.values.bufferView]); }
  }
  for (const image of doc.images ?? []) { assert(!image.uri); assert(doc.bufferViews[image.bufferView]); }
  for (const texture of doc.textures ?? []) {
    if (texture.source !== undefined) assert(doc.images[texture.source]);
    for (const extension of Object.values(texture.extensions ?? {})) if (extension.source !== undefined) assert(doc.images[extension.source]);
  }
}
for (const asset of manifest.assets) await checkAsset(asset);
assert(manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0) < 1_000_000, 'Extracted hair should not copy the whole avatar texture/body payload.');
assert.equal(manifest.bodies.length, 4);
for (const body of manifest.bodies) {
  const bytes = await readFile(new URL(body.file, directory));
  assert.equal(createHash('sha256').update(bytes).digest('hex'), body.sha256);
  const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
  assert(doc.meshes.some(mesh => mesh.name === 'Body'));
  assert(!doc.meshes.some(mesh => mesh.name.startsWith('Hair_')), 'Base body must not retain another gender/group hair mesh.');
  assert.equal(doc.skins[0].joints.length, 20);
}
// Detailed hair-card models (optional, tooling/convert-detailed-hair.py): one per light style at most.
const detailed = manifest.detailed ?? [];
const detailedIds = new Set();
for (const asset of detailed) {
  assert(['male', 'female'].includes(asset.group));
  assert(/^[a-z-]+$/.test(asset.id), `Detailed hair ${asset.id} needs a catalog style id.`);
  assert(asset.mesh.startsWith('Hair_detail_'));
  assert(asset.bytes < 4_000_000, `Detailed hair ${asset.id} should stay under 4 MB.`);
  await checkAsset(asset, detailedIds);
}
const count = group => manifest.assets.filter(asset => asset.group === group).length + detailed.filter(asset => asset.group === group).length;
assert(count('male') > 0 && count('female') > 0, 'Each group needs at least one local hair style.');
console.log(`Hair asset check passed: ${count('male')} male, ${count('female')} female (${detailed.length} detailed); complete canonical skeletons and valid local buffers.`);
