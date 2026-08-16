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
  ChartLegendPosition,
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
 * from the spine, x-axis marks run down from it, so neither eats plot area. */
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
/** The MAGNITUDE of the category-label tilt, in degrees. Tilt is the default
 * state — it is for LEGIBILITY, not a crowding fallback. */
const LABEL_TILT_DEGREES = 30.0;
/** The vertical arm of the escalation: one line height along the axis whatever
 * the label's length, so it packs at any category count. */
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

/** A nice value domain + its tick values for `[lo, hi]`, targeting ~5 ticks. */
const niceDomain = (
  lo: number,
  hi: number,
): { niceLo: number; niceHi: number; step: number; ticks: number[] } => {
  const hiAdj = hi === lo ? lo + 1.0 : hi;
  const targetTicks = 5.0;
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

/** Render `v` with EXACTLY `dps` decimals — round-half-up on the magnitude,
 * comma thousands separators, period decimal point, locale-invariant. */
const renderFixed = (dps: number, v: number): string => {
  if (Number.isNaN(v) || !Number.isFinite(v)) return '0';
  const d = dps < 0 ? 0 : dps > 6 ? 6 : dps;
  const scale = 10.0 ** d;
  const units = Math.floor(Math.abs(v) * scale + 0.5);
  const intPart = Math.floor(units / scale);
  const fracPart = units - intPart * scale;
  const intStr = groupThousands(formatNum(intPart));
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
 * for `Scatter`, numeric) column, the `yFields` series columns, an optional
 * literal `title`, and `stacked` (Bar / Area geometry only — ignored on kinds
 * where stacking is meaningless).
 */
export interface ChartLowerSpec {
  readonly kind: ChartKind;
  readonly xField: string;
  readonly yFields: readonly string[];
  readonly title?: string;
  readonly stacked?: boolean;
  /** Phase 876 — the VALUE axis's number format, reusing the existing `Format`
   * vocabulary. A wire field: a semantic declaration, not an appearance. */
  readonly valueFormat?: Format;
  /**
   * Phase 878 — the axis NAMES and the muted subtitle. Wire fields for the same
   * reason `title` is one: what an axis is CALLED is the author's meaning.
   *
   * Absent is the ORDINARY shape, not an opt-out: each axis title falls back to
   * its capitalised field name, so an axis is never nameless.
   */
  readonly xTitle?: string;
  readonly yTitle?: string;
  /**
   * The natural home for a units statement. Declaring one SUPPRESSES the
   * lowering's own display-unit slot — the author has said it, so the machine
   * does not repeat it.
   */
  readonly subtitle?: string;
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

  // ── Linear x-scale (Phase 636 — the Scatter arm's numeric x axis) ──
  // Scatter reads the x-field NUMERICALLY and plots on a linear x-domain (the
  // first non-band x-scale arm). The domain is NOT zero-anchored — a scatter's
  // x range carries no baseline semantics (the y domain stays zero-anchored
  // with the other arms, deliberately: one shared y-domain rule).
  const isScatter = spec.kind === 'Scatter';
  const xValues = isScatter ? rows.map((r) => numericOf(r, spec.xField)) : [];
  const {
    niceLo: xNiceLo,
    niceHi: xNiceHi,
    step: xStep,
    ticks: xTicks,
  } = isScatter
    ? xValues.length === 0
      ? niceDomain(0.0, 1.0)
      : niceDomain(Math.min(...xValues), Math.max(...xValues))
    : { niceLo: 0.0, niceHi: 1.0, step: 1.0, ticks: [] as number[] };

  // The Scatter arm's x IS a value axis, so its ticks take the same canonical
  // formatter (Phase 876). `valueFormat` is deliberately NOT applied to it: one
  // declared meaning cannot be true of two different measures, and there is no
  // second axis-unit slot to state an x display unit in.
  const xTickText = (v: number): string => formatValue(undefined, 1.0, false, xStep, v);

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
  const axisTitleOf = (declared: string | undefined, fallbackField: string): string | undefined =>
    declared !== undefined
      ? declared
      : fallbackField === ''
        ? undefined
        : capitalise(fallbackField);

  const xTitle = axisTitleOf(spec.xTitle, spec.xField);
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

  // ── Legend placement (Phase 880) ──
  //
  // ONE legend with four placements, resolved HERE — above the margins, because
  // a `Right` legend's column width is an INPUT to the plot rectangle and a
  // `Bottom` legend's band is an input to the bottom margin. Same acyclicity
  // discipline the text metrics established.
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

  // The placement actually used: the author's explicit value where there is one,
  // else the host default. With no entries the answer is `None` whatever either
  // said — so an explicit position on a single-series chart draws nothing and,
  // more to the point, reserves no space.
  const legendPos: ChartLegendPosition =
    legendEntries.length === 0 ? 'None' : (spec.legendPosition ?? LEGEND_POSITION);

  // COLUMN arms: the widest label decides the column, bounded by a share of the
  // canvas and truncated beyond it — the margin autosizes' posture, for the same
  // reason. The band arms pack at natural width and are left as Phase 879
  // shipped them: truncating there would not help, because the overflow is in
  // the SUM, not in any one name.
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
  // Phase 880 — a `Right` legend takes its column off the PLOT, not off the
  // right margin: the margin stays the clearance between the legend's widest
  // label and the canvas edge, exactly as it was the clearance to the plot
  // before. Every other placement leaves `legendColumnW = 0`.
  const PLOT_X1 = W - MARGIN_RIGHT - legendColumnW;
  const PLOT_W = PLOT_X1 - PLOT_X0;

  const bandW = n > 0 ? PLOT_W / n : PLOT_W;
  const centreX = (i: number): number => r2(PLOT_X0 + bandW * (i + 0.5));

  // ── Category-label tilt + its vertical escalation ──
  // Only the BAND arms label categories: Scatter labels numeric x ticks (short
  // by construction, left horizontal) and Pie has no x axis. Both must
  // therefore contribute NO drop, or their bottom margin — and with it the
  // pie's centre — would move for a decision they never take.
  const drawsCategoryLabels = !isScatter && spec.kind !== 'Pie';

  // A rotated label's footprint ALONG the axis is w·cos θ + h·sin θ. Escalate
  // when the widest label's footprint at the tilt no longer fits the band
  // pitch. At 90° the width term vanishes, so the vertical arm packs one label
  // per line height at any count — which is why it is terminal.
  const alongAxisFootprint = (deg: number, w: number): number =>
    w * Math.cos(deg * DEG_TO_RAD) + lineHeight * Math.sin(deg * DEG_TO_RAD);

  const tiltDegrees =
    !drawsCategoryLabels || n === 0 || LABEL_TILT_DEGREES <= 0.0
      ? 0.0
      : alongAxisFootprint(LABEL_TILT_DEGREES, widestOf(categories)) > bandW
        ? VERTICAL_TILT_DEGREES
        : LABEL_TILT_DEGREES;

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
  const categoryTexts = drawsCategoryLabels
    ? categories.map((c) => truncateToWidth(tickSize, categoryTextBudget, c))
    : [];
  const requiredBottom =
    CATEGORY_LABEL_OFFSET_Y +
    sinTilt * widestOf(categoryTexts) +
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

  const xScale = (v: number): number =>
    r2(PLOT_X0 + ((v - xNiceLo) / (xNiceHi - xNiceLo)) * PLOT_W);

  // ── Chrome (assembled in painter's order below) ──
  const axisStyle = styleStrokeInk(AXIS_OPACITY, 1.0);
  const gridStyle = styleStrokeInk(GRID_OPACITY, 1.0);

  const gridlines: Shape[] = ticks.map((t) => {
    const y = yScale(t);
    return line(r2(PLOT_X0), y, r2(PLOT_X1), y, gridStyle);
  });

  // Vertical gridlines — the Scatter arm only (Phase 875). A linear x-scale has
  // readable x positions, so a reader traces a point back to an x value the
  // same way the horizontal grid lets them trace a y value. A BAND x-axis has
  // no such positions to trace (a category is a label, not a magnitude), so a
  // vertical rule there would be decoration.
  const xGridlines: Shape[] = isScatter
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
  const tickMarks: Shape[] = (() => {
    if (TICK_MARK_LENGTH <= 0.0) return [];
    const yMarks: Shape[] = ticks.map((t) => {
      const y = yScale(t);
      return line(r2(PLOT_X0 - TICK_MARK_LENGTH), y, r2(PLOT_X0), y, axisStyle);
    });
    const xAt = (x: number): Shape =>
      line(x, r2(PLOT_Y1), x, r2(PLOT_Y1 + TICK_MARK_LENGTH), axisStyle);
    const xMarks: Shape[] = isScatter
      ? xTicks.map((t) => xAt(xScale(t)))
      : Array.from({ length: n }, (_, i) => xAt(centreX(i)));
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
  // A tilted category label is `End`-anchored at the band centre and rotated
  // NEGATIVELY (counter-clockwise, against `rotation`'s clockwise convention):
  // the anchor is the pivot, so the text ENDS under the band's tick and runs
  // back down-and-left, reading up-to-the-right into it. The opposite sign
  // would swing the same text up into the plot area. At 90° this degenerates
  // to reading bottom-up. Scatter's numeric ticks stay horizontal + Middle.
  const tiltedLabelStyle: DrawStyle = {
    ...textStyle(LABEL_OPACITY, 'End', tickSize, 'Normal'),
    rotation: r2(-tiltDegrees),
  };

  const xLabels: Shape[] = isScatter
    ? xTicks.map((t) =>
        label(
          xScale(t),
          r2(PLOT_Y1 + CATEGORY_LABEL_OFFSET_Y),
          literal(xTickText(t)),
          textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal'),
        ),
      )
    : categoryTexts.map((c, i) =>
        label(
          centreX(i),
          r2(PLOT_Y1 + CATEGORY_LABEL_OFFSET_Y),
          literal(c),
          tiltDegrees > 0.0
            ? tiltedLabelStyle
            : textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal'),
        ),
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
  // note (§4e) and deliberately NOT wired: nothing here can tell a date column
  // from a string one, and inferring it from the label text would be a guess.
  const boundText = (fontSize: number, extent: number, t: string): string =>
    truncateToWidth(fontSize, extent, t);

  const axisTitles: Shape[] = [];
  if (xTitle !== undefined) {
    axisTitles.push(
      label(
        r2((PLOT_X0 + PLOT_X1) / 2.0),
        // Phase 880 — the x title rides ABOVE a `Bottom` legend band, keeping
        // its own inset from whatever is beneath it. `legendBandH` is 0 on
        // every other arm.
        r2(H - legendBandH - AXIS_TITLE_BOTTOM_OFFSET),
        literal(boundText(tickSize, PLOT_W, xTitle)),
        textStyle(undefined, 'Middle', tickSize, 'Normal'),
      ),
    );
  }
  if (yTitle !== undefined) {
    axisTitles.push(
      label(
        r2(Y_AXIS_TITLE_OFFSET_X),
        r2((PLOT_Y0 + PLOT_Y1) / 2.0),
        literal(boundText(tickSize, PLOT_H, yTitle)),
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

  // ── Series geometry ──
  const seriesShapes: Shape[] = [];
  if (spec.kind === 'Bar' && stacked) {
    // One capped bar per category, centred in its band; series stack as
    // segments between consecutive cumulative sums (Phase 637), each
    // shortened by STACK_SEGMENT_GAP on the side facing the next segment so
    // the boundaries read as gaps rather than colour changes (Phase 875).
    const groupW = bandW * 0.7;
    const bw = r2(Math.min(groupW * 0.9, BAR_MAX_THICKNESS));
    for (let i = 0; i < n; i++) {
      const bx = r2(PLOT_X0 + bandW * i + (bandW - bw) / 2.0);
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
            withMark(spec.yFields[j]!, categories[i]!, styleFill(colourFor(j))),
          ),
        );
      }
    }
  } else if (spec.kind === 'Bar') {
    const groupW = bandW * 0.7;
    const subW = m > 0 ? groupW / m : groupW;
    const bw = r2(Math.min(subW * 0.9, BAR_MAX_THICKNESS));
    const baseY = yScale(0.0);
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const seriesValues = series[j]!;
      for (let i = 0; i < n; i++) {
        const v = seriesValues[i]!;
        // Centre the (possibly capped) bar in its own sub-slot, so a cap
        // takes air off BOTH sides and the group stays symmetric about the
        // band centre.
        const slotX = PLOT_X0 + bandW * i + (bandW - groupW) / 2.0 + j * subW;
        const bx = r2(slotX + (subW - bw) / 2.0);
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
            withMark(spec.yFields[j]!, categories[i]!, styleFill(colour)),
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
        for (let i = 0; i < n; i++) upper.push({ x: centreX(i), y: yScale(cums[i]![j + 1]!) });
        const lowerBoundary: DrawPoint[] = [];
        for (let i = n - 1; i >= 0; i--)
          lowerBoundary.push({ x: centreX(i), y: yScale(cums[i]![j]!) });
        seriesShapes.push(
          polygon(
            [...upper, ...lowerBoundary],
            withSeriesMark(yf, styleFillOpacity(colour, AREA_FILL_OPACITY)),
          ),
        );
        seriesShapes.push(polyline(upper, withSeriesMark(yf, styleStroke(colour, 2.0))));
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
        for (let i = 0; i < n; i++) points.push({ x: centreX(i), y: yScale(seriesValues[i]!) });
        const band: DrawPoint[] = [
          { x: centreX(0), y: baseY },
          ...points,
          { x: centreX(n - 1), y: baseY },
        ];
        seriesShapes.push(
          polygon(band, withSeriesMark(yf, styleFillOpacity(colour, AREA_FILL_OPACITY))),
        );
        seriesShapes.push(polyline(points, withSeriesMark(yf, styleStroke(colour, 2.0))));
      }
    }
  } else if (spec.kind === 'Line') {
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const seriesValues = series[j]!;
      const points: DrawPoint[] = [];
      for (let i = 0; i < n; i++) points.push({ x: centreX(i), y: yScale(seriesValues[i]!) });
      seriesShapes.push(
        polyline(points, withSeriesMark(spec.yFields[j]!, styleStroke(colour, 2.0))),
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
            withMark(yf, formatNum(xValues[i]!), styleFill(colour)),
          ),
        );
      }
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
  // `Top`, which is the pre-880 shape every pre-880 golden pins.
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
      lx += LEGEND_LABEL_OFFSET_X + textWidth(tickSize, legendTexts[j]!) + LEGEND_ENTRY_GAP;
    }
  }

  // ── Visible title (a Label — bigger + emphasised) ──
  const titleShapes: Shape[] =
    spec.title !== undefined
      ? [
          label(
            r2(PLOT_X0),
            22.0,
            literal(spec.title),
            textStyle(undefined, 'Start', titleSize, 'Loud'),
          ),
        ]
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
            literal(boundText(SUBTITLE_FONT_SIZE, PLOT_W, spec.subtitle)),
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
        const markStyle = withMark(yf, categories[i]!, styleFill(colour));
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
          ...legend,
          ...titleShapes,
          ...subtitleShapes,
        ];

  const drawing: DrawingSpec = {
    viewBox: { minX: 0.0, minY: 0.0, width: W, height: H },
    shapes,
    style: {},
    ...(spec.title !== undefined ? { title: literal(spec.title) } : {}),
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
