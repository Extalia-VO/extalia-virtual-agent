import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
import manifest from './package.json' with { type: 'json' };

export default defineConfig({
  plugins: [react()],
  // Relative asset URLs let the Desktop shell serve the same build from its app protocol.
  base: './',
  server: { host: '127.0.0.1', port: 5180 },
  define: { __APP_VERSION__: JSON.stringify(manifest.version) },
});
