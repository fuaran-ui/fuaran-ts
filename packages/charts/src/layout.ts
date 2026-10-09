// @fuaran-ui/charts — the fixed canonical drawing space: layout constants,
// surface-relative ink, axis chrome and mark geometry, annotation ink, and the
// deterministic numeric helpers.
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type { ChartLegendPosition } from '@fuaran-ui/schema';

// ─── Layout constants (the fixed canonical drawing space) ────────────────────

export const W = 640.0;
export const H = 400.0;
export const MARGIN_TOP = 64.0; // title + legend band
export const MARGIN_RIGHT = 28.0;
/** Phase 879 — the FLOOR of the autosized bottom margin (category labels + the
 * x-axis title). A tilted or vertical label needs room to fall into. */
export const MARGIN_BOTTOM = 56.0;
/** Phase 879 — the FLOOR of the autosized left margin (right-aligned y-axis
 * tick labels). The value is derived from the widest FORMATTED tick. */
export const MARGIN_LEFT = 64.0;

/** Ceiling on the autosized left margin, as a share of the canvas width. */
export const MARGIN_LEFT_MAX_SHARE = 0.3;
/** Ceiling on the autosized bottom margin, as a share of the canvas height. */
export const MARGIN_BOTTOM_MAX_SHARE = 0.35;
/** Breathing room between an autosized margin's content and the canvas edge —
 * also absorbs the few percent by which a real font differs from the table. */
export const AXIS_LABEL_PADDING = 6.0;

// The plot rectangle is NOT a module constant since Phase 879: it depends on
// the text the chart is going to print, so it is computed per lowering.

// A fixed, deterministic categorical palette (series index → colour).
//
// Phase 875 palette v2 — 8 slots, fixed assignment order. Validated on BOTH
// surfaces (light #fcfcfb, dark #1a1a19) against the OKLab gate set:
// lightness band, chroma floor, adjacent-pair CVD ΔE (protan + deutan, Machado
// 2009 at severity 1.0), adjacent-pair normal-vision ΔE. The ASSIGNMENT ORDER
// is load-bearing — the gates are measured over ADJACENT pairs — so this array
// must never be sorted or re-ordered.
const PALETTE = [
  '#1a86ac', // loch blue
  '#bf831c', // ochre
  '#a51574', // magenta
  '#21a766', // green
  '#6454e5', // violet
  '#af153d', // crimson
  '#21a2b2', // teal
  '#d3241b', // vermilion
] as const;

export const colourFor = (i: number): string => PALETTE[i % PALETTE.length]!;

// ─── Surface-relative ink (theme-aware chart lowering, S4 / D8) ───────────────
export const INK = 'currentColor';
export const AXIS_OPACITY = 0.8;
export const GRID_OPACITY = 0.12;
export const LABEL_OPACITY = 0.66;

/** A translucent categorical fill (Phase 637 — area bands). The gridlines stay
 * legible through the band; the series' full-strength Polyline edge on top
 * carries the categorical colour at full contrast. Phase 875 dropped this to
 * a wash: at 0.35 two overlaid bands read as a third colour and the chrome
 * beneath them disappears. */
export const AREA_FILL_OPACITY = 0.12;

// ─── Axis chrome + mark geometry constants (Phase 875) ────────────────────────

/** Gap between the y-axis spine and the right edge of a tick label. */
export const TICK_LABEL_GAP = 12.0;

/** Length of the small OUTSIDE tick marks on both axes: y-axis marks run left
 * from the spine, x-axis marks run down from it, so neither eats plot area. One
 * per y tick and — since Phase 903 — one per BAND BOUNDARY on a category axis
 * (`n+1` for `n` bands, delimiting the groups rather than pointing at their
 * centres), or one per x tick on the Scatter arm, whose x is continuous. */
export const TICK_MARK_LENGTH = 5.0;

/** Hard pixel ceiling on a single bar's thickness. The bar takes the MIN of
 * its band share and this cap, and is then centred in its slot. */
export const BAR_MAX_THICKNESS = 28.0;

/** GEOMETRIC gap between consecutive segments of a stacked bar — the segment
 * is shortened on the side facing the next segment. */
export const STACK_SEGMENT_GAP = 2.0;

/** GEOMETRIC angular padding between pie wedges, in DEGREES — half is taken
 * from each end of every wedge's sweep. */
export const WEDGE_GAP_DEGREES = 0.75;

