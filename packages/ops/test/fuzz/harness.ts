// ============================================================================
//  The invariant machinery for the decoder robustness fuzz (this host's leg).
//
//  ── The invariants, per input ─────────────────────────────────────────────
//
//   1. Totality      — `decodeNode` / `decodeOp` return a typed `DecodeError`
//                      or a value. A thrown exception is a counterexample.
//   2. Termination   — it returns inside a time budget.
//   3. Bounded work  — the ACCEPTED canonical form stays inside an
//                      amplification bound relative to the input. See the note
//                      on `Budgets.maxAmplification` for why this host measures
//                      output amplification where the reference host measures
//                      allocated bytes: the two are not the same claim, and
//                      pretending otherwise would be the more comfortable lie.
//   4. Fixed point   — an accepted input's canonical form re-decodes and
//                      re-encodes to itself, fuzzed over the reachable
//                      accept-space rather than pinned by fixtures.
//
//  ── Why the subject is a parameter ────────────────────────────────────────
//
//  `Subject` abstracts "decode, canonically re-encode, re-decode, re-encode" so
//  the SAME machinery can be pointed at a deliberately-broken stand-in. A fuzz
//  harness nobody has ever seen fail is decoration: the go-red property is
//  asserted in the suite on every run, not demonstrated once by hand at
//  authoring time and then trusted forever.
// ============================================================================

import { decodeNode, decodeOp, encodeNode, encodeOp } from '../../src/index.js';
import { generate, Rng, type Config, type Generated } from './generator.js';

/** What one decode entry point did with one input. */
export type SubjectResult =
  | { readonly tag: 'refused'; readonly code: string }
  | {
      readonly tag: 'accepted';
      readonly canonical: string;
      /** `null` when the decoder's OWN canonical output is refused — a real defect. */
      readonly reDecoded: string | null;
      readonly reDecodedCode?: string;
    };

/**
 * One decode entry point, or a deliberately-broken stand-in. `run` is allowed —
 * required, in the self-test's case — to throw: catching is the harness's job.
 */
export interface Subject {
  readonly name: string;
  readonly run: (input: string) => SubjectResult;
}

const roundTrip = <T>(
  decode: (s: string) => { ok: true; value: T } | { ok: false; error: { code: string } },
  encode: (v: T) => string,
): ((input: string) => SubjectResult) => {
  return (input: string): SubjectResult => {
    const first = decode(input);
    if (!first.ok) return { tag: 'refused', code: first.error.code };
    const canonical = encode(first.value);
    const again = decode(canonical);
    if (!again.ok) {
      return { tag: 'accepted', canonical, reDecoded: null, reDecodedCode: again.error.code };
    }
    return { tag: 'accepted', canonical, reDecoded: encode(again.value) };
  };
};

export const nodeSubject: Subject = {
  name: 'decodeNode',
  // The typed shapes cross this seam as opaque values: the harness compares
  // canonical FORMS, so it needs no access to the tree type and both entry
  // points share one machinery.
  run: roundTrip(decodeNode as never, encodeNode as never),
};

export const opSubject: Subject = {
  name: 'decodeOp',
  run: roundTrip(decodeOp as never, encodeOp as never),
};

/**
 * The real decode surface — BOTH public entry points, since the totality claim
 * is made about the decoder, not about one of its two doors.
 */
export const realSubjects: readonly Subject[] = [nodeSubject, opSubject];

// ─── Verdicts ───────────────────────────────────────────────────────────────

export type Verdict =
  /** The contract held: a typed refusal carrying this code. */
  | { readonly tag: 'rejected'; readonly code: string }
  /** The contract held: accepted, and its canonical form is a fixed point. */
  | { readonly tag: 'clean' }
  /** Invariant 1 broken — an exception escaped the decode path. */
  | { readonly tag: 'escaped'; readonly kind: string; readonly message: string }
  /** Invariant 2 broken — the decode returned, but past the soft time budget. */
  | { readonly tag: 'timed-out'; readonly ms: number }
  /** Invariant 3 broken — the canonical form is disproportionate to the input. */
  | { readonly tag: 'over-amplified'; readonly chars: number; readonly budget: number }
  /** Invariant 4 broken — the decoder's own canonical output is refused. */
  | { readonly tag: 'canonical-refused'; readonly code: string }
  /** Invariant 4 broken — the canonical form is not a fixed point. */
  | { readonly tag: 'fixed-point-broken'; readonly first: string; readonly second: string }
  /**
   * The ONE observed-and-excluded defect class. Named rather than numbered, so a
   * reader meets the reason at the point of the exclusion.
   *
   * The wire specification's §5 requires every host to EMIT the quoted `"NaN"` /
   * `"Infinity"` / `"-Infinity"` sentinels for a non-finite number, and its §7
   * requires a decoder to ACCEPT them at a float slot. Not every host accepts
   * them at every such slot, so `decode → encode → decode` does not close on a
   * document carrying a non-finite number — and a generated stream reaches one
   * within a few thousand inputs. The specification already records this as a §7
   * conformance defect rather than an open question.
   *
   * Excluded here, not because it is unimportant, but because it spans more than
   * one host: fixing it in one alone would manufacture a new divergence of
   * precisely the kind the cross-host parity work exists to close. It is COUNTED
   * and PRINTED on every run, and it disappears on its own the moment the decoder
   * accepts what it emits.
   *
   * Keyed on the CAUSE — a sentinel in the canonical form — never on a fixture id
   * or an iteration number: the seed pool is the shared corpus, so the generated
   * stream renumbers whenever the corpus moves, and an exclusion keyed to an
   * iteration would silence a different defect next week.
   */
  | { readonly tag: 'known-nonfinite-roundtrip-hole'; readonly code: string };

