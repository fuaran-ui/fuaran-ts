// ============================================================================
//  @fuaran-ui/ops — grid edits as columnar ops (WIRE_FORMAT.md §3.2, "Edits as
//  column ops — GridEdit", Phase 1891; this host since Phase 2500).
//
//  A grid edit carried as the columnar op it is, beside the whole-rows write:
//  the `GridEdit` codec, the op's application to a table (a typed refusal,
//  never a throw), its inverse read from the table it applies to, the row delta
//  it induces under the grid's declared `rowKeyField`, and an edit history
//  (apply, undo, redo). A port of the reference's columnar op algebra
//  (`Fuaran.Compute.ColumnOps`) and its server-driven edit log, certified
//  against the corpus's `grid-edit/` family.
// ============================================================================

import {
  cellAt,
  columnCells,
  columnLength,
  columnOfCells,
  columnTypeWidens,
  decimalCanonical,
  evalErrorString,
  evalPipeline,
  timestampTypeOfText,
} from '@fuaran-ui/core-twins';
import type { Cell, ColumnType, DataColumn, Table, Transform } from '@fuaran-ui/schema';

import { decodePipelineCore } from './decode.js';
import { caseObj, encodePipeline, jArray, jObject, num, str } from './encode.js';
import { parse, type JsonAst } from './parse.js';

// ─── the op, the edit, the refusals ──────────────────────────────────────────

/** A columnar edit op over a table — the reference's `ColumnOp`. */
export type ColumnOp =
  | { readonly kind: 'setCell'; readonly col: string; readonly row: number; readonly value: Cell }
  | { readonly kind: 'setColumn'; readonly column: DataColumn }
  | { readonly kind: 'insertColumn'; readonly index: number; readonly column: DataColumn }
  | { readonly kind: 'removeColumn'; readonly name: string }
  | {
      readonly kind: 'appendRows';
      readonly rows: readonly (readonly (readonly [string, Cell])[])[];
    }
  | { readonly kind: 'applyTransform'; readonly pipeline: readonly Transform[] };

/** A grid edit: the State key it commits to, the op, and the grid's declared row identity. */
export interface GridEdit {
  readonly key: string;
  readonly op: ColumnOp;
  /** The grid's `rowKeyField`; absent means no identity is declared. */
  readonly rowKeyField?: string;
}

/** Why an op was refused — the corpus's refusal tokens. */
export type ColumnRefusal =
  | 'noSuchColumn'
  | 'duplicateColumn'
  | 'rowOutOfRange'
  | 'cellTypeMismatch'
  | 'columnLengthMismatch'
  | 'rowShapeUnknownColumn'
  | 'transformRejected'
  | 'notInvertible';

export type ColumnOpResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly refusal: ColumnRefusal; readonly detail: string };

const done = <T>(value: T): ColumnOpResult<T> => ({ ok: true, value });
const refuse = (refusal: ColumnRefusal, detail: string): ColumnOpResult<never> => ({
  ok: false,
  refusal,
  detail,
});

// ─── table helpers ───────────────────────────────────────────────────────────

const rowCount = (t: Table): number => (t.columns.length === 0 ? 0 : columnLength(t.columns[0]!));
const names = (t: Table): string => t.columns.map((c) => c.name).join(', ');
const findColumn = (t: Table, name: string): DataColumn | undefined =>
  t.columns.find((c) => c.name === name);

const cellType = (c: Cell): ColumnType | undefined => {
  switch (c.kind) {
    case 'Int':
      return 'int';
    case 'Float':
      return 'float';
    case 'Bool':
      return 'bool';
    case 'Str':
      return 'string';
    case 'Date':
      return 'date';
    case 'Timestamp':
      return timestampTypeOfText(c.value);
    case 'Decimal':
      return 'decimal';
    case 'Null':
      return undefined;
  }
};

/** A cell fits a column when it is `Null` or of a type that widens into the column's. */
const fits = (type: ColumnType, c: Cell): boolean => {
  const t = cellType(c);
  return t === undefined || columnTypeWidens(t, type);
};

const build = (name: string, type: ColumnType, cells: readonly Cell[]): DataColumn => {
  const r = columnOfCells(name, type, cells);
  // Every cell was checked to fit before the column is rebuilt, so the builder cannot refuse.
  if (!r.ok) throw new Error(`@fuaran-ui/ops gridEdit: ${r.error}`);
  return r.value;
};

