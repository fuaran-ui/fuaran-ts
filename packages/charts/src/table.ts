// ============================================================================
//  The data-table alternative (Phase 2804) — the TypeScript twin of the
//  reference host's `Charts.tableModel` (Phase 2776).
//
//  A lowered chart is an image to assistive technology: `role="img"` with a
//  title and a summary of at most 320 characters. The summary is not the data.
//  This is the data: beside the drawing, the lowering yields the values its
//  marks were drawn from as a table, and both renderers offer it behind a
//  "View as table" disclosure the drawing names in `aria-details`.
//
//  WHAT A TABLE HOLDS — a lowering rule, pinned for every host by the corpus's
//  `chart-lowering/table-model/` goldens:
//
//   * THE CAPTION is the chart's `title`, carried unresolved; a chart with no
//     title gets a `Literal` minted from its kind, "Bar chart data".
//   * THE COLUMNS are the fields the marks read, under their declared names:
//     the x field, then each series in order, then the interval's low and high
//     ends, the size and the path order when the kind reads them. A heatmap's
//     are its x field, its row field and its value field. A field that orders
//     or withholds rows is not plotted, so it is not a column.
//   * THE ROWS are the rows the chart plotted, in the order the marks were
//     drawn (after `sortBy`); a heatmap's are one per cell, the first row of an
//     (x, row) pair, in data order.
//   * A CELL is the value's exact readout through the declared `valueFormat`
//     (the hover tip's text), the x cell as the category axis projected it, a
//     size or a path order as a plain number, a withheld value as "withheld"
//     and a missing one as an empty cell. Never a zero for a value that is not
//     there.
//   * THE COST CAPS APPLY, as the reference host's admission applies them: a
//     chart the caps refuse offers no table, nor does a chart with no rows; and
//     a table longer than {@link TABLE_ROW_LIMIT} holds its first that many rows
//     and says how many there were (`rowCount`).
// ============================================================================

import type { Format, TextSource } from '@fuaran-ui/schema';

import { MAX_HEATMAP_CELLS, at, heatmapGrid } from './heatmap.js';
import { MAX_DERIVED_SERIES } from './lower.js';
import { formatValue } from './numberFormat.js';
import { literal } from './shapes.js';
import type { ChartLowerSpec, ChartRow } from './spec.js';
import {
  WITHHELD_WORD,
  derivedSeriesFields,
  intervalApplies,
  isWithheldRow,
  presentValueOf,
  scatterChannel,
  sortedRows,
  stringOf,
} from './spec.js';
import { summaryKindWords } from './summary.js';

/** A chart's data table: what the renderers draw behind the disclosure. */
export interface ChartTable {
  /** The chart's `title`, unresolved, or a `Literal` minted from its kind. */
  readonly caption: TextSource;
  /** One header per plotted field, in its declared name. */
  readonly columns: readonly string[];
  /** One row per plotted row, in draw order; at most {@link TABLE_ROW_LIMIT}. */
  readonly rows: readonly (readonly string[])[];
  /** How many rows the chart plotted — more than `rows` holds past the limit. */
  readonly rowCount: number;
}

/** The most rows a chart's data table holds: the bound grid's limit, so the two
 * tables a reader meets are cut at the same place. */
export const TABLE_ROW_LIMIT = 1000;

/** The reference host's per-series point budget (`ChartLimits.defaults`). */
const MAX_POINTS = 10_000;

/** A value cell: "withheld", the hover tip's exact readout (unscaled, at the
 * datum's own precision), or empty when the value is missing. */
const tableCell = (
  fmt: Format | undefined,
  withheld: boolean,
  value: number | undefined,
): string =>
  withheld ? WITHHELD_WORD : value !== undefined ? formatValue(fmt, 1.0, false, value, value) : '';

const tableCaption = (spec: ChartLowerSpec, stacked: boolean): TextSource =>
  spec.title ?? literal(`${summaryKindWords(spec.kind, stacked)} data`);

type Column = readonly [string, (r: ChartRow, i: number) => string];

