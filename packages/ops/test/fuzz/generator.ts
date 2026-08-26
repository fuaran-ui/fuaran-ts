// ============================================================================
//  Hostile-input generator for the decoder robustness fuzz (this host's leg).
//
//  A sibling implementation of the generator strategy the reference host runs,
//  not a transpile of it: the same five INPUT FAMILIES, expressed in this
//  language's own terms. What is shared is the classification, because that is
//  what makes two hosts' fuzz results comparable; what is deliberately not
//  shared is the byte stream, because it cannot be — the reference host's
//  hostile alphabet includes lone UTF-16 surrogates, which several conformant
//  hosts cannot even hold in a string. A generator claiming byte-identity
//  across all hosts would be claiming something false about three of them.
//
//  ── The five families ─────────────────────────────────────────────────────
//
//   1. corpus-seeded mutation   — take a real fixture and corrupt it, with a
//                                 named mutator chain so a find is actionable.
//   2. near-miss vocabulary     — a discriminator one edit away from a real
//                                 one, read from the corpus MANIFEST so a newly
//                                 admitted kind is fuzzed the day it lands.
//   3. structure-aware          — random JSON assembled from REAL wire keys, so
//                                 it reaches the typed decoders rather than
//                                 bouncing off the first MISSING_FIELD.
//   4. crossover                — prefix of one seed, suffix of another.
//   5. pathological             — depth, width and string length taken past the
//                                 §21 limits, assembled as TEXT (building one
//                                 as a nested value would blow the stack while
//                                 CONSTRUCTING the input, which proves nothing
//                                 about the decoder).
//
//  ── Determinism ──────────────────────────────────────────────────────────
//
//  SplitMix64 over BigInt, not Math.random: replayability is the whole point of
//  the seed. Given the same seed and Config, iteration N is identical on every
//  machine and every Node version.
// ============================================================================

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const MASK = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;

/** SplitMix64. `Math.random` has no seed at all; this one replays exactly. */
export class Rng {
  private s: bigint;

  constructor(seed: bigint) {
    this.s = seed === 0n ? GOLDEN : seed & MASK;
  }

  nextU64(): bigint {
    this.s = (this.s + GOLDEN) & MASK;
    let z = this.s;
    z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & MASK;
    z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & MASK;
    return (z ^ (z >> 31n)) & MASK;
  }

  /** Uniform in `[0, n)`; `0` for a non-positive `n` so no caller has to guard. */
  next(n: number): number {
    if (n <= 1) return 0;
    return Number(this.nextU64() % BigInt(n));
  }

  /** Uniform in `[lo, hi]`, inclusive. */
  range(lo: number, hi: number): number {
    if (hi <= lo) return lo;
    return lo + this.next(hi - lo + 1);
  }

  bool(): boolean {
    return this.nextU64() % 2n === 1n;
  }

  pick<T>(xs: readonly T[]): T {
    return xs[this.next(xs.length)]!;
  }
}

// ─── Corpus seeds + vocabulary ──────────────────────────────────────────────

/**
 * Built-in seeds, so the harness is self-sufficient: the go-red self-test must
 * not depend on the shared corpus being checked out alongside this repo in
 * order to prove that the harness can fail.
 */
const BUILTIN_SEEDS: readonly string[] = [
  '{"id":"a","kind":{"$type":"Heading","level":1,"text":"x","variant":"Standard"}}',
  '{"id":"b","kind":{"$type":"Box","children":[],"layout":{"$type":"Auto"},"role":"Group"}}',
  '{"id":"c","kind":{"$type":"Markdown","source":"# hi"}}',
  '{"$type":"RemoveNode","path":["a"]}',
  '{"$type":"Batch","ops":[]}',
  '{}',
  '[]',
  'null',
  '',
];

/**
 * Every corpus payload the harness can find, as raw text. READ-ONLY by
 * construction: the fuzz never writes into the corpus. A REJECT fixture is the
 * most productive seed there is, since it already sits one edit away from the
 * refusal boundary the fuzz is probing.
 */
