// ============================================================================
//  Phase 1021 — the `NodeKind.Custom` content-hash FLOOR, ported from the
//  reference host's Phase 783 hardening so the two conformant hosts agree on the
//  posture. Cross-host posture divergence is itself an exploit class: a tree
//  vetted on one host is not thereby safe on another.
//
//  `ContentHash` is drift detection between a registered renderer and a replayed
//  tree — never authentication, because the TREE supplies its own hash record.
//  Two bypasses followed from reading it as more than that, and this file pins
//  both closed:
//
//    1. OMIT THE HASH. An absent tree hash shared a render branch with `Match`
//       and rendered silently — the cheapest route past verification was to skip
//       it.
//    2. DECLARE A LENIENT STRICTNESS. Strictness was read from the tree's own
//       record, so a hostile tree chose `AdvisoryWarning` and got
//       warn-then-render on a mismatch.
//
//  The first block is a TRANSLATION of the reference host's own unit tests (its
//  `classifyUnder` cases), so the two implementations are held to one oracle
//  rather than to each other's observed behaviour. The second block pins the
//  same rule through an actual render, which is where a floor that is computed
//  but never consulted would still look green.
//
//  Phase 1856 ports the reference host's Phase 1550 flip: the shipped default is
//  `Enforced`, the permissive posture is a declaration made BY NAME, and the
//  floor governs MISMATCH rather than tree-side ABSENCE (only `StrictReplay`
//  refuses a tree declaring no hash). The third block is the cross-host
//  comparison over the same documents, with the reference host's column taken
//  from EXECUTING its classifier rather than from reading it.
// ============================================================================

