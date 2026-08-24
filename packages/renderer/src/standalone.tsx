// @fuaran-ui/renderer — the standalone browser bundle entry.
//
// A self-contained build (React + the renderer + the canonical decoder in one
// file) exposing a minimal global mount API, for hosts with NO Node toolchain:
// drop the script tag in, hand it canonical wire JSON, and the tree renders.
// This is what the .NET `Fuaran.UI.Renderer.Web` package embeds as a static web
// asset — the precedent is Swashbuckle embedding swagger-ui.
//
// The API is deliberately tiny and framework-free, because the consumer is not
// assumed to have React: a mount handle with `update` / `unmount`, and a
// `dispatch` callback so interaction still reaches the host.

import { createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { apply, decodeNode, decodeOp, type TreeOp } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { FuaranRenderer } from './Renderer.js';
import type { BindingSources } from './bindings.js';
import type { FuaranRuntime } from './customRegistry.js';
import type { EgressPolicy } from './egress.js';

/** The bundle's own stamp. Served by the .NET package's fingerprint endpoint and
 *  compared against the authoring package's wire profile, so a drifted embedded
 *  copy is caught rather than silently rendering the wrong vocabulary. */
export const BUNDLE_VERSION = '0.1.0';

/** The wire profile this bundle decodes. A host whose authoring package targets
 *  a different profile is mismatched — see the .NET tag helper's dev warning. */
export const WIRE_PROFILE = '1';

/** Options for {@link mount}. Every field is optional. */
export interface MountOptions<TMsg = unknown> {
  /** Called when the rendered UI dispatches a message.
   *
   *  NOTE: a wire-decoded `Dispatch` carries the `"<closure>"` sentinel, because
   *  `Dispatch` holds a host closure that cannot be serialised. Treat this as a
   *  diagnostic signal. For a real message from a wire tree, use
   *  {@link MountOptions.onNotify}. */
  readonly dispatch?: (msg: TMsg) => void;
  /** Called when the rendered UI raises a `Notify(channel, payload)` — the
   *  wire-representable message action.
   *
   *  This is the cross-host interaction path. A typed host (F#) authors a typed
   *  message that lowers onto a channel + JSON payload; this callback is where it
   *  arrives. An untyped host handles the pair directly: same functionality,
   *  without the typing its language cannot express. Post it back to your server
   *  and the typed host lifts it to its own message type again. */
  readonly onNotify?: (channel: string, payload: unknown) => void;
  /** Binding sources (query results, state, filters) the tree resolves against. */
  readonly sources?: BindingSources;
  /** Host runtime — the default-deny dispatch gate, custom renderers, warnings. */
  readonly runtime?: FuaranRuntime;
  /** Called when the wire JSON cannot be decoded, instead of throwing. */
  readonly onError?: (message: string) => void;
  /**
   * Phase 1037 — the ambient destination policy (WIRE_FORMAT §14.1). OMITTING
   * IT MEANS `denyNonLocalEgress`, and that default matters most here: this
   * entry point exists to render canonical wire JSON, which is precisely the
   * case where the tree cannot be trusted to declare its own egress. A host
   * that knows its own trust boundary passes `permissiveEgress` or an
   * `allowOrigin`-built declaration by name.
   */
  readonly egressPolicy?: EgressPolicy;
}

/** A live mount. Keep it to update or tear down the rendered tree. */
export interface MountHandle<TMsg = unknown> {
  /** Re-render from a new tree — either canonical wire JSON or a decoded node. */
  readonly update: (treeOrJson: string | Node<TMsg>) => void;
  /** Apply canonical `TreeOp` JSON (one op or an array) to the mounted tree —
   *  the cheap-diff path, so a host need not resend the whole tree. */
  readonly applyOps: (opsJson: string) => void;
  /** The tree currently rendered. */
  readonly current: () => Node<TMsg> | undefined;
  /** Unmount and release the React root. */
  readonly unmount: () => void;
}

function decodeTree<TMsg>(
  json: string,
): { ok: true; tree: Node<TMsg> } | { ok: false; error: string } {
  const decoded = decodeNode(json);
  return decoded.ok
    ? { ok: true, tree: decoded.value as Node<TMsg> }
    : {
        ok: false,
        error: `${decoded.error.code} at ${decoded.error.path}: ${decoded.error.message}`,
      };
}

function parseOps<TMsg>(
  opsJson: string,
): { ok: true; ops: TreeOp<TMsg>[] } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(opsJson);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  // Accept a single op or an array, so a host can send either.
  const entries: unknown[] = Array.isArray(raw) ? raw : [raw];
  const ops: TreeOp<TMsg>[] = [];
  for (const entry of entries) {
    const decoded = decodeOp(JSON.stringify(entry));
    if (!decoded.ok) {
      return {
        ok: false,
        error: `${decoded.error.code} at ${decoded.error.path}: ${decoded.error.message}`,
      };
    }
    ops.push(decoded.value as TreeOp<TMsg>);
  }
  return { ok: true, ops };
}