/** `t` with the column of `col.name` replaced; a retyped column gets a fresh schema entry. */
const replaceColumn = (t: Table, col: DataColumn): Table => ({
  schema: t.schema.map((e) =>
    e.name === col.name && e.type !== col.type ? { name: col.name, type: col.type } : e,
  ),
  columns: t.columns.map((c) => (c.name === col.name ? col : c)),
});

const insertAt = <T>(xs: readonly T[], i: number, x: T): T[] => [
  ...xs.slice(0, i),
  x,
  ...xs.slice(i),
];

// ─── apply / invert ──────────────────────────────────────────────────────────

/** Apply a columnar op to a table — total: a typed refusal, never a throw. */
export const applyColumnOp = (op: ColumnOp, t: Table): ColumnOpResult<Table> => {
  switch (op.kind) {
    case 'setCell': {
      const col = findColumn(t, op.col);
      if (col === undefined)
        return refuse('noSuchColumn', `no such column '${op.col}'; available: ${names(t)}`);
      const rc = rowCount(t);
      if (op.row < 0 || op.row >= rc)
        return refuse('rowOutOfRange', `row ${op.row} out of range (row count ${rc})`);
      if (!fits(col.type, op.value))
        return refuse('cellTypeMismatch', `column '${op.col}': expected ${col.type} cell`);
      const cells = columnCells(col);
      cells[op.row] = op.value;
      return done(replaceColumn(t, build(col.name, col.type, cells)));
    }
    case 'setColumn': {
      if (findColumn(t, op.column.name) === undefined)
        return refuse('noSuchColumn', `no such column '${op.column.name}'; available: ${names(t)}`);
      const rc = rowCount(t);
      const n = columnLength(op.column);
      if (n !== rc)
        return refuse(
          'columnLengthMismatch',
          `column '${op.column.name}': length ${n} ≠ row count ${rc}`,
        );
      return done(replaceColumn(t, op.column));
    }
    case 'insertColumn': {
      if (findColumn(t, op.column.name) !== undefined)
        return refuse('duplicateColumn', `duplicate column: ${op.column.name}`);
      const rc = rowCount(t);
      const n = columnLength(op.column);
      if (t.columns.length > 0 && n !== rc)
        return refuse(
          'columnLengthMismatch',
          `column '${op.column.name}': length ${n} ≠ row count ${rc}`,
        );
      const i = Math.max(0, Math.min(op.index, t.columns.length));
      return done({
        schema: insertAt(t.schema, i, { name: op.column.name, type: op.column.type }),
        columns: insertAt(t.columns, i, op.column),
      });
    }
    case 'removeColumn':
      if (findColumn(t, op.name) === undefined)
        return refuse('noSuchColumn', `no such column '${op.name}'; available: ${names(t)}`);
      return done({
        schema: t.schema.filter((e) => e.name !== op.name),
        columns: t.columns.filter((c) => c.name !== op.name),
      });
    case 'appendRows': {
      for (const row of op.rows) {
        for (const [name, value] of row) {
          const col = findColumn(t, name);
          if (col === undefined)
            return refuse(
              'rowShapeUnknownColumn',
              `row references unknown column '${name}'; available: ${names(t)}`,
            );
          if (!fits(col.type, value))
            return refuse('cellTypeMismatch', `column '${name}': expected ${col.type} cell`);
        }
      }
      return done({
        schema: t.schema,
        columns: t.columns.map((col) => {
          const appended = op.rows.map(
            (row) => row.find(([n]) => n === col.name)?.[1] ?? ({ kind: 'Null' } as Cell),
          );
          return build(col.name, col.type, [...columnCells(col), ...appended]);
        }),
      });
    }
    case 'applyTransform': {
      const r = evalPipeline(op.pipeline, t);
      return r.ok ? done(r.value) : refuse('transformRejected', evalErrorString(r.error));
    }
  }
};

/**
 * The op that undoes `op` applied to the PRE-state `t`. An op the table would refuse has no
 * inverse (its refusal is returned); `appendRows` and `applyTransform` have none at any table.
 */
