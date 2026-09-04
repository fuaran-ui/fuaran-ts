// ============================================================================
//  @fuaran-ui/schema — the Compute-layer typed contract (Phase 282 / 284).
//
//  A shape-for-shape port of the Fuaran.Core columnar + dataframe-algebra
//  contract (the `Fuaran.Core.Column` and `Fuaran.Core.DataFrame` strands): the
//  `Cell` / `ColumnType` / `Table` / `DataSource` columnar model and the
//  serialisable `Transform` + `ColExpr` transform algebra. The host `Binding`
//  carries a `Transform` case (a columnar `source` + a `pipeline`) that the
//  renderer evaluates client-side *as data* — no closure on the wire.
//
//  This file owns only the typed contract; the canonical-JSON codec lives in
//  @fuaran-ui/ops and the native-JS columnar evaluator alongside it. The wire
//  shape is declared language-neutrally in fuaran-dotnet/docs/WIRE_FORMAT.md §3.3; the
//  codec is verified byte-for-byte against the workspace wire-format-fixtures
//  corpus (`nodes/grid-transform.json` is the worked Transform reference).
//
//  PORTING CONVENTIONS (consistent with types.ts):
//   - F# discriminated unions become TS tagged unions discriminated by a
//     `kind: '<wireTag>'` literal. For the columnar/algebra DUs the wire tag is
//     the *lower-camel* discriminator the canonical codec emits (`'col'`,
//     `'binary'`, `'filter'`, `'groupBy'`, …) — stored verbatim in-memory so the
//     codec is a pure structural projection with no tag-table indirection.
//   - The bare-string operator/function enums (`BinOp` / `ScalarFn` / `AggFn` /
//     `JoinKind` / `WindowFn` / `SortDir`) are their canonical wire tags, so they
//     drop straight onto the wire as plain JSON strings.
//   - F# `option` / absent ⟺ a field omitted; never `null`.
// ============================================================================

import type { DeterminismSource, EffectClass, HoleValueSpace } from './types.js';

// ─── Columnar model (port of Fuaran.Core.Column) ─────────────────────────────

/**
 * The fixed, Arrow-compatible scalar type set a column ranges over. Closed by
 * intent — these are the canonical wire tags (`ColumnType.tag` in F#).
 */
export type ColumnType = 'int' | 'float' | 'bool' | 'string' | 'date' | 'timestamp';

/** The full closed set of column-type tags, in canonical (encode) order. */
export const COLUMN_TYPES: readonly ColumnType[] = [
  'int',
  'float',
  'bool',
  'string',
  'date',
  'timestamp',
];

/**
 * A single realized scalar cell. Null/NA is a first-class case (`Null`), never a
 * sentinel buried in the data — the in-memory form of the wire's validity mask.
 * `Date` / `Timestamp` carry their canonical ISO-8601 string so the model needs
 * no host `Date` dependency and stays byte-identical across hosts.
 */
export type Cell =
  | { readonly kind: 'Int'; readonly value: number }
  | { readonly kind: 'Float'; readonly value: number }
  | { readonly kind: 'Bool'; readonly value: boolean }
  | { readonly kind: 'Str'; readonly value: string }
  | { readonly kind: 'Date'; readonly value: string }
  | { readonly kind: 'Timestamp'; readonly value: string }
  | { readonly kind: 'Null' };

/** A `(name, type)` schema entry — the column order of a table follows the schema. */
export interface SchemaEntry {
  readonly name: string;
  readonly type: ColumnType;
}

/** The ordered table schema. */
export type ColumnSchema = readonly SchemaEntry[];

/**
 * A typed, null-aware column. `cells` co-indexes with the table's rows; a `Null`
 * cell is the validity-mask "absent" marker. Named `DataColumn` to avoid a clash
 * with the grid `Column<TRow, TMsg>` in types.ts.
 */
export interface DataColumn {
  readonly name: string;
  readonly type: ColumnType;
  readonly cells: readonly Cell[];
}

/** An embedded columnar table: its schema + the columns (column order follows the schema). */
export interface Table {
  readonly schema: ColumnSchema;
  readonly columns: readonly DataColumn[];
}

/**
 * A data source: embedded columns, or a host-resolved named `Ref`. The evaluator
 * resolves a `Ref` through a caller-supplied resolver; the wire carries the name,
 * never the rows. (An `Embedded` wire also always carries the schema; a `Ref`
 * wire carries an empty schema array + the `ref` name — mirrors the F# codec.)
 */
export type DataSource =
  | { readonly kind: 'Embedded'; readonly table: Table }
  | { readonly kind: 'Ref'; readonly name: string };

// ─── Transform algebra (port of Fuaran.Core.DataFrame) ───────────────────────

/** A binary operator (arithmetic / comparison / logical) — its canonical wire tag. */
export type BinOp =
  | 'add'
  | 'sub'
  | 'mul'
  | 'div'
  | 'mod'
  | 'eq'
  | 'ne'
  | 'lt'
  | 'le'
  | 'gt'
  | 'ge'
  | 'and'
  | 'or'
  // fuaran-core#90 — Ordinal substring predicates (Str x Str -> Bool, null-propagating).
  | 'contains'
  | 'startsWith'
  | 'endsWith';

/** The fixed scalar-function set a `ColExpr.apply` may name — its canonical wire tag. */
export type ScalarFn =
  | 'abs'
  | 'round'
  | 'floor'
  | 'ceil'
  | 'length'
  | 'lower'
  | 'upper'
  | 'substr'
  | 'datePart'
  // fuaran-core#90 — string building + the pinned day-delta.
  | 'concat'
  | 'trim'
  | 'replace'
  | 'dateDiffDays';

/** A group/window aggregate function — its canonical wire tag. */
export type AggFn =
  | 'sum'
  | 'mean'
  | 'min'
  | 'max'
  | 'count'
  | 'median'
  | 'stddev'
  | 'first'
  | 'last';

/** A join kind — its canonical wire tag. */
export type JoinKind = 'inner' | 'left' | 'right' | 'outer';

/** A window function — its canonical wire tag. */
export type WindowFn = 'rowNumber' | 'rank' | 'lag' | 'lead' | 'cumulSum' | 'rollingMean';

/** A sort direction — its canonical wire tag. */
export type SortDir = 'asc' | 'desc';

/**
 * A `(from, to)` ordered string pair. The canonical wire shape is `{"a":…,"b":…}`.
 * For `project` cols, `a` is the source column and `b` the output name; for `join`
 * `on` keys, `a` is the left column and `b` the right column.
 */
export interface ColPair {
  readonly a: string;
  readonly b: string;
}

/** A scalar expression over a row's columns + literals — the `ColExpr` algebra. */
export type ColExpr =
  | { readonly kind: 'col'; readonly name: string }
  | { readonly kind: 'lit'; readonly cell: Cell }
  // A named parameter resolved per-evaluation from the host's binding environment (fuaran-core#77).
  | { readonly kind: 'param'; readonly name: string }
  | { readonly kind: 'binary'; readonly op: BinOp; readonly left: ColExpr; readonly right: ColExpr }
  | { readonly kind: 'not'; readonly expr: ColExpr }
  | { readonly kind: 'coalesce'; readonly exprs: readonly ColExpr[] }
  | {
      readonly kind: 'case';
      readonly cases: readonly CaseBranch[];
      readonly else: ColExpr;
    }
  | { readonly kind: 'cast'; readonly type: ColumnType; readonly expr: ColExpr }
  | { readonly kind: 'apply'; readonly fn: ScalarFn; readonly args: readonly ColExpr[] }
  // fuaran-core#90 — SQL three-valued membership over a literal item list.
  | { readonly kind: 'in'; readonly expr: ColExpr; readonly items: readonly ColExpr[] }
  // fuaran-core#90 — the honest presence test: total, always Bool.
  | { readonly kind: 'isNull'; readonly expr: ColExpr }
  // fuaran-core#91 — a LIST-valued named param membership test (multi-select-chip binding).
  // Same `in` wire tag as the literal form, with `param` in place of `items`.
  | { readonly kind: 'inParam'; readonly expr: ColExpr; readonly param: string };

