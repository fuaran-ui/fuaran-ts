import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

// `@fuaran-ui/core-twins` is workspace-internal: it is never published, and this
// package's build bundles it into `dist`. Resolved by its package name it would
// load the twin's BUILD OUTPUT, so a suite run after a source change and before
// `pnpm build` tested whatever was built last — the capability leg once reported
// the twin as mirroring Core `undefined` because the built twin predated the
// version pin. The suite reads the twin's sources instead, as it reads this
// package's own.
export default defineConfig({
  resolve: {
    alias: {
      '@fuaran-ui/core-twins': fileURLToPath(
        new URL('../core-twins/src/index.ts', import.meta.url),
      ),
    },
  },
  test: {
    include: ['test/**/*.test.ts'],
  },
});
