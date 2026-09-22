// ============================================================================
//  Encoder coverage — the TypeScript half of the cross-host theme-manifest byte
//  law (Phase 1729, sibling of the Go tier's 1728).
//
//  EVERY byte literal below is copied VERBATIM from the Rust oracle at
//  `fuaran-rs/tests/manifest.rs`, commit
//  62b40d4bbe597160cc6245e192afbd703e6eb629 (Phase 1725) — the first host to
//  emit a theme manifest, and therefore the portable oracle a later encode on
//  another host is held to. They are NOT recorded from a run of the code under
//  test: a byte pin whose recorder is the code under test pins nothing. Read a
//  change to one of them as a wire-format change for every host, not as a
//  fixture refresh.
// ============================================================================

import { parse, renderAstCanonical } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import {
  DEFAULT_WEIGHT,
  type ManifestRole,
  type ThemeManifest,
  decodeManifest,
  emptyManifest,
  encodeManifest,
  merge,
  projectFromCssCustomProperties,
  projectFromFuaranToneVars,
} from '../src/index.js';

/** Decode or fail loudly — every source below is a fixture that must decode. */
const decoded = (json: string): ThemeManifest => {
  const r = decodeManifest(json);
  if (!r.ok) throw new Error(`fixture failed to decode: ${r.error}`);
  return r.value;
};

/** The Rust oracle's `sample_manifest`, field for field. */
const sampleManifest: ThemeManifest = {
  meta: { name: 'test', version: '1.0' },
  tokens: [
    { name: 'color.brand.base', type: 'color', value: '#3b5bdb' },
    { name: 'color.surface', type: 'color', value: '#ffffff' },
    { name: 'space.md', type: 'dimension', value: '16px' },
  ],
  roles: [
    { role: { kind: 'Tone', tone: 'Brand' }, tokenName: 'color.brand.base' },
    { role: { kind: 'Named', name: 'body-text' }, tokenName: 'color.surface' },
  ],
  invariants: [
    { kind: { kind: 'ContrastFloor', role: 'Brand', minRatio: 7 }, weight: DEFAULT_WEIGHT },
  ],
};

/**
 * The canonical bytes of `sampleManifest`. Note what is ABSENT — no
 * `description` (undefined), no `weight` on the invariant (it carries
 * `DEFAULT_WEIGHT`), no `$description` or `$extensions` on any token.
 */
const SAMPLE_BYTES =
  '{"invariants":[{"kind":"ContrastFloor","minRatio":7,"role":"Brand"}],' +
  '"meta":{"name":"test","version":"1.0"},' +
  '"roles":[{"role":{"tone":"Brand"},"token":"color.brand.base"},' +
  '{"role":{"named":"body-text"},"token":"color.surface"}],' +
  '"tokens":{"color":{"brand":{"base":{"$type":"color","$value":"#3b5bdb"}},' +
  '"surface":{"$type":"color","$value":"#ffffff"}},' +
  '"space":{"md":{"$type":"dimension","$value":"16px"}}}}';

/**
 * Every manifest source the decoder tests cover, plus one carrying each
 * invariant arm with its full payload. The Rust oracle's `decodable_sources`.
 */
const decodableSources: readonly string[] = [
  `{"meta":{"name":"acme","version":"2.1","description":"x"},
    "tokens":{"color":{"brand":{"base":{"$type":"color","$value":"#3b5bdb","$description":"brand"}},
                       "surface":{"$type":"color","$value":"#ffffff"}}},
    "roles":[{"role":{"tone":"Brand"},"token":"color.brand.base"}],
    "invariants":[{"kind":"ContrastFloor","role":"Brand","minRatio":7,"weight":2}]}`,
  `{"color":{"accent":{"$type":"color","$value":"#ff8800"}}}`,
  `{"color":{"brand":{"$type":"color","$value":"#3b5bdb","$extensions":{"fuaran":{"role":"accent"}}}}}`,
  `{"tokens":{"a":{"$value":"1"}},
    "invariants":[{"kind":"UsageBudget","token":"a","targetPct":12.5,"tolerancePct":2,"weight":0.25},
                  {"kind":"MotionVoice","maxDurationMs":240,"easing":"ease-out"},
                  {"kind":"MotionVoice"}]}`,
];

