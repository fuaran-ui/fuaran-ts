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
  Binding,
  CellKindErased,
  DefaultSort,
  CellValue,
  ChartKind,
  ChartSpec,
  ColumnErased,
  GridSpec,
  JsonValue,
  MapSpec,
  SortDirection,
  StateBehaviour,
  TableSpec,
  ToneVariant,
  VisKind,
} from '@fuaran-ui/schema';
import type { ChartRow } from '@fuaran-ui/charts';
import { isLowered, lower } from '@fuaran-ui/charts';

import {
  asArray,
  renderCellValue,
  renderText,
  resolve,
  tryResolve,
  type BindingSources,
} from '../bindings.js';
import { chartLowerSpecOf } from '../chartLowerSpec.js';
import { toneVar } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { runAction, writeBackTo } from '../context.js';
import { drawingSvg } from '../drawingSvg.js';
import { sanitizeUrlForEgress } from '../egress.js';
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
  const resolvedRows = resolution.kind === 'Resolved' ? asArray<unknown>(resolution.value) : [];
  if (resolvedRows.length === 0 && state.onEmpty !== undefined) {
    return renderNode(ctx, state.onEmpty);
  }
  // Phase 818 — `sortStateKey`: the grid sorts its RESOLVED rows by the
  // state-carried descriptor before rendering (runtime-side sort — the author
  // wires no Transform). No descriptor written yet ⇒ natural source order.
  // Phase 861 — the effective order: the state slot decides, and a declared
  // `defaultSort` fills only the not-yet-sorted case. Parity-locked with F#
  // `BindingResolver.effectiveSortDescriptor`.
  const sortDescriptor = effectiveSortDescriptor(spec.sortStateKey, spec.defaultSort, ctx.sources);
  const rows = sortRowsByDescriptor(spec.columns, sortDescriptor, resolvedRows);
  // Phase 862 — `pageStateKey` + `pageSize`: the grid shows one page at a time
  // and owns the pager that moves between them. `hostPages` is the source-shape
  // rule (a `Query` depending on the page key returns the page itself), in
  // which case the pager still renders and drives the query but the grid does
  // NOT slice again.
  const paging =
    spec.pageStateKey !== undefined && spec.pageSize !== undefined && spec.pageSize > 0
      ? (() => {
          const key = spec.pageStateKey;
          const size = spec.pageSize;
          const hostPages = sourceHostPagesOn(spec.source, key);
          const requested = readPageDescriptor(ctx.sources, key);
          return {
            key,
            size,
            hostPages,
            page: hostPages ? Math.max(1, requested) : clampPage(size, requested, rows.length),
          };
        })()
      : undefined;
  // The rows this render actually paints. `rowOffset` is what makes the
  // page-relative index the cell loop hands back addressable in the FULL set —
  // without it a page-2 edit would commit to the matching row of page 1 (the
  // Phase-663 write-back indexes `rows`).
  const pageRows =
    paging !== undefined && !paging.hostPages
      ? sliceRowsToPage(paging.size, paging.page, rows)
      : rows;
  const rowOffset = paging !== undefined && !paging.hostPages ? (paging.page - 1) * paging.size : 0;
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

  // Phase 663 — the grid write-back floor (the Phase 426 control default
  // replayed for the grid): an editable grid commits an edited cell as the
  // WHOLE updated rows value, so every other reader of that key (a Chart
  // sourced on the same `$state` entry) re-renders with the edit.
  // Phase 863 — WHERE it commits is `editDestination`: a declared
  // `editStateKey` wins, else the 663 floor, else no destination and no input.
  // Parity-locked with the F# renderer's `editCommit`.
  const editTarget = editDestination(spec.editable, spec.editStateKey, spec.source);
  const editCommit: ((rowIndex: number, field: string, value: unknown) => void) | undefined =
    editTarget === undefined
      ? undefined
      : (rowIndex, field, value) => {
          const absolute = rowOffset + rowIndex;
          const newRows = rows.map((row, i) =>
            i === absolute ? updateRowField(row, field, value) : row,
          );
          writeBackTo(ctx, editTarget, newRows as unknown as JsonValue);
        };

  // Phase 934 — declarative row reorder, resolving through the same
  // destination the edit path uses, so one collection has one destination.
  // Suppressed while a sort descriptor is IN EFFECT (user-written or
  // `defaultSort`): the sort re-imposes its order on the next render, so a drag
  // would visibly snap back — an affordance that lies. Clear the sort, and the
  // handles return. Parity-locked with the F# renderer.
  const reorderTarget =
    sortDescriptor !== undefined
      ? undefined
      : reorderDestination(spec.reorderable, spec.editStateKey, spec.source);
  const reorderCommit: ((fromAbs: number, toAbs: number) => void) | undefined =
    reorderTarget === undefined
      ? undefined
      : (fromAbs, toAbs) => {
          const moved = moveRow(fromAbs, toAbs, rows);
          // `moveRow` hands back the SAME array instance for an out-of-range or
          // no-op move; writing it back would churn every reader for nothing.
          if (moved !== rows) writeBackTo(ctx, reorderTarget, moved as unknown as JsonValue);
        };

  // The handle is a real <button>: focusable, keyboard-activatable and screen-
  // reader announced with no ARIA re-plumbing. Keyboard is arrow keys on the
  // focused handle — the current pattern for list reorder (`aria-grabbed` is
  // deprecated and deliberately absent); pointer is native HTML5 drag onto any
  // row. The reference CSS already ships these class names (the Phase 77
  // byte-copy), so the affordance lands styled.
  const reorderCell = (rowIndex: number): ReactElement | undefined => {
    if (reorderCommit === undefined) return undefined;
    const commit = reorderCommit;
    const absolute = rowOffset + rowIndex;
    const total = rows.length;
    return (
      <td className="fuaran-grid-reorder-cell">
        <button
          className="fuaran-grid-reorder-handle"
          type="button"
          data-reorder-handle={String(absolute)}
          draggable
          aria-label={`Reorder row ${absolute + 1} of ${total} — drag, or press an arrow key to move it`}
          aria-keyshortcuts="ArrowUp ArrowDown"
          onDragStart={() => {
            gridDragSource = [parentNodeId, absolute];
          }}
          onDragEnd={() => {
            gridDragSource = undefined;
          }}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              commit(absolute, absolute - 1);
            } else if (e.key === 'ArrowDown') {
              e.preventDefault();
              commit(absolute, absolute + 1);
            }
          }}
        >
          {'⣿'}
        </button>
      </td>
    );
  };

  const reorderHeaderCell = (): ReactElement | undefined =>
    reorderCommit === undefined ? undefined : (
      <th key="reorder" className="fuaran-grid-reorder-header" scope="col" aria-label="Reorder" />
    );

  // The drop-target props a row gains while a reorder is possible.
  // `preventDefault` on dragover is what marks the row droppable to the
  // browser, and the drop consumes only a drag begun on THIS grid.
  const reorderRowProps = (
    rowIndex: number,
  ): {
    onDragOver?: (e: { preventDefault: () => void }) => void;
    onDrop?: (e: { preventDefault: () => void }) => void;
  } => {
    if (reorderCommit === undefined) return {};
    const commit = reorderCommit;
    return {
      onDragOver: (e) => e.preventDefault(),
      onDrop: (e) => {
        if (gridDragSource !== undefined && gridDragSource[0] === parentNodeId) {
          const sourceIndex = gridDragSource[1];
          e.preventDefault();
          gridDragSource = undefined;
          commit(sourceIndex, rowOffset + rowIndex);
        }
      },
    };
  };

  // Phase 818 — the sortable-header affordance for a `sortStateKey` grid. A
  // header whose column declares a `field` renders as a sortable affordance
  // (the Phase-801 static-table presentation vocabulary: `data-sortable` +
  // live `aria-sort`, keyboard-activatable); clicking header N dispatches the
  // equivalent of `SetState(sortStateKey, {"column": N, "direction": …})` —
  // routed through `runAction` so it lands exactly as any tree write. A
  // field-less closure column is not sortable and renders without the
  // affordance.
  const sortableHeader = (colIndex: number, col: ColumnErased<TMsg>): ReactElement => {
    // Phase 861 — the column flag NARROWS, never widens: absent inherits,
    // `false` opts out, and `true` cannot turn the affordance on where the grid
    // names no sort state key (FUARAN094 refuses that pre-emit).
    if (spec.sortStateKey === undefined || col.field === undefined || col.sortable === false) {
      return (
        <th key={colIndex} className="fuaran-grid-header">
          {col.label}
        </th>
      );
    }
    const sortKey = spec.sortStateKey;
    const active =
      sortDescriptor !== undefined && sortDescriptor[0] === colIndex
        ? sortDescriptor[1]
        : undefined;
    // Phase 801's three-state cycle, adopted for the bound path: ascending →
    // descending → AUTHORED. The third state writes an EMPTY descriptor rather
    // than clearing the key, because a cleared key means "not yet sorted" and
    // would re-apply `defaultSort` — the user would ask for the emitter's order
    // and be handed the declared one.
    const dispatchToggle = (): void => {
      const next =
        active === 'asc'
          ? { column: colIndex, direction: 'desc' }
          : active === 'desc'
            ? {}
            : { column: colIndex, direction: 'asc' };
      runAction(ctx, { kind: 'SetState', key: sortKey, value: next });
    };
    return (
      <th
        key={colIndex}
        className="fuaran-grid-header"
        data-sortable=""
        tabIndex={0}
        {...(active !== undefined
          ? { 'aria-sort': active === 'asc' ? ('ascending' as const) : ('descending' as const) }
          : {})}
        onClick={dispatchToggle}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            dispatchToggle();
          }
        }}
      >
        {col.label}
      </th>
    );
  };

  // Phase 862 — the pager. RENDERER-OWNED, which is the whole point of the
  // Phase-860 rule: because the grid draws it, the control that writes the page
  // state and the grid that reads it cannot come apart, so the decorative-pager
  // shape is not authorable. Host-paged grids cannot know the row total, so the
  // pager degrades to previous/next with no page count — a stated limit of this
  // cut, not an oversight. Parity-locked with the F# renderer's `pager`.
  const pager = (): ReactElement | undefined => {
    if (paging === undefined) return undefined;
    const lastPage = paging.hostPages ? undefined : pageCountOf(paging.size, rows.length);
    const goTo = (target: number): void => {
      runAction(ctx, { kind: 'SetState', key: paging.key, value: { page: target } });
    };
    const step = (label: string, target: number, disabled: boolean): ReactElement => (
      <button
        type="button"
        className="fuaran-grid-pager-step"
        disabled={disabled}
        {...(disabled ? {} : { onClick: () => goTo(target) })}
      >
        {label}
      </button>
    );
    return (
      <nav className="fuaran-grid-pager" aria-label="Pagination">
        {step('Previous', paging.page - 1, paging.page <= 1)}
        {/* The page position changes without the surrounding layout moving, so
            a screen reader is told politely rather than left to discover it. */}
        <span className="fuaran-grid-pager-status" aria-live="polite">
          {lastPage !== undefined ? `Page ${paging.page} of ${lastPage}` : `Page ${paging.page}`}
        </span>
        {step('Next', paging.page + 1, lastPage !== undefined && paging.page >= lastPage)}
      </nav>
    );
  };

  // Phase 863 — the per-cell commit. Editable write-back applies only on the
  // declarative path: a `field`-projected Text/Numeric cell with no `value`
  // closure (a closure's projection need not correspond to any row field, so
  // there is nothing sound to write). The column flag NARROWS the grid-level
  // capability — an explicit `false` is read-only, the declaration that
  // read-only-by-omission could not make.
  const cellCommit = (
    rowIndex: number,
    col: ColumnErased<TMsg>,
  ): ((v: CellValue) => void) | undefined => {
    if (editCommit === undefined || col.editable === false) return undefined;
    if (col.value !== undefined || col.field === undefined) return undefined;
    if (col.kind.kind !== 'Text' && col.kind.kind !== 'Numeric') return undefined;
    const commit = editCommit;
    const field = col.field;
    return (v: CellValue) => {
      if (v.kind === 'Numeric' || v.kind === 'Text') commit(rowIndex, field, v.value);
    };
  };

  const gridTable = (
    <table className="fuaran-grid">
      <thead>
        <tr>
          {reorderHeaderCell()}
          {spec.columns.map((col, i) => sortableHeader(i, col))}
        </tr>
      </thead>
      <tbody>
        {pageRows.map((row, ri) => {
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
              {...reorderRowProps(ri)}
            >
              {reorderCell(ri)}
              {spec.columns.map((col, ci) => (
                <td key={ci} className="fuaran-grid-cell">
                  {renderGridCell(ctx, cellCommit(ri, col), col, row)}
                </td>
              ))}
            </tr>
          );
        })}
      </tbody>
    </table>
  );

  // The paged grid gains ONE wrapper element; an unpaged grid emits
  // byte-identical DOM to before this phase.
  if (paging === undefined) return gridTable;
  return (
    <div className="fuaran-grid-paged">
      {gridTable}
      {pager()}
    </div>
  );
};

