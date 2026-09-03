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

import type {
  Binding,
  ChartKind,
  ChartDataLabels,
  ChartLegendPosition,
  ChartXScale,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  DrawingSpec,
  Emphasis,
  Format,
  Node,
  Shape,
  TextAnchor,
  TextSource,
} from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

// ─── Layout constants (the fixed canonical drawing space) ────────────────────

const W = 640.0;
const H = 400.0;
const MARGIN_TOP = 64.0; // title + legend band
const MARGIN_RIGHT = 28.0;
/** Phase 879 — the FLOOR of the autosized bottom margin (category labels + the
 * x-axis title). A tilted or vertical label needs room to fall into. */
const MARGIN_BOTTOM = 56.0;
/** Phase 879 — the FLOOR of the autosized left margin (right-aligned y-axis
 * tick labels). The value is derived from the widest FORMATTED tick. */
const MARGIN_LEFT = 64.0;

/** Ceiling on the autosized left margin, as a share of the canvas width. */
const MARGIN_LEFT_MAX_SHARE = 0.3;
/** Ceiling on the autosized bottom margin, as a share of the canvas height. */
const MARGIN_BOTTOM_MAX_SHARE = 0.35;
/** Breathing room between an autosized margin's content and the canvas edge —
 * also absorbs the few percent by which a real font differs from the table. */
const AXIS_LABEL_PADDING = 6.0;

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

const colourFor = (i: number): string => PALETTE[i % PALETTE.length]!;

// ─── Surface-relative ink (theme-aware chart lowering, S4 / D8) ───────────────
const INK = 'currentColor';
const AXIS_OPACITY = 0.8;
const GRID_OPACITY = 0.12;
const LABEL_OPACITY = 0.66;

/** A translucent categorical fill (Phase 637 — area bands). The gridlines stay
 * legible through the band; the series' full-strength Polyline edge on top
 * carries the categorical colour at full contrast. Phase 875 dropped this to
 * a wash: at 0.35 two overlaid bands read as a third colour and the chrome
 * beneath them disappears. */
const AREA_FILL_OPACITY = 0.12;

// ─── Axis chrome + mark geometry constants (Phase 875) ────────────────────────

/** Gap between the y-axis spine and the right edge of a tick label. */
const TICK_LABEL_GAP = 12.0;

/** Length of the small OUTSIDE tick marks on both axes: y-axis marks run left
 * from the spine, x-axis marks run down from it, so neither eats plot area. One
 * per y tick and — since Phase 903 — one per BAND BOUNDARY on a category axis
 * (`n+1` for `n` bands, delimiting the groups rather than pointing at their
 * centres), or one per x tick on the Scatter arm, whose x is continuous. */
const TICK_MARK_LENGTH = 5.0;

/** Hard pixel ceiling on a single bar's thickness. The bar takes the MIN of
 * its band share and this cap, and is then centred in its slot. */
const BAR_MAX_THICKNESS = 28.0;

/** GEOMETRIC gap between consecutive segments of a stacked bar — the segment
 * is shortened on the side facing the next segment. */
const STACK_SEGMENT_GAP = 2.0;

/** GEOMETRIC angular padding between pie wedges, in DEGREES — half is taken
 * from each end of every wedge's sweep. */
const WEDGE_GAP_DEGREES = 0.75;

// The chart's own font stack — carried in the wire so a lowered chart is
// self-contained + legible on every host without host CSS.
const CHART_FONT = "system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

/** Font size of tick labels, category labels, axis titles and legend text. */
const TICK_FONT_SIZE = 13.0;
/** A line's height as a multiple of its font size (Phase 879). */
const TEXT_LINE_HEIGHT_FACTOR = 1.2;
/** Drop from the x-axis spine to the category / x-tick label baseline. */
const CATEGORY_LABEL_OFFSET_Y = 20.0;
/** Distance from the canvas bottom to the x-axis title's BASELINE. */
const AXIS_TITLE_BOTTOM_OFFSET = 12.0;
/** Phase 878 — the subtitle's font size (below the 18 px title) and baseline. */
const SUBTITLE_FONT_SIZE = 13.0;
const SUBTITLE_BASELINE_Y = 38.0;
/**
 * Phase 878 — the ROTATED y-axis title: the x of its baseline measured from the
 * canvas LEFT EDGE (not the autosized margin, so it does not slide about as
 * tick widths change), and the MAGNITUDE of its rotation. Emitted as `-degrees`
 * — `rotation` is clockwise, so the negative angle reads BOTTOM-UP, the same
 * sign convention the vertical category labels already use.
 */
const Y_AXIS_TITLE_OFFSET_X = 18.0;
const Y_AXIS_TITLE_DEGREES = 90.0;
/** The MAGNITUDE of the MIDDLE RUNG of the category-label angle ladder, in
 * degrees. The ladder is fit-driven and UNIFORM per axis: flat while every label
 * fits its band, all at this angle when any does not, all vertical when this
 * angle no longer packs either. (Phase 879 read the tilt as the resting state;
 * Phase 903's correction makes it the middle rung.) `0` opts out of rotation
 * entirely — flat at every label length, never escalated instead. */
const LABEL_TILT_DEGREES = 30.0;
/** The terminal rung of the ladder: one line height along the axis whatever the
 * label's length, so it packs at any category count. */
const VERTICAL_TILT_DEGREES = 90.0;
/** Gap from a legend swatch's left edge to its label's left edge. */
const LEGEND_LABEL_OFFSET_X = 15.0;
/** BAND arms only. Horizontal padding after a legend entry's label, before the
 * next entry's swatch (Phase 879). The pitch itself is per-entry, not a fixed
 * stride. */
const LEGEND_ENTRY_GAP = 24.0;
/** COLUMN arms only. Vertical pitch between legend rows (Phase 880). */
const LEGEND_ROW_PITCH_Y = 20.0;
/** COLUMN arms (and the `Bottom` band). Baseline nudge from a legend row's TOP
 * to its label's baseline — the relation that lets a row be placed by its top
 * edge and still read as one line. */
const LEGEND_LABEL_BASELINE_DY = 9.0;
/** COLUMN arms only. Gap between the plot's edge and the legend column's
 * swatches. The column's trailing clearance to the canvas edge is
 * `MARGIN_RIGHT`, which is what it always was. */
const LEGEND_COLUMN_GAP = 16.0;
/** Ceiling on the legend column's width as a share of `W` (Phase 880) — the
 * margin autosizes' posture: a pathological series name truncates rather than
 * eating the plot. */
const LEGEND_COLUMN_MAX_SHARE = 0.3;
/** The DEFAULT legend edge when the spec does not declare one (Phase 880 —
 * operator decision 2026-08-16). Style, not wire. */
const LEGEND_POSITION: ChartLegendPosition = 'Right';
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
const DATA_LABEL_FONT_SIZE = 12.0;
/** Clearance between a bar's cap and the nearest ink of its label, in BOTH
 * directions — one constant used twice, so the two placements are mirrors. */
const DATA_LABEL_OFFSET_Y = 5.0;
/** Clearance a label keeps from the plot edge, and half the clearance it keeps
 * from its neighbour's. Feeds the fit gate only. */
const DATA_LABEL_PADDING = 2.0;
/** Gap from a line/area endpoint to the left edge of its label. */
const DATA_LABEL_END_OFFSET_X = 6.0;
/** Rise from a line/area endpoint to its label's baseline — the nudge that
 * takes the text off the line it belongs to. */
const DATA_LABEL_END_NUDGE_Y = 5.0;

// ─── Deterministic numeric helpers ────────────────────────────────────────────

/** Round-half-up to 2 dp — the single deterministic rule every host reproduces. */
const r2 = (x: number): number => Math.floor(x * 100.0 + 0.5) / 100.0;

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
const TARGET_TICK_COUNT = 5.0;