// The chart's own font stack — carried in the wire so a lowered chart is
// self-contained + legible on every host without host CSS.
export const CHART_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Font size of tick labels, category labels, axis titles and legend text. */
export const TICK_FONT_SIZE = 13.0;
/** A line's height as a multiple of its font size (Phase 879). */
export const TEXT_LINE_HEIGHT_FACTOR = 1.2;
/** Drop from the x-axis spine to the category / x-tick label baseline. */
export const CATEGORY_LABEL_OFFSET_Y = 20.0;
/** Distance from the canvas bottom to the x-axis title's BASELINE. */
export const AXIS_TITLE_BOTTOM_OFFSET = 12.0;
/** Phase 878 — the subtitle's font size (below the 18 px title) and baseline. */
export const SUBTITLE_FONT_SIZE = 13.0;
export const SUBTITLE_BASELINE_Y = 38.0;
/**
 * Phase 878 — the ROTATED y-axis title: the x of its baseline measured from the
 * canvas LEFT EDGE (not the autosized margin, so it does not slide about as
 * tick widths change), and the MAGNITUDE of its rotation. Emitted as `-degrees`
 * — `rotation` is clockwise, so the negative angle reads BOTTOM-UP, the same
 * sign convention the vertical category labels already use.
 */
export const Y_AXIS_TITLE_OFFSET_X = 18.0;
export const Y_AXIS_TITLE_DEGREES = 90.0;
/** The MAGNITUDE of the MIDDLE RUNG of the category-label angle ladder, in
 * degrees. The ladder is fit-driven and UNIFORM per axis: flat while every label
 * fits its band, all at this angle when any does not, all vertical when this
 * angle no longer packs either. (Phase 879 read the tilt as the resting state;
 * Phase 903's correction makes it the middle rung.) `0` opts out of rotation
 * entirely — flat at every label length, never escalated instead. */
export const LABEL_TILT_DEGREES = 30.0;
/** The terminal rung of the ladder: one line height along the axis whatever the
 * label's length, so it packs at any category count. */
export const VERTICAL_TILT_DEGREES = 90.0;
/** Gap from a legend swatch's left edge to its label's left edge. */
export const LEGEND_LABEL_OFFSET_X = 15.0;
/** BAND arms only. Horizontal padding after a legend entry's label, before the
 * next entry's swatch (Phase 879). The pitch itself is per-entry, not a fixed
 * stride. */
export const LEGEND_ENTRY_GAP = 24.0;
/** COLUMN arms only. Vertical pitch between legend rows (Phase 880). */
export const LEGEND_ROW_PITCH_Y = 20.0;
/** COLUMN arms (and the `Bottom` band). Baseline nudge from a legend row's TOP
 * to its label's baseline — the relation that lets a row be placed by its top
 * edge and still read as one line. */
export const LEGEND_LABEL_BASELINE_DY = 9.0;
/** COLUMN arms only. Gap between the plot's edge and the legend column's
 * swatches. The column's trailing clearance to the canvas edge is
 * `MARGIN_RIGHT`, which is what it always was. */
export const LEGEND_COLUMN_GAP = 16.0;
/** Ceiling on the legend column's width as a share of `W` (Phase 880) — the
 * margin autosizes' posture: a pathological series name truncates rather than
 * eating the plot. */
export const LEGEND_COLUMN_MAX_SHARE = 0.3;
/** The DEFAULT legend edge when the spec does not declare one (Phase 880 —
 * operator decision 2026-08-16). Style, not wire. */
export const LEGEND_POSITION: ChartLegendPosition = 'Right';
/**
 * Phase 881 — the data-label geometry. NONE of these feeds a margin: a data
 * label never makes the plot smaller, it either fits the room the picture
 * already has or it is suppressed. That is what keeps `Off` byte-identical to
 * the pre-881 layout rather than merely visually similar.
 *
 * The font size is one point BELOW the tick size, and a constant of its own: a
 * tick sits OUTSIDE the plot in a column, where a data label sits INSIDE it
 * competing with the mark it describes.
 */
export const DATA_LABEL_FONT_SIZE = 12.0;
/** Clearance between a bar's cap and the nearest ink of its label, in BOTH
 * directions — one constant used twice, so the two placements are mirrors. */
export const DATA_LABEL_OFFSET_Y = 5.0;
/** Clearance a label keeps from the plot edge, and half the clearance it keeps
 * from its neighbour's. Feeds the fit gate only. */
export const DATA_LABEL_PADDING = 2.0;
/** Gap from a line/area endpoint to the left edge of its label. */
export const DATA_LABEL_END_OFFSET_X = 6.0;
/** Rise from a line/area endpoint to its label's baseline — the nudge that
 * takes the text off the line it belongs to. */
export const DATA_LABEL_END_NUDGE_Y = 5.0;

// ─── Annotation ink + geometry (Phase 1490/1491/1492 — §4l) ──────────────────
//
// §4l's "never geometry, never style" prohibition has two halves with two
// owners, and this is the second: an annotation carries an ADDRESS and a LABEL,
// and every pixel and every drop of ink it draws with comes from here. That is
// what makes a data-addressed annotation survive a theme flip and a restyle
// where a placed overlay does not.
//
// The LABEL constants are named for the FAMILY, not for the reference line:
// the event marker and the range band label under exactly the same rule
// (carried `TextSource`, fit-gated, suppressed on no-fit), so one set serves
// all three and a later member adds only its own INK. The four match their
// Phase-881 data-label counterparts by VALUE rather than by reference — an
// annotation label and a data label are the same size of thing in the same
// space, and a host that restyles one should not be forced to restyle the
// other.

