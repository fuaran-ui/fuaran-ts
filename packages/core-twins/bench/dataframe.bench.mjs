// ============================================================================
//  The dataframe evaluator's node benchmark (Phase 1893).
//
//  The reference evaluator's benchmark corpus shapes, built here over this
//  host's typed columns: the sheet (`lines`, `byRegion`), the chain, the dated
//  pipeline, the three scaling pipelines (full evaluation; this host has no
//  incremental refresh), the five shapes the reference suite times separately
//  (inner join, high-cardinality group-by, pivot, one-partition window, two-key
//  sort), the typed family (filter, group-and-sum, sort and join over a decimal,
//  a float and an int value column) and the keyed family (join and group-by
//  over int, string, date, timestamp and decimal keys).
//
//  It runs the BUILT package (`pnpm bench` builds it first), so a figure is
//  always the sources as they stand.
//
//  Discipline, because each of these has misled a figure before:
//   - every input is built OUTSIDE the timed closure;
//   - warm-up is by iteration count, never by time;
//   - each case reports the median AND the worst sample per call;
//   - each case's answer is fingerprinted (sha256 over its schema and every
//     cell, kind-tagged) and its row count checked before anything is timed,
//     so a change that alters an answer, or a run that did no work, shows.
//
//  Usage: node --expose-gc bench/dataframe.bench.mjs [--json <file>] [--skip <s>]… [filter…]
//  A filter is a regular expression over the case names; with none, every case
//  runs. A skip drops every case whose name it matches.
// ============================================================================

import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';

import {
  cellAt,
  columnLength,
  columnOfCells,
  dateDays,
  dateText,
  evalPipeline,
  evalPipelineInEnv,
  instantText,
} from '../dist/index.js';

// ─── table construction ──────────────────────────────────────────────────────

const col = (name, type, cells) => {
  const c = columnOfCells(name, type, cells);
  if (!c.ok) throw new Error(`benchmark corpus: column ${name}: ${c.error}`);
  return c.value;
};

const table = (fields) => ({
  schema: fields.map(([name, type]) => ({ name, type })),
  columns: fields.map(([name, type, cells]) => col(name, type, cells)),
});

const range = (n, f) => Array.from({ length: n }, (_, i) => f(i));
const Int = (value) => ({ kind: 'Int', value });
const Float = (value) => ({ kind: 'Float', value });
const Str = (value) => ({ kind: 'Str', value });
const Decimal = (value) => ({ kind: 'Decimal', value });
const DateCell = (value) => ({ kind: 'Date', value });
const Timestamp = (value) => ({ kind: 'Timestamp', value });
const c = (name) => ({ kind: 'col', name });
const lit = (cell) => ({ kind: 'lit', cell });
const bin = (op, left, right) => ({ kind: 'binary', op, left, right });
const embedded = (t) => ({ kind: 'Embedded', table: t });

// ─── the sheet, the chain and the dated pipeline ─────────────────────────────

const regions = ['north', 'south', 'east', 'west', 'central'];

const ordersFields = (n) => [
  ['id', 'int', range(n, Int)],
  ['region', 'string', range(n, (i) => Str(regions[(i * 3 + Math.floor(i / 7)) % 5]))],
  ['qty', 'int', range(n, (i) => Int(1 + ((i * 7 + Math.floor(i / 3)) % 20)))],
  ['price', 'float', range(n, (i) => Float((4 + ((i * 13) % 397)) * 0.25))],
];