export const loadSeeds = (corpusRoot: string): string[] => {
  const fromCorpus: string[] = [];
  for (const family of ['nodes', 'ops', 'reject', 'lenient']) {
    const dir = join(corpusRoot, family);
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir).sort()) {
      if (!f.endsWith('.json') || f.endsWith('.expected.json')) continue;
      try {
        fromCorpus.push(readFileSync(join(dir, f), 'utf8'));
      } catch {
        // A payload we cannot read is one fewer seed, never a harness failure.
      }
    }
  }
  return [...BUILTIN_SEEDS, ...fromCorpus];
};

const FALLBACK_VOCAB: readonly string[] = [
  'Box',
  'Heading',
  'Markdown',
  'Metric',
  'Badge',
  'Form',
  'Button',
  'DataGrid',
  'Chart',
  'Custom',
];

/**
 * The wire vocabulary the near-miss generators aim just beside. Read from the
 * corpus manifest when available, so a newly-admitted kind is fuzzed the day it
 * lands rather than whenever someone remembers to extend a literal list here.
 */
export const loadVocabulary = (corpusRoot: string): string[] => {
  try {
    const manifest = JSON.parse(readFileSync(join(corpusRoot, 'manifest.json'), 'utf8')) as {
      kinds?: string[];
    };
    if (Array.isArray(manifest.kinds) && manifest.kinds.length > 0) return manifest.kinds;
  } catch {
    // Fall through — a corpus-less checkout still gets a working harness.
  }
  return [...FALLBACK_VOCAB];
};

// ─── Alphabets ──────────────────────────────────────────────────────────────

const HOSTILE_CHARS: readonly string[] = [
  '{',
  '}',
  '[',
  ']',
  '"',
  ':',
  ',',
  '\\',
  '/',
  '-',
  '+',
  '.',
  'e',
  'E',
  '0',
  '9',
  'n',
  't',
  'f',
  ' ',
  '\t',
  '\n',
  '\r',
  '\u0000',
  '\u007f',
  '\ufeff',
  // Lone surrogates: representable in a JS string exactly as they are in the
  // reference host's, and NOT representable in three of the other hosts'. This
  // is where a shared byte stream would have had to stop.
  '\ud800',
  '\udfff',
  '\u2028',
  'é',
  '中',
];

const HOSTILE_TOKENS: readonly string[] = [
  'null',
  'true',
  'false',
  '{}',
  '[]',
  '""',
  '-0',
  '1e999',
  '-1e999',
  '1E-999',
  'NaN',
  'Infinity',
  '-Infinity',
  '0x10',
  '00',
  '01',
  '1.2.3',
  '+1',
  '.5',
  '5.',
  '\\u0000',
  '\\uD800',
  '\\uFFFF',
  '\\x41',
  '\\',
  '\\"',
  '"$type":""',
  '"$type":null',
  '"id":""',
  '"id":null',
  '"id":[]',
  '"kind":"Heading"',
  '"children":"x"',
  ',',
  ':',
  '[',
  ']',
  '{',
  '}',
  '"',
  "'",
  '/*',
  '*/',
  '//',
  '\u0000',
  '\ufeff',
  '\ud800',
  '\r\n',
];

/**
 * The JSON key vocabulary a plausible-but-wrong document is assembled from —
 * REAL wire keys, so a generated near-miss reaches deep into the typed decoders.
 * `__proto__` / `constructor` are in the list because a JSON decoder is a
 * prototype-pollution surface in THIS language above all, and the shared corpus
 * cannot express a trap that only one host has.
 */
