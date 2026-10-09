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
  ChartXScale,
  Format,
  TextSource,
} from '@fuaran-ui/schema';

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

export const numericOf = (row: ChartRow, field: string): number => {
  const v = row[field];
  if (typeof v === 'boolean') return v ? 1.0 : 0.0;
  // Non-finite guard (Phase 640): NaN/Infinity would poison every domain
  // computation and emit NaN geometry into the SVG. Wire-carried data can
  // never be non-finite (the canonical-float codec rejects it), so this covers
  // only host-side rows — coerced to the same 0.0 the non-numeric posture uses.
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0.0;
  return 0.0;
};

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
