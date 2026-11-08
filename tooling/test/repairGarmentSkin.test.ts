/** Opt-in authoring checks; the product and default test suite do not require system Python. */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

interface Accessor {
  bufferView: number; componentType: number; count: number; type: string; normalized?: boolean; min?: number[]; max?: number[];
  sparse?: { count: number; indices: { bufferView: number; componentType: number }; values: { bufferView: number } };
}
interface Primitive { attributes: Record<string, number>; indices: number; material: number; targets?: Record<string, number>[] }
interface Document {
  asset: { version: string }; buffers: { byteLength: number }[];
  bufferViews: { buffer: number; byteOffset: number; byteLength: number }[];
  accessors: Accessor[]; materials: { name: string; extras?: Record<string, string> }[];
  meshes: { primitives: Primitive[] }[]; nodes: { name: string }[];
  skins: { joints: number[] }[]; images: { bufferView: number; mimeType: string }[];
}
interface Fixture { doc: Document; binary: Buffer }
const temporary: string[] = [];
const python = process.env.EXTALIA_TEST_PYTHON;
const script = fileURLToPath(new URL('../blender/repair-garment-skin.py', import.meta.url));
afterEach(() => { for (const folder of temporary.splice(0)) rmSync(folder, { recursive: true, force: true }); });

function fixture(damaged: boolean): Fixture {
  const doc: Document = {
    asset: { version: '2.0' }, buffers: [], bufferViews: [], accessors: [],
    materials: [{ name: 'Skin_Context' }, { name: 'OriginalTop_Fabric', extras: { motif: 'retained synthetic fabric' } }],
    meshes: [], nodes: [{ name: 'hips' }, { name: 'leftLowerArm' }], skins: [{ joints: [0, 1] }], images: [],
  };
  let binary = Buffer.alloc(0);
  function view(bytes: Buffer) {
    const id = doc.bufferViews.length;
    doc.bufferViews.push({ buffer: 0, byteOffset: binary.length, byteLength: bytes.length });
    binary = Buffer.concat([binary, bytes, Buffer.alloc((-bytes.length % 4 + 4) % 4)]);
    return id;
  }
  function accessor(values: number[], type: string, componentType = 5126, normalized = false) {
    const width = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4 }[type]!;
    const bytes = Buffer.alloc(values.length * (componentType === 5126 ? 4 : 2));
    values.forEach((value, i) => { if (componentType === 5126) bytes.writeFloatLE(value, i * 4); else bytes.writeUInt16LE(value, i * 2); });
    const id = doc.accessors.length;
    doc.accessors.push({ bufferView: view(bytes), componentType, type, count: values.length / width, ...(normalized ? { normalized } : {}) });
    return id;
  }
  const offset = damaged ? .04 : 0;
  const positions = [.1 + offset, 1.1, -.1, .12 + offset, 1.1, -.1, .11 + offset, 1.12, -.1];
  const attributes = {
    POSITION: accessor(positions, 'VEC3'),
    NORMAL: accessor(damaged ? [1, 0, 0, 1, 0, 0, 1, 0, 0] : [0, 0, -1, 0, 0, -1, 0, 0, -1], 'VEC3'),
    JOINTS_0: accessor(Array.from({ length: 3 }, () => [damaged ? 1 : 0, 0, 0, 0]).flat(), 'VEC4', 5123),
    WEIGHTS_0: accessor(Array.from({ length: 3 }, () => [65535, 0, 0, 0]).flat(), 'VEC4', 5123, true),
    TEXCOORD_0: accessor(damaged ? [.2, .2, .4, .2, .3, .4] : [0, 0, 1, 0, .5, 1], 'VEC2'),
  };
  doc.accessors[attributes.POSITION]!.min = [.1 + offset, 1.1, -.1];
  doc.accessors[attributes.POSITION]!.max = [.12 + offset, 1.12, -.1];
  const skin: Primitive = {
    attributes, indices: accessor([0, 1, 2], 'SCALAR', 5123), material: 0,
    targets: [{ POSITION: accessor(Array.from({ length: 3 }, () => [0, damaged ? .06 : 0, 0]).flat(), 'VEC3') }],
  };
  const cloth: Primitive = {
    attributes: { POSITION: accessor(damaged ? [.08, 1.1, -.12, .14, 1.1, -.12, .11, 1.15, -.12] : [0, 1, -.2, .2, 1, -.2, .1, 1.2, -.2], 'VEC3') },
    indices: accessor([0, 1, 2], 'SCALAR', 5123), material: 1,
  };
  doc.meshes.push({ primitives: [skin, cloth] });
  doc.images.push({ bufferView: view(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 11, 23, damaged ? 37 : 41, 53])), mimeType: 'image/png' });
  doc.buffers.push({ byteLength: binary.length });
  return { doc, binary };
}

