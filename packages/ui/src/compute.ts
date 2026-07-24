// ============================================================================
//  @fuaran-ui/ui — the Compute-layer authoring surface (Phase 284).
//
//  An ergonomic, polars-like author surface over the @fuaran-ui/schema Compute
//  contract: typed `Cell` / `ColExpr` constructors, a `DataSource` builder, and a
//  fluent `df(source).filter(…).groupBy(…).sort(…)` pipeline builder that yields a
//  `Binding.Transform`. Parity-shaped with the F# `Fuaran.Core.DataFrame`
//  builder surface — the in-memory values the @fuaran-ui/ops codec serialises.
//
//  Capability authoring (`binding.invoke` / `action.invoke`) ships its
//  constructors here too; the full capability *runtime* (dispatch seam +
//  `Deferred` states) is gated on Phase 283.
// ============================================================================

import type {
  Agg,
  AggFn,
  Binding,
  BinOp,
  Cell,
  ColExpr,
  ColPair,
  ColumnType,
  DataColumn,
  DataSource,
  JoinKind,
  PivotSpec,
  ScalarFn,
  SchemaEntry,
  SortDir,
  SortKey,
  Table,
  Transform,
  WindowFn,
  WindowSpec,
} from '@fuaran-ui/schema';

// ─── Cell constructors ───────────────────────────────────────────────────────

/** Typed scalar-cell constructors (the columnar `Cell` cases). */
export const cell = {
  int(value: number): Cell {
    return { kind: 'Int', value };
  },
  float(value: number): Cell {
    return { kind: 'Float', value };
  },
  bool(value: boolean): Cell {
    return { kind: 'Bool', value };
  },
  str(value: string): Cell {
    return { kind: 'Str', value };
  },
  date(value: string): Cell {
    return { kind: 'Date', value };
  },
  timestamp(value: string): Cell {
    return { kind: 'Timestamp', value };
  },
  null(): Cell {
    return { kind: 'Null' };
  },
};

// ─── ColExpr constructors ────────────────────────────────────────────────────

const binary = (op: BinOp, left: ColExpr, right: ColExpr): ColExpr => ({
  kind: 'binary',
  op,
  left,
  right,
});

/** The `ColExpr` algebra — column refs, literals, operators, scalar functions. */
export const expr = {
  col(name: string): ColExpr {
    return { kind: 'col', name };
  },
  lit(c: Cell): ColExpr {
    return { kind: 'lit', cell: c };
  },
  add: (l: ColExpr, r: ColExpr): ColExpr => binary('add', l, r),
  sub: (l: ColExpr, r: ColExpr): ColExpr => binary('sub', l, r),
  mul: (l: ColExpr, r: ColExpr): ColExpr => binary('mul', l, r),
  div: (l: ColExpr, r: ColExpr): ColExpr => binary('div', l, r),
  mod: (l: ColExpr, r: ColExpr): ColExpr => binary('mod', l, r),
  eq: (l: ColExpr, r: ColExpr): ColExpr => binary('eq', l, r),
  ne: (l: ColExpr, r: ColExpr): ColExpr => binary('ne', l, r),
  lt: (l: ColExpr, r: ColExpr): ColExpr => binary('lt', l, r),
  le: (l: ColExpr, r: ColExpr): ColExpr => binary('le', l, r),
  gt: (l: ColExpr, r: ColExpr): ColExpr => binary('gt', l, r),
  ge: (l: ColExpr, r: ColExpr): ColExpr => binary('ge', l, r),
  and: (l: ColExpr, r: ColExpr): ColExpr => binary('and', l, r),
  or: (l: ColExpr, r: ColExpr): ColExpr => binary('or', l, r),
  not(e: ColExpr): ColExpr {
    return { kind: 'not', expr: e };
  },
  coalesce(...exprs: ColExpr[]): ColExpr {
    return { kind: 'coalesce', exprs };
  },
  caseWhen(cases: readonly { when: ColExpr; then: ColExpr }[], elseExpr: ColExpr): ColExpr {
    return { kind: 'case', cases, else: elseExpr };
  },
  cast(type: ColumnType, e: ColExpr): ColExpr {
    return { kind: 'cast', type, expr: e };
  },
  apply(fn: ScalarFn, ...args: ColExpr[]): ColExpr {
    return { kind: 'apply', fn, args };
  },
};

// ─── DataSource builders ─────────────────────────────────────────────────────

/** Build a typed `Table` from a schema and per-column cell arrays. */
export const buildTable = (
  schema: readonly [string, ColumnType][],
  columns: Readonly<Record<string, readonly Cell[]>>,
): Table => {
  const entries: SchemaEntry[] = schema.map(([name, type]) => ({ name, type }));
  const cols: DataColumn[] = entries.map((e) => ({
    name: e.name,
    type: e.type,
    cells: columns[e.name] ?? [],
  }));
  return { schema: entries, columns: cols };
};

/** `DataSource` constructors — an embedded table or a host-resolved named ref. */
export const dataSource = {
  embedded(table: Table): DataSource {
    return { kind: 'Embedded', table };
  },
  ref(name: string): DataSource {
    return { kind: 'Ref', name };
  },
};

// ─── Aggregate constructor ───────────────────────────────────────────────────

/** Build a `groupBy` / `pivot` aggregate `(name = fn(of))`. */
export const agg = (name: string, fn: AggFn, of: string): Agg => ({ name, fn, of });

