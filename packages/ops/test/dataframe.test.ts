// ============================================================================
//  Native-JS dataframe evaluator parity tests (Phase 284).
//
//  The evaluator's contract is byte-identity with the Fuaran.Core.DataFrame
//  reference: evaluate a pipeline → Table → `encodeDataSource(Embedded …)` and
//  compare the wire string (the same comparison `Conformance.transformLaws`
//  makes across hosts). These tests pin the load-bearing semantics — null
//  propagation, int↔float coercion, group/sort stability, round-half-away,
//  division-by-zero, the canonical float layout — and anchor the worked
//  grid-transform corpus pipeline end-to-end (decode → evaluate → encode).
// ============================================================================

import type { Cell, ColumnType, DataSource, Table, Transform } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '../src/decode.js';
import { encodeDataSource } from '../src/encode.js';
import { evalPipeline } from '../src/dataframe.js';

// ─── tiny table builders ─────────────────────────────────────────────────────

const I = (n: number): Cell => ({ kind: 'Int', value: n });
const F = (n: number): Cell => ({ kind: 'Float', value: n });
const S = (s: string): Cell => ({ kind: 'Str', value: s });
const B = (b: boolean): Cell => ({ kind: 'Bool', value: b });
const N: Cell = { kind: 'Null' };

const table = (schema: readonly [string, ColumnType][], cols: Record<string, Cell[]>): Table => ({
  schema: schema.map(([name, type]) => ({ name, type })),
  columns: schema.map(([name, type]) => ({ name, type, cells: cols[name]! })),
});

const run = (pipeline: Transform[], input: Table): string => {
  const r = evalPipeline(pipeline, input);
  if (!r.ok) throw new Error(`eval failed: ${JSON.stringify(r.error)}`);
  return encodeDataSource({ kind: 'Embedded', table: r.value });
};

// ─── the worked corpus pipeline, end-to-end ──────────────────────────────────

describe('grid-transform corpus pipeline (decode → evaluate → encode)', () => {
  it('filter amount>0 → groupBy dept sum → sort total desc', () => {
    // The fixture node carries the Transform binding in kind.source.
    const fixture =
      '{"id":"grid-transform","kind":{"$type":"DataGrid","columns":[],"editable":false,"rowKey":"<closure>","source":{"$type":"Transform","pipeline":[{"$type":"filter","pred":{"$type":"binary","left":{"$type":"col","name":"amount"},"op":"gt","right":{"$type":"lit","cell":{"$type":"Int","value":0}}}},{"$type":"groupBy","aggs":[{"fn":"sum","name":"total","of":"amount"}],"keys":["dept"]},{"$type":"sort","by":[{"col":"total","dir":"desc"}]}],"source":{"columns":{"amount":{"validity":[true,true,false],"values":[100,120,0]},"dept":{"validity":[true,true,true],"values":["eng","eng","sales"]}},"schema":[{"name":"dept","type":"string"},{"name":"amount","type":"int"}]}}}}';
    const decoded = decodeNode(fixture);
    expect(decoded.ok).toBe(true);
    if (!decoded.ok) return;
    const kind = decoded.value.kind;
    expect(kind.kind).toBe('Visualisation');
    if (kind.kind !== 'Visualisation' || kind.visualisation.kind !== 'Grid') return;
    const source = kind.visualisation.spec.source as unknown as {
      kind: string;
      source: DataSource;
      pipeline: Transform[];
    };
    expect(source.kind).toBe('Transform');
    expect(source.source.kind).toBe('Embedded');
    if (source.source.kind !== 'Embedded') return;
    const out = run(source.pipeline, source.source.table);
    expect(out).toBe(
      '{"columns":{"dept":{"validity":[true],"values":["eng"]},"total":{"validity":[true],"values":[220]}},"schema":[{"name":"dept","type":"string"},{"name":"total","type":"int"}]}',
    );
  });
});

// ─── pinned semantics ────────────────────────────────────────────────────────

