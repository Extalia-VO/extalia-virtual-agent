#!/usr/bin/env node
/** Extract independently loadable, skinned hair assets without Blender or a runtime dependency. */
import { existsSync } from 'node:fs';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const value = (flag, fallback) => { const at = process.argv.indexOf(flag); return at < 0 ? fallback : process.argv[at + 1]; };
// Local-only (git-ignored) folder: `source/<model-variant>.glb` holds the full model packs you are
// licensed to use; `bodies/` and `hair/` receive the pruned outputs. Nothing here may ever be committed.
const local = path.join(root, 'apps/web/local-assets/avatars');
const source = value('--source', path.join(local, 'source/office-classic.glb'));
const out = value('--out', path.join(local, 'hair'));
const definitions = [
  ['male', 'short-fade', 'Hair_short_fade'], ['male', 'slicked-back', 'Hair_slicked_back'],
  ['male', 'side-part', 'Hair_side_part'], ['male', 'undercut', 'Hair_undercut'], ['male', 'textured-crop', 'Hair_textured_crop'],
  ['male', 'curly', 'Hair_curly'], ['male', 'afro', 'Hair_afro'],
  ['female', 'bob', 'Hair_shoulder_bob'], ['female', 'wavy', 'Hair_wavy'],
  ['female', 'ponytail', 'Hair_ponytail'], ['female', 'high-ponytail', 'Hair_high_ponytail'], ['female', 'medium', 'Hair_executive_medium'],
];
async function parseGlb(file) {
  const bytes = await readFile(file);
  if (bytes.readUInt32LE(0) !== 0x46546c67 || bytes.readUInt32LE(4) !== 2) throw Error('Expected a glTF 2.0 GLB.');
  const jsonLength = bytes.readUInt32LE(12);
  const original = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString('utf8'));
  const binary = bytes.subarray(28 + jsonLength, 28 + jsonLength + bytes.readUInt32LE(20 + jsonLength));
  return { bytes, original, binary };
}
if (!existsSync(source)) {
  console.error(`Missing local source model: ${path.relative(root, source)}.\nSource-derived models are local-only; place your licensed packs under apps/web/local-assets/avatars/source/ (see apps/web/src/office/scene/avatars/README.md).`);
  process.exit(1);
}
const sourceModel = await parseGlb(source);
const copy = value => JSON.parse(JSON.stringify(value));
const mapping = set => new Map([...set].sort((a, b) => a - b).map((id, index) => [id, index]));
const pick = (array, map) => [...map.keys()].map(id => copy(array[id]));
const pad = (buffer, byte = 0) => Buffer.concat([buffer, Buffer.alloc((4 - buffer.length % 4) % 4, byte)]);
const digest = buffer => createHash('sha256').update(buffer).digest('hex');
const manifest = { schema: 'extalia.hair-assets.v1', sourceSha256: digest(sourceModel.bytes), assets: [], bodies: [] };
const jobs = definitions.map(([group, id, meshName]) => ({ group, id, meshName, sourceFile: source, body: false }));
for (const id of ['office-classic', 'business-man', 'business-woman', 'female-casual']) jobs.push({ group: 'bodies', id, sourceFile: path.join(path.dirname(source), `${id}.glb`), body: true });
for (const job of jobs) {
  const { group, id, meshName } = job;
  const { bytes, original, binary } = job.sourceFile === source ? sourceModel : await parseGlb(job.sourceFile);
  const meshIds = new Set(original.meshes.flatMap((mesh, index) => (job.body ? !mesh.name.startsWith('Hair_') : mesh.name === meshName) ? [index] : []));
  if (!meshIds.size) throw Error(`Missing authored mesh ${meshName ?? id}.`);
  const nodes = new Set(original.nodes.flatMap((node, index) => meshIds.has(node.mesh) ? [index] : []));
  const skins = new Set([...nodes].flatMap(id => original.nodes[id].skin === undefined ? [] : [original.nodes[id].skin]));
  const accessors = new Set(), materials = new Set(), textures = new Set(), images = new Set(), samplers = new Set(), views = new Set();
  for (const skinId of skins) {
    const skin = original.skins[skinId];
    skin.joints.forEach(id => nodes.add(id));
    if (skin.skeleton !== undefined) nodes.add(skin.skeleton);
    if (skin.inverseBindMatrices !== undefined) accessors.add(skin.inverseBindMatrices);
  }
  // Joint and mesh ancestors preserve the original canonical coordinate system.
  let changed = true;
  while (changed) {
    changed = false;
    original.nodes.forEach((node, index) => {
      if (!nodes.has(index) && node.children?.some(child => nodes.has(child))) { nodes.add(index); changed = true; }
    });
  }
  for (const meshId of meshIds) for (const primitive of original.meshes[meshId].primitives) {
    if (primitive.extensions) throw Error('Compressed primitives need a dedicated extractor.');
    Object.values(primitive.attributes).forEach(id => accessors.add(id));
    if (primitive.indices !== undefined) accessors.add(primitive.indices);
    primitive.targets?.forEach(target => Object.values(target).forEach(id => accessors.add(id)));
    if (primitive.material !== undefined) materials.add(primitive.material);
  }
  const findTextures = object => {
    if (!object || typeof object !== 'object') return;
    if (typeof object.index === 'number') textures.add(object.index);
    Object.values(object).forEach(findTextures);
  };
  for (const id of materials) findTextures(original.materials[id]);
  for (const id of textures) {
    const texture = original.textures[id];
    if (texture.source !== undefined) images.add(texture.source);
    if (texture.sampler !== undefined) samplers.add(texture.sampler);
    for (const extension of Object.values(texture.extensions ?? {})) if (extension.source !== undefined) images.add(extension.source);
  }
  for (const id of images) {
    const image = original.images[id];
    if (image.uri) throw Error('Only embedded images are supported.');
    views.add(image.bufferView);
  }
  for (const id of accessors) {
    const accessor = original.accessors[id];
    if (accessor.bufferView !== undefined) views.add(accessor.bufferView);
    if (accessor.sparse) { views.add(accessor.sparse.indices.bufferView); views.add(accessor.sparse.values.bufferView); }
  }
  const maps = { nodes: mapping(nodes), meshes: mapping(meshIds), skins: mapping(skins), accessors: mapping(accessors), materials: mapping(materials), textures: mapping(textures), images: mapping(images), samplers: mapping(samplers), bufferViews: mapping(views) };
  const doc = { asset: { version: '2.0', generator: 'Extalia skinned hair extractor' }, scene: 0, scenes: [{ nodes: original.scenes[original.scene ?? 0].nodes.filter(id => nodes.has(id)).map(id => maps.nodes.get(id)) }] };
  for (const [key, map] of Object.entries(maps)) if (map.size) doc[key] = pick(original[key], map);
  for (const node of doc.nodes) {
    if (node.children) node.children = node.children.filter(id => nodes.has(id)).map(id => maps.nodes.get(id));
    if (node.mesh !== undefined) { if (meshIds.has(node.mesh)) node.mesh = maps.meshes.get(node.mesh); else delete node.mesh; }
    if (node.skin !== undefined) { if (skins.has(node.skin)) node.skin = maps.skins.get(node.skin); else delete node.skin; }
  }
  for (const skin of doc.skins ?? []) {
    skin.joints = skin.joints.map(id => maps.nodes.get(id));
    if (skin.skeleton !== undefined) skin.skeleton = maps.nodes.get(skin.skeleton);
    if (skin.inverseBindMatrices !== undefined) skin.inverseBindMatrices = maps.accessors.get(skin.inverseBindMatrices);
  }
  for (const mesh of doc.meshes) for (const primitive of mesh.primitives) {
    for (const key of Object.keys(primitive.attributes)) primitive.attributes[key] = maps.accessors.get(primitive.attributes[key]);
    if (primitive.indices !== undefined) primitive.indices = maps.accessors.get(primitive.indices);
    primitive.targets?.forEach(target => { for (const key of Object.keys(target)) target[key] = maps.accessors.get(target[key]); });
    if (primitive.material !== undefined) primitive.material = maps.materials.get(primitive.material);
  }
  const remapTextures = object => { if (!object || typeof object !== 'object') return; if (typeof object.index === 'number') object.index = maps.textures.get(object.index); Object.values(object).forEach(remapTextures); };
  doc.materials?.forEach(remapTextures);
  for (const texture of doc.textures ?? []) {
    if (texture.source !== undefined) texture.source = maps.images.get(texture.source);
    if (texture.sampler !== undefined) texture.sampler = maps.samplers.get(texture.sampler);
    for (const extension of Object.values(texture.extensions ?? {})) if (extension.source !== undefined) extension.source = maps.images.get(extension.source);
  }
  doc.images?.forEach(image => { image.bufferView = maps.bufferViews.get(image.bufferView); });
  for (const accessor of doc.accessors) {
    if (accessor.bufferView !== undefined) accessor.bufferView = maps.bufferViews.get(accessor.bufferView);
    if (accessor.sparse) { accessor.sparse.indices.bufferView = maps.bufferViews.get(accessor.sparse.indices.bufferView); accessor.sparse.values.bufferView = maps.bufferViews.get(accessor.sparse.values.bufferView); }
  }
  let offset = 0; const chunks = [];
  for (const [originalId, index] of maps.bufferViews) {
    const view = original.bufferViews[originalId];
    if (view.buffer !== 0) throw Error('Expected one embedded buffer.');
    const chunk = binary.subarray(view.byteOffset ?? 0, (view.byteOffset ?? 0) + view.byteLength);
    doc.bufferViews[index].buffer = 0; doc.bufferViews[index].byteOffset = offset;
    const aligned = pad(chunk); chunks.push(aligned); offset += aligned.length;
  }
  const payload = Buffer.concat(chunks);
  doc.buffers = [{ byteLength: payload.length }];
  if (doc.textures?.some(texture => texture.extensions?.EXT_texture_webp)) { doc.extensionsUsed = ['EXT_texture_webp']; doc.extensionsRequired = ['EXT_texture_webp']; }
  const json = pad(Buffer.from(JSON.stringify(doc)), 0x20);
  const header = Buffer.alloc(20); header.writeUInt32LE(0x46546c67, 0); header.writeUInt32LE(2, 4); header.writeUInt32LE(28 + json.length + payload.length, 8); header.writeUInt32LE(json.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const binHeader = Buffer.alloc(8); binHeader.writeUInt32LE(payload.length, 0); binHeader.writeUInt32LE(0x004e4942, 4);
  const result = Buffer.concat([header, json, binHeader, payload]);
  const destination = job.body ? path.join(path.dirname(out), 'bodies') : path.join(out, group);
  await mkdir(destination, { recursive: true });
  await writeFile(path.join(destination, `${id}.glb`), result);
  if (job.body) manifest.bodies.push({ id, file: `../bodies/${id}.glb`, bytes: result.length, sha256: digest(result), sourceSha256: digest(bytes) });
  else manifest.assets.push({ id, group, mesh: meshName, file: `${group}/${id}.glb`, bytes: result.length, sha256: digest(result) });
}
await mkdir(out, { recursive: true });
await writeFile(path.join(out, 'catalog.json'), `${JSON.stringify(manifest, null, 2)}\n`);
console.log(`Extracted ${manifest.assets.length} skinned hair assets (${manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0)} bytes).`);
