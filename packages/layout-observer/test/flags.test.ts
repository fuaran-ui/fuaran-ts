// ============================================================================
//  Flag-derivation core tests — the per-flag predicates, the combined
//  `deriveFlags`, and the JSON encode byte-shape (parity with the F#
//  LayoutFlag.encode / LayoutObservation.encode output).
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  aspectRatioWildlyOff,
  childClippedByAncestor,
  defaultLayoutObserverOptions,
  deriveFlags,
  emptyLayoutInput,
  encodeFlag,
  encodeObservation,
  overflowHorizontal,
  overflowVertical,
  squeezedToMin,
  zeroDimension,
  type LayoutInput,
} from '../src/index.js';

const base = (over: Partial<LayoutInput> = {}): LayoutInput => ({
  ...emptyLayoutInput(100, 50),
  ...over,
});

describe('overflow predicates', () => {
  it('flags horizontal overflow when scrollWidth exceeds clientWidth and overflow-x clips', () => {
    expect(
      overflowHorizontal(base({ scrollWidth: 200, clientWidth: 100, overflowX: 'hidden' })),
    ).toEqual({
      kind: 'OverflowHorizontal',
    });
  });
  it('does not flag horizontal overflow when overflow-x is visible', () => {
    expect(
      overflowHorizontal(base({ scrollWidth: 200, clientWidth: 100, overflowX: 'visible' })),
    ).toBeUndefined();
  });
  it('does not flag when metrics are unavailable', () => {
    expect(overflowHorizontal(base())).toBeUndefined();
  });
  it('flags vertical overflow symmetrically', () => {
    expect(
      overflowVertical(base({ scrollHeight: 200, clientHeight: 50, overflowY: 'auto' })),
    ).toEqual({
      kind: 'OverflowVertical',
    });
  });
});

describe('zeroDimension', () => {
  it('flags each axis ≤ 0.5px independently', () => {
    expect(zeroDimension(base({ width: 0, height: 0 }))).toEqual([
      { kind: 'ZeroDimension', axis: 'width' },
      { kind: 'ZeroDimension', axis: 'height' },
    ]);
  });
  it('flags only the collapsed axis', () => {
    expect(zeroDimension(base({ width: 100, height: 0.4 }))).toEqual([
      { kind: 'ZeroDimension', axis: 'height' },
    ]);
  });
  it('does not flag a healthy element', () => {
    expect(zeroDimension(base({ width: 100, height: 50 }))).toEqual([]);
  });
});

describe('squeezedToMin', () => {
  it('flags an axis within 0.5px of its computed min', () => {
    expect(squeezedToMin(base({ width: 80.2, minWidth: 80 }))).toEqual([
      { kind: 'SqueezedToMin', axis: 'width' },
    ]);
  });
  it('does not flag when min is zero', () => {
    expect(squeezedToMin(base({ width: 0.3, minWidth: 0 }))).toEqual([]);
  });
  it('does not flag when comfortably above min', () => {
    expect(squeezedToMin(base({ width: 200, minWidth: 80 }))).toEqual([]);
  });
});

describe('childClippedByAncestor', () => {
  it('flags an element extending beyond a clipping ancestor', () => {
    expect(
      childClippedByAncestor(
        base({ elementRect: [0, 0, 200, 50], clippingAncestorRect: [0, 0, 100, 50] }),
      ),
    ).toEqual({ kind: 'ChildClippedByAncestor' });
  });
  it('does not flag an element within its ancestor', () => {
    expect(
      childClippedByAncestor(
        base({ elementRect: [10, 10, 90, 40], clippingAncestorRect: [0, 0, 100, 50] }),
      ),
    ).toBeUndefined();
  });
  it('does not flag when there is no clipping ancestor', () => {
    expect(childClippedByAncestor(base())).toBeUndefined();
  });
});

describe('aspectRatioWildlyOff', () => {
  it('flags a ratio diverging by ≥ the threshold, direction-agnostic', () => {
    // observed 100/10 = 10; expected 1 → magnitude 10 ≥ 3.
    const flag = aspectRatioWildlyOff(3, base({ width: 100, height: 10, expectedAspectRatio: 1 }));
    expect(flag?.kind).toBe('AspectRatioWildlyOff');
    if (flag?.kind === 'AspectRatioWildlyOff') expect(flag.factor).toBeCloseTo(10);
  });
  it('normalises an under-ratio to ≥ 1', () => {
    // observed 10/100 = 0.1; expected 1 → magnitude 10.
    const flag = aspectRatioWildlyOff(3, base({ width: 10, height: 100, expectedAspectRatio: 1 }));
    if (flag?.kind === 'AspectRatioWildlyOff') expect(flag.factor).toBeCloseTo(10);
  });
  it('does not flag within the threshold', () => {
    expect(
      aspectRatioWildlyOff(3, base({ width: 110, height: 100, expectedAspectRatio: 1 })),
    ).toBeUndefined();
  });
  it('does not flag without an expected ratio', () => {
    expect(aspectRatioWildlyOff(3, base({ width: 100, height: 10 }))).toBeUndefined();
  });
});

describe('deriveFlags', () => {
  it('produces a deterministically-ordered combined list', () => {
    const flags = deriveFlags(
      defaultLayoutObserverOptions,
      base({
        width: 0,
        height: 0,
        scrollWidth: 200,
        clientWidth: 100,
        overflowX: 'hidden',
      }),
    );
    expect(flags.map((f) => f.kind)).toEqual([
      'OverflowHorizontal',
      'ZeroDimension',
      'ZeroDimension',
    ]);
  });
  it('returns no flags for a healthy element', () => {
    expect(deriveFlags(defaultLayoutObserverOptions, base({ width: 100, height: 50 }))).toEqual([]);
  });
});

describe('encode — byte-identical to the F# LayoutFlag.encode / LayoutObservation.encode', () => {
  it('encodes nullary flags', () => {
    expect(encodeFlag({ kind: 'OverflowHorizontal' })).toBe('{"kind":"OverflowHorizontal"}');
  });
  it('encodes axis-tagged flags', () => {
    expect(encodeFlag({ kind: 'ZeroDimension', axis: 'width' })).toBe(
      '{"kind":"ZeroDimension","axis":"width"}',
    );
  });
  it('encodes the aspect flag with a 2-decimal factor', () => {
    expect(encodeFlag({ kind: 'AspectRatioWildlyOff', factor: 3.2 })).toBe(
      '{"kind":"AspectRatioWildlyOff","factor":3.20}',
    );
  });
  it('encodes a full observation with 2-decimal metrics + flag array', () => {
    expect(
      encodeObservation({
        nodeId: 'card-1',
        width: 100,
        height: 50.5,
        viewportX: 12,
        viewportY: 8,
        flags: [{ kind: 'OverflowVertical' }, { kind: 'ZeroDimension', axis: 'height' }],
      }),
    ).toBe(
      '{"nodeId":"card-1","width":100.00,"height":50.50,"viewportX":12.00,"viewportY":8.00,"flags":[{"kind":"OverflowVertical"},{"kind":"ZeroDimension","axis":"height"}]}',
    );
  });
});
