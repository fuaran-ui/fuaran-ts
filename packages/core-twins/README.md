# @fuaran-ui/core-twins

**Workspace-internal. Not published.**

This host's twins of the `Fuaran.Core` reference
subsystems, gathered behind one internal boundary:

| Twin                                                                           | Reference                                | Re-exported by                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| DataFrame / `Transform` evaluator, list-parameter substitution                 | `Fuaran.Core.DataFrame`                  | `@fuaran-ui/ops`                                                      |
| Typed column (`columnOfCells`, `cellAt`, `columnCells`, `takeRows`)            | `Fuaran.Core.Column` (typed vectors)     | `@fuaran-ui/ops`                                                      |
| Canonical float layout (`num`, `formatFiniteDouble`)                           | the wire canonical number rule           | `@fuaran-ui/ops`                                                      |
| Capability runtime (`invocationKey`, `validateArgs`, registry, `toJsonSchema`) | `Fuaran.Core.Function`                   | `@fuaran-ui/ui`                                                       |
| Function registry (`findBySignature`, `compose`)                               | `Fuaran.Core.FunctionRegistry`           | `@fuaran-ui/ui`                                                       |
| Op-stream actor and its canonical encoding                                     | `Fuaran.Core.OpStream.Actor`             | `@fuaran-ui/op-stream`                                                |
| Calendar arithmetic (`daysFromCivil`, `civilFromDays`, `parseIsoDay`)          | `Fuaran.Core.DataFrame` (`dateDiffDays`) | used inside `@fuaran-ui/ops` and `@fuaran-ui/charts`; not re-exported |

The calendar module is the host's one copy of the proleptic-Gregorian arithmetic. `@fuaran-ui/schema`
keeps its own `daysFromCivil` for `epochSecondsOfInstant`, because this package depends on schema's
types and an import back would be a build cycle; `test/civil.test.ts` pins that copy against this one.

The published packages re-export every name from the module they always exported it from, and
bundle the implementation into their own `dist` (`noExternal` + `dts.resolve` in their
`tsup.config.ts`), so no public import path depends on this package.

## The typed column (Phase 2205)

A `DataColumn` holds one typed vector and a validity, as Core's `Column` does from 1.0.0: `Int32Array` ints and
days, `Float64Array` floats and epoch seconds (plus an `Int32Array` fraction in the timestamp's unit), a
`Uint8Array` of bools, and string arrays for text and decimals. `src/column.ts` is the one place that builds and
reads that storage; the evaluator works over it, gathering rows by index and reading aggregates from the vectors.

Measured under Node 25 over 100,000 rows (an int key, a float with nulls, a string, a date), against the cell-list
representation it replaced: a table holds 4.90 MB rather than 26.53 MB, and a `groupBy` with `sum`, `mean` and
`count` takes 10.3 ms rather than 34.7 ms. Encoding is slower, 62 ms against 50 ms, because a date's text is written
from its day count. Every wire byte and every transform-law answer is unchanged.

## The boundary

`test/boundary.test.ts` fails if anything in `src/` imports from the host's domain packages. The
only admitted edge is an erased `import type` of the `@fuaran-ui/schema` types pinned in
`test/boundary.ts` (`SCHEMA_TYPE_ALLOWLIST`, held exactly). The same suite checks that no
published package's built `dist` names this package.

Keeping the twins here means a change to Core semantics is one edit in one place, and a future
per-language Core package is a copy of this directory plus the allowlisted type declarations.
