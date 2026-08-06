// ============================================================================
//  The cross-host agreement gate.
//
//  `canonical-json-sha256-v1` is a REGISTERED identifier. Two implementations
//  that declare it and mint differently have not disagreed about anything a
//  reader can see: nothing downstream of a minted address is permitted to check
//  it, so the divergence surfaces as a join that silently misses, months later,
//  with nothing in either record saying why.
//
//  The corpus's own vectors pin a handful of shapes and are run by
//  `corpus.test.ts`. They cannot say that two IMPLEMENTATIONS agree on a document
//  nobody wrote — which is the case that matters, because the rule's whole job is
//  to be applied to documents no repository has seen. So this suite runs against
//  `vectors/cross-host-vectors.json`: several hundred generated documents, plus
//  hand-picked edge renderings and the refusal cases, each carrying the canonical
//  bytes and digest produced by an INDEPENDENT implementation of the same rule in
//  another language.
//
//  The file is generated, never hand-edited. Regenerating it is a deliberate act
//  whose result is reviewed as a diff — see `scripts/README.md` beside it. A
//  vector whose expectation was edited to match this implementation would make
//  the gate agree with itself, which is the one thing it must never do.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { ALGORITHM_ID, canonicalise, describeRefusal, mint } from '../src/index.js';
import { crossHostVectors, type CrossHostRefusal, type CrossHostVector } from './vectors.js';

const file = crossHostVectors();

describe('the cross-host vector file', () => {
  it('is the rule this implementation claims to implement', () => {
    expect(file.algorithm).toBe(ALGORITHM_ID);
  });

  it('carries the count it says it carries', () => {
    // Asked of the harness, not of the implementation: a suite that iterated an
    // empty array would satisfy every assertion below by never reaching one.
    expect(file.vectors.length).toBe(file.vectorCount);
    expect(file.refusals.length).toBe(file.refusalCount);
    expect(file.vectorCount).toBeGreaterThan(200);
    expect(file.refusalCount).toBeGreaterThan(0);
  });

  it('carries both populations — hand-picked edges and generated documents', () => {
    // The generated majority is what makes agreement a property of the rule rather
    // than a coincidence of a few fixtures; the edges are what make a failure name
    // its case. Losing either silently would weaken the gate without failing it.
    expect(file.vectors.filter((v) => v.id.startsWith('edge/')).length).toBeGreaterThan(0);
    expect(file.vectors.filter((v) => v.id.startsWith('generated/')).length).toBe(
      file.generatedCount,
    );
  });
});

describe('the canonical bytes agree, document by document', () => {
  it('reproduces every vector byte for byte', () => {
    const divergences: string[] = [];
    for (const v of file.vectors) {
      const outcome = canonicalise(v.rendered);
      if (!outcome.ok) {
        divergences.push(`${v.id}: refused — ${describeRefusal(outcome.refusal)}`);
      } else if (outcome.value !== v.canonical) {
        divergences.push(`${v.id}:\n  expected ${v.canonical}\n  actual   ${outcome.value}`);
      }
    }
    expect(divergences.slice(0, 10).join('\n'), `${String(divergences.length)} divergence(s)`).toBe(
      '',
    );
  });

  it('reproduces every digest', () => {
    const divergences: string[] = [];
    for (const v of file.vectors) {
      const outcome = mint(v.rendered);
      if (!outcome.ok) divergences.push(`${v.id}: refused — ${describeRefusal(outcome.refusal)}`);
      else if (outcome.value !== v.digest)
        divergences.push(`${v.id}: ${outcome.value} != ${v.digest}`);
    }
    expect(divergences.slice(0, 10).join('\n'), `${String(divergences.length)} divergence(s)`).toBe(
      '',
    );
  });

  it('mints one identity for a document authored the other way round', () => {
    // Every generated vector carries a second rendering of the SAME document, with
    // its members reversed at every level and laid out with whitespace. Member order
    // and whitespace must not change a hash; this is that property, checked across
    // hosts rather than only within one.
    const permuted = file.vectors.filter((v): v is CrossHostVector & { renderedPermuted: string } =>
      Boolean(v.renderedPermuted),
    );
    expect(permuted.length, 'the file carries permuted renderings').toBeGreaterThan(200);

    const divergences: string[] = [];
    for (const v of permuted) {
      const outcome = mint(v.renderedPermuted);
      if (!outcome.ok) divergences.push(`${v.id}: refused — ${describeRefusal(outcome.refusal)}`);
      else if (outcome.value !== v.digest)
        divergences.push(`${v.id} (permuted): ${outcome.value} != ${v.digest}`);
    }
    expect(divergences.slice(0, 10).join('\n'), `${String(divergences.length)} divergence(s)`).toBe(
      '',
    );
  });
});

describe('the domain agrees too', () => {
  it('refuses every rendering the other implementation refuses, with the same name', () => {
    // Two implementations that mint alike but refuse differently have not agreed
    // about the algorithm's DOMAIN — and the domain is exactly where an
    // implementation quietly starts resolving what the rule says to refuse.
    const divergences: string[] = [];
    for (const r of file.refusals as readonly CrossHostRefusal[]) {
      const outcome = mint(r.rendered);
      if (outcome.ok) divergences.push(`${r.id}: accepted, expected refusal '${r.refusal}'`);
      else if (outcome.refusal.kind !== r.refusal)
        divergences.push(`${r.id}: refused as '${outcome.refusal.kind}', expected '${r.refusal}'`);
    }
    expect(divergences.join('\n'), `${String(divergences.length)} divergence(s)`).toBe('');
  });

  it('names an array reordering as a different document, not a different rendering', () => {
    // Stated directly rather than left to the generated population: a rule that
    // sorted everything would satisfy every ordering assertion above.
    const ordered = file.vectors.find((v) => v.id === 'edge/array-order-is-data');
    const reordered = file.vectors.find((v) => v.id === 'edge/array-order-reversed');
    expect(ordered && reordered, 'the file still carries the array-order pair').toBeTruthy();
    expect((ordered as CrossHostVector).digest).not.toBe((reordered as CrossHostVector).digest);
  });
});
