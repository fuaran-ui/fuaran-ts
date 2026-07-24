// ============================================================================
//  @fuaran-ui/renderer/render/Fragment — FragmentRef expansion (Phase 61).
//  Cycle-guarded expansion with `<refId>.<innerId>` namespacing of interior
//  NodeIds, so sibling refs to the same fragment stay DOM-unique. Unresolved
//  and cyclic refs render a labelled placeholder rather than throwing (matching
//  the F# renderer). FragmentDecl renders nothing (handled in core).
// ============================================================================

import type { ReactElement } from 'react';

import type { FragmentRefSpec } from '@fuaran-ui/schema';

import type { RenderContext } from '../context.js';
import { namespaceNode } from '../context.js';
import { renderNode } from './core.js';

export const renderFragmentRef = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  spec: FragmentRefSpec<TMsg>,
): ReactElement => {
  const name = spec.name;

  if (ctx.expandingFragments.has(name)) {
    if (ctx.runtime.warn) {
      ctx.runtime.warn(
        `[fuaran:fragment] cycle detected expanding ref '${parentNodeId}' → fragment '${name}'; rendering placeholder.`,
      );
    }
    return (
      <div className="fuaran-fragment-cycle-placeholder" data-fuaran-fragment-cycle={name}>
        {`[fuaran:fragment cycle '${name}']`}
      </div>
    );
  }

  const body = ctx.fragments.get(name);
  if (body === undefined) {
    if (ctx.runtime.warn) {
      ctx.runtime.warn(
        `[fuaran:fragment] ref '${parentNodeId}' points to fragment '${name}' which has no declaration in this tree; rendering placeholder.`,
      );
    }
    return (
      <div
        className="fuaran-fragment-unresolved-placeholder"
        data-fuaran-fragment-unresolved={name}
      >
        {`[fuaran:fragment unresolved '${name}']`}
      </div>
    );
  }

  const prefix = parentNodeId + '.';
  const namespaced = namespaceNode(prefix, body);
  const expandingFragments = new Set(ctx.expandingFragments);
  expandingFragments.add(name);
  const expandedCtx: RenderContext<TMsg> = { ...ctx, expandingFragments };
  return renderNode(expandedCtx, namespaced);
};
