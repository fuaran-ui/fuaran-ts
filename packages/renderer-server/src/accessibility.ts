// ============================================================================
//  @fuaran-ui/renderer-server/accessibility — project a Node's Accessibility
//  trait into ordered (attr-name, attr-value) pairs for the outer wrapper.
//
//  Verbatim copy of @fuaran-ui/renderer's accessibility module (React-free).
//  Order matches the F# helper: label, labelledby, describedby, role, live,
//  hidden — so the server wrapper's ARIA attribute set matches the client's.
// ============================================================================

import type { Accessibility, NodeKind } from '@fuaran-ui/schema';

import { type BindingSources, tryResolve } from './bindings.js';

/** Project an optional `Accessibility` (resolved against sources) into `[name, value]` pairs. */
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

// --- The node-level tooltip trait (Phase 1112) -------------------------------
//
// A tooltip is a DESCRIPTION of the node, revealed by the renderer's own hover /
// focus / long-press affordance and announced through `aria-describedby`. Two
// placement questions follow from one principle, and getting either wrong makes
// the hint reach nobody:
//
//  1. THE ELEMENT THAT CARRIES `aria-describedby` MUST BE THE ELEMENT THAT TAKES
//     FOCUS. A description on a wrapper the keyboard never lands on is announced
//     on no interaction at all; a description on a control while the wrapper is
//     the focus stop is the same failure with the parts swapped.
//  2. A node whose body is not a focus stop therefore needs one -- `tabindex="0"`
//     on the wrapper -- or the hint is pointer-only, which is WCAG 2.1.1.
//
// So the two decisions are ONE decision, taken here and read by the renderer.

/**
 * Does a node-level tooltip's `aria-describedby` ride the kind's own semantic
 * element (rather than the wrapper)? True exactly when the projection forwards
 * AND the forwarded-to element is a native focus stop.
 *
 * `Image` forwards its projection and `<img>` takes no focus, so an image with a
 * hint takes the wrapper description AND the wrapper focus stop -- the pair, or
 * neither. That is the case that shows this is not simply
 * `forwardsToSemanticElement`.
 *
 * Composed over `forwardsToSemanticElement` rather than restating its arms, so a
 * kind added there (`Media` and `Embed` are the two this tier still owes) is
 * picked up here by the same edit.
 */
export const tooltipRidesSemanticElement = (kind: NodeKind<unknown>): boolean => {
  if (!forwardsToSemanticElement(kind)) return false;
  switch (kind.kind) {
    // `<button>`, `<a href>`, `<video controls>` / `<audio controls>` and
    // `<iframe>` are each a native focus stop.
    case 'Input':
      return kind.input.kind === 'Button';
    case 'Display':
      return (
        kind.display.kind === 'Link' ||
        kind.display.kind === 'Media' ||
        kind.display.kind === 'Embed'
      );
    default:
      return false;
  }
};

/**
 * The DOM id of the hint element a node's tooltip renders as. Derived from the
 * node id so every host computes the same string without carrying a second
 * identifier on the wire.
 */
export const tooltipHintId = (nodeId: string): string => `${nodeId}-tooltip`;

/**
 * Merge a tooltip's hint id into an attribute map's `aria-describedby`.
 *
 * Appended, never substituted: `aria-describedby` is an ID LIST, and a node that
 * declares `accessibility.describedBy` AND carries a hint has said two different
 * things a reader is owed both of.
 */
export const withTooltipDescribedBy = (hintId: string, attrs: Record<string, string>): void => {
  const existing = attrs['aria-describedby'];
  attrs['aria-describedby'] = existing === undefined ? hintId : `${existing} ${hintId}`;
};
