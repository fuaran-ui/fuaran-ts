// ============================================================================
//  Core twin — exact decimal text and its arithmetic (Phase 2001).
//
//  A port of Fuaran.Core's `DecimalText` (the canonical form, the order, the
//  sum, the nearest-double reading) and of the reference evaluator's
//  `DecimalArith` (subtraction, product, remainder, negation, the ONE rounding
//  kernel behind `quotient` / `rounded`, and the float-to-decimal reading).
//
//  A decimal is carried as TEXT, never as a JS number: every value here is held
//  as `(negative, magnitude, scale)` — the number `±magnitude × 10^-scale` with
//  the magnitude a `bigint` — and every answer is rendered back through the
//  canonical form, so nothing here ever emits non-canonical text, nothing
//  overflows and nothing rounds except where a rounding mode says so. Pure: no
//  imports beyond the canonical float layout.
// ============================================================================

import { num } from './canonFloat.js';

/** One of the seven rounding modes, by its canonical wire spelling. */
export type DecimalRoundingMode =
  | 'half-even'
  | 'half-up'
  | 'half-down'
  | 'up'
  | 'down'
  | 'ceiling'
  | 'floor';

/** The largest scale a rounding may name — a resource bound, not a statement about decimals. */
export const MAX_DECIMAL_SCALE = 1000;

// ASCII digits only: `\d` would admit other scripts' digits under some flags, and the grammar is
// deliberately the one reading every host agrees on.
const GRAMMAR = /^-?[0-9]+(\.[0-9]+)?$/;

interface Parts {
  readonly negative: boolean;
  readonly magnitude: bigint;
  readonly scale: number;
}

/** `(negative, integer digits, fraction digits)` with the zeros stripped, or undefined. */
const split = (
  s: string,
): { readonly negative: boolean; readonly ip: string; readonly fp: string } | undefined => {
  if (typeof s !== 'string' || !GRAMMAR.test(s)) return undefined;
  const negative = s.startsWith('-');
  const body = negative ? s.slice(1) : s;
  const dot = body.indexOf('.');
  const ip = (dot < 0 ? body : body.slice(0, dot)).replace(/^0+/, '');
  const fp = dot < 0 ? '' : body.slice(dot + 1).replace(/0+$/, '');
  const isZero = ip.length === 0 && fp.length === 0;
  return { negative: negative && !isZero, ip, fp };
};

/**
 * The canonical form of `s`, or `undefined` where `s` is not decimal text: no
 * leading zero on the integer part (a lone `0` for none), no trailing fraction
 * zero, no point on a whole number, no sign on zero.
 */
export const decimalCanonical = (s: string): string | undefined => {
  const p = split(s);
  if (p === undefined) return undefined;
  return (
    (p.negative ? '-' : '') +
    (p.ip.length === 0 ? '0' : p.ip) +
    (p.fp.length === 0 ? '' : '.' + p.fp)
  );
};

/** True where `s` is decimal text already in canonical form. */
export const isCanonicalDecimal = (s: string): boolean => decimalCanonical(s) === s;

const parts = (s: string): Parts | undefined => {
  const p = split(s);
  if (p === undefined) return undefined;
  const digits = p.ip + p.fp;
  return {
    negative: p.negative,
    magnitude: digits.length === 0 ? 0n : BigInt(digits),
    scale: p.fp.length,
  };
};

/** The canonical text of `±magnitude × 10^-scale` (a negative scale appends zeros). */
const render = (negative: boolean, magnitude: bigint, scale: number): string => {
  const digits = magnitude.toString();
  let text: string;
  if (scale <= 0) {
    text = magnitude === 0n ? '0' : digits + '0'.repeat(-scale);
  } else {
    const padded = digits.padStart(scale + 1, '0');
    text = padded.slice(0, padded.length - scale) + '.' + padded.slice(padded.length - scale);
  }
  const signed = negative && magnitude !== 0n ? '-' + text : text;
  return decimalCanonical(signed) ?? signed;
};

