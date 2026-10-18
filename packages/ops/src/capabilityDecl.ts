// ============================================================================
//  @fuaran-ui/ops/capabilityDecl — the canonical capability DECLARATION codec.
//
//  The invocation half of the capability contract (`Binding.Invoke` /
//  `Action.Invoke` and their `args`) has been in the canonical codec since
//  Phase 283. This is the DECLARATION half: the `{"$type":"capability",…}`
//  document that carries a capability's id, derived signature, determinism and
//  placement — what a registry publishes, what a peer registers from, and what
//  the reference's `declarationRoundTrip` conformance law compares against.
//
//  WHY IT LIVES HERE, and why the types it ranges over live in
//  `@fuaran-ui/schema`. The declaration is canonical JSON, so its encoder must
//  BE this host's canonical encoder — the same `str` escape rule, the same
//  Ordinal key order, the same pinned `formatFiniteDouble` number layout — and
//  those are in this package. The capability RUNTIME (validate / invocationKey
//  / registry / invoker) is in `@fuaran-ui/ui`, which does not depend on this
//  package and must not start to. Moving the five declaration types down into
//  `@fuaran-ui/schema` — which both already depend on — is what lets the codec
//  ship here and the runtime stay there, with neither importing the other.
//
//  Until this module existed the round-trip law ran against a HARNESS-LOCAL
//  codec in `test/capabilityLaws.test.ts`: a real assertion (the input bytes
//  are the reference's), but not one a CONSUMER could call. It now runs against
//  this, so the bytes the law certifies and the bytes the package ships are the
//  same bytes by construction rather than by review.
//
//  Decoding is TOTAL — a named refusal in the `{ ok: false, error }` envelope,
//  never a throw — matching `liveValueToTable` and the decoder's own posture.
//  It admits what the reference's reader admits at the Core version the
//  capability twin mirrors (`mirroredCoreVersion`): a document whose `$type` is
//  `capability`, a determinism set in its canonical label, entries read as
//  their hole kind, and a signature the registry's admission gate admits.
// ============================================================================

import {
  admissionOf,
  describeInvokeError,
  determinismTag,
  tryDeterminismOfTag,
} from '@fuaran-ui/core-twins';
import type {
  Capability,
  CapabilitySigEntry,
  CapabilitySignature,
  HostEffect,
  IslandKind,
  Placement,
} from '@fuaran-ui/schema';

import { bool, caseObj, jArray, jObject, num, str, type Field } from './encode.js';

/** A total codec result — a value, or a named refusal. Never a throw. */
export type CapabilityDeclResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const dok = <T>(value: T): CapabilityDeclResult<T> => ({ ok: true, value });
const derr = (error: string): CapabilityDeclResult<never> => ({ ok: false, error });

// ─── The wire vocabularies ───────────────────────────────────────────────────
//
// Each axis's in-memory tag ⇄ wire tag mapping, declared once and inverted for
// the decoder, so the two halves cannot drift into disagreeing about a spelling.

const HOST_WIRE: Record<HostEffect, string> = {
  Pure: 'pure',
  ReadsHost: 'readsHost',
  WritesHost: 'writesHost',
};

const PLACEMENT_WIRE: Record<Placement['kind'], string> = {
  BuildTime: 'buildTime',
  Server: 'server',
  ClientDeclarative: 'clientDeclarative',
  ClientIsland: 'clientIsland',
  Precomputed: 'precomputed',
};

/** A signature entry's value space: a `HoleValueSpace`, or the tree space `SlotTree`. */
type CapabilitySpace = NonNullable<CapabilitySigEntry['space']>;

const SPACE_WIRE: Record<CapabilitySpace['kind'], string> = {
  IntRange: 'intRange',
  FloatRange: 'floatRange',
  StringLen: 'stringLen',
  Enum: 'enum',
  AnyString: 'anyString',
  SlotTree: 'slotTree',
};

const ISLANDS: readonly IslandKind[] = ['pyodide', 'fable', 'js'];

const invert = <K extends string>(m: Record<K, string>): Record<string, K> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v as string, k as K])) as Record<string, K>;

const HOST_OF = invert(HOST_WIRE);
const PLACEMENT_OF = invert(PLACEMENT_WIRE);
const SPACE_OF = invert(SPACE_WIRE);

// ─── Encode ──────────────────────────────────────────────────────────────────