const NON_FINITE_SENTINELS = ['"NaN"', '"Infinity"', '"-Infinity"'];

export const isKnownNonFiniteHole = (canonical: string): boolean =>
  NON_FINITE_SENTINELS.some((s) => canonical.includes(s));

/**
 * Did this verdict violate the refusal contract? `rejected` and `clean` are both
 * PASSES — a fuzz harness that treated refusal as failure would be asserting the
 * opposite of the claim under test.
 */
export const isCounterexample = (v: Verdict): boolean =>
  v.tag !== 'rejected' && v.tag !== 'clean' && v.tag !== 'known-nonfinite-roundtrip-hole';

/**
 * A coarse class, used to hold a failure steady while minimising. Deliberately
 * drops the payload-specific detail: a smaller input that fails the same WAY is
 * the reduction we want, and demanding byte-identical detail would refuse almost
 * every candidate.
 */
export const verdictClass = (v: Verdict): string => {
  switch (v.tag) {
    case 'rejected':
    case 'clean':
      return 'held';
    case 'escaped':
      return 'escaped-' + v.kind;
    default:
      return v.tag;
  }
};

export const describeVerdict = (v: Verdict): string => {
  switch (v.tag) {
    case 'rejected':
      return 'rejected ' + v.code;
    case 'clean':
      return 'accepted; canonical form is a fixed point';
    case 'escaped':
      return `EXCEPTION ESCAPED: ${v.kind} — ${v.message}`;
    case 'timed-out':
      return `TIME BUDGET EXCEEDED: decode returned only after ${v.ms.toFixed(0)} ms`;
    case 'over-amplified':
      return `AMPLIFICATION BUDGET EXCEEDED: canonical form is ${v.chars} chars, budget ${v.budget}`;
    case 'canonical-refused':
      return `CANONICAL FORM REFUSED: the decoder's own output re-decodes as ${v.code}`;
    case 'fixed-point-broken':
      return `FIXED POINT BROKEN: first canonical form (${v.first.length} chars) <> second (${v.second.length})`;
    case 'known-nonfinite-roundtrip-hole':
      return `KNOWN (EXCLUDED) §7 non-finite round-trip hole: the canonical form re-decodes as ${v.code}`;
  }
};

// ─── Budgets ────────────────────────────────────────────────────────────────

export interface Budgets {
  /** Past this, a decode that DID return is reported as a counterexample. */
  readonly softTimeMs: number;
  /**
   * Floor on the canonical form's length for an ORDINARY input: below this, no
   * input is judged over-amplified however short it was. Covers the fixed cost
   * of canonicalising a small document into its verbose form.
   */
  readonly amplificationFloorChars: number;
  /**
   * Allowed canonical-form length per input character, above the floor.
   *
   * THIS IS NOT THE REFERENCE HOST'S INVARIANT, and the difference is stated
   * rather than smoothed over. That host measures allocated BYTES per input
   * character, which this runtime does not expose per call at any useful
   * fidelity — `heapUsed` moves with the garbage collector, not with the
   * decode. What is measurable here, deterministically, is how much CANONICAL
   * OUTPUT an input buys, which is the amplification an untrusted producer
   * actually controls on the accept path. It catches a decoder that turns a
   * small document into a large one; it would not catch one that allocates
   * heavily and then discards. The time budget is what stands in for the
   * second, and this comment is what stops the pair being read as the whole.
   */
  readonly maxAmplification: number;
}

export const defaultBudgets: Budgets = {
  softTimeMs: 3000,
  amplificationFloorChars: 64 * 1024,
  maxAmplification: 64,
};