/** Stroke width of a reference line. Between the grid's and the series':
 * an annotation is more than chrome and less than data. */
export const REFERENCE_STROKE_WIDTH = 1.5;
/** Per-role opacity for a reference line's ink. Well above `GRID_OPACITY` — a
 * threshold a reader is meant to see — and below `AXIS_OPACITY`, because it is
 * not a boundary of the space. */
export const REFERENCE_OPACITY = 0.55;
/** Phase 1491 — the event marker's ink, matching the reference line's by VALUE
 * rather than by reference: the two are the same weight of statement across the
 * two axes, but a host that wanted to distinguish them must be able to without
 * moving the horizontal one. */
export const EVENT_STROKE_WIDTH = 1.5;
export const EVENT_OPACITY = 0.55;
/** Phase 1492 — the range band's FILL opacity. The LOWEST in the record, below
 * `GRID_OPACITY`, and that is the point rather than timidity: every other role
 * inks a hairline or a glyph, this one inks an AREA. A band is a tint of the
 * surface saying "this region", not a fill saying "this value". */
export const BAND_OPACITY = 0.08;
/** Font size of an annotation's label — one step below the tick size, on the
 * data label's reasoning. */
export const ANNOTATION_LABEL_FONT_SIZE = 12.0;
/** Inset from the plot's LEFT edge to an annotation label's left edge. Left,
 * not right: the right edge is where the series-endpoint labels live. */
export const ANNOTATION_LABEL_OFFSET_X = 6.0;
/** Rise from an annotation's line to its label's baseline. */
export const ANNOTATION_LABEL_NUDGE_Y = 5.0;
/** Clearance an annotation label must keep from the edge of its budget. Feeds
 * the fit gate only; a label that cannot hold it is SUPPRESSED. */
export const ANNOTATION_LABEL_PADDING = 2.0;

// ─── Deterministic numeric helpers ────────────────────────────────────────────

/** Round-half-up to 2 dp — the single deterministic rule every host reproduces. */
export const r2 = (x: number): number => Math.floor(x * 100.0 + 0.5) / 100.0;

/** A "nice" `{1,2,5}·10ⁿ` number for the magnitude of `x` (axis ticks). */
const niceNum = (x: number, roundIt: boolean): number => {
  if (x <= 0.0) return 0.0;
  const exp = Math.floor(Math.log10(x));
  const f = x / 10.0 ** exp;
  let nf: number;
  if (roundIt) {
    if (f < 1.5) nf = 1.0;
    else if (f < 3.0) nf = 2.0;
    else if (f < 7.0) nf = 5.0;
    else nf = 10.0;
  } else if (f <= 1.0) nf = 1.0;
  else if (f <= 2.0) nf = 2.0;
  else if (f <= 5.0) nf = 5.0;
  else nf = 10.0;
  return nf * 10.0 ** exp;
};

/** The tick count both axes aim for. Named because Phase 882's calendar ladder
 * derives its own ceiling from it (`TARGET_TICK_COUNT + 1`), and the two must
 * not be able to drift apart. */
export const TARGET_TICK_COUNT = 5.0;

/** A nice value domain + its tick values for `[lo, hi]`, targeting ~5 ticks. */
export const niceDomain = (
  lo: number,
  hi: number,
): { niceLo: number; niceHi: number; step: number; ticks: number[] } => {
  const hiAdj = hi === lo ? lo + 1.0 : hi;
  const targetTicks = TARGET_TICK_COUNT;
  const range = niceNum(hiAdj - lo, false);
  const step = niceNum(range / (targetTicks - 1.0), true);
  const niceLo = Math.floor(lo / step) * step;
  const niceHi = Math.ceil(hiAdj / step) * step;
  // Enumerate ticks by integer count (float accumulation would drift).
  const count = Math.round((niceHi - niceLo) / step);
  const ticks: number[] = [];
  for (let i = 0; i <= count; i++) ticks.push(r2(niceLo + i * step));
  return { niceLo, niceHi, step, ticks };
};

/**
 * Canonical number form for a label/measure — whole values drop the decimal.
 * Mirrors the F# `DrawingSvg.formatNum`: a whole value renders as a plain integer,
 * else the shortest round-trip layout (JS `Number.toString`, the David-Gay family
 * shared with .NET "R" / CPython repr).
 */
export const formatNum = (n: number): string => {
  if (Number.isNaN(n) || !Number.isFinite(n)) return '0';
  if (n === Math.floor(n) && Math.abs(n) < 1e15) return String(Math.trunc(n));
  return String(n);
};
