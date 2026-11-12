// ============================================================================
//  Merge by fold — this host against the `foldFixtures` family of the
//  merge-conformance corpus (WIRE_FORMAT.md §34.6, Phase 2641).
//
//  Every fixture names a base and two branch deltas (canonical TreeOp arrays,
//  each applying from the base op by op) and one of three kinds:
//
//   - `merge-fold-derive`: the policy admits every reported pair, and the
//     derived tree is byte-equal to `expectedFile` with sha256 == `outcomeHash`.
//     Swapping the branches derives the same bytes.
//   - `merge-fold-refusal`: the policy refuses, and the §34.5 envelope is
//     byte-equal to `envelopeFile` with sha256 == `envelopeHash`. Swapping the
//     branches swaps every entry's left and right and re-sorts — the mirrored
//     envelope is computed from the committed one and asserted, not assumed.
//   - `merge-fold-gated`: the fold derives, and the sample validator gate over
//     the two heads and the derived tree refuses with the verdict byte-equal to
//     `verdictFile`, sha256 == `verdictHash`.
//
//  Counts are read from the manifest, never pinned; the family being non-empty
//  is pinned, so a renamed key cannot pass by asserting nothing. Since Phase
//  2645 it is the manifest's only family (version 2); the tree-merge legs
//  retired with the tree merge (Phase 2646).
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Node } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import {
  decodeNode,
  decodeOps,
  encodeFoldEnvelope,
  encodeNode,
  encodeOp,
  reconcileFold,
  reconcileFoldGated,
  type TreeOp,
} from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';
import { encodeVerdict, introducedDefects, type MergeDefect } from './mergeGate.js';

const corpusRoot = join(wireCorpusRoot(), 'merge-conformance');

interface FoldFixtureBase {
  readonly id: string;
  readonly baseFile: string;
  readonly aOpsFile: string;
  readonly bOpsFile: string;
  readonly description: string;
}

type FoldFixture =
  | (FoldFixtureBase & {
      readonly kind: 'merge-fold-derive';
      readonly expectedFile: string;
      readonly outcomeHash: string;
    })
  | (FoldFixtureBase & {
      readonly kind: 'merge-fold-refusal';
      readonly envelopeFile: string;
      readonly envelopeHash: string;
    })
  | (FoldFixtureBase & {
      readonly kind: 'merge-fold-gated';
      readonly verdictFile: string;
      readonly verdictHash: string;
    });

const read = (rel: string): string =>
  readFileSync(join(corpusRoot, rel), 'utf8').replace(/\n$/, '');
const manifest = JSON.parse(read('manifest.json')) as {
  readonly foldFixtures?: readonly FoldFixture[];
};
const foldFixtures = manifest.foldFixtures ?? [];

const sha256hex = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

const decodeTree = (rel: string): Node<unknown> => {
  const r = decodeNode(read(rel));
  if (!r.ok) throw new Error(`decode ${rel} failed: ${JSON.stringify(r.error)}`);
  return r.value;
};

const decodeDelta = (rel: string): TreeOp<unknown>[] => {
  const r = decodeOps(read(rel));
  if (!r.ok) throw new Error(`decode ${rel} failed: ${JSON.stringify(r.error)}`);
  return [...r.value];
};

const triad = (f: FoldFixture) => ({
  base: decodeTree(f.baseFile),
  a: decodeDelta(f.aOpsFile),
  b: decodeDelta(f.bOpsFile),
});

/** The committed envelope with every entry's left and right swapped and the
 * entries re-sorted by the §34.5 key — what the swapped reconcile must emit. */
