import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
  },
  {
    // The `fuaran-mock` bin. ESM-only: launched as a process, never `require`d.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
  },
]);
