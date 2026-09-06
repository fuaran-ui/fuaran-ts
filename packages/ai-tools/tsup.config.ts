import { defineConfig } from 'tsup';

export default defineConfig({
  // Two entries: the package root (which pulls in the optional React context)
  // and `./introspection`, the React-free surface. A consumer with no React on
  // its dependency graph — a stdio MCP server, a Node script — imports the
  // subpath and never reaches the provider.
  entry: ['src/index.ts', 'src/introspection.ts'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: ['react'],
});