describe('pinned evaluator semantics', () => {
  it('null propagates through arithmetic (any null operand ⇒ null)', () => {
    const t = table([['a', 'int']], { a: [I(1), N] });
    const out = run(
      [
        {
          kind: 'derive',
          name: 'b',
          expr: {
            kind: 'binary',
            op: 'add',
            left: { kind: 'col', name: 'a' },
            right: { kind: 'lit', cell: I(10) },
          },
        },
      ],
      t,
    );
    // row0: 1+10=11; row1: null+10=null → validity false, int default 0
    expect(out).toBe(
      '{"columns":{"a":{"validity":[true,false],"values":[1,0]},"b":{"validity":[true,false],"values":[11,0]}},"schema":[{"name":"a","type":"int"},{"name":"b","type":"int"}]}',
    );
  });

  it('int + float coerces to float', () => {
    const t = table([['a', 'int']], { a: [I(3)] });
    const out = run(
      [
        {
          kind: 'derive',
          name: 'b',
          expr: {
            kind: 'binary',
            op: 'add',
            left: { kind: 'col', name: 'a' },
            right: { kind: 'lit', cell: F(0.5) },
          },
        },
      ],
      t,
    );
    expect(out).toBe(
      '{"columns":{"a":{"validity":[true],"values":[3]},"b":{"validity":[true],"values":[3.5]}},"schema":[{"name":"a","type":"int"},{"name":"b","type":"float"}]}',
    );
  });

  it('division by zero ⇒ null (column stays float via the present row)', () => {
    const t = table(
      [
        ['a', 'int'],
        ['c', 'int'],
      ],
      { a: [I(5), I(6)], c: [I(0), I(2)] },
    );
    const out = run(
      [
        {
          kind: 'derive',
          name: 'b',
          expr: {
            kind: 'binary',
            op: 'div',
            left: { kind: 'col', name: 'a' },
            right: { kind: 'col', name: 'c' },
          },
        },
      ],
      t,
    );
    // row0: 5/0 ⇒ null; row1: 6/2 ⇒ 3.0 (div always yields Float). The present
    // float fixes the inferred column type to float; the null cell → default 0.
    expect(out).toBe(
      '{"columns":{"a":{"validity":[true,true],"values":[5,6]},"b":{"validity":[false,true],"values":[0,3]},"c":{"validity":[true,true],"values":[0,2]}},"schema":[{"name":"a","type":"int"},{"name":"c","type":"int"},{"name":"b","type":"float"}]}',
    );
  });

  it('sort puts nulls last regardless of direction (stable)', () => {
    const asc = run(
      [{ kind: 'sort', by: [{ col: 'a', dir: 'asc' }] }],
      table([['a', 'int']], { a: [I(2), N, I(1)] }),
    );
    expect(asc).toBe(
      '{"columns":{"a":{"validity":[true,true,false],"values":[1,2,0]}},"schema":[{"name":"a","type":"int"}]}',
    );
    const desc = run(
      [{ kind: 'sort', by: [{ col: 'a', dir: 'desc' }] }],
      table([['a', 'int']], { a: [I(2), N, I(1)] }),
    );
    expect(desc).toBe(
      '{"columns":{"a":{"validity":[true,true,false],"values":[2,1,0]}},"schema":[{"name":"a","type":"int"}]}',
    );
  });

  it('groupBy emits groups in first-appearance order', () => {
    const t = table(
      [
        ['k', 'string'],
        ['v', 'int'],
      ],
      { k: [S('b'), S('a'), S('b')], v: [I(1), I(2), I(3)] },
    );
    const out = run(
      [{ kind: 'groupBy', keys: ['k'], aggs: [{ name: 'n', fn: 'count', of: 'v' }] }],
      t,
    );
    // 'b' appears first, then 'a'
    expect(out).toBe(
      '{"columns":{"k":{"validity":[true,true],"values":["b","a"]},"n":{"validity":[true,true],"values":[2,1]}},"schema":[{"name":"k","type":"string"},{"name":"n","type":"int"}]}',
    );
  });

  it('round is half-away-from-zero (not banker’s)', () => {
    const t = table([['a', 'float']], { a: [F(0.5), F(1.5), F(2.5), F(-0.5)] });
    const out = run(
      [
        {
          kind: 'derive',
          name: 'r',
          expr: { kind: 'apply', fn: 'round', args: [{ kind: 'col', name: 'a' }] },
        },
      ],
      t,
    );
    // half-away: 0.5→1, 1.5→2, 2.5→3, -0.5→-1 (banker's would give 0,2,2,0)
    expect(out).toContain('"r":{"validity":[true,true,true,true],"values":[1,2,3,-1]}');
  });

  it('Count is the non-null count; Sum of an all-null group is null', () => {
    const t = table(
      [
        ['k', 'string'],
        ['v', 'int'],
      ],
      { k: [S('a'), S('a')], v: [N, N] },
    );
    const out = run(
      [
        {
          kind: 'groupBy',
          keys: ['k'],
          aggs: [
            { name: 'c', fn: 'count', of: 'v' },
            { name: 's', fn: 'sum', of: 'v' },
          ],
        },
      ],
      t,
    );
    // object keys are Canon-sorted (c < k < s); the schema array keeps column order (k, c, s).
    expect(out).toBe(
      '{"columns":{"c":{"validity":[true],"values":[0]},"k":{"validity":[true],"values":["a"]},"s":{"validity":[false],"values":[0]}},"schema":[{"name":"k","type":"string"},{"name":"c","type":"int"},{"name":"s","type":"int"}]}',
    );
  });

  it('Kleene logic: false AND null ⇒ false; true OR null ⇒ true; null otherwise', () => {
    const t = table([['a', 'bool']], { a: [B(false), B(true), N] });
    const out = run(
      [
        {
          kind: 'derive',
          name: 'r',
          expr: {
            kind: 'binary',
            op: 'and',
            left: { kind: 'col', name: 'a' },
            right: { kind: 'lit', cell: N },
          },
        },
      ],
      t,
    );
    // false AND null = false; true AND null = null; null AND null = null
    expect(out).toContain('"r":{"validity":[true,false,false],"values":[false,false,false]}');
  });

  it('filter drops rows whose predicate is null or false', () => {
    const t = table([['a', 'int']], { a: [I(1), I(-1), N] });
    const out = run(
      [
        {
          kind: 'filter',
          pred: {
            kind: 'binary',
            op: 'gt',
            left: { kind: 'col', name: 'a' },
            right: { kind: 'lit', cell: I(0) },
          },
        },
      ],
      t,
    );
    expect(out).toBe(
      '{"columns":{"a":{"validity":[true],"values":[1]}},"schema":[{"name":"a","type":"int"}]}',
    );
  });

  it('distinct dedupes whole rows, preserving first-appearance order', () => {
    const t = table(
      [
        ['a', 'int'],
        ['b', 'string'],
      ],
      { a: [I(1), I(1), I(2)], b: [S('x'), S('x'), S('y')] },
    );
    const out = run([{ kind: 'distinct' }], t);
    expect(out).toBe(
      '{"columns":{"a":{"validity":[true,true],"values":[1,2]},"b":{"validity":[true,true],"values":["x","y"]}},"schema":[{"name":"a","type":"int"},{"name":"b","type":"string"}]}',
    );
  });

  it('an unknown column is a recoverable EvalError, never a throw', () => {
    const r = evalPipeline(
      [{ kind: 'sort', by: [{ col: 'a', dir: 'asc' }] }],
      table([['x', 'int']], { x: [I(1)] }),
    );
    // sort ignores a missing key (matches the reference) → ok with input unchanged
    expect(r.ok).toBe(true);
    const bad = evalPipeline(
      [{ kind: 'filter', pred: { kind: 'col', name: 'nope' } }],
      table([['x', 'int']], { x: [I(1)] }),
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error.kind).toBe('UnknownColumn');
  });
});

