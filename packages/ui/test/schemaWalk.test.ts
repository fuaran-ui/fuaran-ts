// Phase 1889 — the static output-schema walk, pinned verb by verb against the
// reference's `Fuaran.Core.SchemaWalk` rules (Fuaran.Core.DataFrame 0.34.0).
import { describe, expect, it } from 'vitest';

import type { ColExpr, DataSource, Transform } from '@fuaran-ui/schema';

import { ofPipeline } from '../src/schemaWalk.js';

const table: DataSource = {
  kind: 'Embedded',
  table: {
    schema: [
      { name: 'dept', type: 'string' },
      { name: 'amount', type: 'int' },
      { name: 'day', type: 'date' },
    ],
    columns: [],
  },
};

const col = (name: string): ColExpr => ({ kind: 'col', name });

describe('Phase 1889 — schemaWalk', () => {
  it('an empty pipeline is the source schema, closed', () => {
    expect(ofPipeline(table, [])).toEqual({
      kind: 'Closed',
      columns: [
        { name: 'dept', type: 'string' },
        { name: 'amount', type: 'int' },
        { name: 'day', type: 'date' },
      ],
    });
  });

  it('row-set verbs touch no column', () => {
    const steps: Transform[] = [
      { kind: 'filter', pred: { kind: 'isNull', expr: col('dept') } },
      { kind: 'sort', by: [{ col: 'amount', dir: 'desc' }] },
      { kind: 'distinct' },
      { kind: 'limit', n: 3, offset: 0 },
    ];
    expect(ofPipeline(table, steps)).toEqual(ofPipeline(table, []));
  });

  it('project closes the set under the output names, carrying source types', () => {
    const k = ofPipeline(table, [{ kind: 'project', cols: [{ a: 'amount', b: 'value' }] }]);
    expect(k).toEqual({ kind: 'Closed', columns: [{ name: 'value', type: 'int' }] });
  });

  it('groupBy types each aggregate by the reference rule', () => {
    const k = ofPipeline(table, [
      {
        kind: 'groupBy',
        keys: ['dept'],
        aggs: [
          { name: 'total', fn: 'sum', of: 'amount' },
          { name: 'n', fn: 'count', of: 'amount' },
          { name: 'avg', fn: 'mean', of: 'amount' },
          { name: 'ghost', fn: 'max', of: 'absent' },
        ],
      },
    ]);
    expect(k).toEqual({
      kind: 'Closed',
      columns: [
        { name: 'dept', type: 'string' },
        { name: 'total', type: 'int' },
        { name: 'n', type: 'int' },
        { name: 'avg', type: 'float' },
        { name: 'ghost' },
      ],
    });
  });

  it('derive is typed only where the expression alone decides it: strings, or no present value', () => {
    const k = ofPipeline(table, [
      { kind: 'derive', name: 'label', expr: { kind: 'apply', fn: 'upper', args: [col('dept')] } },
      {
        kind: 'derive',
        name: 'double',
        expr: { kind: 'binary', op: 'mul', left: col('amount'), right: col('amount') },
      },
      { kind: 'derive', name: 'nothing', expr: { kind: 'lit', cell: { kind: 'Null' } } },
      // Retypes in place, position kept.
      { kind: 'derive', name: 'dept', expr: { kind: 'cast', type: 'int', expr: col('dept') } },
    ]);
    expect(k.kind).toBe('Closed');
    expect(k.columns).toEqual([
      { name: 'dept' },
      { name: 'amount', type: 'int' },
      { name: 'day', type: 'date' },
      { name: 'label', type: 'string' },
      { name: 'double' },
      { name: 'nothing', type: 'string' },
    ]);
  });

  it('window appends, typed by its function', () => {
    const k = ofPipeline(table, [
      {
        kind: 'window',
        spec: { partitionBy: [], orderBy: [], fn: 'lag', of: 'day', as: 'prev' },
      },
      {
        kind: 'window',
        spec: { partitionBy: [], orderBy: [], fn: 'rowNumber', of: 'day', as: 'i' },
      },
    ]);
    expect(k.columns.slice(3)).toEqual([
      { name: 'prev', type: 'date' },
      { name: 'i', type: 'int' },
    ]);
  });

  it('pivot opens the set and says why; a Ref opens it from the start', () => {
    const p = ofPipeline(table, [
      { kind: 'pivot', spec: { index: ['dept'], on: 'day', values: 'amount', agg: 'sum' } },
    ]);
    expect(p.kind).toBe('AtLeast');
    expect(p.columns).toEqual([{ name: 'dept', type: 'string' }]);

    const r = ofPipeline({ kind: 'Ref', name: 'orders' }, []);
    expect(r).toEqual({
      kind: 'AtLeast',
      columns: [],
      reason: "source 'orders' is a Ref with no declared schema",
    });
    // ...and a project CLOSES it again, on its own terms.
    expect(
      ofPipeline({ kind: 'Ref', name: 'orders' }, [
        { kind: 'project', cols: [{ a: 'x', b: 'y' }] },
      ]),
    ).toEqual({ kind: 'Closed', columns: [{ name: 'y' }] });
  });

  it('unpivot names variable/value; a join suffixes a colliding right column', () => {
    const u = ofPipeline(table, [{ kind: 'unpivot', idVars: ['dept'], valueVars: ['amount'] }]);
    expect(u).toEqual({
      kind: 'Closed',
      columns: [
        { name: 'dept', type: 'string' },
        { name: 'variable', type: 'string' },
        { name: 'value', type: 'int' },
      ],
    });

    const right: DataSource = {
      kind: 'Embedded',
      table: {
        schema: [
          { name: 'dept', type: 'string' },
          { name: 'head', type: 'string' },
        ],
        columns: [],
      },
    };
    const j = ofPipeline(table, [
      { kind: 'join', source: right, on: [{ a: 'dept', b: 'dept' }], how: 'left' },
    ]);
    expect(j.columns.map((c) => c.name)).toEqual(['dept', 'amount', 'day', 'dept_right', 'head']);
    expect(j.kind).toBe('Closed');
  });
});
