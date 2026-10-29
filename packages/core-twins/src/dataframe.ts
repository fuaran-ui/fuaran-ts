// ============================================================================
//  Core twin — the native-JS columnar dataframe evaluator (Phase 284), moved
//  behind the core-twins boundary in Phase 1861; @fuaran-ui/ops re-exports it.
//
//  A faithful port of the `Fuaran.Core.DataFrame` reference evaluator: a pure
//  fold over the columnar model that runs a serialisable `Transform` pipeline
//  client-side **as data** (no Pyodide). The pinned semantics — null/NA
//  propagation, int↔float coercion, group/sort stability, round-half-away,
//  division-by-zero, the canonical float layout — match the reference exactly, so
//  the evaluator's output `Table` is byte-identical to the reference's under the
//  shared `Canon` codec (`encodeDataSource` ∘ Embedded — the §11.1 parity
//  contract `Conformance.transformLaws` enforces across hosts).
//
//  Total: every recoverable failure is an `EvalError`, never a throw.
// ============================================================================

import type {
  Agg,
  AggFn,
  Cell,
  ColExpr,
  ColumnType,
  DataColumn,
  DataSource,
  EvalError,
  SchemaEntry,
  SortKey,
  Table,
  Transform,
} from '@fuaran-ui/schema';
import type { Result } from '@fuaran-ui/schema';

import { num } from './canonFloat.js';
import {
  cellAt,
  columnCells,
  isPresentAt,
  columnLength,
  columnOfCells,
  nullColumn,
  takeRows,
} from './column.js';
import {
  columnTypeWidens,
  compareInstantText,
  timestampDigits,
  timestampTypeOfText,
} from './columnType.js';
import { daysFromCivil } from './civil.js';
import {
  MAX_DECIMAL_SCALE,
  decimalAbs,
  decimalAdd,
  decimalCanonical,
  decimalCompare,
  decimalDivide,
  decimalIsZero,
  decimalMul,
  decimalOfFloat,
  decimalQuantize,
  decimalRem,
  decimalSub,
  decimalToFloat,
  decimalTruncate,
  type DecimalRoundingMode,
} from './decimalText.js';
import {
  DIMENSIONLESS,
  conversionFactor,
  divUnit,
  mulUnit,
  parseUnit,
  powUnit,
  ratioToFloat,
  renderUnit,
  sameUnit,
  type UnitOfMeasure,
} from './unit.js';

type DR<T> = Result<T, EvalError>;
const dok = <T>(value: T): DR<T> => ({ ok: true, value });
const derr = (error: EvalError): DR<never> => ({ ok: false, error });

const unknownColumn = (name: string, available: readonly string[]): EvalError => ({
  kind: 'UnknownColumn',
  name,
  available,
});
const typeError = (detail: string): EvalError => ({ kind: 'TypeError', detail });
const unboundParam = (name: string, bound: readonly string[]): EvalError => ({
  kind: 'UnboundParam',
  name,
  bound,
});
const arityError = (fn: string, expected: number, got: number): EvalError => ({
  kind: 'ArityError',
  fn,
  expected,
  got,
});

// ─── internal columnar frame (the evaluator's working form) ────────────────────
//
// Phase 2205: the frame holds the table's TYPED columns (`./column.ts`), co-indexed with its schema,
// and a verb reads a row through `cellAt` rather than through a row of boxed cells. The row-set
// verbs (filter, sort, limit, distinct, the set operations, a join's two sides) gather rows by
// index without boxing a cell; a verb that produces values (derive, groupBy, window, pivot,
// unpivot) builds its new column through `columnOfCells`, which admits exactly what Core's typed
// column admits.

interface Frame {
  readonly cols: readonly SchemaEntry[];
  /** One column per schema entry, in schema order, each named and typed as its entry. */
  readonly data: readonly DataColumn[];
  readonly n: number;
}

/** One row of a frame: what `evalExpr` reads a `col` reference through. */
interface RowRef {
  readonly data: readonly DataColumn[];
  readonly i: number;
}

const NULL: Cell = { kind: 'Null' };

const isNull = (c: Cell): boolean => c.kind === 'Null';

const rowCount = (t: Table): number => (t.columns.length > 0 ? columnLength(t.columns[0]!) : 0);

const iota = (n: number): Int32Array => {
  const out = new Int32Array(n);
  for (let i = 0; i < n; i += 1) out[i] = i;
  return out;
};

/** A column built from produced cells, or the storage's refusal as the evaluator's `TypeError`. */
const colOf = (name: string, type: ColumnType, cells: readonly Cell[]): DR<DataColumn> => {
  const c = columnOfCells(name, type, cells);
  return c.ok ? dok(c.value) : derr(typeError(c.error));
};

const renamed = (c: DataColumn, name: string): DataColumn => (c.name === name ? c : { ...c, name });

const toFrame = (t: Table): DR<Frame> => {
  const n = rowCount(t);
  const byName = new Map(t.columns.map((c) => [c.name, c] as const));
  const data: DataColumn[] = [];
  for (const e of t.schema) {
    const c = byName.get(e.name);
    if (c === undefined) data.push(nullColumn(e.name, e.type, n));
    else if (c.type !== e.type) {
      // A column held at another type than its schema entry says is re-admitted at the entry's.
      const r = colOf(e.name, e.type, columnCells(takeRows(c, iota(n))));
      if (!r.ok) return r;
      data.push(r.value);
    } else data.push(columnLength(c) === n ? c : takeRows(c, iota(n)));
  }
  return dok({ cols: t.schema, data, n });
};

const ofFrame = (f: Frame): Table => ({ schema: f.cols, columns: f.data });

/** The frame's rows `rows`, in that order (`-1` an absent row in every column). */
const selectRows = (f: Frame, rows: ArrayLike<number>): Frame => ({
  cols: f.cols,
  data: f.data.map((c) => takeRows(c, rows)),
  n: rows.length,
});

/** The cells of row `i` at the column indices `idxs`. */
const cellsAt = (data: readonly DataColumn[], idxs: readonly number[], i: number): Cell[] =>
  idxs.map((ci) => cellAt(data[ci]!, i));

/** Every cell of row `i`. */
const rowCells = (f: Frame, i: number): Cell[] => f.data.map((c) => cellAt(c, i));

const colIndex = (cols: readonly SchemaEntry[], name: string): number =>
  cols.findIndex((e) => e.name === name);

const colType = (cols: readonly SchemaEntry[], name: string): ColumnType | undefined =>
  cols.find((e) => e.name === name)?.type;

const available = (cols: readonly SchemaEntry[]): string[] => cols.map((e) => e.name);

// ─── pinned scalar semantics ─────────────────────────────────────────────────

/** The canonical string of a cell (float via the shared `Canon` layout). */
export const cellString = (c: Cell): string => {
  switch (c.kind) {
    case 'Int':
      return String(Math.trunc(c.value));
    case 'Float':
      return num(c.value);
    case 'Bool':
      return c.value ? 'true' : 'false';
    case 'Str':
    case 'Date':
    case 'Timestamp':
      return c.value;
    case 'Decimal':
      return decimalCanonical(c.value) ?? c.value;
    case 'Null':
      return '';
  }
};

const asNum = (c: Cell): number | undefined =>
  c.kind === 'Int' || c.kind === 'Float' ? c.value : undefined;

/**
 * The numeric family's order in the float carrier: IEEE order on the non-NaN
 * values, `-0` equal to `0`, and NaN one value ABOVE every other (equal to
 * itself) — the substrate's cell order, the same on every host.
 */
const compareFloat = (x: number, y: number): number => {
  const xn = Number.isNaN(x);
  const yn = Number.isNaN(y);
  if (xn || yn) return xn && yn ? 0 : xn ? 1 : -1;
  return x < y ? -1 : x > y ? 1 : 0;
};

/** A cell as exact decimal text — a `Decimal`'s, or an `Int`'s digits (the lossless promotion). */
const decimalText = (c: Cell): string | undefined =>
  c.kind === 'Decimal' ? c.value : c.kind === 'Int' ? String(Math.trunc(c.value)) : undefined;

/** Total comparison of two present, same-family cells. `undefined` ⇒ incomparable. */
const compareCells = (a: Cell, b: Cell): number | undefined => {
  const an = asNum(a);
  const bn = asNum(b);
  if (an !== undefined && bn !== undefined) return compareFloat(an, bn);
  // A decimal against a decimal or an int compares EXACTLY; against a float it is incomparable
  // (a type error), as the widening lattice refuses that retype in both directions.
  if (
    (a.kind === 'Decimal' && (b.kind === 'Decimal' || b.kind === 'Int')) ||
    (a.kind === 'Int' && b.kind === 'Decimal')
  )
    return decimalCompare(decimalText(a)!, decimalText(b)!);
  if (a.kind === 'Bool' && b.kind === 'Bool') return a.value === b.value ? 0 : a.value ? 1 : -1;
  if (a.kind === 'Str' && b.kind === 'Str')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'Date' && b.kind === 'Date')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  // Phase 2206 — by the instant, not the text: a fraction breaks the byte order.
  if (a.kind === 'Timestamp' && b.kind === 'Timestamp') return compareInstantText(a.value, b.value);
  return undefined;
};

const cellEq = (a: Cell, b: Cell): boolean => {
  if (a.kind === 'Null' || b.kind === 'Null') return false;
  // A decimal matches only a decimal (an equi-join key never promotes).
  if (a.kind === 'Decimal' || b.kind === 'Decimal')
    return a.kind === b.kind && compareCells(a, b) === 0;
  return compareCells(a, b) === 0;
};

const bothInt = (a: Cell, b: Cell): boolean => a.kind === 'Int' && b.kind === 'Int';

/**
 * The refusal a decimal beside a float meets, naming both types and the cast
 * that resolves it: nothing converts between them unless the pipeline says
 * which way.
 */
const decimalFloatMismatch = (what: string): EvalError =>
  typeError(
    what +
      " between a decimal and a float: cast one to the other's type first — Cast(decimal, …) " +
      'to keep the digits exact, Cast(float, …) to compute approximately',
  );

const decimalResult = (ctx: string, r: string | undefined): DR<Cell> =>
  r !== undefined
    ? dok({ kind: 'Decimal', value: r })
    : derr(typeError(ctx + ': an operand is not decimal text'));

/**
 * `add` / `sub` / `mul` / `mod` over two exact operands, at least one a
 * decimal: exact, and a decimal. `div` is refused by name — a quotient of
 * decimals is not a finite decimal in general, so it names its rounding.
 */
const decimalArith = (op: string, x: string, y: string): DR<Cell> => {
  switch (op) {
    case 'add':
      return decimalResult('add', decimalAdd(x, y));
    case 'sub':
      return decimalResult('sub', decimalSub(x, y));
    case 'mul':
      return decimalResult('mul', decimalMul(x, y));
    case 'mod':
      return decimalIsZero(y) ? dok(NULL) : decimalResult('mod', decimalRem(x, y));
    case 'div':
      return derr(
        typeError(
          'division of an exact decimal names its rounding: write quotient(dividend, divisor, { scale, mode })',
        ),
      );
    default:
      return derr(typeError('not an arithmetic operator'));
  }
};

const arith = (op: string, a: Cell, b: Cell): DR<Cell> => {
  if (a.kind === 'Null' || b.kind === 'Null') return dok(NULL);
  if (a.kind === 'Decimal' || b.kind === 'Decimal') {
    if (a.kind === 'Float' || b.kind === 'Float') return derr(decimalFloatMismatch('arithmetic'));
    const dx = decimalText(a);
    const dy = decimalText(b);
    if (dx === undefined || dy === undefined)
      return derr(typeError('arithmetic on a non-numeric operand'));
    return decimalArith(op, dx, dy);
  }
  const x = asNum(a);
  const y = asNum(b);
  if (x === undefined || y === undefined)
    return derr(typeError('arithmetic on a non-numeric operand'));
  const bi = bothInt(a, b);
  switch (op) {
    case 'add':
      return dok(
        bi
          ? { kind: 'Int', value: Math.trunc(x) + Math.trunc(y) }
          : { kind: 'Float', value: x + y },
      );
    case 'sub':
      return dok(
        bi
          ? { kind: 'Int', value: Math.trunc(x) - Math.trunc(y) }
          : { kind: 'Float', value: x - y },
      );
    case 'mul':
      return dok(
        bi
          ? { kind: 'Int', value: Math.trunc(x) * Math.trunc(y) }
          : { kind: 'Float', value: x * y },
      );
    case 'div':
      return dok(y === 0 ? NULL : { kind: 'Float', value: x / y });
    case 'mod':
      if (!bi) return derr(typeError('mod requires integer operands'));
      if (Math.trunc(y) === 0) return dok(NULL);
      return dok({ kind: 'Int', value: Math.trunc(x) % Math.trunc(y) });
    default:
      return derr(typeError('not an arithmetic operator'));
  }
};

const comparison = (op: string, a: Cell, b: Cell): DR<Cell> => {
  if (a.kind === 'Null' || b.kind === 'Null') return dok(NULL);
  const c = compareCells(a, b);
  if (c === undefined)
    return derr(
      (a.kind === 'Decimal' && b.kind === 'Float') || (a.kind === 'Float' && b.kind === 'Decimal')
        ? decimalFloatMismatch('comparison')
        : typeError('comparison between incompatible types'),
    );
  let r: boolean;
  switch (op) {
    case 'eq':
      r = c === 0;
      break;
    case 'ne':
      r = c !== 0;
      break;
    case 'lt':
      r = c < 0;
      break;
    case 'le':
      r = c <= 0;
      break;
    case 'gt':
      r = c > 0;
      break;
    case 'ge':
      r = c >= 0;
      break;
    default:
      r = false;
  }
  return dok({ kind: 'Bool', value: r });
};

