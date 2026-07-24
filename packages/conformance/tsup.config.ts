import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    // import.meta.url shim so the CJS build can resolve the bundled corpus.
    shims: true,
  },
  {
    // The CLI uses top-level await — ESM only.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    treeshake: true,
  },
]);
