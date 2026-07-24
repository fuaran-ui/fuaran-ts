import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm', 'cjs'],
    dts: true,
    clean: true,
    sourcemap: true,
    treeshake: true,
    external: [
      '@fuaran-ui/client',
      '@fuaran-ui/ops',
      '@fuaran-ui/renderer-server',
      '@fuaran-ui/schema',
    ],
  },
  {
    // The stdio executable (`fuaran-mcp` bin). ESM-only: it is launched by an
    // MCP host as a child process, never `require`d.
    entry: ['src/cli.ts'],
    format: ['esm'],
    sourcemap: true,
    banner: { js: '#!/usr/bin/env node' },
    external: [
      '@fuaran-ui/client',
      '@fuaran-ui/ops',
      '@fuaran-ui/renderer-server',
      '@fuaran-ui/schema',
    ],
  },
]);
