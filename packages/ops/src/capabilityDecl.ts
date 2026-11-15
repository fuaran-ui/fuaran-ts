// ============================================================================
//  @fuaran-ui/ops/capabilityDecl — the canonical capability DECLARATION codec.
//
//  The invocation half of the capability contract (`Binding.Invoke` /
//  `Action.Invoke` and their `args`) has been in the canonical codec since
//  Phase 283. This is the DECLARATION half: the `{"$type":"capability",…}`
//  document that carries a capability's id, derived signature, declared result,
//  determinism and placement — what a registry publishes, what a peer registers from, and what
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
//  their hole kind, a signature the registry's admission gate admits, and a
//  REQUIRED declared result (Core 0.43.0) the gate admits too.
//
//  The capability-PIPELINE reader (`decodeCapabilityPipeline`) sits beside it
//  because it reads value spaces through the same reader. It is this module's,
//  not the package's: the conformance leg reads the reference's pipelines with
//  it, and the package root does not export it.
// ============================================================================

import {
  admissionOf,
  describeInvokeError,
  determinismTag,
  spaceFault,
  tryDeterminismOfTag,
  type CapabilityPipeline,
  type PipelineArg,
  type PipelineNode,
} from '@fuaran-ui/core-twins';
import type {
  Capability,
  CapabilitySigEntry,
  CapabilitySignature,
  HostEffect,
  IslandKind,
  Placement,
  Returns,
} from '@fuaran-ui/schema';

import { bool, caseObj, jArray, jObject, num, str, type Field } from './encode.js';

/**
 * The reference reader's decode codes this codec names (F# `DecodeCode`), for
 * the refusals it types: a member that is absent, one of the wrong JSON kind, a
 * tag outside the set, and a value the admission gate refuses.
 */
export type CapabilityDeclCode = 'MissingField' | 'WrongKind' | 'UnknownTag' | 'OutOfRange';

/**
 * A total codec result — a value, or a named refusal. Never a throw. A refusal
 * of the declared result (Core 0.43.0) also names its decode `code` and the
 * `path` of member keys from the declaration root to the fault, as the
 * reference's typed reader does and the shared law vectors pin; the codec's
 * other refusals are sentences, and carry neither.
 */
export type CapabilityDeclResult<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly error: string;
      readonly code?: CapabilityDeclCode;
      readonly path?: readonly string[];
    };

const dok = <T>(value: T): CapabilityDeclResult<T> => ({ ok: true, value });

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

// The declared result (Core 0.43.0): a value's space is the space document
// itself, and "returns nothing" the one document `{"$type":"nothing"}`, whose
// tag no value space uses.
const resultJson = (r: Returns): string =>
  r.kind === 'Nothing' ? caseObj('nothing', []) : spaceJson(r.space);

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
    ['result', resultJson(cap.result)],
    ['determinism', str(determinismTag(cap.determinism))],
    ['placement', placementJson(cap.placement)],
  ]);

// ─── Decode ──────────────────────────────────────────────────────────────────
//
// Order-tolerant (fields are looked up by name) and default-deny by shape: a
// field of the wrong type, an unknown tag, or a member this host cannot carry
// is a NAMED refusal, never a half-built capability.

class DeclError extends Error {
  constructor(
    message: string,
    readonly code?: CapabilityDeclCode,
    readonly path?: readonly string[],
  ) {
    super(message);
  }
}

// The explicit annotation on the CONST is load-bearing, not decoration: TS only
// treats a call as control-flow-terminating when the callee is a name with a
// declared `never` return type, so without it every guard below would need a
// cast to convince the checker the refused branch cannot continue.
const fail: (message: string) => never = (message) => {
  throw new DeclError(message);
};

