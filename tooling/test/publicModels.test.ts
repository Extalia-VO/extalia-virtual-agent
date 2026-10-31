import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PUBLIC_MODEL_DIRECTORY, PUBLIC_MODELS_MANIFEST, PUBLIC_SOURCE_GARMENTS, readSourceGarmentProfiles, verifyModelBuild, verifyPublicModels, verifySourceGarmentMaterialReceipts } from '../public-models.mjs';
import type { PublicModel, SourceGarmentProfile } from '../public-models.mjs';

const temporary: string[] = [];
const license = readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8');
const licensedAvatar = 'LicenseRef-RenderHub-Extended-Use';
const vehicleLicenses: string[] = ['CC-BY-4.0', 'LicenseRef-RenderHub-Extended-Use', 'CC-BY-NC-4.0', 'CC-BY-NC-SA-4.0',
  'LicenseRef-Sketchfab-Standard', 'LicenseRef-Owner-Provided-Unverified'];
const vehicleNotice = (paths: string[]) => `${avatarLicense}\n## Campus vehicles\n\nCC-BY-4.0 https://creativecommons.org/licenses/by/4.0/\n`
  + 'RenderHub free download, Extended Use License. Terms: https://www.renderhub.com/info/3d-content-licensing\n'
  + 'CC-BY-NC-4.0 http://creativecommons.org/licenses/by-nc/4.0/ CC-BY-NC-SA-4.0 http://creativecommons.org/licenses/by-nc-sa/4.0/\n'
  + 'Sketchfab Standard licence https://sketchfab.com/licenses\n'
  + paths.map(item => `- \`${item}\` (${vehicleLicenses.join(', ')}): non-commercial use only; author and licence pending owner confirmation.\n`).join('');
const avatarLicense = 'RenderHub Extended Use License\nTerms: https://www.renderhub.com/info/3d-content-licensing\nAvatar content remains subject to its original license.\n';
afterEach(() => { for (const root of temporary.splice(0)) rmSync(root, { recursive: true, force: true }); });

function glb(extra: Record<string, unknown> = {}, binary = Buffer.alloc(4), tokens = (value: string) => value) {
  const json = Buffer.from(tokens(JSON.stringify({ asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }], ...extra })));
  const length = Math.ceil(json.length / 4) * 4;
  const bytes = Buffer.alloc(12 + 8 + length + 8 + binary.length, 0);
  bytes.write('glTF'); bytes.writeUInt32LE(2, 4); bytes.writeUInt32LE(bytes.length, 8);
  bytes.writeUInt32LE(length, 12); bytes.writeUInt32LE(0x4e4f534a, 16);
  bytes.fill(0x20, 20, 20 + length); json.copy(bytes, 20);
  bytes.writeUInt32LE(binary.length, 20 + length); bytes.writeUInt32LE(0x004e4942, 24 + length);
  binary.copy(bytes, 28 + length);
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
    if (existsSync(path.join(root, PUBLIC_SOURCE_GARMENTS))) copyFileSync(path.join(root, PUBLIC_SOURCE_GARMENTS), path.join(dist, 'source-garments.json'));
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

function vehicleFixture(license: PublicModel['license'] = 'CC-BY-4.0') {
  const test = fixture(), entry = test.add('vehicles/sports.glb');
  entry.license = license;
  entry.provenance = { kind: 'third-party-derived', exporter: 'tooling/blender/prepare-campus-vehicles.py', note: 'Simplified reference car; credit in THIRD_PARTY_NOTICES.md.' };
  mkdirSync(path.join(test.root, 'tooling', 'blender'), { recursive: true });
  writeFileSync(path.join(test.root, entry.provenance.exporter!), '# Synthetic vehicle export fixture.\n');
  writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), vehicleNotice([entry.path]));
  test.save();
  return { ...test, entry };
}

