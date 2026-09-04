# @fuaran-ui/charts

Render-time **lowering to `Drawing`** for the Fuaran UI wire format — the bounded,
deterministic layout engine that turns a semantic chart spec + data rows into a
canonical themed `Drawing` subtree (scales, ticks, axes, gridlines, legend, series
geometry), and the `Sparkline` lowering beside it. The TypeScript twin of the F#
reference lowerings.

A `Chart` stays a **semantic** wire kind; this module lowers it at render time to
the closed, typed `Shape` vocabulary of `@fuaran-ui/schema`, so a chart renders as
first-party inline SVG on every conformant host — no third-party charting engine.

```ts
import { lower, lowerNode } from '@fuaran-ui/charts';
import { encodeNode } from '@fuaran-ui/ops';

const spec = {
  kind: 'Bar',
  xField: 'quarter',
  yFields: ['revenue'],
  title: 'Revenue by quarter',
} as const;
const rows = [
  { quarter: 'Q1', revenue: 120 },
  { quarter: 'Q2', revenue: 150 },
];

const drawing = lower(spec, rows); // a DrawingSpec
const wire = encodeNode(lowerNode('chart-revenue', spec, rows)); // canonical JSON
```

## Sparkline

A `Sparkline` carries a bare bound series and nothing else, so every host that
draws one has to turn that series into geometry — and this is the ONE place this
repository does it. Both renderers (`@fuaran-ui/renderer` and
`@fuaran-ui/renderer-server`) call it, so they cannot draw a different picture;
before it landed they each carried a hand-written copy of the same algorithm.

```ts
import { tryLowerSparkline } from '@fuaran-ui/charts';

const drawing = tryLowerSparkline([1, 2, 3, 2, 4]); // a DrawingSpec, or null
```

`null` is the **nothing-to-draw** case: an empty (or unresolved, and so
array-coerced-to-empty) series has no polyline, and the fallback a renderer emits
instead — its own hook element carrying an em-dash — is a _host_ element rather
than a `Shape`, so the lowering cannot express it and must not pretend to by
returning an empty canvas. The goldens spell the same fact as the JSON literal
`null`.

The geometry, over a series of `n` values with `min` and `max`: a
`viewBox="0 0 100 30"` canvas; `range = max - min`, or `1.0` when
`max - min < 1e-9` so a constant series sits on its own line rather than dividing
by zero; `x = i / (n - 1) * 100`, and `50` when `n = 1` so a lone point is
centred; `y = 30 - (v - min) / range * 28 - 1`, one unit of inset at each edge so
a peak is not clipped by the stroke; round-half-up to 2 dp on both coordinates;
one `Polyline`, `stroke="currentColor"`, `stroke-width="1.5"`, no fill. No title
or description — a sparkline has no spec to generate an accessible summary from,
so it carries no accessible name of its own.

**Non-finite values are not special-cased.** They propagate through that
arithmetic, reach the wire as the canonical `"NaN"` / `"Infinity"` /
`"-Infinity"` string sentinels, and render as `0` through the drawing builder's
number form. The shared `wire-format-fixtures/sparkline-lowering/*` corpus pins
every case, this one included.

## Chart-kind coverage (this host)

`isLowered(kind)` is the dispatch authority — the render branch and the arm set
can never drift apart.

| `ChartKind` | Lowered? | Geometry                                                                                                                                                                                                                                                                                                                                                           |
| ----------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Bar`       | ✅ yes   | grouped bars; `stacked: true` stacks segments by per-category cumulative sum                                                                                                                                                                                                                                                                                       |
| `Line`      | ✅ yes   | one polyline per series over band centres                                                                                                                                                                                                                                                                                                                          |
| `Area`      | ✅ yes   | translucent baseline-closed bands + full-strength series edge; `stacked: true` stacks cumulative bands                                                                                                                                                                                                                                                             |
| `Scatter`   | ✅ yes   | fixed-radius point marks on a linear (non-zero-anchored) numeric x-domain                                                                                                                                                                                                                                                                                          |
| `Pie`       | ✅ yes   | polar single-series wedges (cubic-Bézier arcs, 12-o'clock start, clockwise); zero-value categories keep their legend row; a lone 100% category degenerates to a `Circle`. Multi-series or negative values refuse the geometry. The donut variant is not lowered yet (deferred in the reference implementation; this host mirrors exactly what the reference ships) |
| `Heatmap`   | ❌ no    | falls back to the host placeholder (`fuaran-chart-placeholder`); its lowering rule lands with its own phase                                                                                                                                                                                                                                                        |

`stacked: true` on a kind where stacking is meaningless (`Line`, `Scatter`,
`Pie`) is ignored — the flag only changes `Bar` / `Area` geometry.

## Mark identity

Every **data-bearing** shape carries a derivation-based `markId` on its
`DrawStyle` (`series-field|category-key`, or the series field alone for
one-shape-per-series geometry such as `Line` / `Area`), stable under row
reorder and data refresh (object constancy). Renderers emit it as
`data-fuaran-mark` on the corresponding SVG element. Chrome (axes, gridlines,
labels, legend) deliberately stays unstamped — its identity is structural, not
data-borne.

## Determinism (R2)

The layout is a **byte-for-byte** port of the F# reference lowering: a fixed pixel
viewBox, a `{1,2,5}·10ⁿ` nice-tick rule, and round-half-up coordinate rounding to
2 dp, so the output depends only on the spec + data. The shared
`wire-format-fixtures/chart-lowering/*` corpus certifies parity across the F#,
TypeScript, and Python hosts.

## Theme

Chrome + text ink is **surface-relative** (`currentColor` at a per-role opacity),
never a spec wire field — a lowered chart inherits the surface's own text colour and
is legible on a light or dark surface with no CSS override. Series (categorical data)
colours stay hex so they read distinctly on both surfaces.

Apache-2.0.
