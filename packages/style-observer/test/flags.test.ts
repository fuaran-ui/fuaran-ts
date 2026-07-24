// ============================================================================
//  Flag-derivation core tests — the colour/contrast primitives, the per-flag
//  predicates, the combined `deriveStyleFlags`, and the JSON encode byte-shape
//  (parity with the F# StyleFlag.encode / StyleObservation.encode / Rgba.encode
//  output).
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  accentIndistinct,
  baselineStyleInput,
  black,
  composite,
  contrast,
  contrastBelowAA,
  contrastRatio,
  defaultStyleObserverOptions,
  deriveStyleFlags,
  effectiveBackground,
  encodeRgba,
  encodeStyleFlag,
  encodeStyleObservation,
  fontRole,
  invisibleText,
  isOpaque,
  rgb,
  rgba,
  sameRgb,
  toStyleObservation,
  transparent,
  tryParseHex,
  white,
  type StyleInput,
} from '../src/index.js';

const input = (over: Partial<StyleInput> = {}): StyleInput => ({
  ...baselineStyleInput(),
  ...over,
});

describe('Rgba primitives', () => {
  it('classifies opacity', () => {
    expect(isOpaque(white)).toBe(true);
    expect(isOpaque(rgba(0, 0, 0, 0.5))).toBe(false);
    expect(isOpaque(transparent)).toBe(false);
  });
  it('compares rgb after rounding, ignoring alpha', () => {
    expect(sameRgb(rgb(255, 128, 0), rgba(255.4, 127.6, 0.2, 0.3))).toBe(true);
    expect(sameRgb(rgb(255, 128, 0), rgb(254, 128, 0))).toBe(false);
  });
  it('parses #rgb / #rrggbb / #rrggbbaa hex', () => {
    expect(tryParseHex('#fff')).toEqual(rgb(255, 255, 255));
    expect(tryParseHex('#ff8800')).toEqual(rgb(255, 136, 0));
    expect(tryParseHex('#ff880080')).toEqual(rgba(255, 136, 0, 128 / 255));
    expect(tryParseHex('not-a-hex')).toBeUndefined();
  });
  it('encodes 2-decimal invariant — byte-identical to F# Rgba.encode', () => {
    expect(encodeRgba(white)).toBe('{"r":255.00,"g":255.00,"b":255.00,"a":1.00}');
    expect(encodeRgba(rgba(0, 0, 0, 0))).toBe('{"r":0.00,"g":0.00,"b":0.00,"a":0.00}');
  });
});

describe('compositing + WCAG contrast', () => {
  it('source-over composites a translucent layer over an opaque base', () => {
    // 50% black over white → mid grey, opaque.
    const c = composite(rgba(0, 0, 0, 0.5), white);
    expect(c.r).toBeCloseTo(127.5);
    expect(c.a).toBeCloseTo(1);
  });
  it('folds a layer stack down to the first opaque layer, white base otherwise', () => {
    expect(effectiveBackground([])).toEqual(white);
    expect(effectiveBackground([transparent, white])).toEqual(white);
    expect(effectiveBackground([rgb(10, 20, 30), rgb(99, 99, 99)])).toEqual(rgb(10, 20, 30));
  });
  it('contrastRatio is 21 for black-on-white and 1 for identical colours', () => {
    expect(contrastRatio(black, white)).toBeCloseTo(21);
    expect(contrastRatio(white, white)).toBeCloseTo(1);
  });
});

describe('fontRole classification', () => {
  it('maps family substrings, case- and locale-independent', () => {
    expect(fontRole(input({ fontFamily: 'ui-monospace, Menlo' }))).toBe('Monospace');
    expect(fontRole(input({ fontFamily: 'Inter, sans-serif' }))).toBe('SansSerif');
    expect(fontRole(input({ fontFamily: 'Georgia, serif' }))).toBe('Serif');
    expect(fontRole(input({ fontFamily: 'Wingdings' }))).toBe('Unknown');
    expect(fontRole(input())).toBe('Unknown');
  });
});

