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
//    - the Phase-27 replay `invocationKey` (id + FNV-1a of the addr-sorted
//      `addr=value` arg string), byte-identical to the F# arithmetic,
//    - `discover` (each capability's id + its signature's JSON-Schema — the
//      compute analogue of node-introspection),
//    - `makeCapabilityInvoker` (validate → run the host body → `Deferred`),
//      which builds the renderer's `CapabilityInvoker` seam.
//
//  This is RUNTIME parity, not wire: the Invoke *wire* (codec for the typed
//  invocation) already lives in @fuaran-ui/ops and is byte-identical across
//  hosts. What ships here is the capability DECLARATION runtime the renderer's
//  Binding.Invoke / Action.Invoke dispatch through.
// ============================================================================

import type {
  CapabilityInvoker,
  Deferred,
  DeterminismSource,
  EffectClass,
  HoleValueSpace,
  HostEffect,
  InvokeArg,
  Result,
} from '@fuaran-ui/schema';
import { err, ok } from '@fuaran-ui/schema';

// ─── Capability declaration types (port of Fuaran.Core.Function) ─────────────

/**
 * One signature entry — the introspectable projection of a capability hole. A
 * `value` / `repeat` hole carries its value-`space`; a `slot` hole carries its
 * `slotKind` constraint (and no scalar space). Port of F# `SigEntry`; the value
 * space reuses @fuaran-ui/schema's `HoleValueSpace` (the same five cases).
 */
export interface CapabilitySigEntry {
  readonly addr: string;
  readonly name: string;
  readonly kind: 'value' | 'slot' | 'repeat';
  readonly space?: HoleValueSpace;
  readonly slotKind?: string;
  readonly required: boolean;
}

/** A capability's derived signature: which holes, what spaces, and its effect class. */
export interface CapabilitySignature {
  readonly name: string;
  readonly holes: readonly CapabilitySigEntry[];
  readonly effect: EffectClass;
}

/** Which client-island runtime a `ClientIsland` capability's body runs in. */
export type IslandKind = 'pyodide' | 'fable' | 'js';

/** Where a capability's body runs (spec §5) — a typed, portable placement contract. */
export type Placement =
  | { readonly kind: 'BuildTime' }
  | { readonly kind: 'Server' }
  | { readonly kind: 'ClientDeclarative' }
  | { readonly kind: 'ClientIsland'; readonly island: IslandKind }
  | { readonly kind: 'Precomputed' };

/**
 * A registrable, invocable runtime capability. `signature` (incl. its effect) is
 * the artifact-function projection; `determinism` is the capture-keying axis
 * (always `= signature.effect.determinism`, enforced by `createCapability`);
 * `placement` routes the host body. The wire carries this declaration + a typed
 * invocation, never the body. Port of F# `Capability`.
 */
export interface Capability {
  readonly id: string;
  readonly signature: CapabilitySignature;
  readonly determinism: DeterminismSource;
  readonly placement: Placement;
}

/**
 * Why a typed invocation (or a registration) was refused — total, names the
 * failure and, where a closed set is expected, enumerates the alternatives.
 * Default-deny by shape: only a registered id with in-space args dispatches.
 * Port of F# `InvokeError`.
 */
export type InvokeError =
  | { readonly kind: 'NoSuchCapability'; readonly id: string; readonly known: readonly string[] }
  | { readonly kind: 'DuplicateCapability'; readonly id: string }
  | { readonly kind: 'UnknownArg'; readonly addr: string; readonly declared: readonly string[] }
  | {
      readonly kind: 'ArgOutOfSpace';
      readonly addr: string;
      readonly space: HoleValueSpace;
      readonly got: string;
    }
  | { readonly kind: 'RequiredArgsUnbound'; readonly addrs: readonly string[] }
  | { readonly kind: 'UninvocableArg'; readonly addr: string }
  | { readonly kind: 'BodyFailed'; readonly reason: string };

/** Render an `InvokeError` for a diagnostic — the named-refusal surface. */
export const describeInvokeError = (e: InvokeError): string => {
  switch (e.kind) {
    case 'NoSuchCapability':
      return `NoSuchCapability(${e.id}; known: [${e.known.join(', ')}])`;
    case 'DuplicateCapability':
      return `DuplicateCapability(${e.id})`;
    case 'UnknownArg':
      return `UnknownArg(${e.addr}; declared: [${e.declared.join(', ')}])`;
    case 'ArgOutOfSpace':
      return `ArgOutOfSpace(${e.addr}=${e.got})`;
    case 'RequiredArgsUnbound':
      return `RequiredArgsUnbound([${e.addrs.join(', ')}])`;
    case 'UninvocableArg':
      return `UninvocableArg(${e.addr})`;
    case 'BodyFailed':
      return `BodyFailed(${e.reason})`;
  }
};