const sheetEnv = { threshold: Float(500) };
const amountStep = { kind: 'derive', name: 'amount', expr: bin('mul', c('qty'), c('price')) };
const linesPipeline = [
  amountStep,
  {
    kind: 'derive',
    name: 'big',
    expr: bin('ge', c('amount'), { kind: 'param', name: 'threshold' }),
  },
];
const byRegionPipeline = [
  amountStep,
  {
    kind: 'groupBy',
    keys: ['region'],
    aggs: [
      { name: 'total', fn: 'sum', of: 'amount' },
      { name: 'n', fn: 'count', of: 'amount' },
    ],
  },
];
const chainPipeline = [
  ...linesPipeline,
  { kind: 'filter', pred: c('big') },
  { kind: 'derive', name: 'net', expr: bin('mul', c('amount'), lit(Float(0.8))) },
  { kind: 'derive', name: 'tax', expr: bin('sub', c('amount'), c('net')) },
  {
    kind: 'project',
    cols: ['id', 'region', 'net', 'tax'].map((x) => ({ a: x, b: x })),
  },
];

const firstDay = dateDays('2026-01-01');
const byMonthPipeline = [
  {
    kind: 'filter',
    pred: bin(
      'and',
      bin('ge', c('day'), lit(DateCell('2026-04-01'))),
      bin('lt', c('day'), lit(DateCell('2026-10-01'))),
    ),
  },
  amountStep,
  {
    kind: 'derive',
    name: 'month',
    expr: { kind: 'apply', fn: 'datePart', args: [lit(Str('month')), c('day')] },
  },
  {
    kind: 'groupBy',
    keys: ['month'],
    aggs: [
      { name: 'total', fn: 'sum', of: 'amount' },
      { name: 'n', fn: 'count', of: 'amount' },
    ],
  },
];

// ─── the scaling pipelines ───────────────────────────────────────────────────

const scalingTable = (n) =>
  table([
    ['id', 'string', range(n, (i) => Str('r' + i))],
    ['grp', 'string', range(n, (i) => Str('g' + (i % 17)))],
    ['a', 'int', range(n, Int)],
    ['b', 'int', range(n, (i) => Int(i % 7))],
  ]);
const everyRow = { kind: 'filter', pred: bin('ge', c('a'), lit(Int(-10))) };
const twoAggs = {
  kind: 'groupBy',
  keys: ['grp'],
  aggs: [
    { name: 'n', fn: 'count', of: 'a' },
    { name: 's', fn: 'sum', of: 'b' },
  ],
};
const scalingPipelines = {
  'filter-groupby': [everyRow, twoAggs],
  'filter-sort-limit': [
    everyRow,
    { kind: 'sort', by: [{ col: 'a', dir: 'desc' }] },
    { kind: 'limit', n: 10, offset: 0 },
  ],
  'filter-groupby-filter': [
    everyRow,
    twoAggs,
    { kind: 'filter', pred: bin('gt', c('n'), lit(Int(0))) },
  ],
};

// ─── the shapes ──────────────────────────────────────────────────────────────

const joinRows = 10_000;
const groupKeys = 10_000;
const pivotIndexValues = 100;
const pivotRows = 50 * pivotIndexValues;
const windowRows = 100_000;
const sortRows = 100_000;

