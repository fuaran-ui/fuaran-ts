// ============================================================================
//  Merge-conformance (Phase 179 + 184) — Leg B (TS == corpus).
//
//  Loads the workspace `wire-format-fixtures/merge-conformance/` corpus and
//  asserts the TS host reproduces the F# host's result exactly. Two fixture
//  kinds, both keyed off the manifest entry's `kind`:
//
//   - `merge-3way` (Phase 179): the deterministic auto-merge outcome —
//     decode(base/a/b) succeeds, encodeNode(merge3Way(base, a, b)) is
//     byte-identical to the committed `expectedFile` tree, and sha256hex(those
//     bytes) === the manifest `outcomeHash`. Together with F# Leg A this proves
//     F# == TS byte-for-byte for the merged tree — including the SemanticStyle
//     sub-field blend and the NodeId-byte structural tie-break.
//
//   - `merge-validator-gated` (Phase 184): a structurally-clean merge that
//     INTRODUCES a domain-validity defect (present in the merged tree but in
//     neither parent) is a semantic conflict. The deterministic artifact is the
//     VERDICT — the introduced-defect set canonically encoded — not a merged
//     tree. This leg ports the sample domain validator + the introduced-defect
//     diff + the verdict codec from the F# `Fuaran.UI.OpStream.Dag.Merge`
//     (`ValidatorGate`) / its test corpus (`MergeCorpus.gatedValidator`), then
//     asserts encodeVerdict(introduced) is byte-identical to the committed
//     `verdictFile` and sha256hex(it) === the manifest `verdictHash`.
//
//  And one family under its OWN manifest key (`refusalFixtures`), because a host
//  that iterates `fixtures` expecting every entry to auto-merge is correct to do
//  so:
//
//   - `merge-refusal` (fuaran#1497): what a merge REFUSES is equally a cross-host
//     contract — a host that resolves a conflict resolves against the envelope's
//     contents. The deterministic artefact is the ENVELOPE: the refusal set
//     canonically encoded, byte-identical to the committed `envelopeFile` with
//     sha256hex(it) === the manifest `envelopeHash`. The swap is asserted rather
//     than committed twice — two files that were transpositions of each other
//     would pin the same fact in a form a host could satisfy by emitting both
//     from one side.
//
//  Fixture counts are never hard-coded here: the manifest is the authoritative
//  enumeration, and a corpus that grows a fixture this host cannot satisfy must
//  fail rather than go unnoticed.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Node } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import {
  decodeNode,
  encodeMergeEnvelope,
  encodeNode,
  merge3Way,
  sortConflictsCanonical,
} from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';
import { encodeVerdict, introducedDefects } from './mergeGate.js';

const corpusRoot = join(wireCorpusRoot(), 'merge-conformance');

interface Merge3WayFixture {
  readonly id: string;
  readonly kind: 'merge-3way';
  readonly baseFile: string;
  readonly aFile: string;
  readonly bFile: string;
  readonly expectedFile: string;
  readonly outcomeHash: string;
  readonly description: string;
}

interface ValidatorGatedFixture {
  readonly id: string;
  readonly kind: 'merge-validator-gated';
  readonly baseFile: string;
  readonly aFile: string;
  readonly bFile: string;
  readonly verdictFile: string;
  readonly verdictHash: string;
  readonly description: string;
}

interface RefusalFixture {
  readonly id: string;
  readonly kind: 'merge-refusal';
  readonly baseFile: string;
  readonly aFile: string;
  readonly bFile: string;
  readonly envelopeFile: string;
  readonly envelopeHash: string;
  readonly description: string;
}

/** One half of a merge-totality pair. The refusal half is shaped exactly like a
 * `RefusalFixture` and the twin half exactly like a `Merge3WayFixture`; the two
 * extra members cross-reference each other. */
type TotalityFixture =
  | (RefusalFixture & { readonly twin: string })
  | (Merge3WayFixture & { readonly refusal: string });

type MergeFixture = Merge3WayFixture | ValidatorGatedFixture;

