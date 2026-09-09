// ============================================================================
//  merge3Way facet decomposition — the `tooltip` and `style.direction` slots.
//
//  Phase 1652. Both members are on the wire and were merged by neither this
//  tier's `mkNode` (which spread `tooltip` from `base`) nor its `mergeStyle`
//  (which listed five sub-fields and not `direction`). The failure is silent in
//  both directions, which is the reason for this file:
//
//   - a one-branch edit to either member was DISCARDED, with no refusal and no
//     diagnostic — the merged tree simply carried the base value; and
//   - because `tooltip` also leaked into the KIND / STATE / ACCESSIBILITY
//     isolation probes, a tooltip-only edit varied bytes those probes hold
//     fixed, so two branches that changed nothing but a hint would be reported
//     as a concurrent edit to the node's KIND.
//
//  Every tree here is built by decoding canonical wire JSON rather than by
//  hand-assembling a record, so a fixture cannot drift from what the codec
//  actually accepts, and each case states the falsifier in its own name.
// ============================================================================

import type { Node } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { decodeNode, merge3Way } from '../src/index.js';

/** A tooltip decodes to a `TextSource`, not a bare string — `"x"` on the wire is
 * the `Literal` shorthand. Compare against the decoded shape, never the source
 * text, or the assertion passes for the wrong reason on a future shorthand. */
const literal = (text: string) => ({ kind: 'Literal', value: text });

const node = (wire: string): Node<unknown> => {
  const r = decodeNode(wire);
  if (!r.ok) throw new Error(`fixture does not decode: ${JSON.stringify(r.error)}`);
  return r.value;
};

/** A Button with no tooltip and no declared direction — the LCA for both cases. */
const BASE =
  '{"id":"n","kind":{"$type":"Button","label":"Go","onClick":{"$type":"Notify","channel":"go","payload":{}},"variant":"Secondary"}}';

const withTooltip = (hint: string): string =>
  `{"id":"n","kind":{"$type":"Button","label":"Go","onClick":{"$type":"Notify","channel":"go","payload":{}},"variant":"Secondary"},"tooltip":${JSON.stringify(hint)}}`;

const withDirection = (dir: string): string =>
  `{"id":"n","kind":{"$type":"Button","label":"Go","onClick":{"$type":"Notify","channel":"go","payload":{}},"variant":"Secondary"},"style":{"direction":"${dir}"}}`;

describe('merge3Way — the tooltip facet', () => {
  it('keeps a hint added on ONE branch (it used to be discarded in silence)', () => {
    const r = merge3Way(node(BASE), node(withTooltip('Rebuilds the index.')), node(BASE));
    expect(r.ok, r.ok ? '' : `unexpected refusal: ${JSON.stringify(r.conflicts)}`).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tooltip).toEqual(literal('Rebuilds the index.'));
  });

  it('keeps a hint added on the OTHER branch — the merge is side-symmetric', () => {
    const r = merge3Way(node(BASE), node(BASE), node(withTooltip('Rebuilds the index.')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tooltip).toEqual(literal('Rebuilds the index.'));
  });

  it('keeps a hint REMOVED on one branch — absence is an edit too', () => {
    const start = withTooltip('Old hint.');
    const r = merge3Way(node(start), node(BASE), node(start));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tooltip).toBeUndefined();
  });

  it('takes the shared value when both branches set the SAME hint — agreement, not conflict', () => {
    const same = withTooltip('Same hint.');
    const r = merge3Way(node(BASE), node(same), node(same));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.tooltip).toEqual(literal('Same hint.'));
  });

  it('REFUSES two different hints, naming the `tooltip` facet rather than `kind`', () => {
    const r = merge3Way(node(BASE), node(withTooltip('Hint A.')), node(withTooltip('Hint B.')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const facets = r.conflicts.map((c) => c.facet);
    expect(facets).toContain('tooltip');
    // The isolation half of the fix: a hint is not a kind. Before `tooltip` had
    // a probe of its own it leaked into `kindCanonical`, so this same input
    // refused on `kind` — a refusal naming a member neither branch touched.
    expect(facets).not.toContain('kind');
    const c = r.conflicts.find((x) => x.facet === 'tooltip')!;
    expect(c.class).toBe('ConcurrentEdit');
    expect(c.nodeId).toBe('n');
  });

  it('does not report a tooltip-only edit as a change to any other facet', () => {
    const r = merge3Way(node(BASE), node(withTooltip('Only a hint.')), node(BASE));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The kind, style, state and accessibility facets all came from `base`
    // unchanged, so the merged node differs from base in the hint alone.
    expect(r.tree.kind).toEqual(node(BASE).kind);
    expect(r.tree.style).toEqual(node(BASE).style);
  });
});

describe('merge3Way — the style.direction facet', () => {
  it('keeps a direction declared on ONE branch (it used to be discarded in silence)', () => {
    const r = merge3Way(node(BASE), node(withDirection('rtl')), node(BASE));
    expect(r.ok, r.ok ? '' : `unexpected refusal: ${JSON.stringify(r.conflicts)}`).toBe(true);
    if (!r.ok) return;
    expect(r.tree.style.direction).toBe('rtl');
  });

  it('keeps a direction declared on the OTHER branch', () => {
    const r = merge3Way(node(BASE), node(BASE), node(withDirection('ltr')));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.tree.style.direction).toBe('ltr');
  });

  it('blends independently with a different style sub-field — the M2 property', () => {
    const toned =
      '{"id":"n","kind":{"$type":"Button","label":"Go","onClick":{"$type":"Notify","channel":"go","payload":{}},"variant":"Secondary"},"style":{"tone":"Brand"}}';
    const r = merge3Way(node(BASE), node(withDirection('rtl')), node(toned));
    expect(r.ok, r.ok ? '' : `unexpected refusal: ${JSON.stringify(r.conflicts)}`).toBe(true);
    if (!r.ok) return;
    expect(r.tree.style.direction).toBe('rtl');
    expect(r.tree.style.tone).toBe('Brand');
  });

  it('REFUSES two different directions, and the envelope carries the LOWER-CASE wire tokens', () => {
    const r = merge3Way(node(BASE), node(withDirection('rtl')), node(withDirection('ltr')));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const c = r.conflicts.find((x) => x.facet === 'style.direction');
    expect(c, `no style.direction refusal in ${JSON.stringify(r.conflicts)}`).toBeDefined();
    expect(c!.class).toBe('ConcurrentEdit');
    // These three strings are WIRE, not prose. `direction` is the one style
    // facet whose canonical token is not the reference host's F# case name
    // (`Auto` / `Ltr` / `Rtl`), so a mirror that "corrects" them to match the
    // case names changes what a cross-host refusal envelope says. Pinning them
    // here is what turns that into a failing test rather than a silent
    // divergence.
    expect(c!.base).toBe('auto');
    expect(c!.a.value).toBe('rtl');
    expect(c!.b.value).toBe('ltr');
  });

  it('treats an explicitly-declared `auto` as the default — absent ⟺ auto', () => {
    const r = merge3Way(node(BASE), node(withDirection('auto')), node(withDirection('rtl')));
    // The A side declared the identity, so only B changed the cell: one-sided,
    // no refusal.
    expect(r.ok, r.ok ? '' : `unexpected refusal: ${JSON.stringify(r.conflicts)}`).toBe(true);
    if (!r.ok) return;
    expect(r.tree.style.direction).toBe('rtl');
  });
});