// ─── Transform-step constructors ─────────────────────────────────────────────

const pair = (a: string, b: string): ColPair => ({ a, b });
const order = (col: string, dir: SortDir = 'asc'): SortKey => ({ col, dir });

/** The transform-step constructors (the v1 verb set). */
export const transform = {
  filter(pred: ColExpr): Transform {
    return { kind: 'filter', pred };
  },
  /** `cols`: `[sourceColumn, outputName]` pairs. */
  project(cols: readonly [string, string][]): Transform {
    return { kind: 'project', cols: cols.map(([a, b]) => pair(a, b)) };
  },
  derive(name: string, e: ColExpr): Transform {
    return { kind: 'derive', name, expr: e };
  },
  groupBy(keys: readonly string[], aggs: readonly Agg[]): Transform {
    return { kind: 'groupBy', keys, aggs };
  },
  /** `on`: `[leftColumn, rightColumn]` pairs. */
  join(source: DataSource, on: readonly [string, string][], how: JoinKind = 'inner'): Transform {
    return { kind: 'join', source, on: on.map(([a, b]) => pair(a, b)), how };
  },
  window(spec: WindowSpec): Transform {
    return { kind: 'window', spec };
  },
  pivot(spec: PivotSpec): Transform {
    return { kind: 'pivot', spec };
  },
  unpivot(idVars: readonly string[], valueVars: readonly string[]): Transform {
    return { kind: 'unpivot', idVars, valueVars };
  },
  /** `by`: `[column, direction?]` pairs (direction defaults to `'asc'`). */
  sort(by: readonly (readonly [string, SortDir] | string)[]): Transform {
    return {
      kind: 'sort',
      by: by.map((b) => (typeof b === 'string' ? order(b) : order(b[0], b[1]))),
    };
  },
  distinct(): Transform {
    return { kind: 'distinct' };
  },
  limit(n: number, offset = 0): Transform {
    return { kind: 'limit', n, offset };
  },
  union(source: DataSource): Transform {
    return { kind: 'union', source };
  },
};

// ─── Fluent pipeline builder (polars-like) ───────────────────────────────────

/**
 * A polars-like fluent builder over a `DataSource`. Chain verbs, then
 * `.toBinding()` (a `Binding.Transform`) or `.build()` (the `{ source, pipeline }`
 * pair). Each verb returns a new builder — the builder is immutable.
 */
export class TransformBuilder {
  constructor(
    private readonly source: DataSource,
    private readonly steps: readonly Transform[],
  ) {}

  private add(step: Transform): TransformBuilder {
    return new TransformBuilder(this.source, [...this.steps, step]);
  }

  filter(pred: ColExpr): TransformBuilder {
    return this.add(transform.filter(pred));
  }
  project(cols: readonly [string, string][]): TransformBuilder {
    return this.add(transform.project(cols));
  }
  derive(name: string, e: ColExpr): TransformBuilder {
    return this.add(transform.derive(name, e));
  }
  groupBy(keys: readonly string[], aggs: readonly Agg[]): TransformBuilder {
    return this.add(transform.groupBy(keys, aggs));
  }
  join(
    source: DataSource,
    on: readonly [string, string][],
    how: JoinKind = 'inner',
  ): TransformBuilder {
    return this.add(transform.join(source, on, how));
  }
  window(spec: WindowSpec): TransformBuilder {
    return this.add(transform.window(spec));
  }
  pivot(spec: PivotSpec): TransformBuilder {
    return this.add(transform.pivot(spec));
  }
  unpivot(idVars: readonly string[], valueVars: readonly string[]): TransformBuilder {
    return this.add(transform.unpivot(idVars, valueVars));
  }
  sort(by: readonly (readonly [string, SortDir] | string)[]): TransformBuilder {
    return this.add(transform.sort(by));
  }
  distinct(): TransformBuilder {
    return this.add(transform.distinct());
  }
  limit(n: number, offset = 0): TransformBuilder {
    return this.add(transform.limit(n, offset));
  }
  union(source: DataSource): TransformBuilder {
    return this.add(transform.union(source));
  }

  /** The accumulated `{ source, pipeline }`. */
  build(): { source: DataSource; pipeline: readonly Transform[] } {
    return { source: this.source, pipeline: this.steps };
  }

  /** Project to a `Binding.Transform` — drop it into a data-bearing node's source slot. */
  toBinding<T>(): Binding<T> {
    return { kind: 'Transform', source: this.source, pipeline: this.steps };
  }
}

/** Start a fluent transform pipeline over a `DataSource`. */
export const df = (source: DataSource): TransformBuilder => new TransformBuilder(source, []);

// ─── window-spec convenience ─────────────────────────────────────────────────

/** Build a `WindowSpec` for a `window` step. */
export const window = (
  fn: WindowFn,
  of: string,
  as: string,
  opts?: {
    partitionBy?: readonly string[];
    orderBy?: readonly (readonly [string, SortDir] | string)[];
  },
): WindowSpec => ({
  partitionBy: opts?.partitionBy ?? [],
  orderBy: (opts?.orderBy ?? []).map((b) => (typeof b === 'string' ? order(b) : order(b[0], b[1]))),
  fn,
  of,
  as,
});

/** Build a `PivotSpec` for a `pivot` step. */
export const pivot = (
  index: readonly string[],
  on: string,
  values: string,
  aggFn: AggFn,
): PivotSpec => ({
  index,
  on,
  values,
  agg: aggFn,
});