// ─── Value-space validation (port of Fuaran.Core.Space.validate) ─────────────

const INT_RE = /^[+-]?\d+$/;

/** Is a candidate string value within the value-space? Mirrors F# `Space.validate`. */
export const spaceValidate = (space: HoleValueSpace, s: string): boolean => {
  switch (space.kind) {
    case 'IntRange': {
      if (!INT_RE.test(s.trim())) return false;
      const v = Number.parseInt(s.trim(), 10);
      return Number.isFinite(v) && v >= space.min && v <= space.max;
    }
    case 'FloatRange': {
      const t = s.trim();
      if (t === '') return false;
      const v = Number(t);
      return Number.isFinite(v) && v >= space.min && v <= space.max;
    }
    case 'StringLen':
      return s.length >= space.minLen && s.length <= space.maxLen;
    case 'Enum':
      return space.choices.includes(s);
    case 'AnyString':
      return true;
  }
};

// ─── invocationKey (port of Fuaran.Core.Capability.invocationKey) ─────────────

/**
 * FNV-1a over a string, byte-identical to the F# `fnv1a` (32-bit, offset basis
 * `2166136261`, prime `16777619`, XOR by UTF-16 code unit, 8-hex-digit output).
 * `Math.imul` performs the 32-bit-wrapping multiply; `>>> 0` keeps every
 * intermediate unsigned so the result matches the .NET `uint32` arithmetic.
 */