import type { ContentHash, HashStrictness, Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { refusesUnverifiableHashStrictness } from '../src/customHash.js';
import type { CustomHashOutcome } from '../src/index.js';
import {
  classifyCustomHashUnder,
  createCustomRendererRegistry,
  customHashFloorOf,
  defaultCustomHashFloor,
  FuaranRenderer,
  isEnforcingHashStrictness,
  registerCustomRenderer,
} from '../src/index.js';

const hash = (h: string, strictness: HashStrictness): ContentHash => ({
  algorithm: 'sha256',
  hash: h,
  strictness,
});

// ─── The translated oracle (reference host: `CustomHash.classifyUnder`) ──────

describe('Custom content-hash floor — the classifier (Phase 783 parity oracle)', () => {
  it('omitting the hash is a REFUSAL under a StrictReplay floor', () => {
    expect(classifyCustomHashUnder('StrictReplay', undefined, hash('abc', 'StrictReplay'))).toBe(
      'Unverifiable',
    );
    expect(classifyCustomHashUnder('AdvisoryWarning', undefined, hash('abc', 'StrictReplay'))).toBe(
      'NoTreeHash',
    );
  });

  it('an Enforced floor refuses a MISMATCH and renders a tree that declared no hash', () => {
    // Phase 1856 (the reference host's Phase 1550): what makes the enforcing
    // default shippable. Before this phase `Enforced` refused the absence here
    // and rendered it on the reference host — the same document, two verdicts.
    expect(
      classifyCustomHashUnder(
        'Enforced',
        hash('aaa', 'AdvisoryWarning'),
        hash('bbb', 'AdvisoryWarning'),
      ),
    ).toBe('MismatchStrict');
    expect(classifyCustomHashUnder('Enforced', undefined, hash('abc', 'StrictReplay'))).toBe(
      'NoTreeHash',
    );
  });

  it('a registry with no recorded hash is equally unverifiable', () => {
    expect(classifyCustomHashUnder('Enforced', hash('abc', 'StrictReplay'), undefined)).toBe(
      'Unverifiable',
    );
    expect(classifyCustomHashUnder('AdvisoryWarning', hash('abc', 'StrictReplay'), undefined)).toBe(
      'RegistryNoHash',
    );
  });

  it('a tree-supplied strictness may only TIGHTEN, never loosen', () => {
    const treeAdvisory = hash('aaa', 'AdvisoryWarning');
    const registered = hash('bbb', 'StrictReplay');

    // The HOST floor wins over the tree's lenient declaration — bypass 2.
    expect(classifyCustomHashUnder('StrictReplay', treeAdvisory, registered)).toBe(
      'MismatchStrict',
    );
    // …and an advisory host keeps the advisory outcome.
    expect(classifyCustomHashUnder('AdvisoryWarning', treeAdvisory, registered)).toBe(
      'MismatchAdvisory',
    );
    // Tightening still works from the tree side.
    expect(
      classifyCustomHashUnder('AdvisoryWarning', hash('aaa', 'StrictReplay'), registered),
    ).toBe('MismatchStrict');
  });

  it('a genuine match renders under every floor', () => {
    // The guard must not be so eager that legitimate verified content is
    // refused — otherwise nobody turns it on.
    for (const floor of ['AdvisoryWarning', 'StrictReplay', 'Enforced'] as const) {
      expect(
        classifyCustomHashUnder(
          floor,
          hash('same', 'AdvisoryWarning'),
          hash('same', 'StrictReplay'),
        ),
      ).toBe('Match');
    }
  });

  it('refusesUnverifiable separates the two enforcing floors', () => {
    // Both enforcing floors refuse a MISMATCH…
    expect(isEnforcingHashStrictness('AdvisoryWarning')).toBe(false);
    expect(isEnforcingHashStrictness('StrictReplay')).toBe(true);
    expect(isEnforcingHashStrictness('Enforced')).toBe(true);
    // …and only the one whose name says the tree must replay exactly refuses an
    // ABSENCE. Pinned directly so the distinction cannot be quietly collapsed.
    expect(refusesUnverifiableHashStrictness('StrictReplay')).toBe(true);
    expect(refusesUnverifiableHashStrictness('Enforced')).toBe(false);
    expect(refusesUnverifiableHashStrictness('AdvisoryWarning')).toBe(false);
  });

  it('the shipped default is Enforced, and AdvisoryWarning is reachable BY NAME', () => {
    expect(defaultCustomHashFloor).toBe('Enforced');
    // An absent declaration resolves to the default…
    expect(customHashFloorOf({})).toBe('Enforced');
    // …and a present one REPLACES it, so the permissive posture is declarable
    // rather than unreachable (the reference host's decision 1 at Phase 1550).
    expect(customHashFloorOf({ customHashFloor: 'AdvisoryWarning' })).toBe('AdvisoryWarning');
    expect(customHashFloorOf({ customHashFloor: 'StrictReplay' })).toBe('StrictReplay');
  });
});

// ─── The same rule, through a render ─────────────────────────────────────────

const customNode = (contentHash?: ContentHash): Node<string> => ({
  id: nodeId('custom-1'),
  kind: {
    kind: 'Custom',
    moduleId: 'charts',
    componentId: 'sparkline',
    props: { points: '0,1' },
    ...(contentHash !== undefined ? { contentHash } : {}),
    exposedNodeIds: [],
  },
  state: {},
  style: defaults.style,
});

/** A registry whose renderer RECORDS its invocation — so "not reached" is an
 *  assertion about the renderer, not about the markup happening to differ. */
const registryRecording = (invoked: string[], contentHash?: ContentHash) => {
  const registry = createCustomRendererRegistry();
  registerCustomRenderer(
    registry,
    'charts',
    'sparkline',
    () => {
      invoked.push('sparkline');
      return <span className="the-registered-renderer" />;
    },
    contentHash,
  );
  return registry;
};

describe('Custom content-hash floor — through the renderer (Phase 1021)', () => {
  it('a self-declared-strict tree cannot WEAKEN an enforcing floor', () => {
    // The tree declares `AdvisoryWarning` on a mismatching hash — the pre-1021
    // read would have given it warn-then-render. The host is enforcing, so the
    // registered renderer must not run.
    const invoked: string[] = [];
    const warn = vi.fn();
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('aaa', 'AdvisoryWarning'))}
        runtime={{ registry: registryRecording(invoked, hash('bbb', 'StrictReplay')), warn }}
        customHashFloor="StrictReplay"
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).not.toContain('the-registered-renderer');
    expect(html).toContain('fuaran-custom-placeholder');
    expect(warn).toHaveBeenCalled();
  });

  it('THE GO-RED CASE (Phase 1856): an UNDECLARED host refuses a mismatched Custom', () => {
    // The flip itself. No `customHashFloor` at all — the host that never
    // configured one — and the registered renderer must not run.
    const invoked: string[] = [];
    const warn = vi.fn();
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('aaa', 'AdvisoryWarning'))}
        runtime={{ registry: registryRecording(invoked, hash('bbb', 'StrictReplay')), warn }}
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).not.toContain('the-registered-renderer');
    expect(html).toContain('fuaran-custom-placeholder');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FuaranCustomHashMismatch'));
  });

  it('the NAMED opt-back: the same page with AdvisoryWarning warns and renders', () => {
    // This is the pair's other half — the two renders differ ONLY in the
    // declared floor, so "the renderer did not run" above is about the floor
    // and nothing else. The warning is intact: the opt-back relaxes the verdict,
    // never the report.
    const invoked: string[] = [];
    const warn = vi.fn();
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('aaa', 'AdvisoryWarning'))}
        runtime={{ registry: registryRecording(invoked, hash('bbb', 'StrictReplay')), warn }}
        customHashFloor="AdvisoryWarning"
      />,
    );

    expect(invoked).toEqual(['sparkline']);
    expect(html).toContain('the-registered-renderer');
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('FuaranCustomHashMismatch'));
  });

  it('an undeclared host refuses a declared hash the registry recorded none for', () => {
    // Registry-side absence: the tree made a claim nothing can check.
    const invoked: string[] = [];
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('aaa', 'AdvisoryWarning'))}
        runtime={{ registry: registryRecording(invoked), warn: vi.fn() }}
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).toContain('fuaran-custom-placeholder');
  });

  it('omitting the hash entirely is refused under a StrictReplay floor', () => {
    const invoked: string[] = [];
    const warn = vi.fn();
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(undefined)}
        runtime={{ registry: registryRecording(invoked, hash('bbb', 'StrictReplay')), warn }}
        customHashFloor="StrictReplay"
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).toContain('fuaran-custom-placeholder');
    expect(warn).toHaveBeenCalled();
  });

  it('omitting the hash still renders under Enforced — the floor governs mismatch, not absence', () => {
    const invoked: string[] = [];
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(undefined)}
        runtime={{
          registry: registryRecording(invoked, hash('bbb', 'StrictReplay')),
          warn: vi.fn(),
        }}
        customHashFloor="Enforced"
      />,
    );

    expect(invoked).toEqual(['sparkline']);
    expect(html).toContain('the-registered-renderer');
  });

  it('under the default, an unhashed tree still renders — as on the reference host', () => {
    // The upgrade claim of the flip, asserted rather than assumed.
    const invoked: string[] = [];
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(undefined)}
        runtime={{ registry: registryRecording(invoked), warn: vi.fn() }}
      />,
    );

    expect(invoked).toEqual(['sparkline']);
    expect(html).toContain('the-registered-renderer');
  });

  it('a verified hash renders even under the strictest floor', () => {
    const invoked: string[] = [];
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('same', 'AdvisoryWarning'))}
        runtime={{
          registry: registryRecording(invoked, hash('same', 'StrictReplay')),
          warn: vi.fn(),
        }}
        customHashFloor="Enforced"
      />,
    );

    expect(invoked).toEqual(['sparkline']);
    expect(html).toContain('the-registered-renderer');
  });

  it('a refusal routes through `onError` when the tree supplies one', () => {
    const invoked: string[] = [];
    const tree: Node<string> = {
      ...customNode(undefined),
      state: {
        onError: (payload) => ({
          id: nodeId('err-1'),
          kind: {
            kind: 'Display',
            display: {
              kind: 'Callout',
              spec: {
                tone: 'Default',
                body: { kind: 'Literal', value: payload.message },
                dismissable: false,
              },
            },
          },
          state: {},
          style: defaults.style,
        }),
      },
    };

    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={tree}
        runtime={{
          registry: registryRecording(invoked, hash('bbb', 'StrictReplay')),
          warn: vi.fn(),
        }}
        customHashFloor="StrictReplay"
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).toContain('refused');
    expect(html).toContain('could not be verified');
  });
});

