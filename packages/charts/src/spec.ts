// @fuaran-ui/charts — the chart spec (the neutral cross-host lowering input) and
// row field extraction.
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type {
  ChartAnnotation,
  ChartDataLabels,
  ChartKind,
  ChartLegendPosition,
  ChartScale,
  ChartXScale,
  Format,
  TextSource,
} from '@fuaran-ui/schema';

import { decimalToFloat } from '@fuaran-ui/core-twins';
import { isDecimalCell } from '@fuaran-ui/schema';

import { formatNum } from './layout.js';
import type { ChartAxisUnitMode } from './numberFormat.js';

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
  /**
   * The series columns. EMPTY means every numeric column of the rows but
   * `xField`, Ordinal-ordered and named by column (Phase 2568).
   */
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
  /**
   * Phase 1490 — the data-addressed annotations (§4l): reference lines, event
   * markers and range bands, one closed union. An annotation names a place in
   * the DATA's coordinates and, optionally, a label; it carries no geometry and
   * no style at all — every pixel comes from the constants above.
   *
   * Absent (and empty) draws nothing, so a pre-1490 spec lowers byte-for-byte.
   */
  readonly annotations?: readonly ChartAnnotation[];
  /**
   * Phase 2655 — a `Heatmap`'s DECLARED colour scale: sequential from a floor,
   * or diverging about a midpoint. The author states what the value means; the
   * lowering picks the ramp stop. No colour crosses the wire ("Gap 6").
   *
   * Absent means sequential over the data's extent. Read by `Heatmap` only.
   */
  readonly scale?: ChartScale;
  /**
   * Phase 2809 (D38) — the column whose boolean `true` marks a row WITHHELD by a
   * disclosure gate: the row draws a placeholder and the readout "withheld",
   * never its value and never a zero. Absent means nothing is withheld.
   */
  readonly withheldField?: string;
  /**
   * Phase 2654 (D39) — the mark channels. `interval` names the low and high
   * columns of the single series (Bar, Line, Area, Scatter); `sizeField` sizes a
   * Scatter point by area; `sortBy` orders the rows before layout (Bar, Line,
   * Area, Pie on a non-temporal x); `pathField` joins a Scatter series' points in
   * that column's order. A channel on a kind that does not read it is
   * NEUTRALISED; every one obeys the gap rule.
   */
  readonly interval?: { readonly low: string; readonly high: string };
  readonly sizeField?: string;
  readonly sortBy?: { readonly field: string; readonly direction: 'asc' | 'desc' };
  readonly pathField?: string;
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
/** Every `ChartKind` lowers first-party since `Heatmap` gained its arm (Phase 2655). */
export const isLowered = (_kind: ChartKind): boolean => true;

// ─── Row field extraction ─────────────────────────────────────────────────────

/**
 * Phase 2809 (D38) — a value cell, or `undefined` when it is MISSING. Present is a
 * finite number, an exact decimal the float range holds, or a boolean (1/0, as
 * FUARAN087 and the Heatmap arm read it); everything else — an empty cell, a
 * string, a date, a non-finite number — is missing, and a missing value is drawn
 * as a GAP on every arm, never as a zero. Until this phase the series arms read it
 * as `0.0`, so a bar whose value was missing was drawn at height zero.
 *
 * Non-finite (Phase 640): NaN/Infinity would poison every domain computation.
 * Wire-carried data can never be non-finite, so that arm covers host-side rows
 * only. Phase 2006 — THE one place an exact decimal becomes a number: a screen
 * coordinate is a display projection of the number, and the row is untouched.
 */
export const presentValueOf = (row: ChartRow, field: string): number | undefined => {
  const v = row[field];
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  if (isDecimalCell(v)) return decimalToFloat(v.text) ?? undefined;
  return undefined;
};

/** Phase 2809 (D38) — whether a row is WITHHELD: its cell in the declared
 * `withheldField` is the boolean `true`. Any other cell, or no declaration, leaves
 * the row to its values. A withheld row's values are never read. */
export const isWithheldRow = (withheldField: string | undefined, row: ChartRow): boolean =>
  withheldField !== undefined && row[withheldField] === true;

/** Phase 2809 — the word a WITHHELD datum's readout ends in, where a released
 * datum's ends in its number. */
export const WITHHELD_WORD = 'withheld';

/** Phase 2654 — the dash between an interval's two ends in a readout. */
export const INTERVAL_DASH = ' – ';

/** Phase 2654 — the readout of an interval band (a series-level mark). */
export const INTERVAL_WORD = 'interval';

/** Phase 2809 — the side of a WITHHELD value's placeholder: an outlined, unfilled
 * square centred on the value axis's zero line. A fixed size, so no height implies
 * a value. The reference host's `ChartStyle.WithheldMarkSize`. */
export const WITHHELD_MARK_SIZE = 8.0;

