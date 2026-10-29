// Phase 2208 — the evaluator propagates and checks units (twin of the reference's Phase 429, D29):
// the algebra the check reads, the whole schema entry carried through each verb class (kept,
// dropped, unit-only), and a go-red: the refusals are the UNIT check's, so the same pipelines over
// the same data with the units withdrawn answer.
import { describe, expect, it } from 'vitest';

import type { ColExpr, SchemaEntry, Table, Transform } from '@fuaran-ui/schema';

import {
  compatibleUnits,
  conversionFactor,
  divUnit,
  evalPipeline,
  mulUnit,
  parseUnit,
  powUnit,
  renderUnit,
  type UnitOfMeasure,
} from '../src/index.js';
import { col } from './tables.js';

const u = (text: string): UnitOfMeasure => {
  const r = parseUnit(text);
  if (!r.ok) throw new Error(`refused ${text}`);
  return r.value;
};

const c = (name: string): ColExpr => ({ kind: 'col', name });
const intLit = (value: number): ColExpr => ({ kind: 'lit', cell: { kind: 'Int', value } });

// d: metres, labelled; t: seconds; n: unitless, labelled and described, with an extension key.
const schema: SchemaEntry[] = [
  { name: 'g', type: 'string' },
  { name: 'd', type: 'int', unit: 'm', label: 'Distance' },
  { name: 't', type: 'float', unit: 's' },
  { name: 'dk', type: 'float', unit: 'km' },
  {
    name: 'n',
    type: 'int',
    label: 'Count',
    description: 'How many',
    ext: new Map([['acme.k', 'v']]),
  },
];

const table = (entries: readonly SchemaEntry[]): Table => ({
  schema: entries,
  columns: [
    col('g', 'string', [
      { kind: 'Str', value: 'a' },
      { kind: 'Str', value: 'b' },
    ]),
    col('d', 'int', [
      { kind: 'Int', value: 100 },
      { kind: 'Int', value: 200 },
    ]),
    col('t', 'float', [
      { kind: 'Float', value: 4 },
      { kind: 'Float', value: 8 },
    ]),
    col('dk', 'float', [
      { kind: 'Float', value: 0.5 },
      { kind: 'Float', value: 1 },
    ]),
    col('n', 'int', [
      { kind: 'Int', value: 1 },
      { kind: 'Int', value: 2 },
    ]),
  ],
});

const run = (pipeline: readonly Transform[], entries: readonly SchemaEntry[] = schema) =>
  evalPipeline(pipeline, table(entries));

const outSchema = (pipeline: readonly Transform[]): readonly SchemaEntry[] => {
  const r = run(pipeline);
  if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
  return r.value.schema;
};

const entry = (pipeline: readonly Transform[], name: string): SchemaEntry | undefined =>
  outSchema(pipeline).find((e) => e.name === name);

describe('Phase 2208 — the unit algebra', () => {
  it('composes products, quotients and integer powers in canonical form', () => {
    expect(renderUnit(mulUnit(u('m'), u('m'))!)).toBe('m2');
    expect(renderUnit(divUnit(u('m'), u('s'))!)).toBe('m/s');
    expect(renderUnit(divUnit(u('1'), u('s'))!)).toBe('/s');
    expect(renderUnit(powUnit(u('m/s'), 2)!)).toBe('m2/s2');
    expect(renderUnit(powUnit(u('m'), 0)!)).toBe('1');
    expect(powUnit(u('m2'), 2000000000)).toBeUndefined();
  });

  it('tells dimensions apart, each currency its own', () => {
    expect(compatibleUnits(u('N'), u('kg.m/s2'))).toBe(true);
    expect(compatibleUnits(u('m'), u('s'))).toBe(false);
    expect(compatibleUnits(u('[GBP]'), u('k[GBP]'))).toBe(true);
    expect(compatibleUnits(u('[GBP]'), u('[USD]'))).toBe(false);
  });

  it('gives the exact conversion factor in lowest terms', () => {
    expect(conversionFactor(u('km/h'), u('m/s'))).toEqual({ num: 5n, den: 18n });
    expect(conversionFactor(u('[mi_i]'), u('km'))).toEqual({ num: 25146n, den: 15625n });
    expect(conversionFactor(u('L'), u('m3'))).toEqual({ num: 1n, den: 1000n });
    expect(conversionFactor(u('m'), u('s'))).toBeUndefined();
  });
});

