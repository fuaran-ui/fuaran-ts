// ============================================================================
//  @fuaran-ui/renderer — `@fuaran-ui/charts` absent (Phase 2434).
//
//  charts is an OPTIONAL peer. With it unresolvable, the renderer must still
//  load, and a tree carrying a `Chart` and a `Sparkline` renders the documented
//  fallback: the chart placeholder and the sparkline em-dash element. Never a
//  crash, at import or at render.
//
//  Two legs. The source leg mocks the module as one that throws on load, so any
//  static import of it anywhere in the renderer fails this file at import. The
//  built leg runs the emitted `dist/index.js` and `dist/index.cjs` in a child
//  Node process whose resolver refuses `@fuaran-ui/charts`, which is the
//  install a non-charting consumer actually has.
// ============================================================================

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

vi.mock('@fuaran-ui/charts', () => {
  throw new Error('@fuaran-ui/charts is not installed');
});

import { FuaranRenderer, registerCharts, registeredCharts } from '../src/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const chartNode = (): Node<never> => ({
  id: nodeId('chart'),
  kind: {
    kind: 'Visualisation',
    visualisation: {
      kind: 'Chart',
      spec: {
        source: {
          kind: 'Static',
          value: [
            { quarter: 'Q1', revenue: 120 },
            { quarter: 'Q2', revenue: 150 },
          ],
        },
        kind: 'Bar',
        xField: 'quarter',
        yFields: ['revenue'],
        stacked: false,
      },
    },
  },
  state: defaults.stateBehaviour<never>(),
  style: defaults.style,
});

const sparklineNode = (): Node<never> => ({
  id: nodeId('spark'),
  kind: {
    kind: 'Display',
    display: { kind: 'Sparkline', spec: { source: { kind: 'Static', value: [1, 3, 2] } } },
  },
  state: defaults.stateBehaviour<never>(),
  style: defaults.style,
});

describe('@fuaran-ui/charts absent (Phase 2434)', () => {
  // The suite's setup registers charts, as a charting host does; this file is
  // the host that does not.
  beforeAll(() => registerCharts(null));

  it('the renderer loads without charts and holds no registration', () => {
    expect(registeredCharts()).toBeNull();
  });

  it('a chart renders the placeholder and a sparkline the em-dash, never a crash', () => {
    const chart = renderToStaticMarkup(<FuaranRenderer tree={chartNode()} />);
    expect(chart).toContain('fuaran-chart-placeholder');
    expect(chart).toContain('[Chart placeholder: Bar');
    expect(chart).not.toContain('fuaran-drawing');
    const sparkline = renderToStaticMarkup(<FuaranRenderer tree={sparklineNode()} />);
    expect(sparkline).toContain('fuaran-sparkline fuaran-sparkline-empty');
    expect(sparkline).not.toContain('fuaran-drawing');
  });

  it('the built ESM and CJS entries load and render with charts unresolvable', () => {
    for (const file of ['dist/index.js', 'dist/index.cjs']) {
      expect(existsSync(resolve(packageRoot, file)), `${file} is built`).toBe(true);
    }
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', BUILT_LEG], {
      cwd: packageRoot,
      encoding: 'utf8',
    });
    expect(child.stderr).toBe('');
    expect(child.status).toBe(0);
    expect(child.stdout.trim().split('\n')).toEqual(['esm ok', 'cjs ok']);
  });
});

// The child refuses `@fuaran-ui/charts` on both resolution paths, then renders
// a lowerable chart through each built entry. `createElement` stands in for
// JSX, which the child does not compile.
const BUILT_LEG = String.raw`
import { register, createRequire } from 'node:module';
import Module from 'node:module';
const refuse = (s) => s === '@fuaran-ui/charts' || s.startsWith('@fuaran-ui/charts/');
register('data:text/javascript,' + encodeURIComponent(
  "export async function resolve(s, c, next) {" +
  "  if (s === '@fuaran-ui/charts' || s.startsWith('@fuaran-ui/charts/')) {" +
  "    const e = new Error('Cannot find package ' + s); e.code = 'ERR_MODULE_NOT_FOUND'; throw e; }" +
  "  return next(s, c); }"));
const original = Module._resolveFilename;
Module._resolveFilename = function (s, ...rest) {
  if (refuse(s)) { const e = new Error('Cannot find module ' + s); e.code = 'MODULE_NOT_FOUND'; throw e; }
  return original.call(this, s, ...rest);
};
const require = createRequire(import.meta.url);
const { defaults } = await import('@fuaran-ui/schema');
const tree = {
  id: 'chart', kind: { kind: 'Visualisation', visualisation: { kind: 'Chart', spec: {
    source: { kind: 'Static', value: [{ q: 'Q1', v: 1 }] }, kind: 'Bar', xField: 'q', yFields: ['v'], stacked: false } } },
  state: defaults.stateBehaviour(), style: defaults.style,
};
const check = (label, renderer, react, server) => {
  const html = server.renderToStaticMarkup(react.createElement(renderer.FuaranRenderer, { tree }));
  if (!html.includes('fuaran-chart-placeholder')) throw new Error(label + ': no placeholder in ' + html);
  console.log(label + ' ok');
};
check('esm', await import('./dist/index.js'), await import('react'), await import('react-dom/server'));
check('cjs', require('./dist/index.cjs'), require('react'), require('react-dom/server'));
`;
