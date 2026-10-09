import { cp, readFile, rm, stat } from 'node:fs/promises';
import { build } from 'esbuild';

const manifest = JSON.parse(await readFile(new URL('./package.json', import.meta.url), 'utf8'));

// Everything is bundled, workspace packages and their npm dependencies included,
// so the published package installs without dependencies. Bundled CommonJS
// modules may call `require`, which ESM output lacks; the banner provides it.
await build({
  entryPoints: ['src/bin.ts'],
  outfile: 'dist/extalia.mjs',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  banner: {
    js: [
      '#!/usr/bin/env node',
      "import { createRequire as __extaliaCreateRequire } from 'node:module';",
      'const require = __extaliaCreateRequire(import.meta.url);',
    ].join('\n'),
  },
  define: { __CLI_VERSION__: JSON.stringify(manifest.version) },
  logLevel: 'warning',
});

// The Bridge serves the web UI from dist/web, next to the bundle.
const webDist = new URL('../web/dist/', import.meta.url);
const target = new URL('./dist/web/', import.meta.url);
await rm(target, { recursive: true, force: true });
if (await stat(new URL('index.html', webDist)).then(info => info.isFile(), () => false)) {
  await cp(webDist, target, { recursive: true });
} else {
  console.warn('extalia-vo: apps/web/dist not found; the Bridge will show build instructions instead of the UI. Run `pnpm --filter @extalia/web build` first.');
}
