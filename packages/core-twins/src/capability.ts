// ============================================================================
//  Core twin — the capability runtime (Phase 284), moved behind the core-twins
//  boundary in Phase 1861; @fuaran-ui/ui re-exports the declaration runtime
//  (every name above the pipeline section at the foot of this file).
//
//  The native-TS reimplementation of the invocable-capability surface the F#
//  reference owns in `Fuaran.Core.Function` (the `Capability` /
//  `CapabilityRegistry` contract):
//
//    - the determinism axis as a SET of factors, its canonical `+`-joined label
//      and the label's inverse (Core 0.33.0, fuaran-core Phase 319),
//    - a typed registry (register / tryFind / enumerate, default-deny dispatch)
//      behind the reference's admission gate (totality, then well-formedness),
//    - arg-validation default-deny by shape (an address bound once; an arg must
//      address a declared hole and lie in its space, read by the reference's
//      invariant readers; every required hole bound; a slot hole ranges over the
//      tree space its constraint names, Phase 1873) — every refusal NAMED, never
//      a throw,
//    - the Phase-27 replay `invocationKey` (id + FNV-1a of the canonical,
//      injective pre-image of the addr-sorted args, each value in its canonical
//      spelling — Phase 1860, the reference's fuaran-core#225 form),
//      byte-identical to the F# arithmetic,
//    - `toJsonSchema` (a signature's standard JSON-Schema projection),
//    - the declared result (Core 0.43.0, fuaran-core Phase 642) held to the
//      admission gate, and the capability-pipeline type check that holds an
//      invoke's declared output to it (`typeCheckPipeline`, over the space
//      lattice `capabilitySpaceSubsumes`). The pipeline half is this twin's own: the
//      conformance leg runs it, and no published package re-exports it.
//
//  The agent-tool half (validate / discover / makeCapabilityInvoker, a port of
//  the UI tier's `AiTools.Capabilities`) stays in @fuaran-ui/ui: it builds the
//  renderer's `CapabilityInvoker` seam, which is host-domain vocabulary.
// ============================================================================

import type {
  Capability,
  CapabilityEffectClass,
  CapabilitySigEntry,
  CapabilitySignature,
  DeterminismFactor,
  DeterminismSet,
  HostEffect,
  InvokeArg,
  Placement,
  Result,
  Returns,
} from '@fuaran-ui/schema';

import { formatFiniteDouble } from './canonFloat.js';
import { err, ok } from './result.js';

/**
 * The Fuaran.Core version whose capability semantics this twin mirrors —
 * declared once, here, beside the twin.
 *
 * The corpus's capability-law vectors (`laws/capability-laws.json`) are emitted
 * by Core and stamped with the Core version that emitted them (`kitVersion`).
 * This twin certifies against the vectors of the Core it mirrors; a copy
 * stamped for any other Core is the cut-to-raise window, and the capability
 * leg reports it by name rather than asserting it. Raised to 0.39.0 by Phase
 * 2001: the determinism factor set (Core 0.33.0, fuaran-core Phase 319), the
 * invariant readers and canonical argument spelling the replay key hashes
 * (0.34.0, Phase 295), the admission gate, `DuplicateArg` and the reader's
 * `$type` check (0.35.1, Phase 307), and the entry read as its hole kind
 * (0.37.0, Phase 409). Raised to 0.43.0 by Phase 2741: a capability declares
 * its result (fuaran-core Phase 642) — `Capability.result`, held to the
 * admission gate (`EmptyResult` / `NonFiniteResult`), and the pipeline type
 * check that refuses an invoke whose declared output does not admit it
 * (`PipelineOutputContradicts`). 0.40.0–0.42.0 moved no rule this twin carries
 * (inclusive-bound vectors, `answeredBy` stamps, IDL-derived codecs over an
 * unchanged wire). Not mirrored: the registry's policy gate (0.35.1, Phase 318)
 * with its decision context and grants (0.43.0, Phases 638 and 650), the
 * function registry's derived result kind (0.43.0, Phase 642), and the action
 * hole kind, which this host's signature entry does not carry.
 */
