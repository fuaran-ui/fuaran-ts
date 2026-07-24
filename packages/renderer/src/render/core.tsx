// ============================================================================
//  @fuaran-ui/renderer/render/core — the recursive node renderer.
//
//  Mirrors the F# reference renderer's `render` + `renderKind` functions: every
//  node renders to an outer wrapper `<div>` carrying `id`, `data-fuaran-node-id`,
//  the kind+style className, projected aria-* attributes, and sanitised
//  extra-attributes; the per-kind body renders as its single child. The
//  per-node render guard catches a throwing body so sibling nodes stay live
//  (suspended under an active ErrorBoundary, which wants the fallback subtree).
//
//  Class-name + ARIA parity with the F# renderer is the load-bearing property —
//  see classNames.ts.
// ============================================================================

import type { ReactElement, ReactNode } from 'react';

import type { Node, NodeKind, StateBehaviour } from '@fuaran-ui/schema';

import { accessibilityAttributes } from '../accessibility.js';
import { motionVar, nodeClassName } from '../classNames.js';
import type { RenderContext } from '../context.js';
import { sanitizeExtraAttributes } from '../sanitize.js';
import { renderCustom } from './Custom.js';
import { renderDisplay } from './Display.js';
import { ErrorBoundaryRenderer } from './ErrorBoundary.js';
import { renderFragmentRef } from './Fragment.js';
import { renderInput } from './Input.js';
import { renderLayout } from './Layout.js';
import { renderVis } from './Visualisation.js';

/** Project a NodeKind to "Layout.Stack" / "Display.KPI" / … for failure telemetry. */
export const nodeKindName = (kind: NodeKind<unknown>): string => {
  switch (kind.kind) {
    case 'Layout':
      return `Layout.${kind.layout.kind}`;
    case 'Display':
      return `Display.${kind.display.kind}`;
    case 'Input':
      return `Input.${kind.input.kind}`;
    case 'Visualisation':
      return `Visualisation.${kind.visualisation.kind}`;
    case 'Custom':
      return `Custom.${kind.moduleId}.${kind.componentId}`;
    case 'ErrorBoundary':
      return 'ErrorBoundary';
    case 'Switch':
      return 'Switch';
    case 'FragmentDecl':
      return 'FragmentDecl';
    case 'FragmentRef':
      return 'FragmentRef';
    case 'Mount':
      return `Mount.${kind.spec.scopeId}`;
  }
};

/** Render a list of child nodes with stable React keys. */
export const renderChildren = <TMsg,>(
  ctx: RenderContext<TMsg>,
  nodes: readonly Node<TMsg>[],
): ReactElement[] => nodes.map((child, i) => renderNode(ctx, child, `${child.id}:${i}`));

/** Per-`NodeKind` dispatch to the family sub-renderers. */
export const renderKind = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  state: StateBehaviour<TMsg>,
  kind: NodeKind<TMsg>,
): ReactNode => {
  switch (kind.kind) {
    case 'Layout':
      return renderLayout(ctx, parentNodeId, kind.layout);
    case 'Display':
      return renderDisplay(ctx, state, kind.display);
    case 'Input':
      return renderInput(ctx, kind.input);
    case 'Visualisation':
      return renderVis(ctx, parentNodeId, state, kind.visualisation);
    case 'ErrorBoundary':
      return <ErrorBoundaryRenderer ctx={ctx} parentNodeId={parentNodeId} spec={kind.spec} />;
    case 'Switch': {
      // State-bound conditional child (Phase 392). Resolve the state value at
      // `stateKey` from the (snapshot) sources, match its string form against
      // each case in order (first-match-wins), and render that case's child —
      // else the default. State transitions arrive as ordinary Action.SetState
      // (via runtime.setState); the host re-renders with an updated sources.state
      // and the switch re-selects — no bespoke dispatch path (FGP 3). SSR reads
      // the same initial state, so server + client first render match (hydration
      // parity, docs/SSR.md).
      const raw = ctx.sources.state?.[kind.spec.stateKey];
      const valueStr = raw === undefined || raw === null ? '' : String(raw);
      const matched = kind.spec.cases.find((c) => c.match === valueStr);
      return renderNode(ctx, matched ? matched.child : kind.spec.default);
    }
    case 'Custom':
      return renderCustom(ctx, parentNodeId, state, kind);
    case 'FragmentDecl':
      // The decl renders nothing visible — its body is the template the refs expand.
      return null;
    case 'FragmentRef':
      return renderFragmentRef(ctx, parentNodeId, kind.spec);
    case 'Mount':
      // Isolation/embedding boundary (§4o) — declared empty state until the
      // guest loader attaches (Phase 266); mirrors the F# renderer's Mount arm
      // (never a throw). The scope id is carried as a data attribute so the
      // boundary stays addressable across the isolation seam.
      return (
        <div className="fuaran-mount-placeholder" data-fuaran-mount-scope={kind.spec.scopeId}>
          {`[fuaran:mount '${kind.spec.scopeId}' — guest loader not attached]`}
        </div>
      );
  }
};

/** Render a Fuaran `Node<TMsg>` to a React element against an explicit context. */
export const renderNode = <TMsg,>(
  ctx: RenderContext<TMsg>,
  node: Node<TMsg>,
  key?: string,
): ReactElement => {
  const id = node.id;

  let className = nodeClassName(node.kind, node.style);
  if (node.motion !== undefined) className += ` fuaran-motion-${motionVar(node.motion)}`;

  const attrs: Record<string, string> = {};
  for (const [k, v] of accessibilityAttributes(ctx.sources, node.accessibility)) attrs[k] = v;
  if (node.extraAttributes !== undefined) {
    Object.assign(attrs, sanitizeExtraAttributes(node.extraAttributes));
  }

  let kindBody: ReactNode;
  try {
    kindBody = renderKind(ctx, id, node.state, node.kind);
  } catch (ex) {
    if (ctx.inErrorBoundary) throw ex;
    const message = ex instanceof Error ? ex.message : String(ex);
    kindBody = (
      <div
        className="fuaran-node-fallback"
        data-fuaran-render-failed="true"
        data-fuaran-render-correlation={correlationId()}
      >
        {`[fuaran: render failed for '${id}' (${nodeKindName(node.kind)}) — ${message}]`}
      </div>
    );
  }

  return (
    <div key={key} id={id} data-fuaran-node-id={id} className={className} {...attrs}>
      {kindBody}
    </div>
  );
};

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `r${counter.toString(36)}`;
};