const shapes = {
  'inner join 10,000 x 10,000': () => [
    table([
      ['k', 'int', range(joinRows, (i) => Int((i * 7919) % joinRows))],
      ['a', 'int', range(joinRows, Int)],
    ]),
    [
      {
        kind: 'join',
        source: embedded(
          table([
            ['rk', 'int', range(joinRows, (i) => Int((i * 104729) % joinRows))],
            ['b', 'int', range(joinRows, Int)],
          ]),
        ),
        on: [{ a: 'k', b: 'rk' }],
        how: 'inner',
      },
    ],
    joinRows,
  ],
  'group-by, 10,000 distinct keys': () => [
    table([
      ['key', 'string', range(2 * groupKeys, (i) => Str('k' + (i % groupKeys)))],
      ['v', 'int', range(2 * groupKeys, (i) => Int(i % 100))],
    ]),
    [
      {
        kind: 'groupBy',
        keys: ['key'],
        aggs: [
          { name: 's', fn: 'sum', of: 'v' },
          { name: 'n', fn: 'count', of: 'v' },
        ],
      },
    ],
    groupKeys,
  ],
  'pivot, 50 on-values': () => [
    table([
      ['idx', 'string', range(pivotRows, (i) => Str('i' + (i % pivotIndexValues)))],
      ['on', 'string', range(pivotRows, (i) => Str('o' + Math.floor(i / pivotIndexValues)))],
      ['v', 'float', range(pivotRows, (i) => Float((i % 13) * 0.5))],
    ]),
    [{ kind: 'pivot', spec: { index: ['idx'], on: 'on', values: 'v', agg: 'sum' } }],
    pivotIndexValues,
  ],
  'window CumulSum, one partition': () => [
    table([
      ['seq', 'int', range(windowRows, Int)],
      ['v', 'int', range(windowRows, (i) => Int(i % 10))],
    ]),
    [
      {
        kind: 'window',
        spec: {
          partitionBy: [],
          orderBy: [{ col: 'seq', dir: 'asc' }],
          fn: 'cumulSum',
          of: 'v',
          as: 'cs',
        },
      },
    ],
    windowRows,
  ],
  'sort on two keys': () => [
    table([
      ['k1', 'string', range(sortRows, (i) => Str('c' + (i % 100)))],
      ['k2', 'int', range(sortRows, (i) => Int((i * 7919) % sortRows))],
    ]),
    [
      {
        kind: 'sort',
        by: [
          { col: 'k1', dir: 'asc' },
          { col: 'k2', dir: 'desc' },
        ],
      },
    ],
    sortRows,
  ],
};

// ─── the typed and keyed families ────────────────────────────────────────────

const hundredths = (i) => (i * 7919) % 100_000;
const decimalTextOf = (h) => {
  const whole = Math.floor(h / 100);
  const frac = h % 100;
  if (frac === 0) return String(whole);
  if (frac % 10 === 0) return whole + '.' + frac / 10;
  if (frac < 10) return whole + '.0' + frac;
  return whole + '.' + frac;
};
const typedCell = (ty, h) =>
  ty === 'decimal' ? Decimal(decimalTextOf(h)) : ty === 'float' ? Float(h / 100) : Int(h);

const typedTable = (ty, n) =>
  table([
    ['id', 'int', range(n, Int)],
    ['grp', 'string', range(n, (i) => Str('g' + (i % 50)))],
    ['v', ty, range(n, (i) => typedCell(ty, hundredths(i)))],
  ]);
const typedRight = (ty, n) =>
  table([
    ['rv', ty, range(n, (j) => typedCell(ty, hundredths((j * (104729 % n)) % n)))],
    ['b', 'int', range(n, Int)],
  ]);
const typedPipeline = (verb, ty, n) => {
  switch (verb) {
    case 'filter':
      return [{ kind: 'filter', pred: bin('gt', c('v'), lit(typedCell(ty, 50_000))) }];
    case 'group-and-sum':
      return [{ kind: 'groupBy', keys: ['grp'], aggs: [{ name: 's', fn: 'sum', of: 'v' }] }];
    case 'sort':
      return [{ kind: 'sort', by: [{ col: 'v', dir: 'asc' }] }];
    default:
      return [
        {
          kind: 'join',
          source: embedded(typedRight(ty, n)),
          on: [{ a: 'v', b: 'rv' }],
          how: 'inner',
        },
      ];
  }
};
const typedOutputRows = (verb, n) => {
  if (verb === 'filter') {
    let k = 0;
    for (let i = 0; i < n; i += 1) if (hundredths(i) > 50_000) k += 1;
    return k;
  }
  return verb === 'group-and-sum' ? Math.min(n, 50) : n;
};