// ─── Data-bound grid sort (Phase 818 — `sortStateKey`) ───────────────────────
//
// Parity-locked with F# `BindingResolver.readSortDescriptor` /
// `sortRowsByDescriptor`: the descriptor is validated rather than trusted (a
// malformed descriptor reads as "no sort" so the authored order stands); empty
// cells sort LAST in both directions (unmeasured is not zero); ties keep their
// authored relative order (Array.prototype.sort is stable); string comparison
// is ordinal over the lower-cased forms.

const readSortDescriptor = (
  sources: BindingSources,
  key: string,
): readonly [number, SortDirection] | undefined => {
  const raw = sources.state?.[key];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
  const rec = raw as Record<string, unknown>;
  const col = rec['column'];
  const dir = rec['direction'];
  if (typeof col !== 'number' || !Number.isInteger(col) || col < 0) return undefined;
  if (dir !== 'asc' && dir !== 'desc') return undefined;
  return [col, dir];
};

// ─── Data-bound grid pagination (Phase 862 — `pageStateKey` / `pageSize`) ────
//
// Parity-locked with F# `BindingResolver.readPageDescriptor` / `clampPage` /
// `sliceRowsToPage` / `pageCountOf` / `sourceHostPagesOn`. Same discipline as
// the sort helpers above: validated rather than trusted, and one definition per
// rule so the two hosts cannot disagree about which rows are on page 3.
//
// Who slices is decided by the SOURCE shape, never by a second declaration: a
// `Query` whose `dependsOn` names the page key already returns the page.

