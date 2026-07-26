// ============================================================================
//  @fuaran-ui/renderer/debugGlobal — the in-page introspection REPL global.
//
//  When `<FuaranRenderer debug>` is set, the renderer registers a single
//  guarded global — `window.__fuaran` — that exposes the running UI's *typed
//  layer* to the browser DevTools console. A developer (or an attached human
//  debugging a live Fuaran app) types `__fuaran.getNodeState("submit-btn")`
//  and receives the typed snapshot — the node's kind, its bound binding slots
//  with resolved values, and its real DOM geometry — not the untyped,
//  post-projection DOM node the browser console would otherwise hand back.
//
//  This is the TS half of the in-page introspection REPL — a thin wrapper over
//  the already-shipped @fuaran-ui/ai-tools introspection surface plus the
//  renderer's own binding resolver. The global is registered only when the host
//  opts in (`debug` prop / `import.meta.env.DEV`); it is `undefined` otherwise.
//  Its shape is explicitly DEBUG-ONLY / UNSTABLE and excluded from semver.
//
//  FGP 4 (diagnostics discipline): this module emits no console output of its
//  own — `help()` returns a string for the *caller* to print, and every method
//  returns a value. The only console interaction is the developer typing a
//  `__fuaran.*` call; nothing here writes to `console.*`.
// ============================================================================

import { apply, decodeOp, type TreeOp } from '@fuaran-ui/ops';
import type { Node, NodeKind } from '@fuaran-ui/schema';
import type { DenyTelemetry, FuaranTelemetrySink } from '@fuaran-ui/telemetry';
import {
  bindingForSlot,
  findNode,
  findNodes,
  getNodeState as introspectNodeState,
  inspectTree as introspectTree,
  kindName,
  type NodeIntrospection,
  type TreeIntrospection,
} from '@fuaran-ui/ai-tools';

import { type BindingSources, resolve, type Resolution } from './bindings.js';
import {
  type ActionDescriptor,
  describeActionDescriptor,
  type FuaranRuntime,
} from './customRegistry.js';

/** The window key the debug global is registered under. */
export const DEBUG_GLOBAL_KEY = '__fuaran';

/** Schema version of the `window.__fuaran` shape (independent of package semver). */
export const DEBUG_GLOBAL_VERSION = '0.1.0';

/** A structured error envelope returned in place of a result. */
export interface DebugError {
  readonly error: string;
}

/**
 * The structured outcome of `window.__fuaran.apply(opJson)` — a policy-gated
 * `TreeOp` mutation. Byte-parity with the F# `DebugGlobal.applyEnvelope` POJO
 * shape so a console session is host-agnostic: a denied op returns the deny
 * envelope (the tree is unchanged), never a silent no-op (FGP 3).
 */
export type ApplyEnvelope =
  | { readonly ok: true; readonly status: 'applied' }
  | { readonly ok: false; readonly status: 'unwired'; readonly error: string }
  | { readonly ok: false; readonly status: 'denied'; readonly denied: true; readonly error: string }
  | { readonly ok: false; readonly status: 'decodeFailed'; readonly error: string }
  | { readonly ok: false; readonly status: 'rejected'; readonly error: string };

/**
 * Host wiring for the policy-gated `apply` entry. The renderer owns neither the
 * gate nor the host's tree state, so the host supplies both: `runtime` carries
 * the `canDispatch` default-deny gate (an absent gate allows — matching every
 * other dispatch path); `applyHandler` is the host's "re-render with this tree"
 * callback (typically a React `setState`). A host that omits `applyHandler` is
 * read-only — `apply` returns the `unwired` envelope. Mirrors the F# `register`
 * `runtime` + `ApplyHandler option`.
 */
export interface DebugGlobalOptions<TMsg> {
  readonly runtime?: FuaranRuntime;
  readonly applyHandler?: (newTree: Node<TMsg>) => void;
  /** Durable-sink wiring for the in-page apply path (Phase 193). Optional and
   *  off by default, so omitting it reproduces the historical warn-only
   *  behaviour exactly. */
  readonly sinks?: DebugSinks;
}

/** Where a console-driven apply's outcomes go.
 *
 *  `window.__fuaran.apply` is a THIRD dispatch path (it joins AI-tool dispatch
 *  and the fast path). For the op stream to stay the source of truth, a
 *  console-driven mutation must be as answerable as any other: every permitted
 *  op journals, every denial records. Otherwise the console is an unrecorded
 *  side channel — "what did that session do?" has no answer.
 *
 *  Parity-locked with the F# `DebugGlobal.DebugSinks`. */
