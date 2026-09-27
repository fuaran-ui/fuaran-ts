// ============================================================================
//  @fuaran-ui/ui — the static output-schema walk over a Transform pipeline
//  (Phase 1889; a port of `Fuaran.Core.SchemaWalk` and the expression typer
//  it asks for a `derive`d column's type, `Fuaran.Core.DataFrame` 0.34.0).
//
//  Total and evaluates nothing: every case is a rearrangement of names and
//  declared types. It carries its own ignorance in its SHAPE — `Closed` means
//  these columns and no others, `AtLeast` means these are present and the rest
//  are unnameable — and only `Closed` supports a negative verdict. That is the
//  restraint the pre-emit grounding rules (FUARAN086 / 087 / 097 / 114) stand
//  on: refuse only what is PROVABLY wrong.
//
//  The port is over THIS host's transform algebra, which is a subset of the
//  reference's (no `intersect` / `except`, no filtering joins, a smaller scalar
//  and window vocabulary). A document carrying a verb outside it is refused by
//  this host's decoder before any walk runs, so the subset is not a divergence
//  in what a decoded tree means. Every rule below is the reference's rule for
//  the same verb, and each unresolved-knowledge `reason` is the reference's
//  sentence, so the two hosts state an open schema the same way.
// ============================================================================

import type {
  AggFn,
  BinOp,
  Cell,
  ColExpr,
  ColumnType,
  DataSource,
  ScalarFn,
  Transform,
  WindowSpec,
} from '@fuaran-ui/schema';

/** One column the walk can name. `type` is absent where it is data-dependent. */
export interface ColumnKnowledge {
  readonly name: string;
  readonly type?: ColumnType;
}

/** What is statically known about the columns a pipeline produces. */
export type SchemaKnowledge =
  /** These columns and no others: an absence is a fact. */
  | { readonly kind: 'Closed'; readonly columns: readonly ColumnKnowledge[] }
  /** These columns at least; the rest cannot be named, for `reason`. */
  | {
      readonly kind: 'AtLeast';
      readonly columns: readonly ColumnKnowledge[];
      readonly reason: string;
    };

export const schemaNames = (k: SchemaKnowledge): readonly string[] => k.columns.map((c) => c.name);

export const schemaHas = (name: string, k: SchemaKnowledge): boolean =>
  k.columns.some((c) => c.name === name);

/** The declared type of a named column; `undefined` when absent OR undecidable (ask `schemaHas`). */
export const schemaTypeOf = (name: string, k: SchemaKnowledge): ColumnType | undefined =>
  k.columns.find((c) => c.name === name)?.type;

const withColumns = (cols: readonly ColumnKnowledge[], k: SchemaKnowledge): SchemaKnowledge =>
  k.kind === 'Closed'
    ? { kind: 'Closed', columns: cols }
    : { kind: 'AtLeast', columns: cols, reason: k.reason };

const col = (name: string, type: ColumnType | undefined): ColumnKnowledge =>
  type === undefined ? { name } : { name, type };

/** What is known about a source before any step runs. A `Ref` is unknown here: this host has no resolver. */
export const ofSource = (source: DataSource): SchemaKnowledge =>
  source.kind === 'Embedded'
    ? { kind: 'Closed', columns: source.table.schema.map((e) => col(e.name, e.type)) }
    : {
        kind: 'AtLeast',
        columns: [],
        reason: `source '${source.name}' is a Ref with no declared schema`,
      };

// ── The expression typer (the reference's `Typing`) ─────────────────────────
//
// What a node's PRESENT values can be: never any (`absent` — a null literal),
// always one type (`of`), or undecidable from the schema (`unknown`).

type Typing =
  | { readonly t: 'absent' }
  | { readonly t: 'of'; readonly ty: ColumnType }
  | { readonly t: 'unknown' };

const ABSENT: Typing = { t: 'absent' };
const UNKNOWN: Typing = { t: 'unknown' };
const of = (ty: ColumnType): Typing => ({ t: 'of', ty });

const join = (a: Typing, b: Typing): Typing => {
  if (a.t === 'absent') return b;
  if (b.t === 'absent') return a;
  if (a.t === 'of' && b.t === 'of') return a.ty === b.ty ? a : UNKNOWN;
  return UNKNOWN;
};

const joinAll = (ts: readonly Typing[]): Typing => ts.reduce(join, ABSENT);