const spaceJson = (s: CapabilitySpace): string => {
  switch (s.kind) {
    case 'IntRange':
      return caseObj(SPACE_WIRE[s.kind], [
        ['min', num(s.min)],
        ['max', num(s.max)],
      ]);
    case 'FloatRange':
      return caseObj(SPACE_WIRE[s.kind], [
        ['min', num(s.min)],
        ['max', num(s.max)],
      ]);
    case 'StringLen':
      return caseObj(SPACE_WIRE[s.kind], [
        ['min', num(s.minLen)],
        ['max', num(s.maxLen)],
      ]);
    case 'Enum':
      return caseObj(SPACE_WIRE[s.kind], [['values', jArray(s.choices.map(str))]]);
    case 'AnyString':
      return caseObj(SPACE_WIRE[s.kind], []);
    case 'SlotTree':
      // The explicit tree space (fuaran-core#229); the constraint is omitted
      // when there is none (WIRE_FORMAT.md §2 — absence, never `null`).
      return caseObj(
        SPACE_WIRE[s.kind],
        s.slotKind !== undefined ? [['slotKind', str(s.slotKind)]] : [],
      );
  }
};

const entryJson = (e: CapabilitySigEntry): string => {
  const fields: Field[] = [
    ['addr', str(e.addr)],
    ['name', str(e.name)],
    ['kind', str(e.kind)],
    ['required', bool(e.required)],
  ];
  // Option fields are OMITTED when absent, never `null` (WIRE_FORMAT.md §2). A
  // slot entry writes its constraint and NO space (Core 0.37.0, fuaran-core
  // Phase 409): its space is the tree space of that constraint, never its own.
  if (e.space !== undefined && e.kind !== 'slot') fields.push(['space', spaceJson(e.space)]);
  if (e.slotKind !== undefined) fields.push(['slotKind', str(e.slotKind)]);
  return jObject(fields);
};

const placementJson = (p: Placement): string =>
  p.kind === 'ClientIsland'
    ? caseObj(PLACEMENT_WIRE[p.kind], [['island', str(p.island)]])
    : caseObj(PLACEMENT_WIRE[p.kind], []);

const signatureJson = (sg: CapabilitySignature): string =>
  jObject([
    ['name', str(sg.name)],
    [
      'effect',
      jObject([
        ['host', str(HOST_WIRE[sg.effect.hostEffect])],
        ['determinism', str(determinismTag(sg.effect.determinism))],
      ]),
    ],
    ['holes', jArray(sg.holes.map(entryJson))],
  ]);

/**
 * Encode a capability declaration to its canonical-JSON string. Total: every
 * field of every case is representable, so there is nothing to refuse.
 */
export const encodeCapabilityDeclaration = (cap: Capability): string =>
  caseObj('capability', [
    ['id', str(cap.id)],
    ['signature', signatureJson(cap.signature)],
    ['determinism', str(determinismTag(cap.determinism))],
    ['placement', placementJson(cap.placement)],
  ]);

// ─── Decode ──────────────────────────────────────────────────────────────────
//
// Order-tolerant (fields are looked up by name) and default-deny by shape: a
// field of the wrong type, an unknown tag, or a member this host cannot carry
// is a NAMED refusal, never a half-built capability.

class DeclError extends Error {}

// The explicit annotation on the CONST is load-bearing, not decoration: TS only
// treats a call as control-flow-terminating when the callee is a name with a
// declared `never` return type, so without it every guard below would need a
// cast to convince the checker the refused branch cannot continue.
const fail: (message: string) => never = (message) => {
  throw new DeclError(message);
};

const asObject = (v: unknown, what: string): Record<string, unknown> =>
  typeof v !== 'object' || v === null || Array.isArray(v)
    ? fail(`${what} is not an object`)
    : (v as Record<string, unknown>);

const strAt = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  return typeof v === 'string' ? v : fail(`missing or non-string field: ${k}`);
};

const numAt = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : fail(`missing or non-finite numeric field: ${k}`);
};

const spaceOf = (raw: unknown): CapabilitySpace => {
  const o = asObject(raw, 'value-space');
  const tag = strAt(o, '$type');
  const kind = SPACE_OF[tag];
  switch (kind) {
    case 'IntRange':
      return { kind, min: numAt(o, 'min'), max: numAt(o, 'max') };
    case 'FloatRange':
      return { kind, min: numAt(o, 'min'), max: numAt(o, 'max') };
    case 'StringLen':
      return { kind, minLen: numAt(o, 'min'), maxLen: numAt(o, 'max') };
    case 'Enum': {
      const values = o['values'];
      if (!Array.isArray(values) || values.some((x) => typeof x !== 'string'))
        fail('enum values must be a string array');
      return { kind, choices: values as string[] };
    }
    case 'AnyString':
      return { kind };
    case 'SlotTree':
      return 'slotKind' in o ? { kind, slotKind: strAt(o, 'slotKind') } : { kind };
    default:
      return fail(
        `unknown value-space kind: ${tag}; expected one of: ${Object.values(SPACE_WIRE).join(', ')}`,
      );
  }
};