// ─── The cross-host comparison (Phase 1856) ──────────────────────────────────
//
//  The same documents, under the same host declarations, on both hosts. The
//  corpus carries no `Custom` content-hash vectors, so the oracle is the
//  reference host's classifier EXECUTED over these documents (its
//  `CustomHash.classifyForRender None`, with the declaration made through
//  `installCustomHashFloor` — that host's analogue of this renderer's
//  `customHashFloor`, and "none" meaning no install at all). The expected column
//  below is its output, pasted; the phase's outcome carries the same table.

type Declaration = HashStrictness | 'none';

const crossHostDocuments: ReadonlyArray<
  readonly [string, ContentHash | undefined, ContentHash | undefined]
> = [
  ['match', hash('same', 'AdvisoryWarning'), hash('same', 'StrictReplay')],
  ['mismatch', hash('aaa', 'AdvisoryWarning'), hash('bbb', 'StrictReplay')],
  ['mismatch-tree-strict', hash('aaa', 'StrictReplay'), hash('bbb', 'AdvisoryWarning')],
  ['no-tree-hash', undefined, hash('bbb', 'StrictReplay')],
  ['no-registry-hash', hash('aaa', 'AdvisoryWarning'), undefined],
];

const referenceHostOutcomes: Readonly<
  Record<string, Readonly<Record<Declaration, CustomHashOutcome>>>
