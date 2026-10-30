// ============================================================================
//  Phase 2517 — the corpus's `operability/` family, wire section
//  (WIRE_FORMAT.md §31.1, §31.2).
//
//  This host's codec carries the `affordance` member on `Select`, `Button` and
//  every form field, and refuses a pattern the carrying kind's slot rule
//  forbids. The family's `wire.roundTrip` vectors must re-encode byte for byte
//  and its `wire.reject` vectors must refuse with the recorded code at the
//  recorded path. The derivation and matcher sections (§31.3–31.5) are not yet
//  ported, which is why this host's capability manifest declares the family
//  `pending` rather than covered.
//
//  The family is read from the corpus root (FUARAN_WIRE_FIXTURES first, the
//  sibling clone second): it is not part of the bundled snapshot's payload.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { describe, expect, it } from 'vitest';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

interface RoundTrip {
  readonly id: string;
  readonly canonical: string;
}

interface Reject {
  readonly id: string;
  readonly input: string;
  readonly expectedErrorCode: string;
  readonly expectedPath: string;
}

interface Vectors {
  readonly wire: { readonly roundTrip: readonly RoundTrip[]; readonly reject: readonly Reject[] };
}

const file = join(wireCorpusRoot(), 'operability', 'operability-vectors.json');
const present = existsSync(file);
const vectors: Vectors | undefined = present
  ? (JSON.parse(readFileSync(file, 'utf8')) as Vectors)
  : undefined;

describe.skipIf(!present)('operability/ — the affordance member on the wire (§31.1, §31.2)', () => {
  it('carries round-trip and reject vectors', () => {
    expect(vectors?.wire.roundTrip.length ?? 0).toBeGreaterThan(0);
    expect(vectors?.wire.reject.length ?? 0).toBeGreaterThan(0);
  });

  for (const v of vectors?.wire.roundTrip ?? []) {
    it(`${v.id} re-encodes byte for byte`, () => {
      const decoded = decodeNode(v.canonical);
      if (!decoded.ok) throw new Error(`${v.id}: refused: ${JSON.stringify(decoded.error)}`);
      expect(encodeNode(decoded.value)).toBe(v.canonical);
    });
  }

  for (const v of vectors?.wire.reject ?? []) {
    it(`${v.id} refuses with ${v.expectedErrorCode}`, () => {
      const decoded = decodeNode(v.input);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error.code).toBe(v.expectedErrorCode);
      expect(decoded.error.path.startsWith(v.expectedPath)).toBe(true);
    });
  }
});
