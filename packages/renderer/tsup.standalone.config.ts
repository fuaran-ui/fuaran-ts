import { defineConfig } from 'tsup';

// The STANDALONE browser bundle — a separate build from the package's normal
// ESM/CJS output. Everything is bundled IN (React, react-dom, the renderer, the
// canonical decoder) and nothing is external, because the consumer is a .NET app
// with no Node toolchain: it gets one <script> tag and one stylesheet.
//
// Output lands in `standalone/`, which `Fuaran.UI.Renderer.Web` byte-copies as
// an embedded static web asset — the reference-CSS sync discipline generalised.
export default defineConfig({
  entry: { 'fuaran-renderer': 'src/standalone.tsx' },
  outDir: 'standalone',
  format: ['iife'],
  globalName: 'FuaranRenderer',
  platform: 'browser',
  dts: false,
  clean: true,
  sourcemap: false,
  minify: true,
  // No externals: a self-contained bundle is the whole point.
  noExternal: [/.*/],
  define: {
    // React reads this; without it the dev build ships (larger + slower).
    'process.env.NODE_ENV': '"production"',
  },
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
