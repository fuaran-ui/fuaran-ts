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
// ============================================================================

import type { ContentHash, HashStrictness, Node } from '@fuaran-ui/schema';
import { defaults, nodeId } from '@fuaran-ui/schema';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

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
  it('omitting the hash is a REFUSAL under an enforcing floor', () => {
    expect(classifyCustomHashUnder('StrictReplay', undefined, hash('abc', 'StrictReplay'))).toBe(
      'Unverifiable',
    );
    // …and the default floor is unchanged: no tree hash still renders.
    expect(classifyCustomHashUnder('AdvisoryWarning', undefined, hash('abc', 'StrictReplay'))).toBe(
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

  it('`Enforced` reaching a renderer is as strict as `StrictReplay`', () => {
    expect(isEnforcingHashStrictness('AdvisoryWarning')).toBe(false);
    expect(isEnforcingHashStrictness('StrictReplay')).toBe(true);
    expect(isEnforcingHashStrictness('Enforced')).toBe(true);
  });

  it('an undeclared floor reads as the lenient default, not as an enforcing one', () => {
    expect(defaultCustomHashFloor).toBe('AdvisoryWarning');
    expect(customHashFloorOf({})).toBe('AdvisoryWarning');
    expect(customHashFloorOf({ customHashFloor: 'Enforced' })).toBe('Enforced');
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

  it('THE REGRESSION CASE: remove the floor and the same tree renders', () => {
    // This is the assertion that goes red if the guard is deleted — the pair
    // above and below differ ONLY in the declared floor. Without it, "the
    // renderer did not run" could be true for any number of reasons.
    const invoked: string[] = [];
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(hash('aaa', 'AdvisoryWarning'))}
        runtime={{
          registry: registryRecording(invoked, hash('bbb', 'StrictReplay')),
          warn: vi.fn(),
        }}
      />,
    );

    expect(invoked).toEqual(['sparkline']);
    expect(html).toContain('the-registered-renderer');
  });

  it('omitting the hash entirely is refused under an enforcing floor', () => {
    const invoked: string[] = [];
    const warn = vi.fn();
    const html = renderToStaticMarkup(
      <FuaranRenderer<string>
        tree={customNode(undefined)}
        runtime={{ registry: registryRecording(invoked, hash('bbb', 'StrictReplay')), warn }}
        customHashFloor="Enforced"
      />,
    );

    expect(invoked).toEqual([]);
    expect(html).toContain('fuaran-custom-placeholder');
    expect(warn).toHaveBeenCalled();
  });

  it('the no-floor default is byte-compatible: an unhashed tree still renders', () => {
    // The stability claim of this phase, asserted rather than assumed.
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
