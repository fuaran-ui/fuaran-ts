import { describe, expect, it } from 'vitest';
import {
  epochSecondsOfInstant,
  sinceUnitAndCount,
  truncateToGrain,
  type RelativeTimeUnit,
} from '../src/index.js';

// ============================================================================
//  The host instant — grain truncation and the `Format.Since` reduction
//  (Phase 1533, WIRE_FORMAT.md §3.3.1).
//
//  These pin the two halves the SPECIFICATION makes normative and every host
//  must reproduce: the truncation table, and the (unit, count) reduction. They
//  are deliberately NOT tests of wording — turning a pair into words is
//  locale-aware rendering, and §13 already places `Binding.Format` in the
//  fidelity tier where an Intl host and a stdlib-only host differ.
//
//  The expected values are transcribed from the specification's tables rather
//  than from this implementation's output, which is the only way this file
//  functions as a conformance check on the reference tier rather than as a
//  snapshot of it.
// ============================================================================

const PINNED = '2026-08-02T06:59:24Z';

describe('truncateToGrain — WIRE_FORMAT §3.3.1', () => {
  it('truncates by prefix, and Second is the identity', () => {
    // Second is the DEFAULT grain, so a document declaring none must resolve
    // through exactly the bytes Phase 765 shipped.
    expect(truncateToGrain('Second', PINNED)).toBe('2026-08-02T06:59:24Z');
    expect(truncateToGrain('Minute', PINNED)).toBe('2026-08-02T06:59:00Z');
    expect(truncateToGrain('Hour', PINNED)).toBe('2026-08-02T06:00:00Z');
    // The whole reason the field exists: the YYYY-MM-DD a day-difference verb reads.
    expect(truncateToGrain('Day', PINNED)).toBe('2026-08-02');
  });

  it('keeps sub-second precision at Second and discards it at every coarser grain', () => {
    const fractional = '2026-08-02T06:59:24.512Z';
    expect(truncateToGrain('Second', fractional)).toBe(fractional);
    expect(truncateToGrain('Minute', fractional)).toBe('2026-08-02T06:59:00Z');
    expect(truncateToGrain('Day', fractional)).toBe('2026-08-02');
  });

  it('passes an instant too short to slice through verbatim, never padded', () => {
    // A host-furnished value is not wire data, and a renderer is the wrong place
    // to adjudicate a host's clock format.
    expect(truncateToGrain('Hour', '2026-08-02')).toBe('2026-08-02');
    expect(truncateToGrain('Day', '')).toBe('');
  });
});

describe('epochSecondsOfInstant — the parser both Since and the grain rest on', () => {
  it('reads the canonical form', () => {
    // Hand-checkable anchors, so an arithmetic slip in days-from-civil cannot
    // hide behind a plausible-looking large number.
    expect(epochSecondsOfInstant('1970-01-01T00:00:00Z')).toBe(0);
    expect(epochSecondsOfInstant('1970-01-02')).toBe(86400);
    expect(epochSecondsOfInstant('1970-01-01T00:01:05Z')).toBe(65);
    expect(epochSecondsOfInstant('2000-02-29')).toBe(951782400);
  });

  it('refuses what is not a canonical instant, rather than inventing one', () => {
    for (const bad of ['', 'not-a-date', '20260802', '0000-01-01', '2026-13-01', '2026-08-32']) {
      expect(epochSecondsOfInstant(bad), bad).toBeUndefined();
    }
  });

  it('agrees with Date.UTC on the canonical form — an independent oracle, not a second implementation', () => {
    // The implementation deliberately does NOT call Date.parse (two runtimes'
    // parsers are two oracles for one question). This checks the arithmetic
    // against the platform on inputs where the platform is unambiguous, which is
    // the whole value of not depending on it.
    for (const iso of [PINNED, '1999-12-31T23:59:59Z', '2024-02-29T12:00:00Z']) {
      expect(epochSecondsOfInstant(iso), iso).toBe(Date.parse(iso) / 1000);
    }
  });
});

describe('sinceUnitAndCount — the normative Format.Since reduction', () => {
  it('picks the largest unit that fits, on BOTH sides of every ladder boundary', () => {
    const cases: readonly (readonly [number, RelativeTimeUnit, number])[] = [
      [-1, 'Second', -1],
      [-59, 'Second', -59],
      [-60, 'Minute', -1],
      [-3599, 'Minute', -59],
      [-3600, 'Hour', -1],
      [-86399, 'Hour', -23],
      [-86400, 'Day', -1],
      [-604799, 'Day', -6],
      [-604800, 'Week', -1],
      [-2629745, 'Week', -4],
      [-2629746, 'Month', -1],
      [-31556951, 'Month', -11],
      [-31556952, 'Year', -1],
      // The future direction is the same ladder with the sign kept.
      [7200, 'Hour', 2],
      [0, 'Second', 0],
    ];
    for (const [delta, unit, count] of cases) {
      expect(sinceUnitAndCount(undefined, delta), String(delta)).toEqual([unit, count]);
    }
  });

  it('truncates toward zero — 3599 seconds is 59 minutes, never 1 hour', () => {
    // Truncation rather than rounding, so the ladder and the count agree at
    // every boundary; rounding would break them exactly where a reader checks.
    expect(sinceUnitAndCount(undefined, -3599)).toEqual(['Minute', -59]);
    expect(sinceUnitAndCount('Hour', -3599)).toEqual(['Hour', 0]);
  });

  it('uses a declared unit verbatim, however large the delta', () => {
    expect(sinceUnitAndCount('Day', -31556952)).toEqual(['Day', -365]);
  });
});