export const invertColumnOp = (op: ColumnOp, t: Table): ColumnOpResult<ColumnOp> => {
  if (op.kind === 'appendRows' || op.kind === 'applyTransform')
    return refuse('notInvertible', `${op.kind} is not invertible`);
  const applied = applyColumnOp(op, t);
  if (!applied.ok) return applied;
  switch (op.kind) {
    case 'setCell':
      return done({
        kind: 'setCell',
        col: op.col,
        row: op.row,
        value: cellAt(findColumn(t, op.col)!, op.row),
      });
    case 'setColumn':
      return done({ kind: 'setColumn', column: findColumn(t, op.column.name)! });
    case 'insertColumn':
      return done({ kind: 'removeColumn', name: op.column.name });
    case 'removeColumn': {
      const index = t.columns.findIndex((c) => c.name === op.name);
      return done({ kind: 'insertColumn', index, column: t.columns[index]! });
    }
  }
};

// ─── the row delta ───────────────────────────────────────────────────────────

export type RowChange = 'added' | 'changed' | 'removed';

/** A row delta: the top element, or the rows a change touched by key under a scheme. */
export type TableDelta =
  | { readonly kind: 'fullRefresh' }
  | {
      readonly kind: 'rowSet';
      readonly scheme: string;
      readonly rows: readonly (readonly [string, RowChange])[];
    };

/** The cell token a row key is spelled in (the reference's `Cell.token`). */
export const cellToken = (c: Cell): string => {
  switch (c.kind) {
    case 'Int':
      return 'i:' + String(c.value);
    case 'Float':
      return (
        'f:' +
        (Number.isNaN(c.value)
          ? 'NaN'
          : c.value === Infinity
            ? 'Inf'
            : c.value === -Infinity
              ? '-Inf'
              : num(c.value === 0 ? 0 : c.value))
      );
    case 'Bool':
      return 'b:' + (c.value ? '1' : '0');
    case 'Str':
      return 's:' + c.value;
    case 'Date':
      return 'd:' + c.value;
    case 'Timestamp':
      return 't:' + c.value;
    case 'Decimal':
      return 'm:' + (decimalCanonical(c.value) ?? c.value);
    case 'Null':
      return 'n:';
  }
};

/** Cell equality as the reference decides "unchanged": a NaN never equals itself, the zeros agree. */
const sameCell = (a: Cell, b: Cell): boolean =>
  a.kind === b.kind &&
  (a.kind === 'Null' || (a as { value: unknown }).value === (b as { value: unknown }).value);

const keysOf = (t: Table, field: string): (string | undefined)[] => {
  const col = findColumn(t, field);
  const n = rowCount(t);
  const out = new Array<string | undefined>(n);
  for (let i = 0; i < n; i += 1) {
    const c = col === undefined ? undefined : cellAt(col, i);
    out[i] = c === undefined || c.kind === 'Null' ? undefined : cellToken(c);
  }
  return out;
};

const FULL: TableDelta = { kind: 'fullRefresh' };

const rowSet = (scheme: string, rows: (readonly [string, RowChange])[]): TableDelta => ({
  kind: 'rowSet',
  scheme,
  rows: [...rows].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)),
});

/**
 * The row delta `op` induces on `before` under identity by the column `field` (scheme
 * `column:<field>`): built from the op and the before table, never by diffing two tables. A schema
 * or whole-table op, an op that does not apply, and a row with no key are the top delta.
 */
export const deltaOf = (field: string, before: Table, op: ColumnOp): TableDelta => {
  const scheme = 'column:' + field;
  if (op.kind === 'insertColumn' || op.kind === 'removeColumn' || op.kind === 'applyTransform')
    return FULL;
  const applied = applyColumnOp(op, before);
  if (!applied.ok) return FULL;
  const after = applied.value;
  const k0 = keysOf(before, field);
  const k1 = keysOf(after, field);
  switch (op.kind) {
    case 'setCell': {
      const a = k0[op.row];
      const b = k1[op.row];
      if (a === undefined || b === undefined) return FULL;
      if (sameCell(cellAt(findColumn(before, op.col)!, op.row), op.value))
        return rowSet(scheme, []);
      return a === b
        ? rowSet(scheme, [[a, 'changed']])
        : rowSet(scheme, [
            [a, 'removed'],
            [b, 'added'],
          ]);
    }
    case 'setColumn': {
      if (k0.some((k, i) => k === undefined || k !== k1[i])) return FULL;
      const old = findColumn(before, op.column.name)!;
      const rows: [string, RowChange][] = [];
      for (let i = 0; i < k0.length; i += 1)
        if (!sameCell(cellAt(old, i), cellAt(op.column, i))) rows.push([k0[i]!, 'changed']);
      return rowSet(scheme, rows);
    }
    case 'appendRows': {
      const added = k1.slice(k0.length);
      const existing = new Set(k0.filter((k): k is string => k !== undefined));
      const fresh =
        added.every((k) => k !== undefined) &&
        new Set(added).size === added.length &&
        added.every((k) => !existing.has(k!));
      return fresh
        ? rowSet(
            scheme,
            added.map((k) => [k!, 'added'] as const),
          )
        : FULL;
    }
  }
};

