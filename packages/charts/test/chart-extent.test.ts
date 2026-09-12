// ============================================================================
//  The chart lowering's EXTENT rule — Phase 1670, generalising Phase 1099.
//
//  Phase 1099 fixed the sparkline's extent, which took `Math.min(...series)` /
//  `Math.max(...series)` where the reference (`Fuaran.UI.Charts`) takes
//  `Array.min` / `Array.max` — a `<` / `>` fold that replaces the accumulator
//  only on a true comparison. Three more sites in the CHART lowering carried the
//  same spread, each confirmed against the reference line by line:
//
//    packages/charts/src/index.ts     Fuaran.UI.Charts/Charts.fs
//    ---------------------------      -------------------------
//    temporalDomain's `days`          `Array.min days` / `Array.max days`
//    the value domain's `values`      `List.min allValues` / `List.max allValues`
//    Scatter's `xValues`              `niceDomain … (Array.min xValues)`
//
//  THE VECTORS BELOW ARE THE DISCRIMINATING ONES, and which defect they
//  discriminate is the finding this phase turned up. The bundle that filed this
//  named two defects at each site — NaN propagation, and the spread's
//  argument-count ceiling — and assumed the first was the live one because it was
//  live for the sparkline. At these three sites it is the other way round:
//
//    * THE CEILING IS REACHABLE and is what these tests catch. A spread passes
//      one argument per element; every engine has a call-frame limit, and on the
//      Node this was written against `Math.min(...xs)` throws `RangeError:
//      Maximum call stack size exceeded` between 100k and 125k elements. A
//      sparkline's series never approaches that. A chart's does — the value
//      domain is rows × series, so a 20k-row seven-series chart is 140k values —
//      and the failure is a THROWN EXCEPTION out of a pure lowering, which takes
//      the whole render with it rather than drawing a wrong picture.
//
//    * NaN IS NOT REACHABLE at any of the three, because three separate guards
//      stand in front of them: `numericOf`'s Phase-640 non-finite clamp on every
//      series cell, Phase 1490's `Number.isFinite` filter on reference lines,
//      Phase 1492's on value-band ends — and a temporal `days` entry is an
//      integer day number that cannot be NaN at all. That is why Phase 1099's
//      search for a discriminating GOLDEN found nothing here and why this class
//      looked like the sparkline's and is not. The guards are pinned below, so
//      that if one is ever removed the removal is what goes red — and the fold is
//      then already in place to keep the extent honest, which is the other half
//      of why the fold lands even where its NaN behaviour is unobservable today.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { lower, type ChartLowerSpec, type ChartRow } from '../src/index.js';

/** Comfortably past every engine's spread ceiling (measured: ~125k on Node 25),
 * and still a fifth of a second to lower — the linear cost of a fold. */
const OVER_THE_CEILING = 140_000;

/** Day `i` after 2000-01-01, as the canonical ISO date a temporal x cell carries. */
const isoDay = (i: number): string => new Date(Date.UTC(2000, 0, 1 + i)).toISOString().slice(0, 10);

const line = (over: Partial<ChartLowerSpec> = {}): ChartLowerSpec => ({
  kind: 'Line',
  xField: 'x',
  yFields: ['y'],
  stacked: false,
  ...over,
});

describe('the extent is a fold, not a spread — the argument-count ceiling', () => {
  // Site 2 of 3: the VALUE domain. One series of 140k values, which is the
  // smallest shape that reaches the ceiling through the public entry point.
  it('a value domain longer than the spread ceiling lowers instead of throwing', () => {
    const rows: ChartRow[] = Array.from({ length: OVER_THE_CEILING }, (_, i) => ({
      x: `c${i}`,
      y: i % 977,
    }));

    const drawing = lower(line(), rows);

    // The picture is drawn AND the extent it was drawn against is real: a fold
    // that threw would fail the call, and a fold that returned NaN would poison
    // every coordinate. Both are excluded, which is the whole claim.
    expect(drawing.shapes.length).toBeGreaterThan(0);
    expect(JSON.stringify(drawing)).not.toContain('NaN');
  });

  // Site 1 of 3: the TEMPORAL domain, whose `days` array is one entry per row.
  it('a temporal domain longer than the spread ceiling lowers instead of throwing', () => {
    const rows: ChartRow[] = Array.from({ length: OVER_THE_CEILING }, (_, i) => ({
      x: isoDay(i),
      y: i % 977,
    }));

    const drawing = lower(line({ xScale: 'Temporal' }), rows);
    expect(drawing.shapes.length).toBeGreaterThan(0);
  });

  // Site 3 of 3: Scatter's x values, which are a value axis of their own.
  it("a scatter's x axis longer than the spread ceiling lowers instead of throwing", () => {
    const rows: ChartRow[] = Array.from({ length: OVER_THE_CEILING }, (_, i) => ({
      x: i,
      y: i % 977,
    }));

    const drawing = lower(line({ kind: 'Scatter' }), rows);
    expect(drawing.shapes.length).toBeGreaterThan(0);
  });
});

describe('why the NaN half of the rule is unobservable here — the three guards', () => {
  // Each of these pins a GUARD, not the fold. Together they are the reason no
  // corpus vector can discriminate the NaN rule at these sites: the lowering
  // cannot be put into a state where a non-finite value reaches an extent. If
  // one of them is ever relaxed, its test is what reports it — and the fold is
  // already there to make the relaxation safe rather than a cross-host
  // divergence.
  const finiteText = (drawing: { shapes: readonly { kind: string }[] }) =>
    drawing.shapes.every((s) => !JSON.stringify(s).includes('NaN'));

  it('a non-finite CELL is clamped before it can reach the value extent', () => {
    const rows: ChartRow[] = [
      { x: 'a', y: 1 },
      { x: 'b', y: NaN },
      { x: 'c', y: 3 },
    ];
    expect(finiteText(lower(line(), rows))).toBe(true);
  });

  it('a non-finite REFERENCE LINE is dropped before it can reach the value extent', () => {
    const rows: ChartRow[] = [
      { x: 'a', y: 1 },
      { x: 'b', y: 3 },
    ];
    const drawing = lower(line({ annotations: [{ kind: 'ReferenceLine', value: NaN }] }), rows);
    expect(finiteText(drawing)).toBe(true);
  });

  it('a non-finite value BAND end drops the whole band before it can reach the extent', () => {
    const rows: ChartRow[] = [
      { x: 'a', y: 1 },
      { x: 'b', y: 3 },
    ];
    const drawing = lower(
      line({
        annotations: [{ kind: 'RangeBand', range: { kind: 'ValueRange', from: 1, to: NaN } }],
      }),
      rows,
    );
    expect(finiteText(drawing)).toBe(true);
  });
});
