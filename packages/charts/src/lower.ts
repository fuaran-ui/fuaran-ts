// @fuaran-ui/charts — the Chart → Drawing lowering.
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type {
  ChartAnnotationRange,
  ChartAnnotationX,
  ChartLegendPosition,
  CurveCommand,
  DrawPoint,
  DrawStyle,
  DrawingSpec,
  Node,
  Shape,
  TextAnchor,
  TextSource,
} from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';

import {
  ANNOTATION_LABEL_FONT_SIZE,
  ANNOTATION_LABEL_NUDGE_Y,
  ANNOTATION_LABEL_OFFSET_X,
  ANNOTATION_LABEL_PADDING,
  AREA_FILL_OPACITY,
  AXIS_LABEL_PADDING,
  AXIS_OPACITY,
  AXIS_TITLE_BOTTOM_OFFSET,
  BAND_OPACITY,
  BAR_MAX_THICKNESS,
  CATEGORY_LABEL_OFFSET_Y,
  DATA_LABEL_END_NUDGE_Y,
  DATA_LABEL_END_OFFSET_X,
  DATA_LABEL_FONT_SIZE,
  DATA_LABEL_OFFSET_Y,
  DATA_LABEL_PADDING,
  EVENT_OPACITY,
  EVENT_STROKE_WIDTH,
  GRID_OPACITY,
  H,
  INK,
  LABEL_OPACITY,
  LABEL_TILT_DEGREES,
  LEGEND_COLUMN_GAP,
  LEGEND_COLUMN_MAX_SHARE,
  LEGEND_ENTRY_GAP,
  LEGEND_LABEL_BASELINE_DY,
  LEGEND_LABEL_OFFSET_X,
  LEGEND_POSITION,
  LEGEND_ROW_PITCH_Y,
  MARGIN_BOTTOM,
  MARGIN_BOTTOM_MAX_SHARE,
  MARGIN_LEFT,
  MARGIN_LEFT_MAX_SHARE,
  MARGIN_RIGHT,
  MARGIN_TOP,
  REFERENCE_OPACITY,
  REFERENCE_STROKE_WIDTH,
  STACK_SEGMENT_GAP,
  SUBTITLE_BASELINE_Y,
  SUBTITLE_FONT_SIZE,
  TARGET_TICK_COUNT,
  TEXT_LINE_HEIGHT_FACTOR,
  TICK_FONT_SIZE,
  TICK_LABEL_GAP,
  TICK_MARK_LENGTH,
  VERTICAL_TILT_DEGREES,
  W,
  WEDGE_GAP_DEGREES,
  Y_AXIS_TITLE_DEGREES,
  Y_AXIS_TITLE_OFFSET_X,
  colourFor,
  formatNum,
  niceDomain,
  r2,
} from './layout.js';
import {
  DEG_TO_RAD,
  textFitsBox,
  textLineHeight,
  textWidth,
  truncateToWidth,
} from './textMetrics.js';
import type { ChartAxisUnitMode } from './numberFormat.js';
import {
  DISPLAY_UNIT_MIN_EXPONENT,
  formatValue,
  formatValueScale,
  resolveDisplayUnit,
} from './numberFormat.js';
import type { TemporalStep } from './temporalAxis.js';
import {
  chooseTemporalStep,
  extentOf,
  nominalDays,
  temporalDayOf,
  temporalDomain,
  temporalLabel,
  temporalTicks,
  tryParseDay,
} from './temporalAxis.js';
import {
  TIP_SEPARATOR,
  circle,
  label,
  line,
  literal,
  polygon,
  polyline,
  rectangle,
  styleFill,
  styleFillOpacity,
  styleStroke,
  styleStrokeInk,
  textStyle,
  withMark,
  withSeriesMark,
  withTip,
} from './shapes.js';
import type { ChartLowerSpec, ChartLowerStyle, ChartRow } from './spec.js';
import { capitalise, numericOf, stringOf } from './spec.js';
import {
  SUMMARY_CLAUSE_SEPARATOR,
  SUMMARY_MAX_ANNOTATIONS_NAMED,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_NAME_CHARS,
  SUMMARY_MAX_SERIES_NAMED,
  clampText,
  summaryKindWords,
} from './summary.js';

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

  // Hoisted here (Phase 1490): the annotation slots below are neutralised on the
  // polar arm, so the answer is needed before the value domain rather than after
  // it.
  const isPie = spec.kind === 'Pie';

  // ── Data-addressed annotations (Phase 1490 — §4l) ──────────────────────────
  //
  // The reference lines, in DOCUMENT ORDER, which is what `<n>` in the mark id
  // `annotation|reference|<n>` indexes. The index is per CASE, so a later member
  // of a different case never renumbers one of these.
  //
  // PIE IS EXCLUDED, and neutralised rather than half-applied: the polar arm has
  // no value axis, so a value-axis address names nothing there.
  //
  // A NON-FINITE VALUE IS DROPPED HERE, and the lowering stays TOTAL. It cannot
  // arrive from the wire (the decoder refuses it) and it is refused pre-emit on
  // the authoring path, so this filter is the third gate and not the first: what
  // it buys is that a lowering handed one anyway draws the chart it can rather
  // than taking the nice-domain, every gridline and every mark to NaN.
  const annotationsDeclared = spec.annotations ?? [];
  const referenceLines: readonly (readonly [number, TextSource | undefined])[] = isPie
    ? []
    : annotationsDeclared.flatMap((a) =>
        a.kind === 'ReferenceLine' && Number.isFinite(a.value) ? [[a.value, a.label] as const] : [],
      );

  // ── Range bands (Phase 1492 — §4l) ─────────────────────────────────────────
  //
  // The band subsequence in DOCUMENT ORDER, carrying its per-case index — `<n>`
  // in `annotation|band|<n>` — because the two arms are resolved in two different
  // places and a band's identity must not depend on which. A value band's ends
  // must join the value domain HERE, before the axis is nice-d; an x band's
  // addresses cannot be resolved until the axis form is known, further down.
  // Numbering once, over the whole case, is what keeps the two halves from
  // inventing two orderings of one list.
  const rangeBandsDeclared: readonly (readonly [
    number,
    ChartAnnotationRange,
    TextSource | undefined,
  ])[] = isPie
    ? []
    : annotationsDeclared
        .flatMap((a) => (a.kind === 'RangeBand' ? [[a.range, a.label] as const] : []))
        .map(([range, lbl], i) => [i, range, lbl] as const);

  /** The VALUE-axis bands, as `(index, lo, hi, label)` in the axis's own units.
   * `lo`/`hi` are the pair NORMALISED, not the pair as authored: an unordered
   * pair is refused at the wire boundary and pre-emit, so what reaches here
   * backwards came through a construction site neither gate sits on — and the
   * lowering's job at that point is to stay TOTAL and draw the region the author
   * named. A non-finite end drops the WHOLE band rather than half of it: half a
   * band is not a smaller claim, it is a different one. */
  const valueBands: readonly (readonly [number, number, number, TextSource | undefined])[] =
    rangeBandsDeclared.flatMap(([i, range, lbl]) =>
      range.kind === 'ValueRange' && Number.isFinite(range.from) && Number.isFinite(range.to)
        ? [[i, Math.min(range.from, range.to), Math.max(range.from, range.to), lbl] as const]
        : [],
    );

  const allValuesRaw = [
    ...(stacked ? Array.from({ length: n }, (_, i) => cumsFor(i)).flat() : series.flat()),
    // §4l rule 3 — AN ADDRESS PARTICIPATES IN THE DOMAIN IT ADDRESSES, on the
    // same terms the series data does, and BEFORE the axis is nice-d. A
    // threshold above every bar is still drawn, and the axis says so; clamping
    // the line to the data's own domain would draw a line at a value that is not
    // the value declared, which is worse than not drawing it at all.
    ...referenceLines.map(([v]) => v),
    // Phase 1492 — a value band's BOTH ends join the domain, on exactly the same
    // rule. Clipping it at the data's own maximum would draw a band that ends
    // where the author did not end it.
    ...valueBands.flatMap(([, lo, hi]) => [lo, hi]),
  ];
  const values = allValuesRaw.length > 0 ? allValuesRaw : [0.0];
  const [dataMin, dataMax] = extentOf(values);
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

  // ── Event markers (Phase 1491 — §4l) ───────────────────────────────────────
  //
  // The vertical half of the annotation family, in DOCUMENT ORDER within its own
  // case — which is what `<n>` in the mark id `annotation|event|<n>` indexes, and
  // why a reference line landing between two of these never renumbers them.
  //
  // ONE FORM PER CHART, which is what lets the resolved address be a single
  // number. §4l rule 1 admits a `Category` key on a BAND axis and a `Date` under
  // a TEMPORAL one, and those two axes are mutually exclusive — so every marker
  // this lowering admits carries the chart's one form, and the number is a BAND
  // INDEX under `bandX` and a DAY NUMBER under `isTemporal`.
  //
  // PIE IS NEUTRALISED and Scatter's numeric x admits neither form: a polar arm
  // has no x axis at all, and a continuous NUMERIC x has neither bands to name
  // nor a calendar to name a day in.
  //
  // THE DROPS HERE ARE THE THIRD GATE, not the first — a mismatched form, an
  // unparseable date and an ungrounded key are all refused upstream. A DUPLICATED
  // key resolves to the FIRST matching band, deterministically: the picture is
  // then well-defined even though the validator is right to refuse it.
  const bandX = !isTemporal && !isScatter && !isPie;

  const resolveAnnotationX = (at: ChartAnnotationX): number | undefined => {
    if (at.kind === 'Category' && bandX) {
      const i = categories.indexOf(at.key);
      return i < 0 ? undefined : i;
    }
    if (at.kind === 'Date' && isTemporal) return tryParseDay(at.iso);
    return undefined;
  };

  const eventMarkers: readonly (readonly [number, TextSource | undefined])[] =
    annotationsDeclared.flatMap((a) => {
      if (a.kind !== 'EventMarker') return [];
      const at = resolveAnnotationX(a.at);
      return at === undefined ? [] : [[at, a.label] as const];
    });

  /** The X-AXIS bands (Phase 1492), as `(index, from, to, label)` with the two
   * addresses RESOLVED to the chart's one form, exactly as `eventMarkers`
   * resolves its single address and for the same reason.
   *
   * BOTH ENDS MUST BE THE SAME FORM. A `Category` paired with a `Date` is a
   * mismatch the validator refuses; here it simply yields no band, because half a
   * pair addresses no interval. The pair is NORMALISED, on `valueBands`'
   * argument. */
  const xBands: readonly (readonly [number, number, number, TextSource | undefined])[] =
    rangeBandsDeclared.flatMap(([i, range, lbl]) => {
      if (range.kind !== 'XRange') return [];
      const a = resolveAnnotationX(range.from);
      const b = resolveAnnotationX(range.to);
      return a === undefined || b === undefined
        ? []
        : [[i, Math.min(a, b), Math.max(a, b), lbl] as const];
    });

  /** §4l rule 3 on the X axis — A TEMPORAL ADDRESS ENTERS THE EXTENT, before the
   * ticks are chosen, on the same terms the row dates do. A launch marked a month
   * after the last datum is still drawn, and the axis says so; a recession band
   * whose end lies past the last datum would otherwise be silently truncated at
   * the plot's right edge, which reads as the recession ENDING there.
   *
   * A CATEGORY ADDRESS WIDENS NOTHING, and the asymmetry is §4l's rather than an
   * inconsistency: a band axis's domain IS the set of keys in the rows, so a key
   * outside it is not a wider axis but an ungrounded reference.
   *
   * This does NOT reopen §4h's no-nicing rule: the marker's day joins the data
   * whose extent the domain is, and the domain is still not snapped outward to a
   * calendar boundary. */
  const domainDays: number[] = isTemporal
    ? [...dayValues, ...eventMarkers.map(([at]) => at), ...xBands.flatMap(([, a, b]) => [a, b])]
    : [];

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
        // `domainDays`, not `dayValues` — the extent the ticks are chosen for
        // includes any annotation's own date (§4l rule 3), so a rung is picked
        // for the axis the reader will actually see.
        const [lo, hi] = temporalDomain(domainDays);
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
        const [lo, hi] = temporalDomain(domainDays);
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
        : niceDomain(...extentOf(xValues))
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
  // (`isPie` itself was hoisted to the annotation block above by Phase 1490 —
  // the annotation slots are neutralised on the polar arm, so the answer is
  // needed before the value domain.)
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

  // ── Annotations (Phase 1490 — §4l) — the marks, then the labels ────────────
  //
  // TWO lists, not one, because §4l's draw order separates them: the lines sit in
  // front of the series (rung 3) and EVERY annotation label is last, above all
  // marks (rung 4). Within each rung the tie is document order inside the case,
  // which is the same order `<n>` counts in — so the mark id and the paint order
  // are read off one list and cannot disagree.
  //
  // The order is stated in the design doc, pinned by the goldens, and left to no
  // stylesheet on purpose: in inline SVG z-order IS emission order, so a host
  // that painted these in a different sequence would still produce a valid
  // document showing a different picture, and no schema or validator could see it.
  const referenceStyle = styleStrokeInk(REFERENCE_OPACITY, REFERENCE_STROKE_WIDTH);

  // `Quiet` — the vocabulary's own word for subordinate text, and the only label
  // in this lowering that takes it (the visible title is `Loud`, every other
  // label `Normal`). An annotation label NAMES a line the picture has already
  // drawn, so it should not compete with the values and the axis names that carry
  // the data; it is also what makes an annotation label identifiable in a lowered
  // drawing at all, since a `Start`-anchored muted 12px label is otherwise exactly
  // what a Phase-881 endpoint data label is.
  const annotationLabelStyle = textStyle(
    LABEL_OPACITY,
    'Start',
    ANNOTATION_LABEL_FONT_SIZE,
    'Quiet',
  );

  /** An annotation label, under Phase 881's rule and the Phase 1143 text contract
   * at once. `textFitsBox` is the single predicate and a no-fit is a SUPPRESSION
   * — never a clip, never an overlap, never a nudge onto a mark — but it can only
   * be asked of a `Literal`: the text behind a `Bound` or an `I18n` arm is not
   * known here, and measuring text that is not the text drawn is silently wrong.
   * So a non-`Literal` label is admitted on PRESENCE and may overrun, which is the
   * same honest boundary the text contract draws for truncation. A suppressed
   * label never suppresses its annotation: the line still draws. */
  const annotationLabelShape = (
    x: number,
    baseline: number,
    maxWidth: number,
    maxHeight: number,
    t: TextSource,
  ): Shape[] => {
    const fits =
      t.kind === 'Literal'
        ? textFitsBox(
            ANNOTATION_LABEL_FONT_SIZE,
            TEXT_LINE_HEIGHT_FACTOR,
            maxWidth,
            maxHeight,
            t.value,
          )
        : true;
    return fits ? [label(r2(x), r2(baseline), t, annotationLabelStyle)] : [];
  };

  const referenceLineShapes: Shape[] = referenceLines.map(([v], i) => {
    const y = yScale(v);
    // Phase 642 identity: `annotation|<case>|<n>`, with `<n>` the document-order
    // index within this case. NOT the value itself — a float has no canonical
    // string form the wire defines, and an ordinal is unique by construction and
    // moved by no data change.
    return line(r2(PLOT_X0), y, r2(PLOT_X1), y, {
      ...referenceStyle,
      markId: `annotation|reference|${i}`,
    });
  });

  /** The range bands as PLOT RECTANGLES — `(index, x0, y0, x1, y1, label)`,
   * ordered by the per-case index both arms were numbered with, so the paint
   * order and the `annotation|band|<n>` ids agree by construction rather than by
   * the arms happening to be appended the right way round.
   *
   * EACH BAND SPANS THE OTHER AXIS IN FULL, because the band's claim is about ONE
   * axis: a tolerance band that stopped short of the plot's edge would be
   * asserting something about x it was never given.
   *
   * THE X ARM TAKES PHASE 903'S BOUNDARIES, not its centres — which is where the
   * band differs from the event marker drawn from the same address. A marker is a
   * POSITION and a band is an EXTENT, so "Q2 to Q3" runs from Q2's band START to
   * Q3's band END. On a continuous temporal axis a date IS a position, so the band
   * runs between the two mapped days and there are no boundaries to take. */
  const rangeBands: readonly (readonly [
    number,
    number,
    number,
    number,
    number,
    TextSource | undefined,
  ])[] = [
    ...valueBands.map(
      ([i, lo, hi, lbl]) => [i, r2(PLOT_X0), yScale(hi), r2(PLOT_X1), yScale(lo), lbl] as const,
    ),
    ...xBands.map(([i, a, b, lbl]) => {
      const x0 = isTemporal ? xScale(a) : boundaryX(a);
      const x1 = isTemporal ? xScale(b) : boundaryX(b + 1);
      return [i, x0, r2(PLOT_Y0), x1, r2(PLOT_Y1), lbl] as const;
    }),
  ].sort((p, q) => p[0] - q[0]);

  /** The band's ink: `currentColor` as a FILL at `BAND_OPACITY`, with no stroke.
   * §4l's prohibition is what makes this one line: the wire carries no colour, no
   * opacity and no edge, so there is nothing here to read off the annotation. */
  const bandStyle = styleFillOpacity(INK, BAND_OPACITY);

  const rangeBandShapes: Shape[] = rangeBands.map(([i, x0, y0, x1, y1]) =>
    rectangle(
      x0,
      y0,
      r2(x1 - x0),
      r2(y1 - y0),
      // No corner radius. A band is a region of the SPACE, and a rounded region
      // would read as an object drawn on the chart rather than as part of its
      // ground.
      undefined,
      { ...bandStyle, markId: `annotation|band|${i}` },
    ),
  );

  const eventStyle = styleStrokeInk(EVENT_OPACITY, EVENT_STROKE_WIDTH);

  /** The x an event marker's line stands at (Phase 1491). PHASE 903'S SPLIT,
   * applied to an address rather than to a datum: a BAND axis has no positions,
   * only extents, so the marker sits at the band's CENTRE — the same place the
   * band's own label sits. A CONTINUOUS axis has positions, so the marker sits at
   * the mapped value. */
  const eventMarkerX = (i: number): number => {
    const at = eventMarkers[i]![0];
    return isTemporal ? xScale(at) : centreX(at);
  };

  const eventMarkerShapes: Shape[] = eventMarkers.map((_, i) => {
    const x = eventMarkerX(i);
    return line(x, r2(PLOT_Y0), x, r2(PLOT_Y1), {
      ...eventStyle,
      markId: `annotation|event|${i}`,
    });
  });

  /** The x each event marker's label must not reach — Phase 881's rule applied
   * ALONG X, which is where this member earns its own phase.
   *
   * Markers close together are the normal case (five shocks in a decade land
   * within a few pixels of each other), and the rule is: never overlapped, never
   * nudged across another marker, SUPPRESSED on no fit. So a label's width budget
   * runs to its NEIGHBOUR's line rather than to the plot edge, and the neighbour
   * is the successor in `(x, document index)` order — total and stable, so the
   * goldens pin one answer.
   *
   * Two markers on ONE position are legitimate (§4l says so explicitly, which is
   * why identity is an ordinal rather than the address). They fall out of the same
   * rule rather than needing one of their own: the earlier gets a budget of zero
   * and is suppressed, the later runs to the next distinct position. */
  const eventLabelRight: number[] = (() => {
    const xs = eventMarkers.map((_, i) => eventMarkerX(i));
    const order = xs
      .map((_, i) => i)
      .sort((a, b) => (xs[a]! - xs[b]! !== 0 ? xs[a]! - xs[b]! : a - b));
    const right = xs.map(() => PLOT_X1);
    for (let r = 0; r < order.length - 1; r++) right[order[r]!] = xs[order[r + 1]!]!;
    return right;
  })();

  const annotationLabelShapes: Shape[] = [
    ...referenceLines.flatMap(([v, lbl]) => {
      if (lbl === undefined) return [];
      const baseline = yScale(v) - ANNOTATION_LABEL_NUDGE_Y;
      const x = PLOT_X0 + ANNOTATION_LABEL_OFFSET_X;
      return annotationLabelShape(
        x,
        baseline,
        // The width budget runs to the PLOT's right edge: beyond it lies the
        // legend column or the right margin, and a label that ran into either is
        // the collision the gate exists to refuse.
        Math.max(0.0, PLOT_X1 - x - ANNOTATION_LABEL_PADDING),
        Math.max(0.0, baseline - PLOT_Y0 - ANNOTATION_LABEL_PADDING),
        lbl,
      );
    }),
    // Phase 1491 — the event markers' labels, after the reference lines' and in
    // document order within their own case. Both families are rung 4, so this is a
    // tie inside a rung; ordering by case keeps every pre-1491 golden
    // byte-identical, and §4l's tiebreak is honoured inside each run.
    ...eventMarkers.flatMap(([, lbl], i) => {
      if (lbl === undefined) return [];
      // AT THE TOP OF THE PLOT, beside the line. Top rather than beside the mark
      // it names, because a vertical marker names no single datum — it names the
      // whole column of the picture — and the top is the one place on that column
      // no series occupies by construction.
      const x = eventMarkerX(i) + ANNOTATION_LABEL_OFFSET_X;
      const baseline = PLOT_Y0 + ANNOTATION_LABEL_FONT_SIZE + ANNOTATION_LABEL_NUDGE_Y;
      return annotationLabelShape(
        x,
        baseline,
        Math.max(0.0, eventLabelRight[i]! - x - ANNOTATION_LABEL_PADDING),
        // The vertical budget is the plot's own height: one line always fits it,
        // which is the honest statement — markers collide along X, and that is the
        // axis the gate is really measuring.
        Math.max(0.0, PLOT_Y1 - PLOT_Y0 - ANNOTATION_LABEL_PADDING),
        lbl,
      );
    }),
    // Phase 1492 — the range bands' labels, after the other two cases'. All three
    // are rung 4, so the case order here is a tie inside a rung and is chosen to
    // keep every pre-1492 golden byte-identical.
    ...rangeBands.flatMap(([, x0, y0, x1, y1, lbl]) => {
      if (lbl === undefined) return [];
      // INSIDE THE BAND'S TOP EDGE, which is one rule serving both arms rather
      // than two placements: the top-left corner of the band's own rectangle is
      // the one point every band has, whichever axis it spans, and it is where a
      // reader looks for the name of a region. Inside and not above, deliberately
      // — a label ABOVE a value band would sit over the series, and a label above
      // an x band would leave the plot entirely.
      const x = x0 + ANNOTATION_LABEL_OFFSET_X;
      const baseline = y0 + ANNOTATION_LABEL_FONT_SIZE + ANNOTATION_LABEL_NUDGE_Y;
      return annotationLabelShape(
        x,
        baseline,
        // BOTH BUDGETS ARE THE BAND'S OWN, not the plot's, and that is what makes
        // this member's gate bite where the other two's do not. A narrow x band is
        // the ordinary case — a fortnight on a decade axis — and its name will not
        // fit inside it. Suppressed, per Phase 881, and the band still draws.
        Math.max(0.0, x1 - x - ANNOTATION_LABEL_PADDING),
        Math.max(0.0, y1 - y0 - ANNOTATION_LABEL_PADDING),
        lbl,
      );
    }),
  ];

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
          // Phase 1492 (§4l rung 1) — the RANGE BANDS, first of everything:
          // behind the series, and behind the grid and axes with it. In inline
          // SVG z-order IS emission order, so a host that emitted a band after
          // its series would draw a tinted rectangle OVER the data: a valid
          // document, a different picture, and nothing in a schema or a validator
          // could see it. Before the GRID too, not merely before the series — a
          // gridline is chrome for reading positions off the plot, and chrome a
          // band covered would go missing exactly where the band drew attention.
          ...rangeBandShapes,
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
          // Phase 1490 (§4l rung 3) — reference lines in FRONT of the series. A
          // threshold drawn under the bars it measures is a threshold the reader
          // cannot check the bars against.
          ...referenceLineShapes,
          // Phase 1491 (§4l rung 3, beside the reference lines) — the event
          // markers, also in FRONT of the series.
          ...eventMarkerShapes,
          ...legend,
          ...titleShapes,
          ...subtitleShapes,
          // Phase 1490 (§4l rung 4) — every annotation label LAST, above all
          // marks. Last literally, and not merely after the series: the label is
          // the only part of an annotation that carries authored words, and a rung
          // that put it under the legend column would suppress it on exactly the
          // charts that are busiest.
          ...annotationLabelShapes,
        ];

  // ── The accessible summary (Phase 921) ───────────────────────────────────
  //
  // The grammar is stated at the section head above and normatively in §4i;
  // this is its four data clauses in order, followed since Phase 1494 by one
  // clause per annotation member. A REFUSED PIE announces nothing, for the
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
    //
    // The unit suffix is hoisted out of that clause (Phase 1494) because the
    // annotation clauses below print numbers on the same axis and must say the
    // same thing about their magnitude.
    const unitSuffix = yDisplayUnit.label === '' ? '' : ` ${yDisplayUnit.label}`;

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
      clauses.push(
        `Peak ${clampText(SUMMARY_MAX_NAME_CHARS, spec.yFields[bj]!)} at ${clampText(
          SUMMARY_MAX_NAME_CHARS,
          categories[bi]!,
        )}, ${yTickText(bv)}${unitSuffix}`,
      );
    }

    // ── The annotation clauses (Phase 1494 — §4i, extended) ──
    //
    // One clause per MEMBER, appended after the four data clauses, in the
    // `ChartAnnotation` declaration order: reference lines, event markers,
    // range bands. After, because clauses 1–4 describe the DATA and an
    // annotation is the author's mark ON that data — and because appending is
    // what keeps every chart WITHOUT annotations byte-identical to its
    // pre-1494 golden.
    //
    // WHAT IS ANNOUNCED IS WHAT WAS DRAWN. These read the RESOLVED lists, so a
    // member the lowering dropped (non-finite, ungrounded key, mismatched axis
    // form, or any member at all on the polar arm) is announced by nobody —
    // §4i's refused-pie rule at the level of one annotation. And a marker whose
    // label the fit gate SUPPRESSED is still announced: suppression is a
    // decision about ink, not about meaning, and the summary is where
    // suppressed meaning goes.
    const annotationLabelWords = (lbl: TextSource | undefined): string =>
      lbl !== undefined && lbl.kind === 'Literal' && lbl.value !== ''
        ? ` (${clampText(SUMMARY_MAX_NAME_CHARS, lbl.value)})`
        : '';

    const annotationClause = (noun: string, plural: string, items: readonly string[]): string[] => {
      if (items.length === 0) return [];
      const k = items.length;
      const head = k === 1 ? `1 ${noun}: ` : `${k} ${plural}: `;
      const named = items.slice(0, SUMMARY_MAX_ANNOTATIONS_NAMED).join(', ');
      return [
        k > SUMMARY_MAX_ANNOTATIONS_NAMED
          ? `${head}${named}, and ${k - SUMMARY_MAX_ANNOTATIONS_NAMED} more`
          : `${head}${named}`,
      ];
    };

    // A resolved x address in the ADDRESS'S OWN VOCABULARY — a category key on
    // a band axis, the axis's own Phase-882 tick label on a temporal one. Never
    // the authored ISO string: clause 3 has already stated how this axis writes
    // a date, and a summary that wrote it two ways would disagree with the
    // picture about one of them.
    const xAddressWords = (i: number): string =>
      isTemporal
        ? xTickText(i)
        : i >= 0 && i < categories.length
          ? clampText(SUMMARY_MAX_NAME_CHARS, categories[i]!)
          : '';

    clauses.push(
      ...annotationClause(
        'reference line',
        'reference lines',
        referenceLines.map(
          ([v, lbl]) => `${yTickText(v)}${unitSuffix}${annotationLabelWords(lbl)}`,
        ),
      ),
      ...annotationClause(
        'event',
        'events',
        eventMarkers.map(([at, lbl]) => `${xAddressWords(at)}${annotationLabelWords(lbl)}`),
      ),
      // The two band arms rejoined on the per-case ordinal they were numbered
      // with, so the clause cannot disagree with the mark ids about which band
      // is which. A VALUE PAIR STATES ITS UNIT ONCE, after the second number:
      // the pair is one measurement in one unit.
      ...annotationClause(
        'band',
        'bands',
        [
          ...valueBands.map(
            ([i, lo, hi, lbl]) =>
              [i, `${yTickText(lo)} to ${yTickText(hi)}${unitSuffix}`, lbl] as const,
          ),
          ...xBands.map(
            ([i, a, b, lbl]) => [i, `${xAddressWords(a)} to ${xAddressWords(b)}`, lbl] as const,
          ),
        ]
          .sort((p, q) => p[0] - q[0])
          .map(([, address, lbl]) => `${address}${annotationLabelWords(lbl)}`),
      ),
    );

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
