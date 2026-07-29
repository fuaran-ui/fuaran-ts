// ============================================================================
//  Wire-format conformance harness.
//
//  Loads the workspace-level wire-format-fixtures corpus (the shared executable
//  conformance suite — fuaran-dotnet/docs/WIRE_FORMAT.md §12) and runs every fixture
//  through the TS codec:
//
//   - node-round-trip / op-round-trip : decode(input) deep-decodes without
//     error, AND encode(decode(input)) is byte-identical to the F# encoder's
//     canonical form (expectedFile). The cross-implementation parity check —
//     the load-bearing "no silent drift between sibling implementations" gate.
//   - reject : decode(input) fails with the manifest's expectedErrorCode at a
//     path starting with expectedPath, byte-identical to the F# decoder.
//
//  The corpus is the canonical artefact; this harness is the TS host asserting
//  conformance against it.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  decodeElicitation,
  decodeElicitationOutcome,
  decodeNode,
  decodeOp,
  encodeElicitation,
  encodeElicitationOutcome,
  encodeNode,
  encodeOp,
  negotiateEnvelope,
  validateAnswerDocument,
} from '../src/index.js';
import { FORM_FIELD_KIND_NAMES, NODE_KIND_NAMES } from '@fuaran-ui/schema';
import { WRONG_FORM_FIELD_KIND_HINT, WRONG_NODE_KIND_HINT } from '../src/decode.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

interface ManifestFixture {
  readonly id: string;
  readonly kind:
    | 'node-round-trip'
    | 'op-round-trip'
    | 'reject'
    | 'lenient-accept'
    | 'envelope-round-trip'
    | 'envelope-reject'
    | 'elicitation-round-trip'
    | 'elicitation-reject'
    | 'elicitation-answer-accept'
    | 'elicitation-answer-reject';
  readonly decoder: 'node' | 'op' | 'elicitation' | 'elicitation-outcome' | 'elicitation-answer';
  readonly inputFile: string;
  readonly expectedFile?: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly description: string;
}

interface Manifest {
  readonly version: number;
  readonly description: string;
  readonly kinds: readonly string[];
  /** Phase 746 — the generated FormFieldKind enumeration (WIRE_FORMAT.md §11.2). */
  readonly formFieldKinds: readonly string[];
  readonly fixtures: readonly ManifestFixture[];
}

const readFixture = (relPath: string): string => readFileSync(join(corpusRoot, relPath), 'utf8');

const manifest = JSON.parse(readFixture('manifest.json')) as Manifest;

const roundTrips = manifest.fixtures.filter(
  (f) => f.kind === 'node-round-trip' || f.kind === 'op-round-trip',
);
const rejects = manifest.fixtures.filter((f) => f.kind === 'reject');
const lenientAccepts = manifest.fixtures.filter((f) => f.kind === 'lenient-accept');
const envelopeRoundTrips = manifest.fixtures.filter((f) => f.kind === 'envelope-round-trip');
const envelopeRejects = manifest.fixtures.filter((f) => f.kind === 'envelope-reject');
const elicitationRoundTrips = manifest.fixtures.filter((f) => f.kind === 'elicitation-round-trip');
const elicitationRejects = manifest.fixtures.filter((f) => f.kind === 'elicitation-reject');
const elicitationAnswerAccepts = manifest.fixtures.filter(
  (f) => f.kind === 'elicitation-answer-accept',
);
const elicitationAnswerRejects = manifest.fixtures.filter(
  (f) => f.kind === 'elicitation-answer-reject',
);

/** The §18 host operation: decode with the `decoder`-named entry point, re-encode. */
const elicitationDecodeReencode = (
  decoder: 'elicitation' | 'elicitation-outcome',
  wire: string,
):
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly error: { readonly code: string; readonly path: string; readonly message: string };
    } => {
  if (decoder === 'elicitation') {
    const decoded = decodeElicitation(wire);
    if (!decoded.ok) return decoded;
    return encodeElicitation(decoded.value);
  }
  const decoded = decodeElicitationOutcome(wire);
  if (!decoded.ok) return decoded;
  return { ok: true, value: encodeElicitationOutcome(decoded.value) };
};

describe('wire-format corpus — round-trip + cross-implementation parity', () => {
  it.each(roundTrips.map((f) => [f.id, f] as const))('%s decodes without error', (_id, f) => {
    const input = readFixture(f.inputFile);
    const decoded = f.decoder === 'node' ? decodeNode(input) : decodeOp(input);
    if (!decoded.ok) {
      throw new Error(
        `decode failed: ${decoded.error.code} at ${decoded.error.path} — ${decoded.error.message}`,
      );
    }
    expect(decoded.ok).toBe(true);
  });

  it.each(roundTrips.map((f) => [f.id, f] as const))(
    '%s — encode(decode(input)) is byte-identical to the F# canonical form',
    (_id, f) => {
      const input = readFixture(f.inputFile);
      const expected = readFixture(f.expectedFile ?? f.inputFile).replace(/\n$/, '');
      if (f.decoder === 'node') {
        const decoded = decodeNode(input);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(encodeNode(decoded.value)).toBe(expected);
      } else {
        const decoded = decodeOp(input);
        expect(decoded.ok).toBe(true);
        if (decoded.ok) expect(encodeOp(decoded.value)).toBe(expected);
      }
    },
  );
});