/** Kleene three-valued AND/OR over Bool/Null operands. */
const logical = (op: string, a: Cell, b: Cell): DR<Cell> => {
  const asBool = (c: Cell): DR<boolean | undefined> => {
    if (c.kind === 'Bool') return dok(c.value);
    if (c.kind === 'Null') return dok(undefined);
    return derr(typeError('logical operator on a non-bool operand'));
  };
  const x = asBool(a);
  if (!x.ok) return x;
  const y = asBool(b);
  if (!y.ok) return y;
  const xv = x.value;
  const yv = y.value;
  if (op === 'and') {
    if (xv === false || yv === false) return dok({ kind: 'Bool', value: false });
    if (xv === true && yv === true) return dok({ kind: 'Bool', value: true });
    return dok(NULL);
  }
  if (op === 'or') {
    if (xv === true || yv === true) return dok({ kind: 'Bool', value: true });
    if (xv === false && yv === false) return dok({ kind: 'Bool', value: false });
    return dok(NULL);
  }
  return derr(typeError('not a logical operator'));
};

// .NET Double.TryParse(NumberStyles.Float, InvariantCulture) — leading/trailing
// whitespace + sign + decimal + exponent. JS Number over a trimmed, regex-gated
// string approximates it without accepting hex / Infinity literals .NET rejects.
const FLOAT_RE = /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/;
const tryParseFloat = (s: string): number | undefined => {
  const t = s.trim();
  if (!FLOAT_RE.test(t)) return undefined;
  const n = Number(t);
  return Number.isFinite(n) ? n : undefined;
};
const INT_RE = /^[+-]?\d+$/;
const tryParseInt = (s: string): number | undefined => {
  const t = s.trim();
  return INT_RE.test(t) ? parseInt(t, 10) : undefined;
};

const castCell = (ty: ColumnType, c: Cell): DR<Cell> => {
  if (c.kind === 'Null') return dok(NULL);
  switch (ty) {
    case 'string':
      return dok({ kind: 'Str', value: cellString(c) });
    case 'float': {
      const n = asNum(c);
      if (n !== undefined) return dok({ kind: 'Float', value: n });
      // The nearest float to the decimal — the cast says the pipeline asked for the
      // approximation. A decimal past the float range is refused, never an infinity.
      if (c.kind === 'Decimal') {
        const f = decimalToFloat(c.value);
        return f !== undefined
          ? dok({ kind: 'Float', value: f })
          : derr(
              typeError("cannot cast decimal '" + c.value + "' to float: outside the float range"),
            );
      }
      if (c.kind === 'Str') {
        const p = tryParseFloat(c.value);
        return p !== undefined
          ? dok({ kind: 'Float', value: p })
          : derr(typeError("cannot cast '" + c.value + "' to float"));
      }
      return derr(typeError('cannot cast to float'));
    }
    case 'int':
      if (c.kind === 'Int') return dok(c);
      if (c.kind === 'Float') return dok({ kind: 'Int', value: Math.trunc(c.value) });
      // Truncated toward zero, as a float is; outside int32 a named refusal.
      if (c.kind === 'Decimal') {
        const t = decimalTruncate(c.value);
        return t !== undefined && t >= -2147483648n && t <= 2147483647n
          ? dok({ kind: 'Int', value: Number(t) })
          : derr(typeError('decimal→int cast out of int32 range: ' + c.value));
      }
      if (c.kind === 'Bool') return dok({ kind: 'Int', value: c.value ? 1 : 0 });
      if (c.kind === 'Str') {
        const p = tryParseInt(c.value);
        return p !== undefined
          ? dok({ kind: 'Int', value: p })
          : derr(typeError("cannot cast '" + c.value + "' to int"));
      }
      return derr(typeError('cannot cast to int'));
    case 'bool':
      if (c.kind === 'Bool') return dok(c);
      if (c.kind === 'Int') return dok({ kind: 'Bool', value: c.value !== 0 });
      return derr(typeError('cannot cast to bool'));
    case 'date':
      if (c.kind === 'Date') return dok(c);
      if (c.kind === 'Str') return dok({ kind: 'Date', value: c.value });
      return derr(typeError('cannot cast to date'));
    // Phase 2206 — a cast to any timestamp unit keeps the instant's one
    // canonical text; the unit is a statement about the column, not the cell.
    case 'timestamp':
    case 'timestamp_ms':
    case 'timestamp_us':
    case 'timestamp_ns':
      if (c.kind === 'Timestamp') return dok(c);
      if (c.kind === 'Str') return dok({ kind: 'Timestamp', value: c.value });
      return derr(typeError('cannot cast to timestamp'));
    case 'decimal': {
      // An int is exactly a decimal; a string is read by the decimal grammar; a FLOAT is the one
      // place an approximation enters a decimal — its shortest round-trip digits.
      if (c.kind === 'Int') return dok({ kind: 'Decimal', value: String(Math.trunc(c.value)) });
      if (c.kind === 'Float') {
        const d = decimalOfFloat(c.value);
        return d !== undefined
          ? dok({ kind: 'Decimal', value: d })
          : derr(typeError('cannot cast a non-finite float to decimal'));
      }
      if (c.kind === 'Decimal' || c.kind === 'Str') {
        const d = decimalCanonical(c.value);
        return d !== undefined
          ? dok({ kind: 'Decimal', value: d })
          : derr(typeError("cannot cast '" + c.value + "' to decimal"));
      }
      return derr(typeError('cannot cast to decimal'));
    }
  }
};

/**
 * THE rounding primitive over cells: `rounded`'s, and through it the decimal
 * arm of `round` / `floor` / `ceil` (scale-0 specialisations). The scale is
 * checked first, then a null propagates, then an exact operand is brought to
 * the scale; a float names the cast.
 */
const scaleRefusal = (scale: number): EvalError | undefined =>
  Number.isInteger(scale) && scale >= 0 && scale <= MAX_DECIMAL_SCALE
    ? undefined
    : typeError('rounding scale ' + String(scale) + ' is outside 0..' + String(MAX_DECIMAL_SCALE));

const roundedCell = (mode: DecimalRoundingMode, scale: number, c: Cell): DR<Cell> => {
  const bad = scaleRefusal(scale);
  if (bad !== undefined) return derr(bad);
  if (c.kind === 'Null') return dok(NULL);
  if (c.kind === 'Float') return derr(decimalFloatMismatch('rounding'));
  const t = decimalText(c);
  if (t === undefined) return derr(typeError('rounding of a non-numeric'));
  return decimalResult('rounded', decimalQuantize(mode, scale, t));
};

/** `quotient`'s primitive: the scale, then null propagation, then one correctly rounded division. */
const quotientCell = (mode: DecimalRoundingMode, scale: number, a: Cell, b: Cell): DR<Cell> => {
  const bad = scaleRefusal(scale);
  if (bad !== undefined) return derr(bad);
  if (a.kind === 'Null' || b.kind === 'Null') return dok(NULL);
  if (a.kind === 'Float' || b.kind === 'Float') return derr(decimalFloatMismatch('quotient'));
  const x = decimalText(a);
  const y = decimalText(b);
  if (x === undefined || y === undefined) return derr(typeError('quotient of a non-numeric'));
  const q = decimalDivide(mode, scale, x, y);
  if (q === undefined) return derr(typeError('quotient: an operand is not decimal text'));
  return dok(q === null ? NULL : { kind: 'Decimal', value: q });
};

/** Round half away from zero — host-independent (not banker's rounding). */
const roundHalfAway = (x: number): number => (x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5));

// ─── Phase 2400: the power functions (the reference's D43) ───────────────────
//
// Two guarantees, stated per function. An INTEGER exponent is EXACT on every host: one pinned
// product tree over IEEE-754 multiplication, which every host rounds the same way, so the tree and
// not the host decides the bits. A float exponent, `exp`, `ln` and `log10` are HOST-ROUNDED: the
// special-value table below answers every input the hosts' libraries disagree on BEFORE `Math` is
// called, and what remains is this host's answer — within the bound the transform laws compare in
// (`expected.tolerance`, in ulps).

/**
 * Binary exponentiation, the accumulator empty until the first set bit, so a power takes exactly
 * the multiplies its bits name: `x^1` is `x`, `x^2` is `x*x`, `x^3` is `x*(x*x)`, `x^4` is
 * `(x*x)*(x*x)`. `k > 0` is the exponent's magnitude.
 */
const powGo = (base: number, k: number): number => {
  let b = base;
  let acc: number | undefined;
  for (;;) {
    if (k % 2 === 1) acc = acc === undefined ? b : acc * b;
    k = Math.floor(k / 2);
    if (k === 0) return acc ?? 1;
    b = b * b;
  }
};

/**
 * A float base under an integer exponent: `x^0` is 1 with no multiply; a negative exponent is one
 * reciprocal of the positive power, null where that power is zero (a zero base, or a power that
 * underflowed), exactly as a division by zero is null. The caller has answered a NaN base.
 */
const powIntFloat = (x: number, n: number): Cell => {
  if (n === 0) return { kind: 'Float', value: 1 };
  if (n > 0) return { kind: 'Float', value: powGo(x, n) };
  const p = powGo(x, -n);
  return p === 0 ? NULL : { kind: 'Float', value: 1 / p };
};

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/**
 * An int base under a non-negative int exponent: the same product tree, every product that leaves
 * the int32 band refused by name — a base square that leaves it with exponent bits still to take
 * included, since every value it would still multiply into is at least as large.
 */
const powIntExact = (x: number, n: number): DR<Cell> => {
  if (n === 0) return dok({ kind: 'Int', value: 1 });
  const inBand = (v: number): boolean => v >= INT32_MIN && v <= INT32_MAX;
  const overflow = (v: number): DR<never> => derr(typeError('pow overflowed int32: ' + String(v)));
  let acc: number | undefined;
  let b = x;
  let k = n;
  for (;;) {
    if (k % 2 === 1) {
      acc = acc === undefined ? b : acc * b;
      if (!inBand(acc)) return overflow(acc);
    }
    k = Math.floor(k / 2);
    if (k === 0) return dok({ kind: 'Int', value: acc ?? 1 });
    const b2 = b * b;
    if (!inBand(b2)) return overflow(b2);
    b = b2;
  }
};

/**
 * A float exponent: the special-value table, then `Math.pow`. A NaN operand propagates (`pow(1,
 * NaN)` and `pow(NaN, 0)` included — JavaScript answers 1 for neither and NaN for the first, which
 * is why the table answers before it); a zero exponent and a base of one answer 1, and so does a base
 * of minus one under an infinite exponent (JavaScript says NaN); a zero base under a negative
 * exponent and a finite negative base under a finite non-integer exponent answer null.
 */
const powFloat = (x: number, y: number): Cell => {
  if (Number.isNaN(x) || Number.isNaN(y)) return { kind: 'Float', value: NaN };
  if (y === 0 || x === 1) return { kind: 'Float', value: 1 };
  if (x === 0 && y < 0) return NULL;
  if (x === -1 && !Number.isFinite(y)) return { kind: 'Float', value: 1 };
  if (x < 0 && Number.isFinite(x) && Number.isFinite(y) && y !== Math.floor(y)) return NULL;
  return { kind: 'Float', value: Math.pow(x, y) };
};

/**
 * `exp`'s table: a NaN propagates; above the natural log of the largest double the answer is +Inf
 * and below the natural log of half the smallest subnormal it is 0 — the two edges where a host's
 * last-ulp rounding decides between a finite value and the limit; between them `Math.exp`.
 */
const expHost = (x: number): number =>
  Number.isNaN(x) ? x : x > 709.782712893384 ? Infinity : x < -745.1332191019412 ? 0 : Math.exp(x);

/**
 * `ln`'s and `log10`'s table over a host logarithm: a NaN propagates, zero and below is null, one is
 * exactly 0 and +Inf is +Inf; in between the host answers.
 */
const logHost = (log: (v: number) => number, x: number): Cell =>
  Number.isNaN(x)
    ? { kind: 'Float', value: x }
    : x <= 0
      ? NULL
      : x === 1
        ? { kind: 'Float', value: 0 }
        : x === Infinity
          ? { kind: 'Float', value: x }
          : { kind: 'Float', value: log(x) };

const SPELLED: Readonly<Record<string, string>> = { exp: 'Exp', ln: 'Ln', log10: 'Log10' };

const applyPower = (fn: string, args: readonly Cell[]): DR<Cell> => {
  if (fn === 'pow') {
    if (args.length !== 2) return derr(arityError(fn, 2, args.length));
    const x = args[0]!;
    const y = args[1]!;
    if (x.kind === 'Null' || y.kind === 'Null') return dok(NULL);
    if (x.kind === 'Decimal' || y.kind === 'Decimal')
      return derr(typeError('pow of a decimal is not exact: write Pow(Cast(float, x), n)'));
    if (x.kind === 'Int' && y.kind === 'Int')
      return y.value >= 0 ? powIntExact(x.value, y.value) : dok(powIntFloat(x.value, y.value));
    if (y.kind === 'Int') {
      const f = asNum(x);
      if (f === undefined) return derr(typeError('pow of a non-numeric'));
      return dok(Number.isNaN(f) ? { kind: 'Float', value: f } : powIntFloat(f, y.value));
    }
    const f = asNum(x);
    const g = asNum(y);
    return f === undefined || g === undefined
      ? derr(typeError('pow of a non-numeric'))
      : dok(powFloat(f, g));
  }
  if (args.length !== 1) return derr(arityError(fn, 1, args.length));
  const c = args[0]!;
  if (c.kind === 'Null') return dok(NULL);
  if (c.kind === 'Decimal')
    return derr(
      typeError(fn + ' of a decimal is not exact: write ' + SPELLED[fn] + '(Cast(float, x))'),
    );
  const f = asNum(c);
  if (f === undefined) return derr(typeError(fn + ' of a non-numeric'));
  if (fn === 'exp') return dok({ kind: 'Float', value: expHost(f) });
  return dok(logHost(fn === 'ln' ? Math.log : Math.log10, f));
};

