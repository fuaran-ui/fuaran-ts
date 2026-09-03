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

import {
  apply,
  type DecodeError,
  decodeOp,
  encodeNode,
  encodeOp,
  type TreeOp,
} from '@fuaran-ui/ops';
import type { Node, NodeKind } from '@fuaran-ui/schema';
import type { DenyTelemetry, FuaranTelemetrySink } from '@fuaran-ui/telemetry';
import {
  bindingExpression,
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
import { type ChangeHub, type ChangeListener, pageChangeHub } from './changeHub.js';
import { isDeclaredSlot } from './declaredSlots.js';
import {
  type ActionDescriptor,
  describeActionDescriptor,
  type FuaranRuntime,
} from './customRegistry.js';

/** The window key the debug global is registered under. */
export const DEBUG_GLOBAL_KEY = '__fuaran';

/** Schema version of the `window.__fuaran` shape (independent of package semver). */
export const DEBUG_GLOBAL_VERSION = '0.2.0';

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
  | { readonly ok: true; readonly status: 'applied'; readonly treeRevision?: string }
  | { readonly ok: false; readonly status: 'unwired'; readonly error: string }
  | { readonly ok: false; readonly status: 'denied'; readonly denied: true; readonly error: string }
  | {
      readonly ok: false;
      readonly status: 'decodeFailed';
      readonly error: string;
      /** The codec's structured decode error, for a caller that reports it typed. */
      readonly decodeError?: DecodeError;
    }
  | {
      readonly ok: false;
      readonly status: 'rejected';
      readonly error: string;
      /** The apply-engine / validator diagnostic code behind the rejection. */
      readonly code?: string;
    };

/**
 * A `TreeOp` in canonical wire JSON, carried as a structured object rather than
 * a pre-serialised string. Accepted by {@link FuaranDebugGlobal.apply} alongside
 * the original string form: a structured-clone channel (a page/extension relay)
 * has no text layer, and canonicalising is the HOST's obligation, not its
 * caller's — so the caller hands over the object and the host serialises it.
 */
export type TreeOpJson = Readonly<Record<string, unknown>>;

/** The closed status set of a binding-slot resolution. */
export type BindingStatus =
  | 'resolved'
  | 'notResolved'
  | 'errored'
  | 'i18nUnresolved'
  | 'noOverride';

/**
 * A slot resolution WITH the binding's identity — the tagged envelope form.
 *
 * {@link FuaranDebugGlobal.getBindingValue} returns the bare `Resolution`, which
 * says what a slot resolved TO but not what the binding IS. A slot inspector
 * needs both (and the bare form cannot be recovered into the tagged one), so
 * `expression` + `source` are present on EVERY status, including the ones that
 * carry no value.
 *
 * `noOverride` is the deliberate fifth status: the slot is declared on this
 * node's kind and currently holds nothing — distinct from asking for a slot the
 * kind does not declare, which is a caller error ({@link BindingStateError}).
 */
export interface BindingState {
  readonly status: BindingStatus;
  /** The binding's wire-form expression (`$state.<key>`, `$queries.<name>`, …; `$none` when unset). */
  readonly expression: string;
  /** The binding case token (`Static` / `Query` / `Filter` / `Selection` / `State` / `I18n` / `Computed`). */
  readonly source: string;
  /** Present on `resolved`. */
  readonly value?: unknown;
  /** Present on `errored`. */
  readonly message?: string;
  /** Present on `i18nUnresolved`. */
  readonly key?: string;
}

/** Why {@link FuaranDebugGlobal.getBindingState} could not answer. */
export type BindingStateError =
  | { readonly error: string; readonly reason: 'nodeNotFound'; readonly nodeId: string }
  | {
      readonly error: string;
      readonly reason: 'slotNotDeclared';
      readonly nodeId: string;
      readonly slot: string;
      readonly kind: string;
    };

/**
 * Why {@link FuaranDebugGlobal.getNodeJson} could not answer.
 *
 * Two reasons, tagged, because the relay contract refuses them with two
 * different classes and an untagged `{ error }` cannot tell them apart:
 * `nodeNotFound` means look elsewhere, `encodeFailed` means the node is
 * genuinely here and this host cannot render it in the wire vocabulary.
 *
 * This host never produces `encodeFailed` — the canonical encoder is total over
 * live trees, since a value the wire format cannot carry becomes a sentinel
 * string rather than a refusal. It is in the type so a host whose local model is
 * wider than the wire's has an honest answer available at this seam instead of
 * being forced to claim a node that exists does not.
 */
export type NodeJsonError =
  | { readonly error: string; readonly reason: 'nodeNotFound'; readonly nodeId: string }
  | { readonly error: string; readonly reason: 'encodeFailed'; readonly nodeId: string };

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
  /**
   * The host's tree validator, consulted on the CANDIDATE tree between apply
   * and fold: the op is applied to a copy, the validator runs over the result,
   * and the new tree is handed to `applyHandler` only when the edit introduced
   * no defect that was not already there. Defects the tree already carried are
   * not the edit's fault and must not block it.
   *
   * Optional — a host that wires none gets the apply engine's own legality
   * check and nothing more. A typical wiring is `@fuaran-ui/ui`'s
   * `preEmitValidate`: `(t) => { const r = preEmitValidate(t); return r.ok ? [] : r.error; }`.
   */
  readonly validate?: (candidate: Node<TMsg>) => readonly { readonly code: string }[];
  /**
   * The committed-tree-change hub backing `treeRevision()` + `subscribe()`.
   * Defaults to the page-wide hub, which is what makes a subscription outlive
   * the surface rebuild every tree change causes. Supply your own to isolate a
   * host (or a test) from the page-wide signal.
   */
  readonly hub?: ChangeHub;
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
  /**
   * Whether this host wired a real apply path. `false` means every `apply` call
   * returns the `unwired` envelope — a read-only surface. Exposed so a peer can
   * advertise the mutation entry point honestly instead of discovering its
   * absence by attempting a mutation.
   */
  readonly canApply: boolean;
  /** The typed snapshot (kind + binding slots + child ids) for a node by id. */
  getNodeState(nodeId: string): NodeIntrospection | DebugError;
  /** The resolved value of a single binding-typed slot against the live sources. */
  getBindingValue(nodeId: string, slot: string): Resolution<unknown> | DebugError;
  /**
   * The resolution of a single binding slot WITH the binding's identity — the
   * tagged envelope ({@link BindingState}) a slot inspector needs. The richer
   * companion to {@link getBindingValue}, which stays as it is for console use.
   */
  getBindingState(nodeId: string, slot: string): BindingState | BindingStateError;
  /** The live DOM geometry for a node, read from its rendered element. */
  getRenderedDom(nodeId: string): NodeGeometry | DebugError;
  /** A recursive structural snapshot of the whole rendered tree. */
  inspectTree(): TreeIntrospection;
  /** Ids of every node whose kind discriminator equals `kind`. */
  findNodes(kind: string): readonly string[];
  /**
   * One node's own canonical wire JSON — the whole subtree, as a structured
   * object rather than text.
   *
   * The other reads report what a node IS structurally; this one reports what
   * its properties HOLD, which is what makes a caller able to read-modify-write
   * rather than only write. Reading a style block before replacing it, or a
   * collection's current length before addressing `Columns[0].Label`, is not
   * possible from any other member.
   *
   * Values the wire format cannot carry — closures, opaque host payloads —
   * appear as the encoder's sentinel strings, because an encoding WITH sentinels
   * is the canonical encoding. That also means the result is for READING and
   * path derivation, not for feeding back as a node copy: a sentinel decodes as
   * the literal string it looks like, not as the closure it stands for.
   */
  getNodeJson(nodeId: string): unknown | NodeJsonError;
  /**
   * Decode a canonical-JSON `TreeOp` and apply it to the live tree — but ONLY
   * when the policy gate permits (FGP 3), and only when the edit introduces no
   * new validator defect. A denied op returns the deny envelope and leaves the
   * tree unchanged; a host that wired no `applyHandler` returns the `unwired`
   * envelope.
   *
   * Accepts the op as a JSON **string** (the original console form — paste the
   * JSON) or as a structured **object** ({@link TreeOpJson} — the form a
   * structured-clone channel carries, canonicalised here rather than by the
   * caller).
   */
  apply(op: string | TreeOpJson): ApplyEnvelope;
  /**
   * The current tree-revision token — opaque; compare for equality to detect
   * that a cached read has gone stale, never parse or order it.
   */
  treeRevision(): string;
  /**
   * Subscribe to committed tree changes. Returns an unsubscribe handle. Push,
   * never poll; rapid changes coalesce into one notification carrying the
   * latest revision, because a change is a staleness signal rather than a
   * change log — re-read what you need.
   */
  subscribe(listener: ChangeListener): () => void;
  /** A one-screen reference of the available methods (print the return value). */
  help(): string;
}

