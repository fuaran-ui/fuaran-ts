import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/sanitize.ts', 'src/enhanceMath.ts', 'src/markdown.ts'],
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