const applyScalar = (fn: string, args: readonly Cell[]): DR<Cell> => {
  const arity = (n: number): DR<undefined> =>
    args.length === n ? dok(undefined) : derr(arityError(fn, n, args.length));
  const unary = (g: (c: Cell) => DR<Cell>): DR<Cell> => {
    const a = arity(1);
    if (!a.ok) return a;
    const c = args[0]!;
    return c.kind === 'Null' ? dok(NULL) : g(c);
  };
  switch (fn) {
    case 'pow':
    case 'exp':
    case 'ln':
    case 'log10':
      return applyPower(fn, args);
    case 'abs':
      return unary((c) =>
        c.kind === 'Int'
          ? dok({ kind: 'Int', value: Math.abs(c.value) })
          : c.kind === 'Float'
            ? dok({ kind: 'Float', value: Math.abs(c.value) })
            : c.kind === 'Decimal'
              ? decimalResult('abs', decimalAbs(c.value))
              : derr(typeError('abs of a non-numeric')),
      );
    // Over a decimal `round`, `floor` and `ceil` are scale-0 `rounded`s under their pinned modes —
    // exact, through the one rounding kernel; over the numeric family, unchanged.
    case 'round':
      return unary((c) => {
        if (c.kind === 'Decimal') return roundedCell('half-up', 0, c);
        const n = asNum(c);
        return n !== undefined
          ? dok({ kind: 'Float', value: roundHalfAway(n) })
          : derr(typeError('round of a non-numeric'));
      });
    case 'floor':
      return unary((c) => {
        if (c.kind === 'Decimal') return roundedCell('floor', 0, c);
        const n = asNum(c);
        return n !== undefined
          ? dok({ kind: 'Float', value: Math.floor(n) })
          : derr(typeError('floor of a non-numeric'));
      });
    case 'ceil':
      return unary((c) => {
        if (c.kind === 'Decimal') return roundedCell('ceiling', 0, c);
        const n = asNum(c);
        return n !== undefined
          ? dok({ kind: 'Float', value: Math.ceil(n) })
          : derr(typeError('ceil of a non-numeric'));
      });
    case 'length':
      return unary((c) =>
        c.kind === 'Str'
          ? dok({ kind: 'Int', value: c.value.length })
          : derr(typeError('length of a non-string')),
      );
    case 'lower':
      return unary((c) =>
        c.kind === 'Str'
          ? dok({ kind: 'Str', value: c.value.toLowerCase() })
          : derr(typeError('lower of a non-string')),
      );
    case 'upper':
      return unary((c) =>
        c.kind === 'Str'
          ? dok({ kind: 'Str', value: c.value.toUpperCase() })
          : derr(typeError('upper of a non-string')),
      );
    case 'substr': {
      const a = arity(3);
      if (!a.ok) return a;
      const s = args[0]!;
      const start = args[1]!;
      const len = args[2]!;
      if (s.kind === 'Null') return dok(NULL);
      if (s.kind === 'Str' && start.kind === 'Int' && len.kind === 'Int') {
        let st = Math.max(0, start.value);
        st = Math.min(st, s.value.length);
        const ln = Math.max(0, Math.min(len.value, s.value.length - st));
        return dok({ kind: 'Str', value: s.value.substring(st, st + ln) });
      }
      return derr(typeError('substr expects (string, int, int)'));
    }
    case 'datePart': {
      const a = arity(2);
      if (!a.ok) return a;
      const part = args[0]!;
      const date = args[1]!;
      if (date.kind === 'Null') return dok(NULL);
      if (
        part.kind === 'Str' &&
        (date.kind === 'Date' || date.kind === 'Timestamp' || date.kind === 'Str')
      ) {
        const s = date.value;
        const slice = (lo: number, len: number): DR<Cell> => {
          if (s.length >= lo + len) {
            const v = tryParseInt(s.substring(lo, lo + len));
            return v !== undefined
              ? dok({ kind: 'Int', value: v })
              : derr(typeError("datePart: unparseable component in '" + s + "'"));
          }
          return derr(typeError("datePart: '" + s + "' too short for " + part.value));
        };
        switch (part.value) {
          case 'year':
            return slice(0, 4);
          case 'month':
            return slice(5, 2);
          case 'day':
            return slice(8, 2);
          default:
            return derr(typeError("datePart: unknown part '" + part.value + "'"));
        }
      }
      return derr(typeError('datePart expects (string part, date/timestamp/string)'));
    }
    case 'concat': {
      // fuaran-core#90 — variadic; any null arg propagates (compose coalesce for treat-as-empty).
      // Non-string args stringify via the SAME rendering as a cast to string — no cast noise.
      if (args.length === 0) return derr(arityError(fn, 1, 0));
      if (args.some((c) => c.kind === 'Null')) return dok(NULL);
      return dok({ kind: 'Str', value: args.map(cellString).join('') });
    }
    case 'trim':
      return unary((c) =>
        c.kind === 'Str'
          ? // Pinned ASCII set (space/tab/CR/LF) — NOT the host's Unicode trim (parity pin).
            dok({ kind: 'Str', value: c.value.replace(/^[ \t\r\n]+|[ \t\r\n]+$/g, '') })
          : derr(typeError('trim of a non-string')),
      );
    case 'replace': {
      const a = arity(3);
      if (!a.ok) return a;
      const subj = args[0]!;
      const find = args[1]!;
      const repl = args[2]!;
      if (subj.kind === 'Null' || find.kind === 'Null' || repl.kind === 'Null') return dok(NULL);
      if (subj.kind === 'Str' && find.kind === 'Str' && repl.kind === 'Str') {
        // Pinned: empty `find` returns the subject unchanged.
        if (find.value === '') return dok(subj);
        return dok({ kind: 'Str', value: subj.value.split(find.value).join(repl.value) });
      }
      return derr(typeError('replace expects (string, string, string)'));
    }
    case 'dateDiffDays': {
      const a = arity(2);
      if (!a.ok) return a;
      const from = args[0]!;
      const to = args[1]!;
      if (from.kind === 'Null' || to.kind === 'Null') return dok(NULL);
      const da = civilDays(from);
      if (!da.ok) return da;
      const db = civilDays(to);
      if (!db.ok) return db;
      return dok({ kind: 'Int', value: db.value - da.value });
    }
    case 'least':
    case 'greatest': {
      // Variadic (at least one). Any null propagates, as `concat`'s does; incomparable operands are
      // a typed error through the shared cell ordering, so the pinned comparison is the one source.
      if (args.length === 0) return derr(arityError(fn === 'least' ? 'Least' : 'Greatest', 1, 0));
      if (args.some(isNull)) return dok(NULL);
      let best = args[0]!;
      for (const c of args.slice(1)) {
        const k = compareCells(best, c);
        if (k === undefined) return derr(typeError('least/greatest over incompatible types'));
        if ((fn === 'least') !== k <= 0) best = c;
      }
      return dok(best);
    }
    default:
      return derr(typeError("unknown scalar function '" + fn + "'"));
  }
};

const ARITH_OPS = new Set(['add', 'sub', 'mul', 'div', 'mod']);
const CMP_OPS = new Set(['eq', 'ne', 'lt', 'le', 'gt', 'ge']);
const STR_OPS = new Set(['contains', 'startsWith', 'endsWith']);

/**
 * Ordinal substring predicates (fuaran-core#90). Null propagates (matching `comparison`); a
 * non-string operand is a typed error. JS string methods are code-unit-wise over UTF-16 —
 * exactly the reference evaluator's Ordinal pin.
 */
const stringPred = (op: string, a: Cell, b: Cell): DR<Cell> => {
  if (a.kind === 'Null' || b.kind === 'Null') return dok(NULL);
  if (a.kind === 'Str' && b.kind === 'Str') {
    const r =
      op === 'contains'
        ? a.value.includes(b.value)
        : op === 'startsWith'
          ? a.value.startsWith(b.value)
          : a.value.endsWith(b.value);
    return dok({ kind: 'Bool', value: r });
  }
  return derr(typeError('string predicate on a non-string operand'));
};

/**
 * Days since 1970-01-01 for the first 10 chars (`YYYY-MM-DD`) of a date-like cell —
 * days-from-civil as pure integer math (fuaran-core#90, `dateDiffDays`; the arithmetic is
 * `./civil.ts`). No host date library.
 */
const civilDays = (c: Cell): DR<number> => {
  if (c.kind === 'Date' || c.kind === 'Timestamp' || c.kind === 'Str') {
    const s = c.value;
    const bad = (): DR<number> =>
      derr(typeError("dateDiffDays: '" + s + "' is not YYYY-MM-DD[...]"));
    if (s.length < 10 || s[4] !== '-' || s[7] !== '-') return bad();
    const y0 = tryParseInt(s.substring(0, 4));
    const m0 = tryParseInt(s.substring(5, 7));
    const d0 = tryParseInt(s.substring(8, 10));
    if (y0 === undefined || m0 === undefined || d0 === undefined) return bad();
    return dok(daysFromCivil(y0, m0, d0));
  }
  return derr(typeError('dateDiffDays expects date/timestamp/string operands'));
};

/** Evaluate a `ColExpr` against one row. */
/** The evaluation environment (fuaran-core#77) — binds each `ColExpr.param` name to a `Cell`. */
export type EvalEnv = Readonly<Record<string, Cell>>;
const EMPTY_ENV: EvalEnv = {};

const evalExpr = (
  cols: readonly SchemaEntry[],
  row: RowRef,
  e: ColExpr,
  env: EvalEnv = EMPTY_ENV,
): DR<Cell> => {
  switch (e.kind) {
    case 'col': {
      const i = colIndex(cols, e.name);
      return i >= 0
        ? dok(cellAt(row.data[i]!, row.i))
        : derr(unknownColumn(e.name, available(cols)));
    }
    case 'lit':
      return dok(e.cell);
    case 'param': {
      // fuaran-core#77 — resolve a named param from the env; a miss is a strict `UnboundParam`.
      const c = Object.prototype.hasOwnProperty.call(env, e.name) ? env[e.name] : undefined;
      return c !== undefined ? dok(c) : derr(unboundParam(e.name, Object.keys(env).sort()));
    }
    case 'binary': {
      const a = evalExpr(cols, row, e.left, env);
      if (!a.ok) return a;
      const b = evalExpr(cols, row, e.right, env);
      if (!b.ok) return b;
      if (ARITH_OPS.has(e.op)) return arith(e.op, a.value, b.value);
      if (CMP_OPS.has(e.op)) return comparison(e.op, a.value, b.value);
      if (STR_OPS.has(e.op)) return stringPred(e.op, a.value, b.value);
      return logical(e.op, a.value, b.value);
    }
    case 'not': {
      const inner = evalExpr(cols, row, e.expr, env);
      if (!inner.ok) return inner;
      const c = inner.value;
      if (c.kind === 'Bool') return dok({ kind: 'Bool', value: !c.value });
      if (c.kind === 'Null') return dok(NULL);
      return derr(typeError('not of a non-bool'));
    }
    case 'coalesce': {
      for (const x of e.exprs) {
        const r = evalExpr(cols, row, x, env);
        if (!r.ok) return r;
        if (r.value.kind !== 'Null') return dok(r.value);
      }
      return dok(NULL);
    }
    case 'case': {
      for (const br of e.cases) {
        const w = evalExpr(cols, row, br.when, env);
        if (!w.ok) return w;
        if (w.value.kind === 'Bool' && w.value.value) return evalExpr(cols, row, br.then, env);
      }
      return evalExpr(cols, row, e.else, env);
    }
    case 'cast': {
      const inner = evalExpr(cols, row, e.expr, env);
      return inner.ok ? castCell(e.type, inner.value) : inner;
    }
    case 'apply': {
      const vals: Cell[] = [];
      for (const a of e.args) {
        const r = evalExpr(cols, row, a, env);
        if (!r.ok) return r;
        vals.push(r.value);
      }
      return applyScalar(e.fn, vals);
    }
    case 'in': {
      // fuaran-core#90 — SQL three-valued membership: null subject => null; any equal item =>
      // true; no match having seen a null item => null; else false.
      const sv = evalExpr(cols, row, e.expr, env);
      if (!sv.ok) return sv;
      if (sv.value.kind === 'Null') return dok(NULL);
      let sawNull = false;
      for (const it of e.items) {
        const iv = evalExpr(cols, row, it, env);
        if (!iv.ok) return iv;
        if (iv.value.kind === 'Null') {
          sawNull = true;
          continue;
        }
        const c = compareCells(sv.value, iv.value);
        if (c === undefined) return derr(typeError('in: comparison between incompatible types'));
        if (c === 0) return dok({ kind: 'Bool', value: true });
      }
      return sawNull ? dok(NULL) : dok({ kind: 'Bool', value: false });
    }
    case 'isNull': {
      // fuaran-core#90 — total: always Bool, never null.
      const inner = evalExpr(cols, row, e.expr, env);
      return inner.ok ? dok({ kind: 'Bool', value: inner.value.kind === 'Null' }) : inner;
    }
    case 'inParam':
      // fuaran-core#91 — list params resolve by substitution BEFORE evaluation; one that
      // reaches the evaluator is unbound (scalar-param strictness parity).
      return derr(unboundParam(e.param, Object.keys(env).sort()));
    case 'quotient': {
      // Evaluation order: the scale, the dividend, the divisor.
      const bad = scaleRefusal(e.rounding.scale);
      if (bad !== undefined) return derr(bad);
      const a = evalExpr(cols, row, e.dividend, env);
      if (!a.ok) return a;
      const b = evalExpr(cols, row, e.divisor, env);
      if (!b.ok) return b;
      return quotientCell(e.rounding.mode, e.rounding.scale, a.value, b.value);
    }
    case 'rounded': {
      const bad = scaleRefusal(e.rounding.scale);
      if (bad !== undefined) return derr(bad);
      const a = evalExpr(cols, row, e.expr, env);
      return a.ok ? roundedCell(e.rounding.mode, e.rounding.scale, a.value) : a;
    }
    case 'convert': {
      // Every step resolves a conversion against its schema before evaluation; one that reaches
      // here is resolved the same way, and a mismatch is raised when a row reaches it.
      const r = resolveUnitsIn('expression', cols, e);
      return r.ok ? evalExpr(cols, row, r.value.expr, env) : r;
    }
  }
};

// ─── type inference for derived/melted columns ───────────────────────────────

const cellTypeOf = (c: Cell): ColumnType | undefined => {
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
    // Phase 2206 — the unit the instant text's fraction spells.
    case 'Timestamp':
      return timestampTypeOfText(c.value);
    case 'Decimal':
      return 'decimal';
    case 'Null':
      return undefined;
  }
};

/** The widening lattice (`columnType.ts`): int into float or decimal, a coarser timestamp unit into a finer one. */
const widens = columnTypeWidens;