export const fnv1a = (s: string): string => {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) {
    h = (h ^ s.charCodeAt(i)) >>> 0;
    h = Math.imul(h, 16777619) >>> 0;
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

/**
 * The effect-identity key the Phase 27 capture seam journals a non-deterministic
 * invocation under: the capability id + a hash of the canonical (addr-sorted)
 * `addr=value` arg string. Two invocations with the same args replay the same
 * captured value; different args do not collide. Port of F# `invocationKey`.
 */
export const invocationKey = (cap: Capability, args: readonly InvokeArg[]): string => {
  const canonical = [...args]
    .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
    .map((a) => `${a.addr}=${a.value}`)
    .join('');
  return `${cap.id}#${fnv1a(canonical)}`;
};

// ─── determinism tag (port of Effect.determinismTag) ─────────────────────────

/** The Phase 27 determinism label this determinism source keys its captures on. */
export const determinismTag = (d: DeterminismSource): string => {
  switch (d) {
    case 'Deterministic':
      return 'deterministic';
    case 'Clock':
      return 'clock';
    case 'Random':
      return 'random';
    case 'Network':
      return 'network';
  }
};

/** The Phase 27 determinism label a capability keys its captures on. */
export const capabilityDeterminismTag = (cap: Capability): string =>
  determinismTag(cap.determinism);

// ─── Capability construction + arg-validation ────────────────────────────────

/**
 * Build a capability, deriving `determinism` from the signature's effect class
 * (the two are never allowed to disagree). Port of F# `Capability.create`.
 */
export const createCapability = (
  id: string,
  signature: CapabilitySignature,
  placement: Placement,
): Capability => ({
  id,
  signature,
  determinism: signature.effect.determinism,
  placement,
});

/**
 * Validate typed `args` against the capability's signature *before* dispatch
 * (default-deny by shape, FGP 3): every arg must address a declared value/repeat
 * hole and lie in its space; every required hole must be bound; a slot hole is
 * not scalar-invocable. Port of F# `Capability.validateArgs` — same named-error
 * set (`UnknownArg` / `ArgOutOfSpace` / `UninvocableArg` / `RequiredArgsUnbound`),
 * never a throw.
 */
export const validateArgs = (
  cap: Capability,
  args: readonly InvokeArg[],
): Result<void, InvokeError> => {
  const holes = cap.signature.holes;
  const declared = holes.map((h) => h.addr);

  // 1. every arg addresses a declared hole that takes a scalar value in-space.
  for (const { addr, value } of args) {
    const hole = holes.find((h) => h.addr === addr);
    if (hole === undefined) return err({ kind: 'UnknownArg', addr, declared });
    if (hole.space === undefined) return err({ kind: 'UninvocableArg', addr }); // a slot hole
    if (!spaceValidate(hole.space, value))
      return err({ kind: 'ArgOutOfSpace', addr, space: hole.space, got: value });
  }

  // 2. every required hole is bound.
  const bound = new Set(args.map((a) => a.addr));
  const unbound = holes.filter((h) => h.required && !bound.has(h.addr)).map((h) => h.addr);
  if (unbound.length > 0) return err({ kind: 'RequiredArgsUnbound', addrs: unbound });

  return ok(undefined);
};

// ─── The typed registry (port of Fuaran.Core.Registry) ───────────────────────

/**
 * A typed capability registry — the discovery surface an agent enumerates (the
 * compute analogue of node-introspection). Default-deny by shape on dispatch:
 * only a registered id resolves. Immutable; `register` returns a fresh registry.
 */
export interface CapabilityRegistry {
  readonly capabilities: ReadonlyMap<string, Capability>;
}

/** The empty registry. */
export const emptyRegistry: CapabilityRegistry = { capabilities: new Map() };

/**
 * Register a capability — additive, no silent overwrite (a duplicate id is a
 * named error). Port of F# `Registry.register`.
 */
export const register = (
  cap: Capability,
  reg: CapabilityRegistry,
): Result<CapabilityRegistry, InvokeError> => {
  if (reg.capabilities.has(cap.id)) return err({ kind: 'DuplicateCapability', id: cap.id });
  const next = new Map(reg.capabilities);
  next.set(cap.id, cap);
  return ok({ capabilities: next });
};

/** Build a registry from a list of capabilities (duplicate id → named error). */
export const registryOf = (
  caps: readonly Capability[],
): Result<CapabilityRegistry, InvokeError> => {
  let reg = emptyRegistry;
  for (const cap of caps) {
    const r = register(cap, reg);
    if (!r.ok) return r;
    reg = r.value;
  }
  return ok(reg);
};

/** Look up a registered capability, or `undefined`. Port of F# `Registry.tryFind`. */
export const tryFind = (id: string, reg: CapabilityRegistry): Capability | undefined =>
  reg.capabilities.get(id);

/**
 * Enumerate the registry in a stable order (by id) — the discovery surface;
 * stability is part of the contract. Port of F# `Registry.enumerate`.
 */
export const enumerate = (reg: CapabilityRegistry): Capability[] =>
  [...reg.capabilities.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

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

// ---- signature → standard JSON Schema projection (port of Function.toJsonSchema) ----

const hostStr = (h: HostEffect): string =>
  h === 'Pure' ? 'pure' : h === 'ReadsHost' ? 'readsHost' : 'writesHost';

const effectJson = (e: EffectClass): Record<string, unknown> => ({
  host: hostStr(e.hostEffect),
  determinism: determinismTag(e.determinism),
});

const spaceSchema = (s: HoleValueSpace): Record<string, unknown> => {
  switch (s.kind) {
    case 'IntRange':
      return { type: 'integer', minimum: s.min, maximum: s.max };
    case 'FloatRange':
      return { type: 'number', minimum: s.min, maximum: s.max };
    case 'StringLen':
      return { type: 'string', minLength: s.minLen, maxLength: s.maxLen };
    case 'Enum':
      return { enum: [...s.choices] };
    case 'AnyString':
      return { type: 'string' };
  }
};

const propSchema = (e: CapabilitySigEntry): Record<string, unknown> => {
  if (e.kind === 'slot')
    return e.slotKind !== undefined
      ? { type: 'object', description: `slot of kind: ${e.slotKind}` }
      : { type: 'object' };
  return e.space !== undefined ? spaceSchema(e.space) : { type: 'string' };
};

/**
 * Project a capability signature into a STANDARD JSON Schema `object` — the shape
 * an LLM tool-use API consumes. Each hole becomes a property keyed by its
 * absolute address (hygiene — addresses, never bare names); the required holes
 * (value + slot; repeats optional) are listed; the two-axis effect class travels
 * alongside as `x-effect`, OUTSIDE the parameter schema. Port of F#
 * `Function.toJsonSchema`.
 */
export const toJsonSchema = (sg: CapabilitySignature): Record<string, unknown> => {
  const properties: Record<string, unknown> = {};
  for (const e of sg.holes) properties[e.addr] = propSchema(e);
  return {
    type: 'object',
    title: sg.name,
    'x-effect': effectJson(sg.effect),
    properties,
    required: sg.holes.filter((h) => h.required).map((h) => h.addr),
  };
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
