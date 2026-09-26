// ============================================================================
//  Core twin — the `Result` constructors the twins return.
//
//  The boundary takes TYPES only from @fuaran-ui/schema (the `Result` shape
//  among them) and no runtime value from any host package, so the two
//  constructors are defined here. They build exactly the object shape
//  @fuaran-ui/schema's `ok` / `err` build, so a value from either is
//  interchangeable. Internal: not re-exported by any published package.
// ============================================================================

import type { Result } from '@fuaran-ui/schema';

/** Construct a success result. */
export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });

/** Construct a failure result. */
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });
