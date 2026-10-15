// ============================================================================
//  Self-certification dogfood: the TS reference implementation
//  (@fuaran-ui/ops) certifies through the public kit itself — the same
//  runConformance code path a third party gets, not a parallel harness.
//  Runs against BOTH the bundled snapshot and the authoritative workspace
//  corpus (when present), so the published kit and the live corpus agree.
// ============================================================================

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

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
} from '@fuaran-ui/ops';
import {
  decodeCardBundle,
  decodeContractCard,
  encodeCardBundle,
  encodeContractCard,
  type Node,
} from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import type { ConformanceAdapter } from '../src/adapter.js';
import type { TreeOp } from '@fuaran-ui/ops';
import { loadCorpus } from '../src/corpus.js';
import { formatReport } from '../src/report.js';
import { runConformance } from '../src/run.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const workspaceCorpus = wireCorpusRoot();

const tsHostAdapter: ConformanceAdapter = {
  decodeNode: (json) => decodeNode(json),
  encodeNode: (value) => encodeNode(value as Node<unknown>),
  decodeOp: (json) => decodeOp(json),
  encodeOp: (value) => encodeOp(value as TreeOp<unknown>),
  negotiateEnvelope: (json) => negotiateEnvelope(json),
  roundTripElicitation: (decoder, json) => {
    if (decoder === 'elicitation') {
      const decoded = decodeElicitation(json);
      if (!decoded.ok) return decoded;
      return encodeElicitation(decoded.value);
    }
    const decoded = decodeElicitationOutcome(json);
    if (!decoded.ok) return decoded;
    return { ok: true, value: encodeElicitationOutcome(decoded.value) };
  },
  validateAnswerDocument: (json) => validateAnswerDocument(json),
  roundTripContractCard: (decoder, json) => {
    if (decoder === 'contract-card') {
      const decoded = decodeContractCard(json);
      if (!decoded.ok) return decoded;
      return { ok: true, value: encodeContractCard(decoded.value) };
    }
    const decoded = decodeCardBundle(json);
    if (!decoded.ok) return decoded;
    return { ok: true, value: encodeCardBundle(decoded.value) };
  },
};

const implementation = { name: '@fuaran-ui/ops', version: '0.1.0' };

/**
 * A corpus root holding exactly one fixture of the bundled snapshot, so a run
 * through it times that fixture alone (plus the schema compile every run pays).
 */
const singleFixtureCorpus = (fixtureId: string): { root: string; dispose: () => void } => {
  const bundled = loadCorpus();
  const fixture = bundled.fixtures.find((f) => f.id === fixtureId);
  if (fixture === undefined) throw new Error(`the bundled corpus has no fixture '${fixtureId}'`);

  const root = mkdtempSync(join(tmpdir(), 'fuaran-conformance-single-'));
  const copy = (relPath: string): void => {
    mkdirSync(dirname(join(root, relPath)), { recursive: true });
    writeFileSync(join(root, relPath), bundled.read(relPath));
  };
  const manifest = {
    version: bundled.manifestVersion,
    schema: 'schema.json',
    description: fixtureId,
    fixtures: [fixture],
  };
  writeFileSync(join(root, 'manifest.json'), JSON.stringify(manifest));
  copy('schema.json');
  copy(fixture.inputFile);
  if (fixture.expectedFile !== undefined) copy(fixture.expectedFile);
  return { root, dispose: () => rmSync(root, { recursive: true, force: true }) };
};

const expectFullyConformant = (corpusRoot?: string): void => {
  const report = runConformance(tsHostAdapter, {
    implementation,
    ...(corpusRoot === undefined ? {} : { corpusRoot }),
  });

  const failed = report.legs.filter((l) => l.status === 'fail');
  expect(failed, formatReport(report)).toEqual([]);
  expect(report.verdict).toBe('conformant');

  // Every mandatory leg ran (the full-host adapter provides all four hooks);
  // only the reserved apply leg is skipped.
  const skipped = report.legs.filter((l) => l.status === 'skipped').map((l) => l.leg);
  expect(skipped).toEqual(['apply']);

  // The report names the corpus it certified against.
  expect(report.corpus.manifestVersion).toBeGreaterThanOrEqual(1);
  expect(report.corpus.digest).toMatch(/^[0-9a-f]{64}$/);
  expect(report.corpus.fixtureCount).toBeGreaterThan(0);
};

