import { defineConfig } from 'tsup';

// `@fuaran-ui/core-twins` is a PRIVATE workspace package (the Core-twin
// boundary, Phase 1861): it is never published, so this package must not
// reference it from its dist. `noExternal` bundles its code into both formats,
// and `dts.resolve` inlines its declarations into index.d.ts. The core-twins
// boundary test checks every built dist for a leaked reference.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { resolve: ['@fuaran-ui/core-twins'] },
  noExternal: ['@fuaran-ui/core-twins'],
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['@fuaran-ui/schema'],
});
