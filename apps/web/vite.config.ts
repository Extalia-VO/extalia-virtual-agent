import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs let the Desktop shell serve the same build from its app protocol.
  base: './',
  server: { host: '127.0.0.1', port: 5180 },
  // Fonts stay separate files: the Content Security Policy allows fonts from the app itself, not data: URLs.
  build: { assetsInlineLimit: file => (/\.(woff2?|ttf|otf)$/.test(file) ? false : undefined) },
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
});