const WIRE_KEYS: readonly string[] = [
  'id',
  'kind',
  '$type',
  'children',
  'layout',
  'role',
  'text',
  'level',
  'variant',
  'source',
  'value',
  'label',
  'fields',
  'items',
  'columns',
  'rows',
  'onSubmit',
  'onClick',
  'required',
  'binding',
  'style',
  'props',
  'state',
  'ops',
  'path',
  'node',
  'index',
  'target',
  'name',
  'format',
  'unit',
  'min',
  'max',
  'options',
  'spec',
  '__proto__',
  'constructor',
  'prototype',
  '',
  ' ',
];

const SCALAR_LITERALS: readonly string[] = [
  '0',
  '-1',
  '1e308',
  '-1e308',
  '1e999',
  '3.141592653589793',
  'true',
  'false',
  'null',
  '""',
  '"x"',
  '"Standard"',
  '"Group"',
  '9007199254740993',
  '-0.0',
];

/**
 * A near-miss of a real vocabulary word: the class of input a model emitter
 * actually produces, and the class a curated reject corpus is worst at covering,
 * because a human writing fixtures reaches for obvious garbage.
 */
const nearMiss = (rng: Rng, word: string): string => {
  if (word.length === 0) return 'x';
  switch (rng.next(8)) {
    case 0:
      return word.toLowerCase();
    case 1:
      return word.toUpperCase();
    case 2:
      return word + 's';
    case 3:
      return word.slice(0, -1);
    case 4:
      return word + ' ';
    case 5:
      return ' ' + word;
    case 6: {
      const i = rng.next(word.length);
      return word.slice(0, i) + word.slice(i + 1);
    }
    default: {
      const i = rng.next(word.length);
      return word.slice(0, i) + rng.pick(HOSTILE_CHARS) + word.slice(i);
    }
  }
};

// ─── Mutators ───────────────────────────────────────────────────────────────
//
// Each corrupts a seed payload. Named individually so a reported counterexample
// records WHICH transformation produced it: a find whose provenance is only
// "the fuzzer did something" is markedly harder to act on.

const MUTATOR_NAMES: readonly string[] = [
  'flip-char',
  'delete-span',
  'insert-token',
  'duplicate-span',
  'truncate',
  'transpose',
  'repeat-structural',
  'retype-value',
  'near-miss-type',
  'delete-key',
  'duplicate-key',
  'escape-injection',
  'prefix-junk',
  'suffix-junk',
];

/** Replace the value of a randomly-chosen `"$type":"…"` with a near-miss. */
const nearMissType = (rng: Rng, vocab: readonly string[], s: string): string => {
  const marker = '"$type":"';
  const positions: number[] = [];
  let i = s.indexOf(marker);
  while (i >= 0) {
    positions.push(i);
    i = s.indexOf(marker, i + marker.length);
  }
  if (positions.length === 0) {
    // No discriminator to corrupt — append one rather than returning the input
    // untouched. A silently no-op mutator quietly shrinks the effective
    // iteration count and nothing reports that it did.
    return s + '{"$type":"' + nearMiss(rng, rng.pick(vocab)) + '"}';
  }
  const start = positions[rng.next(positions.length)]! + marker.length;
  const close = s.indexOf('"', start);
  if (close < 0) return s;
  const replacement = rng.bool()
    ? nearMiss(rng, s.slice(start, close))
    : nearMiss(rng, rng.pick(vocab));
  return s.slice(0, start) + replacement + s.slice(close);
};

/**
 * Delete a whole `"key":value` pair, approximated by cutting from the key's
 * opening quote to just past the next comma.
 */
const deleteKey = (rng: Rng, s: string): string => {
  const positions: number[] = [];
  let i = s.indexOf('":');
  while (i >= 0) {
    positions.push(i);
    i = s.indexOf('":', i + 2);
  }
  if (positions.length === 0) return s;
  const colon = positions[rng.next(positions.length)]!;
  let closeQuote = colon;
  while (closeQuote > 0 && s[closeQuote] !== '"') closeQuote--;
  let openQuote = closeQuote - 1;
  while (openQuote > 0 && s[openQuote] !== '"') openQuote--;
  const cutFrom = Math.max(0, openQuote);
  const comma = s.indexOf(',', colon);
  const cutTo = comma < 0 ? Math.min(s.length, colon + 8) : comma + 1;
  return s.slice(0, cutFrom) + s.slice(cutTo);
};