const isOf = (t: Typing, ...tys: ColumnType[]): boolean => t.t === 'of' && tys.includes(t.ty);

const ofCell = (c: Cell): Typing => {
  switch (c.kind) {
    case 'Int':
      return of('int');
    case 'Float':
      return of('float');
    case 'Bool':
      return of('bool');
    case 'Str':
      return of('string');
    case 'Date':
      return of('date');
    case 'Timestamp':
      return of('timestamp');
    case 'Null':
      return ABSENT;
  }
};

const binary = (op: BinOp, a: Typing, b: Typing): Typing => {
  const nullPropagating = (decide: () => Typing): Typing =>
    a.t === 'absent' || b.t === 'absent' ? ABSENT : decide();
  const numeric = (t: Typing): boolean => isOf(t, 'int', 'float');
  const boolLike = (t: Typing): boolean => t.t === 'absent' || isOf(t, 'bool');

  switch (op) {
    case 'add':
    case 'sub':
    case 'mul':
      return nullPropagating(() =>
        isOf(a, 'int') && isOf(b, 'int')
          ? of('int')
          : numeric(a) && numeric(b)
            ? of('float')
            : UNKNOWN,
      );
    case 'div':
      return nullPropagating(() => (numeric(a) && numeric(b) ? of('float') : UNKNOWN));
    case 'mod':
      return nullPropagating(() => (isOf(a, 'int') && isOf(b, 'int') ? of('int') : UNKNOWN));
    case 'eq':
    case 'ne':
    case 'lt':
    case 'le':
    case 'gt':
    case 'ge':
      return nullPropagating(() => {
        if (numeric(a) && numeric(b)) return of('bool');
        if (a.t === 'of' && b.t === 'of' && a.ty === b.ty && a.ty !== 'int' && a.ty !== 'float')
          return of('bool');
        return UNKNOWN;
      });
    case 'and':
    case 'or':
      return boolLike(a) && boolLike(b) ? join(a, b) : UNKNOWN;
    case 'contains':
    case 'startsWith':
    case 'endsWith':
      return nullPropagating(() => (isOf(a, 'string') && isOf(b, 'string') ? of('bool') : UNKNOWN));
  }
};

const applyFn = (fn: ScalarFn, args: readonly Typing[]): Typing => {
  const arity = (n: number): boolean => args.length === n;
  const anyAbsent = args.some((t) => t.t === 'absent');
  const unary = (decide: (t: Typing) => Typing): Typing => {
    if (!arity(1)) return ABSENT;
    const t = args[0]!;
    return t.t === 'absent' ? ABSENT : decide(t);
  };

  switch (fn) {
    case 'abs':
      return unary((t) => (isOf(t, 'int') ? of('int') : isOf(t, 'float') ? of('float') : UNKNOWN));
    case 'round':
    case 'floor':
    case 'ceil':
      return unary(() => of('float'));
    case 'length':
      return unary(() => of('int'));
    case 'lower':
    case 'upper':
    case 'trim':
      return unary(() => of('string'));
    case 'substr':
      return !arity(3) ? ABSENT : args[0]!.t === 'absent' ? ABSENT : of('string');
    case 'datePart':
      return !arity(2) ? ABSENT : args[1]!.t === 'absent' ? ABSENT : of('int');
    case 'concat':
      return args.length === 0 || anyAbsent ? ABSENT : of('string');
    case 'replace':
      return !arity(3) || anyAbsent ? ABSENT : of('string');
    case 'dateDiffDays':
      return !arity(2) || anyAbsent ? ABSENT : of('int');
  }
};

const typing = (cols: readonly ColumnKnowledge[], e: ColExpr): Typing => {
  const go = (x: ColExpr): Typing => typing(cols, x);
  switch (e.kind) {
    case 'col': {
      // A column the walk cannot type reads as absent from the schema — so the
      // expression is undecidable rather than anything false.
      const ty = cols.find((c) => c.name === e.name)?.type;
      return ty === undefined ? UNKNOWN : of(ty);
    }
    case 'lit':
      return ofCell(e.cell);
    case 'param':
      return UNKNOWN;
    case 'binary':
      return binary(e.op, go(e.left), go(e.right));
    case 'not': {
      const a = go(e.expr);
      return a.t === 'absent' ? ABSENT : isOf(a, 'bool') ? of('bool') : UNKNOWN;
    }
    case 'coalesce':
      return joinAll(e.exprs.map(go));
    case 'case':
      return joinAll([go(e.else), ...e.cases.map((c) => go(c.then))]);
    case 'cast':
      return go(e.expr).t === 'absent' ? ABSENT : of(e.type);
    case 'apply':
      return applyFn(e.fn, e.args.map(go));
    case 'in':
    case 'inParam':
      return go(e.expr).t === 'absent' ? ABSENT : of('bool');
    case 'isNull':
      return of('bool');
  }
};

