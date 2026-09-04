// ============================================================================
//  Phase 1482 — this host runs the reference's own capability-law vectors.
//
//  The shared corpus's `laws/` family carries the (input, expected) pairs the
//  reference host's `capabilityLaws` conformance family DRAWS from a declared
//  seed, each expectation computed by calling the pinned reference kit. Before
//  this leg existed, `@fuaran-ui/ui`'s capability surface agreed with the
//  reference only by having been written from the same description — a claim
//  nothing could falsify. Running the reference's own sample here makes it
//  falsifiable: a divergence names the vector id.
//
//  Four cases, all four run:
//    - validateArgs         — accept, or a named refusal at a named address.
//    - invocationKey        — the replay key and the determinism tag (see the
//                             named partial below).
//    - declarationRoundTrip — decode-then-encode returns the REFERENCE's bytes.
//    - registryEnumerate    — id-sorted enumeration, whatever the insertion order.
//
//  WHERE THE CODEC LIVES, and why it is here rather than in a package. The
//  three runtime cases run against SHIPPED ports (`validateArgs`,
//  `invocationKey`, `capabilityDeterminismTag`, `registryOf` + `enumerate`) —
//  those are the surface the reference's law family certifies and the surface
//  this host mirrors. The capability DECLARATION codec is the one member of the
//  family this host ships nowhere: `@fuaran-ui/ui` holds the capability types
//  but not a canonical renderer, and `@fuaran-ui/ops` holds the canonical
//  renderer but not the types. Placing a shipped codec on either side is a
//  public-surface decision (a peer dependency one way, a type move the other),
//  which is not this leg's to make — so the codec below is HARNESS-LOCAL,
//  written over ops's own canonical number and escape rules so the bytes it
//  emits are this host's canonical bytes and not a second convention.
//
//  That still makes `declarationRoundTrip` a real assertion rather than a
//  self-consistency check: the INPUT bytes were produced by the reference, and
//  a decode-then-encode that disagreed on member order, escaping or number form
//  would fail against them. What it does not yet do is certify a codec a
//  CONSUMER can call — that is the successor.
//
//  ONE named partial, deliberately not silent. An `invocationKey` vector also
//  carries `capturedValue`: the value a capture-replay seam must return
//  byte-identically for that key. This host ships no capture/replay effect seam
//  (`@fuaran-ui/op-stream` persists and replays TREE OPS, not effect captures),
//  so there is nothing here for the value to travel through — asserting it
//  would mean comparing the number to itself. The count is reported rather than
//  passing quietly, because a partial nobody can see is indistinguishable from
//  a complete one.
//
//  The seed and vector count are read from the family manifest, never restated
//  here: a count in prose drifts the first time the sample is regenerated.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

// The capability ports under test live in the sibling `@fuaran-ui/ui` package
// and are imported from its BUILT output by path rather than by package name,
// deliberately, for two reasons. Naming the package would add a dev dependency,
// and adding any dependency to a manifest in this workspace forces pnpm to
// re-resolve the whole lockfile — which currently fails on an unrelated
// auto-installed peer in `templates/ts-starter`, so a manifest edit here would
// take the install down with it. And reaching into the sibling's `src/` instead
// would put a file outside this project's `rootDir` (TS6059). `dist/` is what
// the package publishes and what every other cross-package import in this
// workspace resolves, so this reads exactly the surface a consumer would —
// which does mean `pnpm build` must have run, as it must for the corpus legs.
import {
  capabilityDeterminismTag,
  enumerate,
  invocationKey,
  registryOf,
  validateArgs,
  type Capability,
  type CapabilitySigEntry,
  type CapabilitySignature,
  type IslandKind,
  type Placement,
} from '../../ui/dist/index.js';
import type { DeterminismSource, HoleValueSpace, HostEffect, InvokeArg } from '@fuaran-ui/schema';

import { formatFiniteDouble } from '../src/encode.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures/laws
const lawsRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'laws');

// ─── the family manifest ─────────────────────────────────────────────────────

interface LawFamily {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly kitVersion: string;
  readonly seed: number;
  readonly iterations: number;
  readonly vectors: number;
}

interface LawManifest {
  readonly version: number;
  readonly families: readonly LawFamily[];
}

interface CapabilityVector {
  readonly id: string;
  readonly case: string;
  readonly input: {
    readonly capability?: string;
    readonly declaration?: string;
    readonly declarations?: readonly string[];
    readonly args?: readonly InvokeArg[];
  };
  readonly expected: {
    readonly verdict?: string;
    readonly error?: string;
    readonly addr?: string;
    readonly key?: string;
    readonly determinismTag?: string;
    readonly declaration?: string;
    readonly ids?: readonly string[];
  };
}

