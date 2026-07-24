// ============================================================================
//  @fuaran-ui/conformance — the runner.
//
//  Drives a candidate implementation (the `ConformanceAdapter`) over the
//  canonical corpus and produces a per-leg `ConformanceReport`. The assertion
//  semantics are exactly those of the in-house cross-implementation gate
//  (wire-format-fixtures/conformance/cross-host-conformance.mjs + the F#
//  Fuaran.UI.JsonDecode.Tests suite), packaged behind the adapter seam:
//
//    node-decode / op-decode      decode(inputFile) succeeds on every accept
//                                 fixture (the host accepts everything the
//                                 contract admits).
//    node-byte-identity /         encode(decode(inputFile)) is byte-identical
//    op-byte-identity             to expectedFile — the committed corpus IS
//                                 the canonical form, so byte-equality with it
//                                 is byte-equality with every conformant host.
//    node-reject / op-reject      decode(inputFile) fails with the manifest's
//                                 expectedErrorCode at a path starting with
//                                 expectedPath (WIRE_FORMAT.md §6).
//    lenient-accept               decode(inputFile) — a §16 SHORTHAND form —
//                                 succeeds AND encode(decode(inputFile)) is
//                                 byte-identical to expectedFile (the verbose
//                                 canonical form). Mandatory: a host that
//                                 rejects the shorthand, or normalises it to
//                                 different bytes, silently strands AI authors
//                                 (WIRE_FORMAT.md §16 normative block).
//    schema-validation            the host's re-encoded output validates
//                                 against the canonical Draft 2020-12 schema
//                                 (schema.json) — only outputs that already
//                                 passed byte-identity are validated.
//    apply                        reserved; corpus v1 ships no apply fixtures.
//
//  Exceptions thrown by adapter hooks are recorded as fixture failures, never
//  propagated — a crashing codec is a non-conformance finding, not a runner
//  crash.
// ============================================================================

// The named class export is the one binding ajv's CJS dist exposes identically
// under every loader (NodeNext ESM, CJS require, bundlers) — the default-import
// interop differs per loader and is avoided deliberately.
import { Ajv2020 } from 'ajv/dist/2020.js';

import type { AdapterDecodeResult, ConformanceAdapter, ImplementationInfo } from './adapter.js';
import { loadCorpus, type Corpus, type CorpusFixture } from './corpus.js';
import {
  computeVerdict,
  type ConformanceReport,
  type FixtureFailure,
  type LegId,
  type LegResult,
} from './report.js';

export const KIT_NAME = '@fuaran-ui/conformance';
export const KIT_VERSION = '0.1.0';

export interface RunOptions {
  /** Names the candidate implementation in the report. */
  readonly implementation: ImplementationInfo;
  /** Certify against an external corpus checkout instead of the bundled snapshot. */
  readonly corpusRoot?: string;
}

// Fixtures are single-line compact JSON without a trailing newline; strip at
// most one defensively so an editor/git autocrlf touch on a corpus payload
// can't masquerade as a host divergence (the in-house gate's convention).
const canon = (s: string): string => s.replace(/\r?\n$/, '');

/** First byte offset at which two strings differ, with a context window. */
const firstDiff = (expected: string, actual: string): string => {
  const n = Math.min(expected.length, actual.length);
  let i = 0;
  while (i < n && expected[i] === actual[i]) i++;
  const from = Math.max(0, i - 30);
  const win = (s: string): string => JSON.stringify(s.slice(from, i + 30));
  return (
    `byte offset ${i} (length canonical=${expected.length}, host=${actual.length})\n` +
    `  canonical …${win(expected)}…\n` +
    `  host      …${win(actual)}…`
  );
};

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

interface LegAccumulator {
  total: number;
  passed: number;
  failures: FixtureFailure[];
}

const newAcc = (): LegAccumulator => ({ total: 0, passed: 0, failures: [] });

const toLeg = (
  leg: LegId,
  mandatory: boolean,
  acc: LegAccumulator | undefined,
  skipReason?: string,
): LegResult =>
  acc === undefined
    ? {
        leg,
        mandatory,
        status: 'skipped',
        ...(skipReason === undefined ? {} : { skipReason }),
        fixturesTotal: 0,
        fixturesPassed: 0,
        failures: [],
      }
    : {
        leg,
        mandatory,
        status: acc.failures.length === 0 ? 'pass' : 'fail',
        fixturesTotal: acc.total,
        fixturesPassed: acc.passed,
        failures: acc.failures,
      };

