// ============================================================================
//  @fuaran-ui/renderer/context — the RenderContext bundle + action interpreter
//  + fragment collection / namespacing. Ports the F# renderer's RenderContext
//  record, runAction, containsUnwiredAction, collectFragments and namespaceNode.
// ============================================================================

import type {
  Action,
  Binding,
  FileReadEncoding,
  FragmentId,
  JsonValue,
  LayoutKind,
  Node,
  NodeId,
  NodeKind,
} from '@fuaran-ui/schema';

import { type BindingSources, resolve } from './bindings.js';
import {
  type ActionDescriptor,
  describeActionDescriptor,
  type FuaranRuntime,
} from './customRegistry.js';
import { checkDestination, describeEgressVerdict, type EgressPolicy } from './egress.js';

/**
 * Renderer-wide dependencies threaded through every recursive render call.
 * `TMsg` flows through `dispatch`; `sources` + `runtime` are msg-agnostic.
 */
export interface RenderContext<TMsg> {
  readonly sources: BindingSources;
  readonly runtime: FuaranRuntime;
  readonly dispatch: (msg: TMsg) => void;
  /** Phase 61 fragment registry: `FragmentId` → the decl body. */
  readonly fragments: ReadonlyMap<string, Node<TMsg>>;
  /** Phase 61 cycle-guard: ids currently expanding. */
  readonly expandingFragments: ReadonlySet<string>;
  /** Phase 60: true under an active ErrorBoundary child subtree (suspends the per-node guard). */
  readonly inErrorBoundary: boolean;
  /**
   * Phase 1037 — the AMBIENT destination policy (WIRE_FORMAT §14.1). Every
   * emission site that reaches a destination — a `Link` href, an `Image` src, a
   * DataGrid link column, an `Action.Navigate` route, the markdown body —
   * consults THIS field rather than a per-call argument, so a host cannot get
   * the policy by forgetting to pass one.
   *
   * **The default is `denyNonLocalEgress` at every convenience entry point**:
   * an emission cannot declare its own egress, so absent a host's declaration
   * it gets none. `permissiveEgress` is reached BY NAME, so a grep for
   * `permissive` finds every host that has opted back out — the permissive
   * choice is visible in the host's own source instead of inherited silently.
   *
   * Two consequences a host meets on adoption, both deliberate. A `mailto:` /
   * `tel:` href is REFUSED under the default (`allowNonNetwork: false`): those
   * are egress channels with no host for a rule to name, so they can only be
   * permitted wholesale, and permitting them by omission is the failure this
   * default exists to prevent. And same-origin destinations are ALLOWED
   * (`allowLocal: true`), so ordinary in-app links and assets render unchanged
   * — the default denies leaving, not linking.
   *
   * A refused destination RENDERS as a refusal (`egressRefusalUrl` +
   * `egressRefusalAttribute`), never as a silent neuter: "nothing happened" and
   * "this was refused" are different facts, and only one of them is debuggable.
   */
  readonly egressPolicy: EgressPolicy;
}

// ─── Unwired-action detection (UX hint only) ─────────────────────────────────

/** True when any branch of an action reaches a substrate-routed kind. */
export const containsUnwiredAction = <TMsg>(action: Action<TMsg>): boolean => {
  switch (action.kind) {
    case 'Dispatch':
    case 'CommitLocal':
    case 'WriteToClipboard':
    case 'ReadFileBody':
      return false;
    case 'Chain':
      return action.actions.some(containsUnwiredAction);
    case 'Call':
    case 'Notify':
    case 'Navigate':
    case 'SetState':
    case 'AiTool':
    case 'Invoke':
      return true;
  }
};

// ─── Action interpretation ───────────────────────────────────────────────────

const warn = (ctx: RenderContext<unknown>, message: string): void => {
  if (ctx.runtime.warn) ctx.runtime.warn(message);
  // No fallback console noise — an unwired port is a host choice.
};

/**
 * Phase 159 — consult the optional `canDispatch` policy gate before a gated
 * effect runs. The TS mirror of the F# `applyDispatchGate` (Phase 119): an
 * absent gate allows (the effect runs); a gate returning `false` denies — emit
 * a diagnostic via `warn` and skip the effect. Only the gated action set
 * (`Call` / `Navigate` / `AiTool` / `ReadFileBody`) is routed through here.
 */
const applyDispatchGate = <TMsg>(
  ctx: RenderContext<TMsg>,
  descriptor: ActionDescriptor,
  effect: () => void,
): void => {
  if (ctx.runtime.canDispatch && !ctx.runtime.canDispatch(descriptor)) {
    warn(
      ctx as RenderContext<unknown>,
      `dispatch denied by policy gate: ${describeActionDescriptor(descriptor)}`,
    );
    return;
  }
  effect();
};