const amplificationBudget = (b: Budgets, input: string): number =>
  Math.max(b.amplificationFloorChars, b.maxAmplification * input.length);

// ─── The measured check ─────────────────────────────────────────────────────

/**
 * Run one input through one subject and judge it against every invariant. Every
 * exception is caught HERE and nowhere else, which is what makes "no exception
 * escapes" a measured property rather than a hope.
 *
 * A stack overflow is the one escape this cannot always report faithfully: V8
 * raises `RangeError: Maximum call stack size exceeded`, which IS catchable, so
 * it surfaces as an `escaped-RangeError` counterexample rather than killing the
 * process. That is a genuine advantage of this runtime over the reference
 * host's, and it is why the deep-nesting family matters most here.
 */
export interface Measured {
  readonly verdict: Verdict;
  readonly elapsedMs: number;
  /** `0` for a refused input — there is no canonical form to be disproportionate to. */
  readonly canonicalChars: number;
}

export const check = (subject: Subject, budgets: Budgets, input: string): Measured => {
  const started = performance.now();
  let result: SubjectResult;
  try {
    result = subject.run(input);
  } catch (err) {
    const kind = err instanceof Error ? err.constructor.name : typeof err;
    const message = err instanceof Error ? err.message : String(err);
    return {
      verdict: { tag: 'escaped', kind, message },
      elapsedMs: performance.now() - started,
      canonicalChars: 0,
    };
  }
  const elapsedMs = performance.now() - started;
  const canonicalChars = result.tag === 'accepted' ? result.canonical.length : 0;
  const at = (verdict: Verdict): Measured => ({ verdict, elapsedMs, canonicalChars });

  // Order matters: an input that both ran long AND over-amplified is reported
  // as the time breach, because that is the one an operator has to act on first.
  if (elapsedMs > budgets.softTimeMs) return at({ tag: 'timed-out', ms: elapsedMs });

  if (result.tag === 'refused') return at({ tag: 'rejected', code: result.code });

  const budget = amplificationBudget(budgets, input);
  if (result.canonical.length > budget) {
    return at({ tag: 'over-amplified', chars: result.canonical.length, budget });
  }
  if (result.reDecoded === null) {
    const code = result.reDecodedCode ?? 'UNKNOWN';
    return at(
      isKnownNonFiniteHole(result.canonical)
        ? { tag: 'known-nonfinite-roundtrip-hole', code }
        : { tag: 'canonical-refused', code },
    );
  }
  return at(
    result.canonical === result.reDecoded
      ? { tag: 'clean' }
      : { tag: 'fixed-point-broken', first: result.canonical, second: result.reDecoded },
  );
};

// ─── Minimisation ───────────────────────────────────────────────────────────

/**
 * Delta-debugging by span deletion: repeatedly cut a chunk and keep the cut if
 * the input still fails the same WAY. Bounded by a candidate count AND a wall
 * clock, because the class most worth minimising (a time breach) is exactly the
 * one where each probe is expensive.
 */
export const minimise = (
  classify: (candidate: string) => string,
  target: string,
  input: string,
): string => {
  const started = performance.now();
  let best = input;
  let granularity = 2;
  let budget = 400;
  let go = true;

  while (go && budget > 0 && performance.now() - started < 25_000) {
    const chunk = Math.max(1, Math.floor(best.length / granularity));
    let reduced = false;
    let i = 0;
    while (i < best.length && budget > 0 && performance.now() - started < 25_000) {
      const take = Math.min(chunk, best.length - i);
      const candidate = best.slice(0, i) + best.slice(i + take);
      budget--;
      if (candidate.length > 0 && classify(candidate) === target) {
        best = candidate;
        reduced = true;
      } else {
        i += take;
      }
    }
    if (reduced) granularity = Math.max(2, Math.floor(granularity / 2));
    else if (chunk > 1) granularity *= 2;
    else go = false;
  }
  return best;
};

// ─── The run ────────────────────────────────────────────────────────────────

export interface Counterexample {
  readonly subject: string;
  readonly iteration: number;
  readonly seed: string;
  readonly configName: string;
  readonly origin: string;
  readonly verdict: Verdict;
  readonly original: string;
  readonly minimised: string;
}

export interface RunStats {
  iterations: number;
  inputs: number;
  seedCount: number;
  rejectCodes: Record<string, number>;
  accepted: number;
  /**
   * The one EXCLUDED defect class, counted and published rather than dropped: an
   * exclusion nobody can see reads as "found nothing".
   */
  knownNonFiniteHoles: number;
  maxDecodeMs: number;
  maxAmplification: number;
  elapsedSeconds: number;
  seed: string;
  counterexamples: Counterexample[];
}