describe('per-flag predicates', () => {
  const opts = defaultStyleObserverOptions;

  it('flags InvisibleText when foreground ≈ background', () => {
    const flag = invisibleText(
      opts.invisibleTextThreshold,
      input({ foreground: white, backgroundLayers: [white] }),
    );
    expect(flag).toEqual({ kind: 'InvisibleText', ratio: 1 });
  });
  it('does not flag InvisibleText for legible text', () => {
    expect(
      invisibleText(
        opts.invisibleTextThreshold,
        input({ foreground: black, backgroundLayers: [white] }),
      ),
    ).toBeUndefined();
  });
  it('flags ContrastBelowAA for mid-grey text on white', () => {
    const flag = contrastBelowAA(
      opts.invisibleTextThreshold,
      opts.contrastAAThreshold,
      input({ foreground: rgb(150, 150, 150), backgroundLayers: [white] }),
    );
    expect(flag?.kind).toBe('ContrastBelowAA');
    if (flag?.kind === 'ContrastBelowAA') {
      expect(flag.ratio).toBeGreaterThanOrEqual(opts.invisibleTextThreshold);
      expect(flag.ratio).toBeLessThan(opts.contrastAAThreshold);
    }
  });
  it('does not flag ContrastBelowAA for black-on-white (above the floor)', () => {
    expect(
      contrastBelowAA(
        opts.invisibleTextThreshold,
        opts.contrastAAThreshold,
        input({ foreground: black, backgroundLayers: [white] }),
      ),
    ).toBeUndefined();
  });
  it('flags AccentIndistinct when a toned tint barely contrasts its container', () => {
    const flag = accentIndistinct(
      opts.accentIndistinctThreshold,
      input({ emittedTone: 'brand', backgroundLayers: [rgb(240, 240, 240), white] }),
    );
    expect(flag?.kind).toBe('AccentIndistinct');
  });
  it('does not flag AccentIndistinct for an untoned or transparently-backed element', () => {
    expect(
      accentIndistinct(
        opts.accentIndistinctThreshold,
        input({ backgroundLayers: [rgb(240, 240, 240), white] }),
      ),
    ).toBeUndefined();
    expect(
      accentIndistinct(
        opts.accentIndistinctThreshold,
        input({ emittedTone: 'brand', backgroundLayers: [] }),
      ),
    ).toBeUndefined();
    expect(
      accentIndistinct(
        opts.accentIndistinctThreshold,
        input({ emittedTone: 'brand', backgroundLayers: [transparent, white] }),
      ),
    ).toBeUndefined();
  });
});

describe('deriveStyleFlags', () => {
  it('partitions the contrast axis — invisible XOR below-AA, never both', () => {
    const invisible = deriveStyleFlags(
      defaultStyleObserverOptions,
      input({ foreground: white, backgroundLayers: [white] }),
    );
    expect(invisible.map((f) => f.kind)).toEqual(['InvisibleText']);
  });
  it('produces a deterministically-ordered combined list (contrast then accent)', () => {
    const flags = deriveStyleFlags(
      defaultStyleObserverOptions,
      input({ foreground: white, emittedTone: 'brand', backgroundLayers: [white, white] }),
    );
    expect(flags.map((f) => f.kind)).toEqual(['InvisibleText', 'AccentIndistinct']);
  });
  it('returns no flags for legible black-on-white', () => {
    expect(
      deriveStyleFlags(
        defaultStyleObserverOptions,
        input({ foreground: black, backgroundLayers: [white] }),
      ),
    ).toEqual([]);
  });
});

describe('encode — byte-identical to the F# StyleFlag.encode / StyleObservation.encode', () => {
  it('encodes the manifest-free ratio flags', () => {
    expect(encodeStyleFlag({ kind: 'ContrastBelowAA', ratio: 3.21 })).toBe(
      '{"kind":"ContrastBelowAA","ratio":3.21}',
    );
    expect(encodeStyleFlag({ kind: 'InvisibleText', ratio: 1.02 })).toBe(
      '{"kind":"InvisibleText","ratio":1.02}',
    );
    expect(encodeStyleFlag({ kind: 'AccentIndistinct', ratio: 2.5 })).toBe(
      '{"kind":"AccentIndistinct","ratio":2.50}',
    );
  });
  it('encodes the manifest-aware flags (parity-only vocabulary)', () => {
    expect(encodeStyleFlag({ kind: 'TokenResolutionFailed', slot: 'brand' })).toBe(
      '{"kind":"TokenResolutionFailed","slot":"brand"}',
    );
    expect(encodeStyleFlag({ kind: 'OffPaletteColour', value: '#abcdef' })).toBe(
      '{"kind":"OffPaletteColour","value":"#abcdef"}',
    );
    expect(
      encodeStyleFlag({
        kind: 'UsageBudgetExceeded',
        token: 'accent',
        declaredPct: 10,
        observedPct: 42.5,
      }),
    ).toBe(
      '{"kind":"UsageBudgetExceeded","token":"accent","declaredPct":10.00,"observedPct":42.50}',
    );
    expect(
      encodeStyleFlag({ kind: 'ContrastBelowDeclaredFloor', role: 'body', ratio: 3.8, floor: 4.5 }),
    ).toBe('{"kind":"ContrastBelowDeclaredFloor","role":"body","ratio":3.80,"floor":4.50}');
  });
  it('encodes a full observation with null emittedTone + 2-decimal fields', () => {
    const obs = toStyleObservation(
      defaultStyleObserverOptions,
      'node-1',
      input({ foreground: black, backgroundLayers: [white] }),
    );
    expect(encodeStyleObservation(obs)).toBe(
      '{"nodeId":"node-1","foreground":{"r":0.00,"g":0.00,"b":0.00,"a":1.00},"effectiveBackground":{"r":255.00,"g":255.00,"b":255.00,"a":1.00},"fontRole":"Unknown","emittedTone":null,"contrastRatio":21.00,"flags":[]}',
    );
  });
  it('encodes a present emittedTone as a quoted string', () => {
    const obs = toStyleObservation(
      defaultStyleObserverOptions,
      'node-2',
      input({ foreground: black, backgroundLayers: [white], emittedTone: 'brand' }),
    );
    expect(encodeStyleObservation(obs)).toContain('"emittedTone":"brand"');
  });
});
