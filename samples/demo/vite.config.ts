import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

// Port allocation: the Fuaran workspace CLAUDE.md "Port allocation" table
// reserves 24030–24039 (Vite dev) + 14030–14039 (server) for
// fuaran-ts/samples/demo. This is a pure-Vite renderer demo — no server tier
// exists, so only the Vite dev server (24030) + preview (14030) are wired.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // Pin react / react-dom through this package's resolution and dedupe so a
    // single React instance backs the renderer + the host app (duplicate React
    // instances break hooks).
    dedupe: ['react', 'react-dom'],
    alias: {
      react: resolve(here, 'node_modules/react'),
      'react-dom': resolve(here, 'node_modules/react-dom'),
    },
  },
  server: {
    port: 24030,
    strictPort: true,
  },
  preview: {
    port: 14030,
    strictPort: true,
  },
});
