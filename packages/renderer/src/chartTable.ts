// ============================================================================
//  A lowered chart's data-table alternative, as markup (Phase 2804) — the
//  TypeScript twin of the reference host's `ElementPlan.ChartTablePlan`.
//
//  The lowering yields the values a chart's marks were drawn from
//  (`@fuaran-ui/charts` `tableModel`); this module is the ONE statement of how
//  both renderers draw them: a native `<details>` disclosure after the drawing,
//  which the drawing's `role="img"` root names in `aria-details`, holding a
//  real table — a `<caption>`, one `<th scope="col">` per column, and each row's
//  first cell (its x value, the key the row is about) a `<th scope="row">`.
//  The server renderer concatenates the string, and the client sets the same
//  string as the host element's inner markup, so the two tiers emit the same
//  bytes by construction, and the server's needs no script.
//
//  Host chrome under the render policy, never wire: a document says nothing
//  about it. `'Offer'` (the default) draws it wherever the lowering has values
//  to give; `'Off'` never computes it, and the chart's markup is the drawing
//  alone, byte for byte as before.
// ============================================================================

import type { ChartLowerSpec, ChartRow, ChartTable } from '@fuaran-ui/charts';

import { type BindingSources, renderText } from './bindings.js';
import { DRAWING_ROOT_OPEN } from './drawingSvg.js';

/** Whether a lowered chart offers its data table. Absent means `'Offer'`. */
export type ChartTablePolicy = 'Offer' | 'Off';

/** The disclosure's label. */
export const CHART_TABLE_TOGGLE_TEXT = 'View as table';

/**
 * The DOM id of the disclosure holding a chart's data table, which the
 * drawing names in `aria-details`: the disclosure rather than the table inside
 * it, because a closed `<details>` keeps its content out of the accessibility
 * tree, so the reference must reach the control that opens it.
 */
export const chartTableId = (nodeId: string): string => `${nodeId}-data-table`;

// Text as the reference server renderer escapes it, quotes included, so the
// table is byte-identical across the hosts' server renderers.
const text = (s: string): string =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');

/** The drawing's root naming `detailsId` in `aria-details`; any other string unchanged. */
export const withDetails = (detailsId: string, svg: string): string =>
  svg.startsWith(DRAWING_ROOT_OPEN)
    ? `${DRAWING_ROOT_OPEN} aria-details="${text(detailsId)}"${svg.slice(DRAWING_ROOT_OPEN.length)}`
    : svg;

/** The statement under a table cut at its row limit, in the bound grid's wording. */
export const chartTableLimitText = (shown: number, rowCount: number): string =>
  `Rows 1–${shown} of ${rowCount}`;

/** The disclosure's INNER markup: the toggle, the table, and the limit statement
 * when the table was cut. */
export const chartTableInnerHtml = (sources: BindingSources, table: ChartTable): string => {
  const header = table.columns.map((c) => `<th scope="col">${text(c)}</th>`).join('');
  const row = (cells: readonly string[]): string =>
    `<tr>${cells.map((c, i) => (i === 0 ? `<th scope="row">${text(c)}</th>` : `<td>${text(c)}</td>`)).join('')}</tr>`;
  const shown = table.rows.length;
  const limit =
    shown < table.rowCount
      ? `<p class="fuaran-chart-table-limit">${text(chartTableLimitText(shown, table.rowCount))}</p>`
      : '';
  return (
    `<summary class="fuaran-chart-table-toggle">${CHART_TABLE_TOGGLE_TEXT}</summary>` +
    `<table class="fuaran-chart-table-grid"><caption>${text(renderText(sources, table.caption))}</caption>` +
    `<thead><tr>${header}</tr></thead><tbody>${table.rows.map(row).join('')}</tbody></table>` +
    limit
  );
};

/**
 * The data table a lowered chart offers under `policy`, or `null`: never
 * computed under `'Off'`, nor when the registered charts module predates the
 * table model, and `null` from the lowering when it has no values to give.
 */
export const chartTableOf = (
  policy: ChartTablePolicy | undefined,
  tableModel: ((spec: ChartLowerSpec, rows: readonly ChartRow[]) => ChartTable | null) | undefined,
  spec: ChartLowerSpec,
  rows: readonly ChartRow[],
): ChartTable | null =>
  (policy ?? 'Offer') === 'Off' || tableModel === undefined ? null : tableModel(spec, rows);

/**
 * The INNER markup of a lowered chart's `fuaran-chart-table-host` element: the
 * drawing in its own element, naming the disclosure, then the disclosure. The
 * client sets it as the host element's inner markup; the server wraps it.
 */
export const chartTableHostInnerHtml = (
  sources: BindingSources,
  nodeId: string,
  svg: string,
  table: ChartTable,
): string => {
  const id = chartTableId(nodeId);
  return (
    `<div>${withDetails(id, svg)}</div>` +
    `<details class="fuaran-chart-table" id="${text(id)}">${chartTableInnerHtml(sources, table)}</details>`
  );
};

/** The class of the element holding a drawing and its disclosure. */
export const CHART_TABLE_HOST_CLASS = 'fuaran-chart-table-host';
