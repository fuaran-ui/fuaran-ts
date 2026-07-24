// Result<T, E> — the vanilla discriminated union the schema + ui packages use
// for parse-don't-validate and pre-emit-validation outcomes.
//
// Port of the F# `Result<'T, 'TError>` shape the language tier leans on
// (Fuaran.UI.Bounded.tryCreate, Fuaran.UI.PreEmitValidate.validate). The
// in-memory shape is deliberately structural so it round-trips cleanly and
// pattern-matches with a single `if (r.ok)` discriminant check.

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E };

/** Construct a success result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Construct a failure result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
