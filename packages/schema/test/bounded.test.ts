import { describe, expect, it } from 'vitest';

import {
  BoundedConstructionError,
  boundedInt,
  boundedString,
  fraction,
  fractionOne,
  fractionZero,
  nonEmptyString,
  tryBoundedInt,
  tryFraction,
} from '../src/index.js';

describe('boundedInt', () => {
  it('accepts a value at the lower and upper boundary', () => {
    expect(boundedInt(0, 10, 0)).toBe(0);
    expect(boundedInt(0, 10, 10)).toBe(10);
    expect(boundedInt(0, 10, 5)).toBe(5);
  });

  it('rejects a value one past the upper boundary', () => {
    expect(() => boundedInt(0, 10, 11)).toThrow(BoundedConstructionError);
  });

  it('rejects a value one below the lower boundary', () => {
    expect(() => boundedInt(0, 10, -1)).toThrow(BoundedConstructionError);
  });

  it('rejects an inverted bound', () => {
    expect(() => boundedInt(10, 0, 5)).toThrow(/invalid bound/);
  });

  it('has a non-throwing tryBoundedInt variant', () => {
    expect(tryBoundedInt(0, 10, 5)).toEqual({ ok: true, value: 5 });
    const bad = tryBoundedInt(0, 10, 99);
    expect(bad.ok).toBe(false);
  });
});

describe('boundedString', () => {
  it('accepts a string within [minLen, maxLen]', () => {
    expect(boundedString(2, 4, 'abc')).toBe('abc');
    expect(boundedString(2, 4, 'ab')).toBe('ab');
    expect(boundedString(2, 4, 'abcd')).toBe('abcd');
  });

  it('rejects a string shorter than minLen', () => {
    expect(() => boundedString(2, 4, 'a')).toThrow(BoundedConstructionError);
  });

  it('rejects a string longer than maxLen', () => {
    expect(() => boundedString(2, 4, 'abcde')).toThrow(BoundedConstructionError);
  });
});

describe('nonEmptyString', () => {
  it('accepts a string with non-whitespace content', () => {
    expect(nonEmptyString('x')).toBe('x');
  });

  it('rejects the empty string and whitespace-only strings', () => {
    expect(() => nonEmptyString('')).toThrow(BoundedConstructionError);
    expect(() => nonEmptyString('   ')).toThrow(BoundedConstructionError);
  });
});

describe('fraction', () => {
  it('accepts the closed [0, 1] interval at both boundaries', () => {
    expect(fraction(0)).toBe(0);
    expect(fraction(1)).toBe(1);
    expect(fraction(0.5)).toBe(0.5);
  });

  it('rejects values just outside the boundary', () => {
    expect(() => fraction(-0.0001)).toThrow(BoundedConstructionError);
    expect(() => fraction(1.0001)).toThrow(BoundedConstructionError);
  });

  it('rejects NaN and infinity', () => {
    expect(() => fraction(Number.NaN)).toThrow(/finite/);
    expect(() => fraction(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });

  it('exposes total zero and one constants', () => {
    expect(fractionZero).toBe(0);
    expect(fractionOne).toBe(1);
  });

  it('has a non-throwing tryFraction variant', () => {
    expect(tryFraction(0.25)).toEqual({ ok: true, value: 0.25 });
    expect(tryFraction(2).ok).toBe(false);
  });
});