const keyedCell = (ty, h) => {
  switch (ty) {
    case 'string':
      return Str('cust-' + String(h).padStart(6, '0'));
    case 'date':
      return DateCell(dateText(h));
    case 'timestamp_ms':
      return Timestamp(instantText(h * 60, h % 1000, 3));
    case 'decimal':
      return Decimal(decimalTextOf(h));
    default:
      return Int(h);
  }
};
const keyedTable = (ty, n) =>
  table([
    ['id', 'int', range(n, Int)],
    ['k', ty, range(n, (i) => keyedCell(ty, hundredths(i)))],
  ]);
const keyedRight = (ty, n) =>
  table([
    ['rk', ty, range(n, (j) => keyedCell(ty, hundredths((j * (104729 % n)) % n)))],
    ['b', 'int', range(n, Int)],
  ]);
const keyedPipeline = (verb, ty, n) =>
  verb === 'join'
    ? [
        {
          kind: 'join',
          source: embedded(keyedRight(ty, n)),
          on: [{ a: 'k', b: 'rk' }],
          how: 'inner',
        },
      ]
    : [{ kind: 'groupBy', keys: ['k'], aggs: [{ name: 's', fn: 'sum', of: 'id' }] }];

// ─── the case list ───────────────────────────────────────────────────────────

/** Each case: a name, a builder answering `[input, run, expectedRows | undefined]`. */
const cases = [];
const add = (name, build) => cases.push({ name, build });

for (const n of [1_000, 10_000, 100_000]) {
  const orders = () => table(ordersFields(n));
  add(`sheet lines ${n}`, () => [
    orders(),
    (t) => evalPipelineInEnv(sheetEnv, linesPipeline, t),
    n,
  ]);
  add(`sheet byRegion ${n}`, () => [
    orders(),
    (t) => evalPipelineInEnv(sheetEnv, byRegionPipeline, t),
    5,
  ]);
  add(`chain ${n}`, () => [
    orders(),
    (t) => evalPipelineInEnv(sheetEnv, chainPipeline, t),
    undefined,
  ]);
  add(`dated byMonth ${n}`, () => [
    table([
      ...ordersFields(n),
      [
        'day',
        'date',
        range(n, (i) => DateCell(dateText(firstDay + ((i * 7 + Math.floor(i / 3)) % 365)))),
      ],
    ]),
    (t) => evalPipelineInEnv(sheetEnv, byMonthPipeline, t),
    6,
  ]);
}
for (const n of [1_000, 20_000]) {
  for (const [name, p] of Object.entries(scalingPipelines)) {
    add(`scaling ${name} ${n}`, () => [scalingTable(n), (t) => evalPipeline(p, t), undefined]);
  }
}
for (const [name, build] of Object.entries(shapes)) {
  add(`shape ${name}`, () => {
    const [input, p, rows] = build();
    return [input, (t) => evalPipeline(p, t), rows];
  });
}
for (const verb of ['filter', 'group-and-sum', 'sort', 'join']) {
  for (const ty of ['decimal', 'float', 'int']) {
    for (const n of [1_000, 10_000, 100_000]) {
      add(`typed ${verb} ${ty} ${n}`, () => {
        const p = typedPipeline(verb, ty, n);
        return [typedTable(ty, n), (t) => evalPipeline(p, t), typedOutputRows(verb, n)];
      });
    }
  }
}
for (const verb of ['join', 'group-by']) {
  for (const ty of ['int', 'string', 'date', 'timestamp_ms', 'decimal']) {
    for (const n of [10_000, 100_000]) {
      add(`keyed ${verb} ${ty} ${n}`, () => {
        const p = keyedPipeline(verb, ty, n);
        return [keyedTable(ty, n), (t) => evalPipeline(p, t), n];
      });
    }
  }
}

// ─── the instrument ──────────────────────────────────────────────────────────

const rowsOf = (t) => (t.columns.length > 0 ? columnLength(t.columns[0]) : 0);

