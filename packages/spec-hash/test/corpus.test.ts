// ============================================================================
//  The corpus gate: this implementation against the specification's own vectors.
//
//  Every `hash` vector pins BOTH halves of the rule — the canonical intermediate
//  (written out precisely so a divergence says WHERE) and the digest minted over
//  it. Reproducing the digest without the intermediate would tell you that you
//  are right; reproducing both tells you why.
//
//  Two things the corpus asks of a harness rather than of an implementation, and
//  both are asserted below: that the number of vectors executed equals the number
//  the manifest enumerates, and that a mutated document makes the harness go red
//  (see `go-red.test.ts`). A conformance suite is exactly the kind of code that
//  passes by doing nothing.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { ALGORITHM_ID, canonicalise, describeRefusal, mint, sha256Hex } from '../src/index.js';
import { loadVector, manifest, specPayloadOf, type Vector } from './corpus.js';

const specHashVectors = (): readonly Vector[] =>
  manifest().vectors.filter((v) => v.family === 'spec-hash');

const hashVectors = (): readonly Vector[] => specHashVectors().filter((v) => v.kind === 'hash');

const expectCanonical = (v: Vector): string => {
  const { specPayload } = specPayloadOf(loadVector(v));
  const outcome = canonicalise(specPayload);
  if (!outcome.ok) throw new Error(`${v.id}: ${describeRefusal(outcome.refusal)}`);
  return outcome.value;
};

const expectMint = (v: Vector): string => {
  const { specPayload } = specPayloadOf(loadVector(v));
  const outcome = mint(specPayload);
  if (!outcome.ok) throw new Error(`${v.id}: ${describeRefusal(outcome.refusal)}`);
  return outcome.value;
};

describe('the corpus enumerates the family this gate runs', () => {
  it('names the family, and it is not empty', () => {
    // A gate that selected nothing would pass every assertion below by never
    // reaching one.
    expect(manifest().families).toContain('spec-hash');
    expect(specHashVectors().length).toBeGreaterThan(0);
  });

  it('includes both kinds — the hash vectors and the one reject', () => {
    expect(hashVectors().length).toBeGreaterThan(0);
    expect(specHashVectors().filter((v) => v.kind === 'reject').length).toBe(1);
  });

  it('every vector executed is a vector the manifest enumerates', () => {
    // The count assertion, stated over the partition this suite actually runs:
    // hash vectors + reject vectors must exhaust the family, so a future vector
    // kind cannot arrive and be silently ignored.
    const family = specHashVectors();
    const covered = family.filter((v) => v.kind === 'hash' || v.kind === 'reject');
    expect(covered.length).toBe(family.length);
  });

  it('each vector is the bytes the manifest pins', () => {
    // The corpus records each file's own digest. Checking it means a fixture that
    // drifted from its manifest entry fails HERE, naming the file, rather than
    // downstream as an inexplicable hash disagreement.
    for (const v of specHashVectors()) {
      expect(sha256Hex(loadVector(v)), `${v.id}: the fixture's own bytes`).toBe(v.sha256);
    }
  });
});

describe('the canonical intermediate', () => {
  it('is reproduced byte for byte on every hash vector', () => {
    let compared = 0;
    for (const v of hashVectors()) {
      expect(
        v.canonicalPayload,
        `${v.id} is a hash vector and must pin its intermediate`,
      ).toBeTypeOf('string');
      expect(
        expectCanonical(v),
        `${v.id}: the intermediate is written out so a divergence says WHERE`,
      ).toBe(v.canonicalPayload);
      compared += 1;
    }
    expect(compared, 'every hash vector had its intermediate compared').toBe(hashVectors().length);
  });

  it('is a fixed point — canonicalising it again changes nothing', () => {
    // The rule is a NORMALISATION. Stated here rather than assumed, because an
    // implementation that were merely self-consistent would satisfy every vector
    // above while producing an intermediate that is not canonical.
    for (const v of hashVectors()) {
      const once = expectCanonical(v);
      const twice = canonicalise(once);
      expect(twice.ok && twice.value, `${v.id}: the intermediate re-canonicalises to itself`).toBe(
        once,
      );
    }
  });
});

