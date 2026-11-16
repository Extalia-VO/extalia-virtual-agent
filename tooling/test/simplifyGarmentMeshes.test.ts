import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const python = process.env.EXTALIA_TEST_PYTHON;
const root = fileURLToPath(new URL('../../', import.meta.url));
const regressions = fileURLToPath(new URL('./simplify-garment-meshes_test.py', import.meta.url));
const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));

describe.skipIf(!python)('offline attribute-aware garment simplification', () => {
  it('preserves retained attribute bytes, boundaries and metadata, and refuses unsupported inputs', () => {
    expect(execFileSync(python!, ['-B', regressions], { cwd: root, encoding: 'utf8' })).toBe('');
  });
  it('loads the simplified skin with the production native GLTFLoader without another decoder', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'extalia-garment-simplify-'));
    try {
      const path = join(directory, 'fixture.glb');
      execFileSync(python!, ['-B', regressions, '--fixture', path], { cwd: root });
      const gltf = await new GLTFLoader().parseAsync(new Uint8Array(readFileSync(path)).buffer, '');
      const mesh = gltf.scene.getObjectByName('Fixture');
      expect(mesh?.isSkinnedMesh).toBe(true);
      expect(mesh.geometry.index.count).toBeLessThan(3456);
      expect(mesh.skeleton.bones.map(bone => bone.name)).toEqual(['hips']);
      expect(mesh.geometry.getAttribute('skinWeight').getX(0)).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