describe('licensed public model registry', () => {
  it('validates every actual registered public asset and its provenance', () => {
    const models = verifyPublicModels();
    const manifest = JSON.parse(readFileSync(new URL('../../apps/web/public-assets/models.json', import.meta.url), 'utf8'));
    expect(models).toEqual(manifest.models);
    expect(models.length).toBeGreaterThan(0);
    expect(new Set(models.map(model => model.path)).size).toBe(models.length);
    expect(models.every(model => model.provenance.exporter?.startsWith('tooling/blender/fit-original-') || model.provenance.exporter === 'tooling/blender/fit-source-garments.py'
      ? model.license === 'CC-BY-4.0' && model.provenance.kind === 'third-party-derived'
      : /^avatars\/outfits\/(?:male|female)\/outfit-/.test(model.path)
      ? vehicleLicenses.includes(model.license) && model.provenance.kind === 'third-party-derived'
      : model.path.startsWith('avatars/') ? model.license === licensedAvatar
      : model.path.startsWith('vehicles/') ? vehicleLicenses.includes(model.license) && model.provenance.kind === 'third-party-derived'
        : model.license === 'MIT')).toBe(true);
    // One published file per campus car catalog entry.
    const catalog = JSON.parse(readFileSync(new URL('../blender/campus-vehicles.json', import.meta.url), 'utf8'));
    expect(models.filter(model => model.path.startsWith('vehicles/')).map(model => model.path).sort())
      .toEqual(catalog.vehicles.map((vehicle: { style: string }) => `vehicles/${vehicle.style}.glb`).sort());
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

  it('accepts staff uniforms from their exporter only at uniform outfit paths', () => {
    const test = avatarFixture();
    const uniform = test.add('avatars/outfits/female/reception-uniform.glb');
    uniform.license = licensedAvatar;
    uniform.provenance = { kind: 'licensed-avatar-export', exporter: 'tooling/blender/create-staff-uniforms.py' };
    mkdirSync(path.join(test.root, 'tooling', 'blender'), { recursive: true });
    writeFileSync(path.join(test.root, uniform.provenance.exporter!), '# Synthetic staff uniform export fixture.\n');
    test.save();
    expect(() => verifyPublicModels(test.root)).not.toThrow();
    const body = test.manifest.models.find(entry => entry.path === 'avatars/body.glb')!;
    body.provenance.exporter = 'tooling/blender/create-staff-uniforms.py'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/licensed avatar provenance/);
  });

  it('accepts attributed original garments only at their approved exporter paths', () => {
    const test = avatarFixture();
    const piece = test.add('avatars/wardrobe/female/outer/cloth-jacket.glb');
    piece.license = 'CC-BY-4.0';
    piece.provenance = { kind: 'third-party-derived', exporter: 'tooling/blender/fit-original-garments.py' };
    mkdirSync(path.join(test.root, 'tooling', 'blender'), { recursive: true });
    writeFileSync(path.join(test.root, piece.provenance.exporter!), '# Synthetic original garment fixture.\n');
    writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), avatarLicense +
      '\n## Original avatar garments\n\nCC-BY-4.0: https://creativecommons.org/licenses/by/4.0/\n' +
      '- `avatars/wardrobe/female/outer/cloth-jacket.glb` (CC-BY-4.0): synthetic source https://sketchfab.com/3d-models/example-cloth\n');
    test.save();
    expect(() => verifyPublicModels(test.root)).not.toThrow();
    piece.path = 'avatars/wardrobe/female/head/cloth-jacket.glb'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/invalid model declaration/);
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

  it.each(vehicleLicenses)('accepts a third-party-derived %s vehicle with its exporter and notice, and publishes the notice', license => {
    const test = vehicleFixture(license as PublicModel['license']);
    expect(verifyPublicModels(test.root)).toHaveLength(3);
    test.build();
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/missing third-party notices/);
    copyFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), path.join(test.dist, 'THIRD_PARTY_NOTICES.md'));
    expect(verifyModelBuild(test.dist, { root: test.root })).toHaveLength(3);
    writeFileSync(path.join(test.dist, 'THIRD_PARTY_NOTICES.md'), 'changed');
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/published third-party notice differs/);
  });

  it('requires a matching Campus vehicles notice entry and CC-BY terms', () => {
    const test = vehicleFixture(), notice = path.join(test.source, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(notice, avatarLicense);
    expect(() => verifyPublicModels(test.root)).toThrow(/Campus vehicles/);
    writeFileSync(notice, vehicleNotice(['vehicles/other.glb']));
    expect(() => verifyPublicModels(test.root)).toThrow(/missing third-party vehicle notice/);
    writeFileSync(notice, vehicleNotice([test.entry.path]).replace('https://creativecommons.org/licenses/by/4.0/', ''));
    expect(() => verifyPublicModels(test.root)).toThrow(/missing third-party vehicle notice/);
    test.entry.license = 'LicenseRef-RenderHub-Extended-Use'; test.save();
    writeFileSync(notice, vehicleNotice([test.entry.path]).replaceAll('https://www.renderhub.com/info/3d-content-licensing', ''));
    expect(() => verifyPublicModels(test.root)).toThrow(/missing third-party vehicle notice/);
    writeFileSync(notice, vehicleNotice([test.entry.path]));
    expect(verifyPublicModels(test.root)).toHaveLength(3);
    rmSync(notice);
    expect(() => verifyPublicModels(test.root)).toThrow(/missing path/);
  });

  it('requires "non-commercial use only" on NC entries and a pending-confirmation note on unverified ones', () => {
    for (const [license, phrase] of [['CC-BY-NC-4.0', 'non-commercial use only'], ['CC-BY-NC-SA-4.0', 'non-commercial use only'],
      ['LicenseRef-Owner-Provided-Unverified', 'pending owner confirmation']] as const) {
      const test = vehicleFixture(license), notice = path.join(test.source, 'THIRD_PARTY_NOTICES.md');
      expect(verifyPublicModels(test.root)).toHaveLength(3);
      writeFileSync(notice, vehicleNotice([test.entry.path]).replace(phrase, 'see notes'));
      expect(() => verifyPublicModels(test.root)).toThrow(/missing third-party vehicle notice/);
    }
    const test = vehicleFixture('CC-BY-NC-SA-4.0'), notice = path.join(test.source, 'THIRD_PARTY_NOTICES.md');
    writeFileSync(notice, vehicleNotice([test.entry.path]).replace('http://creativecommons.org/licenses/by-nc-sa/4.0/', ''));
    expect(() => verifyPublicModels(test.root)).toThrow(/missing third-party vehicle notice/);
  });

  it('restricts vehicle licenses to vehicles/ with third-party-derived provenance from the vehicle exporter', () => {
    const test = vehicleFixture();
    test.entry.provenance.exporter = 'tooling/generate.py'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/third-party vehicle provenance/);
    test.entry.provenance.exporter = 'tooling/blender/prepare-campus-vehicles.py';
    test.entry.provenance.kind = 'project-generated'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/third-party vehicle provenance/);
    test.entry.provenance.kind = 'third-party-derived'; test.entry.provenance.generator = 'tooling/generate.py'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/third-party vehicle provenance/);
    delete test.entry.provenance.generator;
    test.entry.license = 'MIT'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/project provenance/);
    test.entry.license = 'CC-BY-4.0'; test.manifest.models[0]!.license = 'CC-BY-4.0'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/invalid model declaration/);
    test.manifest.models[0]!.license = 'LicenseRef-Anything' as PublicModel['license']; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/invalid model declaration/);
    test.manifest.models[0]!.license = 'MIT';
    test.entry.license = 'LicenseRef-RenderHub-Extended-Use';
    test.entry.provenance = { kind: 'licensed-avatar-export', exporter: 'tooling/prepare-licensed-avatars.py' }; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/third-party vehicle provenance/);
  });

  it.each([
    'Downloaded from https://example.com/car',
    ['', 'Users', 'example', 'cars', 'car.zip'].join('/'),
  ])('still rejects URLs and personal paths in vehicle provenance: %s', note => {
    const test = vehicleFixture();
    test.entry.provenance.note = note; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/external URI or personal filesystem path/);
  });
});