describe('the minted digest', () => {
  it('is reproduced on every hash vector, and equals the one the document carries', () => {
    let minted = 0;
    for (const v of hashVectors()) {
      const value = expectMint(v);
      expect(value, `${v.id}: the recomputed digest`).toBe(v.digest);
      expect(value, `${v.id}: and the hash the submission itself carries`).toBe(
        specPayloadOf(loadVector(v)).specHash,
      );
      expect(
        specPayloadOf(loadVector(v)).specHashAlgorithm,
        `${v.id}: minted under the rule this gate checks`,
      ).toBe(ALGORITHM_ID);
      minted += 1;
    }
    expect(minted, 'every hash vector was actually minted').toBe(hashVectors().length);
  });

  it('is one identity for the pair that differ only in authoring order', () => {
    // The family's reason for existing: the same specification, authored with its
    // members permuted and laid out across lines, minting one hash. An
    // implementation that reproduces every other vector but not this pairing has a
    // canonicalisation that depends on authoring order.
    const canonicalForm = hashVectors().find((v) => v.id === 'spec-hash/canonical-form');
    const permutedForm = hashVectors().find((v) => v.id === 'spec-hash/permuted-form');
    expect(canonicalForm, 'the corpus still carries the canonical-form vector').toBeDefined();
    expect(permutedForm, 'the corpus still carries the permuted-form vector').toBeDefined();

    const a = specPayloadOf(loadVector(canonicalForm as Vector)).specPayload;
    const b = specPayloadOf(loadVector(permutedForm as Vector)).specPayload;
    expect(a, 'the two renderings genuinely differ on the wire').not.toBe(b);
    expect(expectMint(permutedForm as Vector), 'and mint one identity').toBe(
      expectMint(canonicalForm as Vector),
    );
  });
});

describe('the reject vector — the one error the rule exists to exclude', () => {
  // Nothing downstream is permitted to notice a hash minted over the wrong bytes:
  // the party that receives it stores it, keys by it, and every join against the
  // originator's own record silently misses. So the obligation is pre-emit by
  // construction, and this is the only vector in the corpus a producer rather than
  // a consumer must catch.
  const rejectVector = (): Vector => {
    const v = specHashVectors().find((x) => x.kind === 'reject');
    if (!v) throw new Error('the corpus no longer carries a reject vector for this family');
    return v;
  };

  it('carries a hash that is NOT what the rule mints for its payload', () => {
    const v = rejectVector();
    expect(expectMint(v), 'the carried hash is over the wrong bytes').not.toBe(
      specPayloadOf(loadVector(v)).specHash,
    );
  });

  it('carries the digest of the payload AS RENDERED — re-derived, not transcribed', () => {
    // The gate must fail if the corpus's reject vector stops being the error it
    // says it is, so the wrong hash is recomputed here rather than copied.
    const { specPayload, specHash } = specPayloadOf(loadVector(rejectVector()));
    expect(specHash, 'the vector pins a digest over the raw rendering').toBe(
      `sha256:${sha256Hex(specPayload)}`,
    );
  });

  it('is caught by comparing the mint against the carried hash — a pre-emit check', () => {
    // The check a producer runs before it sends. Expressed as a function so it is
    // the same code a caller would write, not an assertion special to this suite.
    const checkBeforeEmit = (
      documentText: string,
    ): { readonly ok: boolean; readonly detail?: string } => {
      const { specPayload, specHash, specHashAlgorithm } = specPayloadOf(documentText);
      if (specHashAlgorithm !== ALGORITHM_ID) return { ok: true }; // a different registered rule; not ours to judge
      const outcome = mint(specPayload);
      if (!outcome.ok) return { ok: false, detail: describeRefusal(outcome.refusal) };
      return outcome.value === specHash
        ? { ok: true }
        : { ok: false, detail: 'the hash is not over the canonical bytes' };
    };

    expect(
      checkBeforeEmit(loadVector(rejectVector())).ok,
      'the reject vector fails the pre-emit check',
    ).toBe(false);
    for (const v of hashVectors()) {
      expect(checkBeforeEmit(loadVector(v)).ok, `${v.id} passes the pre-emit check`).toBe(true);
    }
  });
});