const pow10 = (n: number): bigint => 10n ** BigInt(n);

/** Both magnitudes at their common scale. */
const aligned = (a: Parts, b: Parts): { scale: number; ma: bigint; mb: bigint } => {
  const scale = Math.max(a.scale, b.scale);
  return {
    scale,
    ma: a.magnitude * pow10(scale - a.scale),
    mb: b.magnitude * pow10(scale - b.scale),
  };
};

const signed = (p: Parts, m: bigint): bigint => (p.negative ? -m : m);

/**
 * The numeric order of two decimal texts as -1 / 0 / 1, or `undefined` where
 * either is not decimal text. Canonical or not: `1.50` and `1.5` are equal.
 */
export const decimalCompare = (a: string, b: string): number | undefined => {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === undefined || pb === undefined) return undefined;
  const { ma, mb } = aligned(pa, pb);
  const x = signed(pa, ma);
  const y = signed(pb, mb);
  return x < y ? -1 : x > y ? 1 : 0;
};

/** The exact sum, canonical, or `undefined` where either operand is not decimal text. */
export const decimalAdd = (a: string, b: string): string | undefined => {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === undefined || pb === undefined) return undefined;
  const { scale, ma, mb } = aligned(pa, pb);
  const total = signed(pa, ma) + signed(pb, mb);
  return render(total < 0n, total < 0n ? -total : total, scale);
};

/** The exact difference `a - b`. */
export const decimalSub = (a: string, b: string): string | undefined => {
  const nb = decimalNegate(b);
  return nb === undefined ? undefined : decimalAdd(a, nb);
};

/** The exact product. */
export const decimalMul = (a: string, b: string): string | undefined => {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === undefined || pb === undefined) return undefined;
  return render(pa.negative !== pb.negative, pa.magnitude * pb.magnitude, pa.scale + pb.scale);
};

/** The negation. */
export const decimalNegate = (a: string): string | undefined => {
  const p = parts(a);
  return p === undefined ? undefined : render(!p.negative, p.magnitude, p.scale);
};

/** The absolute value. */
export const decimalAbs = (a: string): string | undefined => {
  const p = parts(a);
  return p === undefined ? undefined : render(false, p.magnitude, p.scale);
};

/** True where `a` is decimal text denoting zero. */
export const decimalIsZero = (a: string): boolean => parts(a)?.magnitude === 0n;

/**
 * The remainder of a TRUNCATING division, carrying the dividend's sign — the
 * integer `mod`'s convention. `undefined` for a zero divisor (the evaluator
 * answers null there) or text that is not decimal.
 */
export const decimalRem = (a: string, b: string): string | undefined => {
  const pa = parts(a);
  const pb = parts(b);
  if (pa === undefined || pb === undefined || pb.magnitude === 0n) return undefined;
  const { scale, ma, mb } = aligned(pa, pb);
  return render(pa.negative, ma % mb, scale);
};

/**
 * `numerator / denominator` (magnitudes, the denominator non-zero) rounded to
 * an integer under `mode`, where `negative` is the sign of the exact quotient:
 * the truncated quotient, then the remainder decides — twice the remainder
 * against the divisor for the three half-way modes, its being non-zero for the
 * four directed ones. ONE rounding, of the exact value.
 */
const roundQuotient = (
  mode: DecimalRoundingMode,
  negative: boolean,
  numerator: bigint,
  denominator: bigint,
): bigint => {
  const q = numerator / denominator;
  const r = numerator % denominator;
  if (r === 0n) return q;
  const twice = r * 2n;
  const half = twice > denominator ? 1 : twice < denominator ? -1 : 0;
  const bump = q + 1n;
  switch (mode) {
    case 'down':
      return q;
    case 'up':
      return bump;
    case 'ceiling':
      return negative ? q : bump;
    case 'floor':
      return negative ? bump : q;
    case 'half-up':
      return half >= 0 ? bump : q;
    case 'half-down':
      return half > 0 ? bump : q;
    case 'half-even':
      if (half > 0) return bump;
      if (half < 0) return q;
      return q % 2n === 0n ? q : bump;
  }
};

