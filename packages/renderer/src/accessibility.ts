// ============================================================================
//  @fuaran-ui/renderer/accessibility — project a Node's Accessibility trait
//  into the (attr-name, attr-value) pairs the outer wrapper emits as DOM
//  attributes. Port of the F# renderer's `accessibilityAttributes` helper
//  (Phase 12.I). Kept as a pure function so it is testable in isolation.
//
//  aria-labelledby / aria-describedby carry the referenced node's HTML id
//  (the NodeId's inner string), matching what the renderer emits as `id`.
//
//  WHERE the projection lands is a separate question from what it contains, and
//  `forwardsToSemanticElement` below is the answer — a kind whose body IS the
//  node's semantic element carries it there instead of on the wrapper. Port of
//  the F# tier's predicate; the two must not diverge or the emitted DOM forks
//  by host.
// ============================================================================

import type { Accessibility, NodeKind } from '@fuaran-ui/schema';

import { type BindingSources, tryResolve } from './bindings.js';

/**
 * Project an optional `Accessibility` (resolved against the supplied sources)
 * into ordered `[name, value]` attribute pairs. Order matches the F# helper:
 * label, labelledby, describedby, role, live, hidden.
 */
export const accessibilityAttributes = (
  sources: BindingSources,
  a11y: Accessibility | undefined,
): Array<readonly [string, string]> => {
  if (a11y === undefined) return [];
  const pairs: Array<readonly [string, string]> = [];

  if (a11y.label !== undefined) {
    const label = tryResolve(sources, a11y.label);
    if (label !== undefined && label !== '') pairs.push(['aria-label', label]);
  }
  if (a11y.labelledBy !== undefined) pairs.push(['aria-labelledby', a11y.labelledBy]);
  if (a11y.describedBy !== undefined) pairs.push(['aria-describedby', a11y.describedBy]);
  if (a11y.role !== undefined) pairs.push(['role', a11y.role]);
  if (a11y.liveRegion !== undefined) pairs.push(['aria-live', a11y.liveRegion]);
  if (a11y.hidden !== undefined) {
    const hidden = tryResolve(sources, a11y.hidden);
    if (hidden === true) pairs.push(['aria-hidden', 'true']);
  }

  return pairs;
};

/**
 * Does this kind render a body that IS the node's semantic element — so the
 * a11y projection belongs on the body, not on the wrapper `<div>`?
 *
 * Three conditions, all required (the F# tier's `docs/DECISIONS.md` D4):
 *
 *  1. the body is a SINGLE root element — not a container of siblings, not a
 *     label-wrapped control;
 *  2. that element carries native semantics of its own (an interactive role, or
 *     a graphic), so `role` / `aria-*` on an ancestor `<div>` is announced
 *     against the wrong node;
 *  3. the element IS the node — nothing else in the body competes for the
 *     accessible name.
 *
 * `Link` (`<a>`), `Button` (`<button>`) and `Image` (`<img>`) satisfy all three.
 * The form-field kinds deliberately do NOT: `Select` renders
 * `<label><span>…</span><select></label>`, so the control is not the body root
 * (1) and the wrapping `<label>` already supplies an accessible name (3).
 *
 * Kind-level by construction: the wrapper must decide before the body is
 * rendered, and the only thing it has then is the `NodeKind`. Where an arm has a
 * runtime branch (the protected-email `Link`), the ARM owns placement within its
 * own body.
 */
export const forwardsToSemanticElement = (kind: NodeKind<unknown>): boolean => {
  switch (kind.kind) {
    case 'Display':
      return kind.display.kind === 'Link' || kind.display.kind === 'Image';
    case 'Input':
      return kind.input.kind === 'Button';
    default:
      return false;
  }
};

/**
 * Split already-sanitised `extraAttributes` into the half that stays on the
 * wrapper and the half that follows the a11y projection: `[data-*, aria-*]`.
 *
 * `data-*` is ADDRESSING — it sits beside `data-fuaran-node-id`, which layout
 * observers, DOM-snapshot hooks and the in-page introspection surface scan for,
 * so moving it would move the node's address. An `aria-*` hatch is an
 * accessibility attribute and belongs wherever the accessibility attributes go.
 *
 * Only consulted for a kind that forwards — elsewhere both halves land on the
 * wrapper, exactly as before.
 */
export const partitionExtraAttributes = (
  attrs: Record<string, string>,
): [Record<string, string>, Record<string, string>] => {
  const data: Record<string, string> = {};
  const aria: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (k.startsWith('aria-')) aria[k] = v;
    else data[k] = v;
  }
  return [data, aria];
};
