import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

// Port allocation: the Fuaran workspace CLAUDE.md "Port allocation" table reserves
// 24030–24039 (Vite) + 14030–14039 (server) for fuaran-ts/samples/demo. This is a
// second fuaran-ts sample, so it takes the adjacent free 24035 (Vite dev) + 14035
// (preview) slots, distinct from the demo's 24030/14030 and the F# hydration
// sample's 24050. There is no Node server tier kept running — `ssr.mjs` is a
// one-shot build step that writes index.html; Vite then serves it statically.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Dedupe + pin react/react-dom so a single React instance backs the renderer
    // and the hydration mount (duplicate React instances break hooks + hydration).
    dedupe: ['react', 'react-dom'],
    alias: {
      react: resolve(here, 'node_modules/react'),
      'react-dom': resolve(here, 'node_modules/react-dom'),
    },
  },
  server: {
    port: 24035,
    strictPort: true,
  },
  preview: {
    port: 14035,
    strictPort: true,
  },
});
