import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
// Developer tooling interoperability only; standard CI never discovers system Python.
const python = process.env.EXTALIA_TEST_PYTHON;
const regressions = fileURLToPath(new URL('./compact-garment-buffers_test.py', import.meta.url));
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));

/** The two decoder-free storage forms emitted by the compactor, generated without Python. */
function nativeFixture(): ArrayBuffer {
  const binary = Buffer.alloc(2084);
  binary.set([1, 2], 0); // sparse position row indices
  [1, 0, 0, 0, 1, 0].forEach((value, i) => binary.writeFloatLE(value, 4 + i * 4));
  [0, 1, 2].forEach((value, i) => binary.writeUInt16LE(value, 28 + i * 2));
  for (let row = 0; row < 512; row++) binary.set([127, 0, 0, 127], 36 + row * 4);
  const document = {
    asset: { version: '2.0' }, buffers: [{ byteLength: binary.length }],
    extensionsUsed: ['KHR_mesh_quantization'], extensionsRequired: ['KHR_mesh_quantization'],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 2 },
      { buffer: 0, byteOffset: 4, byteLength: 24 },
      { buffer: 0, byteOffset: 28, byteLength: 6 },
      { buffer: 0, byteOffset: 36, byteLength: 2048 },
    ],
    accessors: [
      { componentType: 5126, type: 'VEC3', count: 512, min: [0, 0, 0], max: [1, 1, 0],
        sparse: { count: 2, indices: { bufferView: 0, componentType: 5121 }, values: { bufferView: 1 } } },
      { componentType: 5126, type: 'VEC3', count: 512, min: [0, 0, 0], max: [0, 0, 0] },
      { bufferView: 2, componentType: 5123, type: 'SCALAR', count: 3 },
      { bufferView: 3, componentType: 5120, type: 'VEC4', count: 512, normalized: true },
    ],
    materials: [{ name: 'OriginalTop_Test' }],
    meshes: [{ name: 'Exact garment fixture', weights: [0], extras: { targetNames: ['ExtaliaSeatedDrape'] },
      primitives: [{ attributes: { POSITION: 0, TANGENT: 3 }, indices: 2, material: 0, targets: [{ POSITION: 1 }] }] }],
    nodes: [{ mesh: 0 }], scenes: [{ nodes: [0] }], scene: 0,
  };
  const json = Buffer.from(JSON.stringify(document));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, 32); json.copy(padded);
  const glb = Buffer.alloc(28 + padded.length + binary.length);
  glb.writeUInt32LE(0x46546c67, 0); glb.writeUInt32LE(2, 4); glb.writeUInt32LE(glb.length, 8);
  glb.writeUInt32LE(padded.length, 12); glb.writeUInt32LE(0x4e4f534a, 16); padded.copy(glb, 20);
  glb.writeUInt32LE(binary.length, 20 + padded.length); glb.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(glb, 28 + padded.length);
  return new Uint8Array(glb).buffer;
}

async function expectNativeGeometry(bytes: ArrayBuffer, quantized = false) {
  const gltf = await new GLTFLoader().parseAsync(bytes, '');
  const mesh = gltf.scene.getObjectByName('Exact_garment_fixture');
  expect(mesh?.isMesh).toBe(true);
  expect(mesh.geometry.getAttribute('position').count).toBe(512);
  expect(mesh.geometry.getAttribute('position').getX(1)).toBe(1);
  expect(mesh.geometry.getAttribute('position').getY(2)).toBe(1);
  expect([...mesh.geometry.index.array]).toEqual([0, 1, 2]);
  expect([...mesh.geometry.morphAttributes.position[0].array].every(value => value === 0)).toBe(true);
  expect(mesh.material.name).toBe('OriginalTop_Test');
  if (quantized) {
    expect(mesh.geometry.getAttribute('tangent').normalized).toBe(true);
    expect(mesh.geometry.getAttribute('tangent').getX(0)).toBe(1);
    expect(mesh.geometry.getAttribute('tangent').getW(0)).toBe(1);
  }
}

describe('native sparse garment storage', () => {
  it('loads sparse positions, zero drape targets and quantized tangents without a decoder', async () => {
    await expectNativeGeometry(nativeFixture(), true);
  });
});

describe.skipIf(!python)('opt-in Python garment buffer compaction', () => {
  it('preserves dense, interleaved, normalized, sparse and image payloads exactly', () => {
    const output = execFileSync(python!, ['-B', regressions], { cwd: root, encoding: 'utf8', stdio: 'pipe' });
    expect(output).toBe('');
  });

  it('loads sparse positions and zero-initialized drape targets with the native renderer loader', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'extalia-garment-buffers-'));
    try {
      const path = join(directory, 'fixture.glb');
      execFileSync(python!, ['-B', regressions, '--fixture', path], { cwd: root, stdio: 'pipe' });
      const bytes = readFileSync(path);
      await expectNativeGeometry(new Uint8Array(bytes).buffer);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
