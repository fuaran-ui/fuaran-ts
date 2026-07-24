// ============================================================================
//  @fuaran-ui/renderer — the <FuaranRenderer> top-level React component.
//
//  `<FuaranRenderer tree={tree} />` renders any Fuaran Node<TMsg> tree (authored
//  with @fuaran-ui/ui or decoded with @fuaran-ui/ops) to React DOM, dispatching
//  over tree.kind.kind to the per-NodeKind sub-renderers under src/render/.
//  Class-name + ARIA parity with the F# reference renderer is the load-bearing
//  property (see classNames.ts).
//
//  The optional `runtime` prop carries the per-instance custom-renderer registry
//  + host effect ports (Call / Notify / Navigate / SetState / AiTool /
//  WriteToClipboard / Warn). The optional `theme` prop injects the Theme's CSS
//  custom properties as inline variables at the render root.
// ============================================================================

import { type CSSProperties, type ReactElement, useEffect } from 'react';

import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from './bindings.js';
import type { RenderContext } from './context.js';
import { collectFragments } from './context.js';
import type { FuaranRuntime } from './customRegistry.js';
import { buildDebugGlobal, type DebugGlobalOptions, registerDebugGlobal } from './debugGlobal.js';
import { renderNode } from './render/core.js';
import { type Theme, themeToStyle } from './theme.js';

export interface FuaranRendererProps<TMsg = unknown> {
  /** The typed Fuaran tree to render. */
  readonly tree: Node<TMsg>;
  /** Receives `Action.Dispatch` messages. Defaults to a no-op. */
  readonly dispatch?: (msg: TMsg) => void;
  /** Data sources consulted during binding resolution. Defaults to empty. */
  readonly sources?: BindingSources;
  /** Host effect substrate + per-instance custom-renderer registry. Defaults to empty. */
  readonly runtime?: FuaranRuntime;
  /** Optional theme — injects CSS custom properties as inline variables at the render root. */
  readonly theme?: Theme;
  /**
   * When `true`, registers the in-page introspection REPL on `window.__fuaran`
   * for the duration this renderer is mounted (see `debugGlobal.ts`). The global
   * exposes the typed layer (node state, resolved bindings, DOM geometry) to the
   * browser DevTools console. DEBUG-only / unstable — gate it on
   * `import.meta.env.DEV` so it never registers in a production build.
   */
  readonly debug?: boolean;
  /**
   * When set (alongside `debug`), wires the policy-gated
   * `window.__fuaran.apply(opJson)` mutation: the callback receives the
   * post-apply tree so the host can `setState` and re-render. Omit for a
   * read-only debug surface (`apply` returns the `unwired` envelope). The apply
   * is consulted against `runtime.canDispatch` first (default-deny, FGP 3).
   */
  readonly onApply?: (newTree: Node<TMsg>) => void;
}

const noopDispatch = (): void => {};

/** Render a Fuaran tree to React DOM. */
export function FuaranRenderer<TMsg>(props: FuaranRendererProps<TMsg>): ReactElement {
  // Register window.__fuaran while mounted, scoped to the live tree + sources.
  // The effect cleanup unregisters it, so it never outlives the renderer and
  // never lingers in a production build (where `debug` is left unset).
  useEffect(() => {
    if (props.debug !== true) return undefined;
    // `exactOptionalPropertyTypes`: omit absent options rather than passing
    // explicit `undefined` (an absent gate allows; an absent handler is read-only).
    const options: DebugGlobalOptions<TMsg> = {
      ...(props.runtime !== undefined ? { runtime: props.runtime } : {}),
      ...(props.onApply !== undefined ? { applyHandler: props.onApply } : {}),
    };
    return registerDebugGlobal(buildDebugGlobal(props.tree, props.sources ?? {}, options));
  }, [props.debug, props.tree, props.sources, props.runtime, props.onApply]);

  const ctx: RenderContext<TMsg> = {
    sources: props.sources ?? {},
    runtime: props.runtime ?? {},
    dispatch: props.dispatch ?? noopDispatch,
    fragments: collectFragments(new Map<string, Node<TMsg>>(), props.tree),
    expandingFragments: new Set<string>(),
    inErrorBoundary: false,
  };

  const rendered = renderNode(ctx, props.tree);

  if (props.theme !== undefined) {
    const style = themeToStyle(props.theme) as CSSProperties;
    return (
      <div className="fuaran-root" style={style}>
        {rendered}
      </div>
    );
  }

  return rendered;
}
