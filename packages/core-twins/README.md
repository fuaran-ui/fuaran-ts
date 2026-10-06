# @fuaran-ui/core-twins

**Workspace-internal. Not published.**

This host's twins of the `Fuaran.Core` reference
subsystems, gathered behind one internal boundary:

| Twin                                                                           | Reference                                | Re-exported by                                                        |
| ------------------------------------------------------------------------------ | ---------------------------------------- | --------------------------------------------------------------------- |
| DataFrame / `Transform` evaluator, list-parameter substitution                 | `Fuaran.Core.DataFrame`                  | `@fuaran-ui/ops`                                                      |
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

## The boundary

`test/boundary.test.ts` fails if anything in `src/` imports from the host's domain packages. The
only admitted edge is an erased `import type` of the `@fuaran-ui/schema` types pinned in
`test/boundary.ts` (`SCHEMA_TYPE_ALLOWLIST`, held exactly). The same suite checks that no
published package's built `dist` names this package.

Keeping the twins here means a change to Core semantics is one edit in one place, and a future
per-language Core package is a copy of this directory plus the allowlisted type declarations.
