// @fuaran-ui/charts — the Heatmap arm of the Chart → Drawing lowering (Phase 2655).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.
//
// NORMATIVE CROSS-HOST SPEC (WIRE_FORMAT §3.6.35), reproduced byte-for-byte from
// the reference host's `lowerHeatmap`: the `chart-lowering/heatmap/` subfamily
// pins it.
//
// A heatmap is a CELL GRID, not a series chart: the columns are the distinct
// `xField` keys and the rows the distinct keys of the ROW field (`yFields[0]`),
// both in first-appearance order; a cell's value is the VALUE field
// (`yFields[1]`) of the first row carrying that pair. A pair no row carries — or
// a row whose value cell is empty, text or non-finite — is ABSENT and draws the
// surface (`fill: 'none'` under a gridline-weight outline), never a zero.
//
// The colour is a BIN, not an interpolation: the declared scale maps a value to
// a fraction and the fraction to one ramp stop by `floor(t · n)`, clamped to the
// last stop — plain IEEE arithmetic in a fixed order, so every host picks the
// same stop and the same literal hex.

import type {
  ChartScale,
  DrawStyle,
  DrawingSpec,
  Shape,
  TextAnchor,
  TextSource,
} from '@fuaran-ui/schema';

import {
  AXIS_LABEL_PADDING,
  AXIS_TITLE_BOTTOM_OFFSET,
  CATEGORY_LABEL_OFFSET_Y,
  CHART_FONT,
  DATA_LABEL_FONT_SIZE,
  DATA_LABEL_PADDING,
  GRID_OPACITY,
  H,
  INK,
  LABEL_OPACITY,
  LEGEND_COLUMN_GAP,
  LEGEND_LABEL_OFFSET_X,
  MARGIN_BOTTOM,
  MARGIN_LEFT,
  MARGIN_LEFT_MAX_SHARE,
  MARGIN_RIGHT,
  MARGIN_TOP,
  SUBTITLE_BASELINE_Y,
  SUBTITLE_FONT_SIZE,
  TEXT_LINE_HEIGHT_FACTOR,
  TICK_FONT_SIZE,
  TICK_LABEL_GAP,
  W,
  Y_AXIS_TITLE_DEGREES,
  Y_AXIS_TITLE_OFFSET_X,
  niceDomain,
  r2,
} from './layout.js';
import { formatValue } from './numberFormat.js';
import {
  TIP_SEPARATOR,
  label,
  literal,
  rectangle,
  styleFill,
  styleStrokeInk,
  textStyle,
  withMark,
  withTip,
} from './shapes.js';
import type { ChartLowerSpec, ChartRow } from './spec.js';
import { capitalise, presentValueOf, stringOf } from './spec.js';
import {
  SUMMARY_CLAUSE_SEPARATOR,
  SUMMARY_MAX_CHARS,
  SUMMARY_MAX_NAME_CHARS,
  clampText,
  summaryKindWords,
} from './summary.js';
import { textFitsBox, textLineHeight, textWidth, truncateToWidth } from './textMetrics.js';

// ─── The heatmap style (the reference host's `ChartStyle.defaults`) ───────────

/** The sequential ramp, light to dark: five bins along the categorical primary's
 * hue. Gated by the reference host's `ChartPalette.validateRamp`. */
export const SEQUENTIAL_RAMP: readonly string[] = [
  '#e8f2f7',
  '#bcdae8',
  '#8ec2da',
  '#5caacb',
  '#2c92b9',
];

/** The diverging ramp: seven bins, low hue through a light neutral centre to the
 * high hue. */
export const DIVERGING_RAMP: readonly string[] = [
  '#2c92b9',
  '#7ab2cc',
  '#b9d2df',
  '#f2f2f0',
  '#ddcbb2',
  '#c9a26c',
  '#b47803',
];

/** The literal ink a cell's value label is drawn in (it sits on the cell). */
export const RAMP_LABEL_INK = '#1a1a19';

/** The geometric gap between neighbouring cells. */
export const HEATMAP_CELL_GAP = 2.0;

const TITLE_FONT_SIZE = 18.0;
const TITLE_BASELINE_Y = 22.0;
const TICK_LABEL_BASELINE_DY = 4.0;
const LEGEND_SWATCH_SIZE = 10.0;

