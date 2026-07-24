import { defineConfig } from 'tsup';

// Five extension entry points, each bundled as a self-contained classic script
// (MV3 content scripts and the service worker cannot use ESM imports; iife
// everywhere keeps the load model uniform). `public/` carries the static
// extension shell (manifest, pages, css) — copied verbatim into dist/, which
// becomes the load-unpacked root.
export default defineConfig({
  entry: {
    hook: 'src/hook.ts',
    content: 'src/content.ts',
    background: 'src/background.ts',
    devtools: 'src/devtools.ts',
    panel: 'src/panel/panel.ts',
  },
  format: ['iife'],
  outExtension: () => ({ js: '.js' }),
  dts: false,
  clean: true,
  sourcemap: true,
  treeshake: true,
  publicDir: 'public',
});
