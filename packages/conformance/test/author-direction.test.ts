// ============================================================================
//  The author-direction leg (Phase 1695).
//
//  Every node fixture is decoded, REBUILT through the `@fuaran-ui/ui` authoring
//  surface (see `reauthor.ts` for what that means and where its boundary is),
//  re-encoded, and required to be byte-identical to the fixture.
//
//  Why this exists as its own leg. `self-certification.test.ts` runs the corpus
//  through decode -> encode, which verifies the decoder and encoder against each
//  other; it cannot see a change to an AUTHOR-FACING in-memory type, because the
//  decoder produces the new form and the encoder consumes it. Phase 1661 widened
//  `TextSource.I18n.args` to `Record<string, Binding<JsonValue>>`, 4,795 tests
//  stayed green, and a consumer that constructs a tree rather than decoding one
//  broke two days later on the pin bump — with the failure surfacing as a throw
//  from inside the encoder rather than as a break in what an author must build.
//
//  The reproduced shapes are covered below as REFUSALS, because that is the
//  half a byte comparison structurally cannot state: handed a raw wire object
//  where a `Binding` belongs — and handed a bare literal, the arm whose bare
//  re-encode is what let the pre-widening reading round-trip by accident — the
//  encoder must refuse rather than emit.
// ============================================================================

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import type { Binding, JsonValue, Node, TextSource } from '@fuaran-ui/ui';
import { describe, expect, it } from 'vitest';

import { loadCorpus, type Corpus } from '../src/corpus.js';
import { reauthorNode, type ReauthorTally } from './reauthor.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/conformance/test → workspace-root/wire-format-fixtures
const workspaceCorpus = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

/** Decode, re-author, re-encode. Throws with the fixture named on any leg. */
const roundTripThroughAuthorSurface = (
  corpus: Corpus,
  id: string,
  wire: string,
  tally: ReauthorTally,
): string => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`${id}: decode failed — ${JSON.stringify(decoded.error)}`);
  void corpus;
  return encodeNode(reauthorNode(decoded.value as Node<unknown>, tally));
};

const nodeFixturesOf = (corpus: Corpus) =>
  corpus.fixtures.filter((f) => f.kind === 'node-round-trip');

// ─── The leg, over both corpora the kit knows about ─────────────────────────

const describeCorpus = (label: string, load: () => Corpus): void => {
  describe(`author-direction — ${label}`, () => {
    const corpus = load();
    const fixtures = nodeFixturesOf(corpus);
    const tally: ReauthorTally = new Map();

    it('the corpus is present and non-trivial', () => {
      expect(fixtures.length).toBeGreaterThanOrEqual(70);
    });

    it('every node fixture rebuilds through the authoring surface byte-identically', () => {
      const failures: string[] = [];
      for (const f of fixtures) {
        const wire = corpus.read(f.inputFile).trim();
        let back: string;
        try {
          back = roundTripThroughAuthorSurface(corpus, f.id, wire, tally);
        } catch (e) {
          failures.push(`${f.id}: threw — ${(e as Error).message}`);
          continue;
        }
        if (back !== wire) failures.push(`${f.id}: re-encoded bytes differ from the fixture`);
      }
      expect(
        failures,
        'a tree rebuilt through the @fuaran-ui/ui surface must encode to the canonical bytes',
      ).toEqual([]);
    });

    it('the walk actually rebuilt something in the corpus (non-vacuity)', () => {
      // The identity is a perfect byte round trip, so a walk that matched
      // nothing would pass the test above without exercising one constructor.
      const total = [...tally.values()].reduce((a, b) => a + b, 0);
      expect(total).toBeGreaterThan(100);
    });
  });
};

describeCorpus('bundled corpus snapshot', () => loadCorpus());

if (existsSync(join(workspaceCorpus, 'manifest.json'))) {
  describeCorpus('authoritative workspace corpus', () =>
    loadCorpus({ corpusRoot: workspaceCorpus }),
  );
}

// ─── What the corpus reaches, pinned ────────────────────────────────────────

