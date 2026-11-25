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
import { evalPipeline } from '../src/dataframe.js';
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