/** One `when → then` branch of a `ColExpr.case`. */
export interface CaseBranch {
  readonly when: ColExpr;
  readonly then: ColExpr;
}

/** One aggregate in a `groupBy` — an output `name`, the aggregate `fn`, over column `of`. */
export interface Agg {
  readonly name: string;
  readonly fn: AggFn;
  readonly of: string;
}

/** One sort/order key: a column + a direction. The wire shape is `{"col":…,"dir":…}`. */
export interface SortKey {
  readonly col: string;
  readonly dir: SortDir;
}

/** A window step's specification. */
export interface WindowSpec {
  readonly partitionBy: readonly string[];
  readonly orderBy: readonly SortKey[];
  readonly fn: WindowFn;
  readonly of: string;
  readonly as: string;
}

/** A pivot step's specification. */
export interface PivotSpec {
  readonly index: readonly string[];
  readonly on: string;
  readonly values: string;
  readonly agg: AggFn;
}

/**
 * One transform step — the full v1 verb set. A pipeline is an ordered
 * `readonly Transform[]` over a `DataSource`.
 */
export type Transform =
  | { readonly kind: 'filter'; readonly pred: ColExpr }
  | { readonly kind: 'project'; readonly cols: readonly ColPair[] }
  | { readonly kind: 'derive'; readonly name: string; readonly expr: ColExpr }
  | { readonly kind: 'groupBy'; readonly keys: readonly string[]; readonly aggs: readonly Agg[] }
  | {
      readonly kind: 'join';
      readonly source: DataSource;
      readonly on: readonly ColPair[];
      readonly how: JoinKind;
    }
  | { readonly kind: 'window'; readonly spec: WindowSpec }
  | { readonly kind: 'pivot'; readonly spec: PivotSpec }
  | {
      readonly kind: 'unpivot';
      readonly idVars: readonly string[];
      readonly valueVars: readonly string[];
    }
  | { readonly kind: 'sort'; readonly by: readonly SortKey[] }
  | { readonly kind: 'distinct' }
  | { readonly kind: 'limit'; readonly n: number; readonly offset: number }
  | { readonly kind: 'union'; readonly source: DataSource };

// ─── Capability invocation (Phase 283 wire surface) ─────────────────────────

/**
 * One scalar `(addr, value)` argument of a capability invocation — the wire shape
 * is `{"addr":…,"value":…}`. Shared by `Binding.Invoke` and `Action.Invoke`. The
 * capability body is host-provided and never on the wire (Phase 283); the
 * renderer's dispatch seam + the `Deferred` async-value states are gated on the
 * Phase 283 capability runtime.
 */
export interface InvokeArg {
  readonly addr: string;
  readonly value: string;
}

/**
 * The async-value envelope a capability invocation resolves to (Phase 283/284) —
 * a shape-for-shape port of the F# `Fuaran.UI.Types.Deferred<'T>`
 * (`Pending | Ready of 'T | Error of message`). The renderer maps it onto the
 * binding `Resolution` surface — `Pending` → `NotResolved` (the node's
 * `onLoading` subtree), `Ready` → `Resolved`, `Error` → `Errored` (its
 * `onError`) — so an `Invoke` binding flows through the existing
 * `StateBehaviour` states with no new node. A genuinely-async host returns
 * `Pending` from its body until the realized value arrives.
 */
export type Deferred<T> =
  | { readonly kind: 'Pending' }
  | { readonly kind: 'Ready'; readonly value: T }
  | { readonly kind: 'Error'; readonly message: string };

/**
 * The host capability-dispatch seam (Phase 284) — given a `Binding.Invoke`'s /
 * `Action.Invoke`'s `capabilityId` + scalar `(addr, value)` args, return the
 * current `Deferred` resolution of the invocation. Port of the F#
 * `BindingResolver.CapabilityInvoker` (`string -> (string*string) list ->
 * Deferred<obj>`). A host builds one from a capability registry + a host-body
 * resolver (see `@fuaran-ui/ui`'s `makeCapabilityInvoker`) and threads it into
 * the renderer via `BindingSources.capabilityInvoker`; the default (an absent
 * seam) behaves as `Pending`, so an unwired `Invoke` shows its loading state.
 */
