// ============================================================================
//  Phase 2006 — the row value gains an exact decimal.
//
//  A decimal column reaches a row as a `DecimalCell` (the typed path keeps the
//  type the Transform schema gave it), projects to `CellValue.Decimal`, sorts in
//  exact numeric order and formats from its digits. The sorted order and the
//  formatted text are pinned byte for byte, and they are the SAME bytes the
//  reference host's `decimalRowValueTests` pins.
// ============================================================================

import { DecimalCell, isDecimalCell } from '@fuaran-ui/schema';
import type { Binding, CellFormat, ColumnErased, DataSource } from '@fuaran-ui/schema';
import { encodeRows } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import { emptySources, formatNumber, renderCellValue, resolve } from '../src/bindings.js';
import { sortRowsByDescriptor } from '../src/render/Visualisation.js';

/** Lexical, float and exact order all disagree somewhere; the last two are one double. */
const decimalTexts = [
  '9',
  '10',
  '-2.5',
  '100.25',
  '0.001',
  '12345678901234567.89',
  '12345678901234567.88',
];

const source: DataSource = {
  kind: 'Embedded',
  table: {
    schema: [{ name: 'amount', type: 'decimal' }],
    columns: [
      {
        name: 'amount',
        type: 'decimal',
        cells: decimalTexts.map((value) => ({ kind: 'Decimal', value })),
      },
    ],
  },
} as unknown as DataSource;

const transform = {
  kind: 'Transform',
  source: { kind: 'Data', source },
  pipeline: [],
} as unknown as Binding<unknown>;

const rowsFrom = (r: { readonly kind: string; readonly value?: unknown }): readonly unknown[] => {
  if (r.kind !== 'Resolved') throw new Error(`expected Resolved, got ${JSON.stringify(r)}`);
  return r.value as readonly unknown[];
};

const decimalRows = (): readonly unknown[] => rowsFrom(resolve(emptySources, transform));

const amountColumn = {
  label: 'Amount',
  field: 'amount',
  kind: { kind: 'Text' },
} as unknown as ColumnErased<unknown>;

const amounts = (rows: readonly unknown[]): string[] =>
  rows.map((r) => String((r as Record<string, unknown>)['amount']));

describe('Phase 2006 — CellValue.Decimal', () => {
  it('a Transform over a decimal column yields DecimalCell row values carrying the canonical text', () => {
    const cells = decimalRows().map((r) => (r as Record<string, unknown>)['amount']);
    expect(cells.every(isDecimalCell)).toBe(true);
    expect(cells.map((c) => (c as DecimalCell).text)).toEqual(decimalTexts);
  });

  it('the grid sorts a decimal column in exact numeric order, ascending, byte for byte', () => {
    expect(amounts(sortRowsByDescriptor([amountColumn], [0, 'asc'], decimalRows()))).toEqual([
      '-2.5',
      '0.001',
      '9',
      '10',
      '100.25',
      '12345678901234567.88',
      '12345678901234567.89',
    ]);
  });

  it('and descending is the exact reverse', () => {
    expect(amounts(sortRowsByDescriptor([amountColumn], [0, 'desc'], decimalRows()))).toEqual([
      '12345678901234567.89',
      '12345678901234567.88',
      '100.25',
      '10',
      '9',
      '0.001',
      '-2.5',
    ]);
  });

  it('a bare string stays Text: a decimal-looking string sorts as text, never guessed at', () => {
    const rows = [{ amount: '9' }, { amount: '10' }];
    expect(amounts(sortRowsByDescriptor([amountColumn], [0, 'asc'], rows))).toEqual(['10', '9']);
  });

  const pins: readonly [CellFormat, string, string][] = [
    [{ kind: 'None' }, '100.25', '100.25'],
    [{ kind: 'Number' }, '10', '10'],
    [{ kind: 'Number' }, '0.001', '0.001'],
    [{ kind: 'Number', decimals: 2 }, '12345678901234567.895', '12345678901234567.90'],
    [{ kind: 'Number', decimals: 2 }, '-0.001', '-0.00'],
    [{ kind: 'Number', decimals: 0 }, '2.5', '3'],
    [{ kind: 'Currency', code: 'GBP' }, '1234.5', 'GBP 1234.50'],
    [{ kind: 'Currency', code: 'GBP' }, '99999999999999999.995', 'GBP 100000000000000000.00'],
    [{ kind: 'Percent' }, '0.0625', '6.3%'],
    [{ kind: 'Percent', decimals: 2 }, '0.123456', '12.35%'],
    [{ kind: 'SignificantDigits', digits: 3 }, '123456', '123000'],
    [{ kind: 'SignificantDigits', digits: 2 }, '0.00012345', '0.00012'],
  ];

  it('CellFormat renders a decimal from its digits, byte for byte, ', () => {
    for (const [format, text, expected] of pins) {
      const value = { kind: 'Decimal', value: text } as const;
      expect(renderCellValue(format, value), `${text} ${JSON.stringify(format)}`).toBe(expected);
    }
  });

  it('where the float is exact, a decimal formats exactly as the float does', () => {
    const formats: readonly CellFormat[] = [
      { kind: 'None' },
      { kind: 'Number' },
      { kind: 'Number', decimals: 0 },
      { kind: 'Number', decimals: 3 },
      { kind: 'Currency', code: 'USD' },
      { kind: 'Percent' },
      { kind: 'Percent', decimals: 2 },
      { kind: 'SignificantDigits', digits: 3 },
    ];
    const cases: readonly [string, number][] = [
      ['1234.5', 1234.5],
      ['-0.25', -0.25],
      ['10', 10],
      ['0.125', 0.125],
    ];
    for (const [text, value] of cases)
      for (const format of formats)
        expect(
          renderCellValue(format, { kind: 'Decimal', value: text }),
          `${text} ${JSON.stringify(format)}`,
        ).toBe(formatNumber(format, value));
  });

  it('the row encoder writes a decimal as its canonical text: the wire bytes are unchanged', () => {
    expect(encodeRows([{ amount: new DecimalCell('12.5') }])).toBe(
      encodeRows([{ amount: '12.5' }]),
    );
  });

  it("a DecimalCell's string and JSON forms are its text", () => {
    const d = new DecimalCell('12.5');
    expect(String(d)).toBe('12.5');
    expect(JSON.stringify({ d })).toBe('{"d":"12.5"}');
  });
});
