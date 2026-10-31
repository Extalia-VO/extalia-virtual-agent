import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './workspace.mjs';

export const PUBLIC_MODEL_DIRECTORY = 'apps/web/public-assets';
export const PUBLIC_MODELS_MANIFEST = `${PUBLIC_MODEL_DIRECTORY}/models.json`;
export const PUBLIC_SOURCE_GARMENTS = `${PUBLIC_MODEL_DIRECTORY}/source-garments.json`;
const SOURCE_GARMENT_EXPORTER = 'tooling/blender/fit-source-garments.py';
const FIT_CHECKS = ['rest', 'walk', 'sit', 'reach', 'sourceAppearance'];
const AVATAR_BONES = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm',
  'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
const AVATAR_NOTICES = ['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md'];
const LICENSED_AVATAR_LICENSE = 'LicenseRef-RenderHub-Extended-Use';
const LICENSED_AVATAR_EXPORTER = 'tooling/prepare-licensed-avatars.py';
// Staff uniforms are cut from the licensed avatar outfit, so they keep its license.
const LICENSED_OUTFIT_EXPORTERS = {
  'tooling/blender/create-staff-uniforms.py': /^avatars\/outfits\/(?:male|female)\/[a-z0-9-]+-uniform\.glb$/,
};
const AVATAR_LICENSE_TERMS = /https:\/\/(?:www\.)?renderhub\.com\/info\/3d-content-licensing(?:[\s)#/?]|$)/;
// Campus cars simplified from third-party reference models: one GLB per car, each with its
// own license and a matching "Campus vehicles" notice entry carrying that license's terms.
// They are never MIT-licensed. Non-commercial (NC, NC-SA) entries must say "non-commercial
// use only" on their own notice line; owner-provided files without a licence must say their
// author and licence are pending owner confirmation.
const NON_COMMERCIAL = /non-commercial use only/i;
const VEHICLE_LICENSE_TERMS = {
  'CC-BY-4.0': { section: [/https?:\/\/creativecommons\.org\/licenses\/by\/4\.0/] },
  'CC-BY-NC-4.0': { section: [/https?:\/\/creativecommons\.org\/licenses\/by-nc\/4\.0/], line: NON_COMMERCIAL },
  'CC-BY-NC-SA-4.0': { section: [/https?:\/\/creativecommons\.org\/licenses\/by-nc-sa\/4\.0/], line: NON_COMMERCIAL },
  'LicenseRef-Sketchfab-Standard': { section: [/https:\/\/sketchfab\.com\/licenses/] },
  'LicenseRef-Owner-Provided-Unverified': { section: [], line: /pending owner confirmation/i },
  [LICENSED_AVATAR_LICENSE]: { section: [AVATAR_LICENSE_TERMS, /Extended Use License/] },
};
const DERIVED_VEHICLE_LICENSES = Object.keys(VEHICLE_LICENSE_TERMS);
const DERIVED_VEHICLE_EXPORTER = 'tooling/blender/prepare-campus-vehicles.py';
const DERIVED_VEHICLE_PATH = /^vehicles\/[a-z0-9-]+\.glb$/;
// Wearable outfits refitted from third-party garments (`prepare-avatar-outfits.py`): the same
// licences as the cars, each credited on its own line of the "Avatar outfits" notice section.
const DERIVED_OUTFIT_EXPORTER = 'tooling/blender/prepare-avatar-outfits.py';
const DERIVED_OUTFIT_PATH = /^avatars\/outfits\/(?:male|female)\/outfit-[a-z0-9-]+\.glb$/;
const ORIGINAL_GARMENT_EXPORTERS = {
  'tooling/blender/fit-original-garments.py': /^avatars\/wardrobe\/female\/outer\/cloth-jacket\.glb$/,
  'tooling/blender/fit-original-bottoms.py': /^avatars\/wardrobe\/(?:female\/bottom\/short-jeans|male\/bottom\/jeans)\.glb$/,
  'tooling/blender/fit-original-sets.py': /^avatars\/outfits\/female\/(?:outfit-original-dress|reception-uniform)\.glb$/,
  'tooling/blender/fit-original-bartender.py': /^avatars\/outfits\/male\/bartender-uniform\.glb$/,
};
const VEHICLE_NOTICE = 'THIRD_PARTY_NOTICES.md';
const MODEL = /\.(glb|gltf|fbx)$/i;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Public models: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hashString = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const positiveInteger = value => Number.isSafeInteger(value) && value > 0;

// The authoring receipt uses Python json.dumps. Preserve its published numeric tokens
// (notably 1.0 versus 1) instead of changing their type during a JavaScript round trip.
class ReceiptNumber {
  constructor(value, source) { this.value = value; this.source = source; }
}
const numeric = value => value instanceof ReceiptNumber ? value.value : value;
function receiptDocument(text) {
  return JSON.parse(text, (_key, value, context) => {
    if (typeof value !== 'number') return value;
    if (typeof context?.source !== 'string') fail('material receipts require JSON numeric source support');
    return new ReceiptNumber(value, context.source);
  });
}
function pythonString(value) {
  return JSON.stringify(value).replace(/[\u007f-\uffff]/g, character => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
function canonical(value) {
  if (value instanceof ReceiptNumber) return value.source;
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (object(value)) return `{${Object.keys(value).sort().map(key => `${pythonString(key)}:${canonical(value[key])}`).join(',')}}`;
  return typeof value === 'string' ? pythonString(value) : JSON.stringify(value);
}
function cloneReceipt(value) {
  if (value instanceof ReceiptNumber) return value;
  if (Array.isArray(value)) return value.map(cloneReceipt);
  return object(value) ? Object.fromEntries(Object.entries(value).map(([key, child]) => [key, cloneReceipt(child)])) : value;
}
function at(items, rawIndex, label) {
  const index = numeric(rawIndex);
  if (!Array.isArray(items) || !Number.isSafeInteger(index) || index < 0 || index >= items.length) fail(`invalid ${label} index`);
  return items[index];
}
function* textureInfos(value, prefix = '') {
  if (Array.isArray(value)) {
    for (const [index, child] of value.entries()) yield* textureInfos(child, `${prefix}/${index}`);
  } else if (object(value) && !(value instanceof ReceiptNumber)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extras') continue;
      const location = `${prefix}/${key}`;
      if (key.toLowerCase().endsWith('texture') && object(child)) {
        if (child.index === undefined) fail('TextureInfo is missing its index');
        yield [location, child];
      } else yield* textureInfos(child, location);
    }
  }
}
function* imageSources(value) {
  if (Array.isArray(value)) {
    for (const child of value) yield* imageSources(child);
  } else if (object(value) && !(value instanceof ReceiptNumber)) {
    for (const [key, child] of Object.entries(value)) {
      if (key === 'extras') continue;
      if (key === 'source') yield [value, key];
      else yield* imageSources(child);
    }
  }
}
function imagePayload(document, binary, image) {
  const view = at(document.bufferViews, image.bufferView, 'image bufferView');
  const start = numeric(view.byteOffset) ?? 0, size = numeric(view.byteLength);
  if ((numeric(view.buffer) ?? 0) !== 0 || !Number.isSafeInteger(start) || start < 0
    || !positiveInteger(size) || start + size > binary.length) fail('invalid embedded source image range');
  return binary.subarray(start, start + size);
}
function materialReceipt(document, binary, material) {
  const normalized = cloneReceipt(material), requiredImages = [], uvSets = new Set();
  delete normalized.name; delete normalized.extras;
  for (const [location, info] of textureInfos(normalized)) {
    const texture = cloneReceipt(at(document.textures, info.index, 'material texture'));
    if (texture.sampler !== undefined) texture.sampler = cloneReceipt(at(document.samplers, texture.sampler, 'sampler'));
    const sources = [...imageSources(texture)];
    if (!sources.length) fail('source material texture has no image');
    for (const [owner, key] of sources) {
      const image = at(document.images, owner[key], 'texture image'), bytes = imagePayload(document, binary, image);
      const graph = cloneReceipt(image), sha256 = digest(bytes);
      delete graph.bufferView; delete graph.uri;
      graph.payloadSHA256 = sha256;
      owner[key] = graph;
      requiredImages.push({ textureInfo: location, sha256, bytes: bytes.length });
    }
    info.index = texture;
    const uv = numeric(info.extensions?.KHR_texture_transform?.texCoord ?? info.texCoord ?? 0);
    if (!Number.isSafeInteger(uv) || uv < 0) fail('invalid source texture coordinate set');
    uvSets.add(uv);
  }
  return { graphSHA256: digest(canonical(normalized)), requiredImages, requiredUVSets: [...uvSets].sort((a, b) => a - b) };
}

/** Verify the exact Python-authored material graphs, embedded pixels and UV requirements. */
export function verifySourceGarmentMaterialReceipts(file, receipts) {
  const bytes = readFileSync(file);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length) fail('invalid source garment GLB header');
  let cursor = 12, document, binary;
  while (cursor + 8 <= bytes.length) {
    const length = bytes.readUInt32LE(cursor), kind = bytes.readUInt32LE(cursor + 4);
    if (cursor + 8 + length > bytes.length) fail('truncated source garment chunk');
    if (kind === JSON_CHUNK) document = receiptDocument(bytes.toString('utf8', cursor + 8, cursor + 8 + length));
    if (kind === BIN_CHUNK) binary = bytes.subarray(cursor + 8, cursor + 8 + length);
    cursor += 8 + length;
  }
  if (!document || !binary || !object(receipts) || !Object.keys(receipts).length) fail('missing source material receipts');
  const used = new Map();
  for (const mesh of document.meshes ?? []) for (const primitive of mesh.primitives ?? []) {
    const material = at(document.materials, primitive.material, 'material'), name = material.name ?? '';
    if (!name.startsWith('Original')) continue;
    const uses = used.get(name) ?? [];
    uses.push(primitive); used.set(name, uses);
  }
  if (canonical([...used.keys()].sort()) !== canonical(Object.keys(receipts).sort())) fail('original materials and receipts differ');
  const imageSort = values => [...values].sort((a, b) => canonical(a).localeCompare(canonical(b)));
  for (const [name, expected] of Object.entries(receipts)) {
    const matches = document.materials.filter(material => material.name === name);
    if (matches.length !== 1) fail(`duplicate source material ${name}`);
    const actual = materialReceipt(document, binary, matches[0]);
    if (actual.graphSHA256 !== expected.graphSHA256
      || canonical(imageSort(actual.requiredImages)) !== canonical(imageSort(expected.requiredImages))
      || canonical(actual.requiredUVSets) !== canonical(expected.requiredUVSets)) fail(`source material graph/image receipt mismatch: ${name}`);
    for (const primitive of used.get(name)) {
      const attrs = primitive.attributes ?? {}, position = at(document.accessors, attrs.POSITION, 'POSITION');
      for (const uv of actual.requiredUVSets) {
        const accessor = at(document.accessors, attrs[`TEXCOORD_${uv}`], 'required UV');
        if (accessor.type !== 'VEC2' || numeric(accessor.count) !== numeric(position.count)) fail(`required UV mismatch: ${name}`);
      }
    }
  }
}

/** Per-file approvals are separate from the model registry and never authorize other paths. */
export function readSourceGarmentProfiles(root = ROOT) {
  const filename = path.join(root, PUBLIC_SOURCE_GARMENTS);
  if (!existsSync(filename)) return [];
  let data;
  try { data = JSON.parse(readFileSync(regular(root, PUBLIC_SOURCE_GARMENTS), 'utf8')); } catch { fail('invalid source-garments.json'); }
  keys(data, ['schemaVersion', 'exporter', 'garments'], 'source garment manifest');
  if (data.schemaVersion !== 1 || data.exporter !== SOURCE_GARMENT_EXPORTER || !Array.isArray(data.garments)) fail('invalid source garment manifest');
  const seen = new Set();
  for (const record of data.garments) {
    keys(record, ['path', 'id', 'group', 'mode', 'source', 'fittedSHA256', 'sha256', 'triangles', 'bytes', 'budgets', 'fitChecks',
      'materials', 'materialGraphSHA256', 'imageSHA256s', 'license', 'componentLicenses', 'attribution'], 'source garment profile');
    if (!['male', 'female'].includes(record.group) || typeof record.id !== 'string' || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(record.id)
      || !['outfit', 'top', 'bottom', 'outer'].includes(record.mode)) fail('invalid source garment identity');
    const expectedPath = record.mode === 'outfit' ? `avatars/outfits/${record.group}/outfit-${record.id}.glb`
      : `avatars/wardrobe/${record.group}/${record.mode}/${record.id}.glb`;
    if (record.path !== expectedPath || seen.has(record.path)) fail('unsafe or duplicate source garment path');
    seen.add(record.path);
    keys(record.source, ['path', 'sha256'], 'source garment origin');
    relative(record.source.path, 'source garment origin');
    if (!record.source.path.startsWith(`${record.group}/`) || !record.source.path.endsWith('.glb')
      || ![record.source.sha256, record.fittedSHA256, record.sha256, record.materialGraphSHA256].every(hashString)
      || record.license !== 'CC-BY-4.0') fail('invalid source garment provenance or license');
    keys(record.budgets, ['triangles', 'bytes'], 'source garment budgets');
    if (![record.triangles, record.bytes, record.budgets.triangles, record.budgets.bytes].every(positiveInteger)
      || record.triangles > record.budgets.triangles || record.bytes > record.budgets.bytes) fail('source garment budget exceeded');
    keys(record.fitChecks, FIT_CHECKS, 'source garment fit checks');
    if (FIT_CHECKS.some(check => record.fitChecks[check] !== true)) fail('source garment has unpassed fit checks');
    keys(record.componentLicenses, ['sourceGarment', 'referenceAvatarRigAndContext'], 'source garment component licenses');
    if (record.componentLicenses.sourceGarment !== 'CC-BY-4.0'
      || record.componentLicenses.referenceAvatarRigAndContext !== LICENSED_AVATAR_LICENSE) fail('source garment component license mismatch');
    keys(record.attribution, ['title', 'author', 'source', 'license'], 'source garment attribution');
    if (Object.values(record.attribution).some(value => typeof value !== 'string' || !value.trim() || /[\r\n]|\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/]/.test(value))
      || !record.attribution.license.startsWith('CC-BY-4.0')) fail('invalid source garment attribution');
    let url;
    try { url = new URL(record.attribution.source); } catch { fail('invalid source garment attribution URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail('invalid source garment attribution URL');
    if (!object(record.materials) || !Object.keys(record.materials).length) fail('missing source garment material profiles');
    const imageHashes = new Set();
    for (const [name, receipt] of Object.entries(record.materials)) {
      keys(receipt, ['sourceMaterialIndex', 'graphSHA256', 'requiredImages', 'requiredUVSets', 'overrides'], 'source material receipt');
      if (!name.startsWith('Original') || !Number.isSafeInteger(receipt.sourceMaterialIndex) || receipt.sourceMaterialIndex < 0
        || !hashString(receipt.graphSHA256) || !Array.isArray(receipt.requiredImages) || !Array.isArray(receipt.requiredUVSets)
        || receipt.requiredUVSets.some(index => !Number.isSafeInteger(index) || index < 0)) fail('invalid source material receipt');
      keys(receipt.overrides, ['alphaMode'], 'source material override');
      if (receipt.overrides.alphaMode !== undefined && receipt.overrides.alphaMode !== 'OPAQUE') fail('unapproved source material override');
      for (const image of receipt.requiredImages) {
        keys(image, ['textureInfo', 'sha256', 'bytes'], 'source image receipt');
        if (typeof image.textureInfo !== 'string' || !image.textureInfo.startsWith('/') || !hashString(image.sha256) || !positiveInteger(image.bytes)) fail('invalid source image receipt');
        imageHashes.add(image.sha256);
      }
    }
    const graphHashes = Object.fromEntries(Object.entries(record.materials).map(([name, value]) => [name, value.graphSHA256]));
    if (record.materialGraphSHA256 !== digest(canonical(graphHashes))) fail('source material aggregate hash mismatch');
    if (!Array.isArray(record.imageSHA256s) || canonical(record.imageSHA256s) !== canonical([...imageHashes].sort())) fail('source image aggregate mismatch');
  }
  return data.garments;
}

function verifySourceGarment(root, entry, file, document, profile) {
  if (!profile || profile.sha256 !== entry.sha256 || profile.bytes !== entry.bytes) fail(`missing or stale per-file source garment profile: ${entry.path}`);
  let recipeFile;
  try { recipeFile = JSON.parse(readFileSync(regular(root, `tooling/blender/source-garments-${profile.group}.json`), 'utf8')); }
  catch { fail('missing source garment approval recipes'); }
  const variants = recipeFile.entries?.flatMap(recipe => recipe.variants?.length
    ? recipe.variants.map(variant => ({ ...recipe, ...variant })) : [recipe]);
  const recipes = variants?.filter(recipe => recipe.id === profile.id) ?? [];
  const recipe = recipes[0], review = recipe?.review;
  if (recipeFile.schemaVersion !== 1 || recipeFile.group !== profile.group || recipes.length !== 1
    || recipe.existingOnly || recipe.publish !== true || recipe.source !== profile.source.path || recipe.mode !== profile.mode
    || review?.status !== 'passed' || review.fittedSHA256 !== profile.fittedSHA256
    || review.budgets?.triangles !== profile.budgets.triangles || review.budgets?.bytes !== profile.budgets.bytes
    || FIT_CHECKS.some(check => review.fitChecks?.[check] !== true)) fail(`source garment lacks matching fit approval: ${entry.path}`);
  const meshes = document.meshes, skins = document.skins;
  if (meshes?.length !== 1 || skins?.length !== 1 || skins[0].joints?.length !== 20) fail('source garment requires one mesh and canonical 20-joint skin');
  const boneNames = skins[0].joints.map(index => at(document.nodes, index, 'joint').name).sort();
  if (canonical(boneNames) !== canonical([...AVATAR_BONES].sort())) fail('source garment requires canonical joint names');
  let triangles = 0;
  for (const primitive of meshes[0].primitives ?? []) {
    const position = at(document.accessors, primitive.attributes?.POSITION, 'POSITION');
    const count = primitive.indices === undefined ? position.count : at(document.accessors, primitive.indices, 'indices').count;
    if ((primitive.mode ?? 4) !== 4 || !positiveInteger(count) || count % 3) fail('invalid source garment triangles');
    triangles += count / 3;
  }
  if (triangles !== profile.triangles || triangles > profile.budgets.triangles || entry.bytes > profile.budgets.bytes) fail(`source garment geometry/byte budget mismatch: ${entry.path}`);
  verifySourceGarmentMaterialReceipts(file, profile.materials);
  const credits = profile.attribution, author = credits.author.split(' (http')[0];
  const expectedCopyright = `Based on "${credits.title}" by ${author}; source garment: CC-BY-4.0.`;
  if (!document.asset?.copyright?.includes(expectedCopyright) || !document.asset.copyright.includes('RenderHub Extended Use License')) fail(`source garment copyright mismatch: ${entry.path}`);
}

function keys(value, allowed, label) {
  if (!object(value) || Object.keys(value).some(key => !allowed.includes(key))) fail(`invalid ${label} fields`);
}

function relative(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)
    || value.split('/').some(part => !part || part === '.' || part === '..')) fail(`unsafe ${label}`);
  return value;
}