interface CapabilityLawFile {
  readonly family: string;
  readonly kitVersion: string;
  readonly seed: number;
  readonly iterations: number;
  readonly vectors: readonly CapabilityVector[];
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const manifest = readJson<LawManifest>(join(lawsRoot, 'manifest.json'));
const family = manifest?.families.find((f) => f.id === 'capabilityLaws');
const lawFile = family ? readJson<CapabilityLawFile>(join(lawsRoot, family.file)) : undefined;

// ─── the harness-local declaration codec ─────────────────────────────────────
//
// Canonical form: object keys Ordinal-sorted at every level (`$type`, U+0024,
// sorts before every lower-case data key), strings escaped with `"` / `\` /
// the C0 controls and nothing else, and floats through the host's one pinned
// layout. Decoding is order-tolerant — it looks fields up by name.

type JVal =
  | { readonly t: 'str'; readonly v: string }
  | { readonly t: 'int'; readonly v: number }
  | { readonly t: 'float'; readonly v: number }
  | { readonly t: 'bool'; readonly v: boolean }
  | { readonly t: 'arr'; readonly v: readonly JVal[] }
  | { readonly t: 'obj'; readonly v: readonly (readonly [string, JVal])[] };

const jstr = (v: string): JVal => ({ t: 'str', v });
const jint = (v: number): JVal => ({ t: 'int', v });
const jbool = (v: boolean): JVal => ({ t: 'bool', v });
const jarr = (v: readonly JVal[]): JVal => ({ t: 'arr', v });
const jobj = (v: readonly (readonly [string, JVal])[]): JVal => ({ t: 'obj', v });
/** A `$type`-discriminated object — the DU-position convention. */
const jtyped = (tag: string, fields: readonly (readonly [string, JVal])[]): JVal =>
  jobj([['$type', jstr(tag)], ...fields]);

const escape = (s: string): string => {
  let out = '';
  for (const ch of s) {
    const code = ch.codePointAt(0) ?? 0;
    if (ch === '"') out += '\\"';
    else if (ch === '\\') out += '\\\\';
    else if (code < 0x20) out += `\\u${code.toString(16).padStart(4, '0')}`;
    else out += ch;
  }
  return `"${out}"`;
};

const render = (v: JVal): string => {
  switch (v.t) {
    case 'str':
      return escape(v.v);
    case 'int':
      return String(v.v);
    case 'float':
      // The negative-zero collapse and the .NET "R" layout are both
      // formatFiniteDouble's; nothing about the number form is restated here.
      return formatFiniteDouble(v.v);
    case 'bool':
      return v.v ? 'true' : 'false';
    case 'arr':
      return `[${v.v.map(render).join(',')}]`;
    case 'obj':
      return `{${[...v.v]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([k, val]) => `${escape(k)}:${render(val)}`)
        .join(',')}}`;
  }
};

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

const invert = <K extends string>(m: Record<K, string>): Record<string, K> =>
  Object.fromEntries(Object.entries(m).map(([k, v]) => [v as string, k as K])) as Record<string, K>;

const HOST_OF = invert(HOST_WIRE);
const DETERMINISM_OF = invert(DETERMINISM_WIRE);
const PLACEMENT_OF = invert(PLACEMENT_WIRE);
const SPACE_OF = invert(SPACE_WIRE);

const spaceJson = (s: HoleValueSpace): JVal => {
  switch (s.kind) {
    case 'IntRange':
      return jtyped('intRange', [
        ['min', jint(s.min)],
        ['max', jint(s.max)],
      ]);
    case 'FloatRange':
      return jtyped('floatRange', [
        ['min', { t: 'float', v: s.min }],
        ['max', { t: 'float', v: s.max }],
      ]);
    case 'StringLen':
      return jtyped('stringLen', [
        ['min', jint(s.minLen)],
        ['max', jint(s.maxLen)],
      ]);
    case 'Enum':
      return jtyped('enum', [['values', jarr(s.choices.map(jstr))]]);
    case 'AnyString':
      return jtyped('anyString', []);
  }
};

const effectJson = (host: HostEffect, determinism: DeterminismSource): JVal =>
  jobj([
    ['host', jstr(HOST_WIRE[host])],
    ['determinism', jstr(DETERMINISM_WIRE[determinism])],
  ]);

const entryJson = (e: CapabilitySigEntry): JVal => {
  const fields: (readonly [string, JVal])[] = [
    ['addr', jstr(e.addr)],
    ['name', jstr(e.name)],
    ['kind', jstr(e.kind)],
    ['required', jbool(e.required)],
  ];
  if (e.space !== undefined) fields.push(['space', spaceJson(e.space)]);
  if (e.slotKind !== undefined) fields.push(['slotKind', jstr(e.slotKind)]);
  return jobj(fields);
};

const placementJson = (p: Placement): JVal =>
  p.kind === 'ClientIsland'
    ? jtyped('clientIsland', [['island', jstr(p.island)]])
    : jtyped(PLACEMENT_WIRE[p.kind], []);

const encodeDeclaration = (cap: Capability): string =>
  render(
    jtyped('capability', [
      ['id', jstr(cap.id)],
      [
        'signature',
        jobj([
          ['name', jstr(cap.signature.name)],
          ['effect', effectJson(cap.signature.effect.hostEffect, cap.signature.effect.determinism)],
          ['holes', jarr(cap.signature.holes.map(entryJson))],
        ]),
      ],
      ['determinism', jstr(DETERMINISM_WIRE[cap.determinism])],
      ['placement', placementJson(cap.placement)],
    ]),
  );

// The decoder half. `unknown`-typed field access with named refusals — a
// malformed declaration must name what it got wrong rather than yield a
// half-built capability.

const asObject = (v: unknown, what: string): Record<string, unknown> => {
  if (typeof v !== 'object' || v === null || Array.isArray(v))
    throw new Error(`${what} is not an object`);
  return v as Record<string, unknown>;
};

const strAt = (o: Record<string, unknown>, k: string): string => {
  const v = o[k];
  if (typeof v !== 'string') throw new Error(`missing or non-string field: ${k}`);
  return v;
};

const numAt = (o: Record<string, unknown>, k: string): number => {
  const v = o[k];
  if (typeof v !== 'number' || !Number.isFinite(v))
    throw new Error(`missing or non-finite numeric field: ${k}`);
  return v;
};

const spaceOf = (raw: unknown): HoleValueSpace => {
  const o = asObject(raw, 'value-space');
  const kind = SPACE_OF[strAt(o, '$type')];
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
        throw new Error('enum values must be a string array');
      return { kind, choices: values as string[] };
    }
    case 'AnyString':
      return { kind };
    default:
      throw new Error(`unknown value-space kind: ${strAt(o, '$type')}`);
  }
};

