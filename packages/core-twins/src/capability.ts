// ============================================================================
//  Core twin — the capability runtime (Phase 284), moved behind the core-twins
//  boundary in Phase 1861; @fuaran-ui/ui re-exports every name below.
//
//  The native-TS reimplementation of the invocable-capability surface the F#
//  reference owns in `Fuaran.Core.Function` (the `Capability` /
//  `CapabilityRegistry` contract):
//
//    - a typed registry (register / tryFind / enumerate, default-deny dispatch),
//    - arg-validation default-deny by shape (an arg must address a declared
//      hole and lie in its space; every required hole bound; a slot hole with no
//      declared space is not scalar-invocable) — every refusal NAMED, never a
//      throw,
//    - the Phase-27 replay `invocationKey` (id + FNV-1a of the canonical,
//      injective pre-image of the addr-sorted args — Phase 1860, the
//      reference's fuaran-core#225 form), byte-identical to the F# arithmetic,
//    - `toJsonSchema` (a signature's standard JSON-Schema projection).
//
//  The agent-tool half (validate / discover / makeCapabilityInvoker, a port of
//  the UI tier's `AiTools.Capabilities`) stays in @fuaran-ui/ui: it builds the
//  renderer's `CapabilityInvoker` seam, which is host-domain vocabulary.
// ============================================================================

import type {
  Capability,
  CapabilitySigEntry,
  CapabilitySignature,
  DeterminismSource,
  EffectClass,
  HostEffect,
  InvokeArg,
  Placement,
  Result,
} from '@fuaran-ui/schema';

import { err, ok } from './result.js';

/**
 * The value space a capability signature entry ranges over: a `HoleValueSpace`,
 * or the tree space `SlotTree` (fuaran-core#229) — its argument is a wire
 * document whose `"kind"` satisfies `slotKind` (any kind when absent).
 */
export type CapabilitySpace = NonNullable<CapabilitySigEntry['space']>;

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
      readonly space: CapabilitySpace;
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

/**
 * The kind tag of a tree argument: the top-level string `"kind"` when the
 * string is a well-formed wire document whose top level is an object, and
 * `undefined` for a scalar, a malformed document, or an object with no string
 * `"kind"`. Decodes nothing below the tag. Mirrors F# `Space.slotKindOf`.
 */
export const slotKindOf = (s: string): string | undefined => {
  let doc: unknown;
  try {
    doc = JSON.parse(s);
  } catch {
    return undefined;
  }
  if (typeof doc !== 'object' || doc === null || Array.isArray(doc)) return undefined;
  const kind = (doc as Record<string, unknown>)['kind'];
  return typeof kind === 'string' ? kind : undefined;
};

/** Is a candidate string value within the value-space? Mirrors F# `Space.validate`. */
export const spaceValidate = (space: CapabilitySpace, s: string): boolean => {
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
    case 'SlotTree': {
      const kind = slotKindOf(s);
      return kind !== undefined && (space.slotKind === undefined || kind === space.slotKind);
    }
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
 * The terminator of every field of a canonical pre-image: U+0001 (SOH). No
 * canonical wire encoding emits it unescaped. Port of F# `Hash.foldSep`.
 */
export const FOLD_SEP = '\u0001';

/**
 * The escape `canonicalField` writes before a `FOLD_SEP` or a `FIELD_ESC` a
 * field carries: U+0010 (DLE). Port of F# `Hash.fieldEsc`.
 */
export const FIELD_ESC = '\u0010';

/**
 * ONE field of an injective canonical pre-image: every `FIELD_ESC` and every
 * `FOLD_SEP` the field carries escaped by a preceding `FIELD_ESC`, then the
 * field terminated by `FOLD_SEP`. The first UNESCAPED `FOLD_SEP` is therefore
 * always the end of the field, whatever it contains. Escaping `FIELD_ESC`
 * first keeps the escapes the second replacement inserts from being escaped
 * again. Port of F# `Hash.canonicalField`.
 */
export const canonicalField = (s: string): string =>
  s
    .split(FIELD_ESC)
    .join(FIELD_ESC + FIELD_ESC)
    .split(FOLD_SEP)
    .join(FIELD_ESC + FOLD_SEP) + FOLD_SEP;

/**
 * The canonical pre-image of a field sequence: each field through
 * `canonicalField`, concatenated. Injective — two field lists with one
 * pre-image are one list. Port of F# `Hash.canonicalFields`.
 */
export const canonicalFields = (fields: readonly string[]): string =>
  fields.map(canonicalField).join('');

/**
 * The effect-identity key the Phase 27 capture seam journals a non-deterministic
 * invocation under: the capability id + a hash of the canonical pre-image of
 * the addr-sorted args — two fields per binding (addr, value) through
 * `canonicalFields`. Two invocations with the same args replay the same
 * captured value, and the pre-image is injective, so distinct argument sets
 * never share one whatever their values contain (Phase 1860; the reference's
 * fuaran-core#225 form, which replaced the old separator-free `addr=value`
 * join under which [a="1b=2"] and [a="1"; b="2"] collided). That two distinct
 * pre-images hash apart is a property of `fnv1a` and is not claimed. The sort
 * is stable and by UTF-16 code unit, as the reference's ordinal sort is.
 * Port of F# `Capability.invocationKey`.
 */
export const invocationKey = (cap: Capability, args: readonly InvokeArg[]): string => {
  const canonical = canonicalFields(
    [...args]
      .sort((a, b) => (a.addr < b.addr ? -1 : a.addr > b.addr ? 1 : 0))
      .flatMap((a) => [a.addr, a.value]),
  );
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
    // A tree space: an argument that is no tree at all is uninvocable; a tree of
    // the wrong kind is out of the space (fuaran-core#229, the reference's order).
    if (hole.space.kind === 'SlotTree' && slotKindOf(value) === undefined)
      return err({ kind: 'UninvocableArg', addr });
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

// ---- signature → standard JSON Schema projection (port of Function.toJsonSchema) ----

const hostStr = (h: HostEffect): string =>
  h === 'Pure' ? 'pure' : h === 'ReadsHost' ? 'readsHost' : 'writesHost';

const effectJson = (e: EffectClass): Record<string, unknown> => ({
  host: hostStr(e.hostEffect),
  determinism: determinismTag(e.determinism),
});

const spaceSchema = (s: CapabilitySpace): Record<string, unknown> => {
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
    case 'SlotTree':
      return s.slotKind !== undefined
        ? { type: 'object', description: `slot of kind: ${s.slotKind}` }
        : { type: 'object' };
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