// Inspect every component, including the root. A symlink must never take source
// validation or publication outside the requested tree.
function regular(root, relativePath, directory = false) {
  const absolute = path.resolve(root);
  let current = path.parse(absolute).root;
  const components = [...absolute.slice(current.length).split(path.sep).filter(Boolean), ...relativePath.split('/').filter(Boolean)];
  for (let index = 0; index < components.length; index++) {
    current = path.join(current, components[index]);
    let info;
    try { info = lstatSync(current); } catch { fail(`missing path ${relativePath || 'build directory'}`); }
    if (info.isSymbolicLink()) fail(`symlink is forbidden: ${relativePath || 'build directory'}`);
    const isDirectory = index < components.length - 1 || directory;
    if (isDirectory ? !info.isDirectory() : !info.isFile()) fail(`unexpected file type: ${relativePath || 'build directory'}`);
  }
  return current;
}

function metadata(value) {
  if (typeof value === 'string') {
    if (/(?:file|https?|ftp):\/\/|(?:\/Users\/|\/home\/|[A-Za-z]:[\\/]Users[\\/])|^(?:\/|[A-Za-z]:[\\/]|~\/)|(?:^|\s)\/(?:tmp|private|Volumes|mnt)\//i.test(value)) fail('external URI or personal filesystem path in model metadata');
  } else if (Array.isArray(value)) value.forEach(metadata);
  else if (object(value)) for (const [key, child] of Object.entries(value)) {
    if (key.toLowerCase() === 'uri') fail('model resources must be embedded; URI fields are forbidden');
    metadata(child);
  }
}

/** Parse the public GLB subset: glTF 2 JSON and one embedded BIN, with no external resources. */
export function readModelMetadata(file) {
  const bytes = readFileSync(file);
  if (bytes.length < 20 || bytes.toString('ascii', 0, 4) !== 'glTF' || bytes.readUInt32LE(4) !== 2
    || bytes.readUInt32LE(8) !== bytes.length) fail('invalid GLB header');
  let cursor = 12, document, binaryLength;
  while (cursor < bytes.length) {
    if (cursor + 8 > bytes.length) fail('truncated GLB chunk');
    const length = bytes.readUInt32LE(cursor), type = bytes.readUInt32LE(cursor + 4);
    if (length % 4 || cursor + 8 + length > bytes.length) fail('invalid GLB chunk length');
    const chunk = bytes.subarray(cursor + 8, cursor + 8 + length);
    if (cursor === 12 && type === JSON_CHUNK) {
      try { document = JSON.parse(chunk.toString('utf8')); } catch { fail('invalid GLB JSON'); }
    } else if (document && type === BIN_CHUNK && binaryLength === undefined) binaryLength = length;
    else fail('unsupported or duplicate GLB chunk');
    cursor += 8 + length;
  }
  if (!object(document) || document.asset?.version !== '2.0') fail('GLB must contain glTF 2.0 metadata');
  metadata(document);
  const buffers = document.buffers;
  if (!Array.isArray(buffers) || buffers.length !== 1 || !object(buffers[0])
    || !Number.isSafeInteger(buffers[0].byteLength) || buffers[0].byteLength < 0
    || binaryLength === undefined || binaryLength < buffers[0].byteLength || binaryLength - buffers[0].byteLength > 3) fail('GLB needs exactly one embedded buffer');
  if (document.images !== undefined && (!Array.isArray(document.images)
    || document.images.some(image => !object(image) || !Number.isSafeInteger(image.bufferView)))) fail('GLB images must use embedded buffer views');
  return document;
}

function walk(directory, visit) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name);
    if (entry.isSymbolicLink()) fail('symlink is forbidden in model source or build');
    if (entry.isDirectory()) walk(file, visit);
    else if (entry.isFile()) visit(file);
    else fail('unsupported file type in model source or build');
  }
}