export const mirroredCoreVersion = '0.43.0';

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
  | { readonly kind: 'BodyFailed'; readonly reason: string }
  | { readonly kind: 'NonTotalCapability'; readonly id: string; readonly addrs: readonly string[] }
  | { readonly kind: 'IllFormedCapability'; readonly id: string; readonly fault: DeclarationFault }
  | { readonly kind: 'DuplicateArg'; readonly addr: string };

/**
 * Why a declaration fails the admission gate's well-formedness half — the cases
 * of F# `DeclarationFault` this host's entry can carry: a hole whose space
 * admits no value, a hole with a non-finite bound, and two holes at one address
 * (the second named) (Core 0.35.1, fuaran-core Phase 307); and a declared result
 * whose space admits no value or has a non-finite bound (Core 0.43.0,
 * fuaran-core Phase 642), which names no address.
 */
export type DeclarationFault =
  | { readonly kind: 'EmptySpace'; readonly addr: string; readonly space: CapabilitySpace }
  | { readonly kind: 'NonFiniteBound'; readonly addr: string }
  | { readonly kind: 'DuplicateHoleAddr'; readonly addr: string }
  | { readonly kind: 'EmptyResult'; readonly space: CapabilitySpace }
  | { readonly kind: 'NonFiniteResult' };

/** Render a `DeclarationFault`: its case, and the address where it names one. */
const describeFault = (f: DeclarationFault): string =>
  'addr' in f ? `${f.kind}(${f.addr})` : f.kind;

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
    case 'NonTotalCapability':
      return `NonTotalCapability(${e.id}; [${e.addrs.join(', ')}])`;
    case 'IllFormedCapability':
      return `IllFormedCapability(${e.id}; ${describeFault(e.fault)})`;
    case 'DuplicateArg':
      return `DuplicateArg(${e.addr})`;
  }
};

// ─── Value-space validation (port of Fuaran.Core.Space) ──────────────────────

/** An integer argument's shape under the reference's invariant reader: `-?digits`. */
const INT_RE = /^-?\d+$/;

/** A number argument's shape: `-?digits(.digits)?([eE][+-]?digits)?`. */
const FLOAT_RE = /^-?\d+(\.\d+)?([eE][+-]?\d+)?$/;

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

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

/**
 * The ONE spelling a value in the space is handed on as, or `undefined` where
 * the string is not in the space (Core 0.34.0, fuaran-core Phase 295). An
 * integer is read as `-?digits` within 32 bits — no white space, no `+` — and
 * written in its shortest decimal form (`05` is `5`); a number is read as
 * `-?digits(.digits)?([eE][+-]?digits)?`, finite, and written in the canonical
 * float layout (`1.50` is `1.5`); every other space's value is its own
 * spelling. Mirrors F# `Space.canonical`.
 */
export const canonicalValue = (space: CapabilitySpace, s: string): string | undefined => {
  switch (space.kind) {
    case 'IntRange': {
      if (!INT_RE.test(s)) return undefined;
      const v = Number.parseInt(s, 10);
      return v >= INT32_MIN && v <= INT32_MAX && v >= space.min && v <= space.max
        ? String(v === 0 ? 0 : v)
        : undefined;
    }
    case 'FloatRange': {
      if (!FLOAT_RE.test(s)) return undefined;
      const v = Number(s);
      return Number.isFinite(v) && v >= space.min && v <= space.max
        ? formatFiniteDouble(v)
        : undefined;
    }
    case 'StringLen':
      return s.length >= space.minLen && s.length <= space.maxLen ? s : undefined;
    case 'Enum':
      return space.choices.includes(s) ? s : undefined;
    case 'AnyString':
      return s;
    case 'SlotTree': {
      const kind = slotKindOf(s);
      return kind !== undefined && (space.slotKind === undefined || kind === space.slotKind)
        ? s
        : undefined;
    }
  }
};

