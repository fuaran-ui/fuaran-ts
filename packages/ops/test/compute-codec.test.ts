// ============================================================================
//  Compute-layer codec coverage (Phase 284).
//
//  The shared corpus fixture (grid-transform) exercises filter / groupBy / sort
//  + an Int literal + a binary op. This suite covers the rest of the surface —
//  every Transform verb, every ColExpr case, every Cell type, and a Ref source —
//  through the canonical encode → decode → encode round-trip. Byte-stability of
//  the re-encode certifies the encoder and the (internal) decoder are mutually
//  symmetric over the whole compute wire, the same property the §11.1 gate pins
//  for the corpus fixture.
// ============================================================================

import type { Binding, ColExpr, Node, NodeId, Transform } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode } from '../src/index.js';

// Wrap a Transform binding in a DataGrid node (the data-bearing source slot).
const gridWith = (binding: Binding<unknown>): Node<unknown> => ({
  id: 'n' as NodeId,
  kind: {
    kind: 'Visualisation',
    visualisation: {
      kind: 'Grid',
      spec: {
        source: binding as Binding<readonly unknown[]>,
        rowKey: () => '',
        columns: [],
        editable: false,
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const roundTripStable = (binding: Binding<unknown>): void => {
  const once = encodeNode(gridWith(binding));
  const decoded = decodeNode(once);
  expect(decoded.ok, decoded.ok ? '' : JSON.stringify((decoded as { error: unknown }).error)).toBe(
    true,
  );
  if (!decoded.ok) return;
  expect(encodeNode(decoded.value)).toBe(once);
};

describe('compute codec — full verb / expr / cell coverage (round-trip stable)', () => {
  it('every Cell type as a literal', () => {
    const exprs = [
      { kind: 'lit' as const, cell: { kind: 'Int' as const, value: -7 } },
      { kind: 'lit' as const, cell: { kind: 'Float' as const, value: 3.25 } },
      { kind: 'lit' as const, cell: { kind: 'Bool' as const, value: true } },
      { kind: 'lit' as const, cell: { kind: 'Str' as const, value: 'hi\n"x"' } },
      { kind: 'lit' as const, cell: { kind: 'Date' as const, value: '2026-06-22' } },
      { kind: 'lit' as const, cell: { kind: 'Timestamp' as const, value: '2026-06-22T10:00:00Z' } },
      { kind: 'lit' as const, cell: { kind: 'Null' as const } },
    ];
    const pipeline: Transform[] = exprs.map((e, i) => ({ kind: 'derive', name: `c${i}`, expr: e }));
    roundTripStable({
      kind: 'Transform',
      source: { kind: 'Embedded', table: { schema: [], columns: [] } },
      pipeline,
    });
  });

  it('every ColExpr case', () => {
    const col = (name: string): ColExpr => ({ kind: 'col', name });
    const pipeline: Transform[] = [
      { kind: 'derive', name: 'a', expr: { kind: 'not', expr: col('flag') } },
      {
        kind: 'derive',
        name: 'b',
        expr: {
          kind: 'coalesce',
          exprs: [col('x'), { kind: 'lit', cell: { kind: 'Int', value: 0 } }],
        },
      },
      {
        kind: 'derive',
        name: 'c',
        expr: {
          kind: 'case',
          cases: [
            {
              when: {
                kind: 'binary',
                op: 'gt',
                left: col('x'),
                right: { kind: 'lit', cell: { kind: 'Int', value: 1 } },
              },
              then: { kind: 'lit', cell: { kind: 'Str', value: 'hi' } },
            },
          ],
          else: { kind: 'lit', cell: { kind: 'Str', value: 'lo' } },
        },
      },
      { kind: 'derive', name: 'd', expr: { kind: 'cast', type: 'float', expr: col('x') } },
      { kind: 'derive', name: 'e', expr: { kind: 'apply', fn: 'round', args: [col('x')] } },
      {
        kind: 'derive',
        name: 'f',
        expr: {
          kind: 'apply',
          fn: 'substr',
          args: [
            col('s'),
            { kind: 'lit', cell: { kind: 'Int', value: 0 } },
            { kind: 'lit', cell: { kind: 'Int', value: 2 } },
          ],
        },
      },
    ];
    roundTripStable({
      kind: 'Transform',
      source: { kind: 'Embedded', table: { schema: [], columns: [] } },
      pipeline,
    });
  });

  it('every Transform verb + an embedded multi-type source with nulls', () => {
    const pipeline: Transform[] = [
      {
        kind: 'filter',
        pred: {
          kind: 'binary',
          op: 'ge',
          left: { kind: 'col', name: 'n' },
          right: { kind: 'lit', cell: { kind: 'Int', value: 0 } },
        },
      },
      {
        kind: 'project',
        cols: [
          { a: 'n', b: 'num' },
          { a: 'k', b: 'key' },
        ],
      },
      {
        kind: 'derive',
        name: 'dbl',
        expr: {
          kind: 'binary',
          op: 'mul',
          left: { kind: 'col', name: 'num' },
          right: { kind: 'lit', cell: { kind: 'Int', value: 2 } },
        },
      },
      {
        kind: 'groupBy',
        keys: ['key'],
        aggs: [
          { name: 'total', fn: 'sum', of: 'num' },
          { name: 'avg', fn: 'mean', of: 'num' },
        ],
      },
      {
        kind: 'join',
        source: {
          kind: 'Embedded',
          table: {
            schema: [{ name: 'key', type: 'string' }],
            columns: [{ name: 'key', type: 'string', cells: [{ kind: 'Str', value: 'a' }] }],
          },
        },
        on: [{ a: 'key', b: 'key' }],
        how: 'left',
      },
      {
        kind: 'window',
        spec: {
          partitionBy: ['key'],
          orderBy: [{ col: 'total', dir: 'desc' }],
          fn: 'rowNumber',
          of: 'total',
          as: 'rn',
        },
      },
      { kind: 'pivot', spec: { index: ['key'], on: 'key', values: 'total', agg: 'max' } },
      { kind: 'unpivot', idVars: ['key'], valueVars: ['total'] },
      { kind: 'sort', by: [{ col: 'key', dir: 'asc' }] },
      { kind: 'distinct' },
      { kind: 'limit', n: 10, offset: 2 },
      { kind: 'union', source: { kind: 'Ref', name: 'more' } },
    ];
    roundTripStable({
      kind: 'Transform',
      source: {
        kind: 'Embedded',
        table: {
          schema: [
            { name: 'n', type: 'int' },
            { name: 'f', type: 'float' },
            { name: 'b', type: 'bool' },
            { name: 'k', type: 'string' },
            { name: 'd', type: 'date' },
            { name: 't', type: 'timestamp' },
          ],
          columns: [
            { name: 'n', type: 'int', cells: [{ kind: 'Int', value: 1 }, { kind: 'Null' }] },
            { name: 'f', type: 'float', cells: [{ kind: 'Float', value: 1.5 }, { kind: 'Null' }] },
            { name: 'b', type: 'bool', cells: [{ kind: 'Bool', value: true }, { kind: 'Null' }] },
            {
              name: 'k',
              type: 'string',
              cells: [
                { kind: 'Str', value: 'a' },
                { kind: 'Str', value: 'b' },
              ],
            },
            {
              name: 'd',
              type: 'date',
              cells: [{ kind: 'Date', value: '2026-01-01' }, { kind: 'Null' }],
            },
            {
              name: 't',
              type: 'timestamp',
              cells: [{ kind: 'Timestamp', value: '2026-01-01T00:00:00Z' }, { kind: 'Null' }],
            },
          ],
        },
      },
      pipeline,
    });
  });

  it('a Ref source pipeline', () => {
    roundTripStable({
      kind: 'Transform',
      source: { kind: 'Ref', name: 'sales' },
      pipeline: [{ kind: 'limit', n: 5, offset: 0 }],
    });
  });
});