/** The reference host's Phase-790 point budget, applied to the cell grid. */
export const MAX_HEATMAP_CELLS = 10_000;

// ─── The grid ─────────────────────────────────────────────────────────────────

interface HeatmapGrid {
  readonly rowField: string;
  readonly valueField: string;
  readonly xKeys: readonly string[];
  readonly rowKeys: readonly string[];
  /** `${column},${row}` → the first row's value, for the PRESENT cells only. */
  readonly cells: ReadonlyMap<string, number>;
}

const at = (i: number, j: number): string => `${i},${j}`;

/** The cell key a mark carries: `x|row` (the mark id is `valueField|x|row`). */
export const heatmapCellKey = (xKey: string, rowKey: string): string => `${xKey}|${rowKey}`;

const distinct = (keys: readonly string[]): string[] => {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keys) {
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
};

const heatmapGrid = (spec: ChartLowerSpec, rows: readonly ChartRow[]): HeatmapGrid => {
  const rowField = spec.yFields[0] ?? '';
  const valueField = spec.yFields.length >= 2 ? spec.yFields[1]! : '';
  const keyed = rows.map((r) => [stringOf(r, spec.xField), stringOf(r, rowField), r] as const);
  const xKeys = distinct(keyed.map((k) => k[0]));
  const rowKeys = distinct(keyed.map((k) => k[1]));
  const xIndex = new Map(xKeys.map((k, i) => [k, i] as const));
  const rowIndex = new Map(rowKeys.map((k, j) => [k, j] as const));
  const cells = new Map<string, number>();
  const seen = new Set<string>();
  for (const [x, y, r] of keyed) {
    const key = at(xIndex.get(x)!, rowIndex.get(y)!);
    if (seen.has(key)) continue;
    seen.add(key);
    const v = presentValueOf(r, valueField);
    if (v !== undefined) cells.set(key, v);
  }
  return { rowField, valueField, xKeys, rowKeys, cells };
};

// ─── The scale ────────────────────────────────────────────────────────────────

/** A declared bound, or the data's own when it is absent or non-finite. */
const boundOr = (declared: number | undefined, fallback: number): number =>
  declared !== undefined && Number.isFinite(declared) ? declared : fallback;

interface HeatmapScale {
  readonly ramp: readonly string[];
  readonly binOf: (v: number) => number;
  readonly low: number;
  readonly high: number;
  readonly midpoint: number | undefined;
}

const clampBin = (n: number, x: number): number =>
  n === 0 ? 0 : Math.max(0, Math.min(n - 1, Math.floor(x)));

const heatmapScale = (scale: ChartScale | undefined, values: readonly number[]): HeatmapScale => {
  const dataMin = values.length === 0 ? 0.0 : values.reduce((a, b) => Math.min(a, b));
  const dataMax = values.length === 0 ? 0.0 : values.reduce((a, b) => Math.max(a, b));
  if (scale !== undefined && scale.kind === 'Diverging') {
    const ramp = DIVERGING_RAMP;
    const n = ramp.length;
    const m = boundOr(scale.midpoint, 0.0);
    const lo = boundOr(scale.min, dataMin);
    const hi = boundOr(scale.max, dataMax);
    const e = Math.max(m - lo, hi - m);
    return {
      ramp,
      binOf: (v) => {
        const t = e > 0.0 ? Math.max(-1.0, Math.min(1.0, (v - m) / e)) : 0.0;
        return clampBin(n, ((t + 1.0) / 2.0) * n);
      },
      low: e > 0.0 ? m - e : m,
      high: e > 0.0 ? m + e : m,
      midpoint: m,
    };
  }
  const ramp = SEQUENTIAL_RAMP;
  const n = ramp.length;
  const lo = scale !== undefined ? boundOr(scale.min, dataMin) : dataMin;
  const hi = scale !== undefined ? boundOr(scale.max, dataMax) : dataMax;
  return {
    ramp,
    binOf: (v) => {
      const t = hi > lo ? Math.max(0.0, Math.min(1.0, (v - lo) / (hi - lo))) : 0.0;
      return clampBin(n, t * n);
    },
    low: lo,
    high: hi,
    midpoint: undefined,
  };
};