/**
 * Phase 1037 — consult the ambient destination policy for a route before any
 * navigation happens. Exported so a host (and this package's tests) can pin the
 * decision without a browser render; the TS port of the F#
 * `Render.treeNavigateOutcome`.
 *
 * Returns `undefined` when the route was allowed and `navigate` ran with the
 * SANITISED route, or the log-safe refusal reason when it did not. The reason
 * names the class and — where there is one — the host, never the path or query,
 * which is exactly where an exfiltrated payload would be sitting. The `warn`
 * may carry the raw route because a diagnostic a developer reads in their own
 * console is a different surface from a record that outlives the session.
 */
export const treeNavigate = <TMsg>(
  ctx: RenderContext<TMsg>,
  route: string,
  navigate: (safeRoute: string) => void,
): string | undefined => {
  const verdict = checkDestination(ctx.egressPolicy, 'route', route);
  if (verdict.kind === 'allowed') {
    navigate(verdict.url);
    return undefined;
  }
  const reason = describeEgressVerdict(verdict);
  warn(ctx as RenderContext<unknown>, `Action.Navigate refused — ${reason}: ${route}`);
  return reason;
};

/** Interpret an action: Dispatch/Chain/CommitLocal are native; the rest route through the runtime. */
export const runAction = <TMsg>(ctx: RenderContext<TMsg>, action: Action<TMsg>): void => {
  switch (action.kind) {
    case 'Dispatch':
      ctx.dispatch(action.msg);
      return;
    case 'Chain':
      for (const a of action.actions) runAction(ctx, a);
      return;
    case 'Call':
      // Phase 428: a present `onResult` closure wins (exactly the pre-428
      // behaviour); the declarative `into` target writes the response to the
      // host state / query seam. Both absent is a fire-and-forget command
      // call. A failed call never reaches the callback — the host's `call`
      // implementation surfaces it and the target slot stays unwritten, so
      // readers keep their loading surface rather than a silent wrong value.
      applyDispatchGate(ctx, { kind: 'Call', endpoint: action.endpoint }, () => {
        if (!ctx.runtime.call) {
          warn(
            ctx as RenderContext<unknown>,
            `Action.Call to '${action.endpoint}' — no runtime.call wired.`,
          );
          return;
        }
        const onResult = action.onResult;
        const into = action.into;
        if (onResult !== undefined) {
          ctx.runtime.call(action.endpoint, (raw) => ctx.dispatch(onResult(raw)));
        } else if (into !== undefined) {
          ctx.runtime.call(action.endpoint, (raw) => {
            if (into.kind === 'State') {
              if (ctx.runtime.setState) ctx.runtime.setState(into.key, raw as JsonValue);
              else
                warn(
                  ctx as RenderContext<unknown>,
                  `Call into $state.${into.key} — no runtime.setState wired.`,
                );
            } else if (ctx.runtime.setQueryResult) {
              ctx.runtime.setQueryResult(into.name, raw as JsonValue);
            } else {
              warn(
                ctx as RenderContext<unknown>,
                `Call into query '${into.name}' — no runtime.setQueryResult wired.`,
              );
            }
          });
        } else {
          ctx.runtime.call(action.endpoint, () => {});
        }
      });
      return;
    case 'Notify':
      if (ctx.runtime.notify) ctx.runtime.notify(action.channel, action.payload);
      else
        warn(
          ctx as RenderContext<unknown>,
          `Action.Notify on '${action.channel}' — no runtime.notify wired.`,
        );
      return;
    case 'Navigate':
      // Phase 1037 — the ambient destination policy runs BEFORE the dispatch
      // gate, in the `Route` class. A refusal performs NO navigation at all and
      // warns: unlike an `href`, where the anchor must stay structurally valid,
      // a navigation the author never asked for is not an improvement on a
      // refused one. Port of the F# `treeNavigateOutcome`.
      treeNavigate(ctx, action.route, (safe) => {
        applyDispatchGate(ctx, { kind: 'Navigate', route: safe }, () => {
          if (ctx.runtime.navigate) ctx.runtime.navigate(safe);
          else
            warn(
              ctx as RenderContext<unknown>,
              `Action.Navigate to '${safe}' — no runtime.navigate wired.`,
            );
        });
      });
      return;
    case 'SetState': {
      // Phase 818 — `valueFrom` (value XOR valueFrom, decode-enforced)
      // evaluates AT DISPATCH TIME against the render pass's sources. An
      // unresolved / errored source performs NO write and warns — a derived
      // write must never silently write a wrong value.
      let payload: JsonValue | undefined = action.value;
      if (action.valueFrom !== undefined) {
        const r = resolve<JsonValue>(ctx.sources, action.valueFrom);
        if (r.kind === 'Resolved') {
          payload = r.value;
        } else {
          const why =
            r.kind === 'NotResolved'
              ? 'did not resolve'
              : r.kind === 'Errored'
                ? `errored: ${r.message}`
                : `is an unresolved i18n key '${r.key}'`;
          warn(
            ctx as RenderContext<unknown>,
            `Action.SetState '${action.key}' valueFrom ${why} — no write performed.`,
          );
          return;
        }
      }
      if (payload === undefined) return;
      if (ctx.runtime.setState) ctx.runtime.setState(action.key, payload);
      else
        warn(
          ctx as RenderContext<unknown>,
          `Action.SetState '${action.key}' — no runtime.setState wired.`,
        );
      return;
    }
    case 'AiTool':
      applyDispatchGate(ctx, { kind: 'AiTool', toolName: action.toolName }, () => {
        if (ctx.runtime.invokeAiTool) ctx.runtime.invokeAiTool(action.toolName, action.args);
        else
          warn(
            ctx as RenderContext<unknown>,
            `Action.AiTool '${action.toolName}' — no runtime.invokeAiTool wired.`,
          );
      });
      return;
    case 'CommitLocal':
      // Dispatch a DOM CustomEvent the Local-bound input's effect listener drains.
      if (typeof window !== 'undefined' && typeof window.dispatchEvent === 'function') {
        window.dispatchEvent(new CustomEvent(`fuaran-commit-local-${action.nodeId}`));
      }
      return;
    case 'WriteToClipboard':
      if (ctx.runtime.writeToClipboard) ctx.runtime.writeToClipboard(action.text);
      else if (typeof navigator !== 'undefined' && navigator.clipboard) {
        void navigator.clipboard.writeText(action.text);
      }
      return;
    case 'ReadFileBody': {
      // Phase 136. Prefer the wired runtime port; otherwise fall back to a
      // browser FileReader read of file.handle. onRead fires from the async
      // callback (the typed dispatch surface stays callback-shaped). Phase 159:
      // gated — a denied read runs neither the port nor the FileReader fallback.
      applyDispatchGate(ctx, { kind: 'ReadFileBody', fileId: action.file.id }, () => {
        const dispatchBody = (body: string): void => ctx.dispatch(action.onRead(body));
        if (ctx.runtime.readFileBody) {
          ctx.runtime.readFileBody(action.file, action.encoding, dispatchBody);
        } else {
          readFileBlob(action.file.handle, action.encoding, dispatchBody, (m) =>
            warn(ctx as RenderContext<unknown>, m),
          );
        }
      });
      return;
    }
    case 'Invoke':
      // Phase 283/284 — dispatch a host-registered capability as an effect.
      // Default-deny by shape (FGP 3): gate before dispatch, reusing the `AiTool`
      // descriptor (the closest gate surface for a named host invocation, as in
      // the F# `runAction` Invoke arm). When wired, the host seam dispatches +
      // journals Phase-27 replay; when absent, warn rather than silently drop.
      applyDispatchGate(ctx, { kind: 'AiTool', toolName: action.capabilityId }, () => {
        if (ctx.runtime.invokeCapability)
          ctx.runtime.invokeCapability(action.capabilityId, action.args);
        else
          warn(
            ctx as RenderContext<unknown>,
            `Action.Invoke '${action.capabilityId}' — no runtime.invokeCapability wired.`,
          );
      });
      return;
  }
};

