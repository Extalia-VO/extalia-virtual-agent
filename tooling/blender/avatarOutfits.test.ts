import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';
import { readModelMetadata, readSourceGarmentProfiles, verifySourceGarmentMaterialReceipts } from '../public-models.mjs';

const webRequire = createRequire(new URL('../../apps/web/package.json', import.meta.url));
const { SkinnedMesh, Texture } = await import(webRequire.resolve('three'));
const { GLTFLoader } = await import(webRequire.resolve('three/examples/jsm/loaders/GLTFLoader.js'));

type Entry = { id: string; group: 'female' | 'male'; license: string; notice: string; title: string; status?: string; reason?: string; publish?: boolean };
const root = new URL('../../', import.meta.url);
const catalog = JSON.parse(readFileSync(new URL('tooling/blender/avatar-outfits.json', root), 'utf8')) as { notices: Record<string, unknown>; outfits: Entry[] };
const manifest = JSON.parse(readFileSync(new URL('apps/web/public-assets/models.json', root), 'utf8')) as { models: { path: string; license: string; provenance: { exporter?: string } }[] };
const notices = readFileSync(new URL('apps/web/public-assets/THIRD_PARTY_NOTICES.md', root), 'utf8');
const sourceProfiles = new Map(readSourceGarmentProfiles().map(profile => [profile.path, profile]));
const ZONE = /^(?:(?:Belt|BadgeCard|Apron)|Office(?:Top|Outer|Accent|Trim|Bottom|Shoes|Lining)|Skin)_[A-Za-z0-9]+$/;
const BODY_BONES = (group: string) => {
  const document = readModelMetadata(fileURLToPath(new URL(`apps/web/public-assets/avatars/bodies/${group}/${group === 'female' ? 'female-casual' : 'office-classic'}.glb`, root))) as
    { nodes: { name: string; translation?: number[]; rotation?: number[] }[]; skins: { joints: number[] }[] };
  return new Map(document.skins[0]!.joints.map(index => [document.nodes[index]!.name, document.nodes[index]!]));
};