export type CapabilityInvoker = (
  capabilityId: string,
  args: readonly InvokeArg[],
) => Deferred<unknown>;

// ─── Capability declaration (port of Fuaran.Core.Function) ───────────────────
//
// The DECLARATION half of the capability contract, beside the invocation half
// above. It lives here rather than in the author surface because two packages
// need it and neither may depend on the other: `@fuaran-ui/ui` owns the
// capability RUNTIME (validate / invocationKey / registry / invoker) and
// `@fuaran-ui/ops` owns the canonical DECLARATION CODEC, and a codec whose
// types sit in the author package would need a dependency that inverts this
// workspace's layering. Both already depend on this package, so the shared
// shape belongs here — the same reason `HoleValueSpace` and `EffectClass` are
// in `types.ts` rather than beside the runtime that ranges over them.
// `@fuaran-ui/ui` re-exports all five, so its published surface is unchanged.

/**
 * One signature entry — the introspectable projection of a capability hole. A
 * `value` / `repeat` hole carries its value-`space`; a `slot` hole carries its
 * `slotKind` constraint (and no scalar space). Port of F# `SigEntry`; the value
 * space reuses `HoleValueSpace` (the same five cases).
 */
export interface CapabilitySigEntry {
  readonly addr: string;
  readonly name: string;
  readonly kind: 'value' | 'slot' | 'repeat';
  readonly space?: HoleValueSpace;
  readonly slotKind?: string;
  readonly required: boolean;
}

/** A capability's derived signature: which holes, what spaces, and its effect class. */
export interface CapabilitySignature {
  readonly name: string;
  readonly holes: readonly CapabilitySigEntry[];
  readonly effect: EffectClass;
}

/** Which client-island runtime a `ClientIsland` capability's body runs in. */
export type IslandKind = 'pyodide' | 'fable' | 'js';

/** Where a capability's body runs (spec §5) — a typed, portable placement contract. */
export type Placement =
  | { readonly kind: 'BuildTime' }
  | { readonly kind: 'Server' }
  | { readonly kind: 'ClientDeclarative' }
  | { readonly kind: 'ClientIsland'; readonly island: IslandKind }
  | { readonly kind: 'Precomputed' };

/**
 * A registrable, invocable runtime capability. `signature` (incl. its effect) is
 * the artifact-function projection; `determinism` is the capture-keying axis
 * (always `= signature.effect.determinism`, enforced by `createCapability`);
 * `placement` routes the host body. The wire carries this declaration + a typed
 * invocation, never the body. Port of F# `Capability`.
 */
export interface Capability {
  readonly id: string;
  readonly signature: CapabilitySignature;
  readonly determinism: DeterminismSource;
  readonly placement: Placement;
}

// ─── Evaluator error envelope (port of Fuaran.Core.EvalError) ────────────────

/**
 * The reference evaluator's recoverable error envelope — names the failure,
 * enumerates the alternatives where a closed set is expected. Returned by the
 * @fuaran-ui/ops evaluator (it never throws).
 */
export type EvalError =
  | { readonly kind: 'UnknownColumn'; readonly name: string; readonly available: readonly string[] }
  | { readonly kind: 'TypeError'; readonly detail: string }
  | { readonly kind: 'AggError'; readonly detail: string }
  | { readonly kind: 'JoinError'; readonly detail: string }
  | {
      readonly kind: 'ArityError';
      readonly fn: string;
      readonly expected: number;
      readonly got: number;
    }
  | { readonly kind: 'UnresolvedSource'; readonly ref: string }
  // fuaran-core#77 — a `ColExpr.param` referenced no binding in the evaluation env; names the missing
  // param + enumerates the bound names (strict: the evaluator never guesses a default).
  | { readonly kind: 'UnboundParam'; readonly name: string; readonly bound: readonly string[] };
