// ============================================================================
//  @fuaran-ui/charts — render-time Chart → Drawing lowering (S4 cross-host parity).
//
//  `Chart` stays a SEMANTIC wire kind; this module is the bounded layout engine
//  that turns a resolved chart spec + data rows into a canonical `Drawing` subtree
//  (scales, ticks, axes, gridlines, legend, series geometry) — so a chart renders
//  as first-party inline SVG on every host, headless included, and a new chart type
//  is a lowering rule + fixtures rather than bespoke per-host drawing.
//
//  Lowered arms: Bar (grouped + stacked), Line, Area (overlaid + stacked),
//  Scatter (linear numeric x, point marks), Pie (polar, cubic-approximated
//  wedges; the donut variant is deferred F#-side and mirrored as deferred here).
//
//  Deterministic (R2): a fixed pixel viewBox, a `{1,2,5}·10ⁿ` nice-tick rule, and
//  round-half-up coordinate rounding to 2 dp, so the output depends only on the
//  spec + data (never on enumeration order or platform float print). This is a
//  byte-for-byte port of the F# reference `Fuaran.UI.Charts.lower`; the shared
//  `wire-format-fixtures/chart-lowering/*` corpus certifies the parity.
//
//  Mark identity (Phase 642): every data-bearing shape carries a
//  derivation-based `markId` (`series-field|category-key`, or the series field
//  alone for one-shape-per-series geometry), stable under row reorder and data
//  refresh (object constancy). Chrome (axes, gridlines, labels, legend) stays
//  unstamped — its identity is structural, not data-borne.
//
//  Chrome + text ink is surface-relative (`currentColor` + per-role opacity), never
//  a spec wire field; series (categorical data) colours stay hex. See
//  `docs/CHARTS-DRAWING-PRIMITIVE-DESIGN.md` (S4, D8).
// ============================================================================

// The package entry re-exports the public surface; the implementation lives in
// one module per section (Phase 2076). Adding an export here is a public-surface
// change; a module-internal `export` that is not listed here is not one.

export { textFitsBox } from './textMetrics.js';
export { type ChartAxisUnitMode } from './numberFormat.js';
export { type ChartLowerSpec, type ChartLowerStyle, type ChartRow, isLowered } from './spec.js';
export { lower, lowerNode } from './lower.js';
export { lowerSparklineNode, tryLowerSparkline } from './sparkline.js';