describe('wire-format corpus — reject fixtures surface the F# error code + path', () => {
  it.each(rejects.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const input = readFixture(f.inputFile);
    const decoded = f.decoder === 'node' ? decodeNode(input) : decodeOp(input);
    expect(decoded.ok).toBe(false);
    if (!decoded.ok) {
      expect(decoded.error.code).toBe(f.expectedErrorCode);
      expect(decoded.error.path.startsWith(f.expectedPath ?? '$')).toBe(true);
    }
  });
});

describe('wire-format corpus — lenient-accept (§16 shorthand normalisation)', () => {
  // A conformant host MUST accept each §16 shorthand and normalise it to the
  // verbose canonical bytes (manifest kind `lenient-accept`, WIRE_FORMAT §16
  // normative block). Rejecting the shorthand, or re-encoding to different
  // bytes, is non-conformant.
  it.each(lenientAccepts.map((f) => [f.id, f] as const))(
    '%s — shorthand decodes and normalises to the canonical form',
    (_id, f) => {
      const shorthand = readFixture(f.inputFile);
      const expected = readFixture(f.expectedFile ?? f.inputFile).replace(/\n$/, '');
      const decoded = decodeNode(shorthand);
      if (!decoded.ok) {
        throw new Error(
          `a conformant decoder MUST accept the §16 shorthand; decode failed: ${decoded.error.code} at ${decoded.error.path}`,
        );
      }
      expect(encodeNode(decoded.value)).toBe(expected);
    },
  );

  it('the corpus carries the lenient-accept family (a silently-skipped family cannot certify)', () => {
    expect(lenientAccepts.length).toBeGreaterThan(0);
  });
});

describe('wire-format corpus — envelope/tolerance (WIRE_FORMAT.md §15) parity with F#', () => {
  // A conformant host reads the $profile/$payload envelope, negotiates the
  // authored profile against its own core@1.0, and either re-renders byte-
  // identical (Current/Behind — unknown kinds preserved verbatim) or refuses a
  // Foreign profile with FOREIGN_PROFILE. The corpus pins both cross-host.
  it.each(envelopeRoundTrips.map((f) => [f.id, f] as const))(
    '%s — negotiate + tolerate + re-encode is byte-identical to the F# canonical form',
    (_id, f) => {
      const input = readFixture(f.inputFile);
      const expected = readFixture(f.expectedFile ?? f.inputFile).replace(/\n$/, '');
      const out = negotiateEnvelope(input);
      if (!out.ok) {
        throw new Error(`a §15 round-trip was refused: ${out.error.code} at ${out.error.path}`);
      }
      expect(out.value).toBe(expected);
    },
  );

  it.each(envelopeRejects.map((f) => [f.id, f] as const))(
    '%s — a Foreign profile hard-refuses with the F# error code + path',
    (_id, f) => {
      const input = readFixture(f.inputFile);
      const out = negotiateEnvelope(input);
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe(f.expectedErrorCode);
        expect(out.error.path.startsWith(f.expectedPath ?? '$')).toBe(true);
      }
    },
  );

  it('the corpus carries the envelope family (a silently-skipped family cannot certify)', () => {
    expect(envelopeRoundTrips.length).toBeGreaterThan(0);
    expect(envelopeRejects.length).toBeGreaterThan(0);
  });
});