const readPageDescriptor = (sources: BindingSources, key: string): number => {
  const raw = sources.state?.[key];
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 1;
  const page = (raw as Record<string, unknown>)['page'];
  if (typeof page !== 'number' || !Number.isInteger(page) || page < 1) return 1;
  return page;
};

const sourceHostPagesOn = (source: Binding<readonly unknown[]>, pageKey: string): boolean =>
  source.kind === 'Query' && (source.dependsOn ?? []).includes(pageKey);

const pageCountOf = (pageSize: number, rowCount: number): number =>
  pageSize <= 0 ? 1 : Math.max(1, Math.ceil(rowCount / pageSize));

const clampPage = (pageSize: number, page: number, rowCount: number): number =>
  Math.min(Math.max(1, page), pageCountOf(pageSize, rowCount));

const sliceRowsToPage = (
  pageSize: number,
  page: number,
  rows: readonly unknown[],
): readonly unknown[] => {
  if (pageSize <= 0) return rows;
  const clamped = clampPage(pageSize, page, rows.length);
  const start = (clamped - 1) * pageSize;
  return rows.slice(start, start + pageSize);
};

// ─── The grid's whole-rows write destination (Phase 863 / Phase 934) ─────────
//
// Parity-locked with F# `BindingResolver.gridWriteDestination` /
// `editDestination` / `reorderDestination` / `moveRow`.
//
// A grid has TWO whole-rows writers — an edited cell and a reordered row — and
// they write the same collection, so the destination is resolved in ONE place:
// a declared `editStateKey` wins (Phase 863 added it so a *decoded* grid could
// say where its writes land at all — the only previous spelling was a host
// closure, which crosses the wire as `"<closure>"`); else the Phase-663 floor,
// the grid's own `source` when that source is a direct `State` binding; else
// NOTHING, and the caller draws no input and no handle. A Transform pipeline is
// not invertible and Static/Query rows are host data, so an affordance over
// them would be a gesture with no destination — the fake-affordance class the
// grid-behaviour charter refuses, and the reason this returns `undefined`
// rather than a no-op writer.