/**
 * Render canonical wire JSON into `el`. The single entry point the embedded
 * bundle exposes.
 *
 * ```html
 * <div id="app"></div>
 * <script src="/_fuaran/fuaran-renderer.js"></script>
 * <script>
 *   const handle = FuaranRenderer.mount(document.getElementById('app'), treeJson, {
 *     dispatch: (msg) => fetch('/dispatch', { method: 'POST', body: JSON.stringify(msg) }),
 *   });
 * </script>
 * ```
 */
export function mount<TMsg = unknown>(
  el: Element,
  treeOrJson: string | Node<TMsg>,
  options?: MountOptions<TMsg>,
): MountHandle<TMsg> {
  const root: Root = createRoot(el);
  let currentTree: Node<TMsg> | undefined;

  const fail = (message: string): void => {
    if (options?.onError !== undefined) {
      options.onError(message);
      return;
    }
    // No handler: surface it in the DOM rather than failing silently, so a
    // developer sees the decode diagnostic without opening the console.
    el.textContent = `Fuaran: ${message}`;
  };

  // `Notify` is routed through the runtime seam, so `onNotify` is folded into
  // whatever runtime the host supplied rather than replacing it. A host that
  // wires its own `runtime.notify` keeps it; `onNotify` is the convenience for a
  // consumer who should not need to know the runtime's shape at all.
  const runtime: FuaranRuntime | undefined =
    options?.onNotify !== undefined
      ? {
          ...options.runtime,
          notify: (channel: string, payload: unknown) => {
            options.runtime?.notify?.(channel, payload as never);
            options.onNotify?.(channel, payload);
          },
        }
      : options?.runtime;

  const render = (tree: Node<TMsg>): void => {
    currentTree = tree;
    root.render(
      createElement(FuaranRenderer<TMsg>, {
        tree,
        ...(options?.dispatch !== undefined ? { dispatch: options.dispatch } : {}),
        ...(options?.sources !== undefined ? { sources: options.sources } : {}),
        ...(runtime !== undefined ? { runtime } : {}),
        // Absent, `<FuaranRenderer>` defaults to `denyNonLocalEgress`.
        ...(options?.egressPolicy !== undefined ? { egressPolicy: options.egressPolicy } : {}),
      }),
    );
  };

  const update = (next: string | Node<TMsg>): void => {
    if (typeof next !== 'string') {
      render(next);
      return;
    }
    const decoded = decodeTree<TMsg>(next);
    if (decoded.ok) render(decoded.tree);
    else fail(decoded.error);
  };

  update(treeOrJson);

  return {
    update,
    applyOps: (opsJson: string): void => {
      if (currentTree === undefined) {
        fail('no tree is mounted');
        return;
      }
      const parsed = parseOps<TMsg>(opsJson);
      if (!parsed.ok) {
        fail(parsed.error);
        return;
      }
      // Fold the ops in order; the first rejection stops the batch and leaves
      // the mounted tree untouched, so a bad op never half-applies.
      let next: Node<TMsg> = currentTree;
      for (const op of parsed.ops) {
        const applied = apply(next, op);
        if (!applied.ok) {
          fail(applied.error.message);
          return;
        }
        next = applied.value.newTree;
      }
      render(next);
    },
    current: () => currentTree,
    unmount: () => root.unmount(),
  };
}
