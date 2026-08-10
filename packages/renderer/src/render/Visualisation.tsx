// ============================================================================
//  @fuaran-ui/renderer/render/Visualisation — Grid / Chart / Table / Map.
//  Mirrors the F# renderVis + renderGrid + renderGridCell + renderChart +
//  renderTable + renderMap. Grid uses the simple-HTML-table fallback (the
//  standalone-posture path — no third-party grid dependency). Chart + Map
//  render a labelled placeholder + live row/marker count, matching the F#
//  adapter-less fallback. Link cells route href through the sanitiser.
// ============================================================================

import type { ReactElement, ReactNode } from 'react';

import type {
  CellKindErased,
  CellValue,
  ChartKind,
  ChartSpec,
  ColumnErased,
  GridSpec,
  JsonValue,
  MapSpec,
  StateBehaviour,
  TableSpec,
  ToneVariant,
  VisKind,
} from '@fuaran-ui/schema';
import type { ChartRow } from '@fuaran-ui/charts';
import { isLowered, lower } from '@fuaran-ui/charts';

import { asArray, renderCellValue, renderText, resolve, tryResolve } from '../bindings.js';
import { toneVar } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { runAction } from '../context.js';
import { drawingSvg } from '../drawingSvg.js';
import { sanitizeUrlOrBlank } from '../sanitize.js';
import { renderNode } from './core.js';

// Phase 534 tail / Phase 636–638 — the render dispatch consults the lowering's
// own `isLowered` (Bar / Line / Area / Scatter / Pie), so the first-party
// render branch and the arm set can never drift apart. Other kinds fall
// through to the client-hydration placeholder.

// A resolved chart data row is a plain field-map object (the TS twin of the Python
// `isinstance(item, Obj)` check) — never an array or a scalar.
const isChartRow = (row: unknown): row is ChartRow =>
  typeof row === 'object' && row !== null && !Array.isArray(row);

export const renderVis = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  state: StateBehaviour<TMsg>,
  vis: VisKind<TMsg>,
): ReactNode => {
  switch (vis.kind) {
    case 'Grid':
      // Phase 393 — a static read-only grid renders the semantic <table> leg (byte-identical
      // to the retired Table); a data-bound grid takes the ordinary grid path.
      return vis.spec.staticRows !== undefined
        ? renderTable(ctx, {
            headers: vis.spec.staticRows.headers,
            rows: vis.spec.staticRows.rows,
            // Phase 801 — the declared sort intent rides through to the rendered <table>.
            ...(vis.spec.staticRows.sortable !== undefined
              ? { sortable: vis.spec.staticRows.sortable }
              : {}),
            ...(vis.spec.staticRows.defaultSort !== undefined
              ? { defaultSort: vis.spec.staticRows.defaultSort }
              : {}),
          })
        : renderGrid(ctx, parentNodeId, state, vis.spec);
    case 'Chart':
      return renderChart(ctx, state, vis.spec);
    case 'Map':
      return renderMap(ctx, state, vis.spec);
  }
};

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `v${counter.toString(36)}`;
};