// ─── fuaran-core#90 — expression-algebra completion (pinned parity) ──────────

describe('fuaran-core#90 string/membership/null/date additions', () => {
  const people = table(
    [
      ['name', 'string'],
      ['salary', 'int'],
    ],
    { name: [S('ana'), S('bob'), S('dee')], salary: [I(100), I(120), N] },
  );

  const cells = (pipeline: Transform[], col: string): Cell[] => {
    const r = evalPipeline(pipeline, people);
    if (!r.ok) throw new Error('eval failed');
    return [...(r.value.columns.find((c) => c.name === col)?.cells ?? [])];
  };

  const lit = (c: Cell) => ({ kind: 'lit', cell: c }) as const;
  const colE = (name: string) => ({ kind: 'col', name }) as const;

  it('contains filters ordinally; the Lower idiom is case-insensitive', () => {
    expect(
      cells(
        [
          {
            kind: 'filter',
            pred: { kind: 'binary', op: 'contains', left: colE('name'), right: lit(S('e')) },
          },
        ],
        'name',
      ),
    ).toEqual([S('dee')]);
    expect(
      cells(
        [
          {
            kind: 'filter',
            pred: {
              kind: 'binary',
              op: 'contains',
              left: { kind: 'apply', fn: 'lower', args: [colE('name')] },
              right: { kind: 'apply', fn: 'lower', args: [lit(S('AN'))] },
            },
          },
        ],
        'name',
      ),
    ).toEqual([S('ana')]);
  });

  it('concat stringifies non-null args and propagates null', () => {
    expect(
      cells(
        [
          {
            kind: 'derive',
            name: 'x',
            expr: {
              kind: 'apply',
              fn: 'concat',
              args: [colE('name'), lit(S(' #')), colE('salary')],
            },
          },
        ],
        'x',
      ),
    ).toEqual([S('ana #100'), S('bob #120'), N]);
  });

  it('trim strips exactly the pinned ASCII set (NBSP survives)', () => {
    expect(
      cells(
        [
          {
            kind: 'derive',
            name: 'x',
            expr: { kind: 'apply', fn: 'trim', args: [lit(S('\t p \r\n '))] },
          },
        ],
        'x',
      )[0],
    ).toEqual(S('p'));
    expect(
      cells(
        [{ kind: 'derive', name: 'x', expr: { kind: 'apply', fn: 'trim', args: [lit(S(' x'))] } }],
        'x',
      )[0],
    ).toEqual(S(' x'));
  });

  it('replace is literal replace-all; empty find is the identity', () => {
    const go = (find: string) =>
      cells(
        [
          {
            kind: 'derive',
            name: 'x',
            expr: {
              kind: 'apply',
              fn: 'replace',
              args: [lit(S('banana')), lit(S(find)), lit(S('o'))],
            },
          },
        ],
        'x',
      )[0];
    expect(go('a')).toEqual(S('bonono'));
    expect(go('')).toEqual(S('banana'));
  });

  it('dateDiffDays is civil-day arithmetic (leap year pinned)', () => {
    const go = (a: string, b: string) =>
      cells(
        [
          {
            kind: 'derive',
            name: 'x',
            expr: { kind: 'apply', fn: 'dateDiffDays', args: [lit(S(a)), lit(S(b))] },
          },
        ],
        'x',
      )[0];
    expect(go('2024-02-28', '2024-03-01')).toEqual(I(2));
    expect(go('2023-02-28', '2023-03-01')).toEqual(I(1));
    expect(go('2026-07-18', '2026-07-01')).toEqual(I(-17));
    expect(go('2026-07-18', '2026-07-18T14:30:00')).toEqual(I(0));
  });

  it('in is SQL three-valued; isNull is total', () => {
    expect(
      cells(
        [
          {
            kind: 'derive',
            name: 'x',
            expr: { kind: 'in', expr: colE('salary'), items: [lit(I(120)), lit(N)] },
          },
        ],
        'x',
      ),
    ).toEqual([N, B(true), N]);
    expect(
      cells([{ kind: 'derive', name: 'x', expr: { kind: 'isNull', expr: colE('salary') } }], 'x'),
    ).toEqual([B(false), B(false), B(true)]);
  });
});