function containsInlineModel(text) {
  for (const match of text.matchAll(/data:([^,\s"'`]*),([^\s"'`]*)/gi)) {
    if (/^(?:model\/|application\/(?:gltf|vnd\.fbx))/i.test(match[1])) return true;
    let bytes;
    try {
      bytes = /;base64$/i.test(match[1]) ? Buffer.from(match[2], 'base64') : Buffer.from(decodeURIComponent(match[2]));
    } catch { continue; }
    if (bytes.toString('ascii', 0, 4) === 'glTF' || bytes.toString('ascii', 0, 18) === 'Kaydara FBX Binary') return true;
    const content = bytes.toString('utf8').trimStart();
    if (content.startsWith('{')) {
      try { if (JSON.parse(content)?.asset?.version === '2.0') return true; } catch { /* Other embedded JSON is not a model. */ }
    }
  }
  return false;
}

/** Validate public sources, their license notices, exact hashes and provenance. */
export function verifyPublicModels(root = ROOT) {
  const manifestFile = regular(root, PUBLIC_MODELS_MANIFEST);
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestFile, 'utf8')); } catch { fail('invalid models.json'); }
  keys(manifest, ['schemaVersion', 'license', 'models'], 'manifest');
  if (manifest.schemaVersion !== 1 || manifest.license !== 'MIT' || !Array.isArray(manifest.models)
    || !manifest.models.length) fail('registry must declare a nonempty MIT public model set');
  const license = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/LICENSE.md`), 'utf8');
  if (license !== readFileSync(regular(root, 'LICENSE'), 'utf8') || !license.includes('MIT License')
    || !license.includes('Permission is hereby granted, free of charge') || !license.includes('THE SOFTWARE IS PROVIDED "AS IS"')) fail('missing or modified MIT license text');
  const profiles = readSourceGarmentProfiles(root), byProfile = new Map(profiles.map(profile => [profile.path, profile]));
  const seen = new Set(), hashes = new Set(), derived = [], outfits = [], originals = [], sourceGarments = [];
  for (const entry of manifest.models) {
    keys(entry, ['path', 'sha256', 'bytes', 'license', 'provenance'], 'model');
    relative(entry.path, 'model path');
    if (!entry.path.endsWith('.glb') || seen.has(entry.path)) fail(`unsupported or duplicate model path: ${entry.path}`);
    seen.add(entry.path);
    const originalGarment = entry.license === 'CC-BY-4.0' && ORIGINAL_GARMENT_EXPORTERS[entry.provenance?.exporter]?.test(entry.path);
    const sourceGarment = entry.license === 'CC-BY-4.0' && entry.provenance?.exporter === SOURCE_GARMENT_EXPORTER && byProfile.has(entry.path);
    if (entry.provenance?.exporter === SOURCE_GARMENT_EXPORTER && !sourceGarment) fail(`source garment requires an approved per-file profile: ${entry.path}`);
    const derivedOutfit = DERIVED_VEHICLE_LICENSES.includes(entry.license) && DERIVED_OUTFIT_PATH.test(entry.path)
      && entry.provenance?.exporter === DERIVED_OUTFIT_EXPORTER;
    const derivedVehicle = DERIVED_VEHICLE_LICENSES.includes(entry.license) && DERIVED_VEHICLE_PATH.test(entry.path);
    const licensedAvatar = entry.license === LICENSED_AVATAR_LICENSE && !derivedVehicle && !derivedOutfit && !originalGarment && !sourceGarment;
    if ((!licensedAvatar && !derivedVehicle && !derivedOutfit && !originalGarment && !sourceGarment && entry.license !== 'MIT') || (licensedAvatar && !entry.path.startsWith('avatars/'))
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) fail(`invalid model declaration: ${entry.path}`);
    if (hashes.has(entry.sha256)) fail(`duplicate model content: ${entry.path}`);
    hashes.add(entry.sha256);
    keys(entry.provenance, ['kind', 'generator', 'exporter', 'note'], 'provenance');
    const provenance = entry.provenance;
    if (licensedAvatar) {
      const outfitPath = LICENSED_OUTFIT_EXPORTERS[provenance.exporter];
      if (provenance.kind !== 'licensed-avatar-export' || provenance.generator !== undefined
        || (provenance.exporter !== LICENSED_AVATAR_EXPORTER && !outfitPath?.test(entry.path))) fail(`invalid licensed avatar provenance: ${entry.path}`);
    } else if (sourceGarment) {
      if (provenance.kind !== 'third-party-derived' || provenance.generator !== undefined) fail(`invalid source garment provenance: ${entry.path}`);
      sourceGarments.push(entry);
    } else if (originalGarment) {
      if (provenance.kind !== 'third-party-derived' || provenance.generator !== undefined) fail(`invalid original garment provenance: ${entry.path}`);
      originals.push(entry);
    } else if (derivedOutfit) {
      if (provenance.kind !== 'third-party-derived' || provenance.generator !== undefined) fail(`invalid third-party outfit provenance: ${entry.path}`);
      outfits.push(entry);
    } else if (derivedVehicle) {
      if (provenance.kind !== 'third-party-derived' || provenance.exporter !== DERIVED_VEHICLE_EXPORTER
        || provenance.generator !== undefined) fail(`invalid third-party vehicle provenance: ${entry.path}`);
      derived.push(entry);
    } else if (!['project-authored-export', 'project-generated'].includes(provenance.kind)
      || (provenance.kind === 'project-generated' ? !provenance.generator : !provenance.exporter)) fail(`missing project provenance: ${entry.path}`);
    for (const key of ['generator', 'exporter']) if (provenance[key] !== undefined) {
      relative(provenance[key], 'provenance script');
      if (!/\.(py|mjs|js|ts)$/.test(provenance[key])) fail('provenance must reference a project script');
      regular(root, provenance[key]);
    }
    if (provenance.note !== undefined && (typeof provenance.note !== 'string' || provenance.note.length > 2000)) fail('invalid provenance note');
    metadata(provenance);
    const file = regular(root, `${PUBLIC_MODEL_DIRECTORY}/${entry.path}`);
    const bytes = readFileSync(file);
    if (bytes.length !== entry.bytes || digest(bytes) !== entry.sha256) fail(`source hash or size mismatch: ${entry.path}`);
    const document = readModelMetadata(file);
    if (sourceGarment) verifySourceGarment(root, entry, file, document, byProfile.get(entry.path));
  }
  const source = path.join(root, PUBLIC_MODEL_DIRECTORY);
  walk(source, file => {
    const name = path.relative(source, file).split(path.sep).join('/');
    const bytes = readFileSync(file);
    if ((MODEL.test(file) || bytes.toString('ascii', 0, 4) === 'glTF'
      || bytes.toString('ascii', 0, 18) === 'Kaydara FBX Binary') && !seen.has(name)) fail(`unregistered source model: ${name}`);
  });
  if (profiles.some(profile => !sourceGarments.some(entry => entry.path === profile.path))) fail('source garment profile does not match a published model');
  if (sourceGarments.length) {
    const text = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${VEHICLE_NOTICE}`), 'utf8');
    const section = text.split(/^## Reviewed source avatar garments\s*$/m)[1]?.split(/^## /m)[0];
    if (!section || !/https?:\/\/creativecommons\.org\/licenses\/by\/4\.0/.test(section)
      || !section.includes('RenderHub Extended Use License') || !AVATAR_LICENSE_TERMS.test(section)) fail('source garments need source and component license terms');
    for (const entry of sourceGarments) {
      const credit = byProfile.get(entry.path).attribution;
      const exact = `- \`${entry.path}\` (CC-BY-4.0): "${credit.title}" by ${credit.author}; ${credit.source}. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.`;
      if (!section.split('\n').includes(exact)) fail(`source garment attribution mismatch: ${entry.path}`);
    }
  }
  if (originals.length) {
    const notices = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${VEHICLE_NOTICE}`), 'utf8');
    const section = notices.split(/^## Original avatar garments\s*$/m)[1]?.split(/^## /m)[0];
    if (!section || !/https?:\/\/creativecommons\.org\/licenses\/by\/4\.0/.test(section)) fail('original garments need CC-BY source notices');
    for (const entry of originals) {
      const line = section.split('\n').find(text => text.includes(`\`${entry.path}\``)) ?? '';
      if (!line.includes('CC-BY-4.0') || !line.includes('https://sketchfab.com/')) fail(`missing original garment notice: ${entry.path}`);
    }
  }
  if (outfits.length) {
    const notices = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${VEHICLE_NOTICE}`), 'utf8');
    const section = notices.split(/^## Avatar outfits\s*$/m)[1]?.split(/^## /m)[0];
    if (!section) fail('third-party outfits need an "Avatar outfits" notice section');
    for (const entry of outfits) {
      const terms = VEHICLE_LICENSE_TERMS[entry.license];
      const line = section.split('\n').find(text => text.includes(`\`${entry.path}\``)) ?? '';
      if (!line.includes(entry.license) || terms.section.some(pattern => !pattern.test(section))
        || (terms.line && !terms.line.test(line))) fail(`missing third-party outfit notice: ${entry.path}`);
    }
  }
  if (derived.length) {
    const notices = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${VEHICLE_NOTICE}`), 'utf8');
    const section = notices.split(/^## Campus vehicles\s*$/m)[1]?.split(/^## /m)[0];
    if (!section) fail('third-party vehicles need a "Campus vehicles" notice section');
    for (const entry of derived) {
      const terms = VEHICLE_LICENSE_TERMS[entry.license];
      const line = section.split('\n').find(text => text.includes(`\`${entry.path}\``)) ?? '';
      if (!line.includes(entry.license) || terms.section.some(pattern => !pattern.test(section))
        || (terms.line && !terms.line.test(line))) fail(`missing third-party vehicle notice: ${entry.path}`);
    }
  }
  if (manifest.models.some(entry => entry.path.startsWith('avatars/'))) {
    const avatarLicense = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${AVATAR_NOTICES[0]}`), 'utf8');
    const notices = readFileSync(regular(root, `${PUBLIC_MODEL_DIRECTORY}/${AVATAR_NOTICES[1]}`), 'utf8');
    for (const [name, text] of [[AVATAR_NOTICES[0], avatarLicense], [AVATAR_NOTICES[1], notices]]) {
      if (!text.includes('Extended Use License') || !/RenderHub/i.test(text) || !AVATAR_LICENSE_TERMS.test(text)
        || /^\s*(?:#+\s*)?MIT License\s*$/m.test(text)
        || /Permission is hereby granted, free of charge/.test(text)) fail(`avatar notice must identify the RenderHub Extended Use License and its terms: ${name}`);
    }
  }
  return manifest.models;
}

/** Validate published models by content, allowing Vite's hashed filenames. */
export function verifyModelBuild(directory, { requireAll = true, root = ROOT } = {}) {
  const entries = verifyPublicModels(root);
  const byHash = new Map(entries.map(entry => [entry.sha256, entry]));
  const present = new Set(), models = [];
  const avatars = entries.some(entry => entry.path.startsWith('avatars/'));
  const vehicles = entries.some(entry => DERIVED_VEHICLE_LICENSES.includes(entry.license) && DERIVED_VEHICLE_PATH.test(entry.path));
  const kind = avatars ? 'avatar' : 'third-party';
  const notices = new Map([...(avatars ? AVATAR_NOTICES : []), ...(vehicles ? [VEHICLE_NOTICE] : [])]
    .map(name => [name, readFileSync(path.join(root, PUBLIC_MODEL_DIRECTORY, name), 'utf8')]));
  const publishedNotices = new Set();
  const sourceProfilesFile = path.join(root, PUBLIC_SOURCE_GARMENTS);
  const sourceProfiles = existsSync(sourceProfilesFile) ? readFileSync(sourceProfilesFile, 'utf8') : undefined;
  let hasManifest = false, hasLicense = false, hasSourceProfiles = false;
  regular(directory, '', true);
  walk(path.resolve(directory), file => {
    const name = path.basename(file), bytes = readFileSync(file);
    const isGlb = bytes.toString('ascii', 0, 4) === 'glTF';
    const isFbx = bytes.toString('ascii', 0, 18) === 'Kaydara FBX Binary';
    if (MODEL.test(name) || isGlb || isFbx) {
      const registered = byHash.get(digest(bytes));
      if (!registered || !/\.glb$/i.test(name) || bytes.length !== registered.bytes) fail(`unregistered or modified model in build: ${path.relative(directory, file)}`);
      readModelMetadata(file);
      present.add(registered.path); models.push(file);
    } else if (/\.(?:[cm]?js|html|css|json|map|txt|md)$/i.test(name)) {
      const text = bytes.toString('utf8');
      if (containsInlineModel(text)) fail(`inlined model in build: ${path.relative(directory, file)}`);
      if (name === 'models.json') {
        let manifest;
        try { manifest = JSON.parse(text); } catch { fail('invalid published models.json'); }
        if (JSON.stringify(manifest) !== JSON.stringify(JSON.parse(readFileSync(path.join(root, PUBLIC_MODELS_MANIFEST), 'utf8')))) fail('published model manifest differs from source');
        hasManifest = true;
      }
      if (name === 'source-garments.json') {
        if (sourceProfiles === undefined || text !== sourceProfiles) fail('published source garment profiles differ from source');
        hasSourceProfiles = true;
      }
      if (name === 'OFFICE_ASSETS_LICENSE.md') {
        if (text !== readFileSync(path.join(root, PUBLIC_MODEL_DIRECTORY, 'LICENSE.md'), 'utf8')) fail('published MIT model license differs from source');
        hasLicense = true;
      }
      if (notices.has(name)) {
        if (text !== notices.get(name)) fail(`published ${kind} notice differs from source: ${name}`);
        publishedNotices.add(name);
      }
    }
  });
  if (requireAll) {
    const missing = entries.filter(entry => !present.has(entry.path));
    if (missing.length) fail(`build is missing public models: ${missing.map(entry => entry.path).join(', ')}`);
    if (!hasManifest || !hasLicense) fail('build must include models.json and OFFICE_ASSETS_LICENSE.md');
    if (sourceProfiles !== undefined && !hasSourceProfiles) fail('build must include exact source-garments.json');
    const missingNotices = [...notices.keys()].filter(name => !publishedNotices.has(name));
    if (missingNotices.length) fail(`build is missing ${kind} notices: ${missingNotices.join(', ')}`);
  }
  return models;
}
