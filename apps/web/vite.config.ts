import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { PUBLIC_SOURCE_GARMENTS, verifyModelBuild, verifyPublicModels } from '../../tooling/public-models.mjs';
import manifest from './package.json' with { type: 'json' };

const projectRoot = fileURLToPath(new URL('../..', import.meta.url));
const publicAvatarFiles = fileURLToPath(new URL('./src/office/scene/avatars/publicAvatarFiles.ts', import.meta.url));

/** Validate authored sources before bundling and the actual output before packaging it anywhere. */
function publicOfficeModels(): Plugin {
  let outputDirectory: string;
  return {
    name: 'extalia-public-office-models',
    apply: 'build',
    configResolved(config) { outputDirectory = resolve(config.root, config.build.outDir); },
    buildStart() { verifyPublicModels(projectRoot); },
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'models.json', source: readFileSync(resolve(projectRoot, 'apps/web/public-assets/models.json')) });
      this.emitFile({ type: 'asset', fileName: 'source-garments.json', source: readFileSync(resolve(projectRoot, PUBLIC_SOURCE_GARMENTS)) });
      this.emitFile({ type: 'asset', fileName: 'OFFICE_ASSETS_LICENSE.md', source: readFileSync(resolve(projectRoot, 'apps/web/public-assets/LICENSE.md')) });
      for (const notice of ['AVATAR_SOURCE_LICENSE.md', 'THIRD_PARTY_NOTICES.md']) {
        this.emitFile({ type: 'asset', fileName: notice, source: readFileSync(resolve(projectRoot, 'apps/web/public-assets', notice)) });
      }
    },
    writeBundle() { verifyModelBuild(outputDirectory, { requireAll: true }); },
  };
}

export default defineConfig(({ command, mode }) => {
  if (command === 'build' && mode === 'local-assets') {
    throw new Error('The local-assets mode is for the development server only; production builds use public Blender assets and avatars.');
  }
  return {
    plugins: [react(), publicOfficeModels()],
    // Relative asset URLs let the Desktop shell serve the same build from its app protocol.
    base: './',
    // A build-time module boundary prevents even unused private GLBs from entering the asset graph.
    resolve: { alias: command === 'serve' && mode === 'local-assets' ? [] : [{ find: /^\.\/sourceAvatarFiles$/, replacement: publicAvatarFiles }] },
    server: { host: '127.0.0.1', port: 5180 },
    // GLBs and fonts stay separate files for model verification and the app's Content Security Policy.
    build: { assetsInlineLimit: (file: string) => (/\.(glb|woff2?|ttf|otf)$/i.test(file) ? false : undefined) },
    define: {
      __APP_VERSION__: JSON.stringify(manifest.version),
      // Licence switch: leave non-commercial and unverified campus cars out of parking and traffic.
      __EXTALIA_COMMERCIAL_ASSETS_ONLY__: JSON.stringify(process.env.EXTALIA_COMMERCIAL_ASSETS_ONLY === '1'),
    },
  };
});