// ─── The arm ──────────────────────────────────────────────────────────────────

/** The drawing a refused heatmap produces — the reference host's refusal drawing
 * for `TooManyPoints`. */
const refusalDrawing = (spec: ChartLowerSpec, atLeast: number): DrawingSpec => ({
  viewBox: { minX: 0.0, minY: 0.0, width: W, height: H },
  shapes: [],
  style: {},
  ...(spec.title !== undefined ? { title: spec.title } : {}),
  description: literal(
    `Chart not rendered: at least ${atLeast} data points exceeds the limit of ${MAX_HEATMAP_CELLS} per series.`,
  ),
});

/** Lower a `Heatmap` chart: the reference host's cost caps (the row cap read to
 * the budget + 1, then the cell grid), then the cell grid. */
export const lowerHeatmap = (spec: ChartLowerSpec, rows: readonly ChartRow[]): DrawingSpec => {
  if (rows.length > MAX_HEATMAP_CELLS) return refusalDrawing(spec, MAX_HEATMAP_CELLS + 1);
  const grid = heatmapGrid(spec, rows);
  const cellCount = grid.xKeys.length * grid.rowKeys.length;
  return cellCount > MAX_HEATMAP_CELLS ? refusalDrawing(spec, cellCount) : drawHeatmap(spec, grid);
};

