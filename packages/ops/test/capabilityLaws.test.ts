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
//  WHERE THE CODEC LIVES. Every case now runs against SHIPPED surfaces. The
//  three runtime cases run against `@fuaran-ui/ui`'s ports (`validateArgs`,
//  `invocationKey`, `capabilityDeterminismTag`, `registryOf` + `enumerate`),
//  and `declarationRoundTrip` against `@fuaran-ui/ops`'s
//  `decodeCapabilityDeclaration` / `encodeCapabilityDeclaration`.
//
//  That last one used to be a HARNESS-LOCAL codec, because the types were in
//  `@fuaran-ui/ui` and the canonical renderer in `@fuaran-ui/ops` and neither
//  package may depend on the other. It was a real assertion even then — the
//  INPUT bytes are the reference's, so a decode-then-encode disagreeing on
//  member order, escaping or number form would have failed against them — but
//  it certified no codec a CONSUMER could call. Moving the five declaration
//  types down into `@fuaran-ui/schema`, which both packages already depend on,
//  let the codec ship in `@fuaran-ui/ops`; the bytes this law certifies are now
//  the bytes the package emits, by construction rather than by review.
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
} from '../../ui/dist/index.js';
import type { Capability, InvokeArg } from '@fuaran-ui/schema';

import { decodeCapabilityDeclaration, encodeCapabilityDeclaration } from '../src/capabilityDecl.js';

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
    const decoded = decodeCapabilityDeclaration(declaration);
    // The shipped decoder is TOTAL — it refuses by name rather than throwing —
    // so the harness turns a refusal into the failure, naming what the codec
    // said. A vector the codec cannot read is a divergence, never a skip.
    if (!decoded.ok)
      throw new Error(`vector ${vectorId}: the shipped decoder refused — ${decoded.error}`);
    return decoded.value;
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
          expect(encodeCapabilityDeclaration(cap)).toBe(v.expected.declaration);
          break;
        }

        case 'registryEnumerate': {
          const caps = (v.input.declarations ?? []).map((d, i) => capOf(`${v.id}[${i}]`, d));
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