/**
 * The type a `derive` of `e` produces, where the expression alone decides it —
 * the reference's rule: the evaluator types a derived column from its first
 * present cell and falls back to `string` when there is none, so only an
 * expression whose present values are all strings (or that has none) is
 * decidable on every frame.
 */
const derivedColumnType = (
  cols: readonly ColumnKnowledge[],
  e: ColExpr,
): ColumnType | undefined => {
  const t = typing(cols, e);
  return t.t === 'absent' || isOf(t, 'string') ? 'string' : undefined;
};

const aggregateType = (fn: AggFn, source: ColumnType | undefined): ColumnType | undefined => {
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
      return source;
  }
};

const windowType = (input: SchemaKnowledge, spec: WindowSpec): ColumnType | undefined => {
  switch (spec.fn) {
    case 'rowNumber':
    case 'rank':
      return 'int';
    case 'cumulSum':
    case 'rollingMean':
      return 'float';
    case 'lag':
    case 'lead':
      return schemaTypeOf(spec.of, input);
  }
};

/** The output knowledge of ONE step over an input knowledge. */
export const ofTransform = (input: SchemaKnowledge, step: Transform): SchemaKnowledge => {
  switch (step.kind) {
    case 'filter':
    case 'sort':
    case 'distinct':
    case 'limit':
    case 'union':
      return input;
    case 'project':
      return {
        kind: 'Closed',
        columns: step.cols.map((p) => col(p.b, schemaTypeOf(p.a, input))),
      };
    case 'derive': {
      const derived = col(step.name, derivedColumnType(input.columns, step.expr));
      return input.columns.some((c) => c.name === step.name)
        ? withColumns(
            input.columns.map((c) => (c.name === step.name ? derived : c)),
            input,
          )
        : withColumns([...input.columns, derived], input);
    }
    case 'groupBy':
      return {
        kind: 'Closed',
        columns: [
          ...step.keys.map((key) => col(key, schemaTypeOf(key, input))),
          ...step.aggs.map((a) => col(a.name, aggregateType(a.fn, schemaTypeOf(a.of, input)))),
        ],
      };
    case 'window':
      // Appended unconditionally, duplicate name included — the evaluator's shape.
      return withColumns(
        [...input.columns, col(step.spec.as, windowType(input, step.spec))],
        input,
      );
    case 'pivot':
      return {
        kind: 'AtLeast',
        columns: step.spec.index.map((name) => col(name, schemaTypeOf(name, input))),
        reason:
          "a pivot's value columns are named by the data — one per distinct value in its `on` column",
      };
    case 'unpivot': {
      const valueType =
        step.valueVars.length === 0
          ? 'string'
          : step.valueVars.map((n) => schemaTypeOf(n, input)).find((t) => t !== undefined);
      return {
        kind: 'Closed',
        columns: [
          ...step.idVars.map((name) => col(name, schemaTypeOf(name, input))),
          { name: 'variable', type: 'string' },
          col('value', valueType),
        ],
      };
    }
    case 'join': {
      if (input.kind === 'AtLeast')
        return {
          kind: 'AtLeast',
          columns: input.columns,
          reason:
            input.reason +
            " — and a join's right-hand output names depend on the left's, so they cannot be named either",
        };
      const right = ofSource(step.source);
      const leftNames = new Set(input.columns.map((c) => c.name));
      const renamed = right.columns.map((c) =>
        leftNames.has(c.name) ? { ...c, name: `${c.name}_right` } : c,
      );
      const columns = [...input.columns, ...renamed];
      return right.kind === 'Closed'
        ? { kind: 'Closed', columns }
        : { kind: 'AtLeast', columns, reason: right.reason };
    }
  }
};

/** The output knowledge of a whole pipeline over a source. Total. */
export const ofPipeline = (source: DataSource, pipeline: readonly Transform[]): SchemaKnowledge =>
  pipeline.reduce(ofTransform, ofSource(source));