// ─── The mark channels (Phase 2654, D39, WIRE_FORMAT §3.6.37) ─────────────────

/** The smallest radius a SIZED Scatter point takes: a floor, so a small value
 * still draws a visible point. The reference host's `ChartStyle.ScatterMinRadius`. */
export const SCATTER_MIN_RADIUS = 2.0;

/** The radius of the largest size drawn; above the floor a point's AREA is
 * proportional to its size. The reference host's `ChartStyle.ScatterMaxRadius`. */
export const SCATTER_MAX_RADIUS = 16.0;

/** The width of an interval's end caps (an error bar). `ChartStyle.IntervalCapWidth`. */
export const INTERVAL_CAP_WIDTH = 8.0;

/** The fill opacity of an interval BAND on a Line or an Area. `ChartStyle.IntervalBandOpacity`. */
export const INTERVAL_BAND_OPACITY = 0.2;

/** Whether the chart's `interval` is read: one series on a Bar, Line, Area or Scatter. */
export const intervalApplies = (spec: ChartLowerSpec): boolean =>
  spec.interval !== undefined &&
  spec.yFields.length === 1 &&
  (spec.kind === 'Bar' || spec.kind === 'Line' || spec.kind === 'Area' || spec.kind === 'Scatter');

/** A Scatter-only channel's column, or `undefined` off Scatter. */
export const scatterChannel = (
  spec: ChartLowerSpec,
  field: string | undefined,
): string | undefined => (spec.kind === 'Scatter' ? field : undefined);

/** The chart's `sortBy` when it is read: a Bar, Line, Area or Pie whose x is not
 * temporal (a temporal axis places each row at its date). */
export const sortApplies = (spec: ChartLowerSpec): ChartLowerSpec['sortBy'] =>
  spec.xScale === 'Temporal'
    ? undefined
    : spec.kind === 'Bar' || spec.kind === 'Line' || spec.kind === 'Area' || spec.kind === 'Pie'
      ? spec.sortBy
      : undefined;

/** Phase 2654 (D39) — the rows in the declared `sortBy` order: by the row's
 * PRESENT numeric value in the sort column; rows whose key is missing, and every
 * WITHHELD row, follow in source order. Stable, so equal keys keep their source
 * order. A chart that declares no order, or whose kind does not read one, keeps
 * its source order. */
export const sortedRows = (
  spec: ChartLowerSpec,
  rows: readonly ChartRow[],
): readonly ChartRow[] => {
  const sort = sortApplies(spec);
  if (sort === undefined) return rows;
  const present: (readonly [number, ChartRow])[] = [];
  const missing: ChartRow[] = [];
  for (const r of rows) {
    const k = isWithheldRow(spec.withheldField, r) ? undefined : presentValueOf(r, sort.field);
    if (k === undefined) missing.push(r);
    else present.push([k, r] as const);
  }
  present.sort(sort.direction === 'asc' ? (a, b) => a[0] - b[0] : (a, b) => b[0] - a[0]);
  return [...present.map(([, r]) => r), ...missing];
};

// ─── Series read from the rows (Phase 2568, WIRE_FORMAT §3.6.29) ──────────────
//
// An EMPTY `yFields` means the chart's series are its rows' numeric columns: every
// column other than `xField` that at least one row carries as a number (a number
// or a decimal cell) and no row carries as a string, a boolean or a date. An empty
// cell (`null`, or a key the row does not hold) says nothing either way, and so —
// as in the reference host's cell projection — does a value of no recognised
// type. Ordinal by column name: a decoded row is a map, and the canonical wire
// writes an object's members Ordinal-sorted, so it is the one order every host
// derives alike. A non-empty `yFields` is returned as authored.

const ordinal = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

/** The numeric columns of `rows` other than `xField`, Ordinal-ordered (Phase 2568). */
export const derivedSeriesFields = (xField: string, rows: readonly ChartRow[]): string[] => {
  const numeric = new Set<string>();
  const disqualified = new Set<string>();
  for (const row of rows) {
    for (const column of Object.keys(row)) {
      if (column === xField) continue;
      const v = row[column];
      if (typeof v === 'number' || isDecimalCell(v)) numeric.add(column);
      else if (typeof v === 'string' || typeof v === 'boolean' || v instanceof Date)
        disqualified.add(column);
    }
  }
  return [...numeric].filter((c) => !disqualified.has(c)).sort(ordinal);
};

/** The series a chart plots: its authored `yFields`, or the columns derived from `rows`. */
export const seriesFieldsOf = (
  spec: ChartLowerSpec,
  rows: readonly ChartRow[],
): readonly string[] =>
  spec.yFields.length > 0 ? spec.yFields : derivedSeriesFields(spec.xField, rows);

export const stringOf = (row: ChartRow, field: string): string => {
  const v = row[field];
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return formatNum(v);
  if (v === null || v === undefined) return '';
  return String(v);
};

export const capitalise = (s: string): string =>
  s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