/** The structurally-minimal binding view `writeBackTo` reads. */
type WriteTarget = { readonly kind: string; readonly key?: string; readonly name?: string };

const gridWriteDestination = (
  editStateKey: string | undefined,
  source: Binding<readonly unknown[]>,
): WriteTarget | undefined => {
  if (editStateKey !== undefined) return { kind: 'State', key: editStateKey };
  return source.kind === 'State' ? (source as WriteTarget) : undefined;
};

const editDestination = (
  editable: boolean,
  editStateKey: string | undefined,
  source: Binding<readonly unknown[]>,
): WriteTarget | undefined => (editable ? gridWriteDestination(editStateKey, source) : undefined);

const reorderDestination = (
  reorderable: boolean,
  editStateKey: string | undefined,
  source: Binding<readonly unknown[]>,
): WriteTarget | undefined =>
  reorderable ? gridWriteDestination(editStateKey, source) : undefined;

/**
 * Move the row at `fromIndex` to `toIndex` (both absolute in the full set).
 * Out-of-range either side, or a no-move, returns the SAME array instance —
 * the caller writes the result back wholesale, so "invalid move writes nothing
 * new" and "invalid move is refused" are one behaviour with no partial state in
 * between. Parity-locked with F# `BindingResolver.moveRow`, which refuses
 * rather than clamping for the same reason.
 */