const sourceExporter = 'tooling/blender/fit-source-garments.py';
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
const canonicalJson = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
};

function sourceGarmentFixture(textured = false) {
  const test = avatarFixture();
  const bones = ['root', 'hips', 'spine', 'chest', 'neck', 'head', 'leftShoulder', 'leftUpperArm',
    'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
    'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot'];
  const image = Buffer.from('image123'), imageHash = sha(image);
  const material = { name: 'OriginalTop_Fabric', pbrMetallicRoughness: {
    baseColorFactor: [0.25, 0.5, 0.75, 1], roughnessFactor: 1,
    ...(textured ? { baseColorTexture: { index: 0, texCoord: 0 } } : {}),
  } };
  const tokens = (text: string) => text.replace('"roughnessFactor":1', '"roughnessFactor":1.0');
  function candidate(options: { missingUV?: boolean; roughness?: number; image?: Buffer } = {}) {
    const binary = Buffer.alloc(68); (options.image ?? image).copy(binary, 60);
    return glb({ asset: { version: '2.0', copyright: 'Based on "Example shirt" by Example author; source garment: CC-BY-4.0. Reference avatar rig and context retain the RenderHub Extended Use License.' },
      nodes: bones.map(name => ({ name })), skins: [{ joints: bones.map((_name, index) => index) }],
      meshes: [{ primitives: [{ attributes: { POSITION: 0, ...(textured && !options.missingUV ? { TEXCOORD_0: 1 } : {}) }, material: 0 }] }],
      accessors: [{ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' }, { bufferView: 1, componentType: 5126, count: 3, type: 'VEC2' }],
      bufferViews: [{ buffer: 0, byteOffset: 0, byteLength: 36 }, { buffer: 0, byteOffset: 36, byteLength: 24 }, { buffer: 0, byteOffset: 60, byteLength: 8 }],
      materials: [{ ...material, pbrMetallicRoughness: { ...material.pbrMetallicRoughness, roughnessFactor: options.roughness ?? 1 } }],
      ...(textured ? { images: [{ bufferView: 2, mimeType: 'image/png' }], textures: [{ sampler: 0, source: 0 }], samplers: [{ wrapS: 10497, wrapT: 10497 }] } : {}),
    }, binary, tokens);
  }
  const entry = test.add('avatars/wardrobe/male/top/example-shirt.glb', candidate());
  entry.license = 'CC-BY-4.0'; entry.provenance = { kind: 'third-party-derived', exporter: sourceExporter };
  mkdirSync(path.join(test.root, 'tooling/blender'), { recursive: true });
  writeFileSync(path.join(test.root, sourceExporter), '# Synthetic source-preserving export fixture.\n');
  const graph = { pbrMetallicRoughness: { ...material.pbrMetallicRoughness,
    ...(textured ? { baseColorTexture: { index: { sampler: { wrapS: 10497, wrapT: 10497 }, source: { mimeType: 'image/png', payloadSHA256: imageHash } }, texCoord: 0 } } : {}),
  } };
  const graphSHA256 = sha(tokens(canonicalJson(graph)));
  const profile: SourceGarmentProfile = {
    path: entry.path, id: 'example-shirt', group: 'male', mode: 'top', source: { path: 'male/example-shirt.glb', sha256: sha('source fixture') },
    fittedSHA256: sha('fitted fixture'), sha256: entry.sha256, triangles: 1, bytes: entry.bytes,
    budgets: { triangles: 2, bytes: entry.bytes + 100 }, fitChecks: { rest: true, walk: true, sit: true, reach: true, sourceAppearance: true },
    materials: { OriginalTop_Fabric: { sourceMaterialIndex: 0, graphSHA256, requiredImages: textured ? [{ textureInfo: '/pbrMetallicRoughness/baseColorTexture', sha256: imageHash, bytes: image.length }] : [], requiredUVSets: textured ? [0] : [], overrides: {} } },
    materialGraphSHA256: sha(canonicalJson({ OriginalTop_Fabric: graphSHA256 })), imageSHA256s: textured ? [imageHash] : [], license: 'CC-BY-4.0',
    attribution: { title: 'Example shirt', author: 'Example author', source: 'https://example.com/shirt', license: 'CC-BY-4.0' },
    componentLicenses: { sourceGarment: 'CC-BY-4.0', referenceAvatarRigAndContext: licensedAvatar },
  };
  const recipe = { id: profile.id, source: profile.source.path, mode: profile.mode, publish: true,
    review: { status: 'passed', fittedSHA256: profile.fittedSHA256, budgets: profile.budgets, fitChecks: { ...profile.fitChecks } } };
  const notice = `${avatarLicense}\n## Reviewed source avatar garments\n\nCC-BY-4.0 terms: https://creativecommons.org/licenses/by/4.0/.\n${avatarLicense}\n`
    + `- \`${entry.path}\` (CC-BY-4.0): "Example shirt" by Example author; https://example.com/shirt. Modified: body fit, skeletal binding and garment separation; native UVs and material maps retained.\n`;
  writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), notice);
  function save() {
    test.save();
    writeFileSync(path.join(test.root, PUBLIC_SOURCE_GARMENTS), JSON.stringify({ schemaVersion: 1, exporter: sourceExporter, garments: [profile] }));
    writeFileSync(path.join(test.root, 'tooling/blender/source-garments-male.json'), JSON.stringify({ schemaVersion: 1, group: 'male', entries: [recipe] }));
  }
  function replace(bytes: Buffer) {
    writeFileSync(path.join(test.source, entry.path), bytes);
    profile.sha256 = entry.sha256 = sha(bytes); profile.bytes = entry.bytes = bytes.length; save();
  }
  save();
  return { ...test, entry, profile, recipe, candidate, save, replace, notice };
}

