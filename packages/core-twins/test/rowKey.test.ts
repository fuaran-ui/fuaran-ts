// A row key separates its cells: two different rows never share one, whatever text a cell holds.
//
// Every verb that partitions or matches rows by the token relation (distinct, groupBy, a window's
// partitions, pivot's index groups, intersect / except) keys a row on its cells' keys together. A
// cell's text may contain any character, the key's own separator included, so the key must be
// injective over the list of cell keys: the reference's `rowTokenString` length-prefixes each cell's
// token for exactly this reason. The witness below is two rows whose cells, joined by a bare
// separator, spell the same string.
import { describe, expect, it } from 'vitest';

import type { Cell, ColumnType, Table } from '@fuaran-ui/schema';

import { cellAt, columnLength } from '../src/column.js';
import { evalPipeline } from '../src/dataframe.js';
import { col } from './tables.js';

const S = (value: string): Cell => ({ kind: 'Str', value });
const I = (value: number): Cell => ({ kind: 'Int', value });
const F = (value: number): Cell => ({ kind: 'Float', value });
const M = (value: string): Cell => ({ kind: 'Decimal', value });

type Spec = readonly (readonly [string, ColumnType, readonly Cell[]])[];

const table = (spec: Spec): Table => ({
  schema: spec.map(([name, type]) => ({ name, type })),
  columns: spec.map(([name, type, cells]) => col(name, type, cells)),
});

const rowsOf = (t: Table): Cell[][] => {
  const n = t.columns.length > 0 ? columnLength(t.columns[0]!) : 0;
  return Array.from({ length: n }, (_, i) => t.columns.map((c) => cellAt(c, i)));
};

const run = (t: Table, step: Parameters<typeof evalPipeline>[0][number]): Cell[][] => {
  const r = evalPipeline([step], t);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return rowsOf(r.value);
};

// ("x\u0001Sy", "z") and ("x", "y\u0001Sz"): joined with a bare U+0001 after each cell's `S` tag,
// both spell `Sx\u0001Sy\u0001Sz`.
const rowA = [S('x\u0001Sy'), S('z')];
const rowB = [S('x'), S('y\u0001Sz')];
const two = (a: readonly Cell[], b: readonly Cell[]): Table =>
  table([
    ['a', 'string', [a[0]!, b[0]!]],
    ['b', 'string', [a[1]!, b[1]!]],
  ]);
const witness = two(rowA, rowB);
const onlyA = table([
  ['a', 'string', [rowA[0]!]],
  ['b', 'string', [rowA[1]!]],
]);
const onlyB = table([
  ['a', 'string', [rowB[0]!]],
  ['b', 'string', [rowB[1]!]],
]);

describe('row keys are injective over their cells', () => {
  it('distinct keeps two rows whose cells concatenate alike', () => {
    expect(run(witness, { kind: 'distinct' })).toEqual([rowA, rowB]);
  });

  it('groupBy puts two such rows in two groups', () => {
    expect(
      run(witness, {
        kind: 'groupBy',
        keys: ['a', 'b'],
        aggs: [{ name: 'n', fn: 'count', of: 'a' }],
      }),
    ).toEqual([
      [...rowA, I(1)],
      [...rowB, I(1)],
    ]);
  });

  it('intersect does not match one such row with the other', () => {
    expect(run(onlyA, { kind: 'intersect', source: { kind: 'Embedded', table: onlyB } })).toEqual(
      [],
    );
  });

  it('except keeps a row the other side holds only a look-alike of', () => {
    expect(run(onlyA, { kind: 'except', source: { kind: 'Embedded', table: onlyB } })).toEqual([
      rowA,
    ]);
  });

  it('a window partitions two such rows apart', () => {
    const r = run(witness, {
      kind: 'window',
      spec: { partitionBy: ['a', 'b'], orderBy: [], fn: 'rowNumber', of: 'a', as: 'r' },
    });
    expect(r.map((row) => row[2])).toEqual([I(1), I(1)]);
  });

  it('pivot keeps two such index rows apart', () => {
    const t = table([
      ['a', 'string', [rowA[0]!, rowB[0]!]],
      ['b', 'string', [rowA[1]!, rowB[1]!]],
      ['k', 'string', [S('p'), S('p')]],
      ['v', 'int', [I(1), I(2)]],
    ]);
    const r = run(t, {
      kind: 'pivot',
      spec: { index: ['a', 'b'], on: 'k', values: 'v', agg: 'sum' },
    });
    expect(r.length).toBe(2);
  });

  it('separation does not change which cells are equal', () => {
    // Equal rows still dedup: a decimal by value, a float NaN with a NaN and -0 with 0; an int and a
    // float of one value stay two cells under the token relation.
    const t = table([
      ['m', 'decimal', [M('1.50'), M('1.5'), M('2')]],
      ['f', 'float', [F(NaN), F(NaN), F(-0)]],
      ['s', 'string', [S('a'), S('a'), S('a')]],
    ]);
    expect(run(t, { kind: 'distinct' })).toHaveLength(2);
  });
});