/** The least type two types both widen into, or `undefined` (a float beside a decimal included). */
const joinColumnType = (a: ColumnType, b: ColumnType): ColumnType | undefined =>
  widens(a, b) ? b : widens(b, a) ? a : undefined;

const floatBesideDecimal = (column: string): EvalError =>
  typeError(
    "derived column '" +
      column +
      "' joins a float and a decimal: cast one to the other's type first - Cast(decimal, ...) " +
      'to keep the digits exact, Cast(float, ...) to compute approximately',
  );

const typesBesideEachOther = (column: string, a: ColumnType, b: ColumnType): EvalError =>
  typeError(
    "derived column '" +
      column +
      "' holds a " +
      a +
      ' beside a ' +
      b +
      ", which no column type holds together: cast one to the other's type first",
  );

/**
 * The cells' half of the derived-column rule: the widening join of the present
 * cells' types in row order, `string` when none is present, and the named
 * refusals of a float beside a decimal or two types no widening relates.
 */
const typeFromCells = (column: string, cells: readonly Cell[]): DR<ColumnType> => {
  let acc: ColumnType | undefined;
  let sawFloat = false;
  let sawDecimal = false;
  let disjoint: [ColumnType, ColumnType] | undefined;
  for (const c of cells) {
    const t = cellTypeOf(c);
    if (t === undefined) continue;
    if (t === 'float') sawFloat = true;
    if (t === 'decimal') sawDecimal = true;
    if (acc === undefined) acc = t;
    else {
      const j = joinColumnType(acc, t);
      if (j === undefined) disjoint ??= [acc, t];
      else acc = j;
    }
  }
  if (sawFloat && sawDecimal) return derr(floatBesideDecimal(column));
  if (disjoint !== undefined) return derr(typesBesideEachOther(column, disjoint[0], disjoint[1]));
  return dok(acc ?? 'string');
};

// ─── the static typer and THE derived-column typing rule ─────────────────────
//
// What a node's PRESENT values can be, decided from a step's schema alone:
// `'absent'` (no present value is ever produced — every row answers null or an
// error), a decided `ColumnType`, or `'unknown'`. The join is EXACT, not the
// widening one: int beside float is unknown here (the cells then decide).
//
// The derived-column rule a `derive` and an `unpivot` read:
//  - a decided type IS the column's type on every frame — full, empty or
//    all-null alike; the cells are stored as produced (an int in a float or
//    decimal column), never converted;
//  - `'absent'` types the column `string`;
//  - `'unknown'` leaves it to the cells (the widening join, `string` when none);
//  - a float beside a decimal is refused by name — statically where the
//    expression's own arms carry both, and from the cells otherwise.

type Typing = ColumnType | 'absent' | 'unknown';

const tJoin = (a: Typing, b: Typing): Typing =>
  a === 'absent' ? b : b === 'absent' ? a : a === b ? a : 'unknown';

const tJoinAll = (ts: readonly Typing[]): Typing => ts.reduce<Typing>(tJoin, 'absent');

const isExact = (t: Typing): boolean => t === 'int' || t === 'decimal';
const isNumeric = (t: Typing): boolean => t === 'int' || t === 'float';
const isTimestamp = (t: Typing): boolean =>
  t !== 'absent' && t !== 'unknown' && timestampDigits(t) !== undefined;

const binaryTyping = (op: string, a: Typing, b: Typing): Typing => {
  const nullPropagating = (decide: () => Typing): Typing =>
    a === 'absent' || b === 'absent' ? 'absent' : decide();
  const decimalPair = isExact(a) && isExact(b) && (a === 'decimal' || b === 'decimal');
  switch (op) {
    case 'add':
    case 'sub':
    case 'mul':
      return nullPropagating(() =>
        a === 'int' && b === 'int'
          ? 'int'
          : isNumeric(a) && isNumeric(b)
            ? 'float'
            : decimalPair
              ? 'decimal'
              : 'unknown',
      );
    // A decimal `div` is refused on every row (it names `quotient`), so no present value.
    case 'div':
      return nullPropagating(() => (isNumeric(a) && isNumeric(b) ? 'float' : 'unknown'));
    case 'mod':
      return nullPropagating(() =>
        a === 'int' && b === 'int' ? 'int' : decimalPair ? 'decimal' : 'unknown',
      );
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
      return nullPropagating(() =>
        (isNumeric(a) && isNumeric(b)) ||
        (isExact(a) && isExact(b)) ||
        (a === b && (a === 'string' || a === 'date' || a === 'bool')) ||
        // Phase 2206 — timestamps compare across units, as the reference's typer reads them.
        (isTimestamp(a) && isTimestamp(b))
          ? 'bool'
          : 'unknown',
      );
    case 'and':
    case 'or': {
      const boolLike = (t: Typing): boolean => t === 'absent' || t === 'bool';
      return boolLike(a) && boolLike(b) ? tJoin(a, b) : 'unknown';
    }
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return nullPropagating(() => (a === 'string' && b === 'string' ? 'bool' : 'unknown'));
    default:
      return 'unknown';
  }
};

const applyTyping = (fn: string, args: readonly Typing[]): Typing => {
  const arity = (n: number): boolean => args.length === n;
  const anyAbsent = args.some((t) => t === 'absent');
  const unary = (decide: (t: Typing) => Typing): Typing => {
    if (!arity(1)) return 'absent';
    const t = args[0]!;
    return t === 'absent' ? 'absent' : decide(t);
  };
  switch (fn) {
    case 'abs':
      return unary((t) => (t === 'int' || t === 'float' || t === 'decimal' ? t : 'unknown'));
    // Over a decimal these answer a decimal; over an undecidable operand they cannot be decided.
    case 'round':
    case 'floor':
    case 'ceil':
      return unary((t) => (t === 'decimal' ? 'decimal' : t === 'unknown' ? 'unknown' : 'float'));
    case 'length':
      return unary(() => 'int');
    case 'lower':
    case 'upper':
    case 'trim':
      return unary(() => 'string');
    case 'substr':
      return !arity(3) || args[0] === 'absent' ? 'absent' : 'string';
    case 'datePart':
      return !arity(2) || args[1] === 'absent' ? 'absent' : 'int';
    case 'concat':
      return args.length === 0 || anyAbsent ? 'absent' : 'string';
    case 'replace':
      return !arity(3) || anyAbsent ? 'absent' : 'string';
    case 'dateDiffDays':
      return !arity(2) || anyAbsent ? 'absent' : 'int';
    case 'least':
    case 'greatest':
      return args.length === 0 || anyAbsent ? 'absent' : tJoinAll(args);
    // Phase 2400 (the reference's D43): the transcendentals answer a float, as a root does. A power
    // over an int base and an int exponent is decided by the exponent's SIGN, which a typing does
    // not carry — `powLitTyping` reads a literal exponent, and otherwise the cells decide; an
    // undecided operand may be that pair, so it is undecided too; every other pair is a float.
    case 'exp':
    case 'ln':
    case 'log10':
      return unary(() => 'float');
    case 'pow':
      if (!arity(2) || anyAbsent) return 'absent';
      if (args[0] === 'int' && args[1] === 'int') return 'unknown';
      return args.includes('unknown') ? 'unknown' : 'float';
    default:
      return 'unknown';
  }
};

/** A power under a LITERAL integer exponent: an int base is an int at or above zero, else a float. */
const powLitTyping = (n: number, b: Typing): Typing =>
  b === 'absent' || b === 'unknown' ? b : b === 'int' && n >= 0 ? 'int' : 'float';

/** The static typing of an expression over a schema, with no env (a param is unknown). */
const typing = (cols: readonly SchemaEntry[], e: ColExpr): Typing => {
  const go = (x: ColExpr): Typing => typing(cols, x);
  switch (e.kind) {
    case 'col':
      return colType(cols, e.name) ?? 'unknown';
    case 'lit':
      return cellTypeOf(e.cell) ?? 'absent';
    case 'param':
      return 'unknown';
    case 'binary':
      return binaryTyping(e.op, go(e.left), go(e.right));
    case 'not': {
      const t = go(e.expr);
      return t === 'absent' ? 'absent' : t === 'bool' ? 'bool' : 'unknown';
    }
    case 'coalesce':
      return tJoinAll(e.exprs.map(go));
    case 'case':
      return tJoinAll([go(e.else), ...e.cases.map((br) => go(br.then))]);
    case 'cast':
      return go(e.expr) === 'absent' ? 'absent' : e.type;
    case 'apply': {
      const [base, exponent] = e.args;
      if (
        e.fn === 'pow' &&
        e.args.length === 2 &&
        exponent!.kind === 'lit' &&
        exponent!.cell.kind === 'Int'
      )
        return powLitTyping(exponent!.cell.value, go(base!));
      return applyTyping(e.fn, e.args.map(go));
    }
    case 'in':
    case 'inParam':
      return go(e.expr) === 'absent' ? 'absent' : 'bool';
    case 'isNull':
      return 'bool';
    case 'quotient': {
      const a = go(e.dividend);
      const b = go(e.divisor);
      if (a === 'absent' || b === 'absent') return 'absent';
      return isExact(a) && isExact(b) ? 'decimal' : 'unknown';
    }
    case 'rounded': {
      const a = go(e.expr);
      return a === 'absent' ? 'absent' : isExact(a) ? 'decimal' : 'unknown';
    }
    // A conversion is typed as the float cast it resolves to.
    case 'convert':
      return go(e.expr) === 'absent' ? 'absent' : 'float';
  }
};

/** How a derived column is typed: decided by the schema, left to the cells, or refused. */
type DerivedTyping =
  | { readonly kind: 'decided'; readonly type: ColumnType }
  | { readonly kind: 'byCells' }
  | { readonly kind: 'refused' };

/** Does an arm the value is drawn from — through `case` and `coalesce` — carry the type `ty`? */
const armsHave = (ty: ColumnType, cols: readonly SchemaEntry[], e: ColExpr): boolean => {
  switch (e.kind) {
    case 'coalesce':
      return e.exprs.some((x) => armsHave(ty, cols, x));
    case 'case':
      return armsHave(ty, cols, e.else) || e.cases.some((br) => armsHave(ty, cols, br.then));
    default:
      return typing(cols, e) === ty;
  }
};

const derivedTyping = (cols: readonly SchemaEntry[], e: ColExpr): DerivedTyping => {
  if (armsHave('float', cols, e) && armsHave('decimal', cols, e)) return { kind: 'refused' };
  const t = typing(cols, e);
  if (t === 'absent') return { kind: 'decided', type: 'string' };
  if (t === 'unknown') return { kind: 'byCells' };
  return { kind: 'decided', type: t };
};

/** Replace every `param` bound in `env` by its literal — the expression the evaluator answers. */
const substituteParams = (env: EvalEnv, e: ColExpr): ColExpr => {
  const go = (x: ColExpr): ColExpr => substituteParams(env, x);
  switch (e.kind) {
    case 'col':
    case 'lit':
      return e;
    case 'param': {
      const c = Object.prototype.hasOwnProperty.call(env, e.name) ? env[e.name] : undefined;
      return c === undefined ? e : { kind: 'lit', cell: c };
    }
    case 'binary':
      return { kind: 'binary', op: e.op, left: go(e.left), right: go(e.right) };
    case 'not':
      return { kind: 'not', expr: go(e.expr) };
    case 'coalesce':
      return { kind: 'coalesce', exprs: e.exprs.map(go) };
    case 'case':
      return {
        kind: 'case',
        cases: e.cases.map((br) => ({ when: go(br.when), then: go(br.then) })),
        else: go(e.else),
      };
    case 'cast':
      return { kind: 'cast', type: e.type, expr: go(e.expr) };
    case 'apply':
      return { kind: 'apply', fn: e.fn, args: e.args.map(go) };
    case 'in':
      return { kind: 'in', expr: go(e.expr), items: e.items.map(go) };
    case 'isNull':
      return { kind: 'isNull', expr: go(e.expr) };
    case 'inParam':
      return { kind: 'inParam', expr: go(e.expr), param: e.param };
    case 'quotient':
      return {
        kind: 'quotient',
        dividend: go(e.dividend),
        divisor: go(e.divisor),
        rounding: e.rounding,
      };
    case 'rounded':
      return { kind: 'rounded', expr: go(e.expr), rounding: e.rounding };
    case 'convert':
      return { kind: 'convert', expr: go(e.expr), unit: e.unit };
  }
};

/**
 * How an EVALUATION of a derive types its column: the static rule wherever it
 * decides or refuses; where it leaves the column to the cells, the type the
 * same rule decides over the expression with the env's params substituted.
 */
const derivedTypingIn = (env: EvalEnv, cols: readonly SchemaEntry[], e: ColExpr): DerivedTyping => {
  const dt = derivedTyping(cols, e);
  if (dt.kind !== 'byCells') return dt;
  const sub = derivedTyping(cols, substituteParams(env, e));
  return sub.kind === 'decided' ? sub : dt;
};

/**
 * An unpivot's value column, typed by the same rule over the value columns'
 * DECLARED types (their widening join): no value column is `string`, a float
 * beside a decimal is refused, and a pair no widening relates is the cells'.
 */
const unpivotTyping = (types: readonly ColumnType[]): DerivedTyping => {
  if (types.includes('float') && types.includes('decimal')) return { kind: 'refused' };
  if (types.length === 0) return { kind: 'decided', type: 'string' };
  let acc: ColumnType | undefined = types[0]!;
  for (const t of types.slice(1)) {
    acc = acc === undefined ? undefined : joinColumnType(acc, t);
  }
  return acc === undefined ? { kind: 'byCells' } : { kind: 'decided', type: acc };
};

const columnTypeBy = (dt: DerivedTyping, column: string, cells: readonly Cell[]): DR<ColumnType> =>
  dt.kind === 'decided'
    ? dok(dt.type)
    : dt.kind === 'refused'
      ? derr(floatBesideDecimal(column))
      : typeFromCells(column, cells);

// ─── aggregates (pinned) ─────────────────────────────────────────────────────

/**
 * The present numbers of a column's rows `rows`, read straight from its typed vector (Phase 2205):
 * an int or a float column's values, in row order, with no cell boxed. Any other column holds no
 * number an aggregate reads.
 */
