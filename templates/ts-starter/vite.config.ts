import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

const here = fileURLToPath(new URL('.', import.meta.url));

// The `react`/`react-dom` dedupe + alias keeps a single React instance when the
// starter runs inside the Fuaran pnpm workspace (hoisted node_modules). A
// standalone (degit'd) copy resolves them normally; the alias is harmless.
export default defineConfig({
  plugins: [react()],
  resolve: {
    dedupe: ['react', 'react-dom'],
    alias: {
      react: resolve(here, 'node_modules/react'),
      'react-dom': resolve(here, 'node_modules/react-dom'),
    },
  },
  // Fuaran-workspace template band (server 14030–14039 / Vite 24030–24039 is the
  // fuaran-ts/samples/demo allocation; the starter reuses the preview/dev split
  // one step up to avoid clashing with a running sample).
  server: { port: 24031, strictPort: false },
  preview: { port: 14031, strictPort: false },
});
