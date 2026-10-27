import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_MODEL_DIRECTORY, PUBLIC_MODELS_MANIFEST, verifyModelBuild, verifyPublicModels } from '../public-models.mjs';
import type { PublicModel } from '../public-models.mjs';

const temporary: string[] = [];
const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
const licensedAvatar = 'LicenseRef-RenderHub-Extended-Use';
const avatarLicense = 'RenderHub Extended Use License\nTerms: https://www.renderhub.com/info/3d-content-licensing\nAvatar content remains subject to its original license.\n';
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

function glb(extra: Record<string, unknown> = {}) {
  const json = Buffer.from(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: 4 }], ...extra }));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(12 + 8 + length + 8 + 4, 0);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + length); json.copy(bytes, 20);
  bytes.writeUInt32LE(4, 20 + length); bytes.writeUInt32LE(0x004e4942, 24 + length);
  return bytes;
}

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'extalia-public-models-')));
  temporary.push(root);
  const source = path.join(root, PUBLIC_MODEL_DIRECTORY), dist = path.join(root, 'dist');
  mkdirSync(path.join(source, 'building'), { recursive: true });
  mkdirSync(path.join(root, 'tooling')); mkdirSync(dist);
  writeFileSync(path.join(root, 'LICENSE'), license);
  writeFileSync(path.join(source, 'LICENSE.md'), license);
  writeFileSync(path.join(root, 'tooling', 'generate.py'), '# Synthetic project geometry fixture.\n');
  const manifest: { schemaVersion: number; license: string; models: PublicModel[] } = { schemaVersion: 1, license: 'MIT', models: [] };
  function add(name: string, bytes = glb({ extras: { name } })) {
    mkdirSync(path.dirname(path.join(source, name)), { recursive: true });
    writeFileSync(path.join(source, name), bytes);
    const entry: PublicModel = { path: name, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex'), license: 'MIT', provenance: { kind: 'project-generated', generator: 'tooling/generate.py' } };
    manifest.models.push(entry);
    return entry;
  }
  function save() { writeFileSync(path.join(root, PUBLIC_MODELS_MANIFEST), JSON.stringify(manifest)); }
  function build() {
    for (const [index, entry] of manifest.models.entries()) copyFileSync(path.join(source, entry.path), path.join(dist, `asset-${index}-vitehash.glb`));
    copyFileSync(path.join(root, PUBLIC_MODELS_MANIFEST), path.join(dist, 'models.json'));
    copyFileSync(path.join(source, 'LICENSE.md'), path.join(dist, 'OFFICE_ASSETS_LICENSE.md'));
    if (manifest.models.some(entry => entry.path.startsWith('avatars/'))) {
      for (const name of ['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md']) copyFileSync(path.join(source, name), path.join(dist, name));
    }
  }
  add('building/shell.glb'); add('building/lift.glb'); save();
  return { root, source, dist, manifest, add, save, build };
}

function avatarFixture() {
  const test = fixture(), entry = test.add('avatars/body.glb');
  entry.license = licensedAvatar;
  entry.provenance = { kind: 'licensed-avatar-export', exporter: 'tooling/prepare-licensed-avatars.py' };
  writeFileSync(path.join(test.root, entry.provenance.exporter!), '# Synthetic licensed model export fixture.\n');
  test.save();
  writeFileSync(path.join(test.source, 'AVATAR_SOURCE_LICENSE.md'), avatarLicense);
  writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), avatarLicense);
  return test;
}