describe('wire-format corpus — elicitation envelope (WIRE_FORMAT.md §18) parity with F#', () => {
  // A conformant host decodes the elicitation envelope / outcome with the
  // decoder-named entry point and either re-encodes byte-identically or
  // surfaces the F# host's structured refusal (code + path). Answer documents
  // drive the answer-conformance validation a resolution host runs before an
  // Answered outcome reaches the asking agent.
  it.each(elicitationRoundTrips.map((f) => [f.id, f] as const))(
    '%s — decode + re-encode is byte-identical to the F# canonical form',
    (_id, f) => {
      const input = readFixture(f.inputFile);
      const expected = readFixture(f.expectedFile ?? f.inputFile).replace(/\n$/, '');
      const out = elicitationDecodeReencode(
        f.decoder as 'elicitation' | 'elicitation-outcome',
        input,
      );
      if (!out.ok) {
        throw new Error(`a §18 round-trip was refused: ${out.error.code} at ${out.error.path}`);
      }
      expect(out.value).toBe(expected);
    },
  );

  it.each(elicitationRejects.map((f) => [f.id, f] as const))(
    '%s — refuses with the F# error code + path',
    (_id, f) => {
      const input = readFixture(f.inputFile);
      const out = elicitationDecodeReencode(
        f.decoder as 'elicitation' | 'elicitation-outcome',
        input,
      );
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe(f.expectedErrorCode);
        expect(out.error.path.startsWith(f.expectedPath ?? '$')).toBe(true);
      }
    },
  );

  it.each(elicitationAnswerAccepts.map((f) => [f.id, f] as const))(
    '%s — a conforming answer validates',
    (_id, f) => {
      const out = validateAnswerDocument(readFixture(f.inputFile));
      if (!out.ok) {
        throw new Error(`a conformant answer was refused: ${out.error.code} at ${out.error.path}`);
      }
      expect(out.ok).toBe(true);
    },
  );

  it.each(elicitationAnswerRejects.map((f) => [f.id, f] as const))(
    '%s — a nonconforming answer refuses with the F# error code + path',
    (_id, f) => {
      const out = validateAnswerDocument(readFixture(f.inputFile));
      expect(out.ok).toBe(false);
      if (!out.ok) {
        expect(out.error.code).toBe(f.expectedErrorCode);
        expect(out.error.path.startsWith(f.expectedPath ?? '$')).toBe(true);
      }
    },
  );

  it('the corpus carries the elicitation families (a silently-skipped family cannot certify)', () => {
    expect(elicitationRoundTrips.length).toBeGreaterThan(0);
    expect(elicitationRejects.length).toBeGreaterThan(0);
    expect(elicitationAnswerAccepts.length).toBeGreaterThan(0);
    expect(elicitationAnswerRejects.length).toBeGreaterThan(0);
  });
});

describe('lenient AI-ingest (WIRE_FORMAT.md §16) — parity with the F# decoder', () => {
  it('a bare-string TextSource IS canonical (0.2.0); the Literal envelope still decodes', () => {
    const bare =
      '{"id":"heading-1","kind":{"$type":"Heading","level":2,"text":"Channel performance","variant":"Standard"}}';
    const envelope =
      '{"id":"heading-1","kind":{"$type":"Heading","level":2,"text":{"$type":"Literal","text":"Channel performance"},"variant":"Standard"}}';

    const a = decodeNode(bare);
    const b = decodeNode(envelope);
    expect(a.ok && b.ok).toBe(true);
    if (a.ok && b.ok) {
      // Same decoded value — and BOTH re-encode to the bare-string canonical
      // bytes (the envelope canonicalises down, not the string up).
      expect(encodeNode(a.value)).toBe(encodeNode(b.value));
      expect(encodeNode(b.value)).toContain('"text":"Channel performance"');
    }
  });
});