const moveRow = (
  fromIndex: number,
  toIndex: number,
  rows: readonly unknown[],
): readonly unknown[] => {
  const count = rows.length;
  if (
    fromIndex === toIndex ||
    fromIndex < 0 ||
    fromIndex >= count ||
    toIndex < 0 ||
    toIndex >= count
  ) {
    return rows;
  }
  const item = rows[fromIndex];
  const without = rows.filter((_, i) => i !== fromIndex);
  return [...without.slice(0, toIndex), item, ...without.slice(toIndex)];
};

/**
 * Set one field on one row, returning a NEW row object (Phase 663's
 * `updateRowField`). A row that is not an object is handed back untouched —
 * there is no field to write.
 */
const updateRowField = (row: unknown, field: string, value: unknown): unknown => {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  return { ...(row as Record<string, unknown>), [field]: value };
};

// The in-flight drag, module-level for the same reason the F# renderer keeps it
// there: HTML5 `dataTransfer` is unreadable during `dragover`, so the drop
// target cannot decide whether it is a legitimate target from the event alone.
// Keyed by grid node id, so a drop only ever consumes a drag begun on the SAME
// grid — dragging between two grids does nothing rather than something wrong.
let gridDragSource: readonly [string, number] | undefined;

// Phase 861 — the three-way slot. `readSortDescriptor` collapses "nothing
// written" and "written but not a sort" into undefined, which was right while
// the only alternative to a sort was the authored order; it stops being right
// once a grid can declare an initial order. Parity-locked with F#
// `BindingResolver.readSortSlot` / `effectiveSortDescriptor`.
type SortSlot =
  | { readonly kind: 'NotSorted' }
  | { readonly kind: 'SortedBy'; readonly column: number; readonly direction: SortDirection }
  | { readonly kind: 'Cleared' };

const readSortSlot = (sources: BindingSources, key: string): SortSlot => {
  if (sources.state?.[key] === undefined) return { kind: 'NotSorted' };
  const d = readSortDescriptor(sources, key);
  return d === undefined
    ? { kind: 'Cleared' }
    : { kind: 'SortedBy', column: d[0], direction: d[1] };
};

const effectiveSortDescriptor = (
  sortStateKey: string | undefined,
  defaultSort: DefaultSort | undefined,
  sources: BindingSources,
): readonly [number, SortDirection] | undefined => {
  const declared: readonly [number, SortDirection] | undefined =
    defaultSort !== undefined ? [defaultSort.column, defaultSort.direction] : undefined;
  if (sortStateKey === undefined) return declared;
  const slot = readSortSlot(sources, sortStateKey);
  switch (slot.kind) {
    case 'NotSorted':
      return declared;
    case 'SortedBy':
      return [slot.column, slot.direction];
    case 'Cleared':
      return undefined;
  }
};

const cellSortRank = (v: CellValue): number => {
  switch (v.kind) {
    case 'Numeric':
      return 0;
    case 'Bool':
      return 1;
    case 'Date':
      return 2;
    case 'Text':
      return 3;
    case 'Empty':
      return 4;
  }
};

