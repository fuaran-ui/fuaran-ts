// ============================================================================
//  Decoder robustness fuzz — this host's leg.
//
//  The threat model's load-bearing claim is that decoding is TOTAL: a malformed
//  or hostile input yields a structured, typed error, never an exception and
//  never a hang. Until a fuzz leg exists on a host, that claim rests there on a
//  CURATED reject corpus — inputs an author chose, which is evidence about the
//  author's imagination rather than about the decoder.
//
//  This suite throws hostile bytes at THIS host's decode path instead. It is the
//  demand-side complement to the generative parity harness, which generates
//  VALID trees and asserts the encode round-trip; this one generates inputs a
//  conformant emitter would never produce and asserts the REFUSAL contract.
//
//  ── The bounded run is the gate; the long run is on demand ────────────────
//
//    FUARAN_FUZZ_ITERATIONS=250000 FUARAN_FUZZ_LONG=1 pnpm --filter @fuaran-ui/ops test
//
//  with FUARAN_FUZZ_SEED to replay a specific stream and FUARAN_FUZZ_EVIDENCE
//  naming a file the run writes its machine-readable result into — which is what
//  makes the published totality figures regenerable by a scheduled job rather
//  than by someone remembering to re-run them.
// ============================================================================

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { boundedConfig, loadSeeds, loadVocabulary, longConfig } from './fuzz/generator.js';
import {
  check,
  defaultBudgets,
  describeCounterexample,
  isCounterexample,
  realSubjects,
  run,
  summarise,
  type Subject,
  type SubjectResult,
} from './fuzz/harness.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');

const seeds = loadSeeds(corpusRoot);
const vocab = loadVocabulary(corpusRoot);

const envInt = (name: string, fallback: number): number => {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`${name}: '${raw}' is not a positive integer`);
  }
  return n;
};

const isLong = process.env['FUARAN_FUZZ_LONG'] === '1';
const config = isLong ? longConfig : boundedConfig;
// A FIXED seed by default: the gate must be reproducible, so a red build is the
// same red build on the next run. A caller who wants a fresh draw passes one.
const seed = BigInt(process.env['FUARAN_FUZZ_SEED'] ?? '1023');
const iterations = envInt('FUARAN_FUZZ_ITERATIONS', isLong ? 250_000 : 4_000);