const presentNums = (col: DataColumn, rows: ArrayLike<number>): number[] => {
  const d = col.data;
  if (d.kind !== 'Ints' && d.kind !== 'Floats') return [];
  const nums: number[] = [];
  for (let k = 0; k < rows.length; k += 1) {
    const r = rows[k]!;
    if (isPresentAt(d, r)) nums.push(d.values[r]!);
  }
  return nums;
};

/** `mean` / `stddev` (population) / `median` over numbers already read as floats. */
const floatAgg = (fn: 'mean' | 'stddev' | 'median', nums: readonly number[]): Cell => {
  if (nums.length === 0) return NULL;
  const n = nums.length;
  if (fn === 'median') {
    const sorted = nums.slice().sort(compareFloat);
    const mid = Math.floor(n / 2);
    return {
      kind: 'Float',
      value: n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2,
    };
  }
  const mean = nums.reduce((a, x) => a + x, 0) / n;
  if (fn === 'mean') return { kind: 'Float', value: mean };
  const variance = nums.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
  return { kind: 'Float', value: Math.sqrt(variance) };
};

/**
 * Every aggregate over a DECIMAL column. The column is admitted first: a
 * present cell that is not decimal text (an int is its digits) is refused by
 * name, never truncated or dropped, and every value is read canonicalised.
 * `sum` is EXACT and a decimal; `min` / `max` compare exactly (`min` keeps the
 * first of equals, `max` the last); `mean` / `median` / `stddev` read each
 * value at its nearest double, and a value past the float range is refused.
 */
const aggDecimal = (fn: AggFn, cells: readonly Cell[]): DR<Cell> => {
  const texts: string[] = [];
  for (const c of cells) {
    if (c.kind === 'Null') continue;
    const t =
      c.kind === 'Decimal'
        ? decimalCanonical(c.value)
        : c.kind === 'Int'
          ? decimalText(c)
          : undefined;
    if (t === undefined)
      return derr({
        kind: 'AggError',
        detail: 'aggregate over a decimal column met a cell outside its type: ' + cellString(c),
      });
    texts.push(t);
  }
  const dec = (t: string): Cell => ({ kind: 'Decimal', value: t });
  switch (fn) {
    case 'count':
      return dok({ kind: 'Int', value: texts.length });
    case 'countDistinct':
      return dok({ kind: 'Int', value: new Set(texts).size });
    case 'first':
    case 'last': {
      // The first or the last ROW, a null included.
      const c = fn === 'first' ? cells[0] : cells[cells.length - 1];
      return dok(c === undefined || c.kind === 'Null' ? NULL : dec(decimalText(c)!));
    }
    case 'sum': {
      let total: string | undefined;
      for (const t of texts) total = total === undefined ? t : (decimalAdd(total, t) ?? total);
      return dok(total === undefined ? NULL : dec(total));
    }
    case 'min':
    case 'max': {
      let best: string | undefined;
      for (const t of texts) {
        if (best === undefined) best = t;
        else {
          const k = decimalCompare(best, t)!;
          if (fn === 'min' ? k > 0 : k <= 0) best = t;
        }
      }
      return dok(best === undefined ? NULL : dec(best));
    }
    case 'mean':
    case 'median':
    case 'stddev': {
      const nums: number[] = [];
      for (const t of texts) {
        const f = decimalToFloat(t);
        if (f === undefined)
          return derr({
            kind: 'AggError',
            detail: 'the decimal ' + t + ' is past the float range, and ' + fn + ' is a float',
          });
        nums.push(f);
      }
      return dok(floatAgg(fn, nums));
    }
  }
};

/**
 * One aggregate over a cell list of the given source type — the cells are held as a column of
 * that type first (a cell the type cannot hold is the aggregate's `AggError`), then folded as the
 * evaluator folds a column. Public so a host leg can fold an aggregate over cells it builds directly.
 */
export const aggregateCells = (
  fn: AggFn,
  srcType: ColumnType,
  cells: readonly Cell[],
): DR<Cell> => {
  const col = columnOfCells('aggregate', srcType, cells);
  return col.ok
    ? aggregateRows(fn, srcType, col.value, iota(cells.length))
    : derr({ kind: 'AggError', detail: col.error });
};

/**
 * One aggregate over the rows `rows` of a column of type `srcType` — the evaluator's adapter onto
 * the pinned aggregate semantics. `count`, `sum`, `mean`, `stddev` and `median` read the typed
 * vector directly; the others compare cells.
 */
const aggregateRows = (
  fn: AggFn,
  srcType: ColumnType,
  col: DataColumn,
  rows: ArrayLike<number>,
): DR<Cell> => {
  if (srcType === 'decimal')
    return aggDecimal(
      fn,
      Array.from(rows, (r) => cellAt(col, r)),
    );
  switch (fn) {
    case 'count': {
      let n = 0;
      for (let k = 0; k < rows.length; k += 1) if (isPresentAt(col.data, rows[k]!)) n += 1;
      return dok({ kind: 'Int', value: n });
    }
    case 'first':
      return dok(rows.length === 0 ? NULL : cellAt(col, rows[0]!));
    case 'last':
      return dok(rows.length === 0 ? NULL : cellAt(col, rows[rows.length - 1]!));
    case 'sum': {
      const nums = presentNums(col, rows);
      if (nums.length === 0) return dok(NULL);
      const total = nums.reduce((acc, x) => acc + x, 0);
      return dok(
        col.data.kind === 'Ints' ? { kind: 'Int', value: total } : { kind: 'Float', value: total },
      );
    }
    case 'mean':
    case 'stddev':
    case 'median':
      return dok(floatAgg(fn, presentNums(col, rows)));
    case 'countDistinct':
    case 'min':
    case 'max': {
      const present: Cell[] = [];
      for (let k = 0; k < rows.length; k += 1) {
        const c = cellAt(col, rows[k]!);
        if (!isNull(c)) present.push(c);
      }
      if (fn === 'countDistinct')
        return dok({ kind: 'Int', value: new Set(present.map(cellKey)).size });
      if (present.length === 0) return dok(NULL);
      let acc = present[0]!;
      for (let i = 1; i < present.length; i += 1) {
        const b = present[i]!;
        const c = compareCells(acc, b);
        if (c !== undefined) {
          // keep `acc` iff (fn=min) == (c<=0); else take b
          acc = (fn === 'min') === c <= 0 ? acc : b;
        }
        // c === undefined ⇒ keep acc (matches F# `None -> a`)
      }
      return dok(acc);
    }
  }
};

const aggType = (fn: AggFn, srcType: ColumnType): ColumnType => {
  switch (fn) {
    case 'count':
    case 'countDistinct':
      return 'int';
    case 'mean':
    case 'median':
    case 'stddev':
      return 'float';
    case 'sum':
    case 'min':
    case 'max':
    case 'first':
    case 'last':
      return srcType;
  }
};

// ─── the unit check (Phase 2208, the reference's Phase 429 / D29) ────────────
//
// A column's unit is a fact of its schema entry, so the check is a static walk over the step's
// schema before any row: an empty frame is checked exactly as a full one. The walk answers the
// expression's unit — `undefined` is UNCONSTRAINED: a literal, a param, a column that states no
// unit; it composes with anything, so a unitless pipeline passes and evaluates as it always did —
// and rewrites every `convert` to the cast (and factor) it stands for.

type MaybeUnit = UnitOfMeasure | undefined;

/** A canonical unit text, read back to the unit (it parsed when the entry was decoded). */
const unitOfText = (text: string): UnitOfMeasure => {
  const u = parseUnit(text);
  return u.ok ? u.value : DIMENSIONLESS;
};

/** The unit a schema states for a column, where it states one. */
const colUnit = (cols: readonly SchemaEntry[], name: string): MaybeUnit => {
  const u = cols.find((c) => c.name === name)?.unit;
  return u === undefined ? undefined : unitOfText(u);
};

/** An entry under a stated unit, or as it is. */
const stated = (u: MaybeUnit, entry: SchemaEntry): SchemaEntry =>
  u === undefined ? entry : { ...entry, unit: renderUnit(u) };

/** A compact text of an expression for a refusal — the reference's `exprText`. */
const exprText = (e: ColExpr): string => {
  const args = (xs: readonly ColExpr[]): string => xs.map(exprText).join(', ');
  switch (e.kind) {
    case 'col':
      return "'" + e.name + "'";
    case 'lit':
      return cellString(e.cell);
    case 'param':
      return '$' + e.name;
    case 'binary':
      return e.op.toLowerCase() + '(' + exprText(e.left) + ', ' + exprText(e.right) + ')';
    case 'not':
      return 'not(' + exprText(e.expr) + ')';
    case 'coalesce':
      return 'coalesce(' + args(e.exprs) + ')';
    case 'case':
      return (
        'case(' + args(e.cases.flatMap((c) => [c.when, c.then])) + ', ' + exprText(e.else) + ')'
      );
    case 'cast':
      return 'cast(' + e.type + ', ' + exprText(e.expr) + ')';
    case 'apply':
      return e.fn.toLowerCase() + '(' + args(e.args) + ')';
    case 'in':
      return 'in(' + exprText(e.expr) + '; ' + args(e.items) + ')';
    case 'isNull':
      return 'isNull(' + exprText(e.expr) + ')';
    case 'inParam':
      return 'in(' + exprText(e.expr) + '; $' + e.param + ')';
    case 'quotient':
      return 'quotient(' + exprText(e.dividend) + ', ' + exprText(e.divisor) + ')';
    case 'rounded':
      return 'rounded(' + exprText(e.expr) + ')';
    case 'convert':
      return 'convert(' + exprText(e.expr) + ', ' + e.unit + ')';
  }
};

const unitMismatch = (step: string, expr: ColExpr, left: string, right: string): EvalError => ({
  kind: 'UnitMismatch',
  step,
  expr,
  left,
  right,
});

/** What a power, product or quotient whose exponent would leave the algebra's range is refused against. */
const POWER_RANGE_TEXT = 'a power the algebra can carry';

/** The unit of a product: an unconstrained factor contributes nothing. */
const unitProduct = (step: string, at: ColExpr, a: MaybeUnit, b: MaybeUnit): DR<MaybeUnit> => {
  if (a === undefined) return dok(b);
  if (b === undefined) return dok(a);
  const p = mulUnit(a, b);
  return p === undefined ? derr(unitMismatch(step, at, renderUnit(a), POWER_RANGE_TEXT)) : dok(p);
};

/**
 * The unit of a quotient: an unconstrained dividend is dimensionless over a stated divisor (`1 / s`
 * is `/s`), an unconstrained divisor leaves the dividend's unit.
 */
const unitQuotient = (step: string, at: ColExpr, a: MaybeUnit, b: MaybeUnit): DR<MaybeUnit> => {
  if (b === undefined) return dok(a);
  const dividend = a ?? DIMENSIONLESS;
  const q = divUnit(dividend, b);
  return q === undefined
    ? derr(unitMismatch(step, at, renderUnit(dividend), POWER_RANGE_TEXT))
    : dok(q);
};

/** The first operand stating a unit other than the dimensionless one. */
const firstDimensioned = (units: readonly MaybeUnit[]): MaybeUnit =>
  units.find((u) => u !== undefined && !sameUnit(u, DIMENSIONLESS));

interface UnitResolved {
  readonly unit: MaybeUnit;
  readonly expr: ColExpr;
}

/**
 * The unit of `e` over `cols`, and `e` with every `convert` resolved — the reference's
 * `resolveUnitsIn`. `step` names the step a refusal is about. Addition, subtraction, comparison,
 * `coalesce`, `case` arms, `least` / `greatest` and `in` require ONE unit among the operands that
 * state one, and the answer carries it; multiplication, division, `quotient` and `mod` compose
 * through the algebra; `cast`, `abs`, `round`, `floor`, `ceil` and `rounded` keep their operand's
 * unit; a boolean, a text and a date carry none; a literal and a param are unconstrained.
 */
