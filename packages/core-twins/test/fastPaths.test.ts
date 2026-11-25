// Phase 1893 — the evaluator's fast paths answer exactly what the loops they replaced answered.
//
// Each technique the phase landed is pinned here against a brute-force oracle written from the
// verb's stated semantics, over the inputs where a fast path is most likely to part company with
// the slow one: the number family across an int and a float column (`1` = `1.0`, `-0` = `0`,
// NaN = NaN), a null (matches nothing), a decimal (matches only a decimal, by value), an instant
// at two units, and composite keys whose parts would collide if they were simply concatenated.
// The transform-law vectors pin the same answers on the corpus; this pins the edges the corpus
// does not draw.
import { describe, expect, it } from 'vitest';

import type { Cell, ColumnType, JoinKind, Table } from '@fuaran-ui/schema';

import { cellAt, columnLength, instantParts } from '../src/column.js';
import { decimalCompare } from '../src/decimalText.js';
import { aggregateCells, cellString, evalPipeline } from '../src/dataframe.js';
import { col } from './tables.js';

const N: Cell = { kind: 'Null' };
const I = (value: number): Cell => ({ kind: 'Int', value });
const F = (value: number): Cell => ({ kind: 'Float', value });
const S = (value: string): Cell => ({ kind: 'Str', value });
const M = (value: string): Cell => ({ kind: 'Decimal', value });
const D = (value: string): Cell => ({ kind: 'Date', value });
const T = (value: string): Cell => ({ kind: 'Timestamp', value });

type Spec = readonly (readonly [string, ColumnType, readonly Cell[]])[];

const table = (spec: Spec): Table => ({
  schema: spec.map(([name, type]) => ({ name, type })),
  columns: spec.map(([name, type, cells]) => col(name, type, cells)),
});

const rowsOf = (t: Table): Cell[][] => {
  const n = t.columns.length > 0 ? columnLength(t.columns[0]!) : 0;
  return Array.from({ length: n }, (_, i) => t.columns.map((c) => cellAt(c, i)));
};

const instantNanos = (text: string): number => {
  const p = instantParts(text, 9);
  if (typeof p === 'string') throw new Error(`${text}: ${p}`);
  return p.second * 1e9 + p.fraction;
};

/** The equi-join's equality, written out: no null matches, a decimal only a decimal. */
const oracleEq = (a: Cell, b: Cell): boolean => {
  if (a.kind === 'Null' || b.kind === 'Null') return false;
  const num = (c: Cell): number | undefined =>
    c.kind === 'Int' || c.kind === 'Float' ? c.value : undefined;
  const x = num(a);
  const y = num(b);
  if (x !== undefined && y !== undefined) return (Number.isNaN(x) && Number.isNaN(y)) || x === y;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'Decimal') return decimalCompare(a.value, (b as typeof a).value) === 0;
  if (a.kind === 'Timestamp') return instantNanos(a.value) === instantNanos((b as typeof a).value);
  return a.value === (b as typeof a).value;
};

/** The nested-loop join the hash join replaced, over the rows' cells. */
const oracleJoin = (
  left: Table,
  right: Table,
  on: readonly (readonly [string, string])[],
  how: JoinKind,
): Cell[][] => {
  const li = on.map(([a]) => left.schema.findIndex((e) => e.name === a));
  const ri = on.map(([, b]) => right.schema.findIndex((e) => e.name === b));
  const lr = rowsOf(left);
  const rr = rowsOf(right);
  const nullsL = left.schema.map(() => N);
  const nullsR = right.schema.map(() => N);
  const match = (l: Cell[], r: Cell[]): boolean =>
    li.every((ci, k) => oracleEq(l[ci]!, r[ri[k]!]!));
  const out: Cell[][] = [];
  for (const l of lr) {
    const hits = rr.filter((r) => match(l, r));
    for (const r of hits) out.push([...l, ...r]);
    if (hits.length === 0 && (how === 'left' || how === 'outer')) out.push([...l, ...nullsR]);
  }
  if (how === 'right' || how === 'outer')
    for (const r of rr) if (!lr.some((l) => match(l, r))) out.push([...nullsL, ...r]);
  return out;
};

const join = (
  left: Table,
  right: Table,
  on: readonly (readonly [string, string])[],
  how: JoinKind,
): Cell[][] => {
  const r = evalPipeline(
    [
      {
        kind: 'join',
        source: { kind: 'Embedded', table: right },
        on: on.map(([a, b]) => ({ a, b })),
        how,
      },
    ],
    left,
  );
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return rowsOf(r.value);
};

const HOWS: readonly JoinKind[] = ['inner', 'left', 'right', 'outer'];