describe('self-certification — @fuaran-ui/ops through the public kit', () => {
  it('certifies green against the bundled corpus snapshot', () => {
    expectFullyConformant();
  });

  it.skipIf(!existsSync(join(workspaceCorpus, 'manifest.json')))(
    'certifies green against the authoritative workspace corpus',
    () => {
      expectFullyConformant(workspaceCorpus);
    },
  );

  it('certifies the deepest legal tree without the schema leg blowing up', () => {
    // A guard against a specific regression, not a general timing assertion.
    //
    // The canonical schema is recursive with an `anyOf` over the kind
    // vocabulary, so an ajv instance built with `allErrors: true` explores every
    // alternative at every level and its cost is EXPONENTIAL in node depth —
    // measured at 653ms for a 6-deep tree, 5.9s at 7, 46s at 8, and no return by
    // 24. This suite hung outright until `runConformance` switched to
    // `allErrors: false`.
    //
    // It went unnoticed for as long as it did because the corpus's deepest tree
    // was three levels. WIRE_FORMAT §21 changed that: max node depth is 24 and
    // rule 1 requires every conformant host to accept a document at the limit,
    // so the corpus now carries `limit-node-depth-at-max` and this kit has to be
    // able to validate it.
    //
    // WHAT IS MEASURED, and why it is a RATIO. The old assertion was a bare
    // `elapsed < 60_000` over a whole-corpus run: it measured the machine as much
    // as the schema leg (the same run took 5.7 s and 22.6 s on one loaded
    // machine, minutes apart), so a busy host could breach it with the code
    // unchanged. Instead each certification below is of ONE fixture, run through
    // the same `runConformance` path, in two corpora that differ only in which
    // fixture they hold: the 24-deep tree, and a comparably sized shallow one.
    // They are timed back to back, interleaved, and compared on their fastest of
    // a few passes, so load that scales both sides cancels and a spike that
    // lands on one pass is dropped. The exponential defect is a factor of
    // thousands at this depth; a legal deep tree validating in about the time of
    // a shallow one is the property, and `RATIO_CEILING` leaves headroom over it.
    //
    // The absolute `HANG_BOUND_MS` stays only as an outer bound that names a
    // hang; it is minutes, not seconds, because the ratio is what judges speed.
    const RATIO_CEILING = 25;
    const HANG_BOUND_MS = 300_000;
    const PASSES = 2;

    const deep = singleFixtureCorpus('limit-node-depth-at-max');
    const shallow = singleFixtureCorpus('master-detail-preselected-second-row');
    try {
      const certify = (corpusRoot: string): number => {
        const started = performance.now();
        const report = runConformance(tsHostAdapter, { implementation, corpusRoot });
        const elapsed = performance.now() - started;
        expect(
          report.legs.find((l) => l.leg === 'schema-validation')!.status,
          formatReport(report),
        ).toBe('pass');
        return elapsed;
      };

      let fastestDeep = Infinity;
      let fastestShallow = Infinity;
      for (let pass = 0; pass < PASSES; pass++) {
        fastestShallow = Math.min(fastestShallow, certify(shallow.root));
        fastestDeep = Math.min(fastestDeep, certify(deep.root));
      }

      const ratio = fastestDeep / fastestShallow;
      expect(
        ratio,
        `the 24-deep tree took ${fastestDeep.toFixed(0)} ms against ${fastestShallow.toFixed(0)} ms ` +
          `for a shallow one (fastest of ${PASSES}): ${ratio.toFixed(1)}x, ceiling ${RATIO_CEILING}x`,
      ).toBeLessThan(RATIO_CEILING);
      expect(
        fastestDeep,
        'the deep certification only ever returns if it is not hung',
      ).toBeLessThan(HANG_BOUND_MS);
    } finally {
      deep.dispose();
      shallow.dispose();
    }
  });

  it('exercises every accept fixture through byte-identity + schema validation', () => {
    const report = runConformance(tsHostAdapter, { implementation });
    const leg = (id: string) => report.legs.find((l) => l.leg === id)!;
    const acceptCount = leg('node-decode').fixturesTotal + leg('op-decode').fixturesTotal;
    expect(leg('node-byte-identity').fixturesTotal).toBe(leg('node-decode').fixturesTotal);
    expect(leg('op-byte-identity').fixturesTotal).toBe(leg('op-decode').fixturesTotal);
    expect(leg('schema-validation').fixturesTotal).toBe(acceptCount);
    const rejectCount = leg('node-reject').fixturesTotal + leg('op-reject').fixturesTotal;
    // Every corpus fixture is exercised by exactly one leg family — the
    // no-silently-skipped-family guarantee, spanning every fixture kind.
    const lenientCount = leg('lenient-accept').fixturesTotal;
    const envelopeCount =
      leg('envelope-round-trip').fixturesTotal + leg('envelope-reject').fixturesTotal;
    const elicitationCount =
      leg('elicitation-round-trip').fixturesTotal +
      leg('elicitation-reject').fixturesTotal +
      leg('elicitation-answer').fixturesTotal;
    const cardCount =
      leg('contract-card-round-trip').fixturesTotal + leg('contract-card-reject').fixturesTotal;
    expect(lenientCount).toBeGreaterThan(0);
    expect(envelopeCount).toBeGreaterThan(0);
    expect(elicitationCount).toBeGreaterThan(0);
    expect(cardCount).toBeGreaterThan(0);

    // Two families are exercised by NO leg here, and naming them is what keeps
    // the guarantee above total rather than approximate.
    //
    // `teleport-decode` / `teleport-reject` (WIRE_FORMAT.md §17.6) need an
    // asynchronous decoder — the bundle is a DEFLATE stream inflated through the
    // platform's own decompressor — and `runConformance` is synchronous by
    // contract, so a teleport leg means an async runner entry point and its own
    // piece of work. The family is certified host-side in the meantime
    // (`packages/op-stream/test/teleport.test.ts`, against these same files).
    //
    // `style-observer` (Phase 1752) is excluded for a DIFFERENT reason, and the
    // difference is worth keeping: teleport is work this tier has not done yet,
    // style-observer is a surface this tier does not have. Those vectors are
    // resolved-style facts in and encoded style-flag / style-observation bytes
    // out — no decode, no re-encode, no schema to validate — and no package here
    // implements the derivation, so there is nothing for a leg to run rather
    // than a leg somebody forgot to write. It is certified by the hosts that do
    // implement it. It is bundled in the snapshot regardless, because the
    // snapshot's payload is derived from the manifest, and a snapshot listing
    // files it does not hold is worse than one carrying files it does not read.
    //
    // The exclusion is COMPUTED and pinned to exactly these kinds, so a future
    // family that no leg covers still trips this assertion — which is the whole
    // point of the accounting. Widening this set is a decision, never a repair.
    const notExercisedHere = ['teleport-decode', 'teleport-reject', 'style-observer'];
    const corpus = loadCorpus();
    const unexercised = corpus.fixtures.filter((f) => notExercisedHere.includes(f.kind));
    expect(new Set(unexercised.map((f) => f.kind))).toEqual(new Set(notExercisedHere));

    expect(
      acceptCount +
        rejectCount +
        lenientCount +
        envelopeCount +
        elicitationCount +
        cardCount +
        unexercised.length,
    ).toBe(report.corpus.fixtureCount);
  });
});
