// @fuaran-ui/charts — the Sparkline → Drawing lowering (Phase 1099).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type { DrawPoint, DrawingSpec, Node, ViewBox } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

import { INK, r2 } from './layout.js';
import { polyline, styleStroke } from './shapes.js';

// ─── Sparkline → Drawing lowering (Phase 1099; Phase 644's D7) ───────────────
//
//  The ONE sparkline lowering this repo has. It replaces two hand-written
//  polyline builders — one in the React client renderer's `Display.tsx`, one in
//  the string server renderer's `render.ts` — that computed the same geometry
//  from the same algorithm and emitted byte-identical pictures, side by side in
//  the same repo, while `Drawing` next door had shared `drawingSvg` since Phase
//  525. Two copies of a geometry rule is how the two tiers come to disagree; the
//  point of this seam is that they now cannot.
//
//  It lives beside `lower` rather than in either renderer for the reason the
//  chart lowering does: a sparkline's geometry is a CONTRACT every conformant
//  host reproduces byte-for-byte, pinned by the shared
//  `wire-format-fixtures/sparkline-lowering/*` goldens the F# reference emits,
//  and a contract cannot live inside one surface's renderer.
//
//  The markup consequence, which is deliberate and is what the reference host
//  shipped: the `fuaran-sparkline` class moves to a CONTAINER element, and the
//  picture inside it is the shared builder's `fuaran-drawing` root. That
//  container is where the 100×30 sizing and the inherited `color` the
//  `currentColor` stroke reads have always lived, so the styling hook survives
//  and the picture does not move. `preserveAspectRatio="none"` is not carried
//  and is not needed: the container is exactly 100×30 and so is the viewBox.
//
//  NON-FINITE VALUES are NOT special-cased. They propagate through the
//  arithmetic exactly as they did in the retired builders, reach the wire as the
//  canonical `"NaN"` / `"Infinity"` string sentinels, and render as `0` through
//  `drawingSvg`'s number form. `sparkline-lowering/nonfinite-sentinel` pins the
//  result, which is the point: the recorded cross-host decode divergences live
//  in this input class, and a pinned contract is what makes one a failing test
//  rather than an argument.

/** The sparkline canvas — 100 × 30 user units, the viewBox every host has
 * emitted since the kind shipped. */
const SPARKLINE_VIEW_BOX: ViewBox = { minX: 0.0, minY: 0.0, width: 100.0, height: 30.0 };

/** The shipped sparkline stroke width. Corpus-pinned by `sparkline-lowering/*`. */
const SPARKLINE_STROKE_WIDTH = 1.5;

/** The vertical inset the shipped geometry keeps at each edge, so a peak or a
 * trough is not clipped by the stroke's own width. */
const SPARKLINE_INSET = 1.0;

/** The plotted height — the canvas less one inset at each edge. */
const SPARKLINE_PLOT_HEIGHT = 28.0;

/** The shipped flat-series guard: a range below this is treated as 1.0, which
 * places a constant series on its own line rather than dividing by zero. */
const SPARKLINE_FLAT_EPSILON = 1e-9;

/**
 * Lower a RESOLVED `Sparkline` series to the canonical `DrawingSpec` every
 * conformant host reproduces byte-for-byte — or `null` when there is nothing to
 * draw, which is the caller's cue to render its own declared fallback element.
 *
 * `null` rather than an empty canvas, and the goldens spell it the same way: the
 * fallback (`fuaran-sparkline-empty` carrying an em-dash) is a HOST element
 * rather than a `Shape`, so the lowering cannot express it and must not pretend
 * to by drawing an empty box nobody can read. An ABSENT series and an EMPTY one
 * mean the same thing to a reader and take the same branch — the renderers reach
 * here through `asArray`, which already collapses a non-array binding value to
 * `[]`, so a resolved-but-absent series arrives as the empty case rather than as
 * a fault. (The reference host carries that same collapse inside its own
 * lowering, because F# resolves an absent list slot to `null`.)
 */
export const tryLowerSparkline = (series: readonly number[]): DrawingSpec | null => {
  const n = series.length;
  if (n === 0) return null;

  // A `<` / `>` COMPARISON FOLD seeded on the first element, and never a spread.
  //
  // The fold mirrors the reference's `Array.min` / `Array.max`, which replace
  // the accumulator only on a true comparison. An IEEE comparison against NaN
  // is always false, so a NaN NEVER becomes the extent: it flows on as one
  // poisoned coordinate while its neighbours keep their true positions. That is
  // the cross-host contract — `fuaran-go`, `fuaran-rs` and `fuaran-py` all fold
  // the same way. `Math.min` / `Math.max` would PROPAGATE the NaN into the
  // extent and through it into every coordinate in the series, which is a
  // divergence rather than a stricter reading of the sentinel rule: non-finite
  // values are still not special-cased here, and a NaN element still reaches
  // the wire as the canonical `"NaN"` sentinel through its own coordinate.
  //
  // `sparkline-lowering/nonfinite-sentinel` does NOT discriminate the two, and
  // that is worth stating because it is why this rule once went the other way:
  // that fixture carries both infinities, so the comparison fold reaches
  // -Infinity/+Infinity and the propagating form reaches NaN/NaN, and both then
  // emit all-NaN coordinates by different routes. The golden is satisfied
  // either way. A NaN with no infinity is the discriminating input, and it is
  // pinned by a host test in `test/sparkline-lowering.test.ts`.
  //
  // A fold rather than `Math.min(...series)` for the reason that form was
  // avoided originally, which was sound: a spread has an argument-count ceiling
  // to blow on a long series.
  let minV = series[0]!;
  let maxV = series[0]!;
  for (let i = 1; i < n; i++) {
    const v = series[i]!;
    if (v < minV) minV = v;
    if (v > maxV) maxV = v;
  }

  const range = maxV - minV < SPARKLINE_FLAT_EPSILON ? 1.0 : maxV - minV;

  const points: readonly DrawPoint[] = series.map((v, i) => ({
    // A lone point is CENTRED rather than dividing by `n - 1 = 0`.
    x: r2(n <= 1 ? 50.0 : (i / (n - 1)) * 100.0),
    y: r2(
      SPARKLINE_VIEW_BOX.height - ((v - minV) / range) * SPARKLINE_PLOT_HEIGHT - SPARKLINE_INSET,
    ),
  }));

  return {
    viewBox: SPARKLINE_VIEW_BOX,
    shapes: [polyline(points, styleStroke(INK, SPARKLINE_STROKE_WIDTH))],
    style: {},
    // No `title` / `description`: a sparkline carries no spec to generate an
    // accessible summary from, so it carries no accessible name of its own. The
    // absence is part of the pinned contract, not an omission — see the golden
    // family's README.
  };
};

/**
 * Lower + wrap the `Drawing` kind in a node envelope (id + kind) — the sibling
 * of {@link lowerNode}, and the shape the `sparkline-lowering/*` goldens encode.
 * `null` for the nothing-to-draw case, which those goldens spell as the JSON
 * literal `null`.
 */
export const lowerSparklineNode = (id: string, series: readonly number[]): Node<never> | null => {
  const spec = tryLowerSparkline(series);
  if (spec === null) return null;
  return {
    id: nodeId(id),
    kind: { kind: 'Display', display: { kind: 'Drawing', spec } },
    state: defaults.stateBehaviour<never>(),
    style: defaults.style,
  };
};
