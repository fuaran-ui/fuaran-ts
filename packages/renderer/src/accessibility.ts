// ============================================================================
//  @fuaran-ui/renderer/accessibility — project a Node's Accessibility trait
//  into the (attr-name, attr-value) pairs the outer wrapper emits as DOM
//  attributes. Port of the F# renderer's `accessibilityAttributes` helper
//  (Phase 12.I). Kept as a pure function so it is testable in isolation.
//
//  aria-labelledby / aria-describedby carry the referenced node's HTML id
//  (the NodeId's inner string), matching what the renderer emits as `id`.
// ============================================================================

import type { Accessibility } from '@fuaran-ui/schema';

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