const HELP_TEXT = `window.__fuaran — Fuaran in-page introspection (DEBUG-only, unstable)
  .getNodeState(id)         typed snapshot: kind, bound binding slots, child ids
  .getBindingValue(id,slot) resolve one binding slot's current value
  .getBindingState(id,slot) as above, tagged with the binding's identity + status
  .getRenderedDom(id)       live DOM geometry (x/y/size + overflow/hidden flags)
  .inspectTree()            recursive structural snapshot of the whole tree
  .findNodes(kind)          ids of every node whose kind === <kind>
  .getNodeJson(id)          one node's own canonical wire JSON, whole subtree
  .apply(op)                policy-gated TreeOp mutation, JSON string or object
                            (default-deny; deny → envelope, tree untouched)
  .treeRevision()           opaque token identifying the current tree state
  .subscribe(cb)            committed-tree-change signal; returns an unsubscribe fn
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

/** A stable key for a validator defect, so "was this defect already there?" is a set test. */
const defectKey = (defect: { readonly code: string }): string => JSON.stringify(defect);

/**
 * The policy-gated `apply(op)` pipeline, mirroring the F#
 * `DebugGlobal.applyEnvelope` ordering: read-only host → `unwired`; gate denies
 * (FGP 3) → `denied` (a diagnostic routes through `runtime.warn`, FGP 4, never
 * raw `console.*`); decode failure → `decodeFailed`; apply rejection or a
 * newly-introduced validator defect → `rejected`; otherwise fold, hand the new
 * tree to the host's `applyHandler` (re-render), commit the change to the hub,
 * and return `applied`. The gate is consulted BEFORE the op is decoded — a
 * default-deny posture should not parse what it will refuse anyway.
 *
 * `op` may be a JSON string or a structured object; an object is serialised
 * here (the host owns canonicalisation) and journalled through the codec's own
 * canonical encoder, never through the caller's key order.
 */
const buildApplyEnvelope = <TMsg>(
  tree: Node<TMsg>,
  options: DebugGlobalOptions<TMsg>,
  op: string | TreeOpJson,
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
  const opJson = typeof op === 'string' ? op : JSON.stringify(op);

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
  if (!decoded.ok)
    return {
      ok: false,
      status: 'decodeFailed',
      error: decoded.error.message,
      decodeError: decoded.error,
    };

  const op2 = decoded.value as TreeOp<TMsg>;
  const result = apply(tree, op2);
  if (!result.ok)
    return { ok: false, status: 'rejected', error: result.error.message, code: result.error.code };

  // Candidate-apply → validate → fold only on no NEW defect. A defect the tree
  // already carried is not this edit's fault, so it must not block the edit.
  const { validate } = options;
  if (validate !== undefined) {
    const before = new Set(validate(tree).map(defectKey));
    const introduced = validate(result.value.newTree).filter((d) => !before.has(defectKey(d)));
    const first = introduced[0];
    if (first !== undefined)
      return {
        ok: false,
        status: 'rejected',
        error: `The edit introduces a validator defect: ${first.code}.`,
        code: first.code,
      };
  }

  applyHandler(result.value.newTree);
  const treeRevision = (options.hub ?? pageChangeHub).commit(result.value.newTree, 'apply');

  if (sinks?.onApplied !== undefined) {
    try {
      // A string caller's own bytes are journalled verbatim (unchanged
      // behaviour); an object is journalled through the canonical encoder,
      // since a structured-clone caller never had canonical bytes to give.
      sinks.onApplied(typeof op === 'string' ? op : encodeOp(op2));
    } catch {
      /* journalling is best-effort, like the F# sink contract */
    }
  }

  return { ok: true, status: 'applied', treeRevision };
};

/**
 * Resolve one slot into the tagged {@link BindingState} envelope: the
 * resolution PLUS the binding's identity, with `noOverride` for a declared slot
 * that currently holds nothing and a `slotNotDeclared` error for a slot the
 * kind does not declare at all. The two are deliberately different answers —
 * the first is a state of the tree, the second is a mistake in the question.
 */
const bindingState = <TMsg>(
  tree: Node<TMsg>,
  sources: BindingSources,
  nodeId: string,
  slotName: string,
): BindingState | BindingStateError => {
  const node = findNode(tree, nodeId);
  if (node === undefined)
    return { error: `Node '${nodeId}' not found in tree.`, reason: 'nodeNotFound', nodeId };

  const kind = node.kind as NodeKind<unknown>;
  const binding = bindingForSlot(kind, slotName);
  if (binding === undefined) {
    if (isDeclaredSlot(kind, slotName)) {
      // Declared on this kind, currently absent — a state, not an error. There
      // is no binding case to report, so the inert default stands in.
      return { status: 'noOverride', expression: '$none', source: 'Static' };
    }
    return {
      error: `Slot '${slotName}' is not a binding slot on node '${nodeId}' (kind=${kindName(kind)}).`,
      reason: 'slotNotDeclared',
      nodeId,
      slot: slotName,
      kind: kindName(kind),
    };
  }

  const { expression, source } = bindingExpression(binding);
  const resolution = resolve(sources, binding);
  switch (resolution.kind) {
    case 'Resolved':
      return { status: 'resolved', value: resolution.value, expression, source };
    case 'NotResolved':
      return { status: 'notResolved', expression, source };
    case 'Errored':
      return { status: 'errored', message: resolution.message, expression, source };
    case 'I18nUnresolved':
      return { status: 'i18nUnresolved', key: resolution.key, expression, source };
  }
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
  canApply: options.applyHandler !== undefined,
  treeRevision: () => (options.hub ?? pageChangeHub).revision(),
  subscribe: (listener) => (options.hub ?? pageChangeHub).subscribe(listener),
  getBindingState: (nodeId, slotName) => bindingState(tree, sources, nodeId, slotName),
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
  getNodeJson: (nodeId) => {
    const node = findNode(tree, nodeId);
    if (node === undefined)
      return {
        error: `Node '${nodeId}' not found in tree.`,
        reason: 'nodeNotFound',
        nodeId,
      } satisfies NodeJsonError;
    // The rendered canonical string, read back into structure. What a caller
    // wants here is the encoding a wire consumer would see, byte decisions and
    // all, and parsing the canonical text is the shortest honest route to it.
    return JSON.parse(encodeNode(node)) as unknown;
  },
  apply: (opJson) => buildApplyEnvelope(tree, options, opJson),
  help: () => HELP_TEXT,
});

/**
 * Register `global` under `window.__fuaran`. No-op when there is no `window`
 * (server / test-without-DOM). Returns an unregister function that removes the
 * global only if it still points at this instance — safe to call from a React
 * effect cleanup.
 */
/**
 * The surface currently registered on `window.__fuaran`, or `undefined`. The
 * live lookup a relay peer uses: the surface object is REPLACED on every tree
 * change, so a peer that captured one instance would answer from a stale tree.
 */
export const readRegisteredDebugGlobal = (): FuaranDebugGlobal | undefined => {
  if (typeof window === 'undefined') return undefined;
  return (window as unknown as Record<string, unknown>)[DEBUG_GLOBAL_KEY] as
    | FuaranDebugGlobal
    | undefined;
};

export const registerDebugGlobal = (global: FuaranDebugGlobal): (() => void) => {
  if (typeof window === 'undefined') return () => {};
  const w = window as unknown as Record<string, unknown>;
  w[DEBUG_GLOBAL_KEY] = global;
  return () => {
    if (w[DEBUG_GLOBAL_KEY] === global) delete w[DEBUG_GLOBAL_KEY];
  };
};
