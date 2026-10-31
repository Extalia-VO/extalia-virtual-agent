import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts', 'tooling/blender/*.test.ts', 'tooling/test/**/*.test.ts'],
    environment: 'node',
    // Host suites spawn the real daemon binary and git; under a full parallel run the
    // default 5 s is too tight on a busy machine, so allow 15 s per test and hook.
    testTimeout: 15_000,
    hookTimeout: 15_000,
  },
});