const pairs: readonly (readonly [string, Table, Table, readonly (readonly [string, string])[]])[] =
  [
    [
      'a float key against an int key: 1 = 1.0, -0 = 0, NaN and null match nothing',
      table([
        ['k', 'float', [F(1), F(-0), F(NaN), N, F(2.5), F(1)]],
        ['a', 'int', [I(0), I(1), I(2), I(3), I(4), I(5)]],
      ]),
      table([
        ['rk', 'int', [I(1), I(0), I(3), N, I(1)]],
        ['b', 'int', [I(10), I(11), I(12), I(13), I(14)]],
      ]),
      [['k', 'rk']],
    ],
    [
      'NaN matches NaN across two float keys',
      table([['k', 'float', [F(NaN), F(0), N]]]),
      table([['rk', 'float', [F(-0), F(NaN), F(NaN)]]]),
      [['k', 'rk']],
    ],
    [
      'a decimal matches a decimal by value',
      table([['k', 'decimal', [M('1.50'), M('2.0'), M('3'), N]]]),
      table([['rk', 'decimal', [M('1.5'), M('2'), M('4'), M('3.000')]]]),
      [['k', 'rk']],
    ],
    [
      'a decimal never matches an int of the same value',
      table([['k', 'decimal', [M('1'), M('2')]]]),
      table([['rk', 'int', [I(1), I(2)]]]),
      [['k', 'rk']],
    ],
    [
      'an instant matches by the instant across two units',
      table([['k', 'timestamp_ms', [T('2026-01-01T00:00:00.5Z'), T('2026-01-01T00:00:01Z'), N]]]),
      table([
        [
          'rk',
          'timestamp_us',
          [
            T('2026-01-01T00:00:01Z'),
            T('2026-01-01T00:00:00.5Z'),
            T('2026-01-01T00:00:00.000001Z'),
          ],
        ],
      ]),
      [['k', 'rk']],
    ],
    [
      'a date never matches a string of the same text',
      table([['k', 'date', [D('2026-01-01')]]]),
      table([['rk', 'string', [S('2026-01-01')]]]),
      [['k', 'rk']],
    ],
    [
      'composite keys whose concatenations collide stay distinct',
      table([
        ['a', 'string', [S('ab'), S('a'), S('x'), S('x'), S('aS')]],
        ['b', 'string', [S('c'), S('bc'), N, S('y'), S('b')]],
      ]),
      table([
        ['ra', 'string', [S('a'), S('ab'), S('x'), S('x'), S('a')]],
        ['rb', 'string', [S('bc'), S('c'), S('y'), N, S('Sb')]],
      ]),
      [
        ['a', 'ra'],
        ['b', 'rb'],
      ],
    ],
  ];

describe('the hash join answers what the nested loop answered', () => {
  for (const [name, left, right, on] of pairs)
    for (const how of HOWS)
      it(`${name} (${how})`, () => {
        expect(join(left, right, on, how)).toEqual(oracleJoin(left, right, on, how));
      });
});

/** The pivot the one-pass bucketing replaced: every (on value, index group) cell a filter of the group. */
const oraclePivot = (t: Table, out: Table, agg: 'sum' | 'count'): Cell[][] => {
  const rows = rowsOf(t);
  const [idx, on, v] = [0, 1, 2];
  const groups: Cell[][][] = [];
  for (const r of rows) {
    const g = groups.find((g) => JSON.stringify(g[0]![idx]) === JSON.stringify(r[idx]));
    if (g === undefined) groups.push([r]);
    else g.push(r);
  }
  const names = out.schema.slice(1).map((e) => e.name);
  const onCells = names.map(
    (n) => rows.find((r) => r[on]!.kind !== 'Null' && cellString(r[on]!) === n)![on]!,
  );
  return groups.map((g) => [
    g[0]![idx]!,
    ...onCells.map((ov) => {
      const a = aggregateCells(
        agg,
        'float',
        g.filter((r) => oracleEq(r[on]!, ov)).map((r) => r[v]!),
      );
      if (!a.ok) throw new Error(JSON.stringify(a.error));
      return a.value;
    }),
  ]);
};

const pivotInputs: readonly (readonly [string, Table])[] = [
  [
    'float on values with NaN and nulls, a null index group',
    table([
      ['idx', 'string', [S('a'), S('b'), S('a'), N, S('a'), S('b'), N, S('b')]],
      ['on', 'float', [F(1), F(2), F(1), F(1), F(NaN), F(NaN), N, F(2)]],
      ['v', 'float', [F(1), F(2), F(3), F(4), F(5), F(6), F(7), N]],
    ]),
  ],
  [
    'decimal on values equal by value',
    table([
      ['idx', 'string', [S('a'), S('a'), S('b'), S('b')]],
      ['on', 'decimal', [M('1.50'), M('1.5'), M('2'), M('2.00')]],
      ['v', 'float', [F(1), F(2), F(3), F(4)]],
    ]),
  ],
];

describe('the one-pass pivot answers what the per-cell filter answered', () => {
  for (const [name, t] of pivotInputs)
    for (const agg of ['sum', 'count'] as const)
      it(`${name} (${agg})`, () => {
        const r = evalPipeline(
          [{ kind: 'pivot', spec: { index: ['idx'], on: 'on', values: 'v', agg } }],
          t,
        );
        if (!r.ok) throw new Error(JSON.stringify(r.error));
        expect(rowsOf(r.value)).toEqual(oraclePivot(t, r.value, agg));
      });
});