export interface DebugSinks {
  /** Where a DENIED apply is recorded. The deny envelope returned to the caller
   *  and this record are the same event on two surfaces. */
  readonly telemetrySink?: FuaranTelemetrySink;
  /** Where a PERMITTED apply's op JSON is handed for journalling. The host
   *  wires this to its op-stream sink — see `@fuaran-ui/op-stream`. The debug
   *  global does not journal directly, so hash-chaining stays in the one place
   *  that owns it. */
  readonly onApplied?: (opJson: string) => void;
  /** Audit subject recorded on the deny record. A console-driven mutation is
   *  operator-initiated, so hosts that do not model a user can omit it. */
  readonly userId?: string;
}

/** The stable tool name the in-page apply path records denials under — a
 *  dedicated name (not a real AI tool) so a console-driven denial is
 *  distinguishable from a model-driven one. Parity-locked with F#
 *  `DebugGlobal.ApplyToolName`. */
export const APPLY_TOOL_NAME = '__fuaran.apply';

/** Build the deny record for a rejected in-page apply. Pure, so the emitted
 *  shape is pinned by a test and stays parity-locked with the F# mirror.
 *  `activeModule` / `activePage` / `promptId` are omitted: an operator-initiated
 *  mutation belongs to no module, page, or prompt. */
export function denyTelemetry(userId: string, occurredAt: string, reason: string): DenyTelemetry {
  return { toolName: APPLY_TOOL_NAME, reason, userId, timestamp: occurredAt };
}

/** Resolved geometry for a node, read from its live `[data-fuaran-node-id]` element. */
export interface NodeGeometry {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Content overflows the node's box (scroll size exceeds client size). */
  readonly overflowing: boolean;
  /** The node renders but is visually hidden (display:none / visibility:hidden / zero-box). */
  readonly hidden: boolean;
}

/**
 * The `window.__fuaran` surface — the §4i introspection entry points as plain
 * JS-callable functions over the currently-rendered tree, a single policy-gated
 * `apply(opJson)` mutation, plus `help()`. Each returns either a result or a
 * {@link DebugError} / {@link ApplyEnvelope} (never throws, never a silent
 * no-op).
 */
export interface FuaranDebugGlobal {
  readonly version: string;
  /** The typed snapshot (kind + binding slots + child ids) for a node by id. */
  getNodeState(nodeId: string): NodeIntrospection | DebugError;
  /** The resolved value of a single binding-typed slot against the live sources. */
  getBindingValue(nodeId: string, slot: string): Resolution<unknown> | DebugError;
  /** The live DOM geometry for a node, read from its rendered element. */
  getRenderedDom(nodeId: string): NodeGeometry | DebugError;
  /** A recursive structural snapshot of the whole rendered tree. */
  inspectTree(): TreeIntrospection;
  /** Ids of every node whose kind discriminator equals `kind`. */
  findNodes(kind: string): readonly string[];
  /**
   * Decode a canonical-JSON `TreeOp` and apply it to the live tree — but ONLY
   * when the policy gate permits (FGP 3). A denied op returns the deny envelope
   * and leaves the tree unchanged; a host that wired no `applyHandler` returns
   * the `unwired` envelope.
   */
  apply(opJson: string): ApplyEnvelope;
  /** A one-screen reference of the available methods (print the return value). */
  help(): string;
}

const HELP_TEXT = `window.__fuaran — Fuaran in-page introspection (DEBUG-only, unstable)
  .getNodeState(id)         typed snapshot: kind, bound binding slots, child ids
  .getBindingValue(id,slot) resolve one binding slot's current value
  .getRenderedDom(id)       live DOM geometry (x/y/size + overflow/hidden flags)
  .inspectTree()            recursive structural snapshot of the whole tree
  .findNodes(kind)          ids of every node whose kind === <kind>
  .apply(opJson)            policy-gated TreeOp mutation (default-deny; deny → envelope)
  .help()                   this text
Tip: __fuaran.inspectTree() lists every node id you can query.`;

