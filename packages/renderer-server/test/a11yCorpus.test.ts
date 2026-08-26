// ============================================================================
//  Phase 956 — the a11y projection, driven by the SHARED CORPUS (server tier).
//
//  The twin of @fuaran-ui/renderer's a11yCorpus suite. a11yPlacement.test.ts
//  already asserts WHERE the projection lands, but every node in it is
//  hand-built in this repo — so it measures this tier against this tier's own
//  idea of the trait. The Phase-955 fixture family is the
//  oracle every host answers to: all six slots, both role classes (a named
//  lower-case `region` and a deliberately-cased custom `doc-pageFooter`), both
//  binding forms (Static and State), all three liveRegion tokens, and both
//  placement shapes.
//
//  The render-parity corpus next door compares CLASS and node-id SETS, not
//  attribute placement, so a tier that emitted the projection on the wrapper
//  while its twin emitted it on the anchor would pass it. These assertions
//  split at an element's own open tag, the 951 pattern.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// test → renderer-server → packages → fuaran-ts → Fuaran-UI/wire-format-fixtures
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

/** One fixture's expectation. */
interface A11yCase {
  readonly fixture: string;
  /** `undefined` when the projection stays on the wrapper; else the semantic element's tag. */
  readonly element?: string;
  readonly want: readonly string[];
  readonly absentFromCarrier?: readonly string[];
}

const CASES: readonly A11yCase[] = [
  {
    // All six slots at once on an ordinary wrapper kind. `hidden` is an
    // explicit Static FALSE — distinct on the wire from omitted, and it must
    // emit nothing (`aria-hidden` is not a tri-state).
    fixture: 'a11y-wrapper-all-slots',
    want: [
      'aria-label="Channel performance summary"',
      'aria-labelledby="a11y-wrapper-heading"',
      'aria-describedby="a11y-wrapper-note"',
      'role="region"',
      'aria-live="polite"',
    ],
    absentFromCarrier: ['aria-hidden'],
  },
  {
    // The State forms. `label` resolves through its declared `defaultValue`
    // with no host state; the custom role's CASE is carried verbatim — the
    // exact spelling a fold bug once rewrote — and `off` is a real liveRegion
    // token, not an absence.
    fixture: 'a11y-wrapper-state-bound',
    want: ['aria-label="Site footer"', 'role="doc-pageFooter"', 'aria-live="off"'],
    absentFromCarrier: ['aria-hidden'],
  },
  {
    fixture: 'a11y-alert-assertive',
    want: ['role="alert"', 'aria-live="assertive"'],
  },
  {
    // D4 forwarding: the body IS the semantic element. The accessible name
    // OVERRIDES the visible "Read more".
    fixture: 'a11y-link-labelled',
    element: 'a',
    want: ['aria-label="Read the 2026 annual report (PDF)"'],
  },
  {
    fixture: 'a11y-button-named',
    element: 'button',
    want: ['aria-label="Refresh revenue figures"', 'role="button"'],
  },
  {
    // The decorative shape: empty alt + `hidden` Static TRUE — the slot two
    // hosts dropped entirely before the Phase 951 port.
    fixture: 'a11y-image-decorative',
    element: 'img',
    want: ['aria-hidden="true"'],
  },
];

/**
 * The node wrapper's own open tag, located by the node's ADDRESS rather than by
 * taking the markup's first `>`.
 *
 * Kept identical to the client tier's helper rather than simplified to a
 * first-`>` slice: the two tiers' preambles differ (the client emits a
 * `<link rel="preload">` ahead of an `Image` wrapper), and a helper that only
 * works on one of them is how the two legs drift apart.
 */
const wrapperTag = (markup: string, id: string): string => {
  const at = markup.indexOf(`data-fuaran-node-id="${id}"`);
  if (at < 0) throw new Error(`no wrapper carrying the node address ${id}: ${markup}`);
  const from = markup.slice(markup.lastIndexOf('<', at));
  return from.slice(0, from.indexOf('>') + 1);
};

const openTag = (markup: string, tag: string): string => {
  const from = markup.slice(markup.indexOf(`<${tag}`));
  return from.slice(0, from.indexOf('>') + 1);
};

const renderFixture = (fixture: string): { markup: string; id: string } => {
  const decoded = decodeNode(readFileSync(join(nodesDir, `${fixture}.json`), 'utf8'));
  if (!decoded.ok) throw new Error(`${fixture} failed to decode: ${JSON.stringify(decoded.error)}`);
  return {
    markup: renderToHtml(decoded.value),
    id: decoded.value.id,
  };
};

describe('Phase 956 — the a11y corpus family projects onto the right element', () => {
  it.each(CASES.map((c) => [c.fixture, c] as const))('%s', (_name, testCase) => {
    const { markup, id } = renderFixture(testCase.fixture);
    const wrapper = wrapperTag(markup, id);
    const carrier = testCase.element === undefined ? wrapper : openTag(markup, testCase.element);

    for (const want of testCase.want) expect(carrier).toContain(want);
    for (const absent of testCase.absentFromCarrier ?? []) expect(carrier).not.toContain(absent);

    // A forwarding kind must not leave the projection behind.
    if (testCase.element !== undefined) {
      for (const want of testCase.want) {
        expect(wrapper).not.toContain(want.slice(0, want.indexOf('=')));
      }
    }

    // The wrapper keeps the node's ADDRESS whichever element carries the projection.
    expect(wrapper).toContain(`data-fuaran-node-id="${id}"`);
  });

  // A table-driven leg that silently enumerated nothing would be a gate that
  // checked nothing.
  it('covers the full Phase 955 node family', () => {
    expect(CASES).toHaveLength(6);
  });
});
