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
// ============================================================================

import type {
  Capability,
  CapabilitySigEntry,
  CapabilitySignature,
  DeterminismSource,
  HoleValueSpace,
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

const DETERMINISM_WIRE: Record<DeterminismSource, string> = {
  Deterministic: 'deterministic',
  Clock: 'clock',
  Random: 'random',
  Network: 'network',
};

const PLACEMENT_WIRE: Record<Placement['kind'], string> = {
  BuildTime: 'buildTime',
  Server: 'server',
  ClientDeclarative: 'clientDeclarative',
  ClientIsland: 'clientIsland',
  Precomputed: 'precomputed',
};

const SPACE_WIRE: Record<HoleValueSpace['kind'], string> = {
  IntRange: 'intRange',
  FloatRange: 'floatRange',
  StringLen: 'stringLen',
  Enum: 'enum',
  AnyString: 'anyString',
};

const ISLANDS: readonly IslandKind[] = ['pyodide', 'fable', 'js'];

const invert = <K extends string>(m: Record<K, string>): Record<string, K> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v as string, k as K])) as Record<string, K>;

const HOST_OF = invert(HOST_WIRE);
const DETERMINISM_OF = invert(DETERMINISM_WIRE);
const PLACEMENT_OF = invert(PLACEMENT_WIRE);
const SPACE_OF = invert(SPACE_WIRE);

// ─── Encode ──────────────────────────────────────────────────────────────────

const spaceJson = (s: HoleValueSpace): string => {
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
  }
};

const entryJson = (e: CapabilitySigEntry): string => {
  const fields: Field[] = [
    ['addr', str(e.addr)],
    ['name', str(e.name)],
    ['kind', str(e.kind)],
    ['required', bool(e.required)],
  ];
  // Option fields are OMITTED when absent, never `null` (WIRE_FORMAT.md §2).
  if (e.space !== undefined) fields.push(['space', spaceJson(e.space)]);
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
        ['determinism', str(DETERMINISM_WIRE[sg.effect.determinism])],
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
    ['determinism', str(DETERMINISM_WIRE[cap.determinism])],
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

const spaceOf = (raw: unknown): HoleValueSpace => {
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
  return {
    addr: strAt(o, 'addr'),
    name: strAt(o, 'name'),
    kind,
    required,
    ...('space' in o ? { space: spaceOf(o['space']) } : {}),
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
  const tag = o['$type'];
  if (tag !== undefined && tag !== 'capability')
    fail(`not a capability declaration: $type '${String(tag)}'`);

  const sigObj = asObject(o['signature'], 'signature');
  const effectObj = asObject(sigObj['effect'], 'effect');

  const hostTag = strAt(effectObj, 'host');
  const hostEffect = HOST_OF[hostTag];
  if (hostEffect === undefined)
    fail(
      `unknown host effect: ${hostTag}; expected one of: ${Object.values(HOST_WIRE).join(', ')}`,
    );
  const detTag = strAt(effectObj, 'determinism');
  const determinism = DETERMINISM_OF[detTag];
  if (determinism === undefined)
    fail(
      `unknown determinism: ${detTag}; expected one of: ${Object.values(DETERMINISM_WIRE).join(', ')}`,
    );

  const holes = sigObj['holes'];
  if (!Array.isArray(holes)) fail('missing or non-array field: holes');

  const signature: CapabilitySignature = {
    name: strAt(sigObj, 'name'),
    holes: (holes as unknown[]).map(entryOf),
    effect: { hostEffect, determinism },
  };

  // The capability's determinism is derivable from its signature's effect, so a
  // disagreement is a tampered or divergent payload rather than a spelling
  // difference — refuse it by name instead of silently preferring one side,
  // which would key the replay seam under a determinism the declaration does
  // not declare.
  const wireTag = strAt(o, 'determinism');
  const expectedTag = DETERMINISM_WIRE[determinism];
  if (wireTag !== expectedTag)
    fail(
      `capability determinism disagrees with signature effect: wire '${wireTag}' vs signature '${expectedTag}'`,
    );

  return {
    id: strAt(o, 'id'),
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
