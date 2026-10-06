import { defineConfig } from 'tsup';

// `@fuaran-ui/observer-core` is a PRIVATE workspace package (the scaffolding the
// layout and style observers share): it is never published, so this package
// must not reference it from its dist. `noExternal` bundles its code into both
// formats and `dts.resolve` inlines its declarations; observer-core's own test
// checks every built dist for a leaked reference. React stays external.
export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm', 'cjs'],
  dts: { resolve: ['@fuaran-ui/observer-core'] },
  noExternal: ['@fuaran-ui/observer-core'],
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react'],
});