/** Run the certification kit: corpus × adapter → report. */
export const runConformance = (
  adapter: ConformanceAdapter,
  options: RunOptions,
): ConformanceReport => {
  const corpus: Corpus = loadCorpus(
    options.corpusRoot === undefined ? undefined : { corpusRoot: options.corpusRoot },
  );

  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const schemaValid = ajv.compile(corpus.schema);

  const accepts = (decoder: 'node' | 'op'): readonly CorpusFixture[] =>
    corpus.fixtures.filter(
      (f) => f.decoder === decoder && (f.kind === 'node-round-trip' || f.kind === 'op-round-trip'),
    );
  const rejects = (decoder: 'node' | 'op'): readonly CorpusFixture[] =>
    corpus.fixtures.filter((f) => f.decoder === decoder && f.kind === 'reject');
  const lenients = (decoder: 'node' | 'op'): readonly CorpusFixture[] =>
    corpus.fixtures.filter((f) => f.decoder === decoder && f.kind === 'lenient-accept');

  // Per-leg accumulators — undefined means the adapter lacks the hooks for the leg.
  const accs = new Map<LegId, LegAccumulator>();
  const acc = (leg: LegId): LegAccumulator => {
    let a = accs.get(leg);
    if (a === undefined) {
      a = newAcc();
      accs.set(leg, a);
    }
    return a;
  };

  const runSide = (
    decoder: 'node' | 'op',
    decode: ((json: string) => AdapterDecodeResult) | undefined,
    encode: ((value: unknown) => string) | undefined,
  ): void => {
    const decodeLeg: LegId = decoder === 'node' ? 'node-decode' : 'op-decode';
    const byteLeg: LegId = decoder === 'node' ? 'node-byte-identity' : 'op-byte-identity';
    const rejectLeg: LegId = decoder === 'node' ? 'node-reject' : 'op-reject';

    if (decode === undefined) return;

    for (const f of accepts(decoder)) {
      const input = corpus.read(f.inputFile);
      const d = acc(decodeLeg);
      d.total++;

      let decoded: AdapterDecodeResult;
      try {
        decoded = decode(input);
      } catch (err) {
        d.failures.push({
          fixtureId: f.id,
          summary: 'decoder THREW on an accept fixture (a conformant decoder never throws)',
          detail: messageOf(err),
        });
        continue;
      }
      if (!decoded.ok) {
        d.failures.push({
          fixtureId: f.id,
          summary: 'decoder rejected an accept fixture',
          detail: `${decoded.error.code} at ${decoded.error.path}${decoded.error.message === undefined ? '' : ` — ${decoded.error.message}`}`,
        });
        continue;
      }
      d.passed++;

      if (encode === undefined) continue;
      const b = acc(byteLeg);
      b.total++;
      const expected = canon(corpus.read(f.expectedFile ?? f.inputFile));
      let actual: string;
      try {
        actual = encode(decoded.value);
      } catch (err) {
        b.failures.push({
          fixtureId: f.id,
          summary: 'encoder THREW re-encoding a decoded accept fixture',
          detail: messageOf(err),
        });
        continue;
      }
      if (actual !== expected) {
        b.failures.push({
          fixtureId: f.id,
          summary: 'encoder output diverges from the canonical form',
          detail: firstDiff(expected, actual),
        });
        continue;
      }
      b.passed++;

      // Schema-validate the host's own (byte-identical) output — proves the
      // host emits schema-valid wire, not merely corpus-identical wire.
      const s = acc('schema-validation');
      s.total++;
      if (schemaValid(JSON.parse(actual))) {
        s.passed++;
      } else {
        s.failures.push({
          fixtureId: f.id,
          summary: 'encoder output fails the canonical JSON Schema (schema.json)',
          detail: (schemaValid.errors ?? [])
            .map((e) => `${e.instancePath === '' ? '$' : e.instancePath} ${e.message ?? ''}`)
            .join('\n'),
        });
      }
    }

    // Lenient-accept (§16): the shorthand MUST decode, and MUST normalise to
    // the verbose canonical bytes. Needs both hooks — with decode only, the
    // leg stays unattempted (skipped), same capability semantics as
    // byte-identity.
    if (encode !== undefined) {
      for (const f of lenients(decoder)) {
        const input = corpus.read(f.inputFile);
        const l = acc('lenient-accept');
        l.total++;

        let decoded: AdapterDecodeResult;
        try {
          decoded = decode(input);
        } catch (err) {
          l.failures.push({
            fixtureId: f.id,
            summary: 'decoder THREW on a §16 shorthand (a conformant decoder accepts it)',
            detail: messageOf(err),
          });
          continue;
        }
        if (!decoded.ok) {
          l.failures.push({
            fixtureId: f.id,
            summary: 'decoder rejected a §16 shorthand (MUST accept — WIRE_FORMAT §16)',
            detail: `${decoded.error.code} at ${decoded.error.path}${decoded.error.message === undefined ? '' : ` — ${decoded.error.message}`}`,
          });
          continue;
        }

        let actual: string;
        try {
          actual = encode(decoded.value);
        } catch (err) {
          l.failures.push({
            fixtureId: f.id,
            summary: 'encoder THREW re-encoding a decoded §16 shorthand',
            detail: messageOf(err),
          });
          continue;
        }
        const expected = canon(corpus.read(f.expectedFile ?? f.inputFile));
        if (actual !== expected) {
          l.failures.push({
            fixtureId: f.id,
            summary: 'shorthand normalisation diverges from the verbose canonical form',
            detail: firstDiff(expected, actual),
          });
          continue;
        }
        l.passed++;
      }
    }

    for (const f of rejects(decoder)) {
      const input = corpus.read(f.inputFile);
      const r = acc(rejectLeg);
      r.total++;

      let decoded: AdapterDecodeResult;
      try {
        decoded = decode(input);
      } catch (err) {
        r.failures.push({
          fixtureId: f.id,
          summary: 'decoder THREW on a reject fixture (must return a structured error)',
          detail: messageOf(err),
        });
        continue;
      }
      if (decoded.ok) {
        r.failures.push({
          fixtureId: f.id,
          summary: 'decoder ACCEPTED a reject fixture',
          detail: `expected ${f.expectedErrorCode} at ${f.expectedPath}`,
        });
        continue;
      }
      if (decoded.error.code !== f.expectedErrorCode) {
        r.failures.push({
          fixtureId: f.id,
          summary: 'decode-error CODE diverges from the canonical error',
          detail: `expected ${f.expectedErrorCode}, got ${decoded.error.code} (path ${decoded.error.path})`,
        });
        continue;
      }
      if (!decoded.error.path.startsWith(f.expectedPath ?? '$')) {
        r.failures.push({
          fixtureId: f.id,
          summary: 'decode-error PATH diverges from the canonical error',
          detail: `expected prefix ${f.expectedPath}, got ${decoded.error.path} (code ${decoded.error.code})`,
        });
        continue;
      }
      r.passed++;
    }
  };

  runSide('node', adapter.decodeNode, adapter.encodeNode);
  runSide('op', adapter.decodeOp, adapter.encodeOp);

  // Envelope / tolerance (WIRE_FORMAT.md §15). `negotiateEnvelope` reads the
  // envelope, negotiates against the host's own core@1.0, and either refuses a
  // Foreign profile or returns the whole envelope re-encoded (unknown kinds
  // preserved). A round-trip fixture asserts the re-encode is byte-identical to
  // expectedFile; a reject fixture asserts the FOREIGN_PROFILE refusal.
  const negotiateEnvelope = adapter.negotiateEnvelope;
  if (negotiateEnvelope !== undefined) {
    const byKind = (kind: 'envelope-round-trip' | 'envelope-reject'): readonly CorpusFixture[] =>
      corpus.fixtures.filter((f) => f.kind === kind);

    for (const f of byKind('envelope-round-trip')) {
      const a = acc('envelope-round-trip');
      a.total++;
      const input = corpus.read(f.inputFile);
      let r: AdapterDecodeResult;
      try {
        r = negotiateEnvelope(input);
      } catch (err) {
        a.failures.push({
          fixtureId: f.id,
          summary:
            'negotiateEnvelope THREW on a round-trip fixture (must return a structured result)',
          detail: messageOf(err),
        });
        continue;
      }
      if (!r.ok) {
        a.failures.push({
          fixtureId: f.id,
          summary:
            'negotiateEnvelope refused a round-trip fixture (Current/Behind must be tolerated)',
          detail: `${r.error.code} at ${r.error.path}`,
        });
        continue;
      }
      const expected = canon(corpus.read(f.expectedFile ?? f.inputFile));
      if (typeof r.value !== 'string' || r.value !== expected) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'envelope re-encode diverges from the canonical form (must-ignore-but-preserve)',
          detail:
            typeof r.value === 'string' ? firstDiff(expected, r.value) : 'value was not a string',
        });
        continue;
      }
      a.passed++;
    }

    for (const f of byKind('envelope-reject')) {
      const a = acc('envelope-reject');
      a.total++;
      const input = corpus.read(f.inputFile);
      let r: AdapterDecodeResult;
      try {
        r = negotiateEnvelope(input);
      } catch (err) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'negotiateEnvelope THREW on a reject fixture (must return a structured error)',
          detail: messageOf(err),
        });
        continue;
      }
      if (r.ok) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'negotiateEnvelope ACCEPTED a Foreign artifact (must hard-refuse)',
          detail: `expected ${f.expectedErrorCode} at ${f.expectedPath}`,
        });
        continue;
      }
      if (r.error.code !== f.expectedErrorCode) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal CODE diverges from the canonical error',
          detail: `expected ${f.expectedErrorCode}, got ${r.error.code} (path ${r.error.path})`,
        });
        continue;
      }
      if (!r.error.path.startsWith(f.expectedPath ?? '$')) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal PATH diverges from the canonical error',
          detail: `expected prefix ${f.expectedPath}, got ${r.error.path}`,
        });
        continue;
      }
      a.passed++;
    }
  }

  // Elicitation envelope + answer conformance (WIRE_FORMAT.md §18).
  // `roundTripElicitation` decodes with the fixture's decoder-named entry
  // point and re-encodes; `validateAnswerDocument` runs the §18.4 answer-
  // conformance gate over a {answer, contract} document.
  const roundTripElicitation = adapter.roundTripElicitation;
  if (roundTripElicitation !== undefined) {
    const elDecoder = (f: CorpusFixture): 'elicitation' | 'elicitation-outcome' =>
      f.decoder === 'elicitation-outcome' ? 'elicitation-outcome' : 'elicitation';

    for (const f of corpus.fixtures.filter((x) => x.kind === 'elicitation-round-trip')) {
      const a = acc('elicitation-round-trip');
      a.total++;
      const input = corpus.read(f.inputFile);
      let r: AdapterDecodeResult;
      try {
        r = roundTripElicitation(elDecoder(f), input);
      } catch (err) {
        a.failures.push({
          fixtureId: f.id,
          summary:
            'roundTripElicitation THREW on a round-trip fixture (must return a structured result)',
          detail: messageOf(err),
        });
        continue;
      }
      if (!r.ok) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'roundTripElicitation refused a round-trip fixture',
          detail: `${r.error.code} at ${r.error.path}`,
        });
        continue;
      }
      const expected = canon(corpus.read(f.expectedFile ?? f.inputFile));
      if (typeof r.value !== 'string' || r.value !== expected) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'elicitation re-encode diverges from the canonical form',
          detail:
            typeof r.value === 'string' ? firstDiff(expected, r.value) : 'value was not a string',
        });
        continue;
      }
      a.passed++;
    }

    for (const f of corpus.fixtures.filter((x) => x.kind === 'elicitation-reject')) {
      const a = acc('elicitation-reject');
      a.total++;
      const input = corpus.read(f.inputFile);
      let r: AdapterDecodeResult;
      try {
        r = roundTripElicitation(elDecoder(f), input);
      } catch (err) {
        a.failures.push({
          fixtureId: f.id,
          summary:
            'roundTripElicitation THREW on a reject fixture (must return a structured error)',
          detail: messageOf(err),
        });
        continue;
      }
      if (r.ok) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'roundTripElicitation ACCEPTED a reject fixture',
          detail: `expected ${f.expectedErrorCode} at ${f.expectedPath}`,
        });
        continue;
      }
      if (r.error.code !== f.expectedErrorCode) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal CODE diverges from the canonical error',
          detail: `expected ${f.expectedErrorCode}, got ${r.error.code} (path ${r.error.path})`,
        });
        continue;
      }
      if (!r.error.path.startsWith(f.expectedPath ?? '$')) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal PATH diverges from the canonical error',
          detail: `expected prefix ${f.expectedPath}, got ${r.error.path}`,
        });
        continue;
      }
      a.passed++;
    }
  }

  const validateAnswerDocument = adapter.validateAnswerDocument;
  if (validateAnswerDocument !== undefined) {
    for (const f of corpus.fixtures.filter(
      (x) => x.kind === 'elicitation-answer-accept' || x.kind === 'elicitation-answer-reject',
    )) {
      const a = acc('elicitation-answer');
      a.total++;
      const input = corpus.read(f.inputFile);
      let r: AdapterDecodeResult;
      try {
        r = validateAnswerDocument(input);
      } catch (err) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'validateAnswerDocument THREW (must return a structured result)',
          detail: messageOf(err),
        });
        continue;
      }
      if (f.kind === 'elicitation-answer-accept') {
        if (!r.ok) {
          a.failures.push({
            fixtureId: f.id,
            summary: 'validateAnswerDocument refused a conforming answer',
            detail: `${r.error.code} at ${r.error.path}`,
          });
          continue;
        }
        a.passed++;
        continue;
      }
      if (r.ok) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'validateAnswerDocument ACCEPTED a nonconforming answer',
          detail: `expected ${f.expectedErrorCode} at ${f.expectedPath}`,
        });
        continue;
      }
      if (r.error.code !== f.expectedErrorCode) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal CODE diverges from the canonical error',
          detail: `expected ${f.expectedErrorCode}, got ${r.error.code} (path ${r.error.path})`,
        });
        continue;
      }
      if (!r.error.path.startsWith(f.expectedPath ?? '$')) {
        a.failures.push({
          fixtureId: f.id,
          summary: 'refusal PATH diverges from the canonical error',
          detail: `expected prefix ${f.expectedPath}, got ${r.error.path}`,
        });
        continue;
      }
      a.passed++;
    }
  }

  const need = (hooks: readonly string[]): string =>
    `adapter does not provide ${hooks.join(' + ')}`;
  const hasSchemaInput = adapter.encodeNode !== undefined || adapter.encodeOp !== undefined;

  const legs: LegResult[] = [
    toLeg('node-decode', true, accs.get('node-decode'), need(['decodeNode'])),
    toLeg(
      'node-byte-identity',
      true,
      accs.get('node-byte-identity'),
      need(['decodeNode', 'encodeNode']),
    ),
    toLeg('node-reject', true, accs.get('node-reject'), need(['decodeNode'])),
    toLeg('op-decode', true, accs.get('op-decode'), need(['decodeOp'])),
    toLeg('op-byte-identity', true, accs.get('op-byte-identity'), need(['decodeOp', 'encodeOp'])),
    toLeg('op-reject', true, accs.get('op-reject'), need(['decodeOp'])),
    toLeg(
      'lenient-accept',
      true,
      accs.get('lenient-accept'),
      need(['a decode + encode hook pair (node and/or op)']),
    ),
    toLeg(
      'envelope-round-trip',
      true,
      accs.get('envelope-round-trip'),
      need(['negotiateEnvelope']),
    ),
    toLeg('envelope-reject', true, accs.get('envelope-reject'), need(['negotiateEnvelope'])),
    toLeg(
      'elicitation-round-trip',
      true,
      accs.get('elicitation-round-trip'),
      need(['roundTripElicitation']),
    ),
    toLeg(
      'elicitation-reject',
      true,
      accs.get('elicitation-reject'),
      need(['roundTripElicitation']),
    ),
    toLeg(
      'elicitation-answer',
      true,
      accs.get('elicitation-answer'),
      need(['validateAnswerDocument']),
    ),
    toLeg(
      'schema-validation',
      true,
      accs.get('schema-validation'),
      hasSchemaInput
        ? need(['a decode hook for the encode hooks provided'])
        : need(['encodeNode and/or encodeOp']),
    ),
    toLeg('apply', false, undefined, 'corpus v1 ships no apply fixtures — leg reserved'),
  ];

  return {
    kit: { name: KIT_NAME, version: KIT_VERSION },
    implementation: options.implementation,
    corpus: {
      manifestVersion: corpus.manifestVersion,
      digest: corpus.digest,
      fixtureCount: corpus.fixtures.length,
      source: corpus.source,
    },
    legs,
    verdict: computeVerdict(legs),
    generatedAt: new Date().toISOString(),
  };
};