const repeat = (s: string, n: number): string => (n <= 0 ? '' : s.repeat(n));

const mutateOnce = (
  rng: Rng,
  vocab: readonly string[],
  cfg: Config,
  s: string,
): [string, string] => {
  const name = rng.pick(MUTATOR_NAMES);
  const len = s.length;
  let result: string;

  switch (name) {
    case 'flip-char':
      if (len > 0) {
        const i = rng.next(len);
        result = s.slice(0, i) + rng.pick(HOSTILE_CHARS) + s.slice(i + 1);
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'delete-span':
      if (len > 1) {
        const i = rng.next(len);
        result = s.slice(0, i) + s.slice(i + Math.min(len - i, rng.range(1, 8)));
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'insert-token': {
      const i = rng.next(len + 1);
      result = s.slice(0, i) + rng.pick(HOSTILE_TOKENS) + s.slice(i);
      break;
    }
    case 'duplicate-span':
      if (len > 1) {
        const i = rng.next(len);
        const n = Math.min(len - i, rng.range(1, 64));
        const at = rng.next(len + 1);
        result = s.slice(0, at) + s.slice(i, i + n) + s.slice(at);
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'truncate':
      result = len > 1 ? s.slice(0, rng.next(len)) : s + rng.pick(HOSTILE_CHARS);
      break;
    case 'transpose':
      if (len > 2) {
        const i = rng.next(len - 1);
        result = s.slice(0, i) + s[i + 1]! + s[i]! + s.slice(i + 2);
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'repeat-structural': {
      const ch = rng.pick(['[', '{', '"', ']', '}', ',']);
      const n = Math.min(rng.range(2, 4096), Math.max(2, Math.floor(cfg.maxPayloadChars / 4)));
      const at = rng.next(len + 1);
      result = s.slice(0, at) + repeat(ch, n) + s.slice(at);
      break;
    }
    case 'retype-value':
      if (len > 0) {
        const i = rng.next(len);
        result =
          s.slice(0, i) +
          rng.pick(SCALAR_LITERALS) +
          s.slice(i + Math.min(len - i, rng.range(1, 12)));
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'near-miss-type':
      result = nearMissType(rng, vocab, s);
      break;
    case 'delete-key':
      result = deleteKey(rng, s);
      break;
    case 'duplicate-key': {
      // A duplicated key is a real emitter defect and a classic cross-host
      // parser divergence (first-wins vs last-wins vs refuse) — §20 of the wire
      // specification records the measured matrix and proposes a rule. Fuzzing
      // it for CRASHES is in scope here; asserting which behaviour is correct
      // is not, until that rule is ratified.
      const i = s.indexOf('"');
      const j = i < 0 ? -1 : s.indexOf(',', i);
      result = j < 0 ? s : s.slice(0, j + 1) + s.slice(i, j) + ',' + s.slice(j + 1);
      break;
    }
    case 'escape-injection':
      if (len > 0) {
        const i = rng.next(len);
        result =
          s.slice(0, i) + rng.pick(['\\u', '\\uD800', '\\u00', '\\', '\\/', '\\b\\f']) + s.slice(i);
      } else result = s + rng.pick(HOSTILE_CHARS);
      break;
    case 'prefix-junk': {
      const n = rng.range(1, 16);
      let junk = '';
      for (let k = 0; k < n; k++) junk += rng.pick(HOSTILE_CHARS);
      result = junk + s;
      break;
    }
    case 'suffix-junk': {
      const n = rng.range(1, 16);
      let junk = '';
      for (let k = 0; k < n; k++) junk += rng.pick(HOSTILE_CHARS);
      result = s + junk;
      break;
    }
    default:
      result = s + rng.pick(HOSTILE_CHARS);
  }

  const capped =
    result.length > cfg.maxPayloadChars ? result.slice(0, cfg.maxPayloadChars) : result;
  return [name, capped];
};

// ─── Structure-aware generation ─────────────────────────────────────────────

const genValue = (
  rng: Rng,
  depth: number,
  out: string[],
  size: { n: number },
  vocab: readonly string[],
  cfg: Config,
): void => {
  const push = (s: string): void => {
    out.push(s);
    size.n += s.length;
  };

  if (size.n > cfg.maxPayloadChars) {
    push('0');
    return;
  }
  if (depth <= 0) {
    push(rng.pick(SCALAR_LITERALS));
    return;
  }

  const branch = rng.next(12);
  if (branch <= 3) {
    push(rng.pick(SCALAR_LITERALS));
  } else if (branch <= 7) {
    push('{');
    const n = rng.range(0, 5);
    for (let i = 0; i < n; i++) {
      if (i > 0) push(',');
      push('"' + rng.pick(WIRE_KEYS) + '":');
      genValue(rng, depth - 1, out, size, vocab, cfg);
    }
    push('}');
  } else if (branch <= 10) {
    push('[');
    const n = rng.range(0, 5);
    for (let i = 0; i < n; i++) {
      if (i > 0) push(',');
      genValue(rng, depth - 1, out, size, vocab, cfg);
    }
    push(']');
  } else {
    // A plausible node shell around a wrong interior: the shape that gets
    // furthest into the typed decoders before it fails, and so the one most
    // likely to reach code a shallow syntax reject never does.
    push('{"id":"g","kind":{"$type":"');
    push(nearMiss(rng, rng.pick(vocab)));
    push('","');
    push(rng.pick(WIRE_KEYS) + '":');
    genValue(rng, depth - 1, out, size, vocab, cfg);
    push('}}');
  }
};

/**
 * The deliberately pathological family — depth, width and string length taken
 * past the §21 limits. Every payload is assembled as TEXT: building one as a
 * nested value would blow the stack while CONSTRUCTING the input, which proves
 * nothing about the decoder.
 */
const genPathological = (rng: Rng, cfg: Config): string => {
  const cap = cfg.maxPayloadChars;
  switch (rng.next(9)) {
    case 0: {
      const n = Math.min(Math.floor(cap / 2), rng.range(64, 200000));
      return repeat('[', n) + repeat(']', n);
    }
    case 1: {
      const n = Math.min(Math.floor(cap / 6), rng.range(64, 100000));
      return repeat('{"a":', n) + '1' + repeat('}', n);
    }
    case 2: {
      // Unterminated as well as over-deep: the depth guard must fire on the way
      // DOWN, before truncation is ever reached.
      const n = Math.min(Math.floor(cap / 2), rng.range(64, 200000));
      return repeat('[', n);
    }
    case 3: {
      // Deep NODE nesting rather than deep JSON — crosses the tree depth bound
      // while staying far inside the JSON one, isolating the tree limit.
      const depth = rng.range(2, 400);
      let acc =
        '{"id":"leaf","kind":{"$type":"Heading","level":1,"text":"x","variant":"Standard"}}';
      for (let i = 1; i <= depth; i++) {
        if (acc.length >= cap) break;
        acc =
          '{"id":"n' +
          i +
          '","kind":{"$type":"Box","children":[' +
          acc +
          '],"layout":{"$type":"Auto"},"role":"Group"}}';
      }
      return acc;
    }
    case 4: {
      const n = Math.min(Math.floor(cap / 2), rng.range(1000, 200000));
      return '{"id":"a","kind":[' + new Array(n).fill('1').join(',') + ']}';
    }
    case 5: {
      const n = Math.min(cap, rng.range(1000, 1200000));
      return (
        '{"id":"a","kind":{"$type":"Heading","level":1,"text":"' +
        repeat('x', n) +
        '","variant":"Standard"}}'
      );
    }
    case 6: {
      const depth = rng.range(2, 300);
      let acc = '{"$type":"Batch","ops":[]}';
      for (let i = 0; i < depth; i++) {
        if (acc.length >= cap) break;
        acc = '{"$type":"Batch","ops":[' + acc + ']}';
      }
      return acc;
    }
    case 7: {
      // Escape-heavy: nearly every character an escape, so the unescape path
      // does the work rather than the structural walk.
      const n = Math.min(Math.floor(cap / 6), rng.range(500, 100000));
      return '{"id":"a","kind":{"$type":"Markdown","source":"' + repeat('\\u0041', n) + '"}}';
    }
    default: {
      const n = Math.min(Math.floor(cap / 4), rng.range(500, 50000));
      const parts: string[] = [];
      for (let i = 0; i < n; i++) parts.push('"k' + i + '":1');
      return '{' + parts.join(',') + '}';
    }
  }
};

// ─── The stream ─────────────────────────────────────────────────────────────

export interface Config {
  /**
   * Names the stream, so a reported find's replay line reconstructs the exact
   * configuration as well as the exact seed. Without it the replay command is
   * only approximately right, which is worse than obviously wrong.
   */
  readonly name: string;
  /**
   * Cap on a generated payload's length. The bounded gate run keeps this small
   * so the suite stays a few seconds; the long run raises it past the §21
   * string bound so that bound is actually crossed.
   */
  readonly maxPayloadChars: number;
  /** One in this many inputs is a deliberately pathological (large) payload. */
  readonly heavyEveryN: number;
}

export const boundedConfig: Config = {
  name: 'bounded',
  maxPayloadChars: 48 * 1024,
  heavyEveryN: 120,
};

export const longConfig: Config = {
  name: 'long',
  maxPayloadChars: 2 * 1024 * 1024,
  heavyEveryN: 25,
};

/** One generated input plus the provenance a report needs to be actionable. */
export interface Generated {
  readonly payload: string;
  readonly origin: string;
}

/**
 * Deterministic in `(seed, iteration, cfg)` — the replay contract. Every branch
 * draws from the same `Rng`, so ADDING a family renumbers the stream; that is
 * why a reported find carries its payload too and replay is the backstop rather
 * than the primary record.
 */
export const generate = (
  rng: Rng,
  seeds: readonly string[],
  vocab: readonly string[],
  cfg: Config,
  iteration: number,
): Generated => {
  if (iteration % cfg.heavyEveryN === 0) {
    return { payload: genPathological(rng, cfg), origin: 'pathological' };
  }
  const branch = rng.next(10);
  if (branch <= 1) {
    const out: string[] = [];
    genValue(rng, rng.range(1, 6), out, { n: 0 }, vocab, cfg);
    return { payload: out.join(''), origin: 'structured-generation' };
  }
  if (branch === 2) {
    const n = rng.range(0, 200);
    let s = '';
    for (let i = 0; i < n; i++) s += rng.pick(HOSTILE_CHARS);
    return { payload: s, origin: 'raw-junk' };
  }
  if (branch === 3) {
    // Crossover: prefix of one seed, suffix of another. Produces half-valid
    // documents no single-seed mutation reaches.
    const a = rng.pick(seeds);
    const b = rng.pick(seeds);
    const i = a.length === 0 ? 0 : rng.next(a.length);
    const j = b.length === 0 ? 0 : rng.next(b.length);
    return { payload: a.slice(0, i) + b.slice(j), origin: 'crossover' };
  }
  const steps = rng.range(1, 4);
  let acc = rng.pick(seeds);
  const names: string[] = [];
  for (let k = 0; k < steps; k++) {
    const [name, next] = mutateOnce(rng, vocab, cfg, acc);
    acc = next;
    names.push(name);
  }
  return { payload: acc, origin: 'mutation:' + names.join('+') };
};
