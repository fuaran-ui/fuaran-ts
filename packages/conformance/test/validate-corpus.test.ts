// ============================================================================
//  Phase 2381 — the corpus `validate` family (WIRE_FORMAT.md §27.8.2).
//
//  Each vector is a canonical tree and the pre-emit defects the reference
//  validator reports on it. This leg decodes every tree with this host's
//  decoder, validates it with `preEmitValidate`, and asserts that its findings,
//  restricted to the codes `validator-coverage.json` declares `implemented`,
//  are exactly the expected defects restricted to the same codes.
//
//  What it compares, and what it cannot: a finding here is a discriminant plus
//  typed fields. It carries the FUARAN code (`fuaranCodeOf`) and the node it is
//  raised on, but no path and no severity, so the leg compares the multiset of
//  (code, node) pairs. A repeated id is one `FUARAN-DUP-ID` per occurrence after
//  the first, each naming the id, so the count of those pairs is what pins it.
//
//  The family is read from the workspace corpus, not the bundled snapshot: the
//  snapshot's payload is the root manifest's fixture directories, and
//  `validate/` is a self-enumerated family outside it.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeNode } from '@fuaran-ui/ops';
import { fuaranCodeOf, preEmitValidate, type PreEmitDefect } from '@fuaran-ui/ui';
import { describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

interface Expected {
  readonly code: string;
  readonly severity: string;
  readonly node: string | null;
  readonly path: string;
}

interface Vector {
  readonly id: string;
  readonly tree: string;
  readonly expected: readonly Expected[];
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');

const family = JSON.parse(
  readFileSync(join(wireCorpusRoot(), 'validate', 'manifest.json'), 'utf8'),
) as { readonly vectors: readonly Vector[] };

const implemented = new Set<string>(
  (
    JSON.parse(readFileSync(join(repoRoot, 'validator-coverage.json'), 'utf8')) as {
      readonly implemented: readonly string[];
    }
  ).implemented,
);

/** The node a finding is raised on, or null where it names none. */
const nodeOf = (d: PreEmitDefect): string | null =>
  d.code === 'DUPLICATE_NODE_ID' ? d.id : 'nodeId' in d ? d.nodeId : null;

/** A finding as the comparison sees it: `code@node`, sorted so order is free. */
const pairs = (xs: readonly { code: string; node: string | null }[]): string[] =>
  xs.map((x) => `${x.code}@${x.node ?? '(none)'}`).sort();

const findingsOf = (id: string, wire: string): readonly PreEmitDefect[] => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`${id}: decode failed — ${JSON.stringify(decoded.error)}`);
  const r = preEmitValidate(decoded.value as Node<unknown>);
  return r.ok ? [] : r.error;
};

describe('wire-format corpus — validate family (§27.8.2)', () => {
  it('the family is present and non-empty', () => {
    expect(family.vectors.length).toBeGreaterThan(0);
  });

  it('exercises at least one code this host implements', () => {
    const exercised = family.vectors.flatMap((v) => v.expected.map((e) => e.code));
    expect(exercised.some((c) => implemented.has(c))).toBe(true);
  });

  it.each(family.vectors.map((v) => [v.id, v] as const))('%s', (_id, v) => {
    const got = findingsOf(v.id, v.tree)
      .map((d) => ({ code: fuaranCodeOf(d) as string, node: nodeOf(d) }))
      .filter((f) => implemented.has(f.code));
    const want = v.expected.filter((e) => implemented.has(e.code));
    expect(pairs(got)).toEqual(pairs(want));
  });
});
