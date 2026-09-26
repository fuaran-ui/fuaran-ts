// ============================================================================
//  @fuaran-ui/ui/capability — the Compute-layer capability runtime (Phase 284).
//
//  The native-TS reimplementation of the invocable-capability surface the F#
//  estate owns in `Fuaran.Core.Function` (the `Capability` / `CapabilityRegistry`
//  contract) + `Fuaran.UI.AiTools.Capabilities` (discover / validate /
//  makeInvoker). The TS host does NOT consume fuaran-core — it reproduces the
//  reference semantics natively:
//
//    - a typed registry (register / tryFind / enumerate, default-deny dispatch),
//    - arg-validation default-deny by shape (an arg must address a declared
//      value/repeat hole and lie in its space; every required hole bound; a slot
//      hole is not scalar-invocable) — every refusal NAMED, never a throw,
//    - the Phase-27 replay `invocationKey` (id + FNV-1a of the canonical,
//      injective pre-image of the addr-sorted args), byte-identical to the F#,
//    - `discover` (each capability's id + its signature's JSON-Schema — the
//      compute analogue of node-introspection),
//    - `makeCapabilityInvoker` (validate → run the host body → `Deferred`),
//      which builds the renderer's `CapabilityInvoker` seam.
//
//  The first three bullets are Core twins: since Phase 1861 they live behind
//  the workspace-internal core-twins boundary and are re-exported below. The
//  agent-tool half (validate / discover / makeCapabilityInvoker) stays here.
//
//  This is RUNTIME parity, not wire: the Invoke *wire* (codec for the typed
//  invocation) already lives in @fuaran-ui/ops and is byte-identical across
//  hosts. What ships here is the capability DECLARATION runtime the renderer's
//  Binding.Invoke / Action.Invoke dispatch through.
// ============================================================================

import type { Capability, CapabilityInvoker, Deferred, InvokeArg, Result } from '@fuaran-ui/schema';
import { err, ok } from '@fuaran-ui/schema';

import {
  describeInvokeError,
  enumerate,
  toJsonSchema,
  tryFind,
  validateArgs,
  type CapabilityRegistry,
  type InvokeError,
} from '@fuaran-ui/core-twins';

// ─── Capability declaration types (port of Fuaran.Core.Function) ─────────────
//
// The five declaration types moved DOWN into `@fuaran-ui/schema` (beside
// `InvokeArg` / `CapabilityInvoker` / `HoleValueSpace`) so the canonical
// declaration codec could ship in `@fuaran-ui/ops` without either package
// depending on the other. They are re-exported here verbatim, so every
// consumer that imports them from `@fuaran-ui/ui` is unaffected — this file
// re-exports the RUNTIME the declarations feed.

export type {
  Capability,
  CapabilitySigEntry,
  CapabilitySignature,
  IslandKind,
  Placement,
} from '@fuaran-ui/schema';

// ─── The Core-twin runtime (port of Fuaran.Core.Function) ────────────────────
//
// The declaration runtime — arg validation, the replay `invocationKey`, the
// determinism tags, the typed registry and the JSON-Schema projection — is a
// Core twin, so since Phase 1861 it lives behind the workspace-internal
// core-twins boundary. It is re-exported here name for name, so the published
// surface of this package is unchanged; the build bundles it into this dist.

export {
  capabilityDeterminismTag,
  createCapability,
  describeInvokeError,
  determinismTag,
  emptyRegistry,
  enumerate,
  fnv1a,
  invocationKey,
  register,
  registryOf,
  spaceValidate,
  toJsonSchema,
  tryFind,
  validateArgs,
  type CapabilityRegistry,
  type InvokeError,
} from '@fuaran-ui/core-twins';

// ─── validate / discover / makeCapabilityInvoker (port of AiTools.Capabilities) ─

/**
 * Validate a typed invocation against the registry (default-deny by shape): an
 * unregistered id is `NoSuchCapability`; otherwise validate the scalar args
 * against the resolved capability's signature. Port of F#
 * `AiTools.Capabilities.validate` — returns the resolved capability on success.
 */
export const validate = (
  reg: CapabilityRegistry,
  capabilityId: string,
  args: readonly InvokeArg[],
): Result<Capability, InvokeError> => {
  const cap = tryFind(capabilityId, reg);
  if (cap === undefined)
    return err({
      kind: 'NoSuchCapability',
      id: capabilityId,
      known: enumerate(reg).map((c) => c.id),
    });
  const v = validateArgs(cap, args);
  return v.ok ? ok(cap) : v;
};

/**
 * Enumerate the registry for discovery: each capability's id paired with the
 * JSON-Schema projection of its signature, in stable id order. The compute
 * analogue of node-introspection — an agent reads it to learn the invokable
 * surface. Port of F# `AiTools.Capabilities.discover`.
 */
export const discover = (reg: CapabilityRegistry): [string, Record<string, unknown>][] =>
  enumerate(reg).map((cap) => [cap.id, toJsonSchema(cap.signature)]);

/**
 * Build a `CapabilityInvoker` seam (`id -> args -> Deferred`) from the registry +
 * a host-body resolver. Validates the invocation (a mismatch → `Deferred.Error`,
 * rendered via the node's `onError`), then runs the host body and returns its
 * `Deferred` (`Ready` → the value, `Error` → `onError`, `Pending` → `onLoading`
 * while a genuinely-async body awaits its realized value). A non-`Deterministic`
 * capability's realized value should be journaled by the host through the
 * Phase-27 capture seam keyed by `invocationKey` + `determinismTag`, so the
 * invocation replays exactly. Port of F# `AiTools.Capabilities.makeInvoker`.
 */
export const makeCapabilityInvoker = (
  reg: CapabilityRegistry,
  body: (cap: Capability, args: readonly InvokeArg[]) => Deferred<unknown>,
): CapabilityInvoker => {
  return (capabilityId, args) => {
    const v = validate(reg, capabilityId, args);
    if (!v.ok)
      return {
        kind: 'Error',
        message: `capability invocation rejected: ${describeInvokeError(v.error)}`,
      };
    return body(v.value, args);
  };
};