const entryOf = (raw: unknown): CapabilitySigEntry => {
  const o = asObject(raw, 'signature hole');
  if ('actionEffect' in o) {
    // Named refusal rather than a silent drop: this host's CapabilitySigEntry
    // carries no action-effect axis, so an entry declaring one cannot survive
    // a round trip. Dropping it would make the round-trip law pass on a
    // declaration this host had silently narrowed.
    throw new Error(
      "this host's signature entry carries no action-effect axis, so a hole declaring `actionEffect` cannot round-trip",
    );
  }
  const kind = strAt(o, 'kind');
  if (kind !== 'value' && kind !== 'slot' && kind !== 'repeat')
    throw new Error(`unknown hole kind: ${kind}`);
  const required = o['required'];
  if (typeof required !== 'boolean') throw new Error('missing or non-boolean field: required');
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
  if (kind === undefined) throw new Error(`unknown placement: ${tag}`);
  if (kind === 'ClientIsland') {
    const island = strAt(o, 'island');
    if (island !== 'pyodide' && island !== 'fable' && island !== 'js')
      throw new Error(`unknown island kind: ${island}`);
    return { kind, island: island as IslandKind };
  }
  return { kind } as Placement;
};

const decodeDeclaration = (json: string): Capability => {
  const o = asObject(JSON.parse(json), 'capability declaration');
  const sigObj = asObject(o['signature'], 'signature');
  const effectObj = asObject(sigObj['effect'], 'effect');

  const hostEffect = HOST_OF[strAt(effectObj, 'host')];
  if (hostEffect === undefined) throw new Error(`unknown host effect: ${strAt(effectObj, 'host')}`);
  const determinism = DETERMINISM_OF[strAt(effectObj, 'determinism')];
  if (determinism === undefined)
    throw new Error(`unknown determinism: ${strAt(effectObj, 'determinism')}`);

  const holes = sigObj['holes'];
  if (!Array.isArray(holes)) throw new Error('missing or non-array field: holes');

  const signature: CapabilitySignature = {
    name: strAt(sigObj, 'name'),
    holes: holes.map(entryOf),
    effect: { hostEffect, determinism },
  };

  // The wire tag is derivable from the signature, so a disagreement is a
  // tampered or divergent payload rather than a spelling difference — refuse it
  // by name instead of silently preferring the signature, which would key the
  // replay seam under a determinism the declaration does not declare.
  const wireTag = strAt(o, 'determinism');
  const expectedTag = DETERMINISM_WIRE[determinism];
  if (wireTag !== expectedTag)
    throw new Error(
      `capability determinism disagrees with signature effect: wire '${wireTag}' vs signature '${expectedTag}'`,
    );

  return {
    id: strAt(o, 'id'),
    signature,
    determinism,
    placement: placementOf(o['placement']),
  };
};

