// Phase 2205 — the typed column: a column holds typed vectors and a validity,
// as Core's `Column` does from 1.0.0, and the `toCells` bridge gives back
// exactly the cells it was built from.
import { describe, expect, it } from 'vitest';

import type { Cell, ColumnType } from '@fuaran-ui/schema';

import {
  cellAt,
  columnCells,
  columnLength,
  columnOfCells,
  dateDays,
  dateText,
  instantParts,
  instantText,
  nullColumn,
  takeRows,
} from '../src/column.js';
import { col } from './tables.js';

const N: Cell = { kind: 'Null' };
const I = (value: number): Cell => ({ kind: 'Int', value });
const F = (value: number): Cell => ({ kind: 'Float', value });
const D = (value: string): Cell => ({ kind: 'Date', value });
const T = (value: string): Cell => ({ kind: 'Timestamp', value });

describe('the storage each column type is held as', () => {
  const cases: readonly [ColumnType, readonly Cell[], string, unknown][] = [
    ['int', [I(1), N, I(-7)], 'Ints', Int32Array],
    ['float', [F(1.5), N, F(-0.25)], 'Floats', Float64Array],
    ['bool', [{ kind: 'Bool', value: true }, N], 'Bools', Uint8Array],
    ['string', [{ kind: 'Str', value: 'a' }, N], 'Strs', Array],
    ['date', [D('2026-01-31'), N, D('1969-12-31')], 'Dates', Int32Array],
    ['decimal', [{ kind: 'Decimal', value: '12.5' }, N], 'Decimals', Array],
  ];
  it.each(cases)('%s', (type, cells, kind, ctor) => {
    const c = col('c', type, cells);
    expect(c.data.kind).toBe(kind);
    const values = c.data.kind === 'Timestamps' ? c.data.seconds : c.data.values;
    expect(values).toBeInstanceOf(ctor);
    expect(columnCells(c)).toEqual(cells);
  });

  it('a date is its day count since 1970-01-01', () => {
    const c = col('d', 'date', [
      D('1970-01-02'),
      D('1969-12-31'),
      D('0000-01-01'),
      D('9999-12-31'),
    ]);
    expect(c.data.kind === 'Dates' && Array.from(c.data.values)).toEqual([1, -1, -719528, 2932896]);
  });

  it('an int and a float column of the same numbers are different storage', () => {
    expect(col('i', 'int', [I(3)]).data.kind).toBe('Ints');
    // An int widens into a float column losslessly, and is read back as the float it is held as.
    const f = col('f', 'float', [I(3)]);
    expect(f.data.kind).toBe('Floats');
    expect(cellAt(f, 0)).toEqual(F(3));
  });
});

describe('the validity', () => {
  it('is AllValid where no row is absent, and holds nothing', () => {
    expect(col('c', 'int', [I(1), I(2)]).data.validity).toEqual({ kind: 'AllValid' });
  });

  it('is a byte mask where a row is absent', () => {
    const v = col('c', 'int', [I(1), N]).data.validity;
    expect(v.kind === 'Mask' && Array.from(v.present)).toEqual([1, 0]);
  });

  it('an empty column is AllValid, and a column of absent rows reads every row null', () => {
    expect(col('c', 'float', []).data.validity).toEqual({ kind: 'AllValid' });
    const nulls = nullColumn('c', 'timestamp_ms', 3);
    expect(columnLength(nulls)).toBe(3);
    expect(columnCells(nulls)).toEqual([N, N, N]);
  });

  it('reads a row off either end as null', () => {
    const c = col('c', 'int', [I(1)]);
    expect(cellAt(c, -1)).toEqual(N);
    expect(cellAt(c, 1)).toEqual(N);
  });
});