function encode(fixture: Fixture) {
  const json = Buffer.from(JSON.stringify(fixture.doc)), padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
  const header = Buffer.alloc(20); header.write('glTF'); header.writeUInt32LE(2, 4);
  header.writeUInt32LE(28 + padded.length + fixture.binary.length, 8); header.writeUInt32LE(padded.length, 12); header.writeUInt32LE(0x4e4f534a, 16);
  const chunk = Buffer.alloc(8); chunk.writeUInt32LE(fixture.binary.length, 0); chunk.writeUInt32LE(0x004e4942, 4);
  return Buffer.concat([header, padded, chunk, fixture.binary]);
}

function decode(bytes: Buffer): Fixture {
  const length = bytes.readUInt32LE(12);
  return { doc: JSON.parse(bytes.subarray(20, 20 + length).toString()), binary: bytes.subarray(28 + length) };
}

function payload(fixture: Fixture, index: number) {
  const view = fixture.doc.bufferViews[fixture.doc.accessors[index]!.bufferView]!;
  return fixture.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength);
}

function makeSparse(fixture: Fixture, accessor: number, vertex: number, delta: number, retainBase = false) {
  function append(bytes: Buffer) {
    const index = fixture.doc.bufferViews.length;
    fixture.doc.bufferViews.push({ buffer: 0, byteOffset: fixture.binary.length, byteLength: bytes.length });
    fixture.binary = Buffer.concat([fixture.binary, bytes, Buffer.alloc((-bytes.length % 4 + 4) % 4)]);
    fixture.doc.buffers[0]!.byteLength = fixture.binary.length;
    return index;
  }
  const indices = Buffer.alloc(2); indices.writeUInt16LE(vertex);
  const values = Buffer.alloc(12); values.writeFloatLE(delta, 4);
  fixture.doc.accessors[accessor]!.sparse = { count: 1, indices: { bufferView: append(indices), componentType: 5123 }, values: { bufferView: append(values) } };
  if (!retainBase) Reflect.deleteProperty(fixture.doc.accessors[accessor]!, 'bufferView');
}

function files() {
  const folder = mkdtempSync(join(tmpdir(), 'extalia-skin-repair-')); temporary.push(folder);
  const source = fixture(false), target = fixture(true), original = join(folder, 'original.glb'), current = join(folder, 'fitted.glb');
  const save = () => { writeFileSync(original, encode(source)); writeFileSync(current, encode(target)); };
  save();
  const run = (write = true) => spawnSync(python!, ['-I', '-S', '-B', script, '--source', original, '--target', current, '--audit', ...(write ? ['--write'] : [])], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 65536, windowsHide: true, cwd: folder,
    env: { PATH: process.env.PATH ?? '', ...(process.platform === 'win32' ? { SystemRoot: process.env.SystemRoot ?? '' } : {}) },
  });
  return { source, target, original, current, save, run };
}

