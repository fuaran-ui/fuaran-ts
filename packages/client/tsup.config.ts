import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/render.tsx'],
  format: ['esm', 'cjs'],
  dts: true,
  clean: true,
  sourcemap: true,
  treeshake: true,
  external: [
    'react',
    'react-dom',
    'react-dom/client',
    'react/jsx-runtime',
    '@fuaran-ui/ops',
    '@fuaran-ui/renderer',
    '@fuaran-ui/schema',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
