#!/usr/bin/env node
/** Record the local detailed hair models (hair/<group>/<style>-detail.glb) in the local hair catalog. */
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
const directory = new URL('../apps/web/local-assets/avatars/hair/', import.meta.url);
const catalogUrl = new URL('catalog.json', directory);
const catalog = JSON.parse(await readFile(catalogUrl, 'utf8'));
const detailed = [];
for (const group of ['male', 'female']) {
  for (const file of (await readdir(new URL(`${group}/`, directory))).filter(name => name.endsWith('-detail.glb')).sort()) {
    const bytes = await readFile(new URL(`${group}/${file}`, directory));
    const doc = JSON.parse(bytes.subarray(20, 20 + bytes.readUInt32LE(12)).toString('utf8'));
    detailed.push({ id: file.replace(/-detail\.glb$/, ''), group, mesh: doc.meshes[0]?.name, file: `${group}/${file}`, bytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex') });
  }
}
catalog.detailed = detailed;
await writeFile(catalogUrl, `${JSON.stringify(catalog, null, 2)}\n`);
console.log(`Registered ${detailed.length} detailed hair models: ${detailed.map(item => `${item.group}/${item.id}`).join(', ')}`);