// ─── the codecs ──────────────────────────────────────────────────────────────

/** A cell in the columnar op codec's form: `{"$type":"Int","v":21}`. */
const opCell = (c: Cell): string =>
  c.kind === 'Null'
    ? caseObj('Null', [])
    : caseObj(c.kind, [
        [
          'v',
          c.kind === 'Bool'
            ? String(c.value)
            : c.kind === 'Int' || c.kind === 'Float'
              ? num(c.value)
              : str(c.kind === 'Decimal' ? (decimalCanonical(c.value) ?? c.value) : c.value),
        ],
      ]);

const opColumn = (c: DataColumn): string =>
  jObject([
    ['name', str(c.name)],
    ['type', str(c.type)],
    ['cells', jArray(columnCells(c).map(opCell))],
  ]);

/** The canonical wire string for a columnar op. */
export const encodeColumnOp = (op: ColumnOp): string => {
  switch (op.kind) {
    case 'setCell':
      return caseObj('setCell', [
        ['col', str(op.col)],
        ['row', num(op.row)],
        ['value', opCell(op.value)],
      ]);
    case 'setColumn':
      return caseObj('setColumn', [['column', opColumn(op.column)]]);
    case 'insertColumn':
      return caseObj('insertColumn', [
        ['index', num(op.index)],
        ['column', opColumn(op.column)],
      ]);
    case 'removeColumn':
      return caseObj('removeColumn', [['name', str(op.name)]]);
    case 'appendRows':
      return caseObj('appendRows', [
        [
          'rows',
          jArray(
            op.rows.map((row) =>
              jArray(
                row.map(([n, v]) =>
                  jObject([
                    ['col', str(n)],
                    ['value', opCell(v)],
                  ]),
                ),
              ),
            ),
          ),
        ],
      ]);
    case 'applyTransform':
      return caseObj('applyTransform', [['pipeline', encodePipeline(op.pipeline)]]);
  }
};

/** The canonical wire string for a grid edit; an undeclared `rowKeyField` is omitted. */
export const encodeGridEdit = (edit: GridEdit): string =>
  caseObj('GridEdit', [
    ['key', str(edit.key)],
    ['op', encodeColumnOp(edit.op)],
    ...(edit.rowKeyField === undefined ? [] : [['rowKeyField', str(edit.rowKeyField)] as const]),
  ]);

/** The canonical wire string for a row delta. */
export const encodeTableDelta = (d: TableDelta): string =>
  d.kind === 'fullRefresh'
    ? caseObj('fullRefresh', [])
    : caseObj('rowSet', [
        ['scheme', str(d.scheme)],
        ['rows', jArray(d.rows.map(([k, c]) => caseObj(c, [['key', str(k)]])))],
        ['columns', jArray([])],
      ]);

export type GridEditDecode<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const fail = (error: string): GridEditDecode<never> => ({ ok: false, error });
const ok = <T>(value: T): GridEditDecode<T> => ({ ok: true, value });

const fieldsOf = (j: JsonAst): ReadonlyMap<string, JsonAst> | undefined =>
  j.kind === 'JObject' ? j.fields : undefined;
const strField = (f: ReadonlyMap<string, JsonAst>, k: string): string | undefined => {
  const v = f.get(k);
  return v?.kind === 'JString' ? v.value : undefined;
};
const intField = (f: ReadonlyMap<string, JsonAst>, k: string): number | undefined => {
  const v = f.get(k);
  return v?.kind === 'JNumber' && Number.isSafeInteger(v.value) ? v.value : undefined;
};