describe('licensed public model registry', () => {
  it('validates every actual registered public asset and its provenance', () => {
    const models = verifyPublicModels();
    const manifest = JSON.parse(readFileSync(new URL('../../apps/web/public-assets/models.json', import.meta.url), 'utf8'));
    expect(models).toEqual(manifest.models);
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map(model => model.path)).size).toBe(models.length);
    expect(models.every(model => model.path.startsWith('avatars/') ? model.license === licensedAvatar : model.license === 'MIT')).toBe(true);
  });

  it('accepts a self-contained registry and Vite hashed publication names', () => {
    const test = fixture(); test.build();
    expect(verifyPublicModels(test.root)).toEqual(test.manifest.models);
    expect(verifyModelBuild(test.dist, { root: test.root })).toHaveLength(2);
  });

  it.each(['../outside.glb', '/absolute.glb', 'building/../shell.glb', 'building\\shell.glb', 'building//shell.glb'])(
    'rejects unsafe registry path %s', name => {
      const test = fixture(); test.manifest.models[0]!.path = name; test.save();
      expect(() => verifyPublicModels(test.root)).toThrow(/unsafe model path/);
    });

  it('rejects duplicate declarations, empty registries and unsupported licenses', () => {
    const test = fixture();
    test.manifest.models.push(test.manifest.models[0]!); test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/duplicate/);
    test.manifest.models = []; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/nonempty/);
    test.manifest.license = 'unknown'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/MIT/);
  });

  it('rejects source byte tampering, even when the size remains unchanged', () => {
    const test = fixture(), file = path.join(test.source, test.manifest.models[0]!.path);
    const bytes = readFileSync(file); bytes[bytes.length - 1] = 1; writeFileSync(file, bytes);
    expect(() => verifyPublicModels(test.root)).toThrow(/source hash or size mismatch/);
  });

  it('rejects the same model registered under multiple names', () => {
    const test = fixture(); test.manifest.models = [];
    test.add('building/first.glb', glb()); test.add('building/second.glb', glb()); test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/duplicate model content/);
  });

  it('requires all source models to be registered and all provenance scripts to exist', () => {
    const test = fixture(); writeFileSync(path.join(test.source, 'private.glb'), glb());
    expect(() => verifyPublicModels(test.root)).toThrow(/unregistered source model/);
    rmSync(path.join(test.source, 'private.glb'));
    rmSync(path.join(test.root, 'tooling', 'generate.py'));
    expect(() => verifyPublicModels(test.root)).toThrow(/missing path/);
  });

  it('rejects symlinked source files, source directories and build contents', () => {
    const test = fixture(), model = path.join(test.source, test.manifest.models[0]!.path);
    const target = path.join(test.root, 'model.glb'); copyFileSync(model, target);
    // Windows file symlinks require elevated privileges; directory junctions do
    // not, and still exercise source and publication escape protection in CI.
    if (process.platform !== 'win32') {
      rmSync(model); symlinkSync(target, model);
      expect(() => verifyPublicModels(test.root)).toThrow(/symlink/);
      rmSync(model); copyFileSync(target, model);
    }
    test.build();
    symlinkSync(test.source, path.join(test.dist, 'linked'), 'junction');
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/symlink/);
    rmSync(path.join(test.dist, 'linked'));
    const directory = path.join(test.source, 'building'), moved = path.join(test.root, 'moved');
    mkdirSync(moved); for (const entry of test.manifest.models) copyFileSync(path.join(test.source, entry.path), path.join(moved, path.basename(entry.path)));
    rmSync(directory, { recursive: true }); symlinkSync(moved, directory, 'junction');
    expect(() => verifyPublicModels(test.root)).toThrow(/symlink/);
  });

  it.each([
    { buffers: [{ byteLength: 4, uri: 'outside.bin' }] },
    { images: [{ uri: 'data:image/png;base64,AA==' }] },
    { extras: { source: ['','Users','example','scene.blend'].join('/') } },
    { extras: { source: 'file:///scene.blend' } },
    { buffers: [{ byteLength: 1000 }] },
  ])('rejects external resources and unsafe embedded metadata: %j', extra => {
    const test = fixture(); test.manifest.models = []; test.add('building/unsafe.glb', glb(extra)); test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/URI|filesystem|embedded/);
  });

  it('rejects malformed GLB headers even if their registered hashes match', () => {
    const test = fixture(); test.manifest.models = [];
    const bytes = glb(); bytes.writeUInt32LE(bytes.length + 1, 8);
    test.add('building/broken.glb', bytes); test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/GLB header/);
  });

  it.each(['glb', 'gltf', 'fbx', 'bin'])('rejects private build models with .%s extensions', extension => {
    const test = fixture(); test.build();
    const nested = path.join(test.dist, 'renderer', 'assets'); mkdirSync(nested, { recursive: true });
    writeFileSync(path.join(nested, `private.${extension}`), glb({ extras: { private: true } }));
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/unregistered or modified/);
  });

  it('rejects build tampering, missing models and a missing publication directory', () => {
    const test = fixture(); test.build();
    const model = path.join(test.dist, 'asset-0-vitehash.glb');
    const bytes = readFileSync(model); bytes[bytes.length - 1] = 1; writeFileSync(model, bytes);
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/unregistered or modified/);
    rmSync(model);
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/missing public models/);
    expect(verifyModelBuild(test.dist, { root: test.root, requireAll: false })).toHaveLength(1);
    expect(() => verifyModelBuild(path.join(test.root, 'missing'), { root: test.root })).toThrow(/missing path/);
  });

  it('requires an exact published registry and MIT license', () => {
    const test = fixture(); test.build();
    writeFileSync(path.join(test.dist, 'models.json'), JSON.stringify({ ...test.manifest, models: [] }));
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/manifest differs/);
    test.build(); writeFileSync(path.join(test.dist, 'OFFICE_ASSETS_LICENSE.md'), 'MIT');
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/license differs/);
    test.build(); rmSync(path.join(test.dist, 'models.json'));
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/must include/);
    writeFileSync(path.join(test.source, 'LICENSE.md'), 'MIT');
    expect(() => verifyPublicModels(test.root)).toThrow(/MIT license text/);
  });

  it('validates avatar source notices and publishes both unchanged', () => {
    const test = avatarFixture(); test.build();
    expect(verifyPublicModels(test.root)).toHaveLength(3);
    expect(verifyModelBuild(test.dist, { root: test.root })).toHaveLength(3);
  });

  it.each(['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md'])(
    'rejects missing and tampered avatar source notice %s', name => {
      const test = avatarFixture(), notice = path.join(test.source, name);
      rmSync(notice);
      expect(() => verifyPublicModels(test.root)).toThrow(/missing path/);
      writeFileSync(notice, 'Unknown asset terms');
      expect(() => verifyPublicModels(test.root)).toThrow(/RenderHub Extended Use License/);
    });

  it('restricts the avatar license to avatar paths and its approved export provenance', () => {
    const test = avatarFixture(), entry = test.manifest.models.at(-1)!;
    test.manifest.models[0]!.license = licensedAvatar; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/invalid model declaration/);
    test.manifest.models[0]!.license = 'MIT';
    entry.provenance.kind = 'project-generated'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/licensed avatar provenance/);
    entry.provenance.kind = 'licensed-avatar-export'; entry.provenance.exporter = 'tooling/generate.py'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/licensed avatar provenance/);
    entry.provenance.exporter = 'tooling/prepare-licensed-avatars.py'; entry.license = 'MIT'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/project provenance/);
  });

  it('rejects notices that present the licensed avatars under MIT terms', () => {
    const test = avatarFixture();
    writeFileSync(path.join(test.source, 'AVATAR_SOURCE_LICENSE.md'), `${avatarLicense}\n${license}`);
    expect(() => verifyPublicModels(test.root)).toThrow(/avatar notice must identify/);
  });

  it.each(['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md'])(
    'rejects missing and tampered published avatar notice %s', name => {
      const test = avatarFixture(); test.build();
      const notice = path.join(test.dist, name), text = readFileSync(notice, 'utf8'); rmSync(notice);
      expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/missing avatar notices/);
      writeFileSync(notice, `${text}\nmodified`);
      expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/published avatar notice differs/);
    });

  it.each([
    'data:model/gltf-binary;base64,AAAA',
    `data:application/octet-stream;base64,${glb().toString('base64')}`,
    `data:application/octet-stream;base64,${Buffer.from(JSON.stringify({ asset: { version: '2.0' } })).toString('base64')}`,
  ])(
    'rejects models inlined into JavaScript: %s', uri => {
      const test = fixture(); test.build(); writeFileSync(path.join(test.dist, 'index.js'), `export default ${JSON.stringify(uri)};`);
      expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/inlined model/);
    });
});