/** A nice value domain + its tick values for `[lo, hi]`, targeting ~5 ticks. */
const niceDomain = (
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
const formatNum = (n: number): string => {
  if (Number.isNaN(n) || !Number.isFinite(n)) return '0';
  if (n === Math.floor(n) && Math.abs(n) < 1e15) return String(Math.trunc(n));
  return String(n);
};

// ─── Deterministic text metrics (Phase 879) ───────────────────
//
// A byte-for-byte MIRROR of the F# reference table
// (`Fuaran.UI.Charts.TextMetrics`) — mirrored, never re-derived, because the
// margins, the legend pitch and the label rotations it decides are all pinned
// by the shared `chart-lowering/*` corpus.
//
// THE APPROXIMATION IS THE SPEC. No host measures text: a headless emitter has
// no font engine, and a browser's measurement depends on which member of the
// font stack actually resolved — either would make the lowering's output a
// function of the host, destroying the byte-identical cross-host property the
// corpus rests on. So the widths come from a FIXED table of per-character
// advance widths as a fraction of the font size (em), approximating a typical
// sans-serif. A real font differs by a few percent; `AXIS_LABEL_PADDING`
// absorbs it.
//
//   1. Five width classes; an unlisted character (including every non-ASCII
//      one) takes the DEFAULT, which is what makes the table total.
//   2. Width = fontSize × Σ advanceEm(ch), summed LEFT TO RIGHT (float addition
//      is not associative — the order is part of the spec), rounded once.
//   3. Line height = fontSize × TEXT_LINE_HEIGHT_FACTOR.
//   4. Truncation keeps the longest prefix that still fits with the ellipsis;
//      when nothing fits the result is a bare `…`, never the empty string.

const THIN_EM = 0.28;
const NARROW_EM = 0.33;
const DEFAULT_EM = 0.55;
const WIDE_EM = 0.7;
const EXTRA_WIDE_EM = 0.9;
const ELLIPSIS = '…';

const THIN_CHARS = " !',.:;Iijl|";
const NARROW_CHARS = '"()*-/\\[]{}frt';
const EXTRA_WIDE_CHARS = '%@MWm';

/** One character's advance width as a fraction of the font size. Total: an
 * unlisted character takes `DEFAULT_EM`, so no host enumerates Unicode. */
const advanceEm = (ch: string): number => {
  if (THIN_CHARS.includes(ch)) return THIN_EM;
  if (NARROW_CHARS.includes(ch)) return NARROW_EM;
  if (EXTRA_WIDE_CHARS.includes(ch)) return EXTRA_WIDE_EM;
  if (ch === 'J' || ch === 'L') return DEFAULT_EM;
  if (ch >= 'A' && ch <= 'Z') return WIDE_EM;
  if (ch === 'w') return WIDE_EM;
  return DEFAULT_EM;
};

/** A string's advance width in em — summed LEFT TO RIGHT (rule 2). */
const advanceEmOf = (text: string): number => {
  let acc = 0.0;
  for (let i = 0; i < text.length; i++) acc += advanceEm(text[i]!);
  return acc;
};

/** The estimated rendered width of `text` at `fontSize`, rounded once. */
const textWidth = (fontSize: number, text: string): number => r2(fontSize * advanceEmOf(text));

/** The estimated line height at `fontSize` (rule 3). */
const textLineHeight = (fontSize: number, lineHeightFactor: number): number =>
  r2(fontSize * lineHeightFactor);

/** Does `text` fit a box `maxWidth` × `maxHeight` at `fontSize`? The single
 * predicate a data-label gate answers inside/outside/suppress with, so a label
 * can never disagree with the margin that made room for it. */
export const textFitsBox = (
  fontSize: number,
  lineHeightFactor: number,
  maxWidth: number,
  maxHeight: number,
  text: string,
): boolean =>
  textWidth(fontSize, text) <= maxWidth && textLineHeight(fontSize, lineHeightFactor) <= maxHeight;

/** Deterministic ellipsis truncation to `maxWidth` (rule 4). A string that
 * already fits comes back unchanged. */
const truncateToWidth = (fontSize: number, maxWidth: number, text: string): string => {
  if (textWidth(fontSize, text) <= maxWidth) return text;
  const budget = maxWidth - textWidth(fontSize, ELLIPSIS);
  if (budget < 0.0) return ELLIPSIS;
  let acc = 0.0;
  let take = 0;
  for (let i = 0; i < text.length; i++) {
    const next = acc + advanceEm(text[i]!);
    if (r2(fontSize * next) > budget) break;
    acc = next;
    take = i + 1;
  }
  return text.slice(0, take) + ELLIPSIS;
};

const DEG_TO_RAD = Math.PI / 180.0;

// ─── The canonical invariant number formatter (Phase 876) ────
//
// A byte-for-byte port of the F# reference spec. The chart lowering does NOT
// inherit the locale-aware rendering other surfaces give `Format` (that is
// `Binding.Format`'s job, via `Intl`): a chart's ticks are part of a drawing
// whose bytes must be identical on every host, so the rendering here is
// locale-INVARIANT by definition — period decimal separator, comma thousands.
//
//   1. Decimals come from the TICK STEP, never the data (`dpsOfStep`).
//   2. The base render is round-half-up on the magnitude at that precision,
//      grouped in threes, zero-padded to exactly d places, a leading `-` only
//      when the rounded magnitude is non-zero.
//   3. The `Format` arms layer meaning over that base; `Date` / `RelativeTime`
//      / `Duration` are not value-axis formats and fall through to the base.
//   4. Display-unit scaling divides BOTH the value and the step by 10ⁿ.
//   5. THE INTEGER PART IS RENDERED IN POSITIONAL NOTATION AT EVERY MAGNITUDE,
//      by an expansion this module owns — never by inheriting a host's default
//      number→string switch. Grouping walks decimal digits, so handing it an
//      exponent form corrupts it silently, and the hosts do not agree on WHEN
//      that form appears: the .NET `"R"` layout (which the Python and Rust
//      hosts mirror, and which the wire format pins) goes scientific once the
//      leading-digit exponent passes 16, i.e. at 1e17, while JavaScript's
//      `Number.prototype.toString` stays positional until 1e21. So between
//      1e17 and 1e21 those hosts drew `2.5E,+17` where this one drew the
//      correct digits, and past 1e21 this one drew `1e,+21` — the same chart,
//      different bytes, and no host right. `expandToFixed` therefore re-lays
//      any `d[.ddd]E±NN` mantissa/exponent pair (this host's lower-case
//      `e+NN` included) as its digits zero-padded to `exp + 1` places, and
//      leaves an already-positional form untouched, so nothing below 1e21
//      moves on this host and nothing below 1e17 moves on any host.
//      NOTE the threshold is 1e17, not the 1e15 in `formatNum` — that constant
//      bounds the exact integer fast path, not the notation switch.
//      The expansion is over the SHORTEST-ROUND-TRIP digits, the canonical
//      decimal identity of the double, not its exact binary value: 1e21 reads
//      `1,000,000,000,000,000,000,000`, not `999,999,999,999,999,916,000`.
//      Only the INTEGER part needs this — the fraction is bounded by 10^6.

/** Decimal places implied by a tick step: the smallest `d <= 6` for which
 * `step * 10^d` is (within relative float tolerance) an integer. */
const dpsOfStep = (step: number): number => {
  const s = Math.abs(step);
  if (!(s > 0.0) || !Number.isFinite(s)) return 0;
  let scaled = s;
  for (let d = 0; d < 6; d++) {
    if (Math.abs(scaled - Math.floor(scaled + 0.5)) <= 1e-9 * Math.max(1.0, scaled)) return d;
    scaled *= 10.0;
  }
  return 6;
};

/** Group an integral digit string in threes from the right with `,`. */
const groupThousands = (digits: string): string => {
  const n = digits.length;
  if (n <= 3) return digits;
  const head = n % 3;
  const parts: string[] = [];
  if (head > 0) parts.push(digits.slice(0, head));
  for (let i = head; i <= n - 3; i += 3) parts.push(digits.slice(i, i + 3));
  return parts.join(',');
};

/** Expand a canonical round-trip number form into POSITIONAL notation (rule 5).
 * `s` is whatever the host's shortest-round-trip formatter produced for a
 * non-negative INTEGER-valued double: positional at small magnitudes, and
 * `d[.ddd]E±NN` — or this host's lower-case `e+NN` — above whichever magnitude
 * that host switches at. Total by construction: a form carrying no exponent is
 * returned unchanged, as is the negative-exponent form an integer part cannot
 * produce. */
const expandToFixed = (s: string): string => {
  let eIdx = s.indexOf('E');
  if (eIdx < 0) eIdx = s.indexOf('e');
  if (eIdx < 0) return s;
  const mant = s.slice(0, eIdx);
  const exp = Number(s.slice(eIdx + 1));
  if (!Number.isFinite(exp) || exp < 0) return s;
  const dot = mant.indexOf('.');
  const digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
  // An integer-valued double's shortest round-trip always has at least as many
  // places as digits; the guard keeps the function total rather than describing
  // a reachable case.
  return digits.length >= exp + 1 ? digits : digits + '0'.repeat(exp + 1 - digits.length);
};

/** Render `v` with EXACTLY `dps` decimals — round-half-up on the magnitude,
 * comma thousands separators, period decimal point, locale-invariant. */
const renderFixed = (dps: number, v: number): string => {
  if (Number.isNaN(v) || !Number.isFinite(v)) return '0';
  const d = dps < 0 ? 0 : dps > 6 ? 6 : dps;
  const scale = 10.0 ** d;
  const units = Math.floor(Math.abs(v) * scale + 0.5);
  const intPart = Math.floor(units / scale);
  const fracPart = units - intPart * scale;
  // Rule 5 — expand before grouping. `formatNum` alone would hand the grouper
  // an exponent form above the host's own switch magnitude.
  const intStr = groupThousands(expandToFixed(formatNum(intPart)));
  let body = intStr;
  if (d > 0) {
    const raw = formatNum(fracPart);
    body = `${intStr}.${'0'.repeat(Math.max(0, d - raw.length))}${raw}`;
  }
  return v < 0.0 && units > 0.0 ? `-${body}` : body;
};

/** ISO-4217 code -> symbol, the invariant table. An unlisted code renders as
 * the code itself — deterministic, and never a wrong symbol. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  CHF: 'CHF',
  AUD: '$',
  CAD: '$',
  NZD: '$',
  HKD: '$',
  SGD: '$',
  INR: '₹',
  KRW: '₩',
  BRL: 'R$',
  RUB: '₽',
  ZAR: 'R',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  CZK: 'Kč',
  HUF: 'Ft',
  TRY: '₺',
  MXN: '$',
  THB: '฿',
  ILS: '₪',
};

const currencySymbol = (iso: string): string => CURRENCY_SYMBOLS[iso] ?? iso;

/** The unit symbol a `Format` contributes to an axis-unit label. */
const formatUnitSymbol = (fmt: Format | undefined): string =>
  fmt !== undefined && fmt.kind === 'Currency' ? currencySymbol(fmt.isoCode) : '';

/** The x100 a `Format.Percent` applies to BOTH the value and the step. */
const formatValueScale = (fmt: Format | undefined): number =>
  fmt !== undefined && fmt.kind === 'Percent' ? 100.0 : 1.0;

/** Render one value-axis number. `divisor` is the display unit (1 when no
 * scaling applies); `dropSymbol` suppresses a currency symbol on the ticks
 * because the axis-unit label already states it once. */
const formatValue = (
  fmt: Format | undefined,
  divisor: number,
  dropSymbol: boolean,
  step: number,
  v: number,
): string => {
  const pct = formatValueScale(fmt);
  const dv = (v * pct) / divisor;
  const ds = (step * pct) / divisor;
  const pinned =
    fmt !== undefined && (fmt.kind === 'Number' || fmt.kind === 'Percent')
      ? fmt.decimals
      : undefined;
  const dps = pinned !== undefined ? pinned : dpsOfStep(ds);
  const body = renderFixed(dps, dv);
  if (fmt !== undefined && fmt.kind === 'Percent') return `${body}%`;
  if (fmt !== undefined && fmt.kind === 'Currency' && !dropSymbol) {
    const sym = currencySymbol(fmt.isoCode);
    return body.startsWith('-') ? `-${sym}${body.slice(1)}` : `${sym}${body}`;
  }
  return body;
};

// ─── Display units (Phase 876) ───────────────────
//
// The operator's prefix table: thresholds sit at 1 + 3k and the selected
// threshold `t` for a magnitude of exponent `e` satisfies `e - 1 <= t < e + 2`,
// giving the unit exponent `n = t - 1`. Each unit therefore covers three
// exponents — Thousands for e in {3,4,5}, Millions for {6,7,8} — which is why a
// 12-million axis and a 900-million axis both read in millions.

/** How a value axis states its display unit once scaling applies. */
export type ChartAxisUnitMode =
  | 'Words'
  | 'WordsWithSymbol'
  | 'SIAbbreviation'
  | 'CompactPerTick'
  | 'Off';

/** The smallest unit exponent that triggers scaling at the shipped default —
 * the operator's `unit > 3` gate, so scaling begins at MILLIONS and a
 * thousands-range axis still reads `12,500` in full. */
const DISPLAY_UNIT_MIN_EXPONENT = 6;

const unitExponentOf = (maxAbs: number): number => {
  if (!(maxAbs > 0.0) || !Number.isFinite(maxAbs)) return 0;
  const e = Math.floor(Math.log10(maxAbs) + 0.5);
  const n = 3 * Math.ceil((e - 2) / 3);
  return n < -15 ? -15 : n > 15 ? 15 : n;
};

const UNIT_WORDS: Readonly<Record<number, string>> = {
  3: 'Thousands',
  6: 'Millions',
  9: 'Billions',
  12: 'Trillions',
  15: 'Quadrillions',
};
const UNIT_SI: Readonly<Record<number, string>> = { 3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P' };
const UNIT_COMPACT: Readonly<Record<number, string>> = { 3: 'K', 6: 'M', 9: 'B', 12: 'T', 15: 'Q' };

interface DisplayUnit {
  readonly divisor: number;
  readonly tickSuffix: string;
  readonly dropSymbol: boolean;
  readonly label: string;
}

const NO_DISPLAY_UNIT: DisplayUnit = { divisor: 1.0, tickSuffix: '', dropSymbol: false, label: '' };

/** Resolve the display unit for a value axis whose PRINTED magnitudes peak at
 * `maxAbs` (already through any `Format.Percent` x100). */
const resolveDisplayUnit = (
  mode: ChartAxisUnitMode,
  minExponent: number,
  fmt: Format | undefined,
  maxAbs: number,
): DisplayUnit => {
  const n = unitExponentOf(maxAbs);
  const threshold = mode === 'CompactPerTick' ? 3 : minExponent;
  const words = UNIT_WORDS[n] ?? '';
  if (mode === 'Off' || n < 3 || n < threshold || words === '') return NO_DISPLAY_UNIT;
  const symbol = formatUnitSymbol(fmt);
  const divisor = 10.0 ** n;
  switch (mode) {
    case 'Words':
      return { divisor, tickSuffix: '', dropSymbol: false, label: words };
    case 'WordsWithSymbol':
      return {
        divisor,
        tickSuffix: '',
        dropSymbol: symbol !== '',
        label: symbol === '' ? words : `${words} of ${symbol}`,
      };
    case 'SIAbbreviation':
      return {
        divisor,
        tickSuffix: '',
        dropSymbol: symbol !== '',
        label: `${UNIT_SI[n] ?? ''}${symbol}`,
      };
    case 'CompactPerTick':
      return { divisor, tickSuffix: UNIT_COMPACT[n] ?? '', dropSymbol: false, label: '' };
    default:
      return NO_DISPLAY_UNIT;
  }
};

// ─── The temporal x-axis (Phase 882) ─────────────────────────────────────────
//
// NORMATIVE CROSS-HOST SPEC (R2), the same standing as the text metrics and the
// number formatter above: every conformant host reproduces this block exactly,
// and `docs/CHARTS-DRAWING-PRIMITIVE-DESIGN.md` §4h carries it as the
// language-neutral statement. The `chart-lowering/*` goldens pin it.
//
// FIVE RULES, and each one exists to remove a way two hosts could disagree.
//
//   1. THE UNIT IS THE DAY, and a date is an INTEGER: days since 1970-01-01 in
//      the PROLEPTIC GREGORIAN calendar. Nothing here reads a host date type, a
//      locale, a time zone, or a clock — no `Date`, no `Intl`, no library. The
//      conversions are the fixed integer algorithms below (Howard Hinnant's
//      `days_from_civil` / `civil_from_days`, public domain), exact for every
//      date they admit and needing no leap-year table. A timestamp cell's
//      TIME-OF-DAY IS DISCARDED: the value is its UTC date. That is the whole
//      of the axis's time-zone policy, stated rather than inherited, because
//      inheriting it from a host would make the picture depend on where it was
//      drawn.
//
//      Integer division must TRUNCATE TOWARD ZERO, so every `/` in the two
//      conversions is wrapped in `Math.trunc` — `Math.floor` is WRONG for the
//      negative-bias branches, and JavaScript's bare `/` is not integral at
//      all. The algorithms bias their operands into the non-negative range
//      precisely so truncation is the only convention they need.
//
//   2. THE DOMAIN IS THE DATA'S OWN EXTENT, UNEXPANDED — `[min, max]`, so the
//      first and last points sit on the plot's edges. It is NOT snapped outward
//      the way `niceDomain` snaps the value axis, because a calendar boundary
//      is a coarse thing to round to: nicing a 30-day domain to whole months
//      would add a month of empty plot at each end to make room for ticks
//      nobody asked for. The ticks come to the domain instead. A degenerate
//      domain (every row the same date, or no rows) becomes `[lo, lo+1]`, the
//      same guard `niceDomain` applies for the same reason.
//
//   3. THE TICKS ARE CALENDAR-ALIGNED INSTANTS INSIDE THE DOMAIN, at a step
//      drawn from a FIXED LADDER — the `{1,2,5}·10ⁿ` rule's analogue for units
//      that are not decimal:
//
//        1, 2, 5, 10 DAYS · 1, 2, 3, 6 MONTHS · {1,2,5}·10ⁿ YEARS (n ≤ 6)
//
//      The chosen rung is the FIRST whose in-domain tick count fits the
//      ceiling; the coarsest rung is the fallback nothing else fits. Day rungs
//      step from the DOMAIN'S OWN START (a "nice" 2-day or 5-day boundary does
//      not exist — days are uniform, so the honest anchor is the first datum);
//      month rungs land on month starts where `(month-1) mod k === 0`, which
//      makes `k = 3` the calendar quarters and `k = 6` January and July; year
//      rungs land on the January 1 of years where `year mod k === 0`.
//
//      The ceiling is `TARGET_TICK_COUNT + 1` (6 at the shipped default) rather
//      than `TARGET_TICK_COUNT` itself. The value axis's step is CONTINUOUS and
//      can be tuned to hit a target; a calendar rung jumps by 2–3× and cannot,
//      so rounding down a rung loses roughly half the ticks. Admitting the
//      densest rung that still reads keeps the actual count in the 3–6 band.
//      Counts are computed WITHOUT generating the ticks, so the ladder can be
//      walked from its densest rung on a millennium-wide domain without
//      unbounded work.
//
//   4. THE FORMAT FOLLOWS THE STEP'S NOMINAL LENGTH, at the operator's
//      thresholds: `> 365` days ⇒ `yyyy`, `> 27` ⇒ `mmm yy`, else `dd mmm yy`.
//      Nominal, not measured: a month is `365.2425 / 12 = 30.436875` days and a
//      year `365.2425`, so the rung decides the format and the DATA cannot.
//      Measuring the actual tick gaps instead would put the year rung's average
//      at exactly 365.0 across a run of non-leap years (1900–1903, say) and
//      flip a decade chart from `yyyy` to `mmm yy` on a property of the
//      calendar nobody was asking about. The thresholds are calibrated for
//      this: the 1-month rung clears 27 and the 6-month rung does not clear
//      365, so each threshold separates two ADJACENT rungs.
//
//   5. THE MONTH NAMES ARE PART OF THE SPEC. English three-letter
//      abbreviations, invariant, never a locale lookup — an i18n date axis is a
//      different feature with its own vocabulary, and a chart whose golden
//      bytes changed with the host's culture would not be certifiable at all.

/** The English three-letter month abbreviations, in calendar order. INVARIANT —
 * part of the wire-visible spec (rule 5), never a locale lookup. */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The calendar unit a tick step counts in. */
type TemporalUnit = 'Days' | 'Months' | 'Years';

/** One rung of the ladder: `count` of `unit`. */
interface TemporalStep {
  readonly unit: TemporalUnit;
  readonly count: number;
}

/** Integer division TRUNCATED TOWARD ZERO (rule 1) — the one division
 * convention both conversions below rely on. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** Gregorian leap year (proleptic — the rule applies to every year the parser
 * admits, with no historical exception). */
const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Days in a month — the one place the calendar's irregularity is written down,
 * used by the PARSER only (the conversions need no table). */
const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeapYear(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

/** `(y, m, d)` → days since 1970-01-01. Hinnant's `days_from_civil`: exact for
 * every proleptic-Gregorian date, no leap table, integer-only. */
const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = idiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = month > 2 ? month - 3 : month + 9; // March-based month
  const doy = idiv(153 * mp + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
};

/** Days since 1970-01-01 → `(y, m, d)`. Hinnant's `civil_from_days`, the exact
 * inverse of {@link daysFromCivil}. */
const civilFromDays = (days: number): { year: number; month: number; day: number } => {
  const z = days + 719468;
  const era = idiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100)); // [0, 365]
  const mp = idiv(5 * doy + 2, 153); // [0, 11], March-based
  const d = doy - idiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
};

/**
 * Parse a canonical ISO-8601 date to days since epoch — `YYYY-MM-DD`,
 * optionally followed by `T…`, whose time-of-day is DISCARDED (rule 1). STRICT
 * by shape and by calendar: four digits, two, two, both hyphens, a month in
 * 1–12 and a day the month actually has. `undefined` for everything else,
 * including a locale spelling (`15/01/2026`) and a bare year — admitting either
 * would be the string-sniffing this axis exists to avoid.
 */
const tryParseDay = (text: string): number | undefined => {
  const digits = (start: number, len: number): number | undefined => {
    if (start + len > text.length) return undefined;
    let acc = 0;
    for (let k = start; k < start + len; k++) {
      const c = text.charCodeAt(k);
      if (c < 48 || c > 57) return undefined;
      acc = acc * 10 + (c - 48);
    }
    return acc;
  };
  if (text.length < 10) return undefined;
  if (text[4] !== '-' || text[7] !== '-') return undefined;
  if (text.length > 10 && text[10] !== 'T') return undefined;
  const y = digits(0, 4);
  const m = digits(5, 2);
  const d = digits(8, 2);
  if (y === undefined || m === undefined || d === undefined) return undefined;
  if (m < 1 || m > 12 || d < 1 || d > daysInMonth(y, m)) return undefined;
  return daysFromCivil(y, m, d);
};

/** The day number a row's x cell carries, with an UNPARSEABLE cell reading as
 * the epoch. That mirrors `numericOf`'s posture for a non-numeric value-axis
 * cell — the lowering stays total and the grounding rule (FUARAN097) is what
 * makes a non-date column loud, upstream, before any picture is drawn. Silence
 * here is not the design; refusing here would be. */
const temporalDayOf = (text: string): number => tryParseDay(text) ?? 0;

/** The step's NOMINAL length in days (rule 4) — a mean Gregorian month and
 * year, so the FORMAT is a property of the rung rather than of the data. */
const nominalDays = (step: TemporalStep): number => {
  switch (step.unit) {
    case 'Days':
      return step.count;
    case 'Months':
      return step.count * 30.436875; // 365.2425 / 12
    default:
      return step.count * 365.2425;
  }
};

/** The ladder, ascending (rule 3). Written out rather than generated: it is a
 * pinned vocabulary five hosts mirror, and an explicit list cannot drift on a
 * difference of opinion about exponentiation. */
const TEMPORAL_LADDER: readonly TemporalStep[] = [
  { unit: 'Days', count: 1 },
  { unit: 'Days', count: 2 },
  { unit: 'Days', count: 5 },
  { unit: 'Days', count: 10 },
  { unit: 'Months', count: 1 },
  { unit: 'Months', count: 2 },
  { unit: 'Months', count: 3 },
  { unit: 'Months', count: 6 },
  { unit: 'Years', count: 1 },
  { unit: 'Years', count: 2 },
  { unit: 'Years', count: 5 },
  { unit: 'Years', count: 10 },
  { unit: 'Years', count: 20 },
  { unit: 'Years', count: 50 },
  { unit: 'Years', count: 100 },
  { unit: 'Years', count: 200 },
  { unit: 'Years', count: 500 },
  { unit: 'Years', count: 1000 },
  { unit: 'Years', count: 2000 },
  { unit: 'Years', count: 5000 },
  { unit: 'Years', count: 10000 },
  { unit: 'Years', count: 20000 },
  { unit: 'Years', count: 50000 },
  { unit: 'Years', count: 100000 },
  { unit: 'Years', count: 200000 },
  { unit: 'Years', count: 500000 },
  { unit: 'Years', count: 1000000 },
  { unit: 'Years', count: 2000000 },
  { unit: 'Years', count: 5000000 },
];

/** Round an index UP to the next multiple of `k` (both non-negative). */
const ceilTo = (k: number, i: number): number => idiv(i + k - 1, k) * k;

/** The aligned window a month rung covers: `[first aligned month index, count]`
 * over `[lo, hi]`, in month-index space (`year·12 + month - 1`). Closed-form,
 * so a count never generates a tick. */
const monthWindow = (k: number, lo: number, hi: number): readonly [number, number] => {
  const start = civilFromDays(lo);
  // A `lo` past the 1st means `lo`'s own month start is outside the domain.
  const firstIdx = start.year * 12 + start.month - 1 + (start.day > 1 ? 1 : 0);
  const first = ceilTo(k, firstIdx);
  const end = civilFromDays(hi);
  // `hi`'s own month start is always inside the domain (its day ≥ 1).
  const last = idiv(end.year * 12 + end.month - 1, k) * k;
  return last < first ? [first, 0] : [first, idiv(last - first, k) + 1];
};

/** The year rung's twin of {@link monthWindow}, in year space. */
const yearWindow = (k: number, lo: number, hi: number): readonly [number, number] => {
  const start = civilFromDays(lo);
  const firstYear = start.year + (start.month === 1 && start.day === 1 ? 0 : 1);
  const first = ceilTo(k, firstYear);
  const last = idiv(civilFromDays(hi).year, k) * k;
  return last < first ? [first, 0] : [first, idiv(last - first, k) + 1];
};

/** How many `step`-aligned ticks fall in `[lo, hi]` — closed-form, never by
 * generation (rule 3), so walking the ladder is O(rungs) whatever the span. */
const temporalTickCount = (step: TemporalStep, lo: number, hi: number): number => {
  if (hi < lo) return 0;
  switch (step.unit) {
    case 'Days':
      return idiv(hi - lo, step.count) + 1;
    case 'Months':
      return monthWindow(step.count, lo, hi)[1];
    default:
      return yearWindow(step.count, lo, hi)[1];
  }
};

/** The `step`-aligned ticks in `[lo, hi]`, ascending. */
const temporalTicks = (step: TemporalStep, lo: number, hi: number): number[] => {
  if (hi < lo) return [];
  const out: number[] = [];
  if (step.unit === 'Days') {
    for (let i = 0; i <= idiv(hi - lo, step.count); i++) out.push(lo + i * step.count);
    return out;
  }
  if (step.unit === 'Months') {
    const [first, count] = monthWindow(step.count, lo, hi);
    for (let i = 0; i < count; i++) {
      const idx = first + i * step.count;
      out.push(daysFromCivil(idiv(idx, 12), (idx % 12) + 1, 1));
    }
    return out;
  }
  const [first, count] = yearWindow(step.count, lo, hi);
  for (let i = 0; i < count; i++) out.push(daysFromCivil(first + i * step.count, 1, 1));
  return out;
};

/** The chosen rung: the FIRST whose in-domain tick count fits `maxTicks`, else
 * the coarsest (rule 3). Total — the ladder is never empty. */
const chooseTemporalStep = (maxTicks: number, lo: number, hi: number): TemporalStep =>
  TEMPORAL_LADDER.find((s) => temporalTickCount(s, lo, hi) <= maxTicks) ??
  TEMPORAL_LADDER[TEMPORAL_LADDER.length - 1]!;

/** The domain: the data's own extent, unexpanded, with the degenerate guard
 * (rule 2). No rows ⇒ `[0, 1]` — the epoch day and the one after it, which
 * draws an axis rather than dividing by zero. */
const temporalDomain = (days: readonly number[]): readonly [number, number] => {
  if (days.length === 0) return [0, 1];
  const lo = Math.min(...days);
  const hi = Math.max(...days);
  return hi === lo ? [lo, lo + 1] : [lo, hi];
};

const padTo = (width: number, v: number): string => {
  const s = String(v);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
};

/** The tick label for `day` under `step` — the granularity-adaptive format
 * (rule 4). `yyyy` past a year, `mmm yy` past 27 days, else `dd mmm yy`. */
const temporalLabel = (step: TemporalStep, day: number): string => {
  const { year, month, day: d } = civilFromDays(day);
  const nominal = nominalDays(step);
  const yy = padTo(2, year % 100);
  const mmm = MONTH_NAMES[month - 1]!;
  if (nominal > 365.0) return padTo(4, year);
  if (nominal > 27.0) return mmm + ' ' + yy;
  return padTo(2, d) + ' ' + mmm + ' ' + yy;
};

// ─── DrawStyle + shape builders ──────────────────────────────────────────────

const staticBinding = <T>(value: T): Binding<T> => ({ kind: 'Static', value });

/** Phase 642 — stamp a derivation-based mark identity onto a data-bearing
 * shape's style: `series-field|category-key`, stable under row reorder and
 * data refresh (object constancy). Chrome deliberately stays unstamped. */
const withMark = (seriesField: string, categoryKey: string, style: DrawStyle): DrawStyle => ({
  ...style,
  markId: `${seriesField}|${categoryKey}`,
});

/** A series-level mark (one shape carries the whole series — Line/Area): the
 * identity is the series field alone. */
const withSeriesMark = (seriesField: string, style: DrawStyle): DrawStyle => ({
  ...style,
  markId: seriesField,
});

/** Phase 883 — the separator between the three parts of a hover readout. A
 * middle dot with spaces of its own: not a character a series or category name
 * is likely to contain (a hyphen, a slash and a comma all are), and it reads as
 * a separator rather than as punctuation belonging to either side. */
const TIP_SEPARATOR = ' · ';

/** Phase 883 — stamp the hover readout onto a data-bearing shape's style. An
 * EMPTY readout is dropped rather than encoded: an empty SVG `<title>`
 * suppresses the native tooltip AND overrides the element's accessible name
 * with nothing, which is worse than no title at all. */
const withTip = (text: string, style: DrawStyle): DrawStyle =>
  text === '' ? style : { ...style, tip: { kind: 'Literal', value: text } };

const styleFill = (fill: string): DrawStyle => ({ fill: staticBinding(fill) });

const styleStroke = (stroke: string, width: number): DrawStyle => ({
  stroke: staticBinding(stroke),
  strokeWidth: staticBinding(width),
});

const styleFillOpacity = (fill: string, opacity: number): DrawStyle => ({
  fill: staticBinding(fill),
  opacity: staticBinding(opacity),
});

/** Surface-relative structural stroke (`currentColor` at a per-role opacity). */
const styleStrokeInk = (opacity: number, width: number): DrawStyle => ({
  stroke: staticBinding(INK),
  strokeWidth: staticBinding(width),
  opacity: staticBinding(opacity),
});

/** Surface-relative text-label style: `currentColor` + optional per-role opacity. */
const textStyle = (
  opacity: number | undefined,
  anchor: TextAnchor,
  size: number,
  emphasis: Emphasis,
): DrawStyle => ({
  fill: staticBinding(INK),
  ...(opacity !== undefined ? { opacity: staticBinding(opacity) } : {}),
  textAnchor: anchor,
  fontSize: size,
  emphasis,
  fontFamily: CHART_FONT,
});

const literal = (text: string): TextSource => ({ kind: 'Literal', value: text });

const line = (x1: number, y1: number, x2: number, y2: number, style: DrawStyle): Shape => ({
  kind: 'Line',
  x1,
  y1,
  x2,
  y2,
  style,
});

const rectangle = (
  x: number,
  y: number,
  width: number,
  height: number,
  cornerRadius: number | undefined,
  style: DrawStyle,
): Shape => ({
  kind: 'Rectangle',
  x,
  y,
  width,
  height,
  ...(cornerRadius !== undefined ? { cornerRadius } : {}),
  style,
});

const label = (x: number, y: number, text: TextSource, style: DrawStyle): Shape => ({
  kind: 'Label',
  x,
  y,
  text,
  style,
});

const polyline = (points: readonly DrawPoint[], style: DrawStyle): Shape => ({
  kind: 'Polyline',
  points,
  style,
});

const polygon = (points: readonly DrawPoint[], style: DrawStyle): Shape => ({
  kind: 'Polygon',
  points,
  style,
});

const circle = (cx: number, cy: number, r: number, style: DrawStyle): Shape => ({
  kind: 'Circle',
  cx,
  cy,
  r,
  style,
});

// ─── The chart spec (the neutral cross-host lowering input) ────────────────────

/**
 * The resolved chart layout inputs — the neutral lowering contract. Mirrors the
 * fields the F# `ChartSpec` lowering reads: `kind`, the `xField` category (or,
 * for `Scatter`, numeric) column, the `yFields` series columns, the `title`, and
 * `stacked` (Bar / Area geometry only — ignored on kinds where stacking is
 * meaningless).
 *
 * ── The `TextSource` rule (Phase 1143)
 *
 * The four `TextSource`-typed fields — `title`, `xTitle`, `yTitle`, `subtitle` —
 * CARRY into the drawing unresolved and reach the emitted labels as
 * `TextSource`. A `Bound` or `I18n` arm is neither resolved here nor dropped:
 * resolution is the renderer's, at render time, where the host holds the
 * binding sources and the catalogue.
 *
 * That is affordable because every layout rule below reserves space by the
 * PRESENCE of these fields and never by their text — so a drawing's geometry is
 * a function of the spec's shape, identical on every host and stable under a
 * binding that changes. The one content-dependent rule, `boundText`
 * truncation, is confined to the `Literal` arm for the same reason.
 *
 * The full cross-host statement is the reference host's
 * `docs/CHART-LOWERING-TEXT-CONTRACT.md`; the `chart-lowering/*` corpus pins it.
 * These fields were `string` until Phase 1143, which made the contract
 * unrepresentable at the bridge and silently dropped every non-literal arm.
 */
export interface ChartLowerSpec {
  readonly kind: ChartKind;
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly title?: TextSource;
  readonly stacked?: boolean;
  /** Phase 876 — the VALUE axis's number format, reusing the existing `Format`
   * vocabulary. A wire field: a semantic declaration, not an appearance. */
  readonly valueFormat?: Format;
  /**
   * Phase 878 — the axis NAMES and the muted subtitle. Wire fields for the same
   * reason `title` is one: what an axis is CALLED is the author's meaning.
   *
   * Absent is the ORDINARY shape, not an opt-out: each axis title falls back to
   * its capitalised field name, so an axis is never nameless. The fallback
   * answers ABSENCE only — a declared title of any arm always wins.
   */
  readonly xTitle?: TextSource;
  readonly yTitle?: TextSource;
  /**
   * The natural home for a units statement. Declaring one SUPPRESSES the
   * lowering's own display-unit slot — the author has said it, so the machine
   * does not repeat it. PRESENCE is the whole test, on every arm.
   */
  readonly subtitle?: TextSource;
  /**
   * Phase 880 — WHERE the legend sits, and whether it sits anywhere at all.
   * Semantic for the same reason the titles above are: the edge an author wants
   * the legend on is their meaning; the column widths and pitches that realise
   * it are the host's.
   *
   * Absent means "the host's default" (`Right`) — NOT "no legend"; suppression
   * is the explicit `'None'`. So absence stays the ordinary shape and is
   * omitted on the wire.
   */
  readonly legendPosition?: ChartLegendPosition;
  /**
   * Phase 881 — whether the values are written onto the picture. `'Ends'`
   * labels bar CAPS (a stacked bar's TOTAL only) and LINE/AREA ENDPOINTS, and
   * nothing else: there is deliberately no all-points value, so a number on
   * every interior point is not expressible.
   *
   * Absent means `'Off'`, which is also the default — so an absent field lowers
   * to the pre-881 picture byte-for-byte.
   */
  readonly dataLabels?: ChartDataLabels;
  /**
   * Phase 882 — what the x column MEANS: discrete `'Category'` bands, or
   * `'Temporal'` dates read on a continuous day-scale (points at their date,
   * calendar-aligned ticks, granularity-adaptive labels, vertical gridlines,
   * and no fallback x-title).
   *
   * DECLARED, never inferred — the validator grounds the claim against the
   * column type (FUARAN097) rather than the lowering sniffing cell strings.
   * Absent means `'Category'`, which is also the default, so an absent field
   * lowers to the pre-882 picture byte-for-byte. Inert on `Pie`, which has no
   * x axis to scale.
   */
  readonly xScale?: ChartXScale;
}

/**
 * The styling knobs this lowering exposes (Phase 876). NOT wire fields — a
 * theme flip or a house display-unit convention is the host's, made at render
 * time, and must never rewrite a semantic node. Absent = the shipped defaults,
 * which are what the `chart-lowering/*` goldens pin.
 */
export interface ChartLowerStyle {
  readonly axisUnitMode?: ChartAxisUnitMode;
  readonly displayUnitMinExponent?: number;
}

/** One data row — a field-name → scalar map (the canonical embedded-data shape). */
export type ChartRow = Readonly<Record<string, unknown>>;

/**
 * The `ChartKind`s this module lowers to a real `Drawing`. The render dispatch
 * (client + server) consults THIS — so the first-party render branch and the
 * lowering's arm set can never drift apart.
 */
export const isLowered = (kind: ChartKind): boolean => kind !== 'Heatmap';

// ─── Row field extraction ─────────────────────────────────────────────────────

const numericOf = (row: ChartRow, field: string): number => {
  const v = row[field];
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  // Non-finite guard (Phase 640): NaN/Infinity would poison every domain
  // computation and emit NaN geometry into the SVG. Wire-carried data can
  // never be non-finite (the canonical-float codec rejects it), so this covers
  // only host-side rows — coerced to the same 0.0 the non-numeric posture uses.
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0.0;
  return 0.0;
};

const stringOf = (row: ChartRow, field: string): string => {
  const v = row[field];
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNum(v);
  if (v === null || v === undefined) return '';
  return String(v);
};

const capitalise = (s: string): string => (s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1));

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
const SUMMARY_CLAUSE_SEPARATOR = '. ';