/** sha256 over the answer's schema and every cell, kind-tagged: the answer, not its timing. */
const fingerprint = (t) => {
  const h = createHash('sha256');
  h.update(JSON.stringify(t.schema));
  const n = rowsOf(t);
  for (const column of t.columns) {
    h.update('|' + column.name + ':' + column.type);
    for (let i = 0; i < n; i += 1) {
      const cell = cellAt(column, i);
      h.update(cell.kind === 'Null' ? '\u0000N' : '\u0000' + cell.kind + String(cell.value));
    }
  }
  return h.digest('hex').slice(0, 16);
};

const now = () => Number(process.hrtime.bigint()) / 1e6;

const WARMUP_SAMPLES = 3;
const MIN_SAMPLE_MS = 25;
/** A case whose one call takes longer than this is timed one call per sample, fewer samples. */
const SLOW_CALL_MS = 1_000;

const quantile = (sorted, q) =>
  sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)];

const measure = (input, run) => {
  // Calibrate: calls per sample doubled until one sample spans MIN_SAMPLE_MS.
  let calls = 1;
  let first = 0;
  for (;;) {
    const t0 = now();
    for (let k = 0; k < calls; k += 1) run(input);
    const dt = now() - t0;
    if (first === 0) first = dt;
    if (dt >= MIN_SAMPLE_MS || first >= SLOW_CALL_MS) break;
    calls *= 2;
  }
  const slow = first >= SLOW_CALL_MS;
  const samples = slow ? 3 : 20;
  for (let w = 0; w < (slow ? 1 : WARMUP_SAMPLES); w += 1) {
    for (let k = 0; k < calls; k += 1) run(input);
  }
  const perCall = [];
  for (let s = 0; s < samples; s += 1) {
    globalThis.gc?.();
    const t0 = now();
    for (let k = 0; k < calls; k += 1) run(input);
    perCall.push((now() - t0) / calls);
  }
  perCall.sort((a, b) => a - b);
  return {
    calls,
    samples,
    medianMs: quantile(perCall, 0.5),
    p95Ms: quantile(perCall, 0.95),
    maxMs: perCall[perCall.length - 1],
  };
};

// ─── main ────────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
let jsonOut;
const filters = [];
const skips = [];
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--json') jsonOut = argv[(i += 1)];
  else if (argv[i] === '--skip') skips.push(argv[(i += 1)]);
  else filters.push(argv[i]);
}
const selected = cases.filter(
  (k) =>
    (filters.length === 0 || filters.some((f) => new RegExp(f).test(k.name))) &&
    !skips.some((s) => new RegExp(s).test(k.name)),
);
if (selected.length === 0) throw new Error('no case matches ' + JSON.stringify(filters));

const fmt = (x) => (x >= 100 ? x.toFixed(1) : x >= 10 ? x.toFixed(2) : x.toFixed(3));
const results = [];
console.log(`node ${process.version}, ${selected.length} cases`);
console.log('case | rows out | answer | median ms | p95 ms | max ms | calls x samples');
for (const k of selected) {
  const [input, run, expectedRows] = k.build();
  const answer = run(input);
  if (!answer.ok) throw new Error(`${k.name}: ${JSON.stringify(answer.error)}`);
  const rows = rowsOf(answer.value);
  if (expectedRows !== undefined && rows !== expectedRows)
    throw new Error(`${k.name}: ${rows} rows, expected ${expectedRows}`);
  if (rows === 0) throw new Error(`${k.name}: answered no rows`);
  const fp = fingerprint(answer.value);
  const m = measure(input, run);
  results.push({ name: k.name, rows, answer: fp, ...m });
  console.log(
    `${k.name} | ${rows} | ${fp} | ${fmt(m.medianMs)} | ${fmt(m.p95Ms)} | ${fmt(m.maxMs)} | ${m.calls} x ${m.samples}`,
  );
}
if (jsonOut !== undefined)
  writeFileSync(jsonOut, JSON.stringify({ node: process.version, results }, null, 2) + '\n');