const entryOf = (raw: unknown): CapabilitySigEntry => {
  const o = asObject(raw, 'signature hole');
  if ('actionEffect' in o) {
    // A named refusal rather than a silent drop: this host's
    // `CapabilitySigEntry` carries no action-effect axis, so an entry declaring
    // one cannot survive a round trip. Dropping it would let the round-trip law
    // pass on a declaration this host had silently narrowed.
    fail(
      "this host's signature entry carries no action-effect axis, so a hole declaring `actionEffect` cannot round-trip",
    );
  }
  const kind = strAt(o, 'kind');
  if (kind !== 'value' && kind !== 'slot' && kind !== 'repeat')
    fail(`unknown hole kind: ${kind}; expected one of: value, slot, repeat`);
  const required = o['required'];
  if (typeof required !== 'boolean') fail('missing or non-boolean field: required');
  const addr = strAt(o, 'addr');
  const name = strAt(o, 'name');
  // The entry is read as its hole kind (Core 0.37.0, fuaran-core Phase 409): a
  // value or repeat entry without the `space` its kind needs is refused, and a
  // slot entry is its constraint — a `space` it still carries (the pre-0.37.0
  // encoding wrote one) is read, so a malformed one is refused as before, and is
  // not part of the entry.
  const space = 'space' in o ? spaceOf(o['space']) : undefined;
  if (space === undefined && kind !== 'slot') fail('missing field: space');
  return {
    addr,
    name,
    kind,
    required,
    ...(space !== undefined && kind !== 'slot' ? { space } : {}),
    ...('slotKind' in o ? { slotKind: strAt(o, 'slotKind') } : {}),
  };
};

const placementOf = (raw: unknown): Placement => {
  const o = asObject(raw, 'placement');
  const tag = strAt(o, '$type');
  const kind = PLACEMENT_OF[tag];
  if (kind === undefined)
    fail(`unknown placement: ${tag}; expected one of: ${Object.values(PLACEMENT_WIRE).join(', ')}`);
  if (kind === 'ClientIsland') {
    const island = strAt(o, 'island');
    if (!ISLANDS.includes(island as IslandKind))
      fail(`unknown island kind: ${island}; expected one of: ${ISLANDS.join(', ')}`);
    return { kind, island: island as IslandKind };
  }
  return { kind } as Placement;
};

const declarationOf = (json: string): Capability => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return fail('capability declaration is not well-formed JSON');
  }
  const o = asObject(parsed, 'capability declaration');
  // A capability document says so (Core 0.35.1, fuaran-core Phase 307): an
  // absent `$type` is refused as a missing field, never read as a capability.
  const tag = o['$type'];
  if (tag === undefined) fail('missing field: $type');
  if (tag !== 'capability') fail(`not a capability declaration: $type '${String(tag)}'`);

  const sigObj = asObject(o['signature'], 'signature');
  const effectObj = asObject(sigObj['effect'], 'effect');

  const hostTag = strAt(effectObj, 'host');
  const hostEffect = HOST_OF[hostTag];
  if (hostEffect === undefined)
    fail(
      `unknown host effect: ${hostTag}; expected one of: ${Object.values(HOST_WIRE).join(', ')}`,
    );
  // The determinism set, read from its canonical label only (Core 0.33.0,
  // fuaran-core Phase 319): `clock+random` is a set, `random+clock` is not a
  // label, so a set has one wire spelling.
  const detTag = strAt(effectObj, 'determinism');
  const determinism = tryDeterminismOfTag(detTag) ?? fail(`unknown determinism: ${detTag}`);

  const holes = sigObj['holes'];
  if (!Array.isArray(holes)) fail('missing or non-array field: holes');

  const signature: CapabilitySignature = {
    name: strAt(sigObj, 'name'),
    holes: (holes as unknown[]).map(entryOf),
    effect: { hostEffect, determinism },
  };

  // The registry's admission gate runs over the signature just read, so a
  // declaration that decodes is one `register` admits, and a refused one is
  // refused with the registry's own error.
  const id = strAt(o, 'id');
  const refused = admissionOf(id, signature);
  if (refused !== undefined) fail(`signature.holes: ${describeInvokeError(refused)}`);

  // The capability's determinism is derivable from its signature's effect, so a
  // disagreement is a tampered or divergent payload rather than a spelling
  // difference — refuse it by name instead of silently preferring one side,
  // which would key the replay seam under a determinism the declaration does
  // not declare.
  const wireTag = strAt(o, 'determinism');
  const expectedTag = detTag;
  if (wireTag !== expectedTag)
    fail(
      `capability determinism disagrees with signature effect: wire '${wireTag}' vs signature '${expectedTag}'`,
    );

  return {
    id,
    signature,
    determinism,
    placement: placementOf(o['placement']),
  };
};

/**
 * Decode a canonical capability-declaration string. Total — a malformed or
 * un-carryable declaration yields `{ ok: false, error }` naming what was wrong,
 * never an exception and never a partially-built capability.
 */
export const decodeCapabilityDeclaration = (json: string): CapabilityDeclResult<Capability> => {
  try {
    return dok(declarationOf(json));
  } catch (e) {
    if (e instanceof DeclError) return derr(e.message);
    throw e;
  }
};
