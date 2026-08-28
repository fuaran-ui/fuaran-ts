// ============================================================================
//  Self-certification dogfood: the TS reference implementation
//  (@fuaran-ui/ops) certifies through the public kit itself — the same
//  runConformance code path a third party gets, not a parallel harness.
//  Runs against BOTH the bundled snapshot and the authoritative workspace
//  corpus (when present), so the published kit and the live corpus agree.
// ============================================================================

import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { formatReport } from '../src/report.js';
import { runConformance } from '../src/run.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/conformance/test → workspace-root/wire-format-fixtures
const workspaceCorpus = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

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
    // The budget is deliberately loose. It is not measuring performance — it is
    // separating "sub-second" from "exponential", and those differ by orders of
    // magnitude, so a slow machine cannot make this flake.
    const started = Date.now();
    const report = runConformance(tsHostAdapter, { implementation });
    const elapsed = Date.now() - started;

    expect(report.legs.find((l) => l.leg === 'schema-validation')!.status).toBe('pass');
    expect(elapsed).toBeLessThan(60_000);
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
    expect(
      acceptCount + rejectCount + lenientCount + envelopeCount + elicitationCount + cardCount,
    ).toBe(report.corpus.fixtureCount);
  });
});