/** At most this many series are NAMED before the summary folds the rest into a
 * count — a legibility bound, not a technical one. */
const SUMMARY_MAX_SERIES_NAMED = 4;

/** The per-NAME character cap (a series field, a category label) — untrusted
 * strings straight off the data feed. */
const SUMMARY_MAX_NAME_CHARS = 32;

/** The whole summary's character cap. */
const SUMMARY_MAX_CHARS = 320;

/** Truncate to at most `maxChars`, marking the cut with the ellipsis. The cut
 * never splits a UTF-16 surrogate pair — a boundary landing between a high and a
 * low surrogate moves one unit earlier. */
const clampText = (maxChars: number, s: string): string => {
  if (s.length <= maxChars) return s;
  let cut = maxChars - 1;
  const prev = s.charCodeAt(cut - 1);
  if (cut > 0 && prev >= 0xd800 && prev <= 0xdbff) cut -= 1;
  return s.slice(0, cut) + ELLIPSIS;
};

/** The chart's kind in words. `stacked` earns a word only on the two arms where
 * it changes the geometry — the same rule the lowering itself applies. */
const summaryKindWords = (kind: ChartLowerSpec['kind'], stacked: boolean): string => {
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

// ─── The lowering ─────────────────────────────────────────────────────────────

/**
 * Lower a resolved chart spec + data rows to a canonical `DrawingSpec`.
 * Lowered arms: `Bar` (grouped + stacked), `Line`, `Area` (overlaid + stacked),
 * `Scatter` (linear numeric x), `Pie` (polar, single-series). `Heatmap`
 * produces an empty drawing (its lowering rule lands with its own phase).
 * `stacked: true` on a kind where stacking is meaningless (`Line`, `Scatter`,
 * `Pie`) is ignored — the flag only changes `Bar` / `Area` geometry.
 * Wrap the result in a node with {@link lowerNode}.
 */
export const lower = (
  spec: ChartLowerSpec,
  rows: readonly ChartRow[],
  style?: ChartLowerStyle,
): DrawingSpec => {
  const axisUnitMode: ChartAxisUnitMode = style?.axisUnitMode ?? 'Words';
  const minUnitExponent = style?.displayUnitMinExponent ?? DISPLAY_UNIT_MIN_EXPONENT;
  const categories = rows.map((r) => stringOf(r, spec.xField));
  const n = rows.length;

  const series = spec.yFields.map((yf) => rows.map((r) => numericOf(r, yf)));
  const m = series.length;

  // Stacking applies to Bar + Area only (Phase 637). Values stack as-is by
  // plain cumulative sum per category — deterministic and total; a negative
  // value simply lowers the running sum (mixed-sign stacks are a validation
  // concern, not a lowering one).
  const stacked = (spec.stacked ?? false) && (spec.kind === 'Bar' || spec.kind === 'Area');

  /** Per-category running sums across the series, INCLUDING the leading 0
   * baseline: `cumsFor(i)` has length m+1. */
  const cumsFor = (i: number): number[] => {
    const out = [0.0];
    let acc = 0.0;
    for (let j = 0; j < m; j++) {
      acc += series[j]![i]!;
      out.push(acc);
    }
    return out;
  };

  const allValuesRaw = stacked
    ? Array.from({ length: n }, (_, i) => cumsFor(i)).flat()
    : series.flat();
  const values = allValuesRaw.length > 0 ? allValuesRaw : [0.0];
  const dataMin = Math.min(...values);
  const dataMax = Math.max(...values);
  // Bars + lines share a zero-anchored domain — deterministic + honest for
  // bars. Stacked domains come from the cumulative partial sums, so the axis
  // covers the stack totals, never a single series' range.
  const {
    niceLo,
    niceHi,
    step: yStep,
    ticks,
  } = niceDomain(Math.min(0.0, dataMin), Math.max(0.0, dataMax));

  // ── Value-axis number formatting (Phase 876) ──
  // The declared meaning (`spec.valueFormat`) chooses the arms; the style
  // chooses whether a large magnitude is stated once as a display unit; the
  // tick STEP chooses the precision. The unit is resolved from the PRINTED
  // magnitude, so a `Percent` axis is measured after its x100.
  const valueFormat = spec.valueFormat;
  const yDisplayUnit = resolveDisplayUnit(
    axisUnitMode,
    minUnitExponent,
    valueFormat,
    Math.max(Math.abs(niceLo), Math.abs(niceHi)) * formatValueScale(valueFormat),
  );
  const yTickText = (v: number): string =>
    formatValue(valueFormat, yDisplayUnit.divisor, yDisplayUnit.dropSymbol, yStep, v) +
    yDisplayUnit.tickSuffix;

  // ── Hover readout (Phase 883) ────────────────────────────────────────────
  //
  // THE TIP IS WHERE FULL PRECISION LIVES. A printed data label (Phase 881)
  // goes through `yTickText` — the axis's own formatter, step precision and
  // display unit — and reads ROUGHLY WHERE. The tip answers the other
  // question, WHAT EXACTLY IS THIS, so it takes the opposite three decisions:
  // UNSCALED by the display unit (a tooltip has no unit slot beside it), the
  // DATUM's own precision rather than the tick step's (an explicit
  // `Format.Number`/`Percent` precision still wins — a declared precision is a
  // statement about the data, not the axis), and the currency symbol KEPT (the
  // ticks drop it because the axis-unit label states it once).
  //
  // Passing `v` as the step is what selects the datum's own precision:
  // `formatValue` derives decimals from the step when no explicit precision is
  // declared, so step = value gives the fewest decimals that reproduce it.
  const tipValueText = (v: number): string => formatValue(valueFormat, 1.0, false, v, v);

  /** The readout for a PER-DATUM mark (bar, stack segment, wedge, scatter
   * point): "Series · Category · value". Both leading parts are untrusted
   * strings straight off the data feed — the renderer's XML escape is what
   * makes that safe. The series name is the FIELD name, matching the legend
   * and `markId` rather than the capitalised axis title. */
  const datumTip = (
    seriesField: string,
    categoryKey: string,
    v: number,
    style: DrawStyle,
  ): DrawStyle =>
    withTip(
      `${seriesField}${TIP_SEPARATOR}${categoryKey}${TIP_SEPARATOR}${tipValueText(v)}`,
      style,
    );

  /** The readout for a SERIES-LEVEL mark (a line, an area band or its edge).
   * THE TIP'S GRANULARITY FOLLOWS THE MARK'S IDENTITY GRANULARITY — one
   * element IS the whole series, and SVG resolves a tooltip per ELEMENT, so a
   * single `<title>` cannot honestly report one point's value: whichever was
   * chosen would show for a hover anywhere along the line. */
  const seriesTip = (seriesField: string, style: DrawStyle): DrawStyle =>
    withTip(seriesField, style);

  // ── Linear x-scale (Phase 636 — the Scatter arm's numeric x axis) ──
  // Scatter reads the x-field NUMERICALLY and plots on a linear x-domain (the
  // first non-band x-scale arm). The domain is NOT zero-anchored — a scatter's
  // x range carries no baseline semantics (the y domain stays zero-anchored
  // with the other arms, deliberately: one shared y-domain rule).
  const isScatter = spec.kind === 'Scatter';

  // ── Temporal x-scale (Phase 882 — the SECOND non-band x-scale) ──
  //
  // DECLARED, never inferred. `xScale: 'Temporal'` is the author saying "this
  // column is dates"; the language then GROUNDS that claim against the
  // statically-known column type (FUARAN097) wherever it can. Inference was the
  // alternative and is wrong twice over: the schema is statically known only for
  // an embedded table with an EMPTY pipeline (FUARAN086's window), so an
  // inferred axis would make the same tree draw a band axis or a temporal one
  // depending on where its rows came from — a picture that depends on data
  // PROVENANCE — and sniffing the cell strings for an ISO-8601 shape is the
  // guess-dressed-as-a-rule §4e refused. Absent is `'Category'`, which is every
  // pre-882 chart, byte-for-byte.
  //
  // Pie is excluded because it HAS no x axis: a temporal declaration there is
  // dead intent the polar arm cannot honour, and neutralising it here keeps the
  // pie geometry free of a scale it never reads.
  const isTemporal = spec.xScale === 'Temporal' && spec.kind !== 'Pie';

  // Each row's x as a DAY NUMBER, read off the same string projection the band
  // arms label with — which is exactly the canonical ISO-8601 form a date /
  // timestamp cell carries through the row bridge. So the mark identity keeps
  // the ISO string while the geometry uses the integer, and neither has to be
  // derived from the other.
  const dayValues: number[] = isTemporal ? categories.map(temporalDayOf) : [];

  // The x axis is CONTINUOUS (Phase 903's split) on exactly two arms: the
  // Scatter arm's numeric x and a temporal x. Everything keyed off this — tick
  // marks AT the value, vertical gridlines, marks placed by value rather than by
  // band index — follows from that one property rather than from a list of kinds.
  const isContinuousX = isScatter || isTemporal;

  const xValues = isTemporal
    ? dayValues
    : isScatter
      ? rows.map((r) => numericOf(r, spec.xField))
      : [];

  // The chosen calendar rung, on a temporal axis only. ONE value decides both
  // the tick positions and the label format, so the two cannot disagree about
  // the axis's granularity.
  const temporalStep: TemporalStep | undefined = isTemporal
    ? (() => {
        const [lo, hi] = temporalDomain(dayValues);
        return chooseTemporalStep(TARGET_TICK_COUNT + 1.0, lo, hi);
      })()
    : undefined;

  const {
    niceLo: xNiceLo,
    niceHi: xNiceHi,
    step: xStep,
    ticks: xTicks,
  } = temporalStep !== undefined
    ? // The domain is the data's own extent (rule 2) — deliberately NOT nice-d
      // outward — and the ticks are the calendar-aligned instants inside it.
      // `xStep` carries the rung's NOMINAL length, which is what the label
      // format reads.
      ((): { niceLo: number; niceHi: number; step: number; ticks: number[] } => {
        const [lo, hi] = temporalDomain(dayValues);
        return {
          niceLo: lo,
          niceHi: hi,
          step: nominalDays(temporalStep),
          ticks: temporalTicks(temporalStep, lo, hi),
        };
      })()
    : isScatter
      ? xValues.length === 0
        ? niceDomain(0.0, 1.0)
        : niceDomain(Math.min(...xValues), Math.max(...xValues))
      : { niceLo: 0.0, niceHi: 1.0, step: 1.0, ticks: [] as number[] };

  // The Scatter arm's x IS a value axis, so its ticks take the same canonical
  // formatter (Phase 876). `valueFormat` is deliberately NOT applied to it: one
  // declared meaning cannot be true of two different measures, and there is no
  // second axis-unit slot to state an x display unit in.
  //
  // A TEMPORAL tick takes the calendar label instead (Phase 882) — the same
  // one-formatter-per-axis discipline over a different vocabulary: the number
  // formatter has nothing true to say about a date.
  const xTickText = (v: number): string =>
    temporalStep !== undefined
      ? temporalLabel(temporalStep, Math.trunc(v))
      : formatValue(undefined, 1.0, false, xStep, v);

  const tickSize = TICK_FONT_SIZE;
  const titleSize = 18.0;

  // ── Text-metric layout (Phase 879) ─────────────────────────────────────────
  //
  // ORDER IS LOAD-BEARING. The plot rectangle used to be four module constants;
  // it is now DERIVED from the text the chart prints — the widest formatted y
  // tick decides the left margin, and the category labels' tilt decides the
  // bottom one. So: the left margin, the band pitch that follows from it, the
  // tilt, and the bottom margin the tilt needs, in that order.

  const lineHeight = textLineHeight(tickSize, TEXT_LINE_HEIGHT_FACTOR);
  const widestOf = (texts: readonly string[]): number =>
    texts.reduce((acc, t) => Math.max(acc, textWidth(tickSize, t)), 0.0);

  // ── Axis names + subtitle (Phase 878) ──
  //
  // Resolved HERE, before any margin, because both margins reserve a line for
  // text whose presence these three fields decide — the left margin for the
  // rotated y title, the top margin for the subtitle.
  //
  // An axis title is the author's own when declared, else the capitalised field
  // name (which is what the x axis has always drawn, now stated once and applied
  // to both). Undefined only where there is no honest fallback: an empty field
  // name, or a y axis carrying no series at all.
  // The fallback is a `Literal` the lowering MINTS, and it answers ABSENCE
  // only: a declared title of any arm wins, and is never replaced because it
  // could not be resolved here (the text contract, clause 5).
  const axisTitleOf = (
    declared: TextSource | undefined,
    fallbackField: string,
  ): TextSource | undefined =>
    declared !== undefined
      ? declared
      : fallbackField === ''
        ? undefined
        : literal(capitalise(fallbackField));

  // Phase 882 wires §4e's date-axis rule: a SELF-EVIDENT DATE AXIS SUPPRESSES
  // ITS DEFAULT TITLE — an axis reading "Jan Feb Mar" does not need the word
  // "Date" beneath it. Two boundaries, both stated when the rule was written
  // down and both kept: it applies to the FALLBACK only (an explicit `xTitle` is
  // the author overriding the default and always draws), and it suppresses the
  // TITLE, never the axis. The declaration is what made it wirable — nothing
  // before 882 could tell a date column from a string one, which is why §4e
  // recorded the rule instead of shipping it.
  const xTitle =
    isTemporal && spec.xTitle === undefined ? undefined : axisTitleOf(spec.xTitle, spec.xField);
  // The y fallback is the capitalised FIRST y-field — the honest answer to
  // "what is on this axis", where the retired `"Value"` literal named neither
  // the measure nor its unit.
  const yTitle = axisTitleOf(spec.yTitle, spec.yFields[0] ?? '');

  // ── Top margin ──
  // A subtitle takes one line under the title, and everything below it in the
  // top band — the legend row, the display-unit slot, the plot itself — moves
  // down by exactly that line. Reserved only when one is present, so a chart
  // without a subtitle keeps the pre-878 layout byte-for-byte.
  const subtitleBand =
    spec.subtitle !== undefined ? textLineHeight(SUBTITLE_FONT_SIZE, TEXT_LINE_HEIGHT_FACTOR) : 0.0;
  const marginTop = r2(MARGIN_TOP + subtitleBand);

  // ── Left margin ──
  // The truncation budget is derived from the CEILING — a constant — so the
  // truncation that feeds the margin never depends on the margin it decides.
  const leftCeiling = MARGIN_LEFT_MAX_SHARE * W;
  // Phase 878 — the rotated y title occupies one LINE of the left margin,
  // outboard of the tick column. Only its line height (plus the padding beside
  // it) is reserved: the title is rotated, so its LENGTH runs vertically and is
  // bounded against the plot height further down, which is what keeps this
  // acyclic.
  const yTitleBand = yTitle !== undefined ? lineHeight + AXIS_LABEL_PADDING : 0.0;
  const tickTextBudget = Math.max(
    0.0,
    leftCeiling - TICK_LABEL_GAP - AXIS_LABEL_PADDING - yTitleBand,
  );
  const yTickLabelText = (v: number): string =>
    truncateToWidth(tickSize, tickTextBudget, yTickText(v));
  const requiredLeft =
    TICK_LABEL_GAP + widestOf(ticks.map(yTickLabelText)) + AXIS_LABEL_PADDING + yTitleBand;
  const marginLeft = r2(Math.max(MARGIN_LEFT, Math.min(leftCeiling, requiredLeft)));

  const PLOT_X0 = marginLeft;

  // ── Legend placement (Phase 880; BAND overflow fallback 2026-08-18) ──
  //
  // ONE legend with four placements, resolved HERE — AFTER the left margin,
  // whose `PLOT_X0` is where a band packs FROM, and before the plot's right
  // edge, because a `Right` legend's column width is an INPUT to the plot
  // rectangle and a `Bottom` legend's band is an input to the bottom margin.
  // Same acyclicity discipline the text metrics established. Phase 880 resolved
  // this block above ALL the margins; the overflow rule moved it below the LEFT
  // one, because that is where the band's available width comes from. Nothing
  // between the two reads the legend, so the block moved whole.
  //
  // The pie arm's shares are resolved here for the same reason: its legend
  // labels carry them ("name (NN%)"), so they are layout input, not output.
  const isPie = spec.kind === 'Pie';
  const pieValues = isPie && m === 1 ? series[0]! : [];
  const pieTotal = pieValues.reduce((a, b) => a + b, 0.0);
  // The Phase-638 bounded-v1 guard, unchanged and merely lifted. A refused pie
  // draws no geometry AND no legend — a legend for a picture that was refused
  // would be a claim about data the drawing declined to show.
  const pieRefused = isPie && (m !== 1 || pieValues.some((v) => v < 0.0) || pieTotal <= 0.0);
  const pieFractions = isPie && !pieRefused ? pieValues.map((v) => v / pieTotal) : [];

  // The legend's rows in draw order — `[colour, label]`. TWO sources, ONE shape:
  // the cartesian arms legend their SERIES and only when there is more than one
  // (with a single series the title already names it — the pre-880 rule), while
  // the pie arm legends its CATEGORIES, which is why a single-series pie legends
  // and a single-series bar does not.
  const legendEntries: (readonly [string, string])[] = isPie
    ? pieFractions.map(
        (f, i) =>
          [
            colourFor(i),
            // Routed through the canonical formatter (Phase 876) — one rounding
            // rule for every number this module prints.
            `${categories[i]!} (${formatValue(undefined, 1.0, false, 1.0, f * 100.0)}%)`,
          ] as const,
      )
    : m > 1
      ? spec.yFields.map((yf, j) => [colourFor(j), yf] as const)
      : [];

  // The placement the author ASKED FOR: their explicit value where there is one,
  // else the host default. With no entries the answer is `None` whatever either
  // said — so an explicit position on a single-series chart draws nothing and,
  // more to the point, reserves no space.
  const requestedPos: ChartLegendPosition =
    legendEntries.length === 0 ? 'None' : (spec.legendPosition ?? LEGEND_POSITION);

  /** A BAND entry's PITCH: the swatch's label offset, the label's own natural
   * width, and the gap before the next entry. Read by the overflow predicate AND
   * by the band emitter far below — one expression, so the rule can never decide
   * against geometry the drawing does not use. The name is the untruncated one,
   * because a band never truncates. */
  const bandEntryWidth = (t: string): number =>
    LEGEND_LABEL_OFFSET_X + textWidth(tickSize, t) + LEGEND_ENTRY_GAP;

  /** The width a BAND has to pack into: from the plot's left edge, where the band
   * starts, to the plot's right edge — which on a band arm is the canvas less the
   * right margin, since a band reserves no column and `legendColumnW` is 0 there
   * by construction. So the term is not circular, and it is the PLOT's width
   * rather than canvas-minus-declared-margins: the band packs from `PLOT_X0`, the
   * AUTOSIZED left margin, not from `MARGIN_LEFT`. */
  const bandAvailableW = W - MARGIN_RIGHT - PLOT_X0;

  /** **The BAND overflow rule (operator decision, 2026-08-18).** An explicit
   * `Top` or `Bottom` legend whose entries do not pack into one band row FALLS
   * BACK TO THE RIGHT-HAND COLUMN. A band's width is the SUM of its entries, so
   * it runs off the canvas once the names are long enough or numerous enough —
   * and truncating any one name cannot fix a sum, which is why Phase 879's
   * per-entry natural pitch and Phase 880's repositioning both left it standing.
   *
   * The column never loses information, never grows the band unboundedly, and
   * reuses layout that already shipped. Two alternatives were considered and
   * DECLINED: a second row grows the reserved band and moves the plot rectangle
   * with the entry COUNT (chrome sliding under a data refresh); a refusal loses
   * the legend entirely, when the author's intent — a visible legend — is
   * honourable at another edge. So `Top`/`Bottom` mean "band if it fits, column
   * if it cannot"; the wire is unchanged.
   *
   * The comparison INCLUDES the last entry's trailing `LEGEND_ENTRY_GAP`, exactly
   * as the emitter computes it — that gap is the clearance to the right margin.
   * Strict `>`, so an exact fit stays a band. And the fallback is UNIFORM: the
   * whole legend moves, never a split across two edges. */
  const bandOverflows =
    (requestedPos === 'Top' || requestedPos === 'Bottom') &&
    legendEntries.reduce((acc, [, t]) => acc + bandEntryWidth(t), 0.0) > bandAvailableW;

  /** The placement actually used. */
  const legendPos: ChartLegendPosition = bandOverflows ? 'Right' : requestedPos;

  // COLUMN arms: the widest label decides the column, bounded by a share of the
  // canvas and truncated beyond it — the margin autosizes' posture, for the same
  // reason. A BAND arm packs at NATURAL width and never truncates: its overflow
  // is in the SUM, not in one name, so truncating would cost information without
  // fixing anything — a band that cannot pack falls back to the column above.
  const legendNameBudget = Math.max(
    0.0,
    LEGEND_COLUMN_MAX_SHARE * W - LEGEND_LABEL_OFFSET_X - LEGEND_COLUMN_GAP,
  );
  const legendTexts = legendEntries.map(([, t]) =>
    legendPos === 'Right' ? truncateToWidth(tickSize, legendNameBudget, t) : t,
  );
  const legendColumnW =
    legendPos === 'Right'
      ? r2(LEGEND_COLUMN_GAP + LEGEND_LABEL_OFFSET_X + widestOf(legendTexts))
      : 0.0;
  // The `Bottom` band's height — one line plus its padding, reserved BELOW
  // everything the bottom margin's autosize already accounts for, so the two
  // never contend. The exact mirror of `subtitleBand` at the top.
  const legendBandH = legendPos === 'Bottom' ? r2(lineHeight + AXIS_LABEL_PADDING) : 0.0;

  // Phase 880 — a `Right` legend takes its column off the PLOT, not off the
  // right margin: the margin stays the clearance between the legend's widest
  // label and the canvas edge, exactly as it was the clearance to the plot
  // before. Every other placement leaves `legendColumnW = 0`.
  const PLOT_X1 = W - MARGIN_RIGHT - legendColumnW;
  const PLOT_W = PLOT_X1 - PLOT_X0;

  const bandW = n > 0 ? PLOT_W / n : PLOT_W;
  const centreX = (i: number): number => r2(PLOT_X0 + bandW * (i + 0.5));

  /** The `i`th BAND BOUNDARY — `n` bands have `n+1` of them, boundary `0` on the
   * y-axis spine and boundary `n` on the plot's right edge. Phase 903's category
   * tick marks land here, where a label lands at `centreX`. */
  const boundaryX = (i: number): number => r2(PLOT_X0 + bandW * i);

  // ── The x-axis-label ANGLE LADDER (Phase 903, correcting Phase 879) ──
  // The BAND arms label categories; Pie has no x axis and Scatter labels numeric
  // x ticks (short by construction, left horizontal). Both of those must
  // therefore contribute NO drop, or their bottom margin — and with it the
  // pie's centre — would move for a decision they never take.
  const drawsCategoryLabels = !isScatter && !isTemporal && spec.kind !== 'Pie';

  // Phase 882 — a TEMPORAL axis labels its TICKS, and the ladder applies to
  // them: same three rungs, same footprint formula, measured against the TICK
  // PITCH instead of the band pitch. A date label is not short by construction
  // the way a numeric tick is (`15 Jan 26` against `150`), so leaving it
  // always-flat would recreate exactly the overlap the ladder exists to resolve
  // — and reusing the ladder rather than adding a second rule is what keeps one
  // angle policy for the whole x axis.
  const temporalTickTexts = isTemporal ? xTicks.map(xTickText) : [];

  /** Whether the x axis draws labels the ladder governs at all — the band arms'
   * categories or a temporal axis's ticks. Scatter and Pie: no. */
  const drawsXAxisLabels = drawsCategoryLabels || isTemporal;

  /** The pitch the ladder measures a label against: a band's width, or — on a
   * temporal axis — the SMALLEST pixel gap between consecutive ticks, since
   * calendar gaps are not uniform (28 to 31 days a month) and the tightest pair
   * is the one that has to fit. Computable here because it needs `PLOT_W` only,
   * which the left margin has already fixed: the acyclicity Phase 879
   * established survives intact, with nothing reading the bottom margin the
   * ladder is about to decide. */
  const xLabelPitch = ((): number => {
    if (!isTemporal) return bandW;
    const span = xNiceHi - xNiceLo;
    if (xTicks.length < 2) return PLOT_W;
    let minGap = span;
    for (let i = 1; i < xTicks.length; i++) minGap = Math.min(minGap, xTicks[i]! - xTicks[i - 1]!);
    return (PLOT_W * minGap) / span;
  })();

  /** The labels the ladder decides on, AS AUTHORED (see below). */
  const xLabelsAsAuthored: readonly string[] = isTemporal ? temporalTickTexts : categories;

  // A rotated label's footprint ALONG the axis is w·cos θ + h·sin θ. At 0° that
  // is the bare width (`cos 0 = 1`, `sin 0 = 0`, both exact on every IEEE-754
  // host, so the flat rung needs no special case); at 90° the width term
  // vanishes, so the vertical rung takes one line height per label at any count
  // — which is why it is terminal.
  const alongAxisFootprint = (deg: number, w: number): number =>
    w * Math.cos(deg * DEG_TO_RAD) + lineHeight * Math.sin(deg * DEG_TO_RAD);

  // THREE RUNGS, ONE PREDICATE, applied to the WIDEST label and therefore
  // UNIFORMLY to the axis: flat while every label fits its band, 30° when it
  // does not, vertical when 30° no longer packs either. Phase 879 read the tilt
  // as the resting state and started at rung two; the correction makes it the
  // MIDDLE rung of a fit-driven ladder — "North South East West" is legible flat
  // and reads flat. Deciding on the widest label rather than per-label is what
  // keeps an axis from mixing angles.
  //
  // Decided on the labels AS AUTHORED (`xLabelsAsAuthored`, not the truncated
  // `xLabelTexts`): the truncation budget below is a function of the angle, so
  // reading truncated text here would be circular as well as wrong.
  const widestXLabel = widestOf(xLabelsAsAuthored);
  const packsAt = (deg: number): boolean => alongAxisFootprint(deg, widestXLabel) <= xLabelPitch;

  // `LABEL_TILT_DEGREES = 0` is FLAT-ALWAYS, not "the ladder with a flat rung":
  // a host that zeroed the tilt named the one rotation the ladder may use, so
  // escalating past it to vertical would override an explicit choice with a
  // computed one.
  const tiltDegrees =
    !drawsXAxisLabels || n === 0 || LABEL_TILT_DEGREES <= 0.0
      ? 0.0
      : packsAt(0.0)
        ? 0.0
        : packsAt(LABEL_TILT_DEGREES)
          ? LABEL_TILT_DEGREES
          : VERTICAL_TILT_DEGREES;

  // ── Bottom margin ──
  // Below the plot, top to bottom: the label offset, the tilted label's drop
  // (w·sin θ), the padding, the x-axis title's own LINE (its offset measures to
  // its BASELINE, so the glyphs above it need reserving separately), and that
  // offset. Same ceiling-then-truncate posture as the left margin.
  const sinTilt = Math.sin(tiltDegrees * DEG_TO_RAD);
  const bottomCeiling = MARGIN_BOTTOM_MAX_SHARE * H;
  const dropCeiling = Math.max(
    0.0,
    bottomCeiling -
      CATEGORY_LABEL_OFFSET_Y -
      AXIS_LABEL_PADDING -
      lineHeight -
      AXIS_TITLE_BOTTOM_OFFSET,
  );
  const categoryTextBudget = sinTilt > 0.0 ? dropCeiling / sinTilt : Infinity;
  /** The x labels as DRAWN — the ladder's own labels, bounded by the drop
   * ceiling. Empty on the arms that draw none, so their bottom margin is
   * unmoved (Scatter's short numeric ticks are emitted separately, flat). */
  const xLabelTexts = drawsXAxisLabels
    ? xLabelsAsAuthored.map((c) => truncateToWidth(tickSize, categoryTextBudget, c))
    : [];
  const requiredBottom =
    CATEGORY_LABEL_OFFSET_Y +
    sinTilt * widestOf(xLabelTexts) +
    AXIS_LABEL_PADDING +
    lineHeight +
    AXIS_TITLE_BOTTOM_OFFSET;
  // The `Bottom` legend's band is ADDED to the autosized margin rather than
  // competing inside its ceiling: the ceiling exists to stop LABELS eating the
  // plot, and the legend is not a label.
  const marginBottom = r2(
    legendBandH + Math.max(MARGIN_BOTTOM, Math.min(bottomCeiling, requiredBottom)),
  );

  const PLOT_Y0 = marginTop;
  const PLOT_Y1 = H - marginBottom;
  const PLOT_H = PLOT_Y1 - PLOT_Y0;

  const yScale = (v: number): number => r2(PLOT_Y1 - ((v - niceLo) / (niceHi - niceLo)) * PLOT_H);

  /** The x-scale before rounding. Split out by Phase 882 so the bar arms can
   * derive an UNROUNDED slot origin from it: rounding a centre and then
   * subtracting half a width would round twice, and the band arms' goldens pin
   * the single-rounding form. */
  const xScaleRaw = (v: number): number => PLOT_X0 + ((v - xNiceLo) / (xNiceHi - xNiceLo)) * PLOT_W;

  const xScale = (v: number): number => r2(xScaleRaw(v));

  // ── Chrome (assembled in painter's order below) ──
  const axisStyle = styleStrokeInk(AXIS_OPACITY, 1.0);
  const gridStyle = styleStrokeInk(GRID_OPACITY, 1.0);

  const gridlines: Shape[] = ticks.map((t) => {
    const y = yScale(t);
    return line(r2(PLOT_X0), y, r2(PLOT_X1), y, gridStyle);
  });

  // Vertical gridlines — wherever the x axis is CONTINUOUS (Phase 875 for
  // Scatter, extended to the temporal axis by Phase 882). A continuous scale has
  // readable x positions, so a reader traces a point back to an x value the
  // same way the horizontal grid lets them trace a y value. A BAND x-axis has
  // no such positions to trace (a category is a label, not a magnitude), so a
  // vertical rule there would be decoration. Stating it as "continuous" rather
  // than "Scatter" is what let the temporal axis inherit the behaviour instead
  // of re-deciding it — including on a temporal BAR chart, where the rules read
  // as date guides through the bars rather than as chrome.
  const xGridlines: Shape[] = isContinuousX
    ? xTicks.map((t) => line(xScale(t), r2(PLOT_Y0), xScale(t), r2(PLOT_Y1), gridStyle))
    : [];

  const axes: Shape[] = [
    line(r2(PLOT_X0), r2(PLOT_Y0), r2(PLOT_X0), r2(PLOT_Y1), axisStyle),
    line(r2(PLOT_X0), r2(PLOT_Y1), r2(PLOT_X1), r2(PLOT_Y1), axisStyle),
  ];

  // Zero baseline (Phase 875) — only when the domain CROSSES zero, where the
  // sign of a value is a reading of the chart and the zero line is what the
  // reader measures against. Drawn at axis strength, over the ordinary
  // gridline it shares a y with; when the domain does not cross zero the axis
  // spine already IS the baseline and a second rule at the same strength
  // would be noise.
  const zeroLine: Shape[] =
    niceLo < 0.0 && niceHi > 0.0
      ? [line(r2(PLOT_X0), yScale(0.0), r2(PLOT_X1), yScale(0.0), axisStyle)]
      : [];

  // Outside tick marks (Phase 875) — outside the plot on both axes, so the
  // plot area stays ink-free and the marks tie each label to its position.
  // y marks first, then x marks. Suppressed entirely when TICK_MARK_LENGTH <= 0.
  //
  // BAND vs CONTINUOUS (Phase 903). Where the axis is CONTINUOUS a tick marks a
  // VALUE and sits at it: the y axis, and Scatter's numeric x. Where it is a BAND
  // axis a tick DELIMITS a group, so the `n+1` marks land on the band BOUNDARIES
  // and the label stays centred between two of them — the category-axis
  // convention, and the honest one: a category has an extent, not a position, so
  // a mark under its centre claims a coordinate the axis does not have. Phase
  // 882's temporal axis TAKES the continuous side of this split: a date IS a
  // position, so its marks sit at their dates and its labels are centred ON
  // them — there are no boundaries to delimit, because there are no bands.
  const tickMarks: Shape[] = (() => {
    if (TICK_MARK_LENGTH <= 0.0) return [];
    const yMarks: Shape[] = ticks.map((t) => {
      const y = yScale(t);
      return line(r2(PLOT_X0 - TICK_MARK_LENGTH), y, r2(PLOT_X0), y, axisStyle);
    });
    const xAt = (x: number): Shape =>
      line(x, r2(PLOT_Y1), x, r2(PLOT_Y1 + TICK_MARK_LENGTH), axisStyle);
    const xMarks: Shape[] = isContinuousX
      ? xTicks.map((t) => xAt(xScale(t)))
      : n === 0
        ? []
        : Array.from({ length: n + 1 }, (_, i) => xAt(boundaryX(i)));
    return [...yMarks, ...xMarks];
  })();

  // y-axis tick labels — right-anchored (End) in the left margin. The text is
  // the margin-bounded one (Phase 879): whatever the margin was sized for is
  // exactly what gets drawn.
  const yTickLabels: Shape[] = ticks.map((t) =>
    label(
      r2(PLOT_X0 - TICK_LABEL_GAP),
      r2(yScale(t) + 4.0),
      literal(yTickLabelText(t)),
      textStyle(LABEL_OPACITY, 'End', tickSize, 'Normal'),
    ),
  );

  // x-axis labels — band arms label each category under its band centre;
  // Scatter labels its numeric x-ticks along the linear axis (Phase 636).
  //
  // Every category label sits at its band CENTRE — including since Phase 903,
  // when the tick marks moved to the boundaries: the label names the band, the
  // marks delimit it.
  //
  // The ANCHOR follows the ladder's rung. At the FLAT rung a label is
  // `Middle`-anchored on the band centre (the pre-879 convention, restored). At
  // either ROTATED rung it is `End`-anchored at the same point and rotated
  // NEGATIVELY (counter-clockwise, against `rotation`'s clockwise convention):
  // the anchor is the pivot, so the text ENDS under the band centre and runs
  // back down-and-left, reading up-to-the-right into it. The opposite sign
  // would swing the same text up into the plot area. At 90° this degenerates
  // to reading bottom-up. Scatter's numeric ticks stay horizontal + Middle.
  //
  // Phase 882 — a TEMPORAL axis's labels sit at their TICKS (not at a band
  // centre, because there are no bands) and take the ladder's rung and anchor
  // exactly as the band arms do. So one expression covers "centred at the
  // position the label names" on both, and the only thing that differs is which
  // positions those are.
  const tiltedLabelStyle: DrawStyle = {
    ...textStyle(LABEL_OPACITY, 'End', tickSize, 'Normal'),
    rotation: r2(-tiltDegrees),
  };

  const xLabelStyle: DrawStyle =
    tiltDegrees > 0.0 ? tiltedLabelStyle : textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal');

  const xLabels: Shape[] = isScatter
    ? xTicks.map((t) =>
        label(
          xScale(t),
          r2(PLOT_Y1 + CATEGORY_LABEL_OFFSET_Y),
          literal(xTickText(t)),
          textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal'),
        ),
      )
    : isTemporal
      ? xTicks.map((t, i) =>
          label(
            xScale(t),
            r2(PLOT_Y1 + CATEGORY_LABEL_OFFSET_Y),
            literal(xLabelTexts[i]!),
            xLabelStyle,
          ),
        )
      : xLabelTexts.map((c, i) =>
          label(centreX(i), r2(PLOT_Y1 + CATEGORY_LABEL_OFFSET_Y), literal(c), xLabelStyle),
        );

  // ── Axis titles + the display-unit slot (Phase 878) ──
  //
  // Three rules, and together they retire the hardcoded `"Value"`:
  //
  //   1. NAMES. The x title stays centred under the tick band; the y title is
  //      ROTATED bottom-up in the left margin, Middle-anchored at the plot's
  //      vertical centre so it stays centred on the axis it names whatever its
  //      length. Each falls back to its capitalised field name.
  //   2. UNITS KEEP THEIR OWN SLOT. The top-left label states the Phase-876
  //      display unit and NOTHING else: with no scaling in play it is not drawn
  //      at all, where it previously fell back to the literal `"Value"` — a word
  //      naming neither the measure nor its unit. Composing the unit INTO the
  //      rotated title was rejected: that concatenation is only expressible for
  //      a literal title, so a bound or i18n one would silently take a different
  //      layout, and a rule whose shape depends on that is not a rule.
  //   3. DEDUPE. An explicit subtitle SUPPRESSES the unit slot — the author's
  //      own units statement wins over the machine restating it two lines away.
  //      PRESENCE is the whole test, so no string comparison is involved and the
  //      rule is identical on every host.
  //
  // A SELF-EVIDENT DATE AXIS SUPPRESSES ITS DEFAULT TITLE — stated in the design
  // note (§4e) and WIRED by Phase 882, once `xScale` made "this column is dates"
  // something the author declares rather than something the lowering guesses
  // from the label text. Decided where `xTitle` is resolved, above; the fallback
  // only, and the title only — never the axis.
  // Bound a title to the extent it runs along. Only a `Literal` can be
  // truncated — the text behind a `Bound` or `I18n` arm is not known here — and
  // that is the honest boundary: those pass through and may overrun, which is a
  // visible fact rather than a silently wrong measurement (the text contract,
  // clause 4, implemented identically on every host).
  const boundText = (fontSize: number, extent: number, t: TextSource): TextSource =>
    t.kind === 'Literal' ? literal(truncateToWidth(fontSize, extent, t.value)) : t;

  const axisTitles: Shape[] = [];
  if (xTitle !== undefined) {
    axisTitles.push(
      label(
        r2((PLOT_X0 + PLOT_X1) / 2.0),
        // Phase 880 — the x title rides ABOVE a `Bottom` legend band, keeping
        // its own inset from whatever is beneath it. `legendBandH` is 0 on
        // every other arm.
        r2(H - legendBandH - AXIS_TITLE_BOTTOM_OFFSET),
        boundText(tickSize, PLOT_W, xTitle),
        textStyle(undefined, 'Middle', tickSize, 'Normal'),
      ),
    );
  }
  if (yTitle !== undefined) {
    axisTitles.push(
      label(
        r2(Y_AXIS_TITLE_OFFSET_X),
        r2((PLOT_Y0 + PLOT_Y1) / 2.0),
        boundText(tickSize, PLOT_H, yTitle),
        {
          ...textStyle(undefined, 'Middle', tickSize, 'Normal'),
          rotation: r2(-Y_AXIS_TITLE_DEGREES),
        },
      ),
    );
  }
  if (yDisplayUnit.label !== '' && spec.subtitle === undefined) {
    axisTitles.push(
      label(
        r2(8.0),
        r2(PLOT_Y0 - 12.0),
        literal(yDisplayUnit.label),
        textStyle(undefined, 'Start', tickSize, 'Normal'),
      ),
    );
  }

  // ── Where a datum sits along x (Phase 882) ─────────────────────────────────
  //
  // ONE pair of expressions the series geometry reads, and the band-vs-value
  // difference lives here and nowhere else. On a band axis a datum sits at its
  // band's INDEX; on a temporal axis it sits at its DATE — the same datum, a
  // different question asked of the axis.
  //
  // The temporal slot keeps `bandW` as its PITCH — `PLOT_W / n`, the average
  // spacing — so a bar's thickness is decided by the same expression on both
  // axes and a monthly bar chart looks like a bar chart rather than like a
  // sequence of hairlines. With irregular dates two slots can overlap; that is
  // honest, because the bars are at their true positions and the overlap is the
  // data's, not the layout's. `BAR_MAX_THICKNESS` already bounds the other
  // direction.

  /** The x a datum's mark centres on. */
  const xCentre = (i: number): number => (isTemporal ? xScale(xValues[i]!) : centreX(i));

  /** The UNROUNDED left edge of the slot a datum's bar geometry lays out in.
   * Unrounded because the bar arms round once, at the end — the band form is
   * `PLOT_X0 + bandW·i` character-for-character, so every band golden is
   * unmoved. */
  const slotOriginX = (i: number): number =>
    isTemporal ? xScaleRaw(xValues[i]!) - bandW / 2.0 : PLOT_X0 + bandW * i;

  // ── Bar geometry ──
  //
  // Hoisted out of the two Bar arms (Phase 881) because the cap labels have to
  // land on the SAME caps the rectangles draw: one expression per quantity, so a
  // label and its bar cannot disagree about where the bar is. The arithmetic is
  // character-for-character what the arms computed inline before, which is why
  // every golden is unmoved.
  const barGroupW = bandW * 0.7;
  const stackedBarW = r2(Math.min(barGroupW * 0.9, BAR_MAX_THICKNESS));
  const stackedBarX = (i: number): number => r2(slotOriginX(i) + (bandW - stackedBarW) / 2.0);
  const groupedSubW = m > 0 ? barGroupW / m : barGroupW;
  const groupedBarW = r2(Math.min(groupedSubW * 0.9, BAR_MAX_THICKNESS));
  // Centre the (possibly capped) bar in its own sub-slot, so a cap takes air off
  // BOTH sides and the group stays symmetric about the band centre.
  const groupedBarX = (i: number, j: number): number =>
    r2(
      slotOriginX(i) +
        (bandW - barGroupW) / 2.0 +
        j * groupedSubW +
        (groupedSubW - groupedBarW) / 2.0,
    );

  // ── Series geometry ──
  const seriesShapes: Shape[] = [];
  if (spec.kind === 'Bar' && stacked) {
    // One capped bar per category, centred in its band; series stack as
    // segments between consecutive cumulative sums (Phase 637), each
    // shortened by STACK_SEGMENT_GAP on the side facing the next segment so
    // the boundaries read as gaps rather than colour changes (Phase 875).
    const bw = stackedBarW;
    for (let i = 0; i < n; i++) {
      const bx = stackedBarX(i);
      const cums = cumsFor(i);
      for (let j = 0; j < m; j++) {
        const y0 = yScale(cums[j]!);
        const y1 = yScale(cums[j + 1]!);
        // The gap comes off the far side from the baseline, and only where
        // another segment follows — so the stack's outer tip keeps its full
        // height and the total stays honest. Math.max(0, …) covers a segment
        // thinner than the gap.
        const gap = j < m - 1 ? STACK_SEGMENT_GAP : 0.0;
        const top = r2(Math.min(y0, y1) + (y1 < y0 ? gap : 0.0));
        const hgt = r2(Math.max(0.0, Math.abs(y1 - y0) - gap));
        seriesShapes.push(
          rectangle(
            bx,
            top,
            bw,
            hgt,
            undefined,
            // Phase 883 — a stack SEGMENT's tip carries its OWN series value,
            // never the running total. This is where an interior segment gets
            // its readout: Phase 881 prints the stack TOTAL at the cap and
            // nothing else, and pointed here for the rest.
            datumTip(
              spec.yFields[j]!,
              categories[i]!,
              series[j]![i]!,
              withMark(spec.yFields[j]!, categories[i]!, styleFill(colourFor(j))),
            ),
          ),
        );
      }
    }
  } else if (spec.kind === 'Bar') {
    const bw = groupedBarW;
    const baseY = yScale(0.0);
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const seriesValues = series[j]!;
      for (let i = 0; i < n; i++) {
        const v = seriesValues[i]!;
        const bx = groupedBarX(i, j);
        const vy = yScale(v);
        const top = Math.min(vy, baseY);
        const hgt = r2(Math.abs(vy - baseY));
        seriesShapes.push(
          rectangle(
            bx,
            top,
            bw,
            hgt,
            undefined,
            datumTip(
              spec.yFields[j]!,
              categories[i]!,
              v,
              withMark(spec.yFields[j]!, categories[i]!, styleFill(colour)),
            ),
          ),
        );
      }
    }
  } else if (spec.kind === 'Area' && stacked) {
    // Cumulative bands, bottom band first (painter's order): band j fills
    // between boundary j (below) and boundary j+1 (above); its upper boundary
    // carries the full-strength series edge (Phase 637).
    if (n > 0) {
      const cums = Array.from({ length: n }, (_, i) => cumsFor(i));
      for (let j = 0; j < m; j++) {
        const colour = colourFor(j);
        const yf = spec.yFields[j]!;
        const upper: DrawPoint[] = [];
        for (let i = 0; i < n; i++) upper.push({ x: xCentre(i), y: yScale(cums[i]![j + 1]!) });
        const lowerBoundary: DrawPoint[] = [];
        for (let i = n - 1; i >= 0; i--)
          lowerBoundary.push({ x: xCentre(i), y: yScale(cums[i]![j]!) });
        seriesShapes.push(
          polygon(
            [...upper, ...lowerBoundary],
            seriesTip(yf, withSeriesMark(yf, styleFillOpacity(colour, AREA_FILL_OPACITY))),
          ),
        );
        seriesShapes.push(
          polyline(upper, seriesTip(yf, withSeriesMark(yf, styleStroke(colour, 2.0)))),
        );
      }
    }
  } else if (spec.kind === 'Area') {
    // Overlaid baseline-closed bands in palette order (painter's order: later
    // series draw over earlier); the translucent fill keeps the overlap
    // legible, the Polyline edge keeps each series distinct.
    if (n > 0) {
      const baseY = yScale(0.0);
      for (let j = 0; j < m; j++) {
        const colour = colourFor(j);
        const seriesValues = series[j]!;
        const yf = spec.yFields[j]!;
        const points: DrawPoint[] = [];
        for (let i = 0; i < n; i++) points.push({ x: xCentre(i), y: yScale(seriesValues[i]!) });
        const band: DrawPoint[] = [
          { x: xCentre(0), y: baseY },
          ...points,
          { x: xCentre(n - 1), y: baseY },
        ];
        seriesShapes.push(
          polygon(
            band,
            seriesTip(yf, withSeriesMark(yf, styleFillOpacity(colour, AREA_FILL_OPACITY))),
          ),
        );
        seriesShapes.push(
          polyline(points, seriesTip(yf, withSeriesMark(yf, styleStroke(colour, 2.0)))),
        );
      }
    }
  } else if (spec.kind === 'Line') {
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const seriesValues = series[j]!;
      const points: DrawPoint[] = [];
      for (let i = 0; i < n; i++) points.push({ x: xCentre(i), y: yScale(seriesValues[i]!) });
      seriesShapes.push(
        polyline(
          points,
          seriesTip(spec.yFields[j]!, withSeriesMark(spec.yFields[j]!, styleStroke(colour, 2.0))),
        ),
      );
    }
  } else if (spec.kind === 'Scatter') {
    // Fixed-radius point marks per datum (Phase 636). A non-numeric x/y cell
    // reads 0.0 (`numericOf`'s posture, shared with the other arms) — grounded
    // validation makes that loud upstream, not here.
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const seriesValues = series[j]!;
      const yf = spec.yFields[j]!;
      for (let i = 0; i < n; i++) {
        seriesShapes.push(
          circle(
            xScale(xValues[i]!),
            yScale(seriesValues[i]!),
            4.0,
            // The tip's middle part is the x cell as PROJECTED
            // (`categories[i]`), not the mark id's canonical numeric form: the
            // id is for object constancy, the tip is for a human, and on a
            // temporal axis the projection is the ISO date, not a day count.
            datumTip(
              yf,
              categories[i]!,
              seriesValues[i]!,
              withMark(yf, formatNum(xValues[i]!), styleFill(colour)),
            ),
          ),
        );
      }
    }
  }

  // ── Data labels (Phase 881) — the values, written selectively ───────────────
  //
  // Two states and no third: `Off` (the default, and what an absent field means)
  // and `Ends`. There is deliberately NO all-points mode — a number on every
  // interior point is the clutter this vocabulary exists to prevent, so the API
  // cannot express it. `Ends` names the placements that read on their own:
  //
  //   * BARS label the CAP — above a positive cap, below a negative one, the two
  //     exact mirrors about the cap.
  //   * A GROUPED bar labels every bar. A STACKED bar labels the TOTAL at the
  //     stack cap and nothing else: an interior segment's value is unreadable
  //     against the segment above it, and the legend plus the hover readout
  //     already serve it.
  //   * LINES and AREA EDGES label the LAST point of each series, right of the
  //     endpoint and nudged up off the line.
  //   * SCATTER gets nothing in v1 (recorded decision): a scatter's x IS a value
  //     axis, so its last ROW carries no meaning its first does not, and
  //     labelling by row order would present an accident of the feed as a
  //     reading of the chart.
  //   * PIE is unchanged — its legend already carries `name (NN%)`.
  //
  // Every value goes through `yTickText`, so a label and a tick agree by
  // construction. NO LABEL EVER MOVES A MARGIN: the plot rectangle is decided
  // long before this point, so a label either fits the room the picture already
  // has or it is SUPPRESSED — never clipped, never overlapped, never relocated
  // inside the bar.
  const dataLabelsOn = spec.dataLabels === 'Ends';
  const dataLabelLine = textLineHeight(DATA_LABEL_FONT_SIZE, TEXT_LINE_HEIGHT_FACTOR);
  // Label-role ink at the chrome opacity — NEVER the series colour: a value is a
  // reading of the mark, not a second copy of its identity.
  const dataLabelStyleFor = (anchor: TextAnchor): DrawStyle =>
    textStyle(LABEL_OPACITY, anchor, DATA_LABEL_FONT_SIZE, 'Normal');
  const dataLabelShapes: Shape[] = [];

  /** The single fit gate: `fitsBox` against the room the placement actually has. */
  const pushDataLabel = (
    anchor: TextAnchor,
    x: number,
    baseline: number,
    maxWidth: number,
    maxHeight: number,
    text: string,
  ): boolean => {
    if (!textFitsBox(DATA_LABEL_FONT_SIZE, TEXT_LINE_HEIGHT_FACTOR, maxWidth, maxHeight, text))
      return false;
    dataLabelShapes.push(label(r2(x), r2(baseline), literal(text), dataLabelStyleFor(anchor)));
    return true;
  };

  /** A value at a bar's cap, centred on `cx`. `pitch` is the distance to the NEXT
   * label's centre — the neighbouring bar's slot — so the budget is what
   * separates two labels rather than what fits one bar. */
  const pushCapLabel = (cx: number, pitch: number, v: number): void => {
    const capY = yScale(v);
    const maxWidth = Math.max(0.0, pitch - 2.0 * DATA_LABEL_PADDING);
    if (v < 0.0) {
      pushDataLabel(
        'Middle',
        cx,
        capY + DATA_LABEL_OFFSET_Y + DATA_LABEL_FONT_SIZE,
        maxWidth,
        PLOT_Y1 - capY - DATA_LABEL_OFFSET_Y - DATA_LABEL_PADDING,
        yTickText(v),
      );
    } else {
      pushDataLabel(
        'Middle',
        cx,
        capY - DATA_LABEL_OFFSET_Y,
        maxWidth,
        capY - PLOT_Y0 - DATA_LABEL_OFFSET_Y - DATA_LABEL_PADDING,
        yTickText(v),
      );
    }
  };

  /** The series-endpoint labels, in series order. Two gates, the second the
   * vertical analogue of the cap labels' pitch: every endpoint label shares one
   * x, so the thing they collide with is each other. A label is admitted only
   * when its line clears every ALREADY-ADMITTED one — series order decides who
   * yields, which makes the outcome deterministic. */
  const pushEndpointLabels = (valueAt: (j: number) => number): void => {
    if (n === 0) return;
    const labelX = xCentre(n - 1) + DATA_LABEL_END_OFFSET_X;
    // The budget runs to the PLOT's right edge, not the canvas's: beyond it lies
    // the legend column, and running into it is the collision the gate refuses.
    const maxWidth = Math.max(0.0, PLOT_X1 - labelX - DATA_LABEL_PADDING);
    const admitted: number[] = [];
    for (let j = 0; j < m; j++) {
      const v = valueAt(j);
      const baseline = yScale(v) - DATA_LABEL_END_NUDGE_Y;
      const separated = admitted.every(
        (b) => Math.abs(b - baseline) >= dataLabelLine + DATA_LABEL_PADDING,
      );
      if (!separated) continue;
      if (
        pushDataLabel(
          'Start',
          labelX,
          baseline,
          maxWidth,
          baseline - PLOT_Y0 - DATA_LABEL_PADDING,
          yTickText(v),
        )
      )
        admitted.push(baseline);
    }
  };

  if (dataLabelsOn) {
    if (spec.kind === 'Bar' && stacked) {
      // The TOTAL at the stack cap, once per category.
      for (let i = 0; i < n; i++)
        pushCapLabel(stackedBarX(i) + stackedBarW / 2.0, bandW, cumsFor(i)[m]!);
    } else if (spec.kind === 'Bar') {
      for (let j = 0; j < m; j++)
        for (let i = 0; i < n; i++)
          pushCapLabel(groupedBarX(i, j) + groupedBarW / 2.0, groupedSubW, series[j]![i]!);
    } else if (spec.kind === 'Area' && stacked) {
      // The band's own UPPER boundary is the edge that was drawn, so it is the
      // cumulative value there — not the series' own datum, which is nowhere on
      // the picture.
      const lastCums = n > 0 ? cumsFor(n - 1) : [];
      pushEndpointLabels((j) => lastCums[j + 1]!);
    } else if (spec.kind === 'Line' || spec.kind === 'Area') {
      pushEndpointLabels((j) => series[j]![n - 1]!);
    }
  }

  // ── Legend (Phase 880) — one entry list, four placements ──
  //
  // COLUMN (`Right`, the shipped default): one row per entry, the plot already
  // shrunk by the column above. Rows are TOP-ALIGNED with the plot rather than
  // vertically centred, deliberately: centring makes row j's y a function of the
  // entry COUNT, so adding a series moves every row that was already there —
  // chrome sliding under a data refresh is what the mark-identity rule exists to
  // avoid. Reading order is also series order, which is the order the rows are
  // in. This is what structurally retires the overflow: a band's width is the
  // SUM of its entries, a column's is the MAX of them (bounded and truncated at
  // the bound) with one pitch per entry down 400 px of canvas.
  //
  // BAND (`Top` / `Bottom`): Phase 879's horizontal row, laid out cumulatively
  // from the plot's left edge at each entry's own natural width — unchanged for
  // `Top`, which is the pre-880 shape every pre-880 golden pins. A band that
  // cannot PACK into the plot's width no longer runs off the edge: `bandOverflows`
  // above sends the whole legend to the column instead (operator decision,
  // 2026-08-18), so by the time this arm is reached the entries are known to fit.
  const legendLabelStyle = textStyle(LABEL_OPACITY, 'Start', tickSize, 'Normal');
  const legend: Shape[] = [];
  if (legendPos === 'Right') {
    const swatchX = PLOT_X1 + LEGEND_COLUMN_GAP;
    for (let j = 0; j < legendEntries.length; j++) {
      const rowTop = PLOT_Y0 + LEGEND_ROW_PITCH_Y * j;
      legend.push(
        rectangle(r2(swatchX), r2(rowTop), 10.0, 10.0, 2.0, styleFill(legendEntries[j]![0])),
      );
      legend.push(
        label(
          r2(swatchX + LEGEND_LABEL_OFFSET_X),
          r2(rowTop + LEGEND_LABEL_BASELINE_DY),
          literal(legendTexts[j]!),
          legendLabelStyle,
        ),
      );
    }
  } else if (legendPos === 'Top' || legendPos === 'Bottom') {
    // Phase 878 — the TOP band sits BELOW the subtitle, so it moves down by the
    // line the subtitle took; `subtitleBand` is 0 without one. The BOTTOM band
    // mirrors from the canvas bottom off the band the margin already reserved,
    // so it needs no constants of its own.
    const rowTop = legendPos === 'Bottom' ? H - legendBandH : 34.0 + subtitleBand;
    const baselineY =
      legendPos === 'Bottom' ? rowTop + LEGEND_LABEL_BASELINE_DY : 43.0 + subtitleBand;
    let lx = PLOT_X0;
    for (let j = 0; j < legendEntries.length; j++) {
      // The label offsets from the ROUNDED swatch x, exactly as the reference
      // does — rounding the sum instead can differ in the last 2 dp.
      const sx = r2(lx);
      legend.push(rectangle(sx, r2(rowTop), 10.0, 10.0, 2.0, styleFill(legendEntries[j]![0])));
      legend.push(
        label(
          r2(sx + LEGEND_LABEL_OFFSET_X),
          r2(baselineY),
          literal(legendTexts[j]!),
          legendLabelStyle,
        ),
      );
      // The same `bandEntryWidth` the overflow rule measured against.
      lx += bandEntryWidth(legendTexts[j]!);
    }
  }

  // ── Visible title (a Label — bigger + emphasised) ──
  const titleShapes: Shape[] =
    spec.title !== undefined
      ? [label(r2(PLOT_X0), 22.0, spec.title, textStyle(undefined, 'Start', titleSize, 'Loud'))]
      : [];

  // ── Subtitle (Phase 878) — the muted line under the title ──
  //
  // MUTED (label-role opacity, not the title's full strength) and SMALLER,
  // sharing the title's x and anchor so the pair reads as one block. It draws
  // independently of the title: the top margin has already reserved the line
  // either way.
  const subtitleShapes: Shape[] =
    spec.subtitle !== undefined
      ? [
          label(
            r2(PLOT_X0),
            SUBTITLE_BASELINE_Y,
            boundText(SUBTITLE_FONT_SIZE, PLOT_W, spec.subtitle),
            textStyle(LABEL_OPACITY, 'Start', SUBTITLE_FONT_SIZE, 'Normal'),
          ),
        ]
      : [];

  // ── Pie (Phase 638) — the polar arm: no cartesian chrome ──
  //
  // Bounded v1: exactly ONE series (multi-series pie is a grounded-validation
  // refusal upstream, never a silent first-series truncation) and non-negative
  // values (any negative refuses the geometry — a mixed-sign pie has no honest
  // reading). Zero-value categories draw no wedge but keep their legend row.
  // Wedges start at 12 o'clock and sweep clockwise; arcs are the standard
  // ≤90-degree-segment cubic-Bezier approximation (the closed `CurveCommand`
  // vocabulary has no arc case, deliberately). A lone 100% category
  // degenerates to a `Circle`. Category share reads in the legend
  // ("name (NN%)") — outside labels with leader lines are a later variant.
  //
  // Phase 880 — this emits WEDGES ONLY. The pie's legend was the vertical
  // right-hand column the cartesian arms have now converged on, so it is emitted
  // by the shared `legend` above (from the shared `legendEntries`, which carry
  // the shares) and honours `legendPosition` like any other arm. The guard and
  // the shares were lifted above the margins, because the legend's width is
  // layout input.
  const pieShapes = (): Shape[] => {
    if (pieRefused) return [];

    const cx = r2((PLOT_X0 + PLOT_X1) / 2.0);
    const cy = r2((PLOT_Y0 + PLOT_Y1) / 2.0);
    const radius = 130.0;

    const pt = (a: number): DrawPoint => ({
      x: r2(cx + radius * Math.cos(a)),
      y: r2(cy + radius * Math.sin(a)),
    });

    const arcCubics = (a0: number, a1: number): CurveCommand[] => {
      const segments = Math.max(1, Math.ceil((a1 - a0) / (Math.PI / 2.0) - 1e-9));
      const cmds: CurveCommand[] = [];
      for (let s = 0; s < segments; s++) {
        const t0 = a0 + ((a1 - a0) * s) / segments;
        const t1 = a0 + ((a1 - a0) * (s + 1)) / segments;
        const k = (4.0 / 3.0) * Math.tan((t1 - t0) / 4.0);
        const c1: DrawPoint = {
          x: r2(cx + radius * (Math.cos(t0) - k * Math.sin(t0))),
          y: r2(cy + radius * (Math.sin(t0) + k * Math.cos(t0))),
        };
        const c2: DrawPoint = {
          x: r2(cx + radius * (Math.cos(t1) + k * Math.sin(t1))),
          y: r2(cy + radius * (Math.sin(t1) - k * Math.cos(t1))),
        };
        cmds.push({ kind: 'CubicTo', control1: c1, control2: c2, to: pt(t1) });
      }
      return cmds;
    };

    const starts = [0.0];
    for (const f of pieFractions) starts.push(starts[starts.length - 1]! + f);
    const top = -Math.PI / 2.0;

    // Half the angular padding comes off each end of every wedge (Phase 875),
    // so the separation is a sliver of absent ink — no surface colour is
    // needed and the result is theme-invariant, which a stroked wedge border
    // could not be.
    const halfGap = (WEDGE_GAP_DEGREES * Math.PI) / 360.0;

    const segs: Shape[] = [];
    const yf = spec.yFields[0]!;
    for (let i = 0; i < n; i++) {
      const f = pieFractions[i]!;
      if (f > 0.0) {
        const colour = colourFor(i);
        // The wedge's own VALUE, not its share. The share is already stated,
        // once, in the legend entry (`name (NN%)`); restating it here would
        // leave the magnitude behind the slice the one number still
        // unreachable.
        const markStyle = datumTip(
          yf,
          categories[i]!,
          pieValues[i]!,
          withMark(yf, categories[i]!, styleFill(colour)),
        );
        if (f >= 1.0 - 1e-9) {
          // A lone 100% category is a circle — there is no neighbour to
          // separate from, so no padding.
          segs.push(circle(cx, cy, radius, markStyle));
        } else {
          const a0 = top + 2.0 * Math.PI * starts[i]! + halfGap;
          const a1 = top + 2.0 * Math.PI * starts[i + 1]! - halfGap;
          // A wedge narrower than the padding is DROPPED rather than drawn
          // inverted — the alternative is a sliver sweeping the wrong way
          // round the circle, which is a wrong picture, not a small one.
          if (a1 > a0) {
            const cmds: CurveCommand[] = [
              { kind: 'MoveTo', to: { x: cx, y: cy } },
              { kind: 'LineTo', to: pt(a0) },
              ...arcCubics(a0, a1),
              { kind: 'Close' },
            ];
            segs.push({ kind: 'Curve', commands: cmds, style: markStyle });
          }
        }
      }
    }

    return segs;
  };

  // Pie is polar — no axes/gridlines/tick chrome; every other arm assembles
  // the shared cartesian chrome in painter's order: gridlines (h then v), the
  // zero baseline, axes, tick marks, y-tick + x labels, axis titles, series,
  // legend, chart title.
  const shapes: Shape[] =
    spec.kind === 'Pie'
      ? [...pieShapes(), ...legend, ...titleShapes, ...subtitleShapes]
      : [
          ...gridlines,
          ...xGridlines,
          ...zeroLine,
          ...axes,
          ...tickMarks,
          ...yTickLabels,
          ...xLabels,
          ...axisTitles,
          ...seriesShapes,
          // Phase 881 — the values sit ON the series, so they are painted straight
          // after it and before the legend.
          ...dataLabelShapes,
          ...legend,
          ...titleShapes,
          ...subtitleShapes,
        ];

  // ── The accessible summary (Phase 921) ───────────────────────────────────
  //
  // The grammar is stated at the section head above and normatively in §4i;
  // this is its four clauses in order. A REFUSED PIE announces nothing, for the
  // reason Phase 880 gave when it stopped emitting the refused pie's legend: a
  // claim about data the drawing declined to show.
  const accessibleSummary = ((): string | undefined => {
    if (pieRefused) return undefined;

    const namedSeries = spec.yFields
      .slice(0, SUMMARY_MAX_SERIES_NAMED)
      .map((f) => clampText(SUMMARY_MAX_NAME_CHARS, f))
      .join(', ');

    const seriesClause =
      m === 0
        ? 'no series'
        : m > SUMMARY_MAX_SERIES_NAMED
          ? `${m} series: ${namedSeries}, and ${m - SUMMARY_MAX_SERIES_NAMED} more`
          : `${m} series: ${namedSeries}`;

    // The extent clause follows the X AXIS's own kind, not the chart's: a band
    // axis states its first and last category, a continuous axis its domain
    // endpoints through that axis's own tick formatter.
    const extentClause = isContinuousX
      ? n === 0
        ? 'no points'
        : `${n === 1 ? '1 point: ' : `${n} points: `}${xTickText(xNiceLo)} to ${xTickText(xNiceHi)}`
      : n === 0
        ? 'no categories'
        : n === 1
          ? `1 category: ${clampText(SUMMARY_MAX_NAME_CHARS, categories[0]!)}`
          : `${n} categories: ${clampText(SUMMARY_MAX_NAME_CHARS, categories[0]!)} to ${clampText(
              SUMMARY_MAX_NAME_CHARS,
              categories[n - 1]!,
            )}`;

    // The peak is the largest SINGLE DATUM — never a stacked total, because the
    // clause names one series at one category and a total belongs to neither.
    // Ties resolve to the earliest category then the earliest series (a strict
    // `>` scanned category-major), which is the axis's own reading order. The
    // number takes the value axis's rendering (the Phase-876 formatter at the
    // axis's step precision, plus the axis's display unit in its own words);
    // the category is the datum's OWN label, verbatim, even on a temporal axis.
    const clauses = [summaryKindWords(spec.kind, stacked), seriesClause, extentClause];

    if (n > 0 && m > 0) {
      let bi = 0;
      let bj = 0;
      let bv = series[0]![0]!;
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < m; j++) {
          const v = series[j]![i]!;
          if (v > bv) {
            bv = v;
            bi = i;
            bj = j;
          }
        }
      }
      const unitSuffix = yDisplayUnit.label === '' ? '' : ` ${yDisplayUnit.label}`;
      clauses.push(
        `Peak ${clampText(SUMMARY_MAX_NAME_CHARS, spec.yFields[bj]!)} at ${clampText(
          SUMMARY_MAX_NAME_CHARS,
          categories[bi]!,
        )}, ${yTickText(bv)}${unitSuffix}`,
      );
    }

    return clampText(SUMMARY_MAX_CHARS, `${clauses.join(SUMMARY_CLAUSE_SEPARATOR)}.`);
  })();

  const drawing: DrawingSpec = {
    viewBox: { minX: 0.0, minY: 0.0, width: W, height: H },
    shapes,
    style: {},
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    ...(accessibleSummary !== undefined ? { description: literal(accessibleSummary) } : {}),
  };
  return drawing;
};

/** Lower + wrap the `Drawing` kind in a node envelope (id + kind). */
export const lowerNode = (
  id: string,
  spec: ChartLowerSpec,
  rows: readonly ChartRow[],
  style?: ChartLowerStyle,
): Node<never> => ({
  id: nodeId(id),
  kind: { kind: 'Display', display: { kind: 'Drawing', spec: lower(spec, rows, style) } },
  state: defaults.stateBehaviour<never>(),
  style: defaults.style,
});
