// ============================================================================
//  @fuaran-ui/renderer/render/ErrorBoundary — NodeKind.ErrorBoundary (Phase 60).
//  React still has no hook equivalent, so this uses the class-component
//  getDerivedStateFromError pattern. The child renders with `inErrorBoundary =
//  true` (so the per-node guard suspends and throws propagate to the boundary);
//  the fallback renders with `inErrorBoundary = false` (so its own subtree
//  re-enables the per-node guard). Mirrors the F# boundary's try/catch shape.
//
//  `GenericErrorBoundary` is the reusable primitive the NodeKind.Custom
//  dispatch wraps registered components in for OnError-routing (Phase 70).
// ============================================================================

import { Component, type ReactNode } from 'react';

import type { ErrorBoundarySpec, Node } from '@fuaran-ui/schema';

import type { RenderContext } from '../context.js';
import { renderNode } from './core.js';

interface BoundaryState {
  readonly hasError: boolean;
}

/** Generic catch-and-render-fallback boundary (the reusable primitive). */
export class GenericErrorBoundary extends Component<
  { readonly children: ReactNode; readonly fallback: (error: Error) => ReactNode },
  { error: Error | undefined }
> {
  override state: { error: Error | undefined } = { error: undefined };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override render(): ReactNode {
    if (this.state.error !== undefined) return this.props.fallback(this.state.error);
    return this.props.children;
  }
}

interface NodeBoundaryProps<TMsg> {
  readonly ctx: RenderContext<TMsg>;
  readonly parentNodeId: string;
  readonly spec: ErrorBoundarySpec<TMsg>;
}

/** NodeKind.ErrorBoundary renderer — renders child, falls back to fallback subtree. */
export class ErrorBoundaryRenderer<TMsg> extends Component<NodeBoundaryProps<TMsg>, BoundaryState> {
  override state: BoundaryState = { hasError: false };

  static getDerivedStateFromError(): BoundaryState {
    return { hasError: true };
  }

  override render(): ReactNode {
    const { ctx, spec } = this.props;
    if (this.state.hasError) {
      const fallback: Node<TMsg> = spec.fallback;
      const fallbackCtx: RenderContext<TMsg> = { ...ctx, inErrorBoundary: false };
      return renderNode(fallbackCtx, fallback);
    }
    const childCtx: RenderContext<TMsg> = { ...ctx, inErrorBoundary: true };
    return renderNode(childCtx, spec.child);
  }
}