/**
 * Phase 426 — the control write-back default. When a covered control's event
 * handler is omitted (the declarative / AI-authored shape), the renderer
 * writes the changed value back to the control's own value binding — but ONLY
 * when that binding is directly a writable store binding: `State` (→ the host
 * state seam, `runtime.setState`) or `Filter` (→ the Phase 423 filter seam,
 * `runtime.setFilter`). Any other shape means no write (the FUARAN069
 * inert-control condition — a validate-time warning, not a render-time one).
 * `undefined` (a cleared choice) clears the slot: the filter seam's documented
 * `undefined`-clears contract, and `null` on the state seam (whose payload is
 * a `JsonValue`), so readers fall back to their binding default either way.
 * A present handler dispatches through `runAction` and never touches a seam.
 */
export const writeBackTo = <TMsg>(
  ctx: RenderContext<TMsg>,
  // Structurally-minimal view of `Binding<T>` (only the discriminator + the
  // State key / Filter name are read) — `Binding<T>` itself is invariant in
  // `T` through the Local case's `onCommit`, so a typed `Binding<string>`
  // would not assign to `Binding<unknown>`.
  binding: { readonly kind: string; readonly key?: string; readonly name?: string },
  value: JsonValue | undefined,
): void => {
  if (binding.kind === 'State' && binding.key !== undefined) {
    if (ctx.runtime.setState) ctx.runtime.setState(binding.key, value ?? null);
    else
      warn(
        ctx as RenderContext<unknown>,
        `write-back to $state.${binding.key} — no runtime.setState wired.`,
      );
  } else if (binding.kind === 'Filter' && binding.name !== undefined) {
    if (ctx.runtime.setFilter) ctx.runtime.setFilter(binding.name, value);
    else
      warn(
        ctx as RenderContext<unknown>,
        `write-back to $filters.${binding.name} — no runtime.setFilter wired.`,
      );
  }
};