const escapeAttr = (value: string): string =>
  typeof CSS !== 'undefined' && typeof CSS.escape === 'function'
    ? CSS.escape(value)
    : value.replace(/["\\]/g, '\\$&');

const readGeometry = (nodeId: string): NodeGeometry | DebugError => {
  if (typeof document === 'undefined') return { error: 'No DOM available (server context).' };
  const el = document.querySelector(`[data-fuaran-node-id="${escapeAttr(nodeId)}"]`);
  if (el === null) return { error: `No rendered element for node '${nodeId}'.` };
  const rect = el.getBoundingClientRect();
  const overflowing = el.scrollWidth > el.clientWidth || el.scrollHeight > el.clientHeight;
  const style = typeof window !== 'undefined' ? window.getComputedStyle(el) : undefined;
  const hidden =
    style?.display === 'none' ||
    style?.visibility === 'hidden' ||
    (rect.width === 0 && rect.height === 0);
  return {
    x: rect.x,
    y: rect.y,
    width: rect.width,
    height: rect.height,
    overflowing,
    hidden,
  };
};

/**
 * The policy-gated `apply(opJson)` pipeline, mirroring the F#
 * `DebugGlobal.applyEnvelope` ordering: read-only host → `unwired`; gate denies
 * (FGP 3) → `denied` (a diagnostic routes through `runtime.warn`, FGP 4, never
 * raw `console.*`); decode failure → `decodeFailed`; apply rejection → `rejected`;
 * otherwise apply, hand the new tree to the host's `applyHandler` (re-render),
 * and return `applied`. The gate is consulted BEFORE the op is decoded.
 */
const buildApplyEnvelope = <TMsg>(
  tree: Node<TMsg>,
  options: DebugGlobalOptions<TMsg>,
  opJson: string,
): ApplyEnvelope => {
  const { runtime, applyHandler } = options;
  if (applyHandler === undefined) {
    return {
      ok: false,
      status: 'unwired',
      error: 'apply is not wired on this host (no applyHandler supplied to buildDebugGlobal).',
    };
  }

  const sinks = options.sinks;

  const descriptor: ActionDescriptor = { kind: 'ApplyTreeOp', summary: opJson };
  if (runtime?.canDispatch !== undefined && !runtime.canDispatch(descriptor)) {
    const reason = `apply denied by policy gate: ${describeActionDescriptor(descriptor)}`;
    runtime.warn?.(reason);

    // The deny envelope and the telemetry record are the SAME event on two
    // surfaces. Fire-and-forget: a failing sink must never gate dispatch, so it
    // cannot change what the caller sees.
    if (sinks?.telemetrySink !== undefined) {
      try {
        sinks.telemetrySink.recordDeny(
          denyTelemetry(sinks.userId ?? 'operator', new Date().toISOString(), reason),
        );
      } catch {
        /* a telemetry failure is never the caller's problem */
      }
    }

    return { ok: false, status: 'denied', denied: true, error: reason };
  }

  // Only a genuinely applied op is durable: a decode failure never produced a
  // TreeOp and a rejected one changed no tree, so journalling either would put
  // an op in the stream that never happened.
  const decoded = decodeOp(opJson);
  if (!decoded.ok) return { ok: false, status: 'decodeFailed', error: decoded.error.message };

  const result = apply(tree, decoded.value as TreeOp<TMsg>);
  if (!result.ok) return { ok: false, status: 'rejected', error: result.error.message };

  applyHandler(result.value.newTree);

  if (sinks?.onApplied !== undefined) {
    try {
      sinks.onApplied(opJson);
    } catch {
      /* journalling is best-effort, like the F# sink contract */
    }
  }

  return { ok: true, status: 'applied' };
};

/**
 * Build the `window.__fuaran` surface over a tree + its binding sources. Pure
 * (no global side effect) and host-agnostic — unit-testable directly; the
 * geometry methods consult the live `document` when one exists. `options` wires
 * the policy-gated `apply` (gate + host re-render callback); omit it for a
 * read-only surface (`apply` returns the `unwired` envelope).
 */
export const buildDebugGlobal = <TMsg>(
  tree: Node<TMsg>,
  sources: BindingSources,
  options: DebugGlobalOptions<TMsg> = {},
): FuaranDebugGlobal => ({
  version: DEBUG_GLOBAL_VERSION,
  getNodeState: (nodeId) =>
    introspectNodeState(tree, nodeId) ?? { error: `Node '${nodeId}' not found in tree.` },
  getBindingValue: (nodeId, slot) => {
    const node = findNode(tree, nodeId);
    if (node === undefined) return { error: `Node '${nodeId}' not found in tree.` };
    const binding = bindingForSlot(node.kind as NodeKind<unknown>, slot);
    if (binding === undefined) {
      return {
        error: `Slot '${slot}' is not a binding slot on node '${nodeId}' (kind=${kindName(
          node.kind as NodeKind<unknown>,
        )}). Use getNodeState(id).bindings to list the slots.`,
      };
    }
    return resolve(sources, binding);
  },
  getRenderedDom: (nodeId) => readGeometry(nodeId),
  inspectTree: () => introspectTree(tree),
  findNodes: (kind) =>
    findNodes(tree, (n: Node<TMsg>) => kindName(n.kind as NodeKind<unknown>) === kind).map(
      (n: Node<TMsg>) => n.id as string,
    ),
  apply: (opJson) => buildApplyEnvelope(tree, options, opJson),
  help: () => HELP_TEXT,
});

/**
 * Register `global` under `window.__fuaran`. No-op when there is no `window`
 * (server / test-without-DOM). Returns an unregister function that removes the
 * global only if it still points at this instance — safe to call from a React
 * effect cleanup.
 */
export const registerDebugGlobal = (global: FuaranDebugGlobal): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const w = window as unknown as Record<string, unknown>;
  w[DEBUG_GLOBAL_KEY] = global;
  return () => {
    if (w[DEBUG_GLOBAL_KEY] === global) delete w[DEBUG_GLOBAL_KEY];
  };
};