const mirrored = (envelope: string): string => {
  interface Entry {
    readonly address: string;
    readonly class: string;
    readonly shape: string;
    readonly slot?: string;
    readonly left: unknown;
    readonly right: unknown;
  }
  const entries = (JSON.parse(envelope) as Entry[]).map((e) => ({
    ...e,
    left: e.right,
    right: e.left,
  }));
  const canon = (op: unknown): string => {
    const r = decodeOps(JSON.stringify([op]));
    if (!r.ok) throw new Error('mirror: an envelope op does not decode');
    return encodeOp(r.value[0]!);
  };
  const key = (e: Entry): string[] => [
    e.address,
    e.shape,
    e.slot ?? '',
    canon(e.left),
    canon(e.right),
  ];
  const ord = (x: string, y: string): number => (x < y ? -1 : x > y ? 1 : 0);
  const sorted = [...entries].sort((x, y) => {
    const kx = key(x);
    const ky = key(y);
    return kx.reduce((acc, v, i) => acc || ord(v, ky[i]!), 0);
  });
  // Re-emit with the committed key order and the ops in canonical form.
  return (
    '[' +
    sorted
      .map(
        (e) =>
          `{"address":${JSON.stringify(e.address)},"class":${JSON.stringify(e.class)},` +
          `"left":${canon(e.left)},"right":${canon(e.right)},"shape":${JSON.stringify(e.shape)}` +
          (e.slot === undefined ? '' : `,"slot":${JSON.stringify(e.slot)}`) +
          '}',
      )
      .join(',') +
    ']'
  );
};

describe('merge-by-fold conformance (TS == corpus foldFixtures)', () => {
  it('the manifest carries a non-empty foldFixtures family of every kind', () => {
    expect(foldFixtures.length).toBeGreaterThan(0);
    for (const kind of ['merge-fold-derive', 'merge-fold-refusal', 'merge-fold-gated'])
      expect(foldFixtures.some((f) => f.kind === kind)).toBe(true);
  });

  for (const f of foldFixtures) {
    if (f.kind === 'merge-fold-derive') {
      it(`${f.id}: derives byte-identically in both branch orders`, () => {
        const { base, a, b } = triad(f);
        const expected = read(f.expectedFile);
        expect(sha256hex(expected)).toBe(f.outcomeHash);
        for (const [x, y] of [
          [a, b],
          [b, a],
        ] as const) {
          const r = reconcileFold(base, x, y);
          if (!r.ok) throw new Error(`${f.id} refused: ${JSON.stringify(r.error)}`);
          const bytes = encodeNode(r.value.tree);
          expect(bytes).toBe(expected);
          expect(sha256hex(bytes)).toBe(f.outcomeHash);
        }
      });
    } else if (f.kind === 'merge-fold-refusal') {
      it(`${f.id}: refuses with the committed envelope, mirrored under the swap`, () => {
        const { base, a, b } = triad(f);
        const expected = read(f.envelopeFile);
        expect(sha256hex(expected)).toBe(f.envelopeHash);
        const r = reconcileFold(base, a, b);
        if (r.ok || r.error.fault !== 'Refused')
          throw new Error(`${f.id} did not refuse: ${JSON.stringify(r)}`);
        const bytes = encodeFoldEnvelope(r.error.refusals);
        expect(bytes).toBe(expected);
        expect(sha256hex(bytes)).toBe(f.envelopeHash);

        const swapped = reconcileFold(base, b, a);
        if (swapped.ok || swapped.error.fault !== 'Refused')
          throw new Error(`${f.id} swapped did not refuse: ${JSON.stringify(swapped)}`);
        const swappedBytes = encodeFoldEnvelope(swapped.error.refusals);
        expect(swappedBytes).toBe(mirrored(expected));
      });
    } else {
      it(`${f.id}: derives, and the validator gate refuses with the committed verdict`, () => {
        const { base, a, b } = triad(f);
        const expected = read(f.verdictFile);
        expect(sha256hex(expected)).toBe(f.verdictHash);
        // The fold alone derives — the refusal is the gate's, not the policy's.
        expect(reconcileFold(base, a, b).ok).toBe(true);
        const r = reconcileFoldGated<unknown, MergeDefect>(introducedDefects, base, a, b);
        if (r.ok || r.error.fault !== 'IntroducedDefects')
          throw new Error(`${f.id} was not gated: ${JSON.stringify(r)}`);
        const bytes = encodeVerdict(r.error.defects);
        expect(bytes).toBe(expected);
        expect(sha256hex(bytes)).toBe(f.verdictHash);
      });
    }
  }
});