/** A refusal that names the reference's decode code and the path to the fault. */
const failAt: (code: CapabilityDeclCode, path: readonly string[], message: string) => never = (
  code,
  path,
  message,
) => {
  throw new DeclError(`${code} at ${path.join('.')}: ${message}`, code, path);
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

/**
 * The declared result, read as `resultJson` writes it and dispatched on
 * `$type` (Core 0.43.0): `nothing`, or a value space. It is REQUIRED — absent is
 * `MissingField` at `result` — JSON `null` is not a spelling of nothing
 * (`WrongKind`), a tag outside the set is `UnknownTag` at `result.$type`, and a
 * space the admission gate refuses is `OutOfRange` at `result`, refused with the
 * registry's own error. A malformed space below the tag is the space reader's
 * sentence.
 */
const resultOf = (o: Record<string, unknown>, id: string, sg: CapabilitySignature): Returns => {
  if (!('result' in o)) failAt('MissingField', ['result'], 'a capability declares its result');
  const raw = o['result'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    failAt('WrongKind', ['result'], 'a declared result is an object');
  const r = raw as Record<string, unknown>;
  if (!('$type' in r))
    failAt('MissingField', ['result', '$type'], 'a declared result names its $type');
  const tag = r['$type'];
  if (typeof tag !== 'string') failAt('WrongKind', ['result', '$type'], '$type is a string');
  let result: Returns;
  if (tag === 'nothing') result = { kind: 'Nothing' };
  else if (SPACE_OF[tag as string] !== undefined) {
    try {
      result = { kind: 'Value', space: spaceOf(r) };
    } catch (e) {
      if (e instanceof DeclError) fail(`result: ${e.message}`);
      throw e;
    }
  } else
    failAt(
      'UnknownTag',
      ['result', '$type'],
      `$type '${String(tag)}'; expected one of: ${[...Object.values(SPACE_WIRE), 'nothing'].join(', ')}`,
    );
  const refused = admissionOf(id, sg, result);
  if (refused !== undefined) failAt('OutOfRange', ['result'], describeInvokeError(refused));
  return result;
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
  // refused with the registry's own error — the signature first, then the
  // declared result (Core 0.43.0), as the reference's reader orders them.
  const id = strAt(o, 'id');
  const refused = admissionOf(id, signature);
  if (refused !== undefined) fail(`signature.holes: ${describeInvokeError(refused)}`);
  const result = resultOf(o, id, signature);

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
    result,
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
    if (e instanceof DeclError) return refusal(e);
    throw e;
  }
};

const refusal = (e: DeclError): CapabilityDeclResult<never> =>
  e.code === undefined || e.path === undefined
    ? { ok: false, error: e.message }
    : { ok: false, error: e.message, code: e.code, path: e.path };

// ─── The capability pipeline (Core's pipeline wire) ─────────────────────────
//
// `{"nodes":[…]}`, each node `{"$type":"source","id","dataRef","outputType"}` or
// `{"$type":"invoke","id","capabilityId","outputType","args":[{"addr","source"}]}`,
// a source `{"$type":"literal","value"}` or `{"$type":"fromNode","node"}`. A
// declared `outputType` is held to the space admission check, so an empty or
// non-finite one is refused on read.

const outputTypeOf = (raw: unknown): CapabilitySpace => {
  const space = spaceOf(raw);
  const fault = spaceFault(space);
  if (fault === 'Empty') fail('outputType: empty value-space');
  if (fault === 'NonFinite') fail('outputType: value-space bound is not a finite number');
  return space;
};

const pipelineArgOf = (raw: unknown): PipelineArg => {
  const o = asObject(raw, 'pipeline argument');
  const src = asObject(o['source'], 'argument source');
  const tag = strAt(src, '$type');
  if (tag === 'literal')
    return { addr: strAt(o, 'addr'), source: { kind: 'Literal', value: strAt(src, 'value') } };
  if (tag === 'fromNode')
    return { addr: strAt(o, 'addr'), source: { kind: 'FromNode', node: strAt(src, 'node') } };
  return fail(`unknown argument source: ${tag}; expected one of: literal, fromNode`);
};

const pipelineNodeOf = (raw: unknown): PipelineNode => {
  const o = asObject(raw, 'pipeline node');
  const tag = strAt(o, '$type');
  if (tag === 'source')
    return {
      kind: 'Source',
      id: strAt(o, 'id'),
      dataRef: strAt(o, 'dataRef'),
      outputType: outputTypeOf(o['outputType']),
    };
  if (tag === 'invoke') {
    const args = o['args'];
    if (!Array.isArray(args)) fail('missing or non-array field: args');
    return {
      kind: 'Invoke',
      id: strAt(o, 'id'),
      capabilityId: strAt(o, 'capabilityId'),
      outputType: outputTypeOf(o['outputType']),
      args: (args as unknown[]).map(pipelineArgOf),
    };
  }
  return fail(`unknown pipeline node: ${tag}; expected one of: source, invoke`);
};

/**
 * Decode a capability pipeline from its wire text. Total — a malformed pipeline
 * yields `{ ok: false, error }` naming what was wrong, never a throw. It reads
 * the shape only: whether the pipeline type-checks against a registry is the
 * twin's `typeCheckPipeline`.
 */
export const decodeCapabilityPipeline = (
  json: string,
): CapabilityDeclResult<CapabilityPipeline> => {
  try {
    let parsed: unknown;
    try {
      parsed = JSON.parse(json);
    } catch {
      return fail('capability pipeline is not well-formed JSON');
    }
    const nodes = asObject(parsed, 'capability pipeline')['nodes'];
    if (!Array.isArray(nodes)) fail('missing or non-array field: nodes');
    return dok({ nodes: (nodes as unknown[]).map(pipelineNodeOf) });
  } catch (e) {
    if (e instanceof DeclError) return refusal(e);
    throw e;
  }
};
