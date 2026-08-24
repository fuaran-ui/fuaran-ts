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
import { denyNonLocalEgress, type EgressPolicy } from './egress.js';
import { pageChangeHub } from './changeHub.js';
import {
  buildDebugGlobal,
  type DebugGlobalOptions,
  readRegisteredDebugGlobal,
  registerDebugGlobal,
} from './debugGlobal.js';
import { installRelayPeer } from './relay.js';
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
   * Phase 1037 — the ambient destination policy (WIRE_FORMAT §14.1) every
   * emission site consults for a `Link` href, an `Image` src, a DataGrid link
   * column, an `Action.Navigate` route and the markdown body.
   *
   * **Omitting it means `denyNonLocalEgress`** — a decoded (wire) tree cannot
   * declare its own egress, so absent a host's declaration it gets none. Pass
   * `permissiveEgress` for a HAND-AUTHORED tree, where the author is the trust
   * boundary; pass an `allowOrigin`-built policy to declare specific
   * destinations. Naming the permissive policy is deliberate: a grep for
   * `permissive` finds every host that opted back out.
   */
  readonly egressPolicy?: EgressPolicy;
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
  /**
   * The host's tree validator, consulted on the candidate tree of an in-page /
   * relayed `apply` before the edit is folded. See
   * {@link DebugGlobalOptions.validate}.
   */
  readonly validate?: (candidate: Node<TMsg>) => readonly { readonly code: string }[];
  /**
   * When `true` (alongside `debug`), installs the **DevTools relay page peer**:
   * a same-origin `postMessage` endpoint that carries the in-page introspection
   * surface — and, where `onApply` is wired, its gated mutation entry — across
   * the page/extension boundary.
   *
   * **Off by default, and default-off is the point** (relay contract §11.1): a
   * page with no explicit opt-in installs no listener at all, so a probe gets
   * no answer whatsoever. Gate it the way `debug` is gated (`import.meta.env.DEV`)
   * so a production bundle cannot expose it. A dev/debug affordance — never a
   * production feature flag.
   */
  readonly relay?: boolean;
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
      ...(props.validate !== undefined ? { validate: props.validate } : {}),
    };
    const surface = buildDebugGlobal(props.tree, props.sources ?? {}, options);
    // Announce the committed tree. Idempotent on tree identity, so a
    // re-registration caused by `sources` / `runtime` alone is not a change.
    pageChangeHub.commit(props.tree, 'host');
    return registerDebugGlobal(surface);
  }, [props.debug, props.tree, props.sources, props.runtime, props.onApply, props.validate]);

  // The relay peer is installed separately and NOT torn down on every tree
  // change: it holds client subscriptions, and it reads the live surface from
  // the window key each request, so it needs no rebuild when the tree moves.
  useEffect(() => {
    if (props.debug !== true || props.relay !== true) return undefined;
    // The `relay` prop IS the host's opt-in — there is no message in the
    // contract that turns the relay on (§11.1).
    return installRelayPeer(readRegisteredDebugGlobal, { optedIn: true });
  }, [props.debug, props.relay]);

  const ctx: RenderContext<TMsg> = {
    sources: props.sources ?? {},
    runtime: props.runtime ?? {},
    dispatch: props.dispatch ?? noopDispatch,
    fragments: collectFragments(new Map<string, Node<TMsg>>(), props.tree),
    expandingFragments: new Set<string>(),
    inErrorBoundary: false,
    // Phase 1037 — default-deny. A host widens it BY NAME via `egressPolicy`.
    egressPolicy: props.egressPolicy ?? denyNonLocalEgress,
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
