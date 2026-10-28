// Phase 2205 — the evaluator over typed columns: the row-set verbs gather typed
// vectors without boxing, a produced column is held at its type, and the cases a
// typed column cannot hold are refused by name rather than stored mixed.
import { describe, expect, it } from 'vitest';

import type { Cell, Table, Transform } from '@fuaran-ui/schema';

import { columnCells } from '../src/column.js';
import { aggregateCells, evalPipeline } from '../src/dataframe.js';
import { col } from './tables.js';

const N: Cell = { kind: 'Null' };
const I = (value: number): Cell => ({ kind: 'Int', value });
const F = (value: number): Cell => ({ kind: 'Float', value });
const S = (value: string): Cell => ({ kind: 'Str', value });

const people: Table = {
  schema: [
    { name: 'k', type: 'string' },
    { name: 'n', type: 'int' },
    { name: 'v', type: 'float' },
  ],
  columns: [
    col('k', 'string', [S('a'), S('b'), S('a'), S('c')]),
    col('n', 'int', [I(1), I(2), N, I(4)]),
    col('v', 'float', [F(0.5), N, F(1.5), F(2)]),
  ],
};

const run = (pipeline: Transform[], input: Table = people): Table => {
  const r = evalPipeline(pipeline, input);
  if (!r.ok) throw new Error(JSON.stringify(r.error));
  return r.value;
};

const cellsOf = (t: Table, name: string): Cell[] =>
  columnCells(t.columns.find((c) => c.name === name)!);

describe('the evaluator returns typed columns', () => {
  it('every output column is typed storage of its schema type', () => {
    const t = run([
      {
        kind: 'filter',
        pred: { kind: 'not', expr: { kind: 'isNull', expr: { kind: 'col', name: 'n' } } },
      },
      { kind: 'sort', by: [{ col: 'n', dir: 'desc' }] },
    ]);
    expect(t.columns.map((c) => c.data.kind)).toEqual(['Strs', 'Ints', 'Floats']);
    expect(cellsOf(t, 'n')).toEqual([I(4), I(2), I(1)]);
    expect(cellsOf(t, 'v')).toEqual([F(2), N, F(0.5)]);
  });

  it('a groupBy reads its aggregates from the typed vectors', () => {
    const t = run([
      {
        kind: 'groupBy',
        keys: ['k'],
        aggs: [
          { name: 'total', fn: 'sum', of: 'n' },
          { name: 'mean', fn: 'mean', of: 'v' },
          { name: 'count', fn: 'count', of: 'v' },
        ],
      },
    ]);
    expect(cellsOf(t, 'k')).toEqual([S('a'), S('b'), S('c')]);
    expect(cellsOf(t, 'total')).toEqual([I(1), I(2), I(4)]);
    expect(cellsOf(t, 'mean')).toEqual([F(1), N, F(2)]);
    expect(cellsOf(t, 'count')).toEqual([I(2), I(0), I(1)]);
    expect(t.columns.map((c) => c.data.kind)).toEqual(['Strs', 'Ints', 'Floats', 'Ints']);
  });

  it('an outer join pads the side without a match with absent rows of its own type', () => {
    const right: Table = {
      schema: [
        { name: 'k', type: 'string' },
        { name: 'w', type: 'int' },
      ],
      columns: [col('k', 'string', [S('b'), S('z')]), col('w', 'int', [I(20), I(99)])],
    };
    const t = run([
      {
        kind: 'join',
        source: { kind: 'Embedded', table: right },
        on: [{ a: 'k', b: 'k' }],
        how: 'outer',
      },
    ]);
    expect(cellsOf(t, 'k')).toEqual([S('a'), S('b'), S('a'), S('c'), N]);
    expect(cellsOf(t, 'w')).toEqual([N, I(20), N, N, I(99)]);
    expect(t.columns.find((c) => c.name === 'w')!.data.kind).toBe('Ints');
  });
});

describe('what a typed column needs ruled', () => {
  it('a union holds each column at the join of its two sides: int over float is float', () => {
    const other: Table = {
      schema: [
        { name: 'k', type: 'string' },
        { name: 'n', type: 'float' },
        { name: 'v', type: 'float' },
      ],
      columns: [col('k', 'string', [S('d')]), col('n', 'float', [F(2.5)]), col('v', 'float', [N])],
    };
    const t = run([{ kind: 'union', source: { kind: 'Embedded', table: other } }]);
    expect(t.schema.find((e) => e.name === 'n')!.type).toBe('float');
    expect(cellsOf(t, 'n')).toEqual([F(1), F(2), N, F(4), F(2.5)]);
  });

  it('a union of two types no column holds together is refused by name', () => {
    const other: Table = {
      schema: [
        { name: 'k', type: 'int' },
        { name: 'n', type: 'int' },
        { name: 'v', type: 'float' },
      ],
      columns: [col('k', 'int', [I(1)]), col('n', 'int', [I(1)]), col('v', 'float', [F(1)])],
    };
    const r = evalPipeline([{ kind: 'union', source: { kind: 'Embedded', table: other } }], people);
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind).toBe('TypeError');
  });

  it('a derived int outside 32 bits is refused, never stored wrapped', () => {
    const r = evalPipeline(
      [
        {
          kind: 'derive',
          name: 'big',
          expr: {
            kind: 'binary',
            op: 'mul',
            left: { kind: 'lit', cell: I(2147483647) },
            right: { kind: 'lit', cell: I(2) },
          },
        },
      ],
      people,
    );
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error.kind === 'TypeError' && r.error.detail).toContain('32-bit');
  });

  it('a cast of a non-canonical string to date is refused where the column is stored', () => {
    const r = evalPipeline(
      [
        {
          kind: 'derive',
          name: 'd',
          expr: { kind: 'cast', type: 'date', expr: { kind: 'lit', cell: S('2026-1-5') } },
        },
      ],
      people,
    );
    expect(r.ok).toBe(false);
  });

  it('aggregateCells refuses a cell its source type cannot hold', () => {
    expect(aggregateCells('sum', 'int', [I(1), I(2)])).toEqual({ ok: true, value: I(3) });
    expect(aggregateCells('sum', 'int', [S('x')]).ok).toBe(false);
  });
});
