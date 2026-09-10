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
// test -> renderer-server -> packages -> fuaran-ts -> Fuaran-UI/wire-format-fixtures
const corpusDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const nodesDir = join(corpusDir, 'nodes');

/**
 * One fixture's expectation, DERIVED from the corpus's own a11y contract
 * (Phase 1665).
 *
 * This table used to be hand-written here - and the same table was hand-written
 * again in the client tier beside it and in four sibling hosts. Six copies of one
 * cross-host claim is exactly the arrangement that let `accessibility.label`
 * resolve five different ways with every conformance gate green: each surface
 * measured itself against its own idea of the trait, and no copy could
 * contradict another. The claim now lives once, in `a11y-contract.json`'s
 * `behaviour` section, and every host reads it.
 *
 * What stays tier-local is the one thing the contract deliberately does not
 * state: which ELEMENT this tier renders for a forwarding kind.
 */
interface A11yCase {
  readonly fixture: string;
  /** `undefined` when the projection stays on the wrapper; else the semantic element's tag. */
  readonly element?: string;
  readonly want: readonly string[];
  readonly absentFromCarrier?: readonly string[];
}

/**
 * The six attribute names the accessibility projection can emit, in the wire's
 * slot order. The complement of a vector's own list is what that vector forbids:
 * the contract declares its attribute list EXHAUSTIVE for the projection.
 */
const PROJECTION_ATTRIBUTES = [
  'aria-label',
  'aria-labelledby',
  'aria-describedby',
  'role',
  'aria-live',
  'aria-hidden',
] as const;

/**
 * The element THIS tier's body renders for each forwarding fixture's kind. A
 * forwarding vector with no entry here throws rather than falling back to the
 * wrapper: a silent fallback would assert the projection landed where the
 * contract says it must not.
 */
const FORWARDING_TAG: Readonly<Record<string, string>> = {
  'a11y-link-labelled': 'a',
  'a11y-button-named': 'button',
  'a11y-image-decorative': 'img',
};

interface ContractVector {
  readonly fixture: string;
  readonly forwards: boolean;
  readonly attributes: ReadonlyArray<readonly [string, string]>;
}

const CASES: readonly A11yCase[] = (
  JSON.parse(readFileSync(join(corpusDir, 'a11y-contract.json'), 'utf8')) as {
    behaviour: { vectors: readonly ContractVector[] };
  }
).behaviour.vectors.map((v): A11yCase => {
  const names = new Set(v.attributes.map(([name]) => name));
  let element: string | undefined;
  if (v.forwards) {
    element = FORWARDING_TAG[v.fixture];
    if (element === undefined) {
      throw new Error(
        `${v.fixture}: the contract says the projection forwards, and this tier has not said which ` +
          'element it renders for that kind - add it to FORWARDING_TAG',
      );
    }
  }
  // Spread rather than assign: `exactOptionalPropertyTypes` distinguishes an
  // absent optional property from one holding `undefined`, and a non-forwarding
  // vector has no element at all.
  return {
    fixture: v.fixture,
    ...(element === undefined ? {} : { element }),
    want: v.attributes.map(([name, value]) => `${name}="${value}"`),
    absentFromCarrier: PROJECTION_ATTRIBUTES.filter((name) => !names.has(name)),
  };
});

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
  // checked nothing -- and since Phase 1665 the table is READ rather than written
  // here, so an empty one is also what a mis-shaped contract looks like. Both are
  // refused. The count is not restated: the contract is the enumeration, exactly
  // as `manifest.json` is for the fixtures.
  it("carries the contract's behaviour vectors, including the Transform-bound name", () => {
    expect(CASES.length).toBeGreaterThan(0);
    expect(CASES.map((c) => c.fixture)).toContain('a11y-wrapper-transform-label');
  });
});