describe('merge by fold — the policy beyond the corpus', () => {
  const pane = (id: string) => ({ id, kind: { $type: 'Markdown', text: id } });
  const base = decodeNode(
    JSON.stringify({
      id: 'root',
      kind: { $type: 'Box', children: [pane('p')], layout: { $type: 'Auto' }, role: 'Dashboard' },
    }),
  );
  if (!base.ok) throw new Error(`base: ${JSON.stringify(base.error)}`);
  const ops = (json: unknown[]): TreeOp<unknown>[] => {
    const r = decodeOps(JSON.stringify(json));
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    return [...r.value];
  };

  it('a delta that does not apply from the base is refused first, naming side and index', () => {
    const good = ops([{ $type: 'RemoveNode', target: 'p' }]);
    const bad = ops([
      { $type: 'RemoveNode', target: 'p' },
      { $type: 'RemoveNode', target: 'nope' },
    ]);
    const r = reconcileFold(base.value, good, bad);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.fault).toBe('DeltaDoesNotApply');
      if (r.error.fault === 'DeltaDoesNotApply') {
        expect(r.error.side).toBe('B');
        expect(r.error.index).toBe(1);
      }
    }
  });

  it('two empty deltas derive the base with no script', () => {
    const r = reconcileFold(base.value, [], []);
    expect(r.ok && encodeNode(r.value.tree) === encodeNode(base.value)).toBe(true);
    expect(r.ok && r.value.script.length).toBe(0);
  });

  it('an interleave records the child-order rule as a ReorderChildren script', () => {
    const a = ops([{ $type: 'InsertChild', child: pane('z'), parentId: 'root' }]);
    const b = ops([{ $type: 'InsertChild', child: pane('a'), parentId: 'root' }]);
    const r = reconcileFold(base.value, a, b);
    if (!r.ok) throw new Error(JSON.stringify(r.error));
    expect(r.value.interleaves).toBe(1);
    expect(r.value.script.map((o) => encodeOp(o))).toEqual([
      '{"$type":"ReorderChildren","newOrder":["p","a","z"],"parentId":"root"}',
    ]);
    // Swapped, the fold's order is already the rule's, and the script is
    // recorded anyway (Phase 2645: the script fixes the order a replay reaches).
    const swapped = reconcileFold(base.value, b, a);
    if (!swapped.ok) throw new Error(JSON.stringify(swapped.error));
    expect(swapped.value.script.map((o) => encodeOp(o))).toEqual(
      r.value.script.map((o) => encodeOp(o)),
    );
  });

  it('a reorder beside an append to its parent is rebased, and two differing reorders refuse', () => {
    const two = decodeNode(
      JSON.stringify({
        id: 'root',
        kind: {
          $type: 'Box',
          children: [pane('a'), pane('b')],
          layout: { $type: 'Auto' },
          role: 'Dashboard',
        },
      }),
    );
    if (!two.ok) throw new Error(JSON.stringify(two.error));
    const reorder = ops([{ $type: 'ReorderChildren', newOrder: ['b', 'a'], parentId: 'root' }]);
    const append = ops([{ $type: 'InsertChild', child: pane('c'), parentId: 'root' }]);
    const want = decodeNode(
      JSON.stringify({
        id: 'root',
        kind: {
          $type: 'Box',
          children: [pane('b'), pane('a'), pane('c')],
          layout: { $type: 'Auto' },
          role: 'Dashboard',
        },
      }),
    );
    if (!want.ok) throw new Error(JSON.stringify(want.error));
    for (const [d1, d2] of [
      [reorder, append],
      [append, reorder],
    ] as const) {
      const r = reconcileFold(two.value, d1, d2);
      if (!r.ok) throw new Error(JSON.stringify(r.error));
      expect(encodeNode(r.value.tree)).toBe(encodeNode(want.value));
      expect(r.value.interleaves).toBe(1);
    }
    const other = ops([{ $type: 'ReorderChildren', newOrder: ['a', 'b'], parentId: 'root' }]);
    const refused = reconcileFold(two.value, reorder, other);
    expect(!refused.ok && refused.error.fault).toBe('Refused');
  });

  it('the merge corpus is the fold family alone (manifest version 2)', () => {
    const m = JSON.parse(
      readFileSync(join(wireCorpusRoot(), 'merge-conformance', 'manifest.json'), 'utf8'),
    ) as Record<string, unknown>;
    expect(m['version']).toBe(2);
    for (const retired of ['fixtures', 'refusalFixtures', 'totalityFixtures'])
      expect(m).not.toHaveProperty(retired);
  });
});