/** The cell order of two present cells of one column, written out. */
const oracleOrder = (a: Cell, b: Cell): number => {
  const cmp = (x: number | string | boolean, y: number | string | boolean): number =>
    x < y ? -1 : x > y ? 1 : 0;
  switch (a.kind) {
    case 'Int':
    case 'Float': {
      const x = a.value;
      const y = (b as typeof a).value;
      if (Number.isNaN(x) || Number.isNaN(y))
        return Number.isNaN(x) && Number.isNaN(y) ? 0 : Number.isNaN(x) ? 1 : -1;
      return cmp(x, y);
    }
    case 'Decimal':
      return decimalCompare(a.value, (b as typeof a).value) ?? 0;
    case 'Timestamp':
      return cmp(instantNanos(a.value), instantNanos((b as typeof a).value));
    case 'Null':
      return 0;
    default:
      return cmp(a.value, (b as typeof a).value);
  }
};

/** The boxed stable sort the typed comparator replaced: nulls last whatever the direction. */
const oracleSort = (t: Table, by: readonly (readonly [string, 'asc' | 'desc'])[]): Cell[][] => {
  const ks = by.map(([c, d]) => [t.schema.findIndex((e) => e.name === c), d] as const);
  return rowsOf(t)
    .map((r, i) => [r, i] as const)
    .sort(([x, i], [y, j]) => {
      for (const [ci, d] of ks) {
        const a = x[ci]!;
        const b = y[ci]!;
        if (a.kind === 'Null' || b.kind === 'Null') {
          if (a.kind !== b.kind) return a.kind === 'Null' ? 1 : -1;
          continue;
        }
        const c = oracleOrder(a, b);
        if (c !== 0) return d === 'asc' ? c : -c;
      }
      return i - j;
    })
    .map(([r]) => r);
};

const sortInput = table([
  ['f', 'float', [F(1), F(NaN), N, F(-0), F(0), F(-2.5), F(NaN), F(1)]],
  ['i', 'int', [I(3), I(1), I(2), N, I(1), I(3), I(2), I(1)]],
  ['s', 'string', [S('b'), S('a'), S('B'), S(''), N, S('a'), S('b'), S('ab')]],
  ['m', 'decimal', [M('1.50'), M('-1'), M('1.5'), N, M('10'), M('2'), M('0.1'), M('-0.5')]],
  [
    'd',
    'date',
    [
      D('2026-01-02'),
      D('1969-12-31'),
      N,
      D('2026-01-02'),
      D('0001-01-01'),
      D('9999-12-31'),
      D('2000-02-29'),
      N,
    ],
  ],
  [
    't',
    'timestamp_ms',
    [
      T('2026-01-01T00:00:00.5Z'),
      T('2026-01-01T00:00:00Z'),
      T('2026-01-01T00:00:00.05Z'),
      N,
      T('1969-12-31T23:59:59.999Z'),
      T('2026-01-01T00:00:00.5Z'),
      T('2026-01-01T00:00:01Z'),
      T('1970-01-01T00:00:00Z'),
    ],
  ],
  [
    'b',
    'bool',
    [
      { kind: 'Bool', value: true },
      { kind: 'Bool', value: false },
      N,
      { kind: 'Bool', value: true },
      { kind: 'Bool', value: false },
      N,
      { kind: 'Bool', value: true },
      { kind: 'Bool', value: false },
    ],
  ],
]);

const sortCases: readonly (readonly (readonly [string, 'asc' | 'desc'])[])[] = [
  ...['f', 'i', 's', 'm', 'd', 't', 'b'].flatMap((c) => [
    [[c, 'asc'] as const],
    [[c, 'desc'] as const],
  ]),
  [
    ['i', 'asc'],
    ['f', 'desc'],
  ],
  [
    ['b', 'desc'],
    ['s', 'asc'],
    ['t', 'desc'],
  ],
];

describe('the typed sort comparator orders as the boxed cell order did', () => {
  for (const by of sortCases)
    it(by.map(([c, d]) => c + ' ' + d).join(', '), () => {
      const r = evalPipeline(
        [{ kind: 'sort', by: by.map(([col, dir]) => ({ col, dir })) }],
        sortInput,
      );
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(rowsOf(r.value)).toEqual(oracleSort(sortInput, by));
    });

  it('a rank shares a rank between rows the order keys tie', () => {
    const r = evalPipeline(
      [
        {
          kind: 'window',
          spec: {
            partitionBy: [],
            orderBy: [{ col: 'i', dir: 'desc' }],
            fn: 'rank',
            of: 'i',
            as: 'r',
          },
        },
      ],
      sortInput,
    );
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    const ranks = rowsOf(r.value).map((row) => row[row.length - 1]);
    // i = [3, 1, 2, null, 1, 3, 2, 1] ordered desc, nulls last: 3 3 2 2 1 1 1 null.
    expect(ranks).toEqual([I(1), I(3), I(2), I(4), I(3), I(1), I(2), I(3)]);
  });
});