const resolveUnitsIn = (
  step: string,
  cols: readonly SchemaEntry[],
  e: ColExpr,
): DR<UnitResolved> => {
  const go = (x: ColExpr): DR<UnitResolved> => resolveUnitsIn(step, cols, x);
  const res = (unit: MaybeUnit, expr: ColExpr): DR<UnitResolved> => dok({ unit, expr });
  const mismatch = (l: UnitOfMeasure, r: UnitOfMeasure): DR<never> =>
    derr(unitMismatch(step, e, renderUnit(l), renderUnit(r)));
  // One unit among the stated ones: an unconstrained operand takes the other's.
  const agreeAll = (acc: MaybeUnit, units: readonly MaybeUnit[]): DR<MaybeUnit> => {
    let u = acc;
    for (const x of units) {
      if (x === undefined) continue;
      if (u === undefined) u = x;
      else if (!sameUnit(u, x)) return mismatch(u, x);
    }
    return dok(u);
  };
  const many = (xs: readonly ColExpr[]): DR<UnitResolved[]> => {
    const out: UnitResolved[] = [];
    for (const x of xs) {
      const r = go(x);
      if (!r.ok) return r;
      out.push(r.value);
    }
    return dok(out);
  };
  switch (e.kind) {
    case 'col':
      return res(colUnit(cols, e.name), e);
    case 'lit':
    case 'param':
      return res(undefined, e);
    case 'binary': {
      const a = go(e.left);
      if (!a.ok) return a;
      const b = go(e.right);
      if (!b.ok) return b;
      const e2: ColExpr = { kind: 'binary', op: e.op, left: a.value.expr, right: b.value.expr };
      const ua = a.value.unit;
      const ub = b.value.unit;
      switch (e.op) {
        case 'add':
        case 'sub': {
          const u = agreeAll(ua, [ub]);
          return u.ok ? res(u.value, e2) : u;
        }
        case 'mul': {
          const u = unitProduct(step, e, ua, ub);
          return u.ok ? res(u.value, e2) : u;
        }
        case 'div': {
          const u = unitQuotient(step, e, ua, ub);
          return u.ok ? res(u.value, e2) : u;
        }
        case 'mod':
          return res(ua, e2);
        case 'eq':
        case 'ne':
        case 'lt':
        case 'le':
        case 'gt':
        case 'ge': {
          const u = agreeAll(ua, [ub]);
          return u.ok ? res(undefined, e2) : u;
        }
        default:
          return res(undefined, e2);
      }
    }
    case 'not': {
      const x = go(e.expr);
      return x.ok ? res(undefined, { kind: 'not', expr: x.value.expr }) : x;
    }
    case 'isNull': {
      const x = go(e.expr);
      return x.ok ? res(undefined, { kind: 'isNull', expr: x.value.expr }) : x;
    }
    case 'inParam': {
      const x = go(e.expr);
      return x.ok ? res(undefined, { kind: 'inParam', expr: x.value.expr, param: e.param }) : x;
    }
    case 'coalesce': {
      const rs = many(e.exprs);
      if (!rs.ok) return rs;
      const u = agreeAll(
        undefined,
        rs.value.map((r) => r.unit),
      );
      return u.ok ? res(u.value, { kind: 'coalesce', exprs: rs.value.map((r) => r.expr) }) : u;
    }
    case 'case': {
      const whens = many(e.cases.map((c) => c.when));
      if (!whens.ok) return whens;
      const thens = many(e.cases.map((c) => c.then));
      if (!thens.ok) return thens;
      const els = go(e.else);
      if (!els.ok) return els;
      const u = agreeAll(
        els.value.unit,
        thens.value.map((r) => r.unit),
      );
      if (!u.ok) return u;
      return res(u.value, {
        kind: 'case',
        cases: e.cases.map((_, i) => ({ when: whens.value[i]!.expr, then: thens.value[i]!.expr })),
        else: els.value.expr,
      });
    }
    case 'cast': {
      const x = go(e.expr);
      return x.ok ? res(x.value.unit, { kind: 'cast', type: e.type, expr: x.value.expr }) : x;
    }
    case 'apply': {
      const rs = many(e.args);
      if (!rs.ok) return rs;
      const units = rs.value.map((r) => r.unit);
      const e2: ColExpr = { kind: 'apply', fn: e.fn, args: rs.value.map((r) => r.expr) };
      switch (e.fn) {
        case 'abs':
        case 'round':
        case 'floor':
        case 'ceil':
          return res(units[0], e2);
        case 'least':
        case 'greatest': {
          const u = agreeAll(undefined, units);
          return u.ok ? res(u.value, e2) : u;
        }
        case 'pow': {
          // An integer-LITERAL exponent composes the unit through the algebra (`m` squared is
          // `m2`; to the power zero, unconstrained); any other power takes a dimensionless operand.
          const exponent = e.args[1];
          if (e.args.length === 2 && exponent?.kind === 'lit' && exponent.cell.kind === 'Int') {
            const ub = units[0];
            if (ub === undefined || exponent.cell.value === 0) return res(undefined, e2);
            const p = powUnit(ub, exponent.cell.value);
            return p === undefined
              ? derr(unitMismatch(step, e, renderUnit(ub), POWER_RANGE_TEXT))
              : res(p, e2);
          }
          const u = firstDimensioned(units);
          return u === undefined ? res(undefined, e2) : mismatch(u, DIMENSIONLESS);
        }
        case 'exp':
        case 'ln':
        case 'log10': {
          const u = firstDimensioned(units);
          return u === undefined ? res(undefined, e2) : mismatch(u, DIMENSIONLESS);
        }
        default:
          return res(undefined, e2);
      }
    }
    case 'in': {
      const x = go(e.expr);
      if (!x.ok) return x;
      const rs = many(e.items);
      if (!rs.ok) return rs;
      const u = agreeAll(
        x.value.unit,
        rs.value.map((r) => r.unit),
      );
      return u.ok
        ? res(undefined, { kind: 'in', expr: x.value.expr, items: rs.value.map((r) => r.expr) })
        : u;
    }
    case 'quotient': {
      const a = go(e.dividend);
      if (!a.ok) return a;
      const b = go(e.divisor);
      if (!b.ok) return b;
      const u = unitQuotient(step, e, a.value.unit, b.value.unit);
      return u.ok
        ? res(u.value, {
            kind: 'quotient',
            dividend: a.value.expr,
            divisor: b.value.expr,
            rounding: e.rounding,
          })
        : u;
    }
    case 'rounded': {
      const x = go(e.expr);
      return x.ok
        ? res(x.value.unit, { kind: 'rounded', expr: x.value.expr, rounding: e.rounding })
        : x;
    }
    case 'convert': {
      // Over an operand stating no unit, a TAG: the operand as a float under `unit`. Over one of a
      // compatible unit, the float times the exact factor, as a float literal. Otherwise refused.
      const x = go(e.expr);
      if (!x.ok) return x;
      const target = unitOfText(e.unit);
      const asFloat: ColExpr = { kind: 'cast', type: 'float', expr: x.value.expr };
      const source = x.value.unit;
      if (source === undefined || sameUnit(source, target)) return res(target, asFloat);
      const ratio = conversionFactor(source, target);
      if (ratio === undefined) return mismatch(source, target);
      return res(target, {
        kind: 'binary',
        op: 'mul',
        left: asFloat,
        right: { kind: 'lit', cell: { kind: 'Float', value: ratioToFloat(ratio) } },
      });
    }
  }
};

/** The unit an aggregate's column carries: a count is dimensionless, every other keeps its source's. */
const aggregateUnitOf = (fn: AggFn, source: MaybeUnit): MaybeUnit =>
  fn === 'count' || fn === 'countDistinct' ? undefined : source;

/** The unit a window column carries: the ranking family none, the shifting and running families their source's. */
const windowUnitOf = (fn: WindowSpecLike['fn'], source: MaybeUnit): MaybeUnit =>
  fn === 'rowNumber' || fn === 'rank' ? undefined : source;

/** An unpivot's `value` unit: the one unit every value column states, none where they differ or any states none. */
const sharedUnit = (cols: readonly SchemaEntry[], valueVars: readonly string[]): MaybeUnit => {
  const units = valueVars.map((n) => colUnit(cols, n));
  const first = units[0];
  return first !== undefined && units.every((u) => u !== undefined && sameUnit(u, first))
    ? first
    : undefined;
};

/** Two columns met as one (a union's pair, a set op's pair): the left entry under the one unit the pair states. */
const unitsAgree = (what: string, left: SchemaEntry, right: SchemaEntry): DR<SchemaEntry> => {
  if (left.unit !== undefined && right.unit !== undefined && left.unit !== right.unit)
    return derr(
      unitMismatch(
        what + " '" + left.name + "'",
        { kind: 'col', name: left.name },
        left.unit,
        right.unit,
      ),
    );
  return dok(
    left.unit === undefined && right.unit !== undefined ? { ...left, unit: right.unit } : left,
  );
};

/** A fresh entry: a verb's own column states its name and type, and no metadata it did not derive. */
const fresh = (name: string, type: ColumnType): SchemaEntry => ({ name, type });

// ─── sort (pinned: stable; nulls last regardless of direction) ───────────────

/** A frame's sort keys resolved once: each key's column index and direction; a key naming no column is skipped. */
const resolveSortKeys = (
  cols: readonly SchemaEntry[],
  by: readonly SortKey[],
): { readonly idxs: number[]; readonly dirs: SortKey['dir'][] } => {
  const idxs: number[] = [];
  const dirs: SortKey['dir'][] = [];
  for (const { col, dir } of by) {
    const i = colIndex(cols, col);
    if (i < 0) continue;
    idxs.push(i);
    dirs.push(dir);
  }
  return { idxs, dirs };
};

/** Compare two rows' sort-key cells (`resolveSortKeys` order). */
const keyCompare = (
  dirs: readonly SortKey['dir'][],
  k1: readonly Cell[],
  k2: readonly Cell[],
): number => {
  for (let j = 0; j < dirs.length; j += 1) {
    const a = k1[j]!;
    const b = k2[j]!;
    const an = isNull(a);
    const bn = isNull(b);
    let c: number;
    if (an && bn) c = 0;
    else if (an && !bn)
      c = 1; // null sorts last
    else if (!an && bn) c = -1;
    else {
      const cc = compareCells(a, b);
      c = cc === undefined ? 0 : dirs[j] === 'asc' ? cc : -cc;
    }
    if (c !== 0) return c;
  }
  return 0;
};

// A stable sort over an immutable rows array (Array.prototype.sort is stable).
const stableSort = <T>(xs: readonly T[], cmp: (a: T, b: T) => number): T[] => xs.slice().sort(cmp);

// ─── grouping keys (structural, type-aware) ──────────────────────────────────

const cellKey = (c: Cell): string => {
  switch (c.kind) {
    case 'Null':
      return 'N';
    case 'Int':
      return 'I' + String(c.value);
    case 'Float':
      return 'F' + String(c.value);
    case 'Bool':
      return 'B' + (c.value ? '1' : '0');
    case 'Str':
      return 'S' + c.value;
    case 'Date':
      return 'D' + c.value;
    case 'Timestamp':
      return 'T' + c.value;
    case 'Decimal':
      // The CANONICAL text under its own tag: `1.50` and `1.5` are one value, and a decimal never
      // shares a key with an int or a float of the same value.
      return 'M' + (decimalCanonical(c.value) ?? c.value);
  }
};

const rowKey = (cells: readonly Cell[]): string => cells.map(cellKey).join('');

// ─── per-verb evaluation ─────────────────────────────────────────────────────

const evalFilter = (f: Frame, predicate: ColExpr, env: EvalEnv = EMPTY_ENV): DR<Frame> => {
  // The predicate's units are checked over the schema before any row, then the resolved predicate
  // is evaluated.
  const checked = resolveUnitsIn('filter', f.cols, predicate);
  if (!checked.ok) return checked;
  const pred = checked.value.expr;
  const keep: number[] = [];
  for (let i = 0; i < f.n; i += 1) {
    const r = evalExpr(f.cols, { data: f.data, i }, pred, env);
    if (!r.ok) return r;
    if (r.value.kind === 'Bool' && r.value.value) keep.push(i);
  }
  return dok(keep.length === f.n ? f : selectRows(f, keep));
};

/**
 * Each output column's name beside what produced it, in output order: the first name an earlier
 * output already took is refused — a table cannot hold two columns of one name (the reference's D35,
 * Phase 468: project, groupBy, unpivot and pivot ask this one check, after every name the verb
 * resolves and before any row is read).
 */
const repeatedOutput = (
  verb: string,
  outs: readonly (readonly [string, string])[],
): DR<undefined> => {
  const seen = new Map<string, string>();
  for (const [name, by] of outs) {
    const first = seen.get(name);
    if (first !== undefined)
      return derr(
        typeError(
          verb +
            " output '" +
            name +
            "' is named twice, by " +
            first +
            ' and by ' +
            by +
            '; give each output a name of its own',
        ),
      );
    seen.set(name, by);
  }
  return dok(undefined);
};

const evalProject = (f: Frame, pairs: readonly { a: string; b: string }[]): DR<Frame> => {
  const resolved: { out: string; index: number }[] = [];
  for (const { a, b } of pairs) {
    const i = colIndex(f.cols, a);
    if (i < 0) return derr(unknownColumn(a, available(f.cols)));
    resolved.push({ out: b, index: i });
  }
  const repeat = repeatedOutput(
    'project',
    pairs.map(({ a, b }) => [b, "the projection of '" + a + "'"] as const),
  );
  if (!repeat.ok) return repeat;
  return dok({
    // A projection renames a column and states nothing new about it: every metadatum is kept.
    cols: resolved.map((r) => ({ ...f.cols[r.index]!, name: r.out })),
    data: resolved.map((r) => renamed(f.data[r.index]!, r.out)),
    n: f.n,
  });
};

const evalDerive = (
  f: Frame,
  name: string,
  written: ColExpr,
  env: EvalEnv = EMPTY_ENV,
): DR<Frame> => {
  // The column's unit and typing are read off the schema before any row: a derive refused
  // statically is refused on every frame, an empty one included, and a decided one carries its
  // type, and its unit, whatever rows the frame holds.
  const checked = resolveUnitsIn("derive '" + name + "'", f.cols, written);
  if (!checked.ok) return checked;
  const { unit, expr } = checked.value;
  const dt = derivedTypingIn(env, f.cols, expr);
  if (dt.kind === 'refused') return derr(floatBesideDecimal(name));
  const newCells: Cell[] = [];
  for (let i = 0; i < f.n; i += 1) {
    const r = evalExpr(f.cols, { data: f.data, i }, expr, env);
    if (!r.ok) return r;
    newCells.push(r.value);
  }
  const typed = columnTypeBy(dt, name, newCells);
  if (!typed.ok) return typed;
  const ty = typed.value;
  const col = colOf(name, ty, newCells);
  if (!col.ok) return col;
  const entry = stated(unit, fresh(name, ty));
  const i = colIndex(f.cols, name);
  if (i >= 0) {
    return dok({
      cols: f.cols.map((e, j) => (j === i ? entry : e)),
      data: f.data.map((c, j) => (j === i ? col.value : c)),
      n: f.n,
    });
  }
  return dok({ cols: [...f.cols, entry], data: [...f.data, col.value], n: f.n });
};

/** The frame's rows grouped by the cells at `idxs`: each group's row indices, in first-appearance order. */
const groupRows = (f: Frame, idxs: readonly number[]): number[][] => {
  const groups = new Map<string, number[]>();
  const order: number[][] = [];
  for (let i = 0; i < f.n; i += 1) {
    const ks = rowKey(cellsAt(f.data, idxs, i));
    const g = groups.get(ks);
    if (g === undefined) {
      const fresh = [i];
      groups.set(ks, fresh);
      order.push(fresh);
    } else g.push(i);
  }
  return order;
};