describe('encodeManifest — byte parity with the Rust oracle', () => {
  it('pins the canonical bytes of a hand-built manifest', () => {
    expect(encodeManifest(sampleManifest)).toBe(SAMPLE_BYTES);
    // encode∘decode is the identity ON CANONICAL BYTES — the half that says the
    // emitted shape is one the decoder reads back without normalising anything.
    expect(encodeManifest(decoded(SAMPLE_BYTES))).toBe(SAMPLE_BYTES);
  });

  it('pins the canonical bytes of a projected manifest', () => {
    // The same tone-vars source the projector tests project — a manifest this
    // package could derive and, until now, never hand back.
    const m = projectFromFuaranToneVars(
      ':root { --fuaran-tone-brand-bg: #3b5bdb; --fuaran-tone-brand-fg: #fff; }',
    );
    expect(encodeManifest(m)).toBe(
      '{"roles":[{"role":{"tone":"Brand"},"token":"tone.brand.bg"}],' +
        '"tokens":{"tone":{"brand":{"bg":{"$type":"color","$value":"#3b5bdb"},' +
        '"fg":{"$type":"color","$value":"#fff"}}}}}',
    );
  });
});

describe('encodeManifest — the round trip', () => {
  it('decode of encode is the identity on every decoded manifest', () => {
    // A manifest `decodeManifest` produced already carries its tokens in the
    // wire's own order, so the round trip is an exact model identity — no
    // normalisation.
    for (const src of decodableSources) {
      const m = decoded(src);
      expect(decoded(encodeManifest(m)), `source: ${src}`).toEqual(m);
    }
  });

  it('is a fixpoint through the round trip, and loses no token', () => {
    // A projector or `merge` result carries tokens in first-appearance order and
    // the wire's order is sorted, so the round trip there normalises rather than
    // preserving order. The total statement covering every manifest is that
    // encode is a fixpoint through it.
    const base = projectFromCssCustomProperties(':root { --b: 2px; --a: 1px; --c: #fff; }');
    const over = projectFromCssCustomProperties(':root { --b: 9px; }');
    const cases: readonly ThemeManifest[] = [
      base,
      over,
      merge(base, over),
      projectFromFuaranToneVars(
        ':root { --fuaran-tone-critical-bg: #c92a2a; --fuaran-tone-brand-bg: #3b5bdb; }',
      ),
      sampleManifest,
      emptyManifest,
    ];
    for (const m of cases) {
      const once = encodeManifest(m);
      expect(encodeManifest(decoded(once)), `encode∘decode∘encode differs: ${once}`).toBe(once);

      // What the normalisation may NOT do is lose a token: the set of
      // (name, value) pairs survives even where the order does not.
      const pairs = (x: ThemeManifest): string[] =>
        x.tokens.map((t) => `${t.name}=${t.value}`).sort();
      expect(pairs(decoded(once)), 'token set lost through the round trip').toEqual(pairs(m));
    }
  });

  it('emits canonical JSON', () => {
    // The host-neutral half of the claim, and the one a sibling host can check
    // without agreeing with this host about anything else: the output is a
    // fixpoint of the tier's shared canonical renderer. Unsorted keys, a
    // non-canonical number or a stray escape all go red here.
    for (const src of decodableSources) {
      const bytes = encodeManifest(decoded(src));
      const reparsed = parse(bytes);
      expect(reparsed.ok, `encode emits parseable JSON: ${bytes}`).toBe(true);
      if (reparsed.ok)
        expect(renderAstCanonical(reparsed.value), `not canonical: ${bytes}`).toBe(bytes);
    }
  });
});