const compareCells = (a: CellValue, b: CellValue): number => {
  if (a.kind === 'Numeric' && b.kind === 'Numeric')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'Bool' && b.kind === 'Bool') return Number(a.value) - Number(b.value);
  if (a.kind === 'Date' && b.kind === 'Date') return a.value.getTime() - b.value.getTime();
  if (a.kind === 'Text' && b.kind === 'Text') {
    const x = a.value.toLowerCase();
    const y = b.value.toLowerCase();
    return x < y ? -1 : x > y ? 1 : 0;
  }
  return cellSortRank(a) - cellSortRank(b);
};

const sortRowsByDescriptor = <TMsg,>(
  columns: readonly ColumnErased<TMsg>[],
  descriptor: readonly [number, SortDirection] | undefined,
  rows: readonly unknown[],
): readonly unknown[] => {
  if (descriptor === undefined) return rows;
  const [colIndex, direction] = descriptor;
  const field = columns[colIndex]?.field;
  if (field === undefined) return rows;
  const keyed = rows.map((r) => [projectRowFieldValue(r, field), r] as const);
  keyed.sort(([ka], [kb]) => {
    if (ka.kind === 'Empty' && kb.kind === 'Empty') return 0;
    if (ka.kind === 'Empty') return 1;
    if (kb.kind === 'Empty') return -1;
    const c = compareCells(ka, kb);
    return direction === 'asc' ? c : -c;
  });
  return keyed.map(([, r]) => r);
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
  commit: ((v: CellValue) => void) | undefined,
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
      // Phase 663 — a `commit` (threaded from `renderGrid` only for
      // field-projected Text/Numeric cells on an editable grid with a reachable
      // destination) turns the display cell into the same input shapes as the
      // `Editable` cell kind, committing the RAW value, never the formatted
      // rendering. Absent `commit`, the cell is the pre-663 span, unchanged.
      if (commit !== undefined) {
        if (kind.kind === 'Numeric' && value.kind === 'Numeric') {
          return (
            <input
              className="fuaran-grid-cell-editable"
              type="number"
              value={value.value}
              onChange={(e) => {
                // An empty / mid-edit number input parses NaN — never commit it
                // (a NaN cell would silently flatten every chart on the key).
                const n = Number(e.target.value);
                if (!Number.isNaN(n)) commit({ kind: 'Numeric', value: n });
              }}
            />
          );
        }
        if (kind.kind === 'Numeric') {
          // An Empty (or non-numeric) cell in a Numeric column: text input,
          // committed only when the entry parses numerically.
          return (
            <input
              className="fuaran-grid-cell-editable"
              type="text"
              value={renderCellValue({ kind: 'None' }, value)}
              onChange={(e) => {
                const n = Number(e.target.value);
                if (e.target.value.trim() !== '' && !Number.isNaN(n))
                  commit({ kind: 'Numeric', value: n });
              }}
            />
          );
        }
        return (
          <input
            className="fuaran-grid-cell-editable"
            type="text"
            value={value.kind === 'Text' ? value.value : renderCellValue({ kind: 'None' }, value)}
            onChange={(e) => commit({ kind: 'Text', value: e.target.value })}
          />
        );
      }
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
    case 'Link': {
      // Phase 1037 — the ambient destination policy, same as the `Link` node.
      // Worth stating that this call site is not an afterthought: the href here
      // comes from a ROW ACCESSOR over bound data, so a single decoded tree
      // emits one per row, and a grid pointed at attacker-influenced rows is
      // the highest-volume egress surface the renderer has.
      const [href, egressAttrs] = sanitizeUrlForEgress(
        ctx.egressPolicy,
        'hyperlink',
        kind.href(row),
      );
      return (
        <a className="fuaran-grid-cell-link" href={href} {...Object.fromEntries(egressAttrs)}>
          {renderText(ctx.sources, kind.label(row))}
        </a>
      );
    }
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
    // Every declared semantic field crosses the bridge — see `chartLowerSpec.ts`,
    // which is the ONE place that decision is made (the server twin reads the
    // same helper) and which states the Literal-only `TextSource` rule.
    const drawing = lower(chartLowerSpecOf(spec), rows as readonly ChartRow[]);
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
