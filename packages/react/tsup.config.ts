import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
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
    '@fuaran-ui/client',
    '@fuaran-ui/client/render',
    '@fuaran-ui/ops',
    '@fuaran-ui/renderer',
    '@fuaran-ui/schema',
  ],
  esbuildOptions(options) {
    options.jsx = 'automatic';
  },
});