const inScale = (scale: number): boolean =>
  Number.isInteger(scale) && scale >= 0 && scale <= MAX_DECIMAL_SCALE;

/**
 * `decimal` brought to `scale` places under `mode` — the value itself where it
 * already has no more places. `undefined` for text that is not decimal or a
 * scale outside `0 .. MAX_DECIMAL_SCALE`.
 */
export const decimalQuantize = (
  mode: DecimalRoundingMode,
  scale: number,
  decimal: string,
): string | undefined => {
  const p = parts(decimal);
  if (p === undefined || !inScale(scale)) return undefined;
  if (p.scale <= scale) return render(p.negative, p.magnitude, p.scale);
  return render(
    p.negative,
    roundQuotient(mode, p.negative, p.magnitude, pow10(p.scale - scale)),
    scale,
  );
};

/**
 * `dividend / divisor` correctly rounded to `scale` places under `mode`.
 * `null` for a zero divisor; `undefined` where an operand is not decimal text
 * or the scale is outside `0 .. MAX_DECIMAL_SCALE`.
 */
export const decimalDivide = (
  mode: DecimalRoundingMode,
  scale: number,
  dividend: string,
  divisor: string,
): string | null | undefined => {
  const pa = parts(dividend);
  const pb = parts(divisor);
  if (pa === undefined || pb === undefined || !inScale(scale)) return undefined;
  if (pb.magnitude === 0n) return null;
  // dividend / divisor = (da / db) * 10^(sb - sa); scaled by 10^scale, the integer to round is
  // da * 10^e / db with e = sb - sa + scale.
  const e = pb.scale - pa.scale + scale;
  const numerator = e >= 0 ? pa.magnitude * pow10(e) : pa.magnitude;
  const denominator = e >= 0 ? pb.magnitude : pb.magnitude * pow10(-e);
  const negative = pa.negative !== pb.negative && pa.magnitude !== 0n;
  return render(negative, roundQuotient(mode, negative, numerator, denominator), scale);
};

/**
 * The nearest double to a decimal text, or `undefined` where it is not decimal
 * text OR its magnitude is past the float range (an infinity is the nearest
 * float to no decimal). JS `Number` over decimal text is correctly rounded.
 */
export const decimalToFloat = (s: string): number | undefined => {
  const c = decimalCanonical(s);
  if (c === undefined) return undefined;
  const f = Number(c);
  return Number.isFinite(f) ? f : undefined;
};

/**
 * The decimal text of a FINITE float — its shortest round-trip digits in the
 * canonical float layout, laid out without an exponent. `undefined` for NaN
 * and the infinities. The one place an approximation enters a decimal.
 */
export const decimalOfFloat = (f: number): string | undefined => {
  if (!Number.isFinite(f)) return undefined;
  const text = num(f);
  const e = text.search(/[eE]/);
  if (e < 0) return decimalCanonical(text);
  const mantissa = parts(text.slice(0, e));
  if (mantissa === undefined) return undefined;
  const exponent = parseInt(text.slice(e + 1), 10);
  const scale = mantissa.scale - exponent;
  return scale >= 0
    ? render(mantissa.negative, mantissa.magnitude, scale)
    : render(mantissa.negative, mantissa.magnitude * pow10(-scale), 0);
};

/** The integer part of a decimal (truncated toward zero), or `undefined` for non-decimal text. */
export const decimalTruncate = (a: string): bigint | undefined => {
  const p = parts(a);
  if (p === undefined) return undefined;
  const t = p.magnitude / pow10(p.scale);
  return p.negative ? -t : t;
};