describe('encodeManifest — omit-at-default', () => {
  it('omits every member the decoder tolerates the absence of', () => {
    // The empty manifest is `tokens` and nothing else — and `tokens` is never
    // omitted even when empty, because a top-level `tokens` key is what selects
    // the wrapper shape in `manifestFromJson`. Dropping it would decode as
    // vanilla DTCG and silently discard meta, roles and invariants.
    expect(encodeManifest(emptyManifest)).toBe('{"tokens":{}}');

    // A default-weight invariant carries no `weight`; a doubled one does.
    const withWeight = (weight: number): ThemeManifest => ({
      ...emptyManifest,
      invariants: [{ kind: { kind: 'MotionVoice', budget: { maxDurationMs: 0 } }, weight }],
    });
    expect(encodeManifest(withWeight(DEFAULT_WEIGHT))).toBe(
      '{"invariants":[{"kind":"MotionVoice"}],"tokens":{}}',
    );
    expect(encodeManifest(withWeight(2))).toBe(
      '{"invariants":[{"kind":"MotionVoice","weight":2}],"tokens":{}}',
    );

    // An absent `role` decodes to `Named('')`, so that one binding omits it.
    const anonymous: ThemeManifest = {
      ...emptyManifest,
      roles: [{ role: { kind: 'Named', name: '' }, tokenName: 't' }],
    };
    expect(encodeManifest(anonymous)).toBe('{"roles":[{"token":"t"}],"tokens":{}}');
    expect(decoded(encodeManifest(anonymous))).toEqual(anonymous);
  });
});

// The three model states the wire cannot carry. Each is reachable only by
// hand-building a `ThemeManifest` — no decoder or projector in this package
// produces one — so these are recorded negative results rather than defects:
// widening any of them is a wire-format question for every host at once.

const bare = (name: string, value: string) => ({ name, type: '', value });

describe('encodeManifest — the model states the wire cannot carry', () => {
  it('resolves colliding token paths last-write-wins, in both directions', () => {
    // A DTCG path addresses a group or a token, never both. The later write wins
    // — the precedence `dedupeTokens` and `merge` already apply — in BOTH
    // directions, which is the half an implementation gets wrong: descending past
    // a leaf must clear it, or the EARLIER token would win instead.
    const deeperLast: ThemeManifest = {
      ...emptyManifest,
      tokens: [bare('a', '1'), bare('a.b', '2')],
    };
    expect(encodeManifest(deeperLast)).toBe('{"tokens":{"a":{"b":{"$value":"2"}}}}');
    expect(decoded(encodeManifest(deeperLast)).tokens).toEqual([bare('a.b', '2')]);

    const shallowerLast: ThemeManifest = {
      ...emptyManifest,
      tokens: [bare('a.b', '2'), bare('a', '1')],
    };
    expect(encodeManifest(shallowerLast)).toBe('{"tokens":{"a":{"$value":"1"}}}');
    expect(decoded(encodeManifest(shallowerLast)).tokens).toEqual([bare('a', '1')]);
  });

  it('emits a $-prefixed first segment the decoder cannot read back', () => {
    // `walkTokens` skips `$`-prefixed keys as DTCG metadata, so such a token is
    // emitted and then not read back. Escaping it would mint wire vocabulary this
    // tier may not mint alone.
    const m: ThemeManifest = { ...emptyManifest, tokens: [bare('$meta', 'x')] };
    expect(encodeManifest(m)).toBe('{"tokens":{"$meta":{"$value":"x"}}}');
    expect(decoded(encodeManifest(m)).tokens).toEqual([]);
  });

  it('returns a tone outside the canonical palette as a named role', () => {
    // `parseRole` validates the tone, so an unrecognised one is a named role on
    // the way back in. The cast is the point: `ToneVariant` is a CLOSED union in
    // this tier where the Rust oracle holds a bare `String`, so the typed surface
    // already refuses this state and only a cast reaches it. The pin records that
    // the two tiers agree on the wire behaviour anyway.
    const bogus: ThemeManifest = {
      ...emptyManifest,
      roles: [{ role: { kind: 'Tone', tone: 'Bogus' } as unknown as ManifestRole, tokenName: 't' }],
    };
    expect(decoded(encodeManifest(bogus)).roles[0]?.role).toEqual({
      kind: 'Named',
      name: 'Bogus',
    });

    // A `Named` holding a VALID tone string is unaffected — it travels on the
    // `named` member and returns as itself.
    const namedBrand: ThemeManifest = {
      ...emptyManifest,
      roles: [{ role: { kind: 'Named', name: 'Brand' }, tokenName: 't' }],
    };
    expect(decoded(encodeManifest(namedBrand))).toEqual(namedBrand);
  });
});