// Phase 548 — cross-host kind-set attestation. The TS host's emittable NodeKind
// vocabulary (`NODE_KIND_NAMES`) must equal the generated manifest `kinds`
// enumeration. A vocabulary commit that skips this host fails here with a *named*
// missing kind ("TS decoder lacks Drawing"), so the drift class dies at the host's
// next test run rather than at a later audit.
describe('kind-set attestation (WIRE_FORMAT.md §11 / Phase 548)', () => {
  it('the TS emittable NodeKind vocabulary equals manifest.kinds', () => {
    expect(manifest.kinds.length).toBeGreaterThan(0);
    const manifestKinds = new Set(manifest.kinds);
    const hostKinds = new Set(NODE_KIND_NAMES);
    const missing = [...manifestKinds].filter((k) => !hostKinds.has(k)).sort();
    const extra = [...hostKinds].filter((k) => !manifestKinds.has(k)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });
});

// Phase 746 — cross-host CONTROL-vocabulary attestation, the second discriminator
// family to gain one. `NodeKind` has had a pin since Phase 548; `FormFieldKind` had
// none in ANY host, which is how `DateRange` landed in the corpus and sat unadopted
// in four hosts while every gate stayed green.
describe('FormFieldKind attestation (WIRE_FORMAT.md §11.2 / Phase 746)', () => {
  /**
   * Every `FormFieldKind` discriminator a payload carries, in its two wire
   * carriers. Carriers are matched by their PARENT discriminator, never by
   * property name: `DataGrid.columns[].kind.$type` is a `CellKindErased` and
   * shares the token `Text` with this family, so a property-name sweep silently
   * attests the wrong family and reports green.
   */
  const controlKindsIn = (value: unknown): string[] => {
    const acc: string[] = [];
    const walk = (v: unknown): void => {
      if (Array.isArray(v)) {
        for (const e of v) walk(e);
        return;
      }
      if (v === null || typeof v !== 'object') return;
      const o = v as Record<string, unknown>;
      const carrier =
        o['$type'] === 'Form' ? 'fields' : o['$type'] === 'Filters' ? 'items' : undefined;
      if (carrier !== undefined && Array.isArray(o[carrier])) {
        for (const entry of o[carrier] as unknown[]) {
          const k = (entry as Record<string, unknown> | null)?.['kind'];
          const t = (k as Record<string, unknown> | null)?.['$type'];
          if (typeof t === 'string') acc.push(t);
        }
      }
      for (const child of Object.values(o)) walk(child);
    };
    walk(value);
    return acc;
  };

  const corpusControlKinds = new Set(
    manifest.fixtures
      .filter((f) => f.kind === 'node-round-trip')
      .flatMap((f) => controlKindsIn(JSON.parse(readFixture(f.inputFile)))),
  );

  it('the TS control vocabulary equals manifest.formFieldKinds', () => {
    expect(manifest.formFieldKinds?.length ?? 0).toBeGreaterThan(0);
    const manifestKinds = new Set(manifest.formFieldKinds);
    const hostKinds = new Set(FORM_FIELD_KIND_NAMES);
    const missing = [...manifestKinds].filter((k) => !hostKinds.has(k)).sort();
    const extra = [...hostKinds].filter((k) => !manifestKinds.has(k)).sort();
    expect({ missing, extra }).toEqual({ missing: [], extra: [] });
  });

  it('every control discriminator in the corpus is one the TS host declares', () => {
    expect(corpusControlKinds.size).toBeGreaterThan(0);
    const hostKinds = new Set(FORM_FIELD_KIND_NAMES);
    const manifestKinds = new Set(manifest.formFieldKinds);
    const undeclared = [...corpusControlKinds].filter((k) => !hostKinds.has(k)).sort();
    const unlisted = [...corpusControlKinds].filter((k) => !manifestKinds.has(k)).sort();
    expect({ undeclared, unlisted }).toEqual({ undeclared: [], unlisted: [] });
  });

  it('every declared control kind is actually accepted by the decoder', () => {
    // A kind named in the vocabulary but absent from `decodeFormFieldKind`'s
    // dispatch would send a model to a discriminator that rejects again. A
    // declared kind must at minimum get PAST the dispatch (it may then fail on
    // its own missing fields — anything but UNKNOWN_DU_CASE at the control's
    // own $type).
    const stillUnknown = FORM_FIELD_KIND_NAMES.filter((k) => {
      const r = decodeNode(
        `{"id":"f","kind":{"$type":"Form","fields":[{"id":"a","kind":{"$type":"${k}"},"label":"L","required":false}],"onSubmit":"<closure>"},"state":{},"style":{"emphasis":"Normal","tone":"Default","weight":"Standard"}}`,
      );
      return !r.ok && r.error.code === 'UNKNOWN_DU_CASE' && r.error.path.endsWith('.kind.$type');
    });
    expect(stillUnknown).toEqual([]);
  });

  it('the control hint names every kind in the vocabulary', () => {
    const tokens = new Set(WRONG_FORM_FIELD_KIND_HINT.split(/[^A-Za-z]+/).filter(Boolean));
    const missing = (manifest.formFieldKinds ?? []).filter((k) => !tokens.has(k)).sort();
    expect(missing).toEqual([]);
  });
});

// The kind-set attestation above pins what the decoder ACCEPTS. This pins what it
// TELLS a model when it rejects: the `expectedShape` hint on a WRONG_NODE_KIND
// error must enumerate the whole vocabulary. Both halves matter — a hint that has
// silently fallen behind the kind set degrades every repair turn that reads it,
// and no corpus fixture catches it (fixtures certify codes and paths, not prose).
describe('WRONG_NODE_KIND hint (the model-facing half of the kind-set contract)', () => {
  // Tokenise on non-letters so `List` is not satisfied by `SummaryList`, nor
  // `Map` by `Markdown`. Only the forward direction is asserted — the hint's
  // prose ('Layout', 'Display', …) is legitimately present and is not
  // vocabulary; the reverse direction is covered by the attestation above,
  // since the hint is a pure projection of NODE_KIND_GROUPS.
  const tokens = new Set(WRONG_NODE_KIND_HINT.split(/[^A-Za-z]+/).filter(Boolean));

  it('names every manifest kind as its own token', () => {
    const missing = manifest.kinds.filter((k) => !tokens.has(k)).sort();
    expect(missing).toEqual([]);
  });

  it('is the hint a rejected node actually carries', () => {
    const r = decodeNode(
      '{"id":"x","kind":{"$type":"Widget"},"state":{},"style":{"emphasis":"Normal","tone":"Default","weight":"Standard"}}',
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('WRONG_NODE_KIND');
      expect(r.error.expectedShape).toBe(WRONG_NODE_KIND_HINT);
    }
  });
});
