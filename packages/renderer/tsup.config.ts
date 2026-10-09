import { defineConfig } from 'tsup';

export default defineConfig({
  entry: [
    'src/index.ts',
    'src/sanitize.ts',
    'src/egress.ts',
    'src/enhanceMath.ts',
    'src/enhanceExpandable.ts',
    'src/markdown.ts',
    // Phase 2076 — the DEBUG-only surfaces, published as the `./debug` and
    // `./relay` subpaths rather than from the root. `<FuaranRenderer>` loads
    // them by dynamic import, so they split into chunks of their own and a
    // consumer's bundler leaves them out of a page that never sets `debug`.
    'src/debug.ts',
    'src/relay.ts',
  ],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [
    'react',
    'react-dom',
    'react/jsx-runtime',
    '@fuaran-ui/schema',
    '@fuaran-ui/ops',
    'katex',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
