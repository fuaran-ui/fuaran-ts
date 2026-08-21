// ============================================================================
//  The `Chart` node → chart-lowering bridge.
//
//  ONE statement of which declared `ChartSpec` fields cross into the lowering,
//  shared by the React client renderer (`render/Visualisation.tsx`) and the
//  string server renderer's twin — the same shape `drawingSvg` takes, and for
//  the same reason: two copies of this decision is exactly how a field comes to
//  be honoured on one surface and silently dropped on the other. It was two
//  copies until now, and they had already drifted — the client threaded five
//  fields, the server six, and `ChartSpec` declares twelve that belong here.
//
//  EVERY semantic field `ChartSpec` declares crosses. The lowering owns the
//  geometry; the spec owns the meaning, and a meaning the author declared but
//  the picture does not carry is a silent misdrawing, not a missing nicety —
//  `valueFormat: Currency GBP` renders an axis with no `£`, and
//  `xScale: Temporal` renders evenly-spaced category bands where dates belong.
//  A field that is NOT here is a style knob (`ChartLowerStyle`) or a host
//  concern (`source`, `onPointClick`); the per-field bridge test enumerates
//  `keyof ChartSpec` so a newly-declared field cannot join without a verdict.
//
//  ── The `TextSource` rule (deliberate, and stated because it LOSES something)
//
//  The four `TextSource`-typed fields — `title` and Phase 878's `xTitle` /
//  `yTitle` / `subtitle` — cross as a LITERAL ONLY. A `Bound` or `I18n` arm is
//  DROPPED, and the lowering's own fallback stands (an axis title falls back to
//  its capitalised field name, so an axis is never nameless; a title or
//  subtitle simply does not draw).
//
//  Dropped rather than resolved, even though this renderer holds the binding
//  sources and could resolve a `Bound` arm here, because `ChartLowerSpec` takes
//  plain `string`s: whatever the bridge resolves is BAKED INTO the lowered
//  geometry — the text is measured for the axis margins, for truncation, and
//  for the legend-band overflow predicate. Resolving here would make a
//  drawing's LAYOUT a function of live binding state, which is the kind of
//  cross-surface divergence this bridge exists to end rather than a second one
//  to open, and `I18n` cannot be honest at all: the lowering carries no
//  catalogue.
//
//  This mirrors the Python host's `_lower_chart` gate, whose `literal_text`
//  likewise yields nothing for a non-literal arm — the two hosts whose lowering
//  input is string-typed agree. It is NOT what the F# and Rust hosts do: their
//  lowering carries the `TextSource` itself into the drawing, so bound and i18n
//  arms resolve at render time. Closing THAT residue is a `ChartLowerSpec`
//  contract change across every host — a phase, not a bridge fix.
// ============================================================================

import type { ChartSpec, TextSource } from '@fuaran-ui/schema';
import type { ChartLowerSpec } from '@fuaran-ui/charts';

/** The literal text of a `TextSource`, or nothing for the bound / i18n arms
 * (see the `TextSource` rule above). */
const literalText = (source: TextSource | undefined): string | undefined =>
  source !== undefined && source.kind === 'Literal' ? source.value : undefined;

/**
 * Project a tree-level `ChartSpec` onto the neutral `ChartLowerSpec` the
 * `@fuaran-ui/charts` lowering reads. Absent stays absent: an optional field is
 * omitted rather than passed as `undefined`, so the lowering's documented
 * default applies and a pre-field tree lowers byte-for-byte as before.
 */
export const chartLowerSpecOf = <TMsg>(spec: ChartSpec<TMsg>): ChartLowerSpec => {
  const title = literalText(spec.title);
  const xTitle = literalText(spec.xTitle);
  const yTitle = literalText(spec.yTitle);
  const subtitle = literalText(spec.subtitle);
  return {
    kind: spec.kind,
    xField: spec.xField,
    yFields: spec.yFields,
    stacked: spec.stacked,
    ...(title !== undefined ? { title } : {}),
    // Phase 876 — the declared value-axis number format (the axis UNIT MODE is
    // a style selector, not a wire field, and is never read here).
    ...(spec.valueFormat !== undefined ? { valueFormat: spec.valueFormat } : {}),
    // Phase 878 — the axis names + the muted subtitle. The field-name fallback
    // is the lowering's, not the bridge's, so absent must stay absent.
    ...(xTitle !== undefined ? { xTitle } : {}),
    ...(yTitle !== undefined ? { yTitle } : {}),
    ...(subtitle !== undefined ? { subtitle } : {}),
    // Phase 880 — the legend edge. Absent means the host default (`Right`);
    // suppression is the explicit `'None'`.
    ...(spec.legendPosition !== undefined ? { legendPosition: spec.legendPosition } : {}),
    // Phase 881 — whether the values are written onto the picture. Absent means
    // `'Off'`, which is also the default.
    ...(spec.dataLabels !== undefined ? { dataLabels: spec.dataLabels } : {}),
    // Phase 882 — what the x column MEANS. Absent means `'Category'`, which is
    // also the default, so a pre-882 chart lowers unchanged.
    ...(spec.xScale !== undefined ? { xScale: spec.xScale } : {}),
  };
};
