// ============================================================================
//  @fuaran-ui/renderer — Chart first-party lowering (Phase 534 tail).
//
//  A `Chart` node whose data source resolves to embedded rows lowers to a
//  canonical `Drawing` subtree via `@fuaran-ui/charts` and renders as real
//  first-party inline SVG — NOT the client-hydration placeholder. This closes
//  the TS renderer's asymmetry with the Python host, whose `render.py` `_chart`
//  arm already lowers (see fuaran-py `test_headless_chart_renders_real_inline_svg`).
//  Only Bar/Line lower; other kinds + unresolved sources keep the placeholder.
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

import { FuaranRenderer } from '../src/index.js';

// A Chart node carrying its data inline as a resolved `Static` source — the
// shape the renderer lowers (mirrors the Python test's directly-built model,
// since the `<opaque>` wire sentinel never carries real rows through decode).
const chartNode = (
  kind: 'Bar' | 'Line' | 'Heatmap',
  rows: readonly Record<string, unknown>[],
): Node<never> => ({
  id: nodeId('chart-demo'),
  kind: {
    kind: 'Visualisation',
    visualisation: {
      kind: 'Chart',
      spec: {
        source: { kind: 'Static', value: rows },
        kind,
        xField: 'quarter',
        yFields: ['revenue'],
        title: { kind: 'Literal', value: 'Revenue by quarter' },
        stacked: false,
      },
    },
  },
  state: defaults.stateBehaviour<never>(),
  style: defaults.style,
});

const revenueRows = [
  { quarter: 'Q1', revenue: 120 },
  { quarter: 'Q2', revenue: 150 },
];

describe('Chart first-party lowering (Phase 534 tail)', () => {
  it('renders a Bar chart with resolved rows as lowered inline SVG, not a placeholder', () => {
    const html = renderToStaticMarkup(<FuaranRenderer tree={chartNode('Bar', revenueRows)} />);
    expect(html).toContain('<svg');
    expect(html).toContain('fuaran-drawing');
    // The literal title folded into the drawing's a11y <title>.
    expect(html).toContain('Revenue by quarter');
    // A series bar rectangle from the geometry (palette index 0) made it in.
    expect(html).toContain('#3366cc');
    // Not the adapter-less fallback.
    expect(html).not.toContain('fuaran-chart-placeholder');
  });

  it('renders a Line chart with resolved rows as lowered inline SVG', () => {
    const html = renderToStaticMarkup(<FuaranRenderer tree={chartNode('Line', revenueRows)} />);
    expect(html).toContain('<svg');
    expect(html).toContain('fuaran-drawing');
    expect(html).not.toContain('fuaran-chart-placeholder');
  });

  it('keeps the placeholder for a not-yet-lowered chart kind (Heatmap)', () => {
    // Phase 636/637/638 — Area / Scatter / Pie now lower; Heatmap is the one
    // remaining placeholder kind (its lowering rule lands with its own phase).
    const html = renderToStaticMarkup(<FuaranRenderer tree={chartNode('Heatmap', revenueRows)} />);
    expect(html).toContain('fuaran-chart-placeholder');
    expect(html).not.toContain('<svg');
  });

  it('keeps the placeholder when the source resolves to no rows', () => {
    const html = renderToStaticMarkup(<FuaranRenderer tree={chartNode('Bar', [])} />);
    expect(html).toContain('fuaran-chart-placeholder');
    expect(html).not.toContain('<svg');
  });
});