// ─── the refusal-class vocabulary the vectors speak ──────────────────────────

const REFUSAL_WIRE: Record<string, string> = {
  NoSuchCapability: 'noSuchCapability',
  DuplicateCapability: 'duplicateCapability',
  UnknownArg: 'unknownArg',
  ArgOutOfSpace: 'argOutOfSpace',
  RequiredArgsUnbound: 'requiredArgsUnbound',
  UninvocableArg: 'uninvocableArg',
  BodyFailed: 'bodyFailed',
};

/** The address a refusal names, where the class carries one. */
const refusalAddr = (e: { kind: string; addr?: string }): string | undefined => e.addr;

// ─── the leg ─────────────────────────────────────────────────────────────────

const RUN_CASES = ['validateArgs', 'invocationKey', 'declarationRoundTrip', 'registryEnumerate'];

describe('capabilityLaws vectors (shared corpus laws/ family)', () => {
  // The corpus is a sibling checkout, absent in a standalone clone. Every other
  // corpus leg in this repo tolerates that the same way.
  if (!family || !lawFile) {
    it.skip('law-vector family not present in this corpus checkout', () => {});
    return;
  }

  const { seed, iterations, vectors } = lawFile;

  it('the vector file agrees with the family manifest', () => {
    expect(lawFile.family).toBe(family.id);
    expect(family.kind).toBe('law-vectors');
    expect(seed).toBe(family.seed);
    expect(iterations).toBe(family.iterations);
    expect(vectors.length).toBe(family.vectors);
  });

  it('every case the family carries is one this host runs', () => {
    const carried = [...new Set(vectors.map((v) => v.case))].sort();
    // Both directions: an unrun case would mean a silently uncertified member,
    // and a claimed case the family does not carry would mean this harness
    // describes coverage it has not got.
    expect(carried).toEqual([...RUN_CASES].sort());
  });

  const capOf = (vectorId: string, declaration: string | undefined): Capability => {
    if (declaration === undefined) throw new Error(`vector ${vectorId}: no declaration in input`);
    return decodeDeclaration(declaration);
  };

  for (const v of vectors) {
    it(v.id, () => {
      switch (v.case) {
        case 'validateArgs': {
          const cap = capOf(v.id, v.input.capability);
          const result = validateArgs(cap, v.input.args ?? []);
          if (v.expected.verdict === 'accept') {
            expect(result.ok, `expected accept, this host refused`).toBe(true);
          } else if (v.expected.verdict === 'reject') {
            expect(result.ok, `expected reject ${v.expected.error}, this host accepted`).toBe(
              false,
            );
            if (!result.ok) {
              expect(REFUSAL_WIRE[result.error.kind]).toBe(v.expected.error);
              expect(refusalAddr(result.error as { kind: string; addr?: string })).toBe(
                v.expected.addr,
              );
            }
          } else {
            throw new Error(`unrecognised verdict: ${String(v.expected.verdict)}`);
          }
          break;
        }

        case 'invocationKey': {
          const cap = capOf(v.id, v.input.capability);
          expect(invocationKey(cap, v.input.args ?? [])).toBe(v.expected.key);
          expect(capabilityDeterminismTag(cap)).toBe(v.expected.determinismTag);
          // `expected.capturedValue` is NOT asserted — see the file header.
          break;
        }

        case 'declarationRoundTrip': {
          const cap = capOf(v.id, v.input.declaration);
          expect(encodeDeclaration(cap)).toBe(v.expected.declaration);
          break;
        }

        case 'registryEnumerate': {
          const caps = (v.input.declarations ?? []).map((d) => decodeDeclaration(d));
          const reg = registryOf(caps);
          expect(reg.ok, 'registering the declarations was refused').toBe(true);
          if (reg.ok) {
            expect(enumerate(reg.value).map((c) => c.id)).toEqual([...(v.expected.ids ?? [])]);
          }
          break;
        }

        default:
          // Never a skip. A case this harness does not know is a case this host
          // is not certifying, and a green run must not be able to mean that.
          throw new Error(
            `vector case ${v.case} is not run by this host's harness — the corpus family has grown ` +
              `a case; port it here rather than widening this switch to ignore it`,
          );
      }
    });
  }
});
