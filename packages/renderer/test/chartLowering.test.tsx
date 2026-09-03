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

import { FuaranRenderer, chartLowerSpecOf } from '../src/index.js';

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

// ============================================================================
//  The node → lowering BRIDGE, field by field.
//
//  Every semantic field `ChartSpec` declares has to reach the lowering, or the
//  picture silently contradicts the tree. The whole class survived five phases
//  (876 / 878 / 880 / 881 / 882 — seven fields, since 878 landed three)
//  precisely because nothing asserted the bridge:
//  the fields decoded, the wire round-tripped, the summary described the
//  reduced spec it was handed — and the chart drew the wrong thing.
//
//  Two guards, because either alone is escapable:
//    1. a COMPILE-TIME disposition map over `keyof ChartSpec`, so a newly
//       declared field cannot be added to the wire type without someone
//       writing down whether it crosses (a missing key fails `pnpm typecheck`);
//    2. a RUNTIME per-field assertion that setting the field changes both the
//       projected lower spec and the rendered picture, so "declared threaded"
//       and "actually threaded" cannot diverge.
// ============================================================================

/**
 * What each `ChartSpec` field is, as far as the lowering bridge is concerned.
 * Typed as a total record over `keyof ChartSpec`, so adding a field to the wire
 * type breaks this file until its disposition is stated.
 */
type BridgeDisposition =
  // Crosses as-is (an enum or a structural format record).
  | 'threaded'
  // A `TextSource` field: crosses UNRESOLVED, whichever arm it carries — the
  // Phase 1143 text contract (see `src/chartLowerSpec.ts`).
  | 'threaded-text-source'
  // Not a lowering input: a host concern (the data source, an event handler).
  | 'not-a-lowering-input';

const BRIDGE_DISPOSITIONS: Record<keyof ChartSpec<never>, BridgeDisposition> = {
  source: 'not-a-lowering-input',
  onPointClick: 'not-a-lowering-input',
  kind: 'threaded',
  xField: 'threaded',
  yFields: 'threaded',
  stacked: 'threaded',
  title: 'threaded-text-source',
  xTitle: 'threaded-text-source',
  yTitle: 'threaded-text-source',
  subtitle: 'threaded-text-source',
  valueFormat: 'threaded',
  legendPosition: 'threaded',
  dataLabels: 'threaded',
  xScale: 'threaded',
};

const currencyRows = [
  { quarter: 'Q1', revenue: 12500000, cost: 8100000 },
  { quarter: 'Q2', revenue: 15200000, cost: 9400000 },
];

const temporalRows = [
  { day: '2026-01-05', sessions: 1200 },
  { day: '2026-01-26', sessions: 1580 },
];

const baseSpec: ChartSpec<never> = {
  source: { kind: 'Static', value: currencyRows },
  kind: 'Bar',
  xField: 'quarter',
  yFields: ['revenue', 'cost'],
  stacked: false,
};

const nodeOf = (spec: ChartSpec<never>): Node<never> => ({
  id: nodeId('chart-bridge'),
  kind: { kind: 'Visualisation', visualisation: { kind: 'Chart', spec } },
  state: defaults.stateBehaviour<never>(),
  style: defaults.style,
});

const renderSpec = (spec: ChartSpec<never>): string =>
  renderToStaticMarkup(<FuaranRenderer tree={nodeOf(spec)} />);

/** One case per declared, lowering-bound field: the spec override that sets it,
 * and the key it must appear under in the projected `ChartLowerSpec`. */
const fieldCases: ReadonlyArray<
  readonly [keyof ChartSpec<never>, Partial<ChartSpec<never>>, unknown]
> = [
  [
    'title',
    { title: { kind: 'Literal', value: 'Revenue by quarter' } },
    { kind: 'Literal', value: 'Revenue by quarter' },
  ],
  [
    'xTitle',
    { xTitle: { kind: 'Literal', value: 'Trading quarter' } },
    { kind: 'Literal', value: 'Trading quarter' },
  ],
  [
    'yTitle',
    { yTitle: { kind: 'Literal', value: 'Money in' } },
    { kind: 'Literal', value: 'Money in' },
  ],
  [
    'subtitle',
    { subtitle: { kind: 'Literal', value: 'Millions of £' } },
    { kind: 'Literal', value: 'Millions of £' },
  ],
  [
    'valueFormat',
    { valueFormat: { kind: 'Currency', isoCode: 'GBP' } },
    { kind: 'Currency', isoCode: 'GBP' },
  ],
  ['legendPosition', { legendPosition: 'Bottom' }, 'Bottom'],
  ['dataLabels', { dataLabels: 'Ends' }, 'Ends'],
  ['xScale', { xScale: 'Temporal' }, 'Temporal'],
];