const renderGrid = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  state: StateBehaviour<TMsg>,
  spec: GridSpec<TMsg>,
): ReactNode => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(
      ctx,
      state.onError({
        kind: 'BindingResolution',
        message: resolution.message,
        correlationId: correlationId(),
      }),
    );
  }
  const rows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];
  if (rows.length === 0 && state.onEmpty !== undefined) {
    return renderNode(ctx, state.onEmpty);
  }
  // Phase 427 — the default row-click write (the 423/426 archetype for the
  // Selection channel): a data-bearing grid whose `onRowClick` is omitted
  // writes the clicked row to the host selection seam (`runtime.setSelection`)
  // under its own NodeId, so every `Binding.Selection` reader of this grid
  // sees the row when the host re-renders — decoded master-detail with zero
  // host code. A present closure dispatches exactly as before (closure wins).
  const onRowClick = spec.onRowClick;
  const writeSelection = (row: unknown): void => {
    if (ctx.runtime.setSelection) ctx.runtime.setSelection(parentNodeId, row as JsonValue);
    else if (ctx.runtime.warn)
      ctx.runtime.warn(`grid '${parentNodeId}' selection — no runtime.setSelection wired.`);
  };

  // Selected-row visual state: compare the current selection against each row
  // by stable row key (`rowKey` closure wins; else the declarative
  // `rowKeyField` projection). No key contract ⇒ no reliable identity ⇒ no
  // visual state — parity-locked with the F# renderer. An empty key, or the
  // decoded `rowKey` placeholder (a `"<closure>"`-constant closure — every row
  // would "match"), is no identity either.
  const rowKeyOf: ((row: unknown) => string) | undefined =
    spec.rowKey ??
    (spec.rowKeyField !== undefined
      ? (row: unknown): string => projectRowFieldString(row, spec.rowKeyField as string)
      : undefined);
  const selectedRaw = ctx.sources.selections?.[parentNodeId];
  const rawSelectedKey =
    rowKeyOf !== undefined && selectedRaw !== undefined ? rowKeyOf(selectedRaw) : undefined;
  const selectedKey =
    rawSelectedKey !== undefined && rawSelectedKey !== '' && rawSelectedKey !== '<closure>'
      ? rawSelectedKey
      : undefined;

  return (
    <table className="fuaran-grid">
      <thead>
        <tr>
          {spec.columns.map((col, i) => (
            <th key={i} className="fuaran-grid-header">
              {col.label}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, ri) => {
          const isSelected =
            selectedKey !== undefined && rowKeyOf !== undefined && rowKeyOf(row) === selectedKey;
          return (
            <tr
              key={ri}
              className={
                isSelected ? 'fuaran-grid-row fuaran-grid-row-selected' : 'fuaran-grid-row'
              }
              onClick={() =>
                onRowClick !== undefined ? runAction(ctx, onRowClick(row)) : writeSelection(row)
              }
            >
              {spec.columns.map((col, ci) => (
                <td key={ci} className="fuaran-grid-cell">
                  {renderGridCell(ctx, col, row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );
};

// Phase 425 — the row-field projection contract (parity-locked with F# `projectRowFieldValue`):
// read a named property off a row object and coerce it to a `CellValue`. Missing field → Empty.
const projectRowFieldValue = (row: unknown, field: string): CellValue => {
  if (row === null || typeof row !== 'object') return { kind: 'Empty' };
  const v = (row as Record<string, unknown>)[field];
  if (v === null || v === undefined) return { kind: 'Empty' };
  if (typeof v === 'string') return { kind: 'Text', value: v };
  if (typeof v === 'boolean') return { kind: 'Bool', value: v };
  if (typeof v === 'number') return { kind: 'Numeric', value: v };
  return { kind: 'Empty' };
};

// Phase 427 — the row-key floor (parity-locked with F# `projectRowFieldString`): project a named
// field off a row to a string for stable row identity. Empty string when the field is missing.
const projectRowFieldString = (row: unknown, field: string): string => {
  const v = projectRowFieldValue(row, field);
  switch (v.kind) {
    case 'Text':
      return v.value;
    case 'Numeric':
      return String(v.value);
    case 'Bool':
      return v.value ? 'true' : 'false';
    case 'Date':
      return v.value.toISOString();
    case 'Empty':
      return '';
  }
};

// Phase 750 — lower a `TonedPill` for one row: the named field's text IS the pill's
// label, and its tone is the map's entry for that text, or `defaultTone` for a value the
// map does not mention. One helper because both this renderer and the SSR twin need it
// (parity-locked with F# `BindingResolver.tonedPillOf`) — a per-surface lookup-with-
// fallback is exactly how two hosts come to disagree about an unmapped value.
const tonedPillOf = (
  row: unknown,
  field: string,
  map: Readonly<Record<string, ToneVariant>>,
  defaultTone: ToneVariant,
): readonly [string, ToneVariant] => {
  const label = projectRowFieldString(row, field);
  return [label, map[label] ?? defaultTone];
};

const renderGridCell = <TMsg,>(
  ctx: RenderContext<TMsg>,
  col: ColumnErased<TMsg>,
  row: unknown,
): ReactNode => {
  // Phase 425 — the closure wins; else the declarative `field` projects the row property; else empty.
  const value: CellValue =
    col.value !== undefined
      ? col.value(row)
      : col.field !== undefined
        ? projectRowFieldValue(row, col.field)
        : { kind: 'Empty' };
  const kind: CellKindErased<TMsg> = col.kind;
  switch (kind.kind) {
    case 'Text':
    case 'Numeric':
    case 'Date':
      return <span>{renderCellValue(col.format, value)}</span>;
    case 'Editable': {
      const onEdit = kind.onEdit;
      if (value.kind === 'Numeric') {
        return (
          <input
            className="fuaran-grid-cell-editable"
            type="number"
            value={value.value}
            onChange={(e) =>
              runAction(ctx, onEdit(row, { kind: 'Numeric', value: Number(e.target.value) }))
            }
          />
        );
      }
      if (value.kind === 'Text') {
        return (
          <input
            className="fuaran-grid-cell-editable"
            type="text"
            value={value.value}
            onChange={(e) => runAction(ctx, onEdit(row, { kind: 'Text', value: e.target.value }))}
          />
        );
      }
      return <span>{renderCellValue(col.format, value)}</span>;
    }
    case 'Checkbox': {
      const onToggle = kind.onToggle;
      return (
        <input
          type="checkbox"
          checked={kind.get(row)}
          onChange={(e) => runAction(ctx, onToggle(row, e.target.checked))}
        />
      );
    }
    case 'Button': {
      const onClick = kind.onClick;
      return (
        <button
          className="fuaran-grid-cell-button"
          onClick={(e) => {
            e.stopPropagation();
            runAction(ctx, onClick(row));
          }}
        >
          {renderText(ctx.sources, kind.label)}
        </button>
      );
    }
    case 'ButtonGroup':
      return (
        <span className="fuaran-grid-cell-button-group">
          {kind.buttons.map(([label, onClick], i) => (
            <button
              key={i}
              className="fuaran-grid-cell-button"
              onClick={(e) => {
                e.stopPropagation();
                runAction(ctx, onClick(row));
              }}
            >
              {renderText(ctx.sources, label)}
            </button>
          ))}
        </span>
      );
    case 'Link':
      return (
        <a className="fuaran-grid-cell-link" href={sanitizeUrlOrBlank(kind.href(row))}>
          {renderText(ctx.sources, kind.label(row))}
        </a>
      );
    case 'Pill':
      return (
        <span className={`fuaran-grid-cell-pill fuaran-pill-${toneVar(kind.tone(row))}`}>
          {renderText(ctx.sources, kind.label(row))}
        </span>
      );
    // Phase 750 — the declarative twin. Deliberately the SAME element, class vocabulary
    // and text as the hosted `Pill` arm above: the wire variant exists to make the tone
    // rule expressible, not to render differently.
    case 'TonedPill': {
      const [label, tone] = tonedPillOf(row, kind.field, kind.map, kind.defaultTone);
      return <span className={`fuaran-grid-cell-pill fuaran-pill-${toneVar(tone)}`}>{label}</span>;
    }
    case 'Progress': {
      const f = kind.fraction(row);
      const label = kind.label;
      return (
        <div className="fuaran-grid-cell-progress">
          <div className="fuaran-grid-cell-progress-fill" style={{ width: `${f * 100}%` }} />
          {label !== undefined ? <span>{renderText(ctx.sources, label(row))}</span> : null}
        </div>
      );
    }
    case 'Custom':
      return renderNode(
        ctx,
        kind.render((r: unknown) => r as JsonValue),
      );
  }
};

const renderChart = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  spec: ChartSpec<TMsg>,
): ReactNode => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(
      ctx,
      state.onError({
        kind: 'BindingResolution',
        message: resolution.message,
        correlationId: correlationId(),
      }),
    );
  }
  const rows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];

  // Phase 534 tail — first-party lowering: a Bar/Line chart with resolved embedded rows
  // lowers to a canonical `Drawing` subtree via `@fuaran-ui/charts` and renders as real
  // inline SVG (the TS twin of the Python `render.py` `_chart` first-party path + a byte
  // sibling of the existing `Display.Drawing` arm). Anything unresolved / not-yet-lowered
  // falls through to the client-hydration placeholder below.
  if (isLowered(spec.kind) && rows.length > 0 && rows.every(isChartRow)) {
    // Only a literal title carries into the lowered drawing (mirrors the Python gate).
    const title =
      spec.title !== undefined && spec.title.kind === 'Literal' ? spec.title.value : undefined;
    const drawing = lower(
      {
        kind: spec.kind,
        xField: spec.xField,
        yFields: spec.yFields,
        stacked: spec.stacked,
        ...(title !== undefined ? { title } : {}),
      },
      rows as readonly ChartRow[],
    );
    return <div dangerouslySetInnerHTML={{ __html: drawingSvg(ctx.sources, drawing) }} />;
  }

  const rowCount = rows.length;
  return (
    <div className="fuaran-chart">
      {spec.title !== undefined && (
        <div className="fuaran-chart-title">{renderText(ctx.sources, spec.title)}</div>
      )}
      <div className="fuaran-chart-placeholder" data-stacked={spec.stacked}>
        {`[Chart placeholder: ${spec.kind}${spec.stacked ? ' (stacked)' : ''} — ${rowCount} rows × {${spec.xField}} → {${spec.yFields.join(', ')}}. Wire a chart adapter for live rendering.]`}
      </div>
    </div>
  );
};

const renderTable = <TMsg,>(ctx: RenderContext<TMsg>, spec: TableSpec<TMsg>): ReactElement => (
  <table
    className="fuaran-table"
    // Phase 801 — the declared sort intent as data attributes, so a progressive-enhancement
    // script honours it without re-parsing the wire. Emitted ONLY when declared, so an
    // undeclared table's DOM is unchanged and SSR hydration still finds what it expects.
    {...(spec.sortable !== undefined
      ? { 'data-fuaran-sortable': spec.sortable ? 'true' : 'false' }
      : {})}
    {...(spec.defaultSort !== undefined
      ? {
          'data-fuaran-sort-column': String(spec.defaultSort.column),
          'data-fuaran-sort-direction': spec.defaultSort.direction,
        }
      : {})}
  >
    <thead>
      <tr>
        {spec.headers.map((h, i) => (
          <th key={i} className="fuaran-table-header">
            {renderText(ctx.sources, h)}
          </th>
        ))}
      </tr>
    </thead>
    <tbody>
      {spec.rows.map((row, ri) => {
        const onRowClick = spec.onRowClick;
        return (
          <tr
            key={ri}
            className="fuaran-table-row"
            {...(onRowClick !== undefined ? { onClick: () => runAction(ctx, onRowClick(ri)) } : {})}
          >
            {row.map((cell, ci) => (
              <td key={ci} className="fuaran-table-cell">
                {renderText(ctx.sources, cell)}
              </td>
            ))}
          </tr>
        );
      })}
    </tbody>
  </table>
);

const renderMap = <TMsg,>(
  ctx: RenderContext<TMsg>,
  state: StateBehaviour<TMsg>,
  spec: MapSpec<TMsg>,
): ReactNode => {
  const resolution = resolve(ctx.sources, spec.source);
  if (resolution.kind === 'NotResolved' && state.onLoading !== undefined) {
    return renderNode(ctx, state.onLoading);
  }
  if (resolution.kind === 'Errored' && state.onError !== undefined) {
    return renderNode(
      ctx,
      state.onError({
        kind: 'BindingResolution',
        message: resolution.message,
        correlationId: correlationId(),
      }),
    );
  }
  const markers =
    resolution.kind === 'Resolved'
      ? asArray<import('@fuaran-ui/schema').MapMarker>(resolution.value)
      : [];
  const onMarkerClick = spec.onMarkerClick;
  return (
    <div className="fuaran-map">
      <div className="fuaran-map-placeholder">
        {`[Map placeholder: ${markers.length} markers around (${spec.centreLatitude.toFixed(4)}, ${spec.centreLongitude.toFixed(4)}) zoom ${spec.zoom}. Wire a Leaflet adapter for live rendering.]`}
      </div>
      {markers.length > 0 && (
        <ul className="fuaran-map-marker-list">
          {markers.map((marker, i) => (
            <li
              key={i}
              className="fuaran-map-marker"
              {...(onMarkerClick !== undefined
                ? { onClick: () => runAction(ctx, onMarkerClick(marker)) }
                : {})}
            >
              {`${renderText(ctx.sources, marker.label)} @ (${marker.latitude.toFixed(4)}, ${marker.longitude.toFixed(4)})`}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};
