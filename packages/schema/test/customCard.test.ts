// ============================================================================
//  Contract-card conformance (WIRE_FORMAT.md §25) — corpus-driven, plus the
//  value-level suites the corpus cannot express.
//
//  The corpus half re-proves exactly what the reference emitter proved: a
//  round-trip fixture decodes and re-encodes byte-identically through its
//  `decoder`-named entry point, and a reject surfaces the manifest's code at the
//  manifest's path. Two hosts asserting from the same bytes is what makes §25
//  corpus-certified rather than host-private — and it is the whole reason this
//  host's canonical ENCODER exists at all, since nothing in this tier publishes
//  cards.
//
//  The value-level half is about what a card MEANS, which no byte comparison
//  reaches: the three-way hash verdict and the withholding rule under a
//  mismatch.
//
//  Skipped when the corpus checkout is absent (a standalone clone), mirroring
//  the other corpus-dependent suites. The value-level suite does not need it.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  CardStore,
  cardVerdictMarker,
  decodeCardBundle,
  decodeContractCard,
  describeFromCard,
  encodeCardBundle,
  encodeContractCard,
  parsePropTypeTag,
  validateAgainstCard,
  type ContractCard,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/schema/test → workspace-root/wire-format-fixtures/
const CORPUS = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const MANIFEST = join(CORPUS, 'manifest.json');

const present = existsSync(MANIFEST);

interface ManifestEntry {
  readonly id: string;
  readonly kind: string;
  readonly decoder: string;
  readonly inputFile: string;
  readonly expectedFile?: string;
  readonly expectedErrorCode?: string;
  readonly expectedPath?: string;
  readonly description: string;
}

const entries = (): readonly ManifestEntry[] =>
  (JSON.parse(readFileSync(MANIFEST, 'utf8')) as { fixtures: ManifestEntry[] }).fixtures;

const of = (kind: string): readonly ManifestEntry[] => entries().filter((e) => e.kind === kind);

const payload = (e: ManifestEntry): string => readFileSync(join(CORPUS, e.inputFile), 'utf8');

/** Decode + re-encode through the entry point the fixture names. */
const decodeReencode = (
  decoder: string,
  wire: string,
): { ok: true; value: string } | { ok: false; error: { code: string; path: string } } => {
  if (decoder === 'contract-card') {
    const r = decodeContractCard(wire);
    return r.ok ? { ok: true, value: encodeContractCard(r.value) } : r;
  }
  if (decoder === 'contract-card-bundle') {
    const r = decodeCardBundle(wire);
    return r.ok ? { ok: true, value: encodeCardBundle(r.value) } : r;
  }
  throw new Error(`unknown card decoder '${decoder}'`);
};

describe.skipIf(!present)('contract cards — corpus conformance (WIRE_FORMAT.md §25)', () => {
  it('the corpus carries the card family at all', () => {
    // Without this, every `it.each` below would vacuously pass on an empty list
    // — the completeness check that cannot fail.
    expect(of('contract-card-round-trip').length, 'no round-trip card fixtures').toBeGreaterThan(0);
    expect(of('contract-card-reject').length, 'no reject card fixtures').toBeGreaterThan(0);
  });

  it('round-trips every accept fixture byte-identically', () => {
    for (const e of of('contract-card-round-trip')) {
      const wire = payload(e);
      const result = decodeReencode(e.decoder, wire);
      if (!result.ok)
        throw new Error(`${e.id}: decode refused (${result.error.code} at ${result.error.path})`);
      expect(result.value, `${e.id} — ${e.description}`).toBe(wire);
    }
  });

  it('refuses every reject fixture with the canonical code at the canonical path', () => {
    for (const e of of('contract-card-reject')) {
      const result = decodeReencode(e.decoder, payload(e));
      if (result.ok) throw new Error(`${e.id}: expected a refusal; decode accepted it`);
      expect(result.error.code, `${e.id} — ${e.description}`).toBe(e.expectedErrorCode);
      expect(result.error.path.startsWith(e.expectedPath ?? '$'), `${e.id} path`).toBe(true);
    }
  });

  it('no card fixture is filed as a node round-trip', () => {
    // A card is not a node. One landing in `nodes/` would start every host's
    // node-corpus leg asserting the node round-trip law over a document that law
    // says nothing about — a failure that reads as a codec defect rather than a
    // misfiled fixture.
    const leaked = entries()
      .filter((e) => e.kind === 'node-round-trip' && e.inputFile.startsWith('cards/'))
      .map((e) => e.id);
    expect(leaked).toEqual([]);
  });
});

// ─── What a card means ───────────────────────────────────────────────────────

const CARD: ContractCard = {
  moduleId: 'analytics',
  componentId: 'sparkline',
  props: [
    {
      name: 'series',
      type: 'string',
      required: true,
      payloadLanguage: 'chartspec',
      payloadGate: 'chartspec-gate:1.2',
    },
    { name: 'period', type: 'enum(day|week|month)', required: true },
    { name: 'title', type: 'string', required: false },
  ],
  contentHash: { algorithm: 'SHA256', hash: 'a94a8fe5ccb19ba61c4c0873d391e987982fbbd3' },
  summary: 'A compact trend line.',
};

const CONFORMING = { series: '{"points":[1,2,3]}', period: 'week' };

