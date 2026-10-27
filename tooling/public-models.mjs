import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ROOT } from './workspace.mjs';

export const PUBLIC_MODEL_DIRECTORY = 'apps/web/public-assets';
export const PUBLIC_MODELS_MANIFEST = `${PUBLIC_MODEL_DIRECTORY}/models.json`;
const AVATAR_NOTICES = ['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md'];
const LICENSED_AVATAR_LICENSE = 'LicenseRef-RenderHub-Extended-Use';
const LICENSED_AVATAR_EXPORTER = 'tooling/prepare-licensed-avatars.py';
const AVATAR_LICENSE_TERMS = /https:\/\/(?:www\.)?renderhub\.com\/info\/3d-content-licensing(?:[\s)#/?]|$)/;
const MODEL = /\.(glb|gltf|fbx)$/i;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const fail = message => { throw new Error(`Public models: ${message}`); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

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
  const seen = new Set(), hashes = new Set();
  for (const entry of manifest.models) {
    keys(entry, ['path', 'sha256', 'bytes', 'license', 'provenance'], 'model');
    relative(entry.path, 'model path');
    if (!entry.path.endsWith('.glb') || seen.has(entry.path)) fail(`unsupported or duplicate model path: ${entry.path}`);
    seen.add(entry.path);
    const licensedAvatar = entry.license === LICENSED_AVATAR_LICENSE;
    if ((!licensedAvatar && entry.license !== 'MIT') || (licensedAvatar && !entry.path.startsWith('avatars/'))
      || typeof entry.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(entry.sha256)
      || !Number.isSafeInteger(entry.bytes) || entry.bytes <= 0) fail(`invalid model declaration: ${entry.path}`);
    if (hashes.has(entry.sha256)) fail(`duplicate model content: ${entry.path}`);
    hashes.add(entry.sha256);
    keys(entry.provenance, ['kind', 'generator', 'exporter', 'note'], 'provenance');
    const provenance = entry.provenance;
    if (licensedAvatar) {
      if (provenance.kind !== 'licensed-avatar-export' || provenance.exporter !== LICENSED_AVATAR_EXPORTER
        || provenance.generator !== undefined) fail(`invalid licensed avatar provenance: ${entry.path}`);
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
    readModelMetadata(file);
  }
  const source = path.join(root, PUBLIC_MODEL_DIRECTORY);
  walk(source, file => {
    const name = path.relative(source, file).split(path.sep).join('/');
    const bytes = readFileSync(file);
    if ((MODEL.test(file) || bytes.toString('ascii', 0, 4) === 'glTF'
      || bytes.toString('ascii', 0, 18) === 'Kaydara FBX Binary') && !seen.has(name)) fail(`unregistered source model: ${name}`);
  });
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
  const notices = new Map(entries.some(entry => entry.path.startsWith('avatars/'))
    ? AVATAR_NOTICES.map(name => [name, readFileSync(path.join(root, PUBLIC_MODEL_DIRECTORY, name), 'utf8')]) : []);
  const publishedNotices = new Set();
  let hasManifest = false, hasLicense = false;
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
      if (name === 'OFFICE_ASSETS_LICENSE.md') {
        if (text !== readFileSync(path.join(root, PUBLIC_MODEL_DIRECTORY, 'LICENSE.md'), 'utf8')) fail('published MIT model license differs from source');
        hasLicense = true;
      }
      if (notices.has(name)) {
        if (text !== notices.get(name)) fail(`published avatar notice differs from source: ${name}`);
        publishedNotices.add(name);
      }
    }
  });
  if (requireAll) {
    const missing = entries.filter(entry => !present.has(entry.path));
    if (missing.length) fail(`build is missing public models: ${missing.map(entry => entry.path).join(', ')}`);
    if (!hasManifest || !hasLicense) fail('build must include models.json and OFFICE_ASSETS_LICENSE.md');
    const missingNotices = [...notices.keys()].filter(name => !publishedNotices.has(name));
    if (missingNotices.length) fail(`build is missing avatar notices: ${missingNotices.join(', ')}`);
  }
  return models;
}
