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

import {
  type CSSProperties,
  type ReactElement,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';

import type { HashStrictness, Node } from '@fuaran-ui/schema';

// Phase 1075 — the `Binding.State` seeding pass. One definition, shared with
// the server renderer, so the two tiers cannot drift on the charter's §4/§5.
import { type BehindView, withStateSeeds } from '@fuaran-ui/ops';

import type { BindingSources } from './bindings.js';
import type { GridDragCell, RenderContext } from './context.js';
import { collectFragments } from './context.js';
import { customHashFloorOf } from './customHash.js';
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
   * Phase 1021 — the host's `NodeKind.Custom` content-hash floor. A tree's own
   * declared strictness may raise it, never lower it. Under an enforcing floor
   * (`'Enforced'` / `'StrictReplay'`) a `Custom` node whose declared hash
   * MISMATCHES the registered renderer's is refused rather than rendered, and so
   * is one declaring a hash the registry recorded none for; `'StrictReplay'`
   * additionally refuses a node declaring no hash at all.
   *
   * **Omitting it means `'Enforced'` since Phase 1856** (the reference host's
   * Phase 1550 default): an unconfigured renderer refuses a mismatch, and a
   * `Custom` node with no hash — the common legitimate case — still renders.
   * `customHashFloor="AdvisoryWarning"` is the named opt-back: a mismatch warns
   * and renders, the pre-1856 default, with the warning intact.
   */
  readonly customHashFloor?: HashStrictness;
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
  /**
   * The reference host's wiring introspection DTO for `tree` (alongside
   * `debug`), served by `window.__fuaran.getWiring()` / `describeWiring()`.
   * See {@link DebugGlobalOptions.wiring}; omitted, both say no DTO was given.
   */
  readonly wiring?: unknown;
}

const noopDispatch = (): void => {};

/** No fragment is expanding at the root; one shared, never-mutated set. */
const noExpandingFragments: ReadonlySet<string> = new Set<string>();

const noSources: BindingSources = {};

const noRuntime: FuaranRuntime = {};

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
      // What `hatches()` reports on (Phase 1842): the registry this renderer
      // resolves `Custom` nodes against (`null` — none, so no guest is
      // reachable) and the floor in force, the default included. The renderer
      // KNOWS both, so it hands both over rather than leaving them undecided.
      customRenderers: props.runtime?.registry ?? null,
      customHashFloor: customHashFloorOf(props),
      // Phase 1844 — the wiring DTO is the host's to supply; read per call.
      ...(props.wiring !== undefined ? { wiring: () => props.wiring } : {}),
    };
    const surface = buildDebugGlobal(props.tree, props.sources ?? {}, options);
    // Announce the committed tree. Idempotent on tree identity, so a
    // re-registration caused by `sources` / `runtime` alone is not a change.
    pageChangeHub.commit(props.tree, 'host');
    return registerDebugGlobal(surface);
  }, [
    props.debug,
    props.tree,
    props.sources,
    props.runtime,
    props.onApply,
    props.validate,
    props.customHashFloor,
    props.wiring,
  ]);

  // The relay peer is installed separately and NOT torn down on every tree
  // change: it holds client subscriptions, and it reads the live surface from
  // the window key each request, so it needs no rebuild when the tree moves.
  useEffect(() => {
    if (props.debug !== true || props.relay !== true) return undefined;
    // The `relay` prop IS the host's opt-in — there is no message in the
    // contract that turns the relay on (§11.1).
    return installRelayPeer(readRegisteredDebugGlobal, { optedIn: true });
  }, [props.debug, props.relay]);

  // Phase 2074 — everything the context is built from is memoised on its own
  // inputs, so a render caused by one state change hands every node the same
  // context but for `sources.state`, and the node memo boundary (render/core)
  // can skip each node that did not read the changed key.

  // Phase 1075 — the tree's `Binding.State` declarations are laid UNDER the
  // host's own sources: a grid bound to `$state.members` and a `Transform`
  // deriving over the same key read the same rows. The host's map wins on
  // every key it names (charter §4). The seed walk itself is cached per tree.
  const hostSources = props.sources ?? noSources;
  const sources = useMemo(() => withStateSeeds(props.tree, hostSources), [props.tree, hostSources]);
  const fragments = useMemo(
    () => collectFragments(new Map<string, Node<TMsg>>(), props.tree),
    [props.tree],
  );

  // `dispatch` is only ever CALLED, never rendered from, so the context carries
  // one stable forwarder to the latest prop: a host passing an inline arrow
  // does not thereby re-render every node on every render.
  const dispatchRef = useRef(props.dispatch);
  dispatchRef.current = props.dispatch;
  const dispatch = useCallback((msg: TMsg) => (dispatchRef.current ?? noopDispatch)(msg), []);

  // Phase 2074 — the in-flight grid drag belongs to THIS renderer, so two
  // renderers on one page cannot consume each other's drags.
  const gridDrag = useRef<GridDragCell['current']>(undefined) as GridDragCell;

  const runtime = props.runtime;
  // Phase 1037 — default-deny. A host widens it BY NAME via `egressPolicy`.
  const egressPolicy = props.egressPolicy ?? denyNonLocalEgress;
  const customHashFloor = props.customHashFloor;
  const ctx = useMemo<RenderContext<TMsg>>(
    () => ({
      sources,
      runtime: runtime ?? noRuntime,
      dispatch,
      fragments,
      expandingFragments: noExpandingFragments,
      inErrorBoundary: false,
      egressPolicy,
      // Phase 1021 / 1856 — absent means the shipped ENFORCING default floor.
      // `exactOptionalPropertyTypes`: omit rather than pass an explicit `undefined`.
      ...(customHashFloor !== undefined ? { customHashFloor } : {}),
      gridDrag,
    }),
    [sources, runtime, dispatch, fragments, egressPolicy, customHashFloor, gridDrag],
  );

  const rendered = renderNode(ctx, props.tree);

  const theme = props.theme;
  const style = useMemo(
    () => (theme === undefined ? undefined : (themeToStyle(theme) as CSSProperties)),
    [theme],
  );
  if (style !== undefined) {
    return (
      <div className="fuaran-root" style={style}>
        {rendered}
      </div>
    );
  }

  return rendered;
}

/**
 * Phase 1812 — the BEHIND reader's renderer (WIRE_FORMAT.md §15.3). Given the
 * view `behindView` in `@fuaran-ui/ops` decided — the node itself, the
 * author-declared `fallback` lifted out of a transport-only `Unknown`, or the
 * labelled placeholder — renders a `Rendered` view through `<FuaranRenderer>`
 * exactly as any tree, and a `Placeholder` as the degrade the section has
 * always specified ("needs `core@1.4`", else the unknown kind by name), with
 * the same class and data attributes the server emits.
 */
export function FuaranBehindRenderer<TMsg>(
  props: Omit<FuaranRendererProps<TMsg>, 'tree'> & { readonly view: BehindView<TMsg> },
): ReactElement {
  const { view, ...rest } = props;
  if (view.kind === 'Rendered') return <FuaranRenderer {...rest} tree={view.node} />;
  const label =
    view.requiredProfile !== undefined
      ? `needs ${view.requiredProfile}`
      : `unknown kind ${view.unknownKind}`;
  return (
    <div
      className="fuaran-unknown-placeholder"
      data-fuaran-kind={view.unknownKind}
      {...(view.requiredProfile !== undefined
        ? { 'data-fuaran-requires': view.requiredProfile }
        : {})}
    >
      {label}
    </div>
  );
}