/**
 * Is a candidate string value within the value-space? Exactly when it has a
 * `canonicalValue` there. Mirrors F# `Space.validate`.
 */
export const spaceValidate = (space: CapabilitySpace, s: string): boolean =>
  canonicalValue(space, s) !== undefined;

/** The largest count a repeat hole may range over. Mirrors F# `Space.maxRepeatCount`. */
export const MAX_REPEAT_COUNT = 1_000_000;

/**
 * Is the space a COUNT space a repeat may range over: an `IntRange` with
 * `0 <= min <= max <= MAX_REPEAT_COUNT`. Mirrors F# `Space.isCount`.
 */
const isCount = (space: CapabilitySpace | undefined): boolean =>
  space !== undefined &&
  space.kind === 'IntRange' &&
  0 <= space.min &&
  space.min <= space.max &&
  space.max <= MAX_REPEAT_COUNT;

/**
 * Why a space is not well-formed: `'NonFinite'` for a `FloatRange` with a NaN
 * or infinite bound, `'Empty'` for a range whose min exceeds its max, a
 * `StringLen` whose max is negative, or an empty `Enum`; `undefined` when it is
 * well-formed. Mirrors F# `Space.wellFormed`.
 */
export const spaceFault = (space: CapabilitySpace): 'Empty' | 'NonFinite' | undefined => {
  switch (space.kind) {
    case 'FloatRange':
      if (!Number.isFinite(space.min) || !Number.isFinite(space.max)) return 'NonFinite';
      return space.min > space.max ? 'Empty' : undefined;
    case 'IntRange':
      return space.min > space.max ? 'Empty' : undefined;
    case 'StringLen':
      return space.minLen > space.maxLen || space.maxLen < 0 ? 'Empty' : undefined;
    case 'Enum':
      return space.choices.length === 0 ? 'Empty' : undefined;
    default:
      return undefined;
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
 * `canonicalFields`, each value in its canonical spelling in its hole's space
 * where it lies there (`05` and `5` in an integer hole are one value and one
 * key; Core 0.34.0, fuaran-core Phase 295). Two invocations with the same args replay the same
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
      .flatMap((a) => [a.addr, spelled(cap, a)]),
  );
  return `${cap.id}#${fnv1a(canonical)}`;
};

/**
 * The spelling an argument is keyed by: its canonical spelling in its hole's
 * space where it lies there, its own otherwise.
 */
const spelled = (cap: Capability, a: InvokeArg): string => {
  const hole = cap.signature.holes.find((h) => h.addr === a.addr);
  const space = hole === undefined ? undefined : invocationSpace(hole);
  return (space === undefined ? undefined : canonicalValue(space, a.value)) ?? a.value;
};

// ─── The determinism factor set (port of Fuaran.Core.Effect) ─────────────────

/** The factors in canonical order, with their wire names — the order every label uses. */
const FACTORS: readonly (readonly [DeterminismFactor, string])[] = [
  ['ClockFactor', 'clock'],
  ['RandomFactor', 'random'],
  ['NetworkFactor', 'network'],
];

/** The determinism set of the given factors (no factor: deterministic). */
export const determinismOf = (...factors: readonly DeterminismFactor[]): DeterminismSet =>
  new Set(factors);

/**
 * The canonical wire label of a determinism set — the Phase 27 label a capture
 * keys on: `deterministic` for the empty set, otherwise the member factors in
 * the order clock, random, network joined by `+` (`clock`, `clock+random`,
 * `clock+random+network`). Port of F# `Effect.determinismTag`.
 */
export const determinismTag = (d: DeterminismSet): string => {
  const names = FACTORS.filter(([f]) => d.has(f)).map(([, name]) => name);
  return names.length === 0 ? 'deterministic' : names.join('+');
};

