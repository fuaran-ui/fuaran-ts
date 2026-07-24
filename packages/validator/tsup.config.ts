import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    // `typescript` is a runtime dependency, not bundled into the output.
    external: ['typescript'],
  },
  {
    // The CLI is a Node entry point — ESM only, not bundling `typescript`.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    treeshake: true,
    external: ['typescript'],
  },
]);