const evalGroupBy = (f: Frame, keys: readonly string[], aggs: readonly Agg[]): DR<Frame> => {
  for (const k of keys) {
    if (colIndex(f.cols, k) < 0) return derr(unknownColumn(k, available(f.cols)));
  }
  const idxs = keys.map((k) => colIndex(f.cols, k));
  const groups = groupRows(f, idxs);

  const resolvedAggs: { agg: Agg; type: ColumnType; index: number }[] = [];
  for (const a of aggs) {
    const ty = colType(f.cols, a.of);
    if (ty === undefined) return derr(unknownColumn(a.of, available(f.cols)));
    resolvedAggs.push({ agg: a, type: ty, index: colIndex(f.cols, a.of) });
  }
  const repeat = repeatedOutput('groupBy', [
    ...keys.map((k) => [k, "the key '" + k + "'"] as const),
    ...aggs.map((a) => [a.name, "the aggregate over '" + a.of + "'"] as const),
  ]);
  if (!repeat.ok) return repeat;

  // A key keeps its entry; an aggregate's column keeps its source's unit, a count none.
  const keyCols: SchemaEntry[] = idxs.map((ci) => f.cols[ci]!);
  const aggCols: SchemaEntry[] = resolvedAggs.map((r) =>
    stated(
      aggregateUnitOf(r.agg.fn, colUnit(f.cols, r.agg.of)),
      fresh(r.agg.name, aggType(r.agg.fn, r.type)),
    ),
  );

  // A group's key is its first row's, so the key columns are one gather of those rows.
  const firsts = groups.map((g) => g[0]!);
  const data: DataColumn[] = idxs.map((ci, k) => takeRows(f.data[ci]!, firsts, keys[k]!));
  for (let a = 0; a < resolvedAggs.length; a += 1) {
    const r = resolvedAggs[a]!;
    const out: Cell[] = [];
    for (const g of groups) {
      const v = aggregateRows(r.agg.fn, r.type, f.data[r.index]!, g);
      if (!v.ok) return v;
      out.push(v.value);
    }
    const c = colOf(aggCols[a]!.name, aggCols[a]!.type, out);
    if (!c.ok) return c;
    data.push(c.value);
  }

  return dok({ cols: [...keyCols, ...aggCols], data, n: groups.length });
};

/** The row indices `rows` stably ordered by the sort keys `by` (nulls last regardless of direction). */
const sortedRows = (f: Frame, rows: readonly number[], by: readonly SortKey[]): number[] => {
  const { idxs, dirs } = resolveSortKeys(f.cols, by);
  if (idxs.length === 0) return rows.slice();
  const keys = new Map<number, Cell[]>();
  for (const r of rows) keys.set(r, cellsAt(f.data, idxs, r));
  return stableSort(rows, (a, b) => keyCompare(dirs, keys.get(a)!, keys.get(b)!));
};

const evalSort = (f: Frame, by: readonly SortKey[]): Frame =>
  selectRows(f, sortedRows(f, Array.from(iota(f.n)), by));

const evalDistinct = (f: Frame): Frame => {
  const seen = new Set<string>();
  const keep: number[] = [];
  for (let i = 0; i < f.n; i += 1) {
    const k = rowKey(rowCells(f, i));
    if (!seen.has(k)) {
      seen.add(k);
      keep.push(i);
    }
  }
  return keep.length === f.n ? f : selectRows(f, keep);
};

const evalLimit = (f: Frame, n: number, offset: number): Frame => {
  const start = Math.min(Math.max(0, offset), f.n);
  const end = Math.min(f.n, start + Math.max(0, n));
  const keep = new Int32Array(end - start);
  for (let k = 0; k < keep.length; k += 1) keep[k] = start + k;
  return selectRows(f, keep);
};

const evalJoin = (
  f: Frame,
  right: Frame,
  on: readonly { a: string; b: string }[],
  how: string,
): DR<Frame> => {
  const li: number[] = [];
  const ri: number[] = [];
  for (const { a, b } of on) {
    const il = colIndex(f.cols, a);
    if (il < 0) return derr(unknownColumn(a, [...available(f.cols), ...available(right.cols)]));
    const ir = colIndex(right.cols, b);
    if (ir < 0) return derr(unknownColumn(b, [...available(f.cols), ...available(right.cols)]));
    li.push(il);
    ri.push(ir);
  }
  // A key pair is an equality, so the comparison's rule holds it: two stated units must be one.
  for (const { a, b } of on) {
    const lu = colUnit(f.cols, a);
    const ru = colUnit(right.cols, b);
    if (lu !== undefined && ru !== undefined && !sameUnit(lu, ru))
      return derr(
        unitMismatch(
          "join key '" + a + "' = '" + b + "'",
          {
            kind: 'binary',
            op: 'eq',
            left: { kind: 'col', name: a },
            right: { kind: 'col', name: b },
          },
          renderUnit(lu),
          renderUnit(ru),
        ),
      );
  }
  const leftKeys = Array.from({ length: f.n }, (_, i) => cellsAt(f.data, li, i));
  const rightKeys = Array.from({ length: right.n }, (_, i) => cellsAt(right.data, ri, i));
  const keyMatch = (lk: readonly Cell[], rk: readonly Cell[]): boolean =>
    lk.every((c, k) => cellEq(c, rk[k]!));

  const leftNames = new Set(available(f.cols));
  const rightCols: SchemaEntry[] = right.cols.map((e) => ({
    ...e,
    name: leftNames.has(e.name) ? e.name + '_right' : e.name,
  }));

  // The output is two gathers: the left row and the right row each output row reads, `-1` on
  // the side a non-matching row pads with nulls.
  const lrows: number[] = [];
  const rrows: number[] = [];
  for (let l = 0; l < f.n; l += 1) {
    let matched = false;
    for (let r = 0; r < right.n; r += 1) {
      if (!keyMatch(leftKeys[l]!, rightKeys[r]!)) continue;
      matched = true;
      lrows.push(l);
      rrows.push(r);
    }
    // inner / right with no match: emit nothing
    if (!matched && (how === 'left' || how === 'outer')) {
      lrows.push(l);
      rrows.push(-1);
    }
  }
  if (how === 'right' || how === 'outer') {
    for (let r = 0; r < right.n; r += 1) {
      if (!leftKeys.some((lk) => keyMatch(lk, rightKeys[r]!))) {
        lrows.push(-1);
        rrows.push(r);
      }
    }
  }

  return dok({
    cols: [...f.cols, ...rightCols],
    data: [
      ...f.data.map((c) => takeRows(c, lrows)),
      ...right.data.map((c, k) => takeRows(c, rrows, rightCols[k]!.name)),
    ],
    n: lrows.length,
  });
};

/**
 * `union` appends the other frame's rows. Each column is held at the JOIN of its two sides' types
 * (an int column over a float one is a float column) — the reference's rule (fuaran-core#423),
 * which a typed column needs: a pair no column type holds together is refused by name.
 */
const evalUnion = (f: Frame, other: Frame): DR<Frame> => {
  const an = available(f.cols);
  const bn = available(other.cols);
  if (an.length !== bn.length || an.some((n, i) => n !== bn[i])) {
    return derr({ kind: 'JoinError', detail: 'union requires matching column names' });
  }
  const cols: SchemaEntry[] = [];
  const data: DataColumn[] = [];
  for (let ci = 0; ci < f.cols.length; ci += 1) {
    const r = other.cols[ci]!;
    // The unit is the left's, the right's where only the right states one; two are refused.
    const agreed = unitsAgree('union column', f.cols[ci]!, r);
    if (!agreed.ok) return agreed;
    const l = agreed.value;
    const ty = joinColumnType(l.type, r.type);
    if (ty === undefined) return derr(typesBesideEachOther(l.name, l.type, r.type));
    const c = colOf(l.name, ty, [...columnCells(f.data[ci]!), ...columnCells(other.data[ci]!)]);
    if (!c.ok) return c;
    cols.push({ ...l, type: ty });
    data.push(c.value);
  }
  return dok({ cols, data, n: f.n + other.n });
};

/**
 * `intersect` / `except` — the multiset set-ops, keyed on the SAME row key
 * `distinct` dedups on, so a null matches a null and an int never matches a
 * float. `keepPresent` selects intersect from except; the left's order and
 * duplicate multiplicity survive.
 */
const evalSetOp = (verb: string, keepPresent: boolean, f: Frame, other: Frame): DR<Frame> => {
  const an = available(f.cols);
  const bn = available(other.cols);
  if (an.length !== bn.length || an.some((n, i) => n !== bn[i])) {
    return derr({ kind: 'JoinError', detail: verb + ' requires matching column names' });
  }
  // Row identity across two units is the comparison's error; the left schema is what is kept.
  for (let ci = 0; ci < f.cols.length; ci += 1) {
    const agreed = unitsAgree(verb + ' column', f.cols[ci]!, other.cols[ci]!);
    if (!agreed.ok) return agreed;
  }
  const present = new Set<string>();
  for (let i = 0; i < other.n; i += 1) present.add(rowKey(rowCells(other, i)));
  const keep: number[] = [];
  for (let i = 0; i < f.n; i += 1) {
    if (present.has(rowKey(rowCells(f, i))) === keepPresent) keep.push(i);
  }
  return dok(selectRows(f, keep));
};

const evalWindow = (f: Frame, spec: WindowSpecLike): DR<Frame> => {
  const ofIdx = colIndex(f.cols, spec.of);
  if (ofIdx < 0 && spec.fn !== 'rowNumber' && spec.fn !== 'rank') {
    return derr(unknownColumn(spec.of, available(f.cols)));
  }
  const partIdx = spec.partitionBy.map((p) => colIndex(f.cols, p)).filter((i) => i >= 0);

  // partition (first-appearance order), each partition its rows' indices
  const partitions = groupRows(f, partIdx);
  const { idxs: orderIdxs, dirs: orderDirs } = resolveSortKeys(f.cols, spec.orderBy);

  const valueAt = (r: number): Cell => (ofIdx >= 0 ? cellAt(f.data[ofIdx]!, r) : NULL);
  const sourceIsDecimal = colType(f.cols, spec.of) === 'decimal';

  const outCells = new Array<Cell>(f.n);
  for (const members of partitions) {
    const ordered = sortedRows(f, members, spec.orderBy);
    const vals = ordered.map(valueAt);
    let outs: Cell[];
    switch (spec.fn) {
      case 'rowNumber':
        outs = ordered.map((_, i) => ({ kind: 'Int', value: i + 1 }));
        break;
      case 'rank': {
        // ties (equal order keys) share a rank; running sum of step (0/1)
        const keys = ordered.map((r) => cellsAt(f.data, orderIdxs, r));
        let acc = 0;
        outs = keys.map((k, i) => {
          acc += i === 0 || keyCompare(orderDirs, keys[i - 1]!, k) !== 0 ? 1 : 0;
          return { kind: 'Int', value: acc };
        });
        break;
      }
      case 'lag':
        outs = [NULL, ...vals.slice(0, Math.max(0, vals.length - 1))];
        break;
      case 'lead':
        outs = [...vals.slice(Math.min(1, vals.length)), NULL];
        break;
      case 'cumulSum': {
        if (sourceIsDecimal) {
          // Over a decimal column the running total is EXACT and a decimal, as `sum` over one is.
          let dacc = '0';
          outs = vals.map((v) => {
            const x = decimalText(v);
            if (x !== undefined) dacc = decimalAdd(dacc, x) ?? dacc;
            return { kind: 'Decimal', value: dacc };
          });
          break;
        }
        let acc = 0;
        outs = vals.map((v) => {
          const n = asNum(v);
          if (n !== undefined) acc += n;
          return { kind: 'Float', value: acc };
        });
        break;
      }
      case 'rollingMean':
        outs = vals.map((_, i) => {
          const lo = Math.max(0, i - 2);
          const window = vals.slice(lo, i + 1);
          // A decimal is read at its nearest double: the mean is a float by declaration.
          const nums = window
            .map((c) => (c.kind === 'Decimal' ? decimalToFloat(c.value) : asNum(c)))
            .filter((n): n is number => n !== undefined);
          return nums.length === 0
            ? NULL
            : { kind: 'Float', value: nums.reduce((a, x) => a + x, 0) / nums.length };
        });
        break;
    }
    ordered.forEach((r, i) => {
      outCells[r] = outs[i]!;
    });
  }

  let ty: ColumnType;
  switch (spec.fn) {
    case 'rowNumber':
    case 'rank':
      ty = 'int';
      break;
    case 'cumulSum':
      ty = sourceIsDecimal ? 'decimal' : 'float';
      break;
    case 'rollingMean':
      ty = 'float';
      break;
    case 'lag':
    case 'lead':
      ty = colType(f.cols, spec.of) ?? 'string';
      break;
    default:
      ty = 'string';
  }

  const col = colOf(spec.as, ty, outCells);
  if (!col.ok) return col;
  return dok({
    cols: [...f.cols, stated(windowUnitOf(spec.fn, colUnit(f.cols, spec.of)), fresh(spec.as, ty))],
    data: [...f.data, col.value],
    n: f.n,
  });
};

