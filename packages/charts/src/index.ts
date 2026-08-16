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
const MARGIN_BOTTOM = 56.0; // x-axis category labels + x-axis title
const MARGIN_LEFT = 64.0; // right-aligned y-axis tick labels

const PLOT_X0 = MARGIN_LEFT;
const PLOT_X1 = W - MARGIN_RIGHT;
const PLOT_Y0 = MARGIN_TOP;
const PLOT_Y1 = H - MARGIN_BOTTOM;
const PLOT_W = PLOT_X1 - PLOT_X0;
const PLOT_H = PLOT_Y1 - PLOT_Y0;

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

  const yScale = (v: number): number => r2(PLOT_Y1 - ((v - niceLo) / (niceHi - niceLo)) * PLOT_H);

  const bandW = n > 0 ? PLOT_W / n : PLOT_W;
  const centreX = (i: number): number => r2(PLOT_X0 + bandW * (i + 0.5));

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

  const xScale = (v: number): number =>
    r2(PLOT_X0 + ((v - xNiceLo) / (xNiceHi - xNiceLo)) * PLOT_W);

  const tickSize = 13.0;
  const titleSize = 18.0;

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

  // y-axis tick labels — right-anchored (End) in the left margin.
  const yTickLabels: Shape[] = ticks.map((t) =>
    label(
      r2(PLOT_X0 - TICK_LABEL_GAP),
      r2(yScale(t) + 4.0),
      literal(yTickText(t)),
      textStyle(LABEL_OPACITY, 'End', tickSize, 'Normal'),
    ),
  );

  // x-axis labels — band arms label each category under its band centre;
  // Scatter labels its numeric x-ticks along the linear axis (Phase 636).
  const xLabels: Shape[] = isScatter
    ? xTicks.map((t) =>
        label(
          xScale(t),
          r2(PLOT_Y1 + 20.0),
          literal(xTickText(t)),
          textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal'),
        ),
      )
    : categories.map((c, i) =>
        label(
          centreX(i),
          r2(PLOT_Y1 + 20.0),
          literal(c),
          textStyle(LABEL_OPACITY, 'Middle', tickSize, 'Normal'),
        ),
      );

  // ── Axis titles (a name on both axes) ──
  const axisTitles: Shape[] = [
    label(
      r2((PLOT_X0 + PLOT_X1) / 2.0),
      r2(H - 12.0),
      literal(capitalise(spec.xField)),
      textStyle(undefined, 'Middle', tickSize, 'Normal'),
    ),
    label(
      r2(8.0),
      r2(PLOT_Y0 - 12.0),
      // The top-left slot states the value axis's DISPLAY UNIT once when
      // scaling applies, and otherwise keeps the horizontal "Value" hint.
      literal(yDisplayUnit.label === '' ? 'Value' : yDisplayUnit.label),
      textStyle(undefined, 'Start', tickSize, 'Normal'),
    ),
  ];

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

  // ── Legend (only when >1 series) — a swatch + series name per series ──
  const legend: Shape[] = [];
  if (m > 1) {
    for (let j = 0; j < m; j++) {
      const colour = colourFor(j);
      const lx = r2(PLOT_X0 + j * 100.0);
      legend.push(rectangle(lx, 34.0, 10.0, 10.0, 2.0, styleFill(colour)));
      legend.push(
        label(
          r2(lx + 15.0),
          43.0,
          literal(spec.yFields[j]!),
          textStyle(LABEL_OPACITY, 'Start', tickSize, 'Normal'),
        ),
      );
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
  const pieShapes = (): Shape[] => {
    const pieValues = m === 1 ? series[0]! : [];
    const refused = m !== 1 || pieValues.some((v) => v < 0.0);
    const total = pieValues.reduce((a, b) => a + b, 0.0);
    if (refused || total <= 0.0) return [];

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

    const fractions = pieValues.map((v) => v / total);
    const starts = [0.0];
    for (const f of fractions) starts.push(starts[starts.length - 1]! + f);
    const top = -Math.PI / 2.0;

    // Half the angular padding comes off each end of every wedge (Phase 875),
    // so the separation is a sliver of absent ink — no surface colour is
    // needed and the result is theme-invariant, which a stroked wedge border
    // could not be.
    const halfGap = (WEDGE_GAP_DEGREES * Math.PI) / 360.0;

    const segs: Shape[] = [];
    const yf = spec.yFields[0]!;
    for (let i = 0; i < n; i++) {
      const f = fractions[i]!;
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

    // Vertical category legend on the right — categories take the palette
    // roles a cartesian chart gives its series.
    const pieLegend: Shape[] = [];
    for (let i = 0; i < n; i++) {
      const ly = 70.0 + 20.0 * i;
      pieLegend.push(rectangle(r2(W - 168.0), r2(ly), 10.0, 10.0, 2.0, styleFill(colourFor(i))));
      // Routed through the canonical formatter (Phase 876) — one rounding +
      // rendering rule for every number this module prints. A share is a whole
      // percent here, so the shipped `NN%` shape is unchanged.
      const pct = formatValue(undefined, 1.0, false, 1.0, fractions[i]! * 100.0);
      pieLegend.push(
        label(
          r2(W - 153.0),
          r2(ly + 9.0),
          literal(`${categories[i]!} (${pct}%)`),
          textStyle(LABEL_OPACITY, 'Start', tickSize, 'Normal'),
        ),
      );
    }

    return [...segs, ...pieLegend];
  };

  // Pie is polar — no axes/gridlines/tick chrome; every other arm assembles
  // the shared cartesian chrome in painter's order: gridlines (h then v), the
  // zero baseline, axes, tick marks, y-tick + x labels, axis titles, series,
  // legend, chart title.
  const shapes: Shape[] =
    spec.kind === 'Pie'
      ? [...pieShapes(), ...titleShapes]
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
