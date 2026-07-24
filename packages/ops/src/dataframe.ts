// ============================================================================
//  @fuaran-ui/ops — the native-JS columnar dataframe evaluator (Phase 284).
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

import { num } from './encode.js';

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

// ─── internal row-oriented frame (the evaluator's working form) ──────────────

interface Frame {
  readonly cols: readonly SchemaEntry[];
  readonly rows: readonly (readonly Cell[])[];
}

const NULL: Cell = { kind: 'Null' };

const isNull = (c: Cell): boolean => c.kind === 'Null';

const rowCount = (t: Table): number => (t.columns.length > 0 ? t.columns[0]!.cells.length : 0);

const toFrame = (t: Table): Frame => {
  const n = rowCount(t);
  const byName = new Map(t.columns.map((c) => [c.name, c] as const));
  const rows: Cell[][] = [];
  for (let i = 0; i < n; i += 1) {
    rows.push(
      t.schema.map((e) => {
        const c = byName.get(e.name);
        return c !== undefined && i >= 0 && i < c.cells.length ? c.cells[i]! : NULL;
      }),
    );
  }
  return { cols: t.schema, rows };
};

const ofFrame = (f: Frame): Table => {
  const columns: DataColumn[] = f.cols.map((e, ci) => ({
    name: e.name,
    type: e.type,
    cells: f.rows.map((row) => row[ci]!),
  }));
  return { schema: f.cols, columns };
};

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
    case 'Null':
      return '';
  }
};

const asNum = (c: Cell): number | undefined =>
  c.kind === 'Int' || c.kind === 'Float' ? c.value : undefined;

const sign = (n: number): number => (n < 0 ? -1 : n > 0 ? 1 : 0);

/** Total comparison of two present, same-family cells. `undefined` ⇒ incomparable. */
const compareCells = (a: Cell, b: Cell): number | undefined => {
  const an = asNum(a);
  const bn = asNum(b);
  if (an !== undefined && bn !== undefined) return sign(an - bn);
  if (a.kind === 'Bool' && b.kind === 'Bool') return a.value === b.value ? 0 : a.value ? 1 : -1;
  if (a.kind === 'Str' && b.kind === 'Str')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'Date' && b.kind === 'Date')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  if (a.kind === 'Timestamp' && b.kind === 'Timestamp')
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  return undefined;
};

const cellEq = (a: Cell, b: Cell): boolean => {
  if (a.kind === 'Null' || b.kind === 'Null') return false;
  return compareCells(a, b) === 0;
};

const bothInt = (a: Cell, b: Cell): boolean => a.kind === 'Int' && b.kind === 'Int';

const arith = (op: string, a: Cell, b: Cell): DR<Cell> => {
  if (a.kind === 'Null' || b.kind === 'Null') return dok(NULL);
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
  if (c === undefined) return derr(typeError('comparison between incompatible types'));
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
    case 'timestamp':
      if (c.kind === 'Timestamp') return dok(c);
      if (c.kind === 'Str') return dok({ kind: 'Timestamp', value: c.value });
      return derr(typeError('cannot cast to timestamp'));
  }
};