/** The table of a series chart (every kind but `Heatmap`), over admitted rows. */
const seriesTable = (spec: ChartLowerSpec, admitted: readonly ChartRow[]): ChartTable => {
  const rows = sortedRows(spec, admitted);
  const fmt = spec.valueFormat;
  const withheld = rows.map((r) => isWithheldRow(spec.withheldField, r));
  // A withheld row reads no value: its interval and size are withheld with it.
  const read = (field: string, r: ChartRow, i: number): number | undefined =>
    withheld[i] ? undefined : presentValueOf(r, field);

  const series: Column[] = spec.yFields.map(
    (f): Column => [f, (r, i) => tableCell(fmt, withheld[i]!, read(f, r, i))],
  );
  // The interval's ends, normalised low to high as the marks draw them, and
  // empty where either end is missing.
  const interval: Column[] = (() => {
    const iv = spec.interval;
    if (iv === undefined || !intervalApplies(spec)) return [];
    const ends = (r: ChartRow, i: number): readonly [number, number] | undefined => {
      const lo = read(iv.low, r, i);
      const hi = read(iv.high, r, i);
      return lo !== undefined && hi !== undefined
        ? [Math.min(lo, hi), Math.max(lo, hi)]
        : undefined;
    };
    return [
      [iv.low, (r, i) => tableCell(fmt, withheld[i]!, ends(r, i)?.[0])],
      [iv.high, (r, i) => tableCell(fmt, withheld[i]!, ends(r, i)?.[1])],
    ];
  })();
  // A size is read where it is present and not negative, as the marks read it.
  const sizeField = scatterChannel(spec, spec.sizeField);
  const size: Column[] =
    sizeField === undefined
      ? []
      : [
          [
            sizeField,
            (r, i) => {
              const v = read(sizeField, r, i);
              return tableCell(
                undefined,
                withheld[i]!,
                v !== undefined && v >= 0.0 ? v : undefined,
              );
            },
          ],
        ];
  // The path order is a position, read off a withheld row too.
  const pathField = scatterChannel(spec, spec.pathField);
  const path: Column[] =
    pathField === undefined
      ? []
      : [[pathField, (r) => tableCell(undefined, false, presentValueOf(r, pathField))]];

  const columns: Column[] = [
    [spec.xField, (r) => stringOf(r, spec.xField)],
    ...series,
    ...interval,
    ...size,
    ...path,
  ];
  const stacked = (spec.stacked ?? false) && (spec.kind === 'Bar' || spec.kind === 'Area');
  return {
    caption: tableCaption(spec, stacked),
    columns: columns.map(([name]) => name),
    rows: rows.slice(0, TABLE_ROW_LIMIT).map((r, i) => columns.map(([, cell]) => cell(r, i))),
    rowCount: rows.length,
  };
};

/** The table of a heatmap: one row per drawn cell, in data order, or `null` when
 * the cell grid is past the budget (the chart is drawn as the refusal). */
const heatmapTable = (spec: ChartLowerSpec, rows: readonly ChartRow[]): ChartTable | null => {
  const grid = heatmapGrid(spec, rows);
  if (grid.xKeys.length * grid.rowKeys.length > MAX_HEATMAP_CELLS) return null;
  const xIndex = new Map(grid.xKeys.map((k, i) => [k, i] as const));
  const rowIndex = new Map(grid.rowKeys.map((k, j) => [k, j] as const));
  const seen = new Set<string>();
  const cells: string[][] = [];
  for (const r of rows) {
    const x = stringOf(r, spec.xField);
    const y = stringOf(r, grid.rowField);
    const key = at(xIndex.get(x)!, rowIndex.get(y)!);
    if (seen.has(key)) continue;
    seen.add(key);
    cells.push([x, y, tableCell(spec.valueFormat, grid.withheld.has(key), grid.cells.get(key))]);
  }
  return {
    caption: tableCaption(spec, false),
    columns: [spec.xField, grid.rowField, grid.valueField],
    rows: cells.slice(0, TABLE_ROW_LIMIT),
    rowCount: cells.length,
  };
};

/**
 * The data-table alternative of a chart: the values its marks are drawn from,
 * or `null` when there are none to read, because the reference host's cost caps
 * refuse the chart (it is drawn as the refusal) or it has no rows.
 */
export const tableModel = (spec: ChartLowerSpec, rows: readonly ChartRow[]): ChartTable | null => {
  if (rows.length === 0 || rows.length > MAX_POINTS) return null;
  if (spec.kind === 'Heatmap') return heatmapTable(spec, rows);
  const fields = spec.yFields.length > 0 ? spec.yFields : derivedSeriesFields(spec.xField, rows);
  if (fields.length > MAX_DERIVED_SERIES) return null;
  return seriesTable({ ...spec, yFields: fields }, rows);
};
