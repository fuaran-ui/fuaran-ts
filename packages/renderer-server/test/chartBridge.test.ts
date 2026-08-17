// ============================================================================
//  SSR chart-bridge coverage (the wire-node → ChartLowerSpec seam).
//
//  The lowering's own behaviour is pinned by @fuaran-ui/charts goldens with a
//  hand-built ChartLowerSpec; these pin the other half — that the server
//  renderer's chart arm actually carries the declared wire fields
//  (`valueFormat`, `xTitle`, `yTitle`, `subtitle`, `legendPosition`,
//  `dataLabels`) into the spec, so a dropped field cannot silently regress to
//  the lowering's defaults again (the TS twin of the Python
//  `test_ssr_bridge_passes_*` family). Each test asserts a NEGATIVE control
//  first — the same wire with the declaration stripped must NOT carry the
//  needle — so the positive assertion cannot pass vacuously.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml } from '../src/index.js';

const renderWire = (kind: Record<string, unknown>): string => {
  const decoded = decodeNode(
    JSON.stringify({ id: 'chart-bridge', kind: { $type: 'Chart', ...kind } }),
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  const html = renderToHtml(decoded.value);
  expect(html).toContain('<svg');
  expect(html).not.toContain('fuaran-chart-placeholder');
  return html;
};

describe('SSR chart bridge — declared wire fields reach the lowering', () => {
  it('carries valueFormat, the axis titles, and the subtitle (Phases 876/878)', () => {
    // Discriminating values: the axis titles DIFFER from the capitalised
    // field-name fallbacks and the format is Percent, so each assertion fails
    // individually if its field is dropped by the bridge.
    const base = {
      kind: 'Bar',
      xField: 'quarter',
      yFields: ['share'],
      stacked: false,
      source: {
        $type: 'Static',
        value: [
          { quarter: 'Q1', share: 0.42 },
          { quarter: 'Q2', share: 0.55 },
        ],
      },
    };
    // Negative control: without the declarations, none of the needles exist.
    const stripped = renderWire(base);
    expect(stripped).not.toContain('Fiscal quarter');
    expect(stripped).not.toContain('Segment share');
    expect(stripped).not.toContain('Share of segment');
    expect(stripped).not.toContain('>0%<'); // no percent tick

    const html = renderWire({
      ...base,
      title: 'Market share',
      subtitle: 'Share of segment',
      xTitle: 'Fiscal quarter',
      yTitle: 'Segment share',
      valueFormat: { $type: 'Percent' },
    });
    expect(html).toContain('Fiscal quarter'); // xTitle (fallback would be "Quarter")
    expect(html).toContain('Segment share'); // yTitle (fallback would be "Share")
    expect(html).toContain('Share of segment'); // subtitle (absent without the bridge)
    expect(html).toContain('>0%<'); // valueFormat Percent (a bare "0" tick without it)
  });

  it('carries legendPosition (Phase 880)', () => {
    // Two halves, each discriminating against the default (`Right`): a declared
    // `Bottom` must move the legend (a different picture from the same wire
    // with the declaration stripped), and an explicit `"None"` suppresses the
    // series labels a two-series default legend draws as text nodes.
    const base = {
      kind: 'Bar',
      xField: 'region',
      yFields: ['alpha_series', 'beta_series'],
      stacked: false,
      source: {
        $type: 'Static',
        value: [
          { region: 'North', alpha_series: 80, beta_series: 100 },
          { region: 'South', alpha_series: 130, beta_series: 110 },
        ],
      },
    };
    const defaultHtml = renderWire(base);
    // Positive control first: the default legend draws the series names.
    expect(defaultHtml).toContain('>alpha_series<');
    expect(defaultHtml).toContain('>beta_series<');

    const bottomHtml = renderWire({ ...base, legendPosition: 'Bottom' });
    expect(bottomHtml).not.toBe(defaultHtml); // the declared edge moved the legend

    const noneHtml = renderWire({ ...base, legendPosition: 'None' });
    expect(noneHtml).not.toContain('>alpha_series<');
    expect(noneHtml).not.toContain('>beta_series<');
  });

  it('carries dataLabels (Phase 881)', () => {
    // `120` appears as a text node ONLY as a data label — this chart's axis
    // ticks are 0/50/100/150, so `>120<` cannot be an axis tick. Negative
    // control first: `Off` (the absent-field default) writes no values.
    const base = {
      kind: 'Bar',
      xField: 'quarter',
      yFields: ['revenue'],
      stacked: false,
      source: {
        $type: 'Static',
        value: [
          { quarter: 'Q1', revenue: 120 },
          { quarter: 'Q2', revenue: 150 },
        ],
      },
    };
    const offHtml = renderWire(base);
    expect(offHtml).not.toContain('>120<');
    expect(offHtml).not.toContain('font-size="12px"');

    const html = renderWire({ ...base, dataLabels: 'Ends' });
    expect(html).toContain('>120<'); // the cap label the bridge now carries
    // …set at the data-label size, which no chrome label uses.
    expect(html).toContain('font-size="12px"');
  });
});