const drawHeatmap = (spec: ChartLowerSpec, grid: HeatmapGrid): DrawingSpec => {
  const tickSize = TICK_FONT_SIZE;
  const lineHeight = textLineHeight(tickSize, TEXT_LINE_HEIGHT_FACTOR);
  const widestOf = (fontSize: number, texts: readonly string[]): number =>
    texts.reduce((acc, t) => Math.max(acc, textWidth(fontSize, t)), 0.0);
  const axisTitleOf = (
    declared: TextSource | undefined,
    fallbackField: string,
  ): TextSource | undefined =>
    declared !== undefined
      ? declared
      : fallbackField === ''
        ? undefined
        : literal(capitalise(fallbackField));
  const boundText = (fontSize: number, extent: number, t: TextSource): TextSource =>
    t.kind === 'Literal' ? literal(truncateToWidth(fontSize, extent, t.value)) : t;

  const xTitle = axisTitleOf(spec.xTitle, spec.xField);
  const yTitle = axisTitleOf(spec.yTitle, grid.rowField);
  const n = grid.xKeys.length;
  const m = grid.rowKeys.length;

  const values: number[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const v = grid.cells.get(at(i, j));
      if (v !== undefined) values.push(v);
    }

  const scale = heatmapScale(spec.scale, values);
  const { step } = niceDomain(scale.low, scale.high);
  const valueText = (v: number): string => formatValue(spec.valueFormat, 1.0, false, step, v);

  // ── Top margin (the subtitle's line, as every arm reserves it) ──
  const subtitleBand =
    spec.subtitle !== undefined ? textLineHeight(SUBTITLE_FONT_SIZE, TEXT_LINE_HEIGHT_FACTOR) : 0.0;
  const plotY0 = r2(MARGIN_TOP + subtitleBand);
  const plotY1 = r2(H - MARGIN_BOTTOM);

  // ── Left margin: the row labels (Phase 879's derivation) ──
  const leftCeiling = MARGIN_LEFT_MAX_SHARE * W;
  const yTitleBand = yTitle !== undefined ? lineHeight + AXIS_LABEL_PADDING : 0.0;
  const rowTextBudget = Math.max(
    0.0,
    leftCeiling - TICK_LABEL_GAP - AXIS_LABEL_PADDING - yTitleBand,
  );
  const rowLabels = grid.rowKeys.map((k) => truncateToWidth(tickSize, rowTextBudget, k));
  const requiredLeft =
    TICK_LABEL_GAP + widestOf(tickSize, rowLabels) + AXIS_LABEL_PADDING + yTitleBand;
  const plotX0 = r2(Math.max(MARGIN_LEFT, Math.min(leftCeiling, requiredLeft)));

  // ── Right: the legend ramp's column ──
  const showLegend = spec.legendPosition !== 'None';
  const legendTexts = [
    valueText(scale.high),
    ...(scale.midpoint !== undefined ? [valueText(scale.midpoint)] : []),
    valueText(scale.low),
  ];
  const legendReserve = showLegend
    ? LEGEND_COLUMN_GAP + LEGEND_LABEL_OFFSET_X + widestOf(tickSize, legendTexts)
    : 0.0;

  const plotX1 = r2(W - MARGIN_RIGHT - legendReserve);
  const plotW = plotX1 - plotX0;
  const plotH = plotY1 - plotY0;
  const cellW = n > 0 ? plotW / n : 0.0;
  const cellH = m > 0 ? plotH / m : 0.0;
  const gap = HEATMAP_CELL_GAP;
  const half = gap / 2.0;
  const centreX = (i: number): number => plotX0 + cellW * i + cellW / 2.0;
  const centreY = (j: number): number => plotY0 + cellH * j + cellH / 2.0;
  const fillOf = (v: number): string =>
    scale.ramp.length === 0 ? INK : scale.ramp[scale.binOf(v)]!;

  // ── Cells, in column-major order ──
  const absentStyle: DrawStyle = { ...styleStrokeInk(GRID_OPACITY, 1.0), ...styleFill('none') };
  const cells: Shape[] = [];
  for (let i = 0; i < n; i++)
    for (let j = 0; j < m; j++) {
      const x = r2(plotX0 + cellW * i + half);
      const y = r2(plotY0 + cellH * j + half);
      const w = r2(Math.max(0.0, cellW - gap));
      const h = r2(Math.max(0.0, cellH - gap));
      const v = grid.cells.get(at(i, j));
      if (v !== undefined) {
        const xKey = grid.xKeys[i]!;
        const rowKey = grid.rowKeys[j]!;
        cells.push(
          rectangle(
            x,
            y,
            w,
            h,
            undefined,
            withTip(
              rowKey +
                TIP_SEPARATOR +
                xKey +
                TIP_SEPARATOR +
                formatValue(spec.valueFormat, 1.0, false, v, v),
              withMark(grid.valueField, heatmapCellKey(xKey, rowKey), styleFill(fillOf(v))),
            ),
          ),
        );
      } else {
        cells.push(rectangle(x, y, w, h, undefined, absentStyle));
      }
    }

  // ── The value written on each present cell (`dataLabels: 'Ends'`) ──
  const cellLabels: Shape[] = [];
  if (spec.dataLabels === 'Ends') {
    const labelStyle: DrawStyle = {
      ...styleFill(RAMP_LABEL_INK),
      textAnchor: 'Middle',
      fontSize: DATA_LABEL_FONT_SIZE,
      emphasis: 'Normal',
      fontFamily: CHART_FONT,
    };
    const room = 2.0 * DATA_LABEL_PADDING;
    for (let i = 0; i < n; i++)
      for (let j = 0; j < m; j++) {
        const v = grid.cells.get(at(i, j));
        if (v === undefined) continue;
        const text = valueText(v);
        if (
          textFitsBox(
            DATA_LABEL_FONT_SIZE,
            TEXT_LINE_HEIGHT_FACTOR,
            cellW - gap - room,
            cellH - gap - room,
            text,
          )
        )
          cellLabels.push(
            label(
              r2(centreX(i)),
              r2(centreY(j) + TICK_LABEL_BASELINE_DY),
              literal(text),
              labelStyle,
            ),
          );
      }
  }

  // ── Row + column labels ──
  const chromeLabel = (anchor: TextAnchor): DrawStyle =>
    textStyle(LABEL_OPACITY, anchor, tickSize, 'Normal');
  const rowLabelShapes = rowLabels.map((text, j) =>
    label(
      r2(plotX0 - TICK_LABEL_GAP),
      r2(centreY(j) + TICK_LABEL_BASELINE_DY),
      literal(text),
      chromeLabel('End'),
    ),
  );
  const columnLabelShapes = grid.xKeys.map((key, i) =>
    label(
      r2(centreX(i)),
      r2(plotY1 + CATEGORY_LABEL_OFFSET_Y),
      literal(truncateToWidth(tickSize, cellW, key)),
      chromeLabel('Middle'),
    ),
  );

  // ── Axis titles (the shared rules: x centred below, y rotated left) ──
  const axisTitles: Shape[] = [];
  if (xTitle !== undefined)
    axisTitles.push(
      label(
        r2((plotX0 + plotX1) / 2.0),
        r2(H - AXIS_TITLE_BOTTOM_OFFSET),
        boundText(tickSize, plotW, xTitle),
        textStyle(undefined, 'Middle', tickSize, 'Normal'),
      ),
    );
  if (yTitle !== undefined)
    axisTitles.push(
      label(
        r2(Y_AXIS_TITLE_OFFSET_X),
        r2((plotY0 + plotY1) / 2.0),
        boundText(tickSize, plotH, yTitle),
        {
          ...textStyle(undefined, 'Middle', tickSize, 'Normal'),
          rotation: r2(-Y_AXIS_TITLE_DEGREES),
        },
      ),
    );

  // ── The legend ramp: one swatch per stop, the highest bin on top ──
  const legend: Shape[] = [];
  if (showLegend && scale.ramp.length > 0) {
    const stops = scale.ramp.length;
    const stopH = plotH / stops;
    const swatchX = r2(plotX1 + LEGEND_COLUMN_GAP);
    const labelX = r2(plotX1 + LEGEND_COLUMN_GAP + LEGEND_LABEL_OFFSET_X);
    for (let k = 0; k < stops; k++)
      legend.push(
        rectangle(
          swatchX,
          r2(plotY0 + stopH * (stops - 1 - k)),
          LEGEND_SWATCH_SIZE,
          r2(stopH),
          undefined,
          styleFill(scale.ramp[k]!),
        ),
      );
    const labelAt = (y: number, text: string): Shape =>
      label(labelX, r2(y + TICK_LABEL_BASELINE_DY), literal(text), chromeLabel('Start'));
    legend.push(labelAt(plotY0, valueText(scale.high)));
    if (scale.midpoint !== undefined)
      legend.push(labelAt((plotY0 + plotY1) / 2.0, valueText(scale.midpoint)));
    legend.push(labelAt(plotY1, valueText(scale.low)));
  }

  // ── Title + subtitle (the shipped Left alignment) ──
  const titleShapes: Shape[] =
    spec.title !== undefined
      ? [
          label(
            r2(plotX0),
            TITLE_BASELINE_Y,
            spec.title,
            textStyle(undefined, 'Start', TITLE_FONT_SIZE, 'Loud'),
          ),
        ]
      : [];
  const subtitleShapes: Shape[] =
    spec.subtitle !== undefined
      ? [
          label(
            r2(plotX0),
            SUBTITLE_BASELINE_Y,
            boundText(SUBTITLE_FONT_SIZE, plotW, spec.subtitle),
            textStyle(LABEL_OPACITY, 'Start', SUBTITLE_FONT_SIZE, 'Normal'),
          ),
        ]
      : [];

  // ── The accessible summary ──
  const name = (s: string): string => clampText(SUMMARY_MAX_NAME_CHARS, s);
  const absent = n * m - grid.cells.size;
  const clauses = [
    `${summaryKindWords('Heatmap', false)} of ${name(grid.valueField)} by ${name(spec.xField)} and ${name(grid.rowField)}`,
    `${n} columns by ${m} rows`,
    values.length === 0
      ? 'no values'
      : `values from ${valueText(values.reduce((a, b) => Math.min(a, b)))} to ${valueText(values.reduce((a, b) => Math.max(a, b)))}`,
    ...(absent > 0 ? [`${absent} cells empty`] : []),
  ];

  return {
    viewBox: { minX: 0.0, minY: 0.0, width: W, height: H },
    shapes: [
      ...cells,
      ...cellLabels,
      ...rowLabelShapes,
      ...columnLabelShapes,
      ...axisTitles,
      ...legend,
      ...titleShapes,
      ...subtitleShapes,
    ],
    style: {},
    ...(spec.title !== undefined ? { title: spec.title } : {}),
    description: literal(
      clampText(SUMMARY_MAX_CHARS, clauses.join(SUMMARY_CLAUSE_SEPARATOR) + '.'),
    ),
  };
};