/**
 * Run `iterations` generated inputs through every subject, judging each against
 * every invariant. `subjects` is a parameter precisely so the go-red self-test
 * drives the IDENTICAL machinery with a broken stand-in.
 */
export const run = (
  subjects: readonly Subject[],
  budgets: Budgets,
  cfg: Config,
  seed: bigint,
  iterations: number,
  seeds: readonly string[],
  vocab: readonly string[],
  minimiseFinds: boolean,
): RunStats => {
  const rng = new Rng(seed);
  const started = performance.now();
  const stats: RunStats = {
    iterations: 0,
    inputs: 0,
    seedCount: seeds.length,
    rejectCodes: {},
    accepted: 0,
    knownNonFiniteHoles: 0,
    maxDecodeMs: 0,
    maxAmplification: 0,
    elapsedSeconds: 0,
    seed: seed.toString(),
    counterexamples: [],
  };

  // JIT warm-up against the REAL entry points, never `subjects`. Warming through
  // the caller's subjects spends a self-test mutant's firing budget on inputs
  // nobody is measuring, so the go-red proof reports "found nothing" and the
  // harness looks broken when it is the warm-up that ate the evidence.
  for (const s of seeds.slice(0, 8)) {
    for (const subject of realSubjects) {
      try {
        subject.run(s);
      } catch {
        /* warm-up only */
      }
    }
  }

  for (let i = 1; i <= iterations; i++) {
    const g: Generated = generate(rng, seeds, vocab, cfg, i);
    for (const subject of subjects) {
      const measured = check(subject, budgets, g.payload);
      const verdict = measured.verdict;

      stats.inputs++;
      stats.maxDecodeMs = Math.max(stats.maxDecodeMs, measured.elapsedMs);
      if (measured.canonicalChars > 0 && g.payload.length > 0) {
        stats.maxAmplification = Math.max(
          stats.maxAmplification,
          measured.canonicalChars / g.payload.length,
        );
      }

      if (verdict.tag === 'rejected') {
        stats.rejectCodes[verdict.code] = (stats.rejectCodes[verdict.code] ?? 0) + 1;
      } else if (verdict.tag === 'clean') {
        stats.accepted++;
      } else if (verdict.tag === 'known-nonfinite-roundtrip-hole') {
        stats.knownNonFiniteHoles++;
      } else {
        const target = verdictClass(verdict);
        const minimised = minimiseFinds
          ? minimise(
              (candidate) => verdictClass(check(subject, budgets, candidate).verdict),
              target,
              g.payload,
            )
          : g.payload;
        stats.counterexamples.push({
          subject: subject.name,
          iteration: i,
          seed: seed.toString(),
          configName: cfg.name,
          origin: g.origin,
          verdict,
          original: g.payload,
          minimised,
        });
      }
    }
    stats.iterations = i;
  }

  stats.elapsedSeconds = (performance.now() - started) / 1000;
  return stats;
};

/** A one-line human summary, shared by the gate test and the long-run CLI. */
export const summarise = (stats: RunStats): string => {
  const codes = Object.entries(stats.rejectCodes)
    .sort((a, b) => b[1] - a[1])
    .map(([code, n]) => `${code}=${n}`)
    .join(' ');
  const perIteration = stats.iterations === 0 ? 0 : stats.inputs / stats.iterations;
  return (
    `${stats.inputs} inputs (${stats.iterations} iterations x ${perIteration} entry points) ` +
    `in ${stats.elapsedSeconds.toFixed(1)} s — accepted ${stats.accepted}, refused [${codes}], ` +
    `${stats.counterexamples.length} counterexamples, ${stats.knownNonFiniteHoles} known ` +
    `non-finite round-trip holes (§7, EXCLUDED); max decode ${stats.maxDecodeMs.toFixed(0)} ms; ` +
    `max canonical amplification ${stats.maxAmplification.toFixed(1)} x`
  );
};

/** A reported find, formatted so it can be acted on without re-running anything. */
export const describeCounterexample = (c: Counterexample): string => {
  const preview =
    c.minimised.length > 300 ? c.minimised.slice(0, 300) + ' ...(truncated)' : c.minimised;
  return [
    `subject: ${c.subject}`,
    `seed: ${c.seed}, iteration: ${c.iteration}, config: ${c.configName}`,
    `origin: ${c.origin}`,
    `verdict: ${describeVerdict(c.verdict)}`,
    `length: ${c.original.length} chars original, ${c.minimised.length} minimised`,
    `minimised input: ${JSON.stringify(preview)}`,
    '',
    'Counterexample policy: fix the decoder, then land the minimised input as a',
    'permanent reject fixture in the shared corpus, so every conformant host',
    'inherits the case rather than only this one.',
  ].join('\n');
};