> = {
  match: { none: 'Match', AdvisoryWarning: 'Match', StrictReplay: 'Match', Enforced: 'Match' },
  mismatch: {
    none: 'MismatchStrict',
    AdvisoryWarning: 'MismatchAdvisory',
    StrictReplay: 'MismatchStrict',
    Enforced: 'MismatchStrict',
  },
  'mismatch-tree-strict': {
    none: 'MismatchStrict',
    AdvisoryWarning: 'MismatchStrict',
    StrictReplay: 'MismatchStrict',
    Enforced: 'MismatchStrict',
  },
  'no-tree-hash': {
    none: 'NoTreeHash',
    AdvisoryWarning: 'NoTreeHash',
    StrictReplay: 'Unverifiable',
    Enforced: 'NoTreeHash',
  },
  'no-registry-hash': {
    none: 'Unverifiable',
    AdvisoryWarning: 'RegistryNoHash',
    StrictReplay: 'Unverifiable',
    Enforced: 'Unverifiable',
  },
};

const declarations: readonly Declaration[] = [
  'none',
  'AdvisoryWarning',
  'StrictReplay',
  'Enforced',
];

const renders = (outcome: CustomHashOutcome): boolean =>
  outcome !== 'MismatchStrict' && outcome !== 'Unverifiable';

describe('Custom content-hash floor — the same documents decide the same way on both hosts', () => {
  for (const [doc, treeHash, registryHash] of crossHostDocuments) {
    for (const declared of declarations) {
      const expected = referenceHostOutcomes[doc]![declared];
      it(`${doc} under ${declared === 'none' ? 'no declaration' : declared} → ${expected}`, () => {
        const ctx = declared === 'none' ? {} : { customHashFloor: declared };
        // The verdict, through the same accessor the render arm reads.
        expect(classifyCustomHashUnder(customHashFloorOf(ctx), treeHash, registryHash)).toBe(
          expected,
        );

        // …and the render decision, through an actual render: a floor computed
        // but never consulted would pass the line above and fail here.
        const invoked: string[] = [];
        renderToStaticMarkup(
          <FuaranRenderer<string>
            tree={customNode(treeHash)}
            runtime={{ registry: registryRecording(invoked, registryHash), warn: vi.fn() }}
            {...ctx}
          />,
        );
        expect(invoked).toEqual(renders(expected) ? ['sparkline'] : []);
      });
    }
  }
});