const decodeOpCell = (j: JsonAst): GridEditDecode<Cell> => {
  const f = fieldsOf(j);
  if (f === undefined) return fail('cell: expected an object');
  const kind = strField(f, '$type');
  if (kind === 'Null') return ok({ kind: 'Null' });
  const v = f.get('v');
  if (v === undefined) return fail(`cell: missing field: v`);
  switch (kind) {
    case 'Int':
      return v.kind === 'JNumber' &&
        Number.isInteger(v.value) &&
        v.value >= -2147483648 &&
        v.value <= 2147483647
        ? ok({ kind: 'Int', value: v.value })
        : fail('cell: expected int');
    case 'Float':
      return v.kind === 'JNumber'
        ? ok({ kind: 'Float', value: v.value })
        : fail('cell: expected float');
    case 'Bool':
      return v.kind === 'JBool'
        ? ok({ kind: 'Bool', value: v.value })
        : fail('cell: expected bool');
    case 'Str':
    case 'Date':
    case 'Timestamp':
      return v.kind === 'JString' ? ok({ kind, value: v.value }) : fail('cell: expected string');
    case 'Decimal': {
      const text =
        v.kind === 'JString'
          ? decimalCanonical(v.value)
          : v.kind === 'JNumber' && Number.isSafeInteger(v.value)
            ? String(v.value)
            : undefined;
      return text === undefined
        ? fail('cell: not decimal text')
        : ok({ kind: 'Decimal', value: text });
    }
    default:
      return fail(`unknown cell kind: ${kind ?? '(none)'}`);
  }
};

const COLUMN_TYPES: readonly ColumnType[] = [
  'int',
  'float',
  'bool',
  'string',
  'date',
  'timestamp',
  'decimal',
  'timestamp_ms',
  'timestamp_us',
  'timestamp_ns',
];

const decodeOpColumn = (j: JsonAst): GridEditDecode<DataColumn> => {
  const f = fieldsOf(j);
  const name = f && strField(f, 'name');
  const type = f && strField(f, 'type');
  const cellsJ = f?.get('cells');
  if (name === undefined || type === undefined || cellsJ?.kind !== 'JArray')
    return fail('column: expected {name, type, cells}');
  if (!COLUMN_TYPES.includes(type as ColumnType)) return fail(`unknown column type: ${type}`);
  const cells: Cell[] = [];
  for (const c of cellsJ.items) {
    const r = decodeOpCell(c);
    if (!r.ok) return r;
    cells.push(r.value);
  }
  const col = columnOfCells(name, type as ColumnType, cells);
  return col.ok ? ok(col.value) : fail(`column '${name}': ${col.error}`);
};

/** Decode a columnar op from its JSON form. */
export const decodeColumnOpJson = (j: JsonAst): GridEditDecode<ColumnOp> => {
  const f = fieldsOf(j);
  if (f === undefined) return fail('op: expected an object');
  const kind = strField(f, '$type');
  switch (kind) {
    case 'setCell': {
      const col = strField(f, 'col');
      const row = intField(f, 'row');
      const valueJ = f.get('value');
      if (col === undefined || row === undefined || valueJ === undefined)
        return fail('setCell: expected {col, row, value}');
      const value = decodeOpCell(valueJ);
      return value.ok ? ok({ kind, col, row, value: value.value }) : value;
    }
    case 'setColumn':
    case 'insertColumn': {
      const colJ = f.get('column');
      if (colJ === undefined) return fail(`${kind}: missing field: column`);
      const column = decodeOpColumn(colJ);
      if (!column.ok) return column;
      if (kind === 'setColumn') return ok({ kind, column: column.value });
      const index = intField(f, 'index');
      return index === undefined
        ? fail('insertColumn: expected an int index')
        : ok({ kind, index, column: column.value });
    }
    case 'removeColumn': {
      const name = strField(f, 'name');
      return name === undefined ? fail('removeColumn: expected a name') : ok({ kind, name });
    }
    case 'appendRows': {
      const rowsJ = f.get('rows');
      if (rowsJ?.kind !== 'JArray') return fail('appendRows: expected a rows array');
      const rows: (readonly [string, Cell])[][] = [];
      for (const rowJ of rowsJ.items) {
        if (rowJ.kind !== 'JArray') return fail('appendRows: a row is an array');
        const row: (readonly [string, Cell])[] = [];
        for (const cellJ of rowJ.items) {
          const cf = fieldsOf(cellJ);
          const col = cf && strField(cf, 'col');
          const valueJ = cf?.get('value');
          if (col === undefined || valueJ === undefined)
            return fail('appendRows: expected {col, value}');
          const value = decodeOpCell(valueJ);
          if (!value.ok) return value;
          row.push([col, value.value]);
        }
        rows.push(row);
      }
      return ok({ kind, rows });
    }
    case 'applyTransform': {
      const pipelineJ = f.get('pipeline');
      if (pipelineJ === undefined) return fail('applyTransform: missing field: pipeline');
      const pipeline = decodePipelineCore(pipelineJ);
      return pipeline.ok ? ok({ kind, pipeline: pipeline.value }) : fail(pipeline.error);
    }
    default:
      return fail(`unknown columnar op: ${kind ?? '(none)'}`);
  }
};

