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

import type { ChartSpec, Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

import { FuaranRenderer } from '../src/index.js';

// A Chart node carrying its data inline as a resolved `Static` source — the
// shape the renderer lowers (mirrors the Python test's directly-built model,
// since the `<opaque>` wire sentinel never carries real rows through decode).
const chartNode = (
  kind: 'Bar' | 'Line' | 'Heatmap',
  rows: readonly Record<string, unknown>[],
  extra?: Partial<ChartSpec<never>>,
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
        ...extra,
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
    expect(html).toContain('#1a86ac');
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

// ── Bridge coverage (the ChartSpec-node → ChartLowerSpec seam) ───────────────
// The lowering's own behaviour is pinned by @fuaran-ui/charts goldens with a
// hand-built ChartLowerSpec; these pin the other half — that the render arm
// actually carries the declared wire fields (`valueFormat`, `xTitle`, `yTitle`,
// `subtitle`, `legendPosition`, `dataLabels`) into the spec, so a dropped field
// cannot silently regress to the lowering's defaults again (the TS twin of the
// Python `test_ssr_bridge_passes_*` family, negative control first so the
// positive assertion cannot pass vacuously).

const renderChart = (
  rows: readonly Record<string, unknown>[],
  extra?: Partial<ChartSpec<never>>,
): string => {
  const html = renderToStaticMarkup(<FuaranRenderer tree={chartNode('Bar', rows, extra)} />);
  expect(html).toContain('<svg');
  expect(html).not.toContain('fuaran-chart-placeholder');
  return html;
};

describe('chart bridge — declared wire fields reach the lowering', () => {
  it('carries valueFormat, the axis titles, and the subtitle (Phases 876/878)', () => {
    // Discriminating values: the axis titles DIFFER from the capitalised
    // field-name fallbacks and the format is Percent, so each assertion fails
    // individually if its field is dropped by the bridge.
    const rows = [
      { quarter: 'Q1', share: 0.42 },
      { quarter: 'Q2', share: 0.55 },
    ];
    const declared: Partial<ChartSpec<never>> = {
      yFields: ['share'],
      title: { kind: 'Literal', value: 'Market share' },
      subtitle: { kind: 'Literal', value: 'Share of segment' },
      xTitle: { kind: 'Literal', value: 'Fiscal quarter' },
      yTitle: { kind: 'Literal', value: 'Segment share' },
      valueFormat: { kind: 'Percent' },
    };
    // Negative control: without the declarations, none of the needles exist.
    const stripped = renderChart(rows, { yFields: ['share'] });
    expect(stripped).not.toContain('Fiscal quarter');
    expect(stripped).not.toContain('Segment share');
    expect(stripped).not.toContain('Share of segment');
    expect(stripped).not.toContain('>0%<');

    const html = renderChart(rows, declared);
    expect(html).toContain('Fiscal quarter'); // xTitle (fallback would be "Quarter")
    expect(html).toContain('Segment share'); // yTitle (fallback would be "Share")
    expect(html).toContain('Share of segment'); // subtitle (absent without the bridge)
    expect(html).toContain('>0%<'); // valueFormat Percent (a bare "0" tick without it)
  });

  it('carries legendPosition (Phase 880)', () => {
    // Two halves, each discriminating against the default (`Right`): a declared
    // `Bottom` must move the legend (a different picture from the same node
    // with the declaration stripped), and an explicit `'None'` suppresses the
    // series labels a two-series default legend draws as text nodes.
    const rows = [
      { region: 'North', sales: 80, target: 100 },
      { region: 'South', sales: 130, target: 110 },
    ];
    const twoSeries: Partial<ChartSpec<never>> = { xField: 'region', yFields: ['sales', 'target'] };
    const defaultHtml = renderChart(rows, twoSeries);
    // Positive control first: the default legend draws the series names.
    expect(defaultHtml).toContain('>sales<');
    expect(defaultHtml).toContain('>target<');

    const bottomHtml = renderChart(rows, { ...twoSeries, legendPosition: 'Bottom' });
    expect(bottomHtml).not.toBe(defaultHtml); // the declared edge moved the legend

    const noneHtml = renderChart(rows, { ...twoSeries, legendPosition: 'None' });
    expect(noneHtml).not.toContain('>sales<');
    expect(noneHtml).not.toContain('>target<');
  });

  it('carries dataLabels (Phase 881)', () => {
    // `120` appears as a text node ONLY as a data label — this chart's axis
    // ticks are 0/50/100/150, so `>120<` cannot be an axis tick. Negative
    // control first: `Off` (the absent-field default) writes no values.
    const offHtml = renderChart(revenueRows);
    expect(offHtml).not.toContain('>120<');
    expect(offHtml).not.toContain('font-size="12px"');

    const html = renderChart(revenueRows, { dataLabels: 'Ends' });
    expect(html).toContain('>120<'); // the cap label the bridge now carries
    // …set at the data-label size, which no chrome label uses.
    expect(html).toContain('font-size="12px"');
  });

  it('does not carry a non-literal text field (the Literal gate)', () => {
    // A bound title cannot be resolved into the drawing — the gate keeps it
    // out, and the axis falls back to its capitalised field name.
    const html = renderChart(revenueRows, {
      xTitle: { kind: 'Bound', binding: { kind: 'Static', value: 'Bound quarter' } },
    });
    expect(html).not.toContain('Bound quarter');
    expect(html).toContain('Quarter'); // the capitalised-field-name fallback
  });
});
