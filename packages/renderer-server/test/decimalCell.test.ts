// ============================================================================
//  Phase 2006 — the row value gains an exact decimal, in the static tier.
//
//  The server renderer's Transform rows carry a decimal column as `DecimalCell`,
//  its grid presents them in exact numeric order, and its `renderCellValue`
//  formats them from their digits. The bytes are the client renderer's and the
//  reference host's (`packages/renderer/test/decimalCell.test.ts`).
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { isDecimalCell } from '@fuaran-ui/schema';
import type { Binding, CellFormat, DataSource, Node } from '@fuaran-ui/schema';

import { emptySources, renderCellValue, resolve } from '../src/bindings.js';
import { renderToHtml } from '../src/index.js';

const decimalTexts = [
  '9',
  '10',
  '-2.5',
  '100.25',
  '0.001',
  '12345678901234567.89',
  '12345678901234567.88',
];

const transform = {
  kind: 'Transform',
  source: {
    kind: 'Data',
    source: {
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
    } as unknown as DataSource,
  },
  pipeline: [],
} as unknown as Binding<unknown>;

const grid = (direction: 'asc' | 'desc'): Node<unknown> => {
  const decoded = decodeNode(
    `{"id":"g","kind":{"$type":"DataGrid","columns":[{"field":"amount","kind":{"$type":"Numeric"},"label":"Amount"}],` +
      `"defaultSort":{"column":0,"direction":"${direction}"},"rowKeyField":"amount","sortStateKey":"s",` +
      `"source":{"$type":"State","defaultValue":[],"key":"rows"}}}`,
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

/** The typed rows the Transform resolves to, seeded where the grid reads them. */
const typedRows = (): unknown => {
  const r = resolve(emptySources, transform);
  if (r.kind !== 'Resolved') throw new Error(`expected Resolved, got ${JSON.stringify(r)}`);
  return r.value;
};

const rendered = (direction: 'asc' | 'desc'): string =>
  renderToHtml(grid(direction), { sources: { state: { rows: typedRows() } } });

/** The cell texts in document order. */
const cellTexts = (html: string): string[] =>
  [...html.matchAll(/<td[^>]*><span>([^<]*)<\/span><\/td>/g)].map((m) => m[1]!);

describe('Phase 2006 — CellValue.Decimal in the static tier', () => {
  it('a Transform over a decimal column yields DecimalCell row values', () => {
    const r = resolve(emptySources, transform);
    if (r.kind !== 'Resolved') throw new Error(`expected Resolved, got ${JSON.stringify(r)}`);
    const cells = (r.value as readonly Record<string, unknown>[]).map((row) => row['amount']);
    expect(cells.every(isDecimalCell)).toBe(true);
  });

  it('the grid presents a decimal column in exact numeric order, ascending, byte for byte', () => {
    expect(cellTexts(rendered('asc'))).toEqual([
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
    expect(cellTexts(rendered('desc'))).toEqual([
      '12345678901234567.89',
      '12345678901234567.88',
      '100.25',
      '10',
      '9',
      '0.001',
      '-2.5',
    ]);
  });

  const pins: readonly [CellFormat, string, string][] = [
    [{ kind: 'None' }, '100.25', '100.25'],
    [{ kind: 'Number', decimals: 2 }, '12345678901234567.895', '12345678901234567.90'],
    [{ kind: 'Number', decimals: 2 }, '-0.001', '-0.00'],
    [{ kind: 'Currency', code: 'GBP' }, '99999999999999999.995', 'GBP 100000000000000000.00'],
    [{ kind: 'Percent' }, '0.0625', '6.3%'],
    [{ kind: 'SignificantDigits', digits: 2 }, '0.00012345', '0.00012'],
  ];

  it('CellFormat renders a decimal from its digits, byte for byte', () => {
    for (const [format, text, expected] of pins)
      expect(renderCellValue(format, { kind: 'Decimal', value: text }), text).toBe(expected);
  });
});
