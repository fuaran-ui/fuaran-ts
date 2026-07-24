// ============================================================================
//  Parse-don't-validate bounded scalars (port of Fuaran.UI/Bounded.fs, Phase 53).
//
//  Each bounded type is a *branded* primitive whose only construction path is
//  the validating factory below. A value that exists is in-range by
//  construction, so every downstream consumer can rely on the invariant
//  without re-checking it — the "parse, don't validate" discipline applied to
//  the value dimension.
//
//  The F# kit returns `Result<_, string>` from `tryCreate`; the TS kit instead
//  THROWS a `BoundedConstructionError` on invalid input (Phase 75 task spec).
//  Throwing keeps the happy-path call site free of unwrapping — the constructor
//  is the boundary, and a value of the branded type is proof the bound held.
//  Callers who want a non-throwing path wrap the call in try/catch (or use the
//  `try*` variants, which return `Result`).
// ============================================================================

import type { Result } from './result.js';
import { err, ok } from './result.js';

/** Thrown by a bounded constructor when its input falls outside the bound. */
export class BoundedConstructionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BoundedConstructionError';
  }
}

// ─── NonEmptyString ──────────────────────────────────────────────────────────

/** A string guaranteed to contain at least one non-whitespace character. */
export type NonEmptyString = string & { readonly __brand: 'NonEmptyString' };

/** Parse a string into a `NonEmptyString`. Throws on empty / whitespace-only input. */
export function nonEmptyString(value: string): NonEmptyString {
  if (value.trim() === '') {
    throw new BoundedConstructionError('value must be a non-empty string');
  }
  return value as NonEmptyString;
}

/** Non-throwing `nonEmptyString`. */
export function tryNonEmptyString(value: string): Result<NonEmptyString, string> {
  return value.trim() === ''
    ? err('value must be a non-empty string')
    : ok(value as NonEmptyString);
}

// ─── BoundedString ─────────────────────────────────────────────────────────

/** A string whose length lies within `[minLen, maxLen]` inclusive. */
export type BoundedString = string & { readonly __brand: 'BoundedString' };

/** Parse a string into a `BoundedString`. Throws on an invalid bound or out-of-bound length. */
export function boundedString(minLen: number, maxLen: number, value: string): BoundedString {
  if (minLen > maxLen) {
    throw new BoundedConstructionError(`invalid bound: minLen ${minLen} exceeds maxLen ${maxLen}`);
  }
  if (value.length < minLen || value.length > maxLen) {
    throw new BoundedConstructionError(
      `string length ${value.length} is outside [${minLen}, ${maxLen}]`,
    );
  }
  return value as BoundedString;
}

/** Non-throwing `boundedString`. */
export function tryBoundedString(
  minLen: number,
  maxLen: number,
  value: string,
): Result<BoundedString, string> {
  if (minLen > maxLen) {
    return err(`invalid bound: minLen ${minLen} exceeds maxLen ${maxLen}`);
  }
  if (value.length < minLen || value.length > maxLen) {
    return err(`string length ${value.length} is outside [${minLen}, ${maxLen}]`);
  }
  return ok(value as BoundedString);
}

// ─── BoundedInt ────────────────────────────────────────────────────────────

/**
 * An integer guaranteed to lie within `[Min, Max]` inclusive. The bound is
 * carried in the brand's phantom `__min` / `__max` literals so two differently
 * bounded ints are distinct types.
 */
export type BoundedInt<Min extends number, Max extends number> = number & {
  readonly __brand: 'BoundedInt';
  readonly __min: Min;
  readonly __max: Max;
};

/** Parse an integer into a `BoundedInt<min, max>`. Throws on an invalid bound or out-of-range value. */
export function boundedInt<Min extends number, Max extends number>(
  min: Min,
  max: Max,
  value: number,
): BoundedInt<Min, Max> {
  if (min > max) {
    throw new BoundedConstructionError(`invalid bound: min ${min} exceeds max ${max}`);
  }
  if (value < min || value > max) {
    throw new BoundedConstructionError(`value ${value} is outside [${min}, ${max}]`);
  }
  return value as BoundedInt<Min, Max>;
}

/** Non-throwing `boundedInt`. */
export function tryBoundedInt<Min extends number, Max extends number>(
  min: Min,
  max: Max,
  value: number,
): Result<BoundedInt<Min, Max>, string> {
  if (min > max) {
    return err(`invalid bound: min ${min} exceeds max ${max}`);
  }
  if (value < min || value > max) {
    return err(`value ${value} is outside [${min}, ${max}]`);
  }
  return ok(value as BoundedInt<Min, Max>);
}

// ─── Fraction ────────────────────────────────────────────────────────────────

/**
 * A real number guaranteed to lie within `[0, 1]` inclusive — the canonical
 * progress / ratio fraction. Mirrors `ProgressSpec.fraction`'s documented domain.
 */
export type Fraction = number & { readonly __brand: 'Fraction' };

/** Parse a float into a `Fraction`. Throws on NaN, infinity, or any value outside `[0, 1]`. */
export function fraction(value: number): Fraction {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    throw new BoundedConstructionError('fraction must be a finite number');
  }
  if (value < 0 || value > 1) {
    throw new BoundedConstructionError(`fraction ${value} is outside [0, 1]`);
  }
  return value as Fraction;
}

/** Non-throwing `fraction`. */
export function tryFraction(value: number): Result<Fraction, string> {
  if (Number.isNaN(value) || !Number.isFinite(value)) {
    return err('fraction must be a finite number');
  }
  if (value < 0 || value > 1) {
    return err(`fraction ${value} is outside [0, 1]`);
  }
  return ok(value as Fraction);
}

/** `0.0` as a `Fraction` — total, no validation needed. */
export const fractionZero = 0 as Fraction;
/** `1.0` as a `Fraction` — total, no validation needed. */
export const fractionOne = 1 as Fraction;