/** Round half away from zero — host-independent (not banker's rounding). */
const roundHalfAway = (x: number): number => (x >= 0 ? Math.floor(x + 0.5) : Math.ceil(x - 0.5));

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
    case 'abs':
      return unary((c) =>
        c.kind === 'Int'
          ? dok({ kind: 'Int', value: Math.abs(c.value) })
          : c.kind === 'Float'
            ? dok({ kind: 'Float', value: Math.abs(c.value) })
            : derr(typeError('abs of a non-numeric')),
      );
    case 'round':
      return unary((c) => {
        const n = asNum(c);
        return n !== undefined
          ? dok({ kind: 'Float', value: roundHalfAway(n) })
          : derr(typeError('round of a non-numeric'));
      });
    case 'floor':
      return unary((c) => {
        const n = asNum(c);
        return n !== undefined
          ? dok({ kind: 'Float', value: Math.floor(n) })
          : derr(typeError('floor of a non-numeric'));
      });
    case 'ceil':
      return unary((c) => {
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
 * days-from-civil as pure integer math (fuaran-core#90, `dateDiffDays`). No host date library.
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
    const y = m0 <= 2 ? y0 - 1 : y0;
    const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
    const yoe = y - era * 400;
    const mp = (m0 + 9) % 12;
    const doy = Math.trunc((153 * mp + 2) / 5) + d0 - 1;
    const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
    return dok(era * 146097 + doe - 719468);
  }
  return derr(typeError('dateDiffDays expects date/timestamp/string operands'));
};

/** Evaluate a `ColExpr` against one row. */
/** The evaluation environment (fuaran-core#77) — binds each `ColExpr.param` name to a `Cell`. */
export type EvalEnv = Readonly<Record<string, Cell>>;
const EMPTY_ENV: EvalEnv = {};

const evalExpr = (
  cols: readonly SchemaEntry[],
  row: readonly Cell[],
  e: ColExpr,
  env: EvalEnv = EMPTY_ENV,
): DR<Cell> => {
  switch (e.kind) {
    case 'col': {
      const i = colIndex(cols, e.name);
      return i >= 0 ? dok(row[i]!) : derr(unknownColumn(e.name, available(cols)));
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
    case 'Timestamp':
      return 'timestamp';
    case 'Null':
      return undefined;
  }
};

const inferType = (cells: readonly Cell[]): ColumnType => {
  for (const c of cells) {
    const t = cellTypeOf(c);
    if (t !== undefined) return t;
  }
  return 'string';
};

// ─── aggregates (pinned) ─────────────────────────────────────────────────────

const presentNums = (cells: readonly Cell[]): number[] =>
  cells.map(asNum).filter((n): n is number => n !== undefined);

const aggCells = (fn: AggFn, srcType: ColumnType, cells: readonly Cell[]): Cell => {
  const present = cells.filter((c) => !isNull(c));
  switch (fn) {
    case 'count':
      return { kind: 'Int', value: present.length };
    case 'first':
      return cells.length === 0 ? NULL : cells[0]!;
    case 'last':
      return cells.length === 0 ? NULL : cells[cells.length - 1]!;
    case 'sum': {
      const nums = presentNums(cells);
      if (nums.length === 0) return NULL;
      return srcType === 'int'
        ? { kind: 'Int', value: nums.reduce((acc, x) => acc + Math.trunc(x), 0) }
        : { kind: 'Float', value: nums.reduce((acc, x) => acc + x, 0) };
    }
    case 'mean': {
      const nums = presentNums(cells);
      if (nums.length === 0) return NULL;
      return { kind: 'Float', value: nums.reduce((a, x) => a + x, 0) / nums.length };
    }
    case 'stddev': {
      const nums = presentNums(cells);
      if (nums.length === 0) return NULL;
      const n = nums.length;
      const mean = nums.reduce((a, x) => a + x, 0) / n;
      const variance = nums.reduce((a, x) => a + (x - mean) * (x - mean), 0) / n;
      return { kind: 'Float', value: Math.sqrt(variance) };
    }
    case 'median': {
      const nums = presentNums(cells)
        .slice()
        .sort((a, b) => a - b);
      if (nums.length === 0) return NULL;
      const n = nums.length;
      const mid = Math.floor(n / 2);
      if (n % 2 === 1) return { kind: 'Float', value: nums[mid]! };
      return { kind: 'Float', value: (nums[mid - 1]! + nums[mid]!) / 2 };
    }
    case 'min':
    case 'max': {
      if (present.length === 0) return NULL;
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
      return acc;
    }
  }
};

const aggType = (fn: AggFn, srcType: ColumnType): ColumnType => {
  switch (fn) {
    case 'count':
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

// ─── sort (pinned: stable; nulls last regardless of direction) ───────────────

const rowKeyCompare = (
  cols: readonly SchemaEntry[],
  by: readonly SortKey[],
  r1: readonly Cell[],
  r2: readonly Cell[],
): number => {
  for (const { col, dir } of by) {
    const i = colIndex(cols, col);
    if (i < 0) continue;
    const a = r1[i]!;
    const b = r2[i]!;
    const an = isNull(a);
    const bn = isNull(b);
    let c: number;
    if (an && bn) c = 0;
    else if (an && !bn)
      c = 1; // null sorts last
    else if (!an && bn) c = -1;
    else {
      const cc = compareCells(a, b);
      c = cc === undefined ? 0 : dir === 'asc' ? cc : -cc;
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
  }
};

const rowKey = (cells: readonly Cell[]): string => cells.map(cellKey).join('');

// ─── per-verb evaluation ─────────────────────────────────────────────────────

const evalFilter = (f: Frame, pred: ColExpr, env: EvalEnv = EMPTY_ENV): DR<Frame> => {
  const out: (readonly Cell[])[] = [];
  for (const row of f.rows) {
    const r = evalExpr(f.cols, row, pred, env);
    if (!r.ok) return r;
    if (r.value.kind === 'Bool' && r.value.value) out.push(row);
  }
  return dok({ ...f, rows: out });
};

const evalProject = (f: Frame, pairs: readonly { a: string; b: string }[]): DR<Frame> => {
  const resolved: { out: string; type: ColumnType; index: number }[] = [];
  for (const { a, b } of pairs) {
    const i = colIndex(f.cols, a);
    if (i < 0) return derr(unknownColumn(a, available(f.cols)));
    resolved.push({ out: b, type: f.cols[i]!.type, index: i });
  }
  return dok({
    cols: resolved.map((r) => ({ name: r.out, type: r.type })),
    rows: f.rows.map((row) => resolved.map((r) => row[r.index]!)),
  });
};

const evalDerive = (f: Frame, name: string, expr: ColExpr, env: EvalEnv = EMPTY_ENV): DR<Frame> => {
  const newCells: Cell[] = [];
  for (const row of f.rows) {
    const r = evalExpr(f.cols, row, expr, env);
    if (!r.ok) return r;
    newCells.push(r.value);
  }
  const ty = inferType(newCells);
  const i = colIndex(f.cols, name);
  if (i >= 0) {
    return dok({
      cols: f.cols.map((e, j) => (j === i ? { name: e.name, type: ty } : e)),
      rows: f.rows.map((row, ri) => row.map((cell, j) => (j === i ? newCells[ri]! : cell))),
    });
  }
  return dok({
    cols: [...f.cols, { name, type: ty }],
    rows: f.rows.map((row, ri) => [...row, newCells[ri]!]),
  });
};

const evalGroupBy = (f: Frame, keys: readonly string[], aggs: readonly Agg[]): DR<Frame> => {
  for (const k of keys) {
    if (colIndex(f.cols, k) < 0) return derr(unknownColumn(k, available(f.cols)));
  }
  const idxs = keys.map((k) => colIndex(f.cols, k));
  const keyOf = (row: readonly Cell[]): Cell[] => idxs.map((i) => row[i]!);

  const order: string[] = [];
  const groups = new Map<string, { key: Cell[]; rows: (readonly Cell[])[] }>();
  for (const row of f.rows) {
    const k = keyOf(row);
    const ks = rowKey(k);
    const g = groups.get(ks);
    if (g === undefined) {
      order.push(ks);
      groups.set(ks, { key: k, rows: [row] });
    } else {
      g.rows.push(row);
    }
  }

  const resolvedAggs: { agg: Agg; type: ColumnType; index: number }[] = [];
  for (const a of aggs) {
    const ty = colType(f.cols, a.of);
    if (ty === undefined) return derr(unknownColumn(a.of, available(f.cols)));
    resolvedAggs.push({ agg: a, type: ty, index: colIndex(f.cols, a.of) });
  }

  const keyCols: SchemaEntry[] = keys.map((k) => ({ name: k, type: colType(f.cols, k)! }));
  const aggCols: SchemaEntry[] = resolvedAggs.map((r) => ({
    name: r.agg.name,
    type: aggType(r.agg.fn, r.type),
  }));

  const rows = order.map((ks) => {
    const g = groups.get(ks)!;
    const aggVals = resolvedAggs.map((r) =>
      aggCells(
        r.agg.fn,
        r.type,
        g.rows.map((row) => row[r.index]!),
      ),
    );
    return [...g.key, ...aggVals];
  });

  return dok({ cols: [...keyCols, ...aggCols], rows });
};

const evalSort = (f: Frame, by: readonly SortKey[]): Frame => ({
  ...f,
  rows: stableSort(f.rows, (a, b) => rowKeyCompare(f.cols, by, a, b)),
});

const evalDistinct = (f: Frame): Frame => {
  const seen = new Set<string>();
  const out: (readonly Cell[])[] = [];
  for (const row of f.rows) {
    const k = rowKey(row);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(row);
    }
  }
  return { ...f, rows: out };
};

const evalLimit = (f: Frame, n: number, offset: number): Frame => {
  const start = Math.min(Math.max(0, offset), f.rows.length);
  const take = Math.max(0, n);
  return { ...f, rows: f.rows.slice(start, start + take) };
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
  const keyMatch = (lr: readonly Cell[], rr: readonly Cell[]): boolean =>
    li.every((i, k) => cellEq(lr[i]!, rr[ri[k]!]!));

  const leftNames = new Set(available(f.cols));
  const rightCols: SchemaEntry[] = right.cols.map((e) => ({
    name: leftNames.has(e.name) ? e.name + '_right' : e.name,
    type: e.type,
  }));
  const outCols = [...f.cols, ...rightCols];
  const leftNulls: Cell[] = f.cols.map(() => NULL);
  const rightNulls: Cell[] = right.cols.map(() => NULL);

  const leftSide: (readonly Cell[])[] = [];
  for (const lr of f.rows) {
    const matches = right.rows.filter((rr) => keyMatch(lr, rr));
    if (matches.length === 0) {
      if (how === 'left' || how === 'outer') leftSide.push([...lr, ...rightNulls]);
      // inner / right with no match: emit nothing
    } else {
      for (const rr of matches) leftSide.push([...lr, ...rr]);
    }
  }

  const rightOnly: (readonly Cell[])[] = [];
  if (how === 'right' || how === 'outer') {
    for (const rr of right.rows) {
      if (!f.rows.some((lr) => keyMatch(lr, rr))) rightOnly.push([...leftNulls, ...rr]);
    }
  }

  return dok({ cols: outCols, rows: [...leftSide, ...rightOnly] });
};

const evalUnion = (f: Frame, other: Frame): DR<Frame> => {
  const an = available(f.cols);
  const bn = available(other.cols);
  if (an.length !== bn.length || an.some((n, i) => n !== bn[i])) {
    return derr({ kind: 'JoinError', detail: 'union requires matching column names' });
  }
  return dok({ ...f, rows: [...f.rows, ...other.rows] });
};

const evalWindow = (f: Frame, spec: WindowSpecLike): DR<Frame> => {
  const ofIdx = colIndex(f.cols, spec.of);
  if (ofIdx < 0 && spec.fn !== 'rowNumber' && spec.fn !== 'rank') {
    return derr(unknownColumn(spec.of, available(f.cols)));
  }
  const partIdx = spec.partitionBy.map((p) => colIndex(f.cols, p)).filter((i) => i >= 0);
  const partKey = (row: readonly Cell[]): string => rowKey(partIdx.map((i) => row[i]!));

  // partition (first-appearance order), tagging each row with its original index
  const order: string[] = [];
  const partitions = new Map<string, { index: number; row: readonly Cell[] }[]>();
  f.rows.forEach((row, i) => {
    const k = partKey(row);
    const p = partitions.get(k);
    if (p === undefined) {
      order.push(k);
      partitions.set(k, [{ index: i, row }]);
    } else {
      p.push({ index: i, row });
    }
  });

  const valueAt = (row: readonly Cell[]): Cell => (ofIdx >= 0 ? row[ofIdx]! : NULL);

  const computed: { index: number; out: Cell }[] = [];
  for (const k of order) {
    const members = partitions.get(k)!;
    const ordered = stableSort(members, (a, b) =>
      rowKeyCompare(f.cols, spec.orderBy, a.row, b.row),
    );
    const vals = ordered.map((m) => valueAt(m.row));
    let outs: Cell[];
    switch (spec.fn) {
      case 'rowNumber':
        outs = ordered.map((_, i) => ({ kind: 'Int', value: i + 1 }));
        break;
      case 'rank': {
        // ties (equal order keys) share a rank; running sum of step (0/1)
        const steps = ordered.map((m, i) =>
          i === 0
            ? 1
            : rowKeyCompare(f.cols, spec.orderBy, ordered[i - 1]!.row, m.row) === 0
              ? 0
              : 1,
        );
        let acc = 0;
        outs = steps.map((s) => {
          acc += s;
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
          const nums = window.map(asNum).filter((n): n is number => n !== undefined);
          return nums.length === 0
            ? NULL
            : { kind: 'Float', value: nums.reduce((a, x) => a + x, 0) / nums.length };
        });
        break;
    }
    ordered.forEach((m, i) => computed.push({ index: m.index, out: outs[i]! }));
  }

  computed.sort((a, b) => a.index - b.index);
  const outCells = computed.map((c) => c.out);

  let ty: ColumnType;
  switch (spec.fn) {
    case 'rowNumber':
    case 'rank':
      ty = 'int';
      break;
    case 'cumulSum':
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

  return dok({
    cols: [...f.cols, { name: spec.as, type: ty }],
    rows: f.rows.map((row, i) => [...row, outCells[i]!]),
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

  const indexKey = (row: readonly Cell[]): Cell[] => idxIdx.map((i) => row[i]!);

  // distinct on-values (sorted by canonical string for a deterministic column order)
  const onSeen = new Set<string>();
  const onValues: Cell[] = [];
  for (const row of f.rows) {
    const c = row[onIdx]!;
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

  // index groups, first-appearance order
  const order: Cell[][] = [];
  const orderSeen = new Set<string>();
  for (const row of f.rows) {
    const k = indexKey(row);
    const ks = rowKey(k);
    if (!orderSeen.has(ks)) {
      orderSeen.add(ks);
      order.push(k);
    }
  }

  const idxCols: SchemaEntry[] = spec.index.map((n) => ({ name: n, type: colType(f.cols, n)! }));
  const pivotCols: SchemaEntry[] = onValues.map((ov) => ({
    name: cellString(ov),
    type: aggType(spec.agg, valType),
  }));

  const rows = order.map((k) => {
    const ks = rowKey(k);
    const cellsFor = (ov: Cell): Cell => {
      const matching = f.rows
        .filter((row) => rowKey(indexKey(row)) === ks && cellEq(row[onIdx]!, ov))
        .map((row) => row[valIdx]!);
      return aggCells(spec.agg, valType, matching);
    };
    return [...k, ...onValues.map(cellsFor)];
  });

  return dok({ cols: [...idxCols, ...pivotCols], rows });
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
  const idCols: SchemaEntry[] = idVars.map((n) => ({ name: n, type: colType(f.cols, n)! }));
  let valType: ColumnType = 'string';
  for (const n of valueVars) {
    const t = colType(f.cols, n);
    if (t !== undefined) {
      valType = t;
      break;
    }
  }
  const cols: SchemaEntry[] = [
    ...idCols,
    { name: 'variable', type: 'string' },
    { name: 'value', type: valType },
  ];
  const rows: Cell[][] = [];
  for (const row of f.rows) {
    const idCells = idIdx.map((i) => row[i]!);
    valueVars.forEach((name, k) => {
      rows.push([...idCells, { kind: 'Str', value: name }, row[valIdx[k]!]!]);
    });
  }
  return dok({ cols, rows });
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
      return evalJoin(f, toFrame(r.value), t.on, t.how);
    }
    case 'union': {
      const r = evalSource(resolve, t.source);
      if (!r.ok) return r;
      return evalUnion(f, toFrame(r.value));
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
  let f = toFrame(input);
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
