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
//  ── The `TextSource` rule (Phase 1143)
//
//  The four `TextSource`-typed fields — `title` and Phase 878's `xTitle` /
//  `yTitle` / `subtitle` — cross UNRESOLVED, whichever arm they carry. The
//  lowering reaches its labels with the `TextSource` itself, and a `Bound` or
//  `I18n` arm resolves at RENDER time, where this renderer's binding sources
//  and catalogue are.
//
//  It is deliberately not resolved HERE, even though this renderer holds the
//  sources: whatever the bridge resolved would be BAKED INTO the lowered
//  geometry — measured for the axis margins, for truncation, and for the
//  legend-band overflow predicate — which would make a drawing's LAYOUT a
//  function of live binding state, and `I18n` could not be honest at all
//  because the lowering carries no catalogue. The lowering's own rules are
//  arranged so it never needs to be: space is reserved by the PRESENCE of these
//  fields, and truncation is confined to the `Literal` arm.
//
//  Until Phase 1143 the four fields crossed as a LITERAL ONLY and a `Bound` or
//  `I18n` arm was DROPPED here — an authored title vanishing from a localised
//  chart, an authored axis name silently replaced by a capitalised column name.
//  The Python host's bridge dropped them the same way; the F# and Rust hosts
//  already carried them. Same wire, two behaviours. The recorded contract is
//  the reference host's `docs/CHART-LOWERING-TEXT-CONTRACT.md`, and the
//  `chart-lowering/bar-bound-i18n-titles` corpus fixture pins it on every host.
// ============================================================================

import type { ChartSpec } from '@fuaran-ui/schema';
import type { ChartLowerSpec } from '@fuaran-ui/charts';

/**
 * Project a tree-level `ChartSpec` onto the neutral `ChartLowerSpec` the
 * `@fuaran-ui/charts` lowering reads. Absent stays absent: an optional field is
 * omitted rather than passed as `undefined`, so the lowering's documented
 * default applies and a pre-field tree lowers byte-for-byte as before.
 */
export const chartLowerSpecOf = <TMsg>(spec: ChartSpec<TMsg>): ChartLowerSpec => {
  return {
    kind: spec.kind,
    xField: spec.xField,
    yFields: spec.yFields,
    stacked: spec.stacked,
    // Phase 1143 — every arm crosses, unresolved (the `TextSource` rule above).
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    // Phase 876 — the declared value-axis number format (the axis UNIT MODE is
    // a style selector, not a wire field, and is never read here).
    ...(spec.valueFormat !== undefined ? { valueFormat: spec.valueFormat } : {}),
    // Phase 878 — the axis names + the muted subtitle. The field-name fallback
    // is the lowering's, not the bridge's, so absent must stay absent.
    ...(spec.xTitle !== undefined ? { xTitle: spec.xTitle } : {}),
    ...(spec.yTitle !== undefined ? { yTitle: spec.yTitle } : {}),
    ...(spec.subtitle !== undefined ? { subtitle: spec.subtitle } : {}),
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