/**
 * The inverse of `determinismTag`, on exactly the canonical labels: a
 * reordered, repeated, empty or unknown member is `undefined`, so a set has
 * one wire spelling. Port of F# `Effect.tryDeterminismOfTag`.
 */
export const tryDeterminismOfTag = (tag: string): DeterminismSet | undefined => {
  if (tag === 'deterministic') return new Set();
  const set = new Set<DeterminismFactor>();
  for (const name of tag.split('+')) {
    const factor = FACTORS.find(([, n]) => n === name);
    if (factor === undefined) return undefined;
    set.add(factor[0]);
  }
  return determinismTag(set) === tag ? set : undefined;
};

/** The union of two determinism sets — the determinism axis of F# `Effect.join`. */
export const joinDeterminism = (a: DeterminismSet, b: DeterminismSet): DeterminismSet =>
  new Set([...a, ...b]);

/**
 * Does `declared` name every factor `actual` reads — the superset relation of
 * F# `Effect.covers` on the determinism axis.
 */
export const coversDeterminism = (declared: DeterminismSet, actual: DeterminismSet): boolean =>
  [...actual].every((f) => declared.has(f));

/** The Phase 27 determinism label a capability keys its captures on. */
export const capabilityDeterminismTag = (cap: Capability): string =>
  determinismTag(cap.determinism);

// ─── Capability construction + arg-validation ────────────────────────────────

/**
 * Build a capability, deriving `determinism` from the signature's effect class
 * (the two are never allowed to disagree). `result` is what it answers (Core
 * 0.43.0): there is no capability without one, and `{ kind: 'Nothing' }` is how
 * one that answers no value says so. Port of F# `Capability.create`.
 */
export const createCapability = (
  id: string,
  signature: CapabilitySignature,
  placement: Placement,
  result: Returns,
): Capability => ({
  id,
  signature,
  result,
  determinism: signature.effect.determinism,
  placement,
});

/**
 * The value space an argument for this hole must lie in.
 *
 * The rule (Phase 1873, from fuaran-core#229; narrowed by Core 0.37.0,
 * fuaran-core Phase 409): a slot hole ranges over the tree space constrained to
 * its `slotKind`, so it admits a well-formed wire document whose `"kind"`
 * satisfies that constraint (any kind when the slot is unconstrained). The slot
 * entry IS its constraint: no declared space overrides it, so a `Text` tree in
 * a `Layout` slot is out of space. The space is supplied here, at validation,
 * rather than written into the declaration. Every other hole answers its
 * declared space.
 */
const invocationSpace = (hole: CapabilitySigEntry): CapabilitySpace | undefined => {
  if (hole.kind !== 'slot') return hole.space;
  return hole.slotKind === undefined
    ? { kind: 'SlotTree' }
    : { kind: 'SlotTree', slotKind: hole.slotKind };
};

/**
 * The refusal one argument earns on its own, by the rules `validateArgs` applies
 * to it: it must address a declared hole whose space admits it. A spaceless hole
 * is uninvocable; in a tree space an argument that is no tree at all is
 * uninvocable and a tree of the wrong kind is out of the space (fuaran-core#229,
 * the reference's order). Port of F# `Capability.argFault`.
 */
const argFault = (
  holes: readonly CapabilitySigEntry[],
  declared: readonly string[],
  { addr, value }: InvokeArg,
): InvokeError | undefined => {
  const hole = holes.find((h) => h.addr === addr);
  if (hole === undefined) return { kind: 'UnknownArg', addr, declared };
  const space = invocationSpace(hole);
  if (space === undefined) return { kind: 'UninvocableArg', addr };
  if (space.kind === 'SlotTree' && slotKindOf(value) === undefined)
    return { kind: 'UninvocableArg', addr };
  if (!spaceValidate(space, value)) return { kind: 'ArgOutOfSpace', addr, space, got: value };
  return undefined;
};

