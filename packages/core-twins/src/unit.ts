// ============================================================================
//  Core twin — the unit algebra's text: parse and canonical render (Phase 2207).
//
//  A port of `Fuaran.Core.Unit` (fuaran-core#426) as far as a host needs it to
//  carry a column's unit on the wire: `parseUnit` reads UCUM's case-sensitive
//  syntax over the subset Core admits, `renderUnit` writes the unit's ONE
//  canonical text, and two units are equal exactly when they render alike.
//  Since Phase 2208 the algebra too: the product, quotient and integer power of
//  units, dimensions and the exact conversion factor, which the dataframe
//  evaluator's unit check reads (fuaran-core#429).
//
//  The vocabulary is the reference's, complete: every admitted atom with its
//  metric flag (whether an SI prefix applies), the alias, the twenty prefixes in
//  the reference's TRY ORDER (`da` first, so `dam` reads as decametre), the
//  non-ratio and arbitrary sets, and the currency shape. So the refusal a token
//  meets here is the class the reference names for it (WIRE_FORMAT §3.6.26).
//
//  Canonical form: factors ordered by (symbol, prefix) ordinally, equal factors
//  merged by summing exponents, zero exponents dropped. Exponents are 32-bit
//  (±2147483647; outside is Malformed). No exponent follows `)`. `1` is the only
//  numeric factor. A leading `/` is allowed at the start of a term. Letters are
//  ASCII only, and no white space is read.
// ============================================================================

import type { Result } from '@fuaran-ui/schema';

import { err, ok } from './result.js';

/** One factor of a unit: an atom under an optional SI prefix, with a non-zero exponent. */
export interface UnitFactor {
  readonly symbol: string;
  readonly prefix: string;
  readonly exp: number;
}

/** A unit in canonical form: its factors ordered by symbol then prefix, ordinally. */
export interface UnitOfMeasure {
  readonly factors: readonly UnitFactor[];
}

/** Why a text is not a unit — the reference's `UnitRefusal`, a position the token's first index. */
export type UnitRefusal =
  | { readonly kind: 'Empty' }
  | {
      readonly kind: 'Malformed';
      readonly found: string;
      readonly position: number;
      readonly expected: string;
    }
  | {
      readonly kind:
        | 'UnknownAtom'
        | 'Annotation'
        | 'ArbitraryUnit'
        | 'NonRatioUnit'
        | 'PrefixNotAllowed'
        | 'NumericFactor';
      readonly token: string;
      readonly position: number;
    };

// ─── the vocabulary ──────────────────────────────────────────────────────────

/**
 * An admitted atom: whether SI prefixes apply, its scale relative to the coherent base (metre,
 * GRAM, second, ampere, kelvin, mole, candela) as `num/den`, and its exponents over
 * `[length, mass, time, current, temperature, amount, luminous intensity]` — the reference's
 * `AtomDef`.
 */
interface AtomDef {
  readonly metric: boolean;
  readonly num: bigint;
  readonly den: bigint;
  readonly dims: readonly number[];
}

const def = (metric: boolean, num: bigint, den: bigint, dims: readonly number[]): AtomDef => ({
  metric,
  num,
  den,
  dims,
});

