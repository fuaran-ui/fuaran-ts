// @fuaran-ui/charts — the accessible summary (Phase 921).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import { ELLIPSIS } from './textMetrics.js';
import type { ChartLowerSpec } from './spec.js';

// ─── The accessible summary (Phase 921) ──────────────────────────────────────
//
// NORMATIVE CROSS-HOST SPEC, ported verbatim from the F# reference and pinned by
// the `chart-lowering/*` goldens; `docs/CHARTS-DRAWING-PRIMITIVE-DESIGN.md` §4i
// carries the language-neutral statement.
//
// The drawing root is `role="img"`, which presents the chart as ONE graphic and
// does not traverse into it — so the per-mark `<title>`s are never announced.
// Operator decision 2026-08-18: the root keeps that role, and the lowering
// generates a deterministic summary as the drawing's `description`, which the
// SVG builder wires to the root's `aria-label`. The title is NOT part of the
// summary: it is a `TextSource` whose bound/i18n arms resolve only at render
// time, so the builder composes it in front instead.

/** The clause separator + terminator. Periods, not commas: a screen reader
 * pauses at a sentence boundary. */
export const SUMMARY_CLAUSE_SEPARATOR = '. ';

/** At most this many series are NAMED before the summary folds the rest into a
 * count — a legibility bound, not a technical one. */
export const SUMMARY_MAX_SERIES_NAMED = 4;

/** At most this many ANNOTATIONS are named in one annotation clause (Phase 1494)
 * before that clause folds the rest into a count — the same legibility bound
 * `SUMMARY_MAX_SERIES_NAMED` states, for the same reason, over a different list.
 * It is a SEPARATE constant rather than a reuse of that one because the two lists
 * are different things: a chart carrying twenty markers and four series is an
 * ordinary chart, and a future decision to fold one list sooner must not silently
 * move the other. */
export const SUMMARY_MAX_ANNOTATIONS_NAMED = 4;

/** The per-NAME character cap (a series field, a category label) — untrusted
 * strings straight off the data feed. */
export const SUMMARY_MAX_NAME_CHARS = 32;

/** The whole summary's character cap. */
export const SUMMARY_MAX_CHARS = 320;

/** Truncate to at most `maxChars`, marking the cut with the ellipsis. The cut
 * never splits a UTF-16 surrogate pair — a boundary landing between a high and a
 * low surrogate moves one unit earlier. */
export const clampText = (maxChars: number, s: string): string => {
  if (s.length <= maxChars) return s;
  let cut = maxChars - 1;
  const prev = s.charCodeAt(cut - 1);
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + ELLIPSIS;
};

/** The chart's kind in words. `stacked` earns a word only on the two arms where
 * it changes the geometry — the same rule the lowering itself applies. */
export const summaryKindWords = (kind: ChartLowerSpec['kind'], stacked: boolean): string => {
  switch (kind) {
    case 'Bar':
      return stacked ? 'Stacked bar chart' : 'Bar chart';
    case 'Line':
      return 'Line chart';
    case 'Area':
      return stacked ? 'Stacked area chart' : 'Area chart';
    case 'Scatter':
      return 'Scatter chart';
    case 'Pie':
      return 'Pie chart';
    default:
      return 'Heatmap chart';
  }
};