/**
 * Validate typed `args` against the capability's signature *before* dispatch
 * (default-deny by shape, FGP 3): every arg must address a declared hole and
 * lie in its space (a slot hole's space is its tree space, see
 * `invocationSpace`); every required hole must be bound. Port of F#
 * `Capability.validateArgs` — same named-error set (`DuplicateArg` /
 * `UnknownArg` / `ArgOutOfSpace` / `UninvocableArg` / `RequiredArgsUnbound`),
 * in the same order, never a throw.
 */
export const validateArgs = (
  cap: Capability,
  args: readonly InvokeArg[],
): Result<void, InvokeError> => {
  const holes = cap.signature.holes;
  const declared = holes.map((h) => h.addr);

  // 0. every address is bound once (Core 0.35.1, fuaran-core Phase 307): the
  //    first repeated address, at its second occurrence, before any value is read.
  const bound = new Set<string>();
  for (const { addr } of args) {
    if (bound.has(addr)) return err({ kind: 'DuplicateArg', addr });
    bound.add(addr);
  }

  // 1. every arg addresses a declared hole whose space admits it.
  for (const arg of args) {
    const fault = argFault(holes, declared, arg);
    if (fault !== undefined) return err(fault);
  }

  // 2. every required hole is bound.
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

/** "Returns nothing" — the one spelling of a capability that answers no value. */
const NOTHING: Returns = { kind: 'Nothing' };

/**
 * Why a declared result is not well-formed (Core 0.43.0, fuaran-core Phase 642):
 * a value space `spaceFault` refuses, named as the hole faults are; "returns
 * nothing" is always well-formed. Port of F# `Capability.resultFault`.
 */
const resultFault = (result: Returns): DeclarationFault | undefined => {
  if (result.kind === 'Nothing') return undefined;
  const fault = spaceFault(result.space);
  if (fault === 'NonFinite') return { kind: 'NonFiniteResult' };
  if (fault === 'Empty') return { kind: 'EmptyResult', space: result.space };
  return undefined;
};

/**
 * THE admission gate a declaration passes to be registered or read (Core
 * 0.35.1, fuaran-core Phase 307; F# `Capability.admissionOf`): totality first —
 * every repeat hole ranges over a count space, refused `NonTotalCapability`
 * naming each one that does not — then well-formedness, the first entry in
 * declaration order whose address an earlier entry holds (`DuplicateHoleAddr`)
 * or whose space admits no value or has a non-finite bound (`EmptySpace` /
 * `NonFiniteBound`), then the declared result's space (Core 0.43.0:
 * `EmptyResult` / `NonFiniteResult`), each refused `IllFormedCapability`.
 * `undefined` admits. Without a `result` it is the gate over the signature
 * alone (F# `Capability.signatureAdmissionOf`): "returns nothing" has no fault.
 */
export const admissionOf = (
  id: string,
  sg: CapabilitySignature,
  result: Returns = NOTHING,
): InvokeError | undefined => {
  const nonTotal = sg.holes
    .filter((h) => h.kind === 'repeat' && !isCount(h.space))
    .map((h) => h.addr);
  if (nonTotal.length > 0) return { kind: 'NonTotalCapability', id, addrs: nonTotal };
  const seen = new Set<string>();
  for (const h of sg.holes) {
    if (seen.has(h.addr))
      return {
        kind: 'IllFormedCapability',
        id,
        fault: { kind: 'DuplicateHoleAddr', addr: h.addr },
      };
    const space = invocationSpace(h);
    const fault = space === undefined ? undefined : spaceFault(space);
    if (fault === 'NonFinite')
      return { kind: 'IllFormedCapability', id, fault: { kind: 'NonFiniteBound', addr: h.addr } };
    if (fault === 'Empty' && space !== undefined)
      return {
        kind: 'IllFormedCapability',
        id,
        fault: { kind: 'EmptySpace', addr: h.addr, space },
      };
    seen.add(h.addr);
  }
  const fault = resultFault(result);
  return fault === undefined ? undefined : { kind: 'IllFormedCapability', id, fault };
};

/**
 * Register a capability — additive, no silent overwrite (a duplicate id is a
 * named error), and only one the admission gate admits (`admissionOf`). Port
 * of F# `Registry.register`.
 */
export const register = (
  cap: Capability,
  reg: CapabilityRegistry,
): Result<CapabilityRegistry, InvokeError> => {
  if (reg.capabilities.has(cap.id)) return err({ kind: 'DuplicateCapability', id: cap.id });
  const refused = admissionOf(cap.id, cap.signature, cap.result);
  if (refused !== undefined) return err(refused);
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

const effectJson = (e: CapabilityEffectClass): Record<string, unknown> => ({
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

// ─── The space lattice (port of Fuaran.Core.Space.subsumes) ──────────────────

/**
 * Does `required` admit every value `available` admits (Core 0.34.0,
 * fuaran-core Phase 295)? The reference's lattice: a range admits a narrower
 * range of its own kind, a float range admits an int range inside it, a
 * `StringLen` admits a `StringLen` it bounds and an `Enum` whose every member it
 * bounds (by UTF-16 length, as the reference's `String.Length`), an `Enum`
 * admits a subset of itself, `AnyString` admits every scalar space, and the tree
 * spaces are their own family (an unconstrained `SlotTree` admits every
 * `SlotTree`, a constrained one only its own kind). Port of F# `Space.subsumes`.
 *
 * Not the function registry's `spaceSubsumes` (`function.ts`): that twin is
 * certified by the shared function-registry goldens against an older, narrower
 * relation (no int-in-float widening, no `StringLen` over an `Enum`, no tree
 * spaces), and moving it would move a family this phase does not certify.
 */
export const capabilitySpaceSubsumes = (
  required: CapabilitySpace,
  available: CapabilitySpace,
): boolean => {
  switch (required.kind) {
    case 'IntRange':
      return (
        available.kind === 'IntRange' &&
        required.min <= available.min &&
        available.max <= required.max
      );
    case 'FloatRange':
      return (
        (available.kind === 'FloatRange' || available.kind === 'IntRange') &&
        required.min <= available.min &&
        available.max <= required.max
      );
    case 'StringLen':
      if (available.kind === 'StringLen')
        return required.minLen <= available.minLen && available.maxLen <= required.maxLen;
      if (available.kind === 'Enum')
        return available.choices.every(
          (x) => x.length >= required.minLen && x.length <= required.maxLen,
        );
      return false;
    case 'Enum':
      return (
        available.kind === 'Enum' && available.choices.every((x) => required.choices.includes(x))
      );
    case 'AnyString':
      return available.kind !== 'SlotTree';
    case 'SlotTree':
      return (
        available.kind === 'SlotTree' &&
        (required.slotKind === undefined || required.slotKind === available.slotKind)
      );
  }
};

// ─── The capability pipeline (port of Fuaran.Core.CapabilityPipeline) ───────
//
// A typed capability-DAG declared as data: `source` nodes the host supplies and
// `invoke` nodes that call a registered capability, each argument a literal or
// the output of an EARLIER node. This twin carries the pipeline's TYPE CHECK
// (what the capability-law vectors draw); evaluation and the capture keys stay
// with the reference.

/** Where an invoke's argument comes from: a literal, or an upstream node's output. */
export type PipelineArgSource =
  | { readonly kind: 'Literal'; readonly value: string }
  | { readonly kind: 'FromNode'; readonly node: string };

/** One argument binding of an invoke node: a hole address and its source. */
export interface PipelineArg {
  readonly addr: string;
  readonly source: PipelineArgSource;
}

/**
 * A pipeline node. A `Source` is an input the host supplies under an opaque
 * `dataRef`; an `Invoke` calls `capabilityId`. Each declares the `outputType`
 * downstream edges are checked against. Port of F# `PipelineNode`.
 */
export type PipelineNode =
  | {
      readonly kind: 'Source';
      readonly id: string;
      readonly dataRef: string;
      readonly outputType: CapabilitySpace;
    }
  | {
      readonly kind: 'Invoke';
      readonly id: string;
      readonly capabilityId: string;
      readonly outputType: CapabilitySpace;
      readonly args: readonly PipelineArg[];
    };

/** A capability pipeline: its nodes in declaration (topological) order. */
export interface CapabilityPipeline {
  readonly nodes: readonly PipelineNode[];
}

/**
 * Why a pipeline does not type-check — named, never a throw. Port of F#
 * `PipelineError`; an argument refusal wraps the `InvokeError` the node's
 * capability gives the same argument, and `EdgeTypeMismatch` names only the
 * space FAMILIES (`int`, `float`, `string`, `enum`, `anyString`, `slotTree`).
 */
export type PipelineError =
  | { readonly kind: 'DuplicateNode'; readonly id: string }
  | { readonly kind: 'UnknownNode'; readonly id: string }
  | {
      readonly kind: 'PipelineNoSuchCapability';
      readonly id: string;
      readonly known: readonly string[];
    }
  | { readonly kind: 'PipelineArgRefused'; readonly node: string; readonly reason: InvokeError }
  | { readonly kind: 'PipelineCycle'; readonly node: string; readonly cycle: readonly string[] }
  | {
      readonly kind: 'EdgeTypeMismatch';
      readonly node: string;
      readonly arg: string;
      readonly producer: string;
      readonly consumer: string;
    }
  | {
      readonly kind: 'PipelineForwardEdge';
      readonly node: string;
      readonly arg: string;
      readonly upstream: string;
    }
  | {
      readonly kind: 'PipelineOutputContradicts';
      readonly node: string;
      readonly capability: string;
      readonly declared: CapabilitySpace;
      readonly result: Returns;
    };

const SPACE_FAMILY: Record<CapabilitySpace['kind'], string> = {
  IntRange: 'int',
  FloatRange: 'float',
  StringLen: 'string',
  Enum: 'enum',
  AnyString: 'anyString',
  SlotTree: 'slotTree',
};

/** The upstream ids an invoke's `FromNode` edges name, in argument order. */
const upstreams = (n: PipelineNode): string[] =>
  n.kind === 'Source'
    ? []
    : n.args.flatMap((a) => (a.source.kind === 'FromNode' ? [a.source.node] : []));

/**
 * Does a node's declared output state what its capability answers (Core
 * 0.43.0)? It must admit every value of the declared result; a capability that
 * answers nothing has no output a node could declare.
 */
const outputStates = (declared: CapabilitySpace, result: Returns): boolean =>
  result.kind === 'Value' && capabilitySpaceSubsumes(declared, result.space);

/**
 * Type-check a pipeline against a registry. Node ids are unique; every
 * invoke's capability resolves (default-deny); its declared output admits the
 * capability's declared result (`PipelineOutputContradicts`, checked before the
 * arguments); an address is bound once (`DuplicateArg`); a literal is refused
 * as `validateArgs` refuses it; an edge names a node declared EARLIER — a
 * self-edge or one closing a cycle is `PipelineCycle` naming the cycle, any
 * other later node `PipelineForwardEdge` — whose output space feeds the hole's
 * (`EdgeTypeMismatch` otherwise); every required hole is bound. Total; the first
 * refusal in declaration order is the answer, `undefined` admits. Port of F#
 * `CapabilityPipeline.typeCheck`.
 */
export const typeCheckPipeline = (
  reg: CapabilityRegistry,
  p: CapabilityPipeline,
): PipelineError | undefined => {
  const ids = p.nodes.map((n) => n.id);
  const nodeById = new Map(p.nodes.map((n) => [n.id, n] as const));
  const position = new Map(ids.map((id, i) => [id, i] as const));

  // The path from `start` along edges to a node whose edge reaches `target`:
  // [start, …, x] with x -> target. Each node is visited once.
  const pathTo = (target: string, start: string): string[] | undefined => {
    const seen = new Set<string>();
    const walk = (cur: string): string[] | undefined => {
      if (seen.has(cur)) return undefined;
      seen.add(cur);
      const node = nodeById.get(cur);
      const ups = node === undefined ? [] : upstreams(node);
      if (ups.includes(target)) return [cur];
      for (const u of ups) {
        const path = walk(u);
        if (path !== undefined) return [cur, ...path];
      }
      return undefined;
    };
    return walk(start);
  };

  const counted = new Set<string>();
  for (const id of ids) {
    if (counted.has(id)) continue;
    counted.add(id);
    if (ids.filter((x) => x === id).length > 1) return { kind: 'DuplicateNode', id };
  }

  for (const n of p.nodes) {
    if (n.kind === 'Source') continue;
    const nid = n.id;
    const cap = tryFind(n.capabilityId, reg);
    if (cap === undefined)
      return {
        kind: 'PipelineNoSuchCapability',
        id: n.capabilityId,
        known: enumerate(reg).map((c) => c.id),
      };
    if (!outputStates(n.outputType, cap.result))
      return {
        kind: 'PipelineOutputContradicts',
        node: nid,
        capability: n.capabilityId,
        declared: n.outputType,
        result: cap.result,
      };

    const holes = cap.signature.holes;
    const declared = holes.map((h) => h.addr);

    const edgeFault = (
      addr: string,
      up: string,
      argSpace: CapabilitySpace,
    ): PipelineError | undefined => {
      const upNode = nodeById.get(up);
      if (upNode === undefined) return { kind: 'UnknownNode', id: up };
      if (up === nid) return { kind: 'PipelineCycle', node: nid, cycle: [nid] };
      if ((position.get(up) ?? 0) > (position.get(nid) ?? 0)) {
        const path = pathTo(nid, up);
        return path !== undefined
          ? { kind: 'PipelineCycle', node: nid, cycle: [nid, ...path] }
          : { kind: 'PipelineForwardEdge', node: nid, arg: addr, upstream: up };
      }
      return capabilitySpaceSubsumes(argSpace, upNode.outputType)
        ? undefined
        : {
            kind: 'EdgeTypeMismatch',
            node: nid,
            arg: addr,
            producer: SPACE_FAMILY[upNode.outputType.kind],
            consumer: SPACE_FAMILY[argSpace.kind],
          };
    };

    const refused = (reason: InvokeError): PipelineError => ({
      kind: 'PipelineArgRefused',
      node: nid,
      reason,
    });

    // An address bound twice is `DuplicateArg`, at its second occurrence, first.
    const bound = new Set<string>();
    for (const { addr } of n.args) {
      if (bound.has(addr)) return refused({ kind: 'DuplicateArg', addr });
      bound.add(addr);
    }

    for (const { addr, source } of n.args) {
      if (source.kind === 'Literal') {
        const fault = argFault(holes, declared, { addr, value: source.value });
        if (fault !== undefined) return refused(fault);
        continue;
      }
      const hole = holes.find((h) => h.addr === addr);
      if (hole === undefined) return refused({ kind: 'UnknownArg', addr, declared });
      const argSpace = invocationSpace(hole);
      if (argSpace === undefined) return refused({ kind: 'UninvocableArg', addr });
      const fault = edgeFault(addr, source.node, argSpace);
      if (fault !== undefined) return fault;
    }

    const unbound = holes.filter((h) => h.required && !bound.has(h.addr)).map((h) => h.addr);
    if (unbound.length > 0) return refused({ kind: 'RequiredArgsUnbound', addrs: unbound });
  }
  return undefined;
};
