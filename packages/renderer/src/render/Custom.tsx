// ============================================================================
//  @fuaran-ui/renderer/render/Custom — NodeKind.Custom bounded escape (Phase 70).
//  Dispatches to the per-instance custom-renderer registry, with:
//    1. content-hash verification (pre-dispatch): Match / NoTreeHash → render;
//       RegistryNoHash / MismatchAdvisory → warn + render; MismatchStrict →
//       warn + route through state.onError (or placeholder when absent).
//    2. post-paint DOM walk for declared exposedNodeIds (browser only) — warns
//       when a declared interior id never appears in the rendered subtree.
//    3. OnError-routing when the registered React component throws, via a
//       wrapping error boundary that falls back to state.onError / placeholder.
// ============================================================================

import { useEffect } from 'react';
import type { ReactElement, ReactNode } from 'react';

import type { ContentHash, NodeKind, StateBehaviour } from '@fuaran-ui/schema';

import type { RenderContext } from '../context.js';
import { GenericErrorBoundary } from './ErrorBoundary.js';
import { renderNode } from './core.js';

type CustomKind<TMsg> = Extract<NodeKind<TMsg>, { kind: 'Custom' }>;

type HashOutcome =
  | 'NoTreeHash'
  | 'Match'
  | 'RegistryNoHash'
  | 'MismatchAdvisory'
  | 'MismatchStrict';

const classifyHash = (
  treeHash: ContentHash | undefined,
  registryHash: ContentHash | undefined,
): HashOutcome => {
  if (treeHash === undefined) return 'NoTreeHash';
  if (registryHash === undefined) return 'RegistryNoHash';
  if (treeHash.algorithm === registryHash.algorithm && treeHash.hash === registryHash.hash)
    return 'Match';
  return treeHash.strictness === 'StrictReplay' ? 'MismatchStrict' : 'MismatchAdvisory';
};

const renderHash = (h: ContentHash | undefined): string =>
  h ? `${h.algorithm}:${h.hash}` : '(none)';

const formatHashMismatchPayload = (
  moduleId: string,
  componentId: string,
  expected: ContentHash | undefined,
  actual: ContentHash | undefined,
): string =>
  `{ "kind": "FuaranCustomHashMismatch", "moduleId": "${moduleId}", "componentId": "${componentId}", "expected": "${renderHash(
    expected,
  )}", "actual": "${renderHash(actual)}" }`;

let counter = 0;
const correlationId = (): string => {
  counter += 1;
  return `c${counter.toString(36)}`;
};

export const renderCustom = <TMsg,>(
  ctx: RenderContext<TMsg>,
  parentNodeId: string,
  state: StateBehaviour<TMsg>,
  kind: CustomKind<TMsg>,
): ReactElement => (
  <CustomNodeView ctx={ctx} parentNodeId={parentNodeId} state={state} kind={kind} />
);

function CustomNodeView<TMsg>({
  ctx,
  parentNodeId,
  state,
  kind,
}: {
  ctx: RenderContext<TMsg>;
  parentNodeId: string;
  state: StateBehaviour<TMsg>;
  kind: CustomKind<TMsg>;
}): ReactElement {
  const { moduleId, componentId, props, contentHash, exposedNodeIds } = kind;
  const entry = ctx.runtime.registry?.get(moduleId, componentId);
  const outcome = classifyHash(contentHash, entry?.contentHash);

  // Post-paint exposed-NodeIds verification (browser only; no-op under SSR / .NET parity).
  useEffect(() => {
    if (exposedNodeIds.length === 0 || typeof document === 'undefined') return;
    const id = window.setTimeout(() => {
      const wrapper = document.querySelector(`[data-fuaran-node-id="${parentNodeId}"]`);
      if (!wrapper) return;
      const present = new Set(
        Array.from(wrapper.querySelectorAll('[data-fuaran-node-id]'))
          .map((el) => el.getAttribute('data-fuaran-node-id'))
          .filter((s): s is string => s !== null && s !== parentNodeId),
      );
      for (const expected of exposedNodeIds) {
        if (!present.has(expected) && ctx.runtime.warn) {
          ctx.runtime.warn(
            `Phase 70 exposed-NodeIds verification: Custom '${parentNodeId}' declared exposed-id '${expected}' but no matching data-fuaran-node-id was emitted.`,
          );
        }
      }
    }, 0);
    return () => window.clearTimeout(id);
  });

  const placeholder = (): ReactElement => {
    const propKeys = Object.keys(props).join(', ');
    return (
      <div className="fuaran-custom-placeholder">
        <div className="fuaran-custom-label">{`Custom ${moduleId}.${componentId}`}</div>
        <div className="fuaran-custom-props">{`props: ${propKeys}`}</div>
      </div>
    );
  };

  const dispatchToRenderer = (): ReactNode => {
    if (entry === undefined) return placeholder();
    const Comp = entry.render;
    return (
      <GenericErrorBoundary
        fallback={() => {
          if (state.onError !== undefined) {
            return renderNode(
              ctx,
              state.onError({
                kind: 'BindingResolution',
                message: `Custom renderer ${moduleId}.${componentId} threw during render.`,
                correlationId: correlationId(),
              }),
            );
          }
          return placeholder();
        }}
      >
        <Comp moduleId={moduleId} componentId={componentId} props={props} />
      </GenericErrorBoundary>
    );
  };

  switch (outcome) {
    case 'Match':
    case 'NoTreeHash':
      return <>{dispatchToRenderer()}</>;
    case 'RegistryNoHash':
    case 'MismatchAdvisory':
      if (ctx.runtime.warn)
        ctx.runtime.warn(
          formatHashMismatchPayload(moduleId, componentId, contentHash, entry?.contentHash),
        );
      return <>{dispatchToRenderer()}</>;
    case 'MismatchStrict':
      if (ctx.runtime.warn)
        ctx.runtime.warn(
          formatHashMismatchPayload(moduleId, componentId, contentHash, entry?.contentHash),
        );
      if (state.onError !== undefined) {
        return (
          <>
            {renderNode(
              ctx,
              state.onError({
                kind: 'BindingResolution',
                message: `Custom hash mismatch for ${moduleId}.${componentId} (StrictReplay).`,
                correlationId: correlationId(),
              }),
            )}
          </>
        );
      }
      return placeholder();
  }
}
