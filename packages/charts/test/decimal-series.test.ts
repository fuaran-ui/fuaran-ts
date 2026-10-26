// ============================================================================
//  Phase 2006 — a decimal series plots the exact values.
//
//  `numericOf` is the ONE place a row's exact decimal (`DecimalCell`) becomes a
//  number: a screen coordinate. A decimal chart therefore lowers to exactly the
//  drawing the same values as JS numbers lower to, and not to the flat zero
//  bars a decimal read as text used to draw. Twin of the reference host's
//  `decimalRowValueTests` chart case.
// ============================================================================

import { DecimalCell } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { lower, type ChartLowerSpec, type ChartRow } from '../src/index.js';

const bar: ChartLowerSpec = { kind: 'Bar', xField: 'k', yFields: ['v'], stacked: false };

const floatRows: ChartRow[] = [
  { k: 'a', v: 12.5 },
  { k: 'b', v: 3.25 },
  { k: 'c', v: 100 },
];

const decimalRows: ChartRow[] = [
  { k: 'a', v: new DecimalCell('12.5') },
  { k: 'b', v: new DecimalCell('3.25') },
  { k: 'c', v: new DecimalCell('100') },
];

const zeroRows: ChartRow[] = floatRows.map((r) => ({ ...r, v: 0 }));

describe('Phase 2006 — a decimal series', () => {
  it('plots as the float bars of the same values', () => {
    expect(lower(bar, decimalRows)).toEqual(lower(bar, floatRows));
  });

  it('and not as the flat zero bars a decimal read as text drew', () => {
    expect(lower(bar, decimalRows)).not.toEqual(lower(bar, zeroRows));
  });
});