/** Every admitted atom by its canonical symbol. */
const ATOMS: ReadonlyMap<string, AtomDef> = new Map([
  // The seven SI base dimensions; mass at the gram, UCUM's base.
  ['m', def(true, 1n, 1n, [1, 0, 0, 0, 0, 0, 0])],
  ['g', def(true, 1n, 1n, [0, 1, 0, 0, 0, 0, 0])],
  ['s', def(true, 1n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['A', def(true, 1n, 1n, [0, 0, 0, 1, 0, 0, 0])],
  ['K', def(true, 1n, 1n, [0, 0, 0, 0, 1, 0, 0])],
  ['mol', def(true, 1n, 1n, [0, 0, 0, 0, 0, 1, 0])],
  ['cd', def(true, 1n, 1n, [0, 0, 0, 0, 0, 0, 1])],
  // The SI coherent derived units (degree Celsius excepted: it is affine).
  ['rad', def(true, 1n, 1n, [0, 0, 0, 0, 0, 0, 0])],
  ['sr', def(true, 1n, 1n, [0, 0, 0, 0, 0, 0, 0])],
  ['Hz', def(true, 1n, 1n, [0, 0, -1, 0, 0, 0, 0])],
  ['N', def(true, 1000n, 1n, [1, 1, -2, 0, 0, 0, 0])],
  ['Pa', def(true, 1000n, 1n, [-1, 1, -2, 0, 0, 0, 0])],
  ['J', def(true, 1000n, 1n, [2, 1, -2, 0, 0, 0, 0])],
  ['W', def(true, 1000n, 1n, [2, 1, -3, 0, 0, 0, 0])],
  ['C', def(true, 1n, 1n, [0, 0, 1, 1, 0, 0, 0])],
  ['V', def(true, 1000n, 1n, [2, 1, -3, -1, 0, 0, 0])],
  ['F', def(true, 1n, 1000n, [-2, -1, 4, 2, 0, 0, 0])],
  ['Ohm', def(true, 1000n, 1n, [2, 1, -3, -2, 0, 0, 0])],
  ['S', def(true, 1n, 1000n, [-2, -1, 3, 2, 0, 0, 0])],
  ['Wb', def(true, 1000n, 1n, [2, 1, -2, -1, 0, 0, 0])],
  ['T', def(true, 1000n, 1n, [0, 1, -2, -1, 0, 0, 0])],
  ['H', def(true, 1000n, 1n, [2, 1, -2, -2, 0, 0, 0])],
  ['lm', def(true, 1n, 1n, [0, 0, 0, 0, 0, 0, 1])],
  ['lx', def(true, 1n, 1n, [-2, 0, 0, 0, 0, 0, 1])],
  ['Bq', def(true, 1n, 1n, [0, 0, -1, 0, 0, 0, 0])],
  ['Gy', def(true, 1n, 1n, [2, 0, -2, 0, 0, 0, 0])],
  ['Sv', def(true, 1n, 1n, [2, 0, -2, 0, 0, 0, 0])],
  ['kat', def(true, 1n, 1n, [0, 0, -1, 0, 0, 1, 0])],
  // Metric non-SI units.
  ['L', def(true, 1n, 1000n, [3, 0, 0, 0, 0, 0, 0])],
  ['t', def(true, 1000000n, 1n, [0, 1, 0, 0, 0, 0, 0])],
  ['bar', def(true, 100000000n, 1n, [-1, 1, -2, 0, 0, 0, 0])],
  // Non-metric units: time, ratios, and the international customary set.
  ['min', def(false, 60n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['h', def(false, 3600n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['d', def(false, 86400n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['wk', def(false, 604800n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['a', def(false, 31557600n, 1n, [0, 0, 1, 0, 0, 0, 0])],
  ['%', def(false, 1n, 100n, [0, 0, 0, 0, 0, 0, 0])],
  ['[ppm]', def(false, 1n, 1000000n, [0, 0, 0, 0, 0, 0, 0])],
  ['[ppb]', def(false, 1n, 1000000000n, [0, 0, 0, 0, 0, 0, 0])],
  ['[in_i]', def(false, 127n, 5000n, [1, 0, 0, 0, 0, 0, 0])],
  ['[ft_i]', def(false, 381n, 1250n, [1, 0, 0, 0, 0, 0, 0])],
  ['[yd_i]', def(false, 1143n, 1250n, [1, 0, 0, 0, 0, 0, 0])],
  ['[mi_i]', def(false, 201168n, 125n, [1, 0, 0, 0, 0, 0, 0])],
  ['[lb_av]', def(false, 45359237n, 100000n, [0, 1, 0, 0, 0, 0, 0])],
  ['[oz_av]', def(false, 45359237n, 1600000n, [0, 1, 0, 0, 0, 0, 0])],
]);

/** Spellings read as another atom: UCUM's lower-case litre. Rendered as the canonical symbol. */
const ALIASES: ReadonlyMap<string, string> = new Map([['l', 'L']]);

/**
 * UCUM's twenty prefixes and their powers of ten, in the reference's TRY ORDER: `da` first, so `dam`
 * is decametre.
 */
const PREFIX_POWERS: ReadonlyMap<string, number> = new Map([
  ['da', 1],
  ['Y', 24],
  ['Z', 21],
  ['E', 18],
  ['P', 15],
  ['T', 12],
  ['G', 9],
  ['M', 6],
  ['k', 3],
  ['h', 2],
  ['d', -1],
  ['c', -2],
  ['m', -3],
  ['u', -6],
  ['n', -9],
  ['p', -12],
  ['f', -15],
  ['a', -18],
  ['z', -21],
  ['y', -24],
]);

/** The prefixes in try order. */
const PREFIXES: readonly string[] = [...PREFIX_POWERS.keys()];

/** UCUM special units whose conversion is not a ratio: affine temperatures and logarithms. */
const NON_RATIO: ReadonlySet<string> = new Set([
  'Cel',
  '[degF]',
  '[degRe]',
  '[pH]',
  'Np',
  'B',
  'B[SPL]',
  'B[V]',
  'B[mV]',
  'B[uV]',
  'B[10.nV]',
  'B[W]',
  'B[kW]',
  'bit_s',
  "[p'diop]",
  '%[slope]',
  '[hp_X]',
  '[hp_C]',
  '[hp_M]',
  '[hp_Q]',
  '[kp_X]',
  '[kp_C]',
  '[kp_M]',
  '[kp_Q]',
]);

/** UCUM's arbitrary units. Several have a currency's shape (`[CFU]`), so this set is read first. */
const ARBITRARY: ReadonlySet<string> = new Set([
  '[iU]',
  '[IU]',
  "[arb'U]",
  "[USP'U]",
  "[GPL'U]",
  "[MPL'U]",
  "[APL'U]",
  "[beth'U]",
  "[anti'Xa'U]",
  "[todd'U]",
  "[dye'U]",
  "[smgy'U]",
  "[bdsk'U]",
  "[ka'U]",
  "[knk'U]",
  "[mclg'U]",
  "[tb'U]",
  '[CCID_50]',
  '[TCID_50]',
  '[EID_50]',
  '[PFU]',
  '[FFU]',
  '[CFU]',
  '[IR]',
  '[BAU]',
  '[AU]',
  "[Amb'a'1'U]",
  '[PNU]',
  '[Lf]',
  "[D'ag'U]",
  '[FEU]',
  '[ELU]',
  '[EU]',
]);

const isCapital = (c: string): boolean => c >= 'A' && c <= 'Z';

/** An ISO 4217 code in brackets — `[` three ASCII capitals `]` — that is not an arbitrary unit. */
const isCurrency = (tok: string): boolean =>
  tok.length === 5 &&
  tok[0] === '[' &&
  tok[4] === ']' &&
  isCapital(tok[1]!) &&
  isCapital(tok[2]!) &&
  isCapital(tok[3]!) &&
  !ARBITRARY.has(tok);

/** The canonical symbol of an admitted atom, through the aliases. */
const tryAtom = (tok: string): string | undefined => {
  const canonical = ALIASES.get(tok) ?? tok;
  return ATOMS.has(canonical) ? canonical : undefined;
};

// ─── the canonical form ──────────────────────────────────────────────────────

const MAX_EXP = 2147483647;

const compareFactors = (a: UnitFactor, b: UnitFactor): number =>
  a.symbol < b.symbol
    ? -1
    : a.symbol > b.symbol
      ? 1
      : a.prefix < b.prefix
        ? -1
        : a.prefix > b.prefix
          ? 1
          : 0;

/**
 * `a` times `b` raised to `sign` — equal factors merged, zero exponents dropped, the result in
 * canonical order — or `undefined` where an exponent leaves ±2147483647.
 */
const tryCombine = (
  a: readonly UnitFactor[],
  sign: number,
  b: readonly UnitFactor[],
): UnitFactor[] | undefined => {
  const merged = new Map<string, UnitFactor>();
  // U+0000 is in no symbol or prefix, so the key separates the pair unambiguously.
  const key = (f: UnitFactor): string => f.symbol + '\u0000' + f.prefix;
  for (const f of a) merged.set(key(f), f);
  for (const f of b) {
    const sum = (merged.get(key(f))?.exp ?? 0) + sign * f.exp;
    if (sum > MAX_EXP || sum < -MAX_EXP) return undefined;
    merged.set(key(f), { symbol: f.symbol, prefix: f.prefix, exp: sum });
  }
  return [...merged.values()].filter((f) => f.exp !== 0).sort(compareFactors);
};

/**
 * The unit's one canonical text: the positive-exponent factors joined by `.`, then each
 * negative-exponent factor as `/` and the factor; an exponent written as its magnitude and omitted
 * where it is 1; `1` for the dimensionless unit. `km/h`, `kg.m/s2`, `/min`, `c[GBP]`.
 */
export const renderUnit = (u: UnitOfMeasure): string => {
  const text = (f: UnitFactor): string => {
    const e = Math.abs(f.exp);
    return f.prefix + f.symbol + (e === 1 ? '' : String(e));
  };
  const num = u.factors.filter((f) => f.exp > 0).map(text);
  const den = u.factors.filter((f) => f.exp < 0).map(text);
  return num.length === 0 && den.length === 0
    ? '1'
    : num.join('.') + den.map((t) => '/' + t).join('');
};

// ─── the parse ───────────────────────────────────────────────────────────────

const isLetter = (c: string): boolean => (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z');
const isDigit = (c: string): boolean => c >= '0' && c <= '9';

/** Resolve one symbol token to an atom, or to the refusal naming its class. */
const resolve = (tok: string, position: number): Result<UnitFactor, UnitRefusal> => {
  const sym = tryAtom(tok);
  if (sym !== undefined) return ok({ symbol: sym, prefix: '', exp: 1 });
  if (NON_RATIO.has(tok)) return err({ kind: 'NonRatioUnit', token: tok, position });
  if (ARBITRARY.has(tok)) return err({ kind: 'ArbitraryUnit', token: tok, position });
  if (isCurrency(tok)) return ok({ symbol: tok, prefix: '', exp: 1 });
  for (const p of PREFIXES) {
    if (!(tok.length > p.length && tok.startsWith(p))) continue;
    const rest = tok.substring(p.length);
    const atom = tryAtom(rest);
    if (atom !== undefined)
      return ATOMS.get(atom)!.metric
        ? ok({ symbol: atom, prefix: p, exp: 1 })
        : err({ kind: 'PrefixNotAllowed', token: tok, position });
    if (NON_RATIO.has(rest)) return err({ kind: 'NonRatioUnit', token: tok, position });
    if (ARBITRARY.has(rest)) return err({ kind: 'ArbitraryUnit', token: tok, position });
    if (isCurrency(rest)) return ok({ symbol: rest, prefix: p, exp: 1 });
  }
  return err({ kind: 'UnknownAtom', token: tok, position });
};

/** One open term: its product so far, the sign of the next component, the sign it takes outside. */
interface Frame {
  acc: UnitFactor[];
  next: number;
  readonly outer: number;
  readonly opened: number;
}

const EXP_RANGE = 'an exponent within ±2147483647';

const malformed = (found: string, position: number, expected: string): Result<never, UnitRefusal> =>
  err({ kind: 'Malformed', found, position, expected });

/**
 * Read a unit from its text: atoms under an optional prefix, each with an optional signed integer
 * exponent; products `.`, quotients `/` (left-associative, with an optional leading `/`),
 * parentheses, and the factor `1`. An iterative parse over an explicit stack of open terms — the
 * reference's — so nesting depth never reaches the machine stack.
 */
export const parseUnit = (text: string): Result<UnitOfMeasure, UnitRefusal> => {
  if (text.length === 0) return err({ kind: 'Empty' });
  const n = text.length;
  const charAt = (i: number): string => (i < n ? text[i]! : '');
  const stack: Frame[] = [{ acc: [], next: 1, outer: 1, opened: 0 }];
  const top = (): Frame => stack[stack.length - 1]!;
  let pos = 0;
  let expectComponent = true;
  let termStart = true;

  for (;;) {
    if (expectComponent) {
      if (pos >= n) return malformed('', pos, 'a unit');
      const c = text[pos]!;
      if (termStart && c === '/') {
        top().next = -1;
        pos += 1;
        termStart = false;
      } else if (c === '(') {
        stack.push({ acc: [], next: 1, outer: top().next, opened: pos });
        pos += 1;
        termStart = true;
      } else if (isDigit(c)) {
        const start = pos;
        while (pos < n && isDigit(text[pos]!)) pos += 1;
        if (pos < n && (text[pos] === '*' || text[pos] === '^')) {
          pos += 1;
          if (pos < n && (text[pos] === '+' || text[pos] === '-')) pos += 1;
          while (pos < n && isDigit(text[pos]!)) pos += 1;
        }
        const tok = text.substring(start, pos);
        if (tok !== '1') return err({ kind: 'NumericFactor', token: tok, position: start });
        expectComponent = false;
        termStart = false;
      } else if (c === '{') {
        const close = text.indexOf('}', pos);
        return close < 0
          ? malformed(text.substring(pos), pos, "'}' closing the annotation")
          : err({ kind: 'Annotation', token: text.substring(pos, close + 1), position: pos });
      } else if (isLetter(c) || c === '[' || c === '%') {
        const start = pos;
        while (pos < n) {
          const d = text[pos]!;
          if (!(isLetter(d) || d === '_' || d === "'" || d === '%' || d === '[')) break;
          if (d === '[') {
            const close = text.indexOf(']', pos);
            if (close < 0) return malformed(text.substring(pos), pos, "']' closing the symbol");
            pos = close + 1;
          } else pos += 1;
        }
        const atom = resolve(text.substring(start, pos), start);
        if (!atom.ok) return atom;
        const expStart = pos;
        let sign = 1;
        if (pos < n && (text[pos] === '+' || text[pos] === '-')) {
          if (text[pos] === '-') sign = -1;
          pos += 1;
        }
        const digitsStart = pos;
        let value = 0;
        let over = false;
        while (pos < n && isDigit(text[pos]!)) {
          if (!over) {
            value = value * 10 + (text.charCodeAt(pos) - 48);
            if (value > MAX_EXP) over = true;
          }
          pos += 1;
        }
        if (pos === digitsStart && pos > expStart)
          return malformed(charAt(pos), pos, 'the digits of an exponent');
        if (over) return malformed(text.substring(expStart, pos), expStart, EXP_RANGE);
        const e = pos === expStart ? 1 : sign * value;
        const comp = e === 0 ? [] : [{ ...atom.value, exp: e }];
        // Fold the component into the innermost open term.
        const frame = top();
        const acc = tryCombine(frame.acc, frame.next, comp);
        if (acc === undefined) return malformed(text.substring(start, pos), start, EXP_RANGE);
        frame.acc = acc;
        expectComponent = false;
        termStart = false;
      } else return malformed(c, pos, 'a unit');
    } else if (pos >= n) {
      return stack.length === 1
        ? ok({ factors: top().acc })
        : malformed('', pos, `')' closing the '(' at ${top().opened}`);
    } else {
      const c = text[pos]!;
      if (c === '.' || c === '/') {
        top().next = c === '.' ? 1 : -1;
        pos += 1;
        expectComponent = true;
      } else if (c === ')') {
        if (stack.length < 2) return malformed(')', pos, "'.', '/' or the end");
        const at = pos;
        pos += 1;
        const inner = stack.pop()!;
        // The closed term is one component of the term that encloses it.
        const outer = top();
        const acc = tryCombine(outer.acc, inner.outer, inner.acc);
        if (acc === undefined) return malformed(')', at, EXP_RANGE);
        outer.acc = acc;
      } else if (c === '{') {
        const close = text.indexOf('}', pos);
        return close < 0
          ? malformed(text.substring(pos), pos, "'}' closing the annotation")
          : err({ kind: 'Annotation', token: text.substring(pos, close + 1), position: pos });
      } else return malformed(c, pos, stack.length > 1 ? "'.', '/' or ')'" : "'.', '/' or the end");
    }
  }
};

/** The sentence a refusal is reported in — the reference codec's `unitRefusalText`. */
export const unitRefusalText = (r: UnitRefusal): string => {
  const at = (what: string, token: string, position: number): string =>
    `${what} '${token}' at position ${position}`;
  switch (r.kind) {
    case 'Empty':
      return 'the text is empty';
    case 'Malformed':
      return `expected ${r.expected} at position ${r.position}, found '${r.found}'`;
    case 'UnknownAtom':
      return at('unknown unit symbol', r.token, r.position);
    case 'Annotation':
      return at('annotation', r.token, r.position);
    case 'ArbitraryUnit':
      return at('arbitrary unit', r.token, r.position);
    case 'NonRatioUnit':
      return at('non-ratio unit', r.token, r.position);
    case 'PrefixNotAllowed':
      return at('prefix not allowed on', r.token, r.position);
    case 'NumericFactor':
      return at('numeric factor', r.token, r.position);
  }
};

/** A unit text's canonical spelling (`s-1.m` is `m/s`), or the refusal of a text that is no unit. */
export const canonicalUnit = (text: string): Result<string, UnitRefusal> => {
  const u = parseUnit(text);
  return u.ok ? ok(renderUnit(u.value)) : u;
};

// ─── the algebra (Phase 2208) ────────────────────────────────────────────────
//
// What the dataframe evaluator's unit check reads (the reference's `Unit.mul` / `div` / `pow` /
// `compatible` / `conversionFactor`, fuaran-core#426): the product, the quotient and an integer
// power of units, whether two units measure one dimension, and the EXACT factor between two that
// do. Where the reference raises because an exponent would leave ±2147483647, these answer
// `undefined` and the caller names the refusal: a twin never throws.

/** The dimensionless unit, `1`: the identity of `mulUnit`. */
export const DIMENSIONLESS: UnitOfMeasure = { factors: [] };

/** Two units are one unit when they render to one canonical text (identity is the product). */
export const sameUnit = (a: UnitOfMeasure, b: UnitOfMeasure): boolean =>
  renderUnit(a) === renderUnit(b);

/** The product of two units, or `undefined` where an exponent would leave ±2147483647. */
export const mulUnit = (a: UnitOfMeasure, b: UnitOfMeasure): UnitOfMeasure | undefined => {
  const f = tryCombine(a.factors, 1, b.factors);
  return f === undefined ? undefined : { factors: f };
};

/** The quotient `a / b`, or `undefined` where an exponent would leave ±2147483647. */
export const divUnit = (a: UnitOfMeasure, b: UnitOfMeasure): UnitOfMeasure | undefined => {
  const f = tryCombine(a.factors, -1, b.factors);
  return f === undefined ? undefined : { factors: f };
};

/** `u` to the integer power `n` (`1` at `n = 0`), or `undefined` where an exponent leaves the range. */
export const powUnit = (u: UnitOfMeasure, n: number): UnitOfMeasure | undefined => {
  if (n === 0) return DIMENSIONLESS;
  const factors: UnitFactor[] = [];
  for (const f of u.factors) {
    const e = f.exp * n;
    if (e > MAX_EXP || e < -MAX_EXP) return undefined;
    factors.push({ symbol: f.symbol, prefix: f.prefix, exp: e });
  }
  return { factors };
};

/** The dimension a unit measures: non-zero exponents by base dimension, and one per currency. */
const dimension = (u: UnitOfMeasure): Map<string, number> => {
  const m = new Map<string, number>();
  const add = (k: string, x: number): void => {
    m.set(k, (m.get(k) ?? 0) + x);
  };
  for (const f of u.factors) {
    if (isCurrency(f.symbol)) add('[' + f.symbol, f.exp);
    else ATOMS.get(f.symbol)!.dims.forEach((x, i) => add(String(i), x * f.exp));
  }
  for (const [k, x] of [...m]) if (x === 0) m.delete(k);
  return m;
};

/**
 * Whether two units measure one dimension, so a value in one has a value in the other. Every
 * currency is a dimension of its own.
 */
export const compatibleUnits = (a: UnitOfMeasure, b: UnitOfMeasure): boolean => {
  const da = dimension(a);
  const db = dimension(b);
  if (da.size !== db.size) return false;
  for (const [k, x] of da) if (db.get(k) !== x) return false;
  return true;
};

/** An exact ratio in lowest terms, its denominator positive. */
export interface UnitRatio {
  readonly num: bigint;
  readonly den: bigint;
}

const gcd = (a: bigint, b: bigint): bigint => {
  let x = a;
  let y = b;
  while (y !== 0n) [x, y] = [y, x % y];
  return x;
};

/** The scale of a unit relative to the coherent base, in lowest terms (the reference's `scale`). */
const scale = (u: UnitOfMeasure): UnitRatio => {
  let num = 1n;
  let den = 1n;
  let ten = 0;
  for (const f of u.factors) {
    ten += prefixPower(f.prefix) * f.exp;
    if (!isCurrency(f.symbol)) {
      const a = ATOMS.get(f.symbol)!;
      const k = BigInt(Math.abs(f.exp));
      if (f.exp > 0) {
        num *= a.num ** k;
        den *= a.den ** k;
      } else {
        num *= a.den ** k;
        den *= a.num ** k;
      }
    }
  }
  if (ten > 0) num *= 10n ** BigInt(ten);
  else if (ten < 0) den *= 10n ** BigInt(-ten);
  const g = gcd(num, den);
  return { num: num / g, den: den / g };
};

/** The power of ten a prefix stands for (`''` is none). */
const prefixPower = (p: string): number => (p === '' ? 0 : PREFIX_POWERS.get(p)!);

/**
 * The exact factor that turns a value in `source` into the same quantity in `target`
 * (`km/h` → `m/s` is `5/18`), or `undefined` where the two are not compatible.
 */
export const conversionFactor = (
  source: UnitOfMeasure,
  target: UnitOfMeasure,
): UnitRatio | undefined => {
  if (!compatibleUnits(source, target)) return undefined;
  const q = divUnit(source, target);
  return q === undefined ? undefined : scale(q);
};

/** A ratio as the reference reads it into a float literal: each side to a double, then divided. */
export const ratioToFloat = (r: UnitRatio): number => Number(r.num) / Number(r.den);
