// ============================================================================
//  The host's one calendar module (Phase 2075) — pinned by fixed values, by an
//  independent oracle, and against the one copy that cannot import it.
// ============================================================================

import { epochSecondsOfInstant } from '@fuaran-ui/schema';
import type { Cell, Table } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import {
  civilFromDays,
  daysFromCivil,
  daysInMonth,
  isLeapYear,
  parseIsoDay,
} from '../src/civil.js';
import { evalPipeline } from '../src/dataframe.js';

/** Days since the epoch by the host's own date type — an INDEPENDENT oracle for
 * the test only; the module under test never reads one. Years 0–99 are set
 * explicitly because `Date.UTC` maps them onto 1900–1999. */
const oracleDays = (y: number, m: number, d: number): number => {
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  t.setUTCHours(0, 0, 0, 0);
  return Math.round(t.getTime() / 86400000);
};

/** The edge years: century rules both ways, the epoch, year zero and the
 * negative-bias branches, and the four-digit ceiling. */
const EDGE_YEARS = [
  -401, -400, -399, -101, -100, -1, 0, 1, 4, 99, 100, 399, 400, 1582, 1600, 1700, 1899, 1900, 1969,
  1970, 1971, 1999, 2000, 2001, 2024, 2100, 2400, 9999,
];

describe('civil — fixed values', () => {
  it.each([
    [1970, 1, 1, 0],
    [1969, 12, 31, -1],
    [2000, 3, 1, 11017],
    [2000, 2, 29, 11016],
    [2026, 1, 15, 20468],
    [1, 1, 1, -719162],
    [0, 3, 1, -719468],
    [9999, 12, 31, 2932896],
  ])('%i-%i-%i is day %i', (y, m, d, days) => {
    expect(daysFromCivil(y, m, d)).toBe(days);
    expect(civilFromDays(days)).toEqual({ year: y, month: m, day: d });
  });

  it('leap years follow the proleptic Gregorian rule', () => {
    expect([1900, 2000, 2100, 2400, 0, -4, -100].map(isLeapYear)).toEqual([
      false,
      true,
      false,
      true,
      true,
      true,
      false,
    ]);
    expect([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].map((m) => daysInMonth(2023, m))).toEqual([
      31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31,
    ]);
    expect(daysInMonth(2024, 2)).toBe(29);
    expect(daysInMonth(1900, 2)).toBe(28);
  });
});

describe('civil — every day of every edge year', () => {
  it('daysFromCivil agrees with the independent oracle and civilFromDays inverts it', () => {
    let checked = 0;
    for (const y of EDGE_YEARS) {
      for (let m = 1; m <= 12; m += 1) {
        for (let d = 1; d <= daysInMonth(y, m); d += 1) {
          const days = daysFromCivil(y, m, d);
          expect(days).toBe(oracleDays(y, m, d));
          expect(civilFromDays(days)).toEqual({ year: y, month: m, day: d });
          checked += 1;
        }
      }
    }
    // A loop over nothing proves nothing: every edge year contributed a full year.
    expect(checked).toBe(EDGE_YEARS.reduce((n, y) => n + (isLeapYear(y) ? 366 : 365), 0));
  });

  it('every day number across the edge span round-trips', () => {
    const lo = daysFromCivil(-401, 1, 1);
    const hi = daysFromCivil(2401, 1, 1);
    const misses: number[] = [];
    for (let n = lo; n <= hi; n += 1) {
      const c = civilFromDays(n);
      if (daysFromCivil(c.year, c.month, c.day) !== n || c.day > daysInMonth(c.year, c.month))
        misses.push(n);
    }
    expect(hi - lo).toBeGreaterThan(1_000_000);
    expect(misses).toEqual([]);
  });
});

describe("civil — schema's epochSecondsOfInstant cannot drift from it", () => {
  // Schema keeps its own transcription because core-twins depends on schema's
  // types; this is the pin that holds the two together.
  const pad = (n: number, w: number): string => String(n).padStart(w, '0');

  it('every day of the four-digit edge years', () => {
    let checked = 0;
    for (const y of EDGE_YEARS.filter((y) => y >= 1)) {
      for (let m = 1; m <= 12; m += 1) {
        for (let d = 1; d <= daysInMonth(y, m); d += 1) {
          const iso = `${pad(y, 4)}-${pad(m, 2)}-${pad(d, 2)}T12:34:56Z`;
          expect(epochSecondsOfInstant(iso)).toBe(
            daysFromCivil(y, m, d) * 86400 + 12 * 3600 + 34 * 60 + 56,
          );
          checked += 1;
        }
      }
    }
    expect(checked).toBeGreaterThan(365 * 20);
  });
});

describe('civil — parseIsoDay is strict by shape and by calendar', () => {
  it.each([
    ['2026-01-15', { year: 2026, month: 1, day: 15 }],
    ['2024-02-29', { year: 2024, month: 2, day: 29 }],
    ['2026-01-15T23:59:59Z', { year: 2026, month: 1, day: 15 }],
    ['0000-03-01', { year: 0, month: 3, day: 1 }],
  ])('admits %s', (text, parts) => {
    expect(parseIsoDay(text)).toEqual(parts);
  });

  it.each([
    '2023-02-29',
    '1900-02-29',
    '2026-04-31',
    '2026-13-01',
    '2026-00-10',
    '2026-01-00',
    '15/01/2026',
    '2026',
    '2026-1-15',
    '2026-01-15 10:00',
    '2026-01-1x',
    '',
  ])('refuses %s', (text) => {
    expect(parseIsoDay(text)).toBeUndefined();
  });
});

describe('civil — dateDiffDays keeps the reference spelling on unvalidated months', () => {
  // The reference evaluator does not validate the month, and spells the
  // March-based month `(m + 9) % 12`. A month past 14 is where that spelling and
  // `m > 2 ? m - 3 : m + 9` part company, so it is the case that pins which one
  // the twin uses.
  const one: Table = {
    schema: [{ name: 'k', type: 'int' }],
    columns: [{ name: 'k', type: 'int', cells: [{ kind: 'Int', value: 0 }] }],
  };
  const diff = (from: string, to: string): Cell | undefined => {
    const r = evalPipeline(
      [
        {
          kind: 'derive',
          name: 'x',
          expr: {
            kind: 'apply',
            fn: 'dateDiffDays',
            args: [
              { kind: 'lit', cell: { kind: 'Str', value: from } },
              { kind: 'lit', cell: { kind: 'Str', value: to } },
            ],
          },
        },
      ],
      one,
    );
    if (!r.ok) throw new Error(`eval failed: ${JSON.stringify(r.error)}`);
    return r.value.columns.find((c) => c.name === 'x')?.cells[0];
  };

  it('a real month matches the calendar', () => {
    expect(diff('2024-02-28', '2024-03-01')).toEqual({ kind: 'Int', value: 2 });
  });

  it('month 99 resolves as the reference does', () => {
    // (99 + 9) % 12 = 0 — the reference's March-based index, not 96 — so
    // 2020-99-01 lands where 2020-03-01 does.
    const expected = daysFromCivil(2020, 3, 1) - daysFromCivil(2020, 1, 1);
    expect(daysFromCivil(2020, 99, 1) - daysFromCivil(2020, 1, 1)).toBe(expected);
    expect(diff('2020-01-01', '2020-99-01')).toEqual({ kind: 'Int', value: expected });
  });
});