describe('the node → lowering bridge threads every declared chart field', () => {
  it('states a disposition for every field `ChartSpec` declares', () => {
    // The compile-time guard is the `Record<keyof ChartSpec<never>, …>` above;
    // this asserts the two guards agree on WHICH fields the runtime cases cover.
    const declaredThreaded = Object.entries(BRIDGE_DISPOSITIONS)
      .filter(([, d]) => d !== 'not-a-lowering-input')
      .map(([k]) => k)
      .sort();
    const covered = [
      ...new Set([
        ...fieldCases.map(([field]) => field as string),
        'kind',
        'xField',
        'yFields',
        'stacked',
      ]),
    ].sort();
    expect(covered).toEqual(declaredThreaded);
  });

  it('projects the four structural fields unconditionally', () => {
    const lowered = chartLowerSpecOf(baseSpec);
    expect(lowered.kind).toBe('Bar');
    expect(lowered.xField).toBe('quarter');
    expect(lowered.yFields).toEqual(['revenue', 'cost']);
    expect(lowered.stacked).toBe(false);
  });

  it.each(fieldCases)('projects `%s` into the lowering spec', (field, override, expected) => {
    const lowered = chartLowerSpecOf({ ...baseSpec, ...override }) as unknown as Record<
      string,
      unknown
    >;
    expect(lowered[field as string]).toEqual(expected);
  });

  it.each(fieldCases)('omits `%s` when the spec does not declare it', (field) => {
    // Absent must stay ABSENT, not `undefined`: the lowering's documented
    // default applies, so a tree authored before the field existed lowers
    // byte-for-byte as it did.
    expect(Object.hasOwn(chartLowerSpecOf(baseSpec), field as string)).toBe(false);
  });

  it.each(fieldCases)('`%s` visibly changes the rendered picture', (_field, override) => {
    // The assertion that would have caught the original defect: it is not
    // enough for the field to decode — the drawing has to differ.
    const withField = renderSpec({ ...baseSpec, ...override });
    expect(withField).not.toEqual(renderSpec(baseSpec));
  });
});

describe('the threaded fields reach the drawing with their declared meaning', () => {
  it('renders the declared currency unit on the value axis (Phase 876)', () => {
    const html = renderSpec({ ...baseSpec, valueFormat: { kind: 'Currency', isoCode: 'GBP' } });
    expect(html).toContain('£');
    expect(renderSpec(baseSpec)).not.toContain('£');
  });

  it('renders the declared axis titles and subtitle (Phase 878)', () => {
    const html = renderSpec({
      ...baseSpec,
      xTitle: { kind: 'Literal', value: 'Trading quarter' },
      yTitle: { kind: 'Literal', value: 'Money in' },
      subtitle: { kind: 'Literal', value: 'Millions of £' },
    });
    expect(html).toContain('Trading quarter');
    expect(html).toContain('Money in');
    expect(html).toContain('Millions of £');
  });

  it('suppresses the legend entirely at the declared `None` (Phase 880)', () => {
    // A legend entry draws the series name as its own label text node; the
    // per-mark <title>s and the accessible summary also mention the series, so
    // the assertion is on the LABEL, not on the name appearing anywhere.
    const legendEntry = '>revenue<';
    expect(renderSpec(baseSpec)).toContain(legendEntry);
    expect(renderSpec({ ...baseSpec, legendPosition: 'None' })).not.toContain(legendEntry);
  });

  it('reads the x column on a temporal scale when declared (Phase 882)', () => {
    const asCategories: ChartSpec<never> = {
      source: { kind: 'Static', value: temporalRows },
      kind: 'Line',
      xField: 'day',
      yFields: ['sessions'],
      stacked: false,
    };
    // A temporal axis draws its own calendar tick format; a category band axis
    // labels itself with the raw ISO cell strings.
    expect(renderSpec(asCategories)).toContain('2026-01-05');
    expect(renderSpec({ ...asCategories, xScale: 'Temporal' })).not.toContain('2026-01-05');
  });
});

describe('the `TextSource` rule — every arm crosses, unresolved (Phase 1143)', () => {
  // The four TextSource-typed fields cross whichever arm they carry, and the
  // bridge resolves nothing: resolution is the renderer's, at render time. The
  // bridge DROPPED the non-literal arms until Phase 1143, which is how an
  // authored `I18n` title came to vanish from a localised chart. See
  // `src/chartLowerSpec.ts` for the reasoning and the reference host's
  // `docs/CHART-LOWERING-TEXT-CONTRACT.md` for the cross-host contract.
  const bound = {
    kind: 'Bound',
    binding: { kind: 'State', key: 'chartTitle', defaultValue: 'from state' },
  } as const;
  const i18n = { kind: 'I18n', key: 'chart.title', args: {} } as const;

  it('crosses a Literal title', () => {
    expect(chartLowerSpecOf({ ...baseSpec, title: { kind: 'Literal', value: 'Q' } }).title).toEqual(
      { kind: 'Literal', value: 'Q' },
    );
  });

  it.each([
    ['Bound', bound],
    ['I18n', i18n],
  ] as const)('crosses a %s title unresolved', (_arm, source) => {
    expect(chartLowerSpecOf({ ...baseSpec, title: source }).title).toEqual(source);
  });

  it.each([
    ['Bound', bound],
    ['I18n', i18n],
  ] as const)('crosses a %s axis title, so the fallback is not reached', (_arm, source) => {
    const lowered = chartLowerSpecOf({ ...baseSpec, xTitle: source, yTitle: source });
    expect(lowered.xTitle).toEqual(source);
    expect(lowered.yTitle).toEqual(source);
    // The capitalised-field-name fallback answers ABSENCE only (contract
    // clause 5): a declared arm is never replaced by it. The bound title
    // resolves at render time, so what draws is the state default.
    const markup = renderSpec({ ...baseSpec, xTitle: bound });
    expect(markup).toContain('from state');
    expect(markup).not.toContain('>Quarter<');
  });

  it('leaves the axis nameless-proofing intact when nothing is declared', () => {
    expect(chartLowerSpecOf(baseSpec).xTitle).toBeUndefined();
    expect(renderSpec(baseSpec)).toContain('Quarter');
  });
});