describe('timestamps: whole epoch seconds plus the fraction scaled to the unit', () => {
  const texts = [
    '1970-01-01T00:00:00Z',
    '1969-12-31T23:59:59.999Z',
    '0000-01-01T00:00:00Z',
    '9999-12-31T23:59:59.1Z',
    '2026-10-12T16:08:57.05Z',
  ];

  it.each(['timestamp_ms', 'timestamp_us', 'timestamp_ns'] as const)(
    'a %s column reads back the canonical text it was built from',
    (type) => {
      const c = col('t', type, texts.map(T));
      expect(columnCells(c)).toEqual(texts.map(T));
    },
  );

  it('stores the second and the fraction in the unit', () => {
    const c = col('t', 'timestamp_ms', [
      T('1969-12-31T23:59:59.999Z'),
      T('2026-01-01T00:00:00.5Z'),
    ]);
    expect(c.data.kind).toBe('Timestamps');
    if (c.data.kind !== 'Timestamps') return;
    expect(Array.from(c.data.seconds)).toEqual([-1, 1767225600]);
    expect(c.data.fraction && Array.from(c.data.fraction)).toEqual([999, 500]);
  });

  it('holds no fraction vector for a seconds column, or where every fraction is zero', () => {
    const s = col('t', 'timestamp', [T('2026-01-01T00:00:00Z')]);
    const z = col('t', 'timestamp_ns', [T('2026-01-01T00:00:00Z'), N]);
    expect(s.data.kind === 'Timestamps' && s.data.fraction).toBeUndefined();
    expect(z.data.kind === 'Timestamps' && z.data.fraction).toBeUndefined();
  });

  it('the text and the parts are inverse at every unit', () => {
    for (const t of texts) {
      for (const digits of [3, 6, 9]) {
        const p = instantParts(t, digits);
        if (typeof p !== 'object') throw new Error(`${t} did not read at ${digits}`);
        expect(instantText(p.second, p.fraction, digits)).toBe(t);
      }
    }
  });
});

describe('what a typed column refuses — exactly what the reference column refuses', () => {
  it('a cell of another type, naming the column', () => {
    const r = columnOfCells('n', 'int', [{ kind: 'Str', value: 'x' }]);
    expect(r).toEqual({ ok: false, error: "column 'n': expected int value, got string" });
  });

  it('an int outside 32 bits', () => {
    expect(columnOfCells('n', 'int', [I(2147483647), I(-2147483648)]).ok).toBe(true);
    expect(columnOfCells('n', 'int', [I(2147483648)]).ok).toBe(false);
  });

  it('a date whose text is not canonical', () => {
    for (const t of ['2026-1-01', '2026-02-30', '2026-01-01T00:00:00Z', 'garbage']) {
      expect(columnOfCells('d', 'date', [D(t)]).ok, t).toBe(false);
      expect(dateDays(t), t).toBeUndefined();
    }
  });

  it('an instant whose text is not canonical, or finer than the unit', () => {
    expect(columnOfCells('t', 'timestamp_ms', [T('2026-01-01T00:00:00.500Z')]).ok).toBe(false);
    expect(columnOfCells('t', 'timestamp_ms', [T('2026-01-01T00:00:00.0001Z')]).ok).toBe(false);
    expect(columnOfCells('t', 'timestamp', [T('2026-01-01T00:00:00.5Z')]).ok).toBe(false);
  });

  it('a float into an int column, and a float into a decimal column', () => {
    expect(columnOfCells('n', 'int', [F(1)]).ok).toBe(false);
    expect(columnOfCells('n', 'decimal', [F(1)]).ok).toBe(false);
  });
});

describe('takeRows — the gather the row-set verbs share', () => {
  it('reads the rows in the order given, -1 an absent row, and keeps the type', () => {
    const c = col('c', 'date', [D('2026-01-01'), N, D('2026-01-03')]);
    const g = takeRows(c, [2, -1, 0, 1], 'g');
    expect(g.name).toBe('g');
    expect(g.data.kind).toBe('Dates');
    expect(columnCells(g)).toEqual([D('2026-01-03'), N, D('2026-01-01'), N]);
  });

  it('drops a fraction vector the gathered rows no longer need', () => {
    const c = col('t', 'timestamp_ms', [T('2026-01-01T00:00:00Z'), T('2026-01-01T00:00:00.5Z')]);
    const g = takeRows(c, [0]);
    expect(g.data.kind === 'Timestamps' && g.data.fraction).toBeUndefined();
    expect(columnCells(g)).toEqual([T('2026-01-01T00:00:00Z')]);
  });

  it('a date round-trips through its day count', () => {
    for (const d of ['0000-01-01', '1600-02-29', '1970-01-01', '2026-10-28', '9999-12-31'])
      expect(dateText(dateDays(d)!)).toBe(d);
  });
});
