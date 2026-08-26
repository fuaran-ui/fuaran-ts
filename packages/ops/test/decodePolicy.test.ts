// ============================================================================
//  Host-declared kind admission policy (WIRE_FORMAT.md §23).
//
//  The corpus family under `decode-policy/` is the oracle: each case pairs a
//  document with a declared policy and the outcome a conformant decoder owes.
//  The family is hand-authored (the `sanitization/` precedent) rather than
//  emitted, so this suite reads its manifest directly rather than through the
//  generated root manifest that `corpus.test.ts` walks.
//
//  Three classes of assertion, and the middle one is why the family exists:
//
//   1. THE PAIRING. The same bytes admit under one policy and refuse under
//      another. Either half alone proves nothing.
//   2. THE DEFAULT IS UNCHANGED. Every document in the family decodes through
//      the argument-less call exactly as it does at `admitAll` — which is §22's
//      "a decoder owes nothing" restated as a test rather than trusted as a
//      property of a diff.
//   3. THE GATE CAN GO RED. A refusal case re-run under a policy that ADMITS
//      the kind must fail the same check, so the check is known to be able to
//      fail rather than assumed to be.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CLOSED_PROFILE,
  HATCH_NODE_KINDS,
  NODE_KIND_NAMES,
  admitAll,
  admits,
  excluding,
  narrows,
  type DecodePolicy,
} from '@fuaran-ui/schema';
import { decodeNode, decodeOp } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures/decode-policy
const familyDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'decode-policy');

interface PolicyDecl {
  readonly identity: string;
  readonly admission: 'all' | 'allowlist';
  readonly excludesFromVocabulary?: readonly string[];
  readonly description: string;
}

interface PolicyCase {
  readonly id: string;
  readonly document: string;
  readonly policy: string;
  readonly outcome: 'admit' | 'refuse';
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly refusedKind?: string;
  readonly description: string;
}

interface FamilyManifest {
  readonly version: number;
  readonly description: string;
  readonly policies: readonly PolicyDecl[];
  readonly cases: readonly PolicyCase[];
}

const manifest: FamilyManifest = JSON.parse(
  readFileSync(join(familyDir, 'manifest.json'), 'utf8'),
) as FamilyManifest;

/**
 * Build the policy the manifest declares, the way §23 says a host must: an
 * `allowlist` declaration is resolved against the CORPUS vocabulary, not against
 * a list restated in this file. So a kind added to the language reaches this
 * suite through `NODE_KIND_NAMES` — itself pinned to the root manifest's `kinds`
 * array by `corpus.test.ts` — rather than through an edit here.
 */
const resolvePolicy = (identity: string): DecodePolicy => {
  const decl = manifest.policies.find((p) => p.identity === identity);
  if (decl === undefined)
    throw new Error(`decode-policy manifest declares no policy '${identity}'`);
  if (decl.admission === 'all') return admitAll;
  return excluding(decl.identity, decl.excludesFromVocabulary ?? []);
};

const readDocument = (c: PolicyCase): string =>
  readFileSync(resolve(familyDir, c.document), 'utf8');

/**
 * The conformance rule as a FUNCTION, so the negative probe below exercises the
 * same code the positive cases do rather than a paraphrase of it. Returns the
 * complaints; empty means the case held.
 */
const violations = (c: PolicyCase, policy: DecodePolicy): string[] => {
  const out: string[] = [];
  const decoded = decodeNode(readDocument(c), policy);

  if (c.outcome === 'admit') {
    if (!decoded.ok) {
      out.push(
        `expected admission, got ${decoded.error.code} at ${decoded.error.path}: ${decoded.error.message}`,
      );
    }
    return out;
  }

  if (decoded.ok) {
    out.push('expected a refusal, the document decoded');
    return out;
  }

  const err = decoded.error;
  if (c.expectedErrorCode === undefined) out.push('a refuse case with no expectedErrorCode');
  else if (err.code !== c.expectedErrorCode)
    out.push(`expected code ${c.expectedErrorCode}, got ${err.code}`);

  if (c.expectedPath === undefined) out.push('a refuse case with no expectedPath');
  else if (err.path !== c.expectedPath)
    out.push(`expected path ${c.expectedPath}, got ${err.path}`);

  if (c.refusedKind !== undefined && !err.message.includes(c.refusedKind))
    out.push(`the refusal message must name the refused kind '${c.refusedKind}': ${err.message}`);

  // A refusal a host cannot act on is a failure of the surface even when the
  // code is right: the author has to learn WHICH declaration refused.
  if (err.code === 'KIND_NOT_ADMITTED') {
    if (!err.message.includes(policy.identity))
      out.push(`the refusal must name the policy '${policy.identity}': ${err.message}`);
    if (err.expectedShape === undefined)
      out.push('a KIND_NOT_ADMITTED refusal must carry the admitted vocabulary as expectedShape');
  }

  return out;
};