const evalPivot = (f: Frame, spec: PivotSpecLike): DR<Frame> => {
  const need = (name: string): number | undefined => {
    const i = colIndex(f.cols, name);
    return i >= 0 ? i : undefined;
  };
  const idxIdx: number[] = [];
  for (const n of spec.index) {
    const i = need(n);
    if (i === undefined) return derr(unknownColumn(n, available(f.cols)));
    idxIdx.push(i);
  }
  const onIdx = need(spec.on);
  if (onIdx === undefined) return derr(unknownColumn(spec.on, available(f.cols)));
  const valIdx = need(spec.values);
  if (valIdx === undefined) return derr(unknownColumn(spec.values, available(f.cols)));
  const valType = f.cols[valIdx]!.type;
  const onCol = f.data[onIdx]!;

  // distinct on-values (sorted by canonical string for a deterministic column order)
  const onSeen = new Set<string>();
  const onValues: Cell[] = [];
  for (let i = 0; i < f.n; i += 1) {
    const c = cellAt(onCol, i);
    if (isNull(c)) continue;
    const k = cellKey(c);
    if (!onSeen.has(k)) {
      onSeen.add(k);
      onValues.push(c);
    }
  }
  onValues.sort((a, b) => {
    const sa = cellString(a);
    const sb = cellString(b);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
  const repeat = repeatedOutput('pivot', [
    ...spec.index.map((n) => [n, "the index column '" + n + "'"] as const),
    ...onValues.map((ov) => {
      const t = cellString(ov);
      return [t, "the column for the on value '" + t + "'"] as const;
    }),
  ]);
  if (!repeat.ok) return repeat;

  // index groups, first-appearance order
  const groups = groupRows(f, idxIdx);

  // An index column keeps its entry; every value column is one aggregate of `values`, so each
  // carries that aggregate's unit.
  const idxCols: SchemaEntry[] = idxIdx.map((ci) => f.cols[ci]!);
  const valueUnit = aggregateUnitOf(spec.agg, colUnit(f.cols, spec.values));
  const pivotCols: SchemaEntry[] = onValues.map((ov) =>
    stated(valueUnit, fresh(cellString(ov), aggType(spec.agg, valType))),
  );

  const firsts = groups.map((g) => g[0]!);
  const data: DataColumn[] = idxIdx.map((ci, k) => takeRows(f.data[ci]!, firsts, spec.index[k]!));
  for (let p = 0; p < onValues.length; p += 1) {
    const ov = onValues[p]!;
    const out: Cell[] = [];
    for (const g of groups) {
      const matching = g.filter((r) => cellEq(cellAt(onCol, r), ov));
      const v = aggregateRows(spec.agg, valType, f.data[valIdx]!, matching);
      if (!v.ok) return v;
      out.push(v.value);
    }
    const c = colOf(pivotCols[p]!.name, pivotCols[p]!.type, out);
    if (!c.ok) return c;
    data.push(c.value);
  }

  return dok({ cols: [...idxCols, ...pivotCols], data, n: groups.length });
};

const evalUnpivot = (
  f: Frame,
  idVars: readonly string[],
  valueVars: readonly string[],
): DR<Frame> => {
  const idIdx: number[] = [];
  for (const n of idVars) {
    const i = colIndex(f.cols, n);
    if (i < 0) return derr(unknownColumn(n, available(f.cols)));
    idIdx.push(i);
  }
  const valIdx: number[] = [];
  for (const n of valueVars) {
    const i = colIndex(f.cols, n);
    if (i < 0) return derr(unknownColumn(n, available(f.cols)));
    valIdx.push(i);
  }
  const repeat = repeatedOutput('unpivot', [
    ...idVars.map((n) => [n, "the id column '" + n + "'"] as const),
    ['variable', "the unpivot's variable column"],
    ['value', "the unpivot's value column"],
  ]);
  if (!repeat.ok) return repeat;
  const idCols: SchemaEntry[] = idIdx.map((ci) => f.cols[ci]!);
  // The value column is typed by the one derived-column rule, the value columns being its arms:
  // their declared types' join where the schema decides it — over an empty frame too — and the
  // melted cells only where it does not.
  const dt = unpivotTyping(valueVars.map((n) => colType(f.cols, n)!));
  if (dt.kind === 'refused') return derr(floatBesideDecimal('value'));
  // Each source row melts into one output row per value column, so the id columns are one gather.
  const sources: number[] = [];
  const variables: Cell[] = [];
  const values: Cell[] = [];
  for (let i = 0; i < f.n; i += 1) {
    valueVars.forEach((name, k) => {
      sources.push(i);
      variables.push({ kind: 'Str', value: name });
      values.push(cellAt(f.data[valIdx[k]!]!, i));
    });
  }
  const valType = columnTypeBy(dt, 'value', values);
  if (!valType.ok) return valType;
  const variable = colOf('variable', 'string', variables);
  if (!variable.ok) return variable;
  const value = colOf('value', valType.value, values);
  if (!value.ok) return value;
  return dok({
    cols: [
      ...idCols,
      fresh('variable', 'string'),
      stated(sharedUnit(f.cols, valueVars), fresh('value', valType.value)),
    ],
    data: [
      ...idIdx.map((ci, k) => takeRows(f.data[ci]!, sources, idVars[k]!)),
      variable.value,
      value.value,
    ],
    n: sources.length,
  });
};

// Window/Pivot spec aliases (the schema `WindowSpec`/`PivotSpec` shapes).
interface WindowSpecLike {
  readonly partitionBy: readonly string[];
  readonly orderBy: readonly SortKey[];
  readonly fn: 'rowNumber' | 'rank' | 'lag' | 'lead' | 'cumulSum' | 'rollingMean';
  readonly of: string;
  readonly as: string;
}
interface PivotSpecLike {
  readonly index: readonly string[];
  readonly on: string;
  readonly values: string;
  readonly agg: AggFn;
}

// ─── pipeline driver ─────────────────────────────────────────────────────────

/** Resolve a `Ref` source to a concrete `Table` (default: reject every ref). */
export type SourceResolver = (ref: string) => DR<Table>;

/** A `Ref`-rejecting resolver — the default for embedded-only pipelines. */
export const noResolve: SourceResolver = (ref) => derr({ kind: 'UnresolvedSource', ref });

/** Evaluate a `DataSource` to a concrete `Table`, resolving a `Ref` through `resolve`. */
export const evalSource = (resolve: SourceResolver, src: DataSource): DR<Table> =>
  src.kind === 'Embedded' ? dok(src.table) : resolve(src.name);

const evalStep = (
  resolve: SourceResolver,
  f: Frame,
  t: Transform,
  env: EvalEnv = EMPTY_ENV,
): DR<Frame> => {
  switch (t.kind) {
    case 'filter':
      return evalFilter(f, t.pred, env);
    case 'project':
      return evalProject(f, t.cols);
    case 'derive':
      return evalDerive(f, t.name, t.expr, env);
    case 'groupBy':
      return evalGroupBy(f, t.keys, t.aggs);
    case 'sort':
      return dok(evalSort(f, t.by));
    case 'distinct':
      return dok(evalDistinct(f));
    case 'limit':
      return dok(evalLimit(f, t.n, t.offset));
    case 'window':
      return evalWindow(f, t.spec);
    case 'pivot':
      return evalPivot(f, t.spec);
    case 'unpivot':
      return evalUnpivot(f, t.idVars, t.valueVars);
    case 'join': {
      const r = evalSource(resolve, t.source);
      if (!r.ok) return r;
      const right = toFrame(r.value);
      return right.ok ? evalJoin(f, right.value, t.on, t.how) : right;
    }
    case 'union': {
      const r = evalSource(resolve, t.source);
      if (!r.ok) return r;
      const other = toFrame(r.value);
      return other.ok ? evalUnion(f, other.value) : other;
    }
    case 'intersect':
    case 'except': {
      const r = evalSource(resolve, t.source);
      if (!r.ok) return r;
      const other = toFrame(r.value);
      return other.ok ? evalSetOp(t.kind, t.kind === 'intersect', f, other.value) : other;
    }
  }
};

/**
 * The reference evaluator: fold the pipeline over the input table, threading a
 * `Frame`. `resolve` provides any `Ref` source a `Join` / `Union` names.
 */
export const evalPipelineWithInEnv = (
  resolve: SourceResolver,
  env: EvalEnv,
  pipeline: readonly Transform[],
  input: Table,
): DR<Table> => {
  const start = toFrame(input);
  if (!start.ok) return start;
  let f = start.value;
  for (const step of pipeline) {
    const r = evalStep(resolve, f, step, env);
    if (!r.ok) return r;
    f = r.value;
  }
  return dok(ofFrame(f));
};

export const evalPipelineWith = (
  resolve: SourceResolver,
  pipeline: readonly Transform[],
  input: Table,
): DR<Table> => evalPipelineWithInEnv(resolve, EMPTY_ENV, pipeline, input);

/** The reference evaluator over embedded sources only (`Ref` ⇒ `UnresolvedSource`). */
export const evalPipeline = (pipeline: readonly Transform[], input: Table): DR<Table> =>
  evalPipelineWith(noResolve, pipeline, input);

/** The env-aware evaluator over embedded sources only (fuaran-core#77 / Phase 424). */
export const evalPipelineInEnv = (
  env: EvalEnv,
  pipeline: readonly Transform[],
  input: Table,
): DR<Table> => evalPipelineWithInEnv(noResolve, env, pipeline, input);

/** Render an `EvalError` as a stable human string (mirrors F# `DataFrame.errorString`). */
export const evalErrorString = (e: EvalError): string => {
  switch (e.kind) {
    case 'UnknownColumn':
      return "unknown column '" + e.name + "'; available: " + e.available.join(', ');
    case 'TypeError':
      return 'type error: ' + e.detail;
    case 'AggError':
      return 'aggregate error: ' + e.detail;
    case 'JoinError':
      return 'join error: ' + e.detail;
    case 'ArityError':
      return "function '" + e.fn + "' expects " + e.expected + ' args, got ' + e.got;
    case 'UnresolvedSource':
      return 'unresolved source ref: ' + e.ref;
    case 'UnboundParam':
      return "unbound param '" + e.name + "'; bound: " + e.bound.join(', ');
    case 'UnitMismatch':
      return (
        'unit mismatch in ' +
        e.step +
        ': ' +
        e.left +
        ' against ' +
        e.right +
        ' in ' +
        exprText(e.expr)
      );
  }
};

// ─── param derivation (fuaran-core#77 / Phase 424) ───────────────────────────

const colExprParams = (e: ColExpr): string[] => {
  switch (e.kind) {
    case 'col':
    case 'lit':
      return [];
    case 'param':
      return [e.name];
    case 'binary':
      return [...colExprParams(e.left), ...colExprParams(e.right)];
    case 'not':
      return colExprParams(e.expr);
    case 'coalesce':
      return e.exprs.flatMap(colExprParams);
    case 'case':
      return [
        ...e.cases.flatMap((br) => [...colExprParams(br.when), ...colExprParams(br.then)]),
        ...colExprParams(e.else),
      ];
    case 'cast':
      return colExprParams(e.expr);
    case 'apply':
      return e.args.flatMap(colExprParams);
    case 'in':
      return [...colExprParams(e.expr), ...e.items.flatMap(colExprParams)];
    case 'isNull':
      return colExprParams(e.expr);
    case 'inParam':
      // A list param shares the scalar params' namespace (reactivity derivation needs it).
      return [...colExprParams(e.expr), e.param];
    case 'quotient':
      return [...colExprParams(e.dividend), ...colExprParams(e.divisor)];
    case 'rounded':
    case 'convert':
      return colExprParams(e.expr);
  }
};

/** Every `ColExpr.param` name a single step references (only `filter` / `derive` carry a ColExpr). */
export const stepParams = (t: Transform): readonly string[] => {
  switch (t.kind) {
    case 'filter':
      return colExprParams(t.pred);
    case 'derive':
      return colExprParams(t.expr);
    default:
      return [];
  }
};

/** Every distinct param name a pipeline references — the TS mirror of Core `Transform.paramsOf`. */
export const pipelineParams = (pipeline: readonly Transform[]): readonly string[] => [
  ...new Set(pipeline.flatMap((t) => stepParams(t))),
];

// ─── list-param substitution (fuaran-core#91 / Phase 610) ────────────────────
//
// A LIST param resolves by SUBSTITUTION, not through the evaluation env: every
// `inParam` bound in `listEnv` is rewritten to the literal `in` form BEFORE the
// pipeline is evaluated, which is why `evalExpr`'s `inParam` arm is an unbound-param
// error rather than a lookup. An unbound `inParam` is left intact — the host's prune
// then sees it still naming its own param, so one `stepParams`-driven prune covers
// scalar and list params alike.

const substituteListParamsExpr = (
  listEnv: Readonly<Record<string, readonly Cell[]>>,
  e: ColExpr,
): ColExpr => {
  switch (e.kind) {
    case 'col':
    case 'lit':
    case 'param':
      return e;
    case 'binary':
      return {
        kind: 'binary',
        op: e.op,
        left: substituteListParamsExpr(listEnv, e.left),
        right: substituteListParamsExpr(listEnv, e.right),
      };
    case 'not':
      return { kind: 'not', expr: substituteListParamsExpr(listEnv, e.expr) };
    case 'coalesce':
      return { kind: 'coalesce', exprs: e.exprs.map((x) => substituteListParamsExpr(listEnv, x)) };
    case 'case':
      return {
        kind: 'case',
        cases: e.cases.map((br) => ({
          when: substituteListParamsExpr(listEnv, br.when),
          then: substituteListParamsExpr(listEnv, br.then),
        })),
        else: substituteListParamsExpr(listEnv, e.else),
      };
    case 'cast':
      return { kind: 'cast', type: e.type, expr: substituteListParamsExpr(listEnv, e.expr) };
    case 'apply':
      return {
        kind: 'apply',
        fn: e.fn,
        args: e.args.map((x) => substituteListParamsExpr(listEnv, x)),
      };
    case 'in':
      return {
        kind: 'in',
        expr: substituteListParamsExpr(listEnv, e.expr),
        items: e.items.map((x) => substituteListParamsExpr(listEnv, x)),
      };
    case 'isNull':
      return { kind: 'isNull', expr: substituteListParamsExpr(listEnv, e.expr) };
    case 'inParam': {
      const expr = substituteListParamsExpr(listEnv, e.expr);
      const items = Object.prototype.hasOwnProperty.call(listEnv, e.param)
        ? listEnv[e.param]
        : undefined;
      return items === undefined
        ? { kind: 'inParam', expr, param: e.param }
        : { kind: 'in', expr, items: items.map((c): ColExpr => ({ kind: 'lit', cell: c })) };
    }
    case 'quotient':
      return {
        kind: 'quotient',
        dividend: substituteListParamsExpr(listEnv, e.dividend),
        divisor: substituteListParamsExpr(listEnv, e.divisor),
        rounding: e.rounding,
      };
    case 'rounded':
      return {
        kind: 'rounded',
        expr: substituteListParamsExpr(listEnv, e.expr),
        rounding: e.rounding,
      };
    case 'convert':
      return { kind: 'convert', expr: substituteListParamsExpr(listEnv, e.expr), unit: e.unit };
  }
};

/**
 * Substitute every `inParam` bound in `listEnv` with the literal `in` form, through the
 * whole pipeline — the TS mirror of Core `Transform.substituteListParams`. Unbound list
 * params are left intact for the caller's prune to catch. Only `filter` / `derive` carry
 * a `ColExpr`; every other step is returned unchanged.
 */
export const substituteListParams = (
  listEnv: Readonly<Record<string, readonly Cell[]>>,
  pipeline: readonly Transform[],
): readonly Transform[] =>
  pipeline.map((t) => {
    switch (t.kind) {
      case 'filter':
        return { kind: 'filter', pred: substituteListParamsExpr(listEnv, t.pred) };
      case 'derive':
        return { kind: 'derive', name: t.name, expr: substituteListParamsExpr(listEnv, t.expr) };
      default:
        return t;
    }
  });