interface Manifest {
  readonly version: number;
  readonly description: string;
  readonly fixtures: readonly MergeFixture[];
  /** Additive, and a host that predates it reads an older manifest without the
   * key — hence optional, rather than a decode failure on an old corpus. */
  readonly refusalFixtures?: readonly RefusalFixture[];
  /** merge-totality (Phase 1526): PAIRS, each a triad that must refuse followed
   * by a corrected twin that must auto-merge. Same optionality, same reason. */
  readonly totalityFixtures?: readonly TotalityFixture[];
}

const read = (rel: string): string =>
  readFileSync(join(corpusRoot, rel), 'utf8').replace(/\n$/, '');
const manifest = JSON.parse(read('manifest.json')) as Manifest;

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const decodeOrThrow = (rel: string): Node<unknown> => {
  const r = decodeNode(read(rel));
  if (!r.ok) throw new Error(`decode ${rel} failed: ${JSON.stringify(r.error)}`);
  return r.value;
};

describe('merge-conformance (TS == corpus)', () => {
  // A manifest key that was renamed, or a family this host stopped reading,
  // yields zero `it` blocks and a green run asserting nothing. Counts are read
  // from the manifest, never pinned — what is pinned is that each family is
  // non-empty.
  it('the manifest enumerates every family this host reads', () => {
    expect(manifest.fixtures.length).toBeGreaterThan(0);
    expect(manifest.refusalFixtures ?? []).not.toHaveLength(0);
    expect(manifest.totalityFixtures ?? []).not.toHaveLength(0);
  });

  for (const fx of manifest.fixtures) {
    if (fx.kind === 'merge-3way') {
      it(`${fx.id}: ${fx.description}`, () => {
        const base = decodeOrThrow(fx.baseFile);
        const a = decodeOrThrow(fx.aFile);
        const b = decodeOrThrow(fx.bFile);
        const expected = read(fx.expectedFile);

        const result = merge3Way(base, a, b);
        expect(result.ok, result.ok ? '' : `unexpected conflicts: ${JSON.stringify(result)}`).toBe(
          true,
        );
        if (!result.ok) return;

        const bytes = encodeNode(result.tree);
        // Byte-identical merged tree + matching outcome hash — the F#↔TS gate.
        expect(bytes).toBe(expected);
        expect(sha256hex(bytes)).toBe(fx.outcomeHash);
      });
    } else {
      it(`${fx.id}: ${fx.description}`, () => {
        const base = decodeOrThrow(fx.baseFile);
        const a = decodeOrThrow(fx.aFile);
        const b = decodeOrThrow(fx.bFile);
        const expected = read(fx.verdictFile);

        // The gated fixture merges cleanly STRUCTURALLY — the conflict is
        // semantic (introduced by the merge), surfaced as the verdict.
        const result = merge3Way(base, a, b);
        expect(result.ok, result.ok ? '' : `unexpected conflicts: ${JSON.stringify(result)}`).toBe(
          true,
        );
        if (!result.ok) return;

        const introduced = introducedDefects(a, b, result.tree);
        // The fixture exists to introduce a defect — guard against a silent
        // no-op (a validator that found nothing would also encode to `[]`).
        expect(introduced.length).toBeGreaterThan(0);

        const bytes = encodeVerdict(introduced);
        // Byte-identical verdict + matching verdict hash — the F#↔TS gate.
        expect(bytes).toBe(expected);
        expect(sha256hex(bytes)).toBe(fx.verdictHash);
      });
    }
  }

  // ─── merge-totality (Phase 1526) — the PAIRS ────────────────────────────
  //
  // Each pair is a triad that must REFUSE, immediately followed by a corrected
  // twin that must AUTO-MERGE, and the pair is the whole point: a host passes
  // the refusal half by refusing every structural merge, and passes an
  // auto-merge suite by never growing the arm at all. Only the pair pins the
  // boundary between them.
  //
  // Held under its own manifest key rather than folded into the two families
  // above, for the reason `refusalFixtures` is: a host iterating `fixtures` and
  // expecting every entry to auto-merge is CORRECT to do so, and one iterating
  // `refusalFixtures` expecting every entry to refuse is correct too. A pair
  // belongs to neither.
  //
  // This host read neither the key nor the fixtures until Phase 1652, so its
  // merge leg was green while asserting nothing at all about three behaviours a
  // host can silently omit and still look conformant.
  const totality = manifest.totalityFixtures ?? [];
  const totalityById = new Map(totality.map((fx) => [fx.id, fx]));

  for (const fx of totality) {
    // A kind this host does not model must FAIL rather than be skipped past —
    // the same rule the refusal family carries, and the same reason: a silently
    // ignored fixture is a green leg asserting less than it claims.
    expect(['merge-refusal', 'merge-3way']).toContain(fx.kind);

    it(`${fx.id}: ${fx.description}`, () => {
      const base = decodeOrThrow(fx.baseFile);
      const a = decodeOrThrow(fx.aFile);
      const b = decodeOrThrow(fx.bFile);
      const result = merge3Way(base, a, b);

      if (fx.kind === 'merge-refusal') {
        expect(result.ok, 'the refusal half of the pair refuses').toBe(false);
        if (result.ok) return;
        const bytes = encodeMergeEnvelope(result.conflicts);
        expect(bytes).toBe(read(fx.envelopeFile));
        expect(sha256hex(bytes)).toBe(fx.envelopeHash);
      } else {
        expect(
          result.ok,
          result.ok ? '' : `the twin must auto-merge: ${JSON.stringify(result.conflicts)}`,
        ).toBe(true);
        if (!result.ok) return;
        const bytes = encodeNode(result.tree);
        expect(bytes).toBe(read(fx.expectedFile));
        expect(sha256hex(bytes)).toBe(fx.outcomeHash);
      }
    });
  }

  // The cross-references are the structure, so an entry whose partner is missing
  // or mis-kinded leaves a half-pair that still passes — refusing everything, or
  // merging everything — which is exactly what the pairing exists to rule out.
  it('every totality entry is half of a well-formed pair', () => {
    for (const fx of totality) {
      const partnerId = fx.kind === 'merge-refusal' ? fx.twin : fx.refusal;
      const partner = totalityById.get(partnerId);
      expect(
        partner,
        `${fx.id} names a partner the manifest does not carry: ${partnerId}`,
      ).toBeDefined();
      expect(partner!.kind).not.toBe(fx.kind);
      const back = partner!.kind === 'merge-refusal' ? partner!.twin : partner!.refusal;
      expect(back, `${partnerId} does not point back at ${fx.id}`).toBe(fx.id);
    }
  });

  for (const fx of manifest.refusalFixtures ?? []) {
    // A family entry whose `kind` this host does not model must fail, not be
    // skipped past — a silently-ignored fixture is a green leg asserting less
    // than it claims.
    expect(fx.kind).toBe('merge-refusal');

    it(`${fx.id}: ${fx.description}`, () => {
      const base = decodeOrThrow(fx.baseFile);
      const a = decodeOrThrow(fx.aFile);
      const b = decodeOrThrow(fx.bFile);
      const expected = read(fx.envelopeFile);

      const result = merge3Way(base, a, b);
      // A refusal fixture that stopped refusing would otherwise encode to `[]`
      // — a green fixture asserting nothing.
      expect(result.ok, 'the fixture refuses').toBe(false);
      if (result.ok) return;

      const bytes = encodeMergeEnvelope(result.conflicts);
      // Byte-identical two-sided envelope + matching envelope hash — the F#↔TS
      // gate for what a merge REFUSES.
      expect(bytes).toBe(expected);
      expect(sha256hex(bytes)).toBe(fx.envelopeHash);

      // Swapping the branches TRANSPOSES each entry's sides and changes nothing
      // else: same cells, same classes, same base, `a` and `b` exchanged.
      const swapped = merge3Way(base, b, a);
      expect(swapped.ok, 'the swapped merge also refuses').toBe(false);
      if (swapped.ok) return;

      const forward = sortConflictsCanonical(result.conflicts);
      const reverse = sortConflictsCanonical(swapped.conflicts);
      expect(reverse).toHaveLength(forward.length);
      forward.forEach((fc, i) => {
        const rc = reverse[i]!;
        expect([rc.nodeId, rc.facet, rc.class, rc.base, rc.primacyHeld]).toEqual([
          fc.nodeId,
          fc.facet,
          fc.class,
          fc.base,
          fc.primacyHeld,
        ]);
        expect(rc.b).toEqual(fc.a);
        expect(rc.a).toEqual(fc.b);
      });
    });
  }
});