describe('Phase 2208 — the whole entry rides each verb class', () => {
  it('KEPT: a projection renames a column and keeps every metadatum', () => {
    expect(entry([{ kind: 'project', cols: [{ a: 'n', b: 'count' }] }], 'count')).toEqual({
      name: 'count',
      type: 'int',
      label: 'Count',
      description: 'How many',
      ext: new Map([['acme.k', 'v']]),
    });
  });

  it('KEPT: a filter, a sort and a join keep the entries they carry', () => {
    const kept = outSchema([
      { kind: 'filter', pred: { kind: 'binary', op: 'gt', left: c('n'), right: intLit(0) } },
      { kind: 'sort', by: [{ col: 'n', dir: 'desc' }] },
    ]);
    expect(kept).toEqual(schema);
    const joined = outSchema([
      {
        kind: 'join',
        on: [{ a: 'g', b: 'g' }],
        how: 'inner',
        source: { kind: 'Embedded', table: table(schema) },
      },
    ]);
    expect(joined.find((e) => e.name === 'n_right')).toEqual({ ...schema[4]!, name: 'n_right' });
  });

  it('DROPPED: a derive and an aggregate build their own entry, stating no label', () => {
    expect(entry([{ kind: 'derive', name: 'n2', expr: c('n') }], 'n2')).toEqual({
      name: 'n2',
      type: 'int',
    });
    expect(
      entry([{ kind: 'groupBy', keys: ['g'], aggs: [{ name: 'c', fn: 'count', of: 'd' }] }], 'c'),
    ).toEqual({ name: 'c', type: 'int' });
  });

  it('UNIT-ONLY: a derive, an aggregate and a window carry a unit and no label', () => {
    expect(entry([{ kind: 'derive', name: 'v', expr: c('d') }], 'v')).toEqual({
      name: 'v',
      type: 'int',
      unit: 'm',
    });
    expect(
      entry([{ kind: 'groupBy', keys: ['g'], aggs: [{ name: 's', fn: 'sum', of: 'd' }] }], 's'),
    ).toEqual({ name: 's', type: 'int', unit: 'm' });
    expect(
      entry(
        [
          {
            kind: 'window',
            spec: {
              partitionBy: [],
              orderBy: [{ col: 'n', dir: 'asc' }],
              fn: 'lag',
              of: 'd',
              as: 'p',
            },
          },
        ],
        'p',
      ),
    ).toEqual({ name: 'p', type: 'int', unit: 'm' });
  });
});

describe('Phase 2208 — go-red: the refusals are the unit check', () => {
  const refused: readonly [string, Transform][] = [
    [
      'm + s',
      {
        kind: 'derive',
        name: 'x',
        expr: { kind: 'binary', op: 'add', left: c('d'), right: c('t') },
      },
    ],
    [
      'km + m',
      {
        kind: 'derive',
        name: 'x',
        expr: { kind: 'binary', op: 'add', left: c('dk'), right: c('d') },
      },
    ],
    ['m > s', { kind: 'filter', pred: { kind: 'binary', op: 'gt', left: c('d'), right: c('t') } }],
    ['m to s', { kind: 'derive', name: 'x', expr: { kind: 'convert', expr: c('d'), unit: 's' } }],
  ];
  const unitless = schema.map(({ unit: _, ...rest }) => rest);

  for (const [what, step] of refused) {
    it(`${what} is refused as a unit mismatch, and answers once the units are withdrawn`, () => {
      const r = run([step]);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error.kind).toBe('UnitMismatch');
      expect(run([step], unitless).ok).toBe(true);
    });
  }

  it('a conversion between two units of one dimension multiplies by the exact factor', () => {
    const r = run([
      { kind: 'derive', name: 'm', expr: { kind: 'convert', expr: c('dk'), unit: 'm' } },
    ]);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.schema.find((e) => e.name === 'm')).toEqual({
      name: 'm',
      type: 'float',
      unit: 'm',
    });
  });
});