describe('avatar outfit catalog', () => {
  it('lists unique outfit ids, a known licence and notice per entry, and a reason for every skip', () => {
    const ids = catalog.outfits.map(entry => entry.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const entry of catalog.outfits) {
      expect(entry.id).toMatch(/^outfit-[a-z0-9-]+$/);
      expect(['female', 'male']).toContain(entry.group);
      expect(Object.keys(catalog.notices)).toContain(entry.notice);
      expect(['CC-BY-4.0', 'LicenseRef-RenderHub-Extended-Use', 'LicenseRef-Sketchfab-Standard', 'LicenseRef-Owner-Provided-Unverified']).toContain(entry.license);
      if (entry.status === 'skip') expect(entry.reason, entry.id).toBeTruthy();
    }
  });

  it('publishes each processed outfit with its licence, exporter and a credit line', () => {
    const published = manifest.models.filter(model => model.provenance.exporter === 'tooling/blender/prepare-avatar-outfits.py');
    expect(published.length + manifest.models.filter(model => /^avatars\/wardrobe\//.test(model.path)).length).toBeGreaterThan(0);
    const byPath = new Map(catalog.outfits.map(entry => [`avatars/outfits/${entry.group}/${entry.id}.glb`, entry]));
    for (const model of published) {
      const entry = byPath.get(model.path);
      expect(entry, model.path).toBeDefined();
      expect(entry!.status, model.path).not.toBe('skip');
      expect(entry!.publish, model.path).not.toBe(false);
      expect(model.license).toBe(entry!.license);
      expect(model.provenance.exporter).toBe('tooling/blender/prepare-avatar-outfits.py');
      expect(notices.split('\n').find(line => line.includes(`\`${model.path}\``)), model.path).toContain(entry!.license);
    }
  });
});

describe('published wearable geometry', () => {
  const originalExporters = new Set([
    'tooling/blender/fit-original-garments.py', 'tooling/blender/fit-original-bottoms.py',
    'tooling/blender/fit-original-sets.py', 'tooling/blender/fit-original-bartender.py',
  ]);
  const files = manifest.models.filter(model => /^avatars\/(?:outfits|wardrobe)\//.test(model.path));

  it('publishes wearable originals while keeping incomplete paired inners out of the catalog', () => {
    expect(files.some(model => model.path.endsWith('/outer/cloth-jacket.glb'))).toBe(true);
    expect(files.some(model => model.path.endsWith('/bottom/short-jeans.glb'))).toBe(true);
    expect(files.some(model => model.path.endsWith('/bottom/jeans.glb'))).toBe(true);
    expect(files.some(model => model.path.endsWith('/top/cloth-shirt.glb'))).toBe(false);
  });

  it.each(files)('$path retains a compatible rig, finite weights and its declared material representation', async model => {
    const file = new URL(`apps/web/public-assets/${model.path}`, root);
    const bytes = readFileSync(file);
    const source = model.provenance.exporter === 'tooling/blender/fit-source-garments.py';
    const profile = sourceProfiles.get(model.path);
    if (source) expect(profile, model.path).toBeDefined();
    const original = source || originalExporters.has(model.provenance.exporter ?? '');
    expect(bytes.length).toBeLessThanOrEqual(profile?.budgets.bytes ?? (original ? 42_000_000 : 700_000));
    const document = readModelMetadata(fileURLToPath(file)) as {
      asset: { extras?: { nonStandalone?: boolean } }; images?: unknown[]; meshes: unknown[];
      materials: { name: string; alphaMode?: string }[]; nodes: { name: string; rotation?: number[] }[]; skins: { joints: number[] }[];
    };
    expect(document.asset.extras?.nonStandalone).not.toBe(true);
    const group = model.path.includes('/female/') ? 'female' : 'male';
    const body = BODY_BONES(group);
    const joints = document.skins[0]!.joints.map(index => document.nodes[index]!);
    expect(joints.map(joint => joint.name).sort()).toEqual([...body.keys()].sort());
    for (const joint of joints) {
      const reference = body.get(joint.name)!;
      (joint.rotation ?? [0, 0, 0, 1]).forEach((value, axis) => expect(value).toBeCloseTo((reference.rotation ?? [0, 0, 0, 1])[axis]!, 3));
    }
    expect(document.meshes).toHaveLength(1);
    if (original) {
      // Some original source materials are native colors with no image maps.
      // Their receipt must prove that representation rather than impose a texture.
      if (profile) verifySourceGarmentMaterialReceipts(fileURLToPath(file), profile.materials);
      else expect(document.images!.length).toBeGreaterThan(0);
      expect(document.materials.some(material => material.name.startsWith('Original'))).toBe(true);
      expect(model.license).toBe('CC-BY-4.0');
      if (model.provenance.exporter === 'tooling/blender/fit-original-sets.py') {
        // Transparent sorting must not put an opaque enclosing jacket behind its shirt.
        expect(document.materials.filter(material => material.name.startsWith('Original')).every(material => material.alphaMode !== 'BLEND')).toBe(true);
      }
      expect(notices).toContain(`\`${model.path}\``);
    } else {
      expect(document.images ?? []).toHaveLength(0);
      for (const material of document.materials) expect(material.name).toMatch(ZONE);
    }
    const scene = (await new GLTFLoader().register(() => ({ name: 'geometry-only-image-fixture', loadTexture: async () => new Texture() })).parseAsync(new Uint8Array(bytes).buffer, '')).scene;
    let triangles = 0, sourceUv = false;
    scene.traverse((node: InstanceType<typeof SkinnedMesh>) => {
      if (!(node instanceof SkinnedMesh)) return;
      const geometry = node.geometry, weight = geometry.getAttribute('skinWeight');
      triangles += (geometry.index?.count ?? geometry.getAttribute('position').count) / 3;
      expect(weight).toBeDefined();
      for (let vertex = 0; vertex < weight.count; vertex++) {
        const total = weight.getX(vertex) + weight.getY(vertex) + weight.getZ(vertex) + weight.getW(vertex);
        expect(Number.isFinite(total)).toBe(true);
        expect(total).toBeCloseTo(1, 3);
      }
      sourceUv ||= geometry.getAttribute('uv') !== undefined;
      if (!original) expect(geometry.getAttribute('uv')).toBeUndefined();
    });
    expect(triangles).toBeLessThanOrEqual(profile?.budgets.triangles ?? (original ? 180_000 : 16_000));
    if (profile) expect(triangles).toBe(profile.triangles);
    if (original && (!profile || Object.values(profile.materials).some(material => material.requiredUVSets.length))) expect(sourceUv).toBe(true);
  });
});