describe('author-direction — union-case coverage', () => {
  const corpus = loadCorpus();
  const tally: ReauthorTally = new Map();
  for (const f of nodeFixturesOf(corpus)) {
    try {
      roundTripThroughAuthorSurface(corpus, f.id, corpus.read(f.inputFile).trim(), tally);
    } catch {
      /* the leg above is what reports a failure; this one measures reach */
    }
  }

  // Pinned EXACTLY, in both directions, because both movements are worth a
  // human looking. A case that leaves this list is a case the corpus stopped
  // exercising — the author direction quietly stopped being covered there. A
  // case that joins it is either a new fixture reaching a slot nothing reached
  // before (move the line out of UNREACHED below) or a NEW union case, which is
  // the one this file exists to make impossible to miss: `reauthor.ts`'s
  // exhaustive switches already refuse to compile without it.
  const EXERCISED: readonly string[] = [
    'Action.AiTool',
    'Action.Call',
    'Action.Chain',
    'Action.Confirm',
    'Action.Dispatch',
    'Action.Focus',
    'Action.Navigate',
    'Action.Notify',
    'Action.Print',
    'Action.ReadFileBody',
    'Action.SetState',
    'Action.WriteToClipboard',
    'Binding.Expr',
    'Binding.Filter',
    'Binding.Format',
    'Binding.Invoke',
    'Binding.Local',
    'Binding.Now',
    'Binding.Query',
    'Binding.Selection',
    'Binding.State',
    'Binding.Static',
    'Binding.Transform',
    'TextSource.Bound',
    'TextSource.I18n',
    'TextSource.Literal',
  ];

  // The rest of the three unions, each with the reason the canonical node
  // corpus does not reach it through this leg. Stated rather than left as the
  // complement, because "not in the list above" reads identically whether the
  // case is unreachable by construction or merely unfixtured, and those are
  // different findings.
  const UNREACHED: Readonly<Record<string, string>> = {
    // A closure. No wire document can carry one, so no fixture can produce one.
    'Binding.Computed': 'carries a compute closure the wire cannot express',
    // Every `I18n` in the corpus carries an argument bag, which is the shape
    // `TextSource.I18n` declares — so the two cases are indistinguishable at
    // that point and this leg tallies them as the text one. They rebuild
    // identically (§5: the two slots carry the same argument type and differ
    // only in the slot's presence), so nothing is lost but the label.
    'Binding.I18n': 'indistinguishable from TextSource.I18n once args are present',
    // Same members as `Binding.Invoke`, and tallied as that one.
    'Action.Invoke': 'indistinguishable from Binding.Invoke',
    'Action.CommitLocal': 'no node fixture carries a local-buffer commit',
  };

  it('the corpus exercises exactly the union cases this leg is pinned to', () => {
    expect([...tally.keys()].sort()).toEqual([...EXERCISED].sort());
  });

  it('every pinned case is accounted for exactly once, reached or not', () => {
    const overlap = Object.keys(UNREACHED).filter((k) => EXERCISED.includes(k));
    expect(overlap, 'a case cannot be both reached and unreached').toEqual([]);
    expect(
      Object.values(UNREACHED).filter((r) => r.trim() === ''),
      'an unreached case must say why',
    ).toEqual([]);
  });
});

// ─── The Phase 1661 shapes, as refusals ─────────────────────────────────────

/**
 * A real corpus tree carrying a `TextSource.I18n`, with its argument bag
 * REPLACED. Derived from the corpus rather than hand-built, so a refusal below
 * is a statement about the argument slot and not about some other member of a
 * tree assembled by hand.
 */
const corpusTreeWithI18nArgs = (args: unknown): Node<unknown> => {
  const corpus = loadCorpus();
  for (const f of nodeFixturesOf(corpus)) {
    const wire = corpus.read(f.inputFile).trim();
    if (!/"\$type"\s*:\s*"I18n"/.test(wire)) continue;
    const decoded = decodeNode(wire);
    if (!decoded.ok) continue;
    let replaced = false;
    const swap = (v: unknown): unknown => {
      if (Array.isArray(v)) return v.map(swap);
      if (v === null || typeof v !== 'object' || v instanceof Date) return v;
      const o = v as Record<string, unknown>;
      if (o['kind'] === 'I18n' && 'args' in o) {
        replaced = true;
        return { ...o, args };
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, swap(x)]));
    };
    const tree = swap(decoded.value) as Node<unknown>;
    if (replaced) return tree;
  }
  throw new Error('no node fixture carries an I18n text source — this cover is vacuous');
};

describe('author-direction — the Phase 1661 shapes are refused (not emitted)', () => {
  it('a raw wire object where a Binding belongs is refused', () => {
    // `{"$type":"State", …}` is the WIRE spelling. In memory an argument is a
    // `Binding`, discriminated by `kind`; handing the encoder the wire form is
    // the reading that broke on the widening.
    expect(() =>
      encodeNode(corpusTreeWithI18nArgs({ count: { $type: 'State', key: 'cartCount' } })),
    ).toThrow(/unreachable case/);
  });

  it('a bare literal where a Binding belongs is refused', () => {
    // The arm that hid the defect: a `Static` argument carrying a value encodes
    // BARE (WIRE_FORMAT.md §5), so for as long as the encoder spelled this slot
    // as a plain JSON map, a bare `1908` round-tripped byte-identically while
    // never having been a `Binding` at all.
    expect(() => encodeNode(corpusTreeWithI18nArgs({ year: 1908 }))).toThrow(/unreachable case/);
  });

  it('the same tree with the arguments spelled as bindings encodes', () => {
    // The positive control: without it the two refusals above would pass on a
    // tree that was malformed for some unrelated reason.
    const args: Record<string, Binding<JsonValue>> = {
      count: { kind: 'State', key: 'cartCount', defaultValue: null },
      year: { kind: 'Static', value: 1908 },
    };
    const encoded = encodeNode(corpusTreeWithI18nArgs(args));
    expect(encoded).toContain('"$type":"I18n"');
    // The literal argument rides the wire BARE, which is the property that made
    // the widening byte-invisible.
    expect(encoded).toContain('"year":1908');
  });
});