describe('reviewed source garment publication', () => {
  it.each([false, true])('accepts exact per-file receipts including native image-free materials (textures=%s)', textured => {
    const test = sourceGarmentFixture(textured); test.build();
    expect(verifyPublicModels(test.root)).toHaveLength(4);
    expect(readSourceGarmentProfiles(test.root)).toEqual([test.profile]);
    expect(verifyModelBuild(test.dist, { root: test.root })).toHaveLength(4);
    expect(() => verifySourceGarmentMaterialReceipts(path.join(test.source, test.entry.path), test.profile.materials)).not.toThrow();
  });

  it('requires matching approval hashes, fit checks, explicit budgets and public eligibility', () => {
    for (const mutate of [
      (test: ReturnType<typeof sourceGarmentFixture>) => { test.recipe.review.fittedSHA256 = sha('other candidate'); },
      (test: ReturnType<typeof sourceGarmentFixture>) => { test.recipe.review.status = 'pending'; },
      (test: ReturnType<typeof sourceGarmentFixture>) => { Object.assign(test.recipe.review.fitChecks, { reach: false }); },
      (test: ReturnType<typeof sourceGarmentFixture>) => { test.recipe.publish = false; },
      (test: ReturnType<typeof sourceGarmentFixture>) => { test.recipe.review.budgets = { ...test.recipe.review.budgets, triangles: 3 }; },
    ]) {
      const test = sourceGarmentFixture(); mutate(test); test.save();
      expect(() => verifyPublicModels(test.root)).toThrow(/matching fit approval/);
    }
    const test = sourceGarmentFixture(); test.profile.budgets.triangles = 0; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/budget exceeded/);
  });

  it('rejects changed native colors, embedded image payloads and missing required UVs after registry rehashing', () => {
    for (const options of [{ roughness: 0.5 }, { image: Buffer.from('changed!') }, { missingUV: true }]) {
      const test = sourceGarmentFixture(true); test.replace(test.candidate(options));
      expect(() => verifyPublicModels(test.root)).toThrow(/material graph\/image receipt|UV/);
    }
  });

  it('requires exact per-file credits and rejects unregistered or ineligible receipt paths', () => {
    const test = sourceGarmentFixture();
    writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), test.notice.replace('by Example author;', 'by Someone else;'));
    expect(() => verifyPublicModels(test.root)).toThrow(/attribution mismatch/);
    writeFileSync(path.join(test.source, 'THIRD_PARTY_NOTICES.md'), test.notice);
    test.profile.path = 'avatars/wardrobe/male/top/unapproved-alias.glb'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/unsafe or duplicate/);
    test.profile.path = test.entry.path; test.save();
    test.entry.license = 'LicenseRef-Sketchfab-Standard'; test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/approved per-file profile/);
    test.entry.license = 'CC-BY-4.0'; test.save();
    rmSync(path.join(test.root, PUBLIC_SOURCE_GARMENTS));
    expect(() => verifyPublicModels(test.root)).toThrow(/approved per-file profile/);
  });

  it('requires the exact receipt manifest in the build and rejects orphaned approvals', () => {
    const test = sourceGarmentFixture(); test.build();
    writeFileSync(path.join(test.dist, 'source-garments.json'), '{}');
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/profiles differ/);
    test.build(); rmSync(path.join(test.dist, 'source-garments.json'));
    expect(() => verifyModelBuild(test.dist, { root: test.root })).toThrow(/exact source-garments/);
    test.manifest.models = test.manifest.models.filter(entry => entry.path !== test.entry.path);
    rmSync(path.join(test.source, test.entry.path)); test.save();
    expect(() => verifyPublicModels(test.root)).toThrow(/does not match a published model/);
  });
});
