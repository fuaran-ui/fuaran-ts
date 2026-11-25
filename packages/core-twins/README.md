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

## The evaluator's performance (Phase 1893)

The evaluator carries the reference evaluator's measured techniques, each landed only where it pays
under V8, and every one answers exactly what the code it replaced answered:

- **An expression is compiled once per step.** A filter's predicate and a derive's expression resolve
  every column reference, parameter and operator before any row is read (`compileExpr`); an unknown
  column or an unbound parameter still refuses only when a row reaches it.
- **The equi-join is a hash join**, the right rows bucketed by a key read from the typed storage, so the
  output order is the nested loop's; **the pivot buckets its rows in one pass**.
- **One allocation-free comparer orders rows** for a sort and a window, reading the typed vectors (a
  decimal column parsed once, at one common scale), and sorting a plain array of positions: V8 sorts a
  typed array through a comparator on its slow path.
- **Grouping keys are read from the typed storage** for a group-by, a window's partitions, a pivot's
  groups, distinct and the set operations.

`pnpm bench` (in this directory) builds the package and times the reference corpus shapes: the
sheet, the chain, the dated pipeline, the scaling pipelines, the five separately timed shapes, and
the typed and keyed families. Inputs are built outside the timed closure, warm-up is by iteration
count, every case reports its median and its worst sample, and every answer is fingerprinted before it
is timed, so a change that alters an answer shows. `test/fastPaths.test.ts` pins each fast path against
a brute-force oracle on the edges the transform-law corpus does not draw (the number family across an
int and a float, NaN, nulls, decimals by value, instants across units, colliding composite keys).

Measured under Node 22, each case in a fresh process, interleaved with the tree before the phase:
the inner join of 10,000 × 10,000 rows from 966 ms to 1.7 ms, a sort on two keys over 100,000 rows from
78 ms to 32 ms, a decimal sort over 100,000 rows from 627 ms to 43 ms, the pivot with 50 on values from
3.6 ms to 0.6 ms, and no case slower than before.

## The boundary

`test/boundary.test.ts` fails if anything in `src/` imports from the host's domain packages. The
only admitted edge is an erased `import type` of the `@fuaran-ui/schema` types pinned in
`test/boundary.ts` (`SCHEMA_TYPE_ALLOWLIST`, held exactly). The same suite checks that no
published package's built `dist` names this package.

Keeping the twins here means a change to Core semantics is one edit in one place, and a future
per-language Core package is a copy of this directory plus the allowlisted type declarations.