describe.skipIf(!python)('repairing damaged garment skin without replacing fitted cloth', () => {
  it('restores exact skin positions, normals, normalized binding and morphs while retaining all other bytes', () => {
    const test = files(), sourceBytes = readFileSync(test.original), targetBytes = readFileSync(test.current);
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    const audit = JSON.parse(result.stdout);
    expect(audit.skin[0]).toMatchObject({ vertices: 3, changedPositions: 3, changedJointRows: 3, newTorsoArmLeaks: 3 });
    const repaired = decode(readFileSync(test.current)), skin = test.source.doc.meshes[0]!.primitives[0]!;
    const restored = [...['POSITION', 'NORMAL', 'JOINTS_0', 'WEIGHTS_0'].map(name => skin.attributes[name]!), skin.targets![0]!.POSITION!];
    for (const index of restored) {
      expect(payload(repaired, index)).toEqual(payload(test.source, index));
      expect(repaired.doc.accessors[index]).toEqual(test.source.doc.accessors[index]);
    }
    const changedBytes = new Set<number>();
    for (const index of restored) {
      const view = test.target.doc.bufferViews[test.target.doc.accessors[index]!.bufferView]!;
      for (let offset = view.byteOffset; offset < view.byteOffset + view.byteLength; offset++) changedBytes.add(offset);
    }
    for (let offset = 0; offset < repaired.binary.length; offset++) if (!changedBytes.has(offset)) expect(repaired.binary[offset]).toBe(test.target.binary[offset]);
    for (const field of ['meshes', 'materials', 'images', 'nodes', 'skins', 'bufferViews'] as const) expect(repaired.doc[field]).toEqual(test.target.doc[field]);
    expect(readFileSync(test.original)).toEqual(sourceBytes);
    expect(readFileSync(test.current)).not.toEqual(targetBytes);
    const second = test.run();
    expect(second.status, second.stderr).toBe(0);
    expect(JSON.parse(second.stdout).beforeSHA256).toBe(JSON.parse(second.stdout).afterSHA256);
  });

  it('audits a repair without writing either input', () => {
    const test = files(), beforeSource = readFileSync(test.original), beforeTarget = readFileSync(test.current);
    const result = test.run(false);
    expect(result.status, result.stderr).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.write).toBe(false); expect(report.afterSHA256).not.toBe(report.beforeSHA256);
    expect(readFileSync(test.original)).toEqual(beforeSource); expect(readFileSync(test.current)).toEqual(beforeTarget);
  });

  it('retains sparse cloth morphs, their optional dense bases and zero-initialized cloth accessors', () => {
    const test = files();
    const doc = test.target.doc, cloth = doc.meshes[0]!.primitives[1]!;
    const withoutBase = doc.accessors.length;
    doc.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
    makeSparse(test.target, withoutBase, 1, .025);
    const withBase = doc.accessors.length;
    doc.accessors.push({ ...doc.accessors[cloth.attributes.POSITION!]! });
    makeSparse(test.target, withBase, 2, .05, true);
    const zero = doc.accessors.length;
    doc.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
    Reflect.deleteProperty(doc.accessors[zero]!, 'bufferView');
    cloth.targets = [{ POSITION: withoutBase }, { POSITION: withBase }, { POSITION: zero }];
    test.save(); const before = decode(readFileSync(test.current));
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    const repaired = decode(readFileSync(test.current));
    for (const index of [withoutBase, withBase, zero]) expect(repaired.doc.accessors[index]).toEqual(before.doc.accessors[index]);
    for (const index of [withoutBase, withBase]) {
      const sparse = before.doc.accessors[index]!.sparse!;
      for (const viewId of [sparse.indices.bufferView, sparse.values.bufferView]) {
        const view = before.doc.bufferViews[viewId]!;
        expect(repaired.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength)).toEqual(before.binary.subarray(view.byteOffset, view.byteOffset + view.byteLength));
      }
    }
    expect(payload(repaired, cloth.attributes.POSITION!)).toEqual(payload(before, cloth.attributes.POSITION!));
    expect(repaired.doc.meshes).toEqual(before.doc.meshes);
  });

  it.each(['source-sparse', 'both-sparse', 'target-zero'])('restores logical skin morph values with %s storage', problem => {
    const test = files(), sourceMorph = test.source.doc.meshes[0]!.primitives[0]!.targets![0]!.POSITION!;
    const targetMorph = test.target.doc.meshes[0]!.primitives[0]!.targets![0]!.POSITION!;
    const expected = Buffer.alloc(36);
    if (problem === 'target-zero') {
      payload(test.source, sourceMorph).writeFloatLE(.025, 16); expected.writeFloatLE(.025, 16);
      Reflect.deleteProperty(test.target.doc.accessors[targetMorph]!, 'bufferView');
    } else {
      makeSparse(test.source, sourceMorph, 1, .025); expected.writeFloatLE(.025, 16);
      if (problem === 'both-sparse') makeSparse(test.target, targetMorph, 2, .06);
    }
    test.save(); const before = decode(readFileSync(test.current));
    const result = test.run();
    expect(result.status, result.stderr).toBe(0);
    const repaired = decode(readFileSync(test.current));
    expect(payload(repaired, targetMorph)).toEqual(expected);
    expect(repaired.doc.accessors[targetMorph]!.sparse).toBeUndefined();
    if (problem !== 'source-sparse') {
      // Sparse/implicit target storage is replaced by an appended skin-only view.
      expect(repaired.binary.subarray(0, before.binary.length).subarray(before.binary.length - 12)).toEqual(before.binary.subarray(before.binary.length - 12));
      expect(repaired.doc.meshes).toEqual(before.doc.meshes);
    }
  });

  it.each(['indices', 'values'])('refuses skin writes overlapping protected sparse cloth %s', part => {
    const test = files(), doc = test.target.doc, skin = doc.meshes[0]!.primitives[0]!, cloth = doc.meshes[0]!.primitives[1]!;
    const morph = doc.accessors.length;
    doc.accessors.push({ bufferView: 0, componentType: 5126, count: 3, type: 'VEC3' });
    makeSparse(test.target, morph, 1, .025);
    doc.accessors[morph]!.sparse![part].bufferView = doc.accessors[skin.attributes[part === 'indices' ? 'JOINTS_0' : 'POSITION']!]!.bufferView;
    cloth.targets = [{ POSITION: morph }]; test.save();
    const before = readFileSync(test.current), result = test.run();
    expect(result.status).not.toBe(0); expect(result.stderr).toContain('overlaps protected accessor or image');
    expect(readFileSync(test.current)).toEqual(before);
  });

  it.each(['shared-accessor', 'overlapping-storage', 'image-overlap', 'topology', 'joint-order', 'format', 'morph-count'])(
    'refuses %s without changing the target', problem => {
      const test = files(), doc = test.target.doc, skin = doc.meshes[0]!.primitives[0]!, cloth = doc.meshes[0]!.primitives[1]!;
      if (problem === 'shared-accessor') cloth.attributes.POSITION = skin.attributes.POSITION!;
      if (problem === 'overlapping-storage') doc.accessors[cloth.attributes.POSITION!]!.bufferView = doc.accessors[skin.attributes.POSITION!]!.bufferView;
      if (problem === 'image-overlap') doc.images[0]!.bufferView = doc.accessors[skin.attributes.POSITION!]!.bufferView;
      if (problem === 'topology') payload(test.target, skin.indices).writeUInt16LE(2, 2);
      if (problem === 'joint-order') doc.skins[0]!.joints.reverse();
      if (problem === 'format') doc.accessors[skin.attributes.WEIGHTS_0!]!.normalized = false;
      if (problem === 'morph-count') skin.targets = [];
      test.save(); const before = readFileSync(test.current);
      const result = test.run();
      expect(result.status).not.toBe(0); expect(result.stderr).toContain('Skin repair refused:');
      expect(readFileSync(test.current)).toEqual(before);
    },
  );
});