const GRID_EDIT_MEMBERS = new Set(['$type', 'key', 'op', 'rowKeyField']);

/**
 * Decode a `GridEdit` from its JSON form. STRICT: a member outside the four, an empty `key` or
 * `rowKeyField`, or an op the codec does not know is refused, because an edit applied differently
 * from the one sent is worse than one refused.
 */
export const decodeGridEditJson = (j: JsonAst): GridEditDecode<GridEdit> => {
  const f = fieldsOf(j);
  if (f === undefined) return fail('GridEdit: expected an object');
  for (const k of f.keys())
    if (!GRID_EDIT_MEMBERS.has(k)) return fail(`GridEdit: unknown member '${k}'`);
  if (strField(f, '$type') !== 'GridEdit') return fail('GridEdit: $type must be "GridEdit"');
  const key = strField(f, 'key');
  if (key === undefined || key === '') return fail('GridEdit: key must be a non-empty string');
  const opJ = f.get('op');
  if (opJ === undefined) return fail('GridEdit: missing op');
  const rk = f.get('rowKeyField');
  if (rk !== undefined && (rk.kind !== 'JString' || rk.value === ''))
    return fail('GridEdit: rowKeyField must be a non-empty string');
  const op = decodeColumnOpJson(opJ);
  if (!op.ok) return fail('GridEdit: op: ' + op.error);
  return ok(
    rk === undefined
      ? { key, op: op.value }
      : { key, op: op.value, rowKeyField: (rk as { value: string }).value },
  );
};

/** Decode a `GridEdit` from its wire text. */
export const decodeGridEdit = (text: string): GridEditDecode<GridEdit> => {
  const ast = parse(text);
  return ast.ok ? decodeGridEditJson(ast.value) : fail('GridEdit: not json');
};

// ─── the edit history ────────────────────────────────────────────────────────

export type HistoryRefusal = ColumnRefusal | 'nothingToUndo' | 'nothingToRedo';

export type HistoryResult =
  | { readonly ok: true; readonly history: GridEditHistory }
  | { readonly ok: false; readonly refusal: HistoryRefusal };

type Entry = readonly [op: ColumnOp, inverse: ColumnOp];

/**
 * An edit history over one table. Immutable: every gesture returns a new history. An edit's
 * inverse is read from the table it is applied to; an edit with none (`appendRows`,
 * `applyTransform`) applies and clears what could be undone; any new edit clears what could be
 * redone. Bounded: past `capacity` edits the oldest is no longer undoable (`nothingToUndo`).
 */
export class GridEditHistory {
  private constructor(
    readonly table: Table,
    private readonly capacity: number,
    private readonly undoStack: readonly Entry[],
    private readonly redoStack: readonly Entry[],
  ) {}

  static create(table: Table, capacity = 100): GridEditHistory {
    return new GridEditHistory(table, Math.max(1, capacity), [], []);
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0;
  }

  apply(op: ColumnOp): HistoryResult {
    const applied = applyColumnOp(op, this.table);
    if (!applied.ok) return { ok: false, refusal: applied.refusal };
    const inverse = invertColumnOp(op, this.table);
    const undo = inverse.ok
      ? [[op, inverse.value] as const, ...this.undoStack].slice(0, this.capacity)
      : [];
    return { ok: true, history: new GridEditHistory(applied.value, this.capacity, undo, []) };
  }

  undo(): HistoryResult {
    const [top, ...rest] = this.undoStack;
    if (top === undefined) return { ok: false, refusal: 'nothingToUndo' };
    const applied = applyColumnOp(top[1], this.table);
    if (!applied.ok) return { ok: false, refusal: applied.refusal };
    return {
      ok: true,
      history: new GridEditHistory(applied.value, this.capacity, rest, [top, ...this.redoStack]),
    };
  }

  redo(): HistoryResult {
    const [top, ...rest] = this.redoStack;
    if (top === undefined) return { ok: false, refusal: 'nothingToRedo' };
    const applied = applyColumnOp(top[0], this.table);
    if (!applied.ok) return { ok: false, refusal: applied.refusal };
    const undo = [top, ...this.undoStack].slice(0, this.capacity);
    return { ok: true, history: new GridEditHistory(applied.value, this.capacity, undo, rest) };
  }
}
