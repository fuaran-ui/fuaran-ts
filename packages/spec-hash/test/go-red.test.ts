// ============================================================================
//  The gate goes red.
//
//  A green run that exercised nothing looks exactly like a green run that
//  exercised everything, so the two suites beside this one are worth what this
//  one proves about them: that each is asking a question an implementation can
//  fail, and that the vectors they run genuinely discriminate the rules they are
//  said to pin.
//
//  Every probe here is in-code. Nothing mutates a committed file, because a
//  self-test that edited its own fixtures would be indistinguishable from the
//  drift it exists to catch.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { canonicalise, mint, sha256Hex } from '../src/index.js';
import { loadVector, manifest, specPayloadOf, type Vector } from './corpus.js';
import { crossHostVectors } from './vectors.js';

const vector = (id: string): Vector => {
  const v = manifest().vectors.find((x) => x.id === id);
  if (!v) throw new Error(`the corpus no longer carries '${id}'`);
  return v;
};

const canonicalOf = (rendered: string): string => {
  const outcome = canonicalise(rendered);
  if (!outcome.ok) throw new Error(`unexpected refusal for ${rendered}`);
  return outcome.value;
};

describe('a changed document is a changed identity', () => {
  it('a one-character edit no longer reproduces the pinned intermediate or digest', () => {
    const v = vector('spec-hash/canonical-form');
    const { specPayload } = specPayloadOf(loadVector(v));
    const mutated = specPayload.replace('"scale":2.5', '"scale":2.6');
    expect(mutated, 'the probe must actually change the payload').not.toBe(specPayload);

    expect(canonicalOf(mutated)).not.toBe(v.canonicalPayload);
    expect(mint(mutated)).not.toEqual(mint(specPayload));
  });

  it('a corrupted cross-host expectation is detected by the same comparison the gate runs', () => {
    // The gate compares this implementation's output against a committed
    // expectation. Corrupt the expectation and the comparison must report it —
    // otherwise the comparison is not the thing doing the work.
    const file = crossHostVectors();
    const first = file.vectors[0];
    expect(first, 'the file carries vectors').toBeDefined();

    const corrupted = {
      ...(first as (typeof file.vectors)[number]),
      digest: 'sha256:' + '0'.repeat(64),
    };
    const outcome = mint(corrupted.rendered);
    expect(
      outcome.ok && outcome.value === corrupted.digest,
      'a corrupted digest must NOT compare equal',
    ).toBe(false);
  });
});

describe('the vectors discriminate the rules they are said to pin', () => {
  it('the ordering rule is code UNIT, and the unicode vector can tell the difference', () => {
    // The astral key sorts BEFORE U+FFFD by UTF-16 code unit and AFTER it by code
    // point. If the vector's keys did not straddle that boundary, an implementation
    // sorting the wrong way would still pass — so the discrimination is asserted
    // here rather than assumed of the corpus.
    const astral = '\u{10000}';
    const replacement = '�';
    expect(astral < replacement, 'code-unit order puts the astral key first').toBe(true);
    expect(
      (astral.codePointAt(0) as number) < (replacement.codePointAt(0) as number),
      'code-point order puts it last',
    ).toBe(false);

    const pinned = vector('spec-hash/unicode').canonicalPayload as string;
    expect(
      pinned.indexOf(`"${astral}"`),
      'and the pinned intermediate follows code-unit order',
    ).toBeLessThan(pinned.indexOf(`"${replacement}"`));
  });

  it('an implementation that did not sort object members fails the permuted vector', () => {
    // The deliberately-wrong implementation: everything the real one does except
    // the recursive member ordering. It must reproduce `canonical-form` (already a
    // fixed point) and FAIL `permuted-form`, which is precisely what makes that
    // pair the family's reason for existing.
    const unsorted = (rendered: string): string => JSON.stringify(JSON.parse(rendered) as unknown);

    const canonicalForm = specPayloadOf(loadVector(vector('spec-hash/canonical-form'))).specPayload;
    const permutedForm = specPayloadOf(loadVector(vector('spec-hash/permuted-form'))).specPayload;

    expect(canonicalOf(canonicalForm), 'the rule agrees with the pin here').toBe(
      vector('spec-hash/canonical-form').canonicalPayload,
    );
    expect(unsorted(permutedForm), 'an unsorted implementation does not').not.toBe(
      vector('spec-hash/permuted-form').canonicalPayload,
    );
    expect(canonicalOf(permutedForm), 'and the real one does').toBe(
      vector('spec-hash/permuted-form').canonicalPayload,
    );
  });

  it('the reject vector is a WRONG hash, re-derived rather than trusted', () => {
    const v = vector('spec-hash/reject-raw-bytes-minted');
    const { specPayload, specHash } = specPayloadOf(loadVector(v));
    expect(specHash, 'it is the digest of the rendering as written').toBe(
      `sha256:${sha256Hex(specPayload)}`,
    );
    expect(mint(specPayload)).not.toEqual({ ok: true, value: specHash });
  });
});

describe('the refusals are not free', () => {
  it('a duplicate member is refused here and silently resolved by the platform parser', () => {
    // `JSON.parse` keeps the last duplicate without complaint. That is the whole
    // reason this package carries its own reader, and the reason a refusal test
    // that used the platform parser would be vacuous.
    const rendered = '{"a":1,"b":2,"a":3}';
    expect(JSON.parse(rendered), 'the platform parser resolves it').toEqual({ a: 3, b: 2 });
    const outcome = mint(rendered);
    expect(outcome.ok).toBe(false);
    expect(!outcome.ok && outcome.refusal.kind).toBe('duplicate-members');
  });

  it('an integer beyond exact binary64 range is refused on its TOKEN, not on its value', () => {
    // 2^53 + 1 parses to 2^53, so a range check on the parsed double would accept
    // exactly the case the rule exists to exclude.
    expect(Number('9007199254740993'), 'the parsed value is indistinguishable from 2^53').toBe(
      9007199254740992,
    );
    const outcome = mint('{"a":9007199254740993}');
    expect(!outcome.ok && outcome.refusal.kind).toBe('number-not-representable');
    expect(mint('{"a":9007199254740992}').ok, 'while the largest exact integer is accepted').toBe(
      true,
    );
  });

  it('an unpaired surrogate is refused rather than replaced', () => {
    const outcome = mint('{"a":"\\ud800"}');
    expect(!outcome.ok && outcome.refusal.kind).toBe('ill-formed-unicode');
  });
});
