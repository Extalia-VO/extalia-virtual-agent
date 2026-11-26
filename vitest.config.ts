import { defineConfig } from 'vitest/config';

const DEFAULT_TIMEOUT_MS = process.platform === 'win32' ? 30_000 : 15_000;

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tooling/blender/*.test.ts', 'tooling/test/**/*.test.ts'],
    environment: 'node',
    // Host suites spawn the real daemon binary, SQLite stores, and git; under a full
    // parallel run the default 5 s is too tight (especially on Windows NTFS runners).
    testTimeout: DEFAULT_TIMEOUT_MS,
    hookTimeout: DEFAULT_TIMEOUT_MS,
  },
});