/**
 * Browser FileReader fallback for `Action.ReadFileBody` when no `readFileBody`
 * runtime port is wired (Phase 136). Reads `handle` (the browser `File`) per
 * the requested encoding and invokes `cb` from the load callback; warns and
 * never calls back when there is no blob / FileReader available.
 */
const readFileBlob = (
  handle: unknown,
  encoding: FileReadEncoding,
  cb: (body: string) => void,
  onWarn: (message: string) => void,
): void => {
  if (typeof FileReader === 'undefined' || !(handle instanceof Blob)) {
    onWarn(
      'Action.ReadFileBody — no browser File blob / FileReader available; onRead will not fire.',
    );
    return;
  }
  const reader = new FileReader();
  reader.onload = () => {
    const res = reader.result == null ? '' : String(reader.result);
    if (encoding === 'Base64') {
      const i = res.indexOf(',');
      cb(i >= 0 ? res.slice(i + 1) : res);
    } else {
      cb(res);
    }
  };
  reader.onerror = () => onWarn('Action.ReadFileBody — FileReader error.');
  if (encoding === 'Text') reader.readAsText(handle);
  else reader.readAsDataURL(handle);
};

// ─── Fragment collection + namespacing (Phase 61) ────────────────────────────

const layoutChildren = <TMsg>(layout: LayoutKind<TMsg>): readonly Node<TMsg>[] =>
  layout.spec.children;

/** One-shot pre-render walk collecting every reachable FragmentDecl body. */
export const collectFragments = <TMsg>(
  acc: Map<string, Node<TMsg>>,
  node: Node<TMsg>,
): Map<string, Node<TMsg>> => {
  const kind = node.kind;
  switch (kind.kind) {
    case 'FragmentDecl':
      acc.set(kind.spec.name, kind.spec.body);
      return collectFragments(acc, kind.spec.body);
    case 'Layout':
      for (const child of layoutChildren(kind.layout)) collectFragments(acc, child);
      return acc;
    case 'ErrorBoundary':
      collectFragments(acc, kind.spec.child);
      collectFragments(acc, kind.spec.fallback);
      return acc;
    case 'Switch':
      for (const c of kind.spec.cases) collectFragments(acc, c.child);
      collectFragments(acc, kind.spec.default);
      return acc;
    default:
      return acc;
  }
};

/** Rewrite every interior NodeId of a fragment body by prepending `prefix`. */
export const namespaceNode = <TMsg>(prefix: string, node: Node<TMsg>): Node<TMsg> => ({
  ...node,
  id: (prefix + node.id) as NodeId,
  kind: namespaceKind(prefix, node.kind),
});

const namespaceKind = <TMsg>(prefix: string, kind: NodeKind<TMsg>): NodeKind<TMsg> => {
  switch (kind.kind) {
    case 'Layout': {
      const layout = kind.layout;
      const newSpec = {
        ...layout.spec,
        children: layout.spec.children.map((c) => namespaceNode(prefix, c)),
      };
      return { kind: 'Layout', layout: { ...layout, spec: newSpec } as LayoutKind<TMsg> };
    }
    case 'ErrorBoundary':
      return {
        kind: 'ErrorBoundary',
        spec: {
          child: namespaceNode(prefix, kind.spec.child),
          fallback: namespaceNode(prefix, kind.spec.fallback),
        },
      };
    case 'Switch':
      return {
        kind: 'Switch',
        spec: {
          ...kind.spec,
          cases: kind.spec.cases.map((c) => ({
            match: c.match,
            child: namespaceNode(prefix, c.child),
          })),
          default: namespaceNode(prefix, kind.spec.default),
        },
      };
    case 'FragmentDecl':
      return {
        kind: 'FragmentDecl',
        spec: { ...kind.spec, body: namespaceNode(prefix, kind.spec.body) },
      };
    default:
      return kind;
  }
};

/** The FragmentId-keyed string for a fragment name (the brand is structurally a string). */
export const fragmentKey = (name: FragmentId): string => name;
