// ============================================================================
//  Phase 1800 — the corpus's two negative wiring pairs, bound to the rule they
//  exist to make a host prove.
//
//  Four fixtures, two pairs, one variable each: whether the document's
//  `Filters` node declares the second chip its consumer's declared edge reads.
//
//   · `filters-param-source-{declared,undeclared}` (Phase 1784) — the arm where
//     the edge is a `Transform` param whose `from` is a chip.
//   · `filters-dependson-{declared,undeclared}` (Phase 1800) — the arm where
//     the edge is a `Query`'s `dependsOn` entry.
//
//  Every one of the four is legal wire and round-trips byte-identically, so the
//  node-round-trip family certifies the codec and says NOTHING about any of
//  this. That is the whole point of asserting them here instead: the divergence
//  is in what a host DOES with a document, and in this host that is
//  `preEmitValidate`.
//
//  Until Phase 1800 this host had no such rule, and the consequence was not a
//  missing warning — it was a silent wrong answer. An undeclared chip resolves
//  to nothing exactly as an UNSET chip does, the lenient "unset ⇒ no
//  constraint" prune drops the dependent step, and the consumer renders the
//  UNFILTERED set for a document whose author asked for a filter. This host is
//  the one new hosts port validator semantics from, so the gap propagated.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeNode } from '@fuaran-ui/ops';
import { preEmitValidate, type PreEmitDefect } from '@fuaran-ui/ui';
import { describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled snapshot — always present, so these assertions never skip. */
const nodesDir = join(here, '..', 'corpus', 'nodes');

const decodeFixture = (name: string): Node<unknown> => {
  const decoded = decodeNode(readFileSync(join(nodesDir, `${name}.json`), 'utf8'));
  // FAIL rather than skip: an assertion suite that silently drops the document
  // it is about certifies nothing.
  if (!decoded.ok) throw new Error(`${name} failed to decode: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const defectsOf = (name: string): readonly PreEmitDefect[] => {
  const r = preEmitValidate(decodeFixture(name));
  return r.ok ? [] : r.error;
};

const danglingOf = (name: string): readonly { nodeId: string; name: string }[] =>
  defectsOf(name)
    .filter((d) => d.code === 'DANGLING_FILTER_REFERENCE')
    .map((d) => ({ nodeId: d.nodeId, name: d.name }));

describe.each([
  {
    arm: 'Transform param source (Phase 1784)',
    stem: 'filters-param-source',
    reader: 'scoped-grid',
  },
  { arm: 'Query dependsOn (Phase 1800)', stem: 'filters-dependson', reader: 'scoped-metric' },
])('FUARAN075 over the corpus — $arm', ({ stem, reader }) => {
  it('the control is clean OUTRIGHT, not merely free of this one code', () => {
    // A control carrying some other defect would make the negative's single
    // finding hard to attribute.
    expect(defectsOf(`${stem}-declared`)).toEqual([]);
  });

  it('the negative names the undeclared chip, its reader, and nothing else', () => {
    expect(danglingOf(`${stem}-undeclared`)).toEqual([{ nodeId: reader, name: 'genre' }]);

    // Exactly one defect, so the fixture cannot pass by raising something else
    // that happens to contain the right case.
    expect(defectsOf(`${stem}-undeclared`)).toEqual([
      { code: 'DANGLING_FILTER_REFERENCE', nodeId: reader, name: 'genre' },
    ]);
  });

  it('the pair isolates ONE variable — the chip declaration and nothing else', () => {
    // The vacuity guard. If the two fixtures had drifted apart in some second
    // respect, the assertions above would still pass while the pair had stopped
    // measuring what it claims to. Both documents carry the same reader, and
    // the control declares strictly more chips than the negative.
    const chipNames = (name: string): readonly string[] => {
      const tree = decodeFixture(name);
      const k = tree.kind;
      if (k.kind !== 'Layout' || k.layout.kind !== 'Box') throw new Error(`${name}: not a Box`);
      const chips = k.layout.spec.children.find((c) => c.id === 'edge-chips');
      if (chips === undefined || chips.kind.kind !== 'Input' || chips.kind.input.kind !== 'Filters')
        throw new Error(`${name}: no Filters node`);
      return chips.kind.input.specs.map((s) => s.name);
    };

    expect(chipNames(`${stem}-declared`)).toEqual(['region', 'genre']);
    expect(chipNames(`${stem}-undeclared`)).toEqual(['region']);
  });
});