describe('WIRE_FORMAT §23 — the shipped declarations', () => {
  it('every hatch kind is a kind the decoder recognises', () => {
    // A misspelt entry in HATCH_NODE_KINDS is a set difference that removes
    // nothing — so the closed profile would silently ADMIT the hatch it names,
    // and every test below would still pass because they exercise the two
    // spellings that happen to be right. This is the only assertion that
    // catches it.
    expect(HATCH_NODE_KINDS.filter((k) => !NODE_KIND_NAMES.includes(k))).toEqual([]);
  });

  it('the closed profile admits the vocabulary minus the hatches', () => {
    for (const k of NODE_KIND_NAMES) {
      expect(admits(CLOSED_PROFILE, k)).toBe(!HATCH_NODE_KINDS.includes(k));
    }
  });

  it('an exclusion is resolved at construction, not against a live vocabulary', () => {
    // The allow-list shape's whole claim: a kind that did not exist when the
    // policy was declared is NOT admitted by it. Modelled with a name outside
    // the vocabulary, which is what a future kind is from the perspective of
    // today's declaration.
    expect(admits(excluding('probe', ['Custom']), 'AKindAddedNextRelease')).toBe(false);
  });

  it('the default policy narrows nothing', () => {
    expect(narrows(admitAll)).toBe(false);
    expect(narrows(CLOSED_PROFILE)).toBe(true);
    for (const k of NODE_KIND_NAMES) expect(admits(admitAll, k)).toBe(true);
  });

  it('the SHIPPED closed profile is the one the corpus declares', () => {
    // Every case below resolves its policy from the manifest, which is right —
    // the corpus is the oracle — but it means the family says nothing about
    // CLOSED_PROFILE, the value a HOST actually consumes. Found by perturbation
    // on the reference host: emptying the hatch list left the whole family green
    // while the shipped profile admitted both hatches, and the two declaration
    // tests above are self-referential and cannot see it.
    const declared = resolvePolicy('closed-no-escape-hatches');
    expect(CLOSED_PROFILE.identity).toBe(declared.identity);
    expect(CLOSED_PROFILE.admission).toEqual(declared.admission);
  });
});

describe('WIRE_FORMAT §23 — the decode-policy corpus family', () => {
  it('the family is not empty', () => {
    expect(manifest.cases.length).toBeGreaterThan(0);
  });

  for (const c of manifest.cases) {
    it(`${c.id} — ${c.description}`, () => {
      expect(violations(c, resolvePolicy(c.policy))).toEqual([]);
    });
  }

  it('a refusal case run under an admitting policy FAILS (negative probe)', () => {
    // Every refusal above is caused by the policy or by something else, and the
    // passing test cannot tell you which. Re-running each refusal under a policy
    // that ADMITS the refused kind must break it: if the case still "passes",
    // the refusal was never the policy's doing.
    const refusals = manifest.cases.filter(
      (c) => c.outcome === 'refuse' && c.expectedErrorCode === 'KIND_NOT_ADMITTED',
    );
    expect(refusals.length).toBeGreaterThan(0);
    for (const c of refusals) {
      expect(violations(c, admitAll).length).toBeGreaterThan(0);
    }
  });

  it('every family document decodes identically with no policy and at admitAll', () => {
    const seen = new Set<string>();
    for (const c of manifest.cases) {
      if (seen.has(c.document)) continue;
      seen.add(c.document);
      const text = readDocument(c);
      expect(decodeNode(text, admitAll)).toEqual(decodeNode(text));
    }
  });
});

describe('WIRE_FORMAT §23 — the op decoder', () => {
  // A tree admitted under a policy and then EDITED into a refused kind would
  // make the policy a property of the first decode only, which is not a closure
  // at all. Both routes a kind takes into an op are gated.
  const customKind = '{"$type":"Custom","componentId":"c","moduleId":"m","props":{}}';

  it("EditNode's replacement kind is gated", () => {
    const op = `{"$type":"EditNode","newKind":${customKind},"target":"n1"}`;
    const refused = decodeOp(op, CLOSED_PROFILE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) {
      expect(refused.error.code).toBe('KIND_NOT_ADMITTED');
      expect(refused.error.path).toContain('$type');
    }
    expect(decodeOp(op).ok).toBe(true);
  });

  it("an inserted child's kind is gated", () => {
    const op = `{"$type":"InsertChild","child":{"id":"c1","kind":${customKind}},"parentId":"p"}`;
    const refused = decodeOp(op, CLOSED_PROFILE);
    expect(refused.ok).toBe(false);
    if (!refused.ok) expect(refused.error.code).toBe('KIND_NOT_ADMITTED');
    expect(decodeOp(op).ok).toBe(true);
  });
});

describe('WIRE_FORMAT §23 — the policy does not leak between decodes', () => {
  it('a narrowed decode does not narrow the next one', () => {
    // The carrier is module-level mutable state, which is sound for the walk
    // counters because decoding is synchronous — but a counter is reset to zero
    // while a policy is reset to a VALUE, so a missed reset would silently keep
    // narrowing every subsequent decode in the process. This is the assertion
    // that the reset happens.
    const custom = readFileSync(join(familyDir, '..', 'nodes', 'custom-1.json'), 'utf8');
    expect(decodeNode(custom, CLOSED_PROFILE).ok).toBe(false);
    expect(decodeNode(custom).ok).toBe(true);
    expect(decodeNode(custom, admitAll).ok).toBe(true);
  });
});