describe('contract cards — what a card means (WIRE_FORMAT.md §25.4)', () => {
  it('a matching declared hash shows the description', () => {
    const described = describeFromCard(
      { algorithm: 'SHA256', hash: CARD.contentHash.hash, strictness: 'AdvisoryWarning' },
      CONFORMING,
      CARD,
    );

    expect(cardVerdictMarker(described.verdict)).toBe('described');
    expect(described.summary).toBe('A compact trend line.');
    expect(described.propLines).toContain(
      'series: string (required) [chartspec (gate chartspec-gate:1.2)]',
    );
  });

  it('no declared hash is unverified — shown, and SAID to be unverified', () => {
    // Degrading to identity-only here would throw away the common case for no
    // gain: most nodes declare no hash, and a card matching by name is still the
    // best description anyone has.
    const described = describeFromCard(undefined, CONFORMING, CARD);

    expect(cardVerdictMarker(described.verdict)).toBe('unverified');
    expect(described.summary).toBe('A compact trend line.');
    if (described.verdict.kind === 'unverified')
      expect(described.verdict.reason).toContain('no content hash');
  });

  it('a differing ALGORITHM is unverified, not a mismatch', () => {
    // Two digests under different algorithms are incomparable, not unequal.
    // Reporting a mismatch would withhold a good description on the strength of
    // a comparison that was never made.
    const described = describeFromCard(
      { algorithm: 'BLAKE3', hash: CARD.contentHash.hash, strictness: 'AdvisoryWarning' },
      CONFORMING,
      CARD,
    );

    expect(cardVerdictMarker(described.verdict)).toBe('unverified');
    if (described.verdict.kind === 'unverified')
      expect(described.verdict.reason).toContain('cannot be compared');
  });

  it('a differing hash WITHHOLDS the description but keeps the identity', () => {
    const described = describeFromCard(
      {
        algorithm: 'SHA256',
        hash: '0000000000000000000000000000000000000000',
        strictness: 'AdvisoryWarning',
      },
      CONFORMING,
      CARD,
    );

    expect(cardVerdictMarker(described.verdict)).toBe('hash-mismatch');
    expect(described.summary, 'a description of a different shape is withheld').toBeUndefined();
    expect(described.propLines).toEqual([]);
    expect(
      described.validation.defects,
      'no verdict against a schema that is not this node’s',
    ).toEqual([]);
    // Hiding the identity too would leave a reader with less than the uncarded
    // placeholder gave them.
    expect(described.label).toBe('[fuaran:custom analytics.sparkline]');
  });

  it('validates a prop bag against the card, in the reference tier’s own words', () => {
    const v = validateAgainstCard(CARD, { period: 'fortnight' });

    expect(v.defects.map((d) => d.message)).toEqual([
      "required prop 'series' (string) is missing",
      "prop 'period' is not a enum(day|week|month)",
    ]);
    expect(v.defects.every((d) => d.code === 'FUARAN068')).toBe(true);
  });

  it('surfaces the payload obligation, and never calls it a defect', () => {
    const v = validateAgainstCard(CARD, CONFORMING);

    expect(v.defects).toEqual([]);
    expect(v.obligations).toHaveLength(1);
    expect(v.obligations[0]!.kind).toBe('GateOwed');
    expect(v.obligations[0]!.message).toContain('has NOT run here');
  });

  it('reports an unresolvable type tag rather than assuming it permissive', () => {
    // A decoded card cannot carry one (the decoder refuses it), so this is the
    // in-process path — exactly how a NEWER producer's card reaches a consumer
    // built before the tag existed. Reading it as permissive would silently turn
    // a check into a pass.
    const fromFuture: ContractCard = {
      ...CARD,
      props: [{ name: 'series', type: 'timeseries', required: true }],
    };
    const v = validateAgainstCard(fromFuture, CONFORMING);

    expect(v.unresolvable).toEqual(['series']);
    expect(v.defects).toEqual([]);
  });

  it('refuses `enum()` as a tag', () => {
    // An enum admitting nothing, spelled as though it admitted one empty choice.
    expect(parsePropTypeTag('enum()')).toBeUndefined();
    expect(parsePropTypeTag('enum(a|b)')).toEqual({ enumChoices: ['a', 'b'] });
  });

  it('a store answers only for identities it holds', () => {
    const store = CardStore.of([CARD]);

    expect(store.get('analytics', 'sparkline')).toBeDefined();
    expect(store.get('analytics', 'trend-card')).toBeUndefined();
    // And an empty store answers for nothing, which is what keeps the uncarded
    // placeholder path unchanged.
    expect(new CardStore().get('analytics', 'sparkline')).toBeUndefined();
  });

  it('encodes a bundle sorted by identity whatever order it was given', () => {
    const other: ContractCard = {
      moduleId: 'analytics',
      componentId: 'aardvark',
      props: [],
      contentHash: { algorithm: 'SHA256', hash: 'ff00' },
    };

    expect(encodeCardBundle([CARD, other])).toBe(encodeCardBundle([other, CARD]));
    expect(encodeCardBundle([CARD, other]).indexOf('aardvark')).toBeLessThan(
      encodeCardBundle([CARD, other]).indexOf('sparkline'),
    );
  });
});