describe('decoder robustness fuzz', () => {
  it(
    `holds the refusal contract over ${iterations} generated hostile inputs`,
    { timeout: isLong ? 60 * 60_000 : 120_000 },
    () => {
      const stats = run(
        realSubjects,
        defaultBudgets,
        config,
        seed,
        iterations,
        seeds,
        vocab,
        /* minimiseFinds */ true,
      );

      // Printed on every run, pass or fail: a harness whose output is only
      // visible when it fails cannot be checked for having quietly stopped
      // generating anything.
      // eslint-disable-next-line no-console
      console.log(`  [decoder-fuzz] ${summarise(stats)}`);

      const evidencePath = process.env['FUARAN_FUZZ_EVIDENCE'];
      if (evidencePath !== undefined && evidencePath.trim() !== '') {
        mkdirSync(dirname(evidencePath), { recursive: true });
        writeFileSync(
          evidencePath,
          JSON.stringify(
            {
              host: 'fuaran-ts',
              entryPoints: realSubjects.map((s) => s.name),
              config: config.name,
              seed: stats.seed,
              iterations: stats.iterations,
              inputs: stats.inputs,
              corpusSeeds: stats.seedCount,
              corpusPresent: existsSync(join(corpusRoot, 'manifest.json')),
              accepted: stats.accepted,
              rejectCodes: stats.rejectCodes,
              counterexamples: stats.counterexamples.length,
              maxDecodeMs: Number(stats.maxDecodeMs.toFixed(3)),
              maxCanonicalAmplification: Number(stats.maxAmplification.toFixed(3)),
              elapsedSeconds: Number(stats.elapsedSeconds.toFixed(3)),
              generatedAt: new Date().toISOString(),
            },
            null,
            2,
          ) + '\n',
          'utf8',
        );
      }

      if (stats.counterexamples.length > 0) {
        const detail = stats.counterexamples.slice(0, 5).map(describeCounterexample).join('\n\n');
        throw new Error(
          `${stats.counterexamples.length} counterexample(s) — the decoder's refusal contract does ` +
            `not hold over generated hostile input.\n\n${detail}`,
        );
      }

      // A run that generated nothing would report zero counterexamples and look
      // identical to a clean one. Pin the work actually done.
      expect(stats.iterations).toBe(iterations);
      expect(stats.inputs).toBe(iterations * realSubjects.length);
      // Both outcomes must occur. A stream that only ever refuses never reaches
      // the fixed-point invariant; one that only ever accepts is not hostile.
      expect(stats.accepted).toBeGreaterThan(0);
      expect(Object.keys(stats.rejectCodes).length).toBeGreaterThan(0);
    },
  );

  // ── Go-red: the harness fails when the decoder is broken ──────────────────
  //
  // Permanent, not a one-off demonstration at authoring time. Each mutant
  // breaks ONE invariant, and the inverse pin below proves each is PARTIAL — a
  // mutant that broke every input would make the harness look sensitive while
  // testing nothing.

  const okResult: SubjectResult = { tag: 'refused', code: 'INVALID_JSON' };

  /** Fires only on inputs whose length is divisible by `n` — partial by design. */
  const everyNth = (
    n: number,
    name: string,
    broken: (input: string) => SubjectResult,
  ): Subject => ({
    name,
    run: (input: string): SubjectResult => (input.length % n === 0 ? broken(input) : okResult),
  });

  // The slow mutant is measured against a DELIBERATELY TIGHT budget rather than
  // the shipped 3-second one. Busy-waiting past the real budget would cost three
  // seconds per firing and put ~20 s of pure spin into the PR gate — the sort of
  // cost that gets a go-red test deleted rather than fixed. What is under test is
  // the harness's ability to see a decode that returned past ITS budget, and that
  // is exactly as true at 5 ms as at 3 s.
  const tightTimeBudget = { ...defaultBudgets, softTimeMs: 5 };

  const mutants: readonly Subject[] = [
    everyNth(3, 'mutant:throws', () => {
      throw new TypeError('deliberate: the decoder let an exception escape');
    }),
    everyNth(5, 'mutant:slow', () => {
      const until = performance.now() + tightTimeBudget.softTimeMs + 20;
      while (performance.now() < until) {
        /* deliberate: return only past the soft time budget */
      }
      return okResult;
    }),
    everyNth(7, 'mutant:amplifies', () => ({
      tag: 'accepted',
      canonical: 'x'.repeat(defaultBudgets.amplificationFloorChars + 1),
      reDecoded: 'x'.repeat(defaultBudgets.amplificationFloorChars + 1),
    })),
    everyNth(11, 'mutant:canonical-refused', () => ({
      tag: 'accepted',
      canonical: '{}',
      reDecoded: null,
      reDecodedCode: 'INVALID_JSON',
    })),
    everyNth(13, 'mutant:fixed-point-broken', () => ({
      tag: 'accepted',
      canonical: '{"a":1}',
      reDecoded: '{"a":2}',
    })),
  ];

  for (const mutant of mutants) {
    it(`goes red on ${mutant.name}`, { timeout: 120_000 }, () => {
      const stats = run(
        [mutant],
        mutant.name === 'mutant:slow' ? tightTimeBudget : defaultBudgets,
        boundedConfig,
        seed,
        400,
        seeds,
        vocab,
        /* minimiseFinds */ false,
      );
      expect(
        stats.counterexamples.length,
        `${mutant.name} produced no counterexample — the harness cannot see this defect class`,
      ).toBeGreaterThan(0);
    });
  }

  it('the mutants are PARTIAL — each still lets some inputs through', () => {
    // The inverse pin. Without it, a mutant that failed EVERYTHING would satisfy
    // every go-red test above while proving only that the harness reports what
    // it is handed.
    for (const mutant of mutants) {
      const stats = run(
        [mutant],
        mutant.name === 'mutant:slow' ? tightTimeBudget : defaultBudgets,
        boundedConfig,
        seed,
        200,
        seeds,
        vocab,
        /* minimiseFinds */ false,
      );
      expect(
        stats.counterexamples.length,
        `${mutant.name} broke EVERY input — it proves nothing about the harness's discrimination`,
      ).toBeLessThan(stats.inputs);
    }
  });

  it('a real decode of well-formed input is neither a refusal nor a counterexample', () => {
    // The floor under everything above: the machinery must call a GOOD input
    // good. A harness that reported every input as a counterexample would pass
    // every go-red test in this file.
    const good = '{"id":"a","kind":{"$type":"Heading","level":1,"text":"x","variant":"Standard"}}';
    const measured = check(realSubjects[0]!, defaultBudgets, good);
    expect(
      isCounterexample(measured.verdict),
      `a well-formed node decoded as '${measured.verdict.tag}'`,
    ).toBe(false);
    expect(measured.verdict.tag).toBe('clean');
  });
});
