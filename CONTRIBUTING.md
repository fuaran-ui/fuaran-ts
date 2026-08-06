# Contributing to fuaran-ts

`fuaran-ts` is the TypeScript reference implementation of the Fuaran UI language contract. It is a
conformant host of the same canonical wire format as the F#
[`fuaran-dotnet`](https://github.com/fuaran-ui/fuaran-dotnet) tier, and ships the `@fuaran-ui/*` npm-scoped
package set. Contributions are welcome under the repository licence (Apache-2.0).

## Wire-format conformance

The canonical Fuaran UI wire format is specified language-neutrally in the
[`fuaran-specification`](https://github.com/fuaran-ui/fuaran-specification) repository
(`WIRE_FORMAT.md` + `schema.json` + the executable conformance corpus). Every change to
`@fuaran-ui/schema` / `@fuaran-ui/ops` that touches the wire form is subject to the forward-coupling
rule (`WIRE_FORMAT.md` §11): the specification, the schema, the corpus, and every conformant host's
encoder/decoder move together — a wire-shape change here lands only alongside the matching
specification and corpus change.

### Running the conformance tests locally

The corpus-parity tests read the fixture corpus from a directory named `wire-format-fixtures`
**next to** this repository's checkout:

```sh
git clone https://github.com/fuaran-ui/fuaran-specification wire-format-fixtures
git clone https://github.com/fuaran-ui/fuaran-ts
cd fuaran-ts && pnpm install && pnpm test
```

Without the corpus checkout, the corpus-driven suites (`@fuaran-ui/ops`, `@fuaran-ui/conformance`,
and the function-registry goldens) fail with a missing-file error; everything else runs standalone.

### A second corpus, for a second specification

`@fuaran-ui/spec-hash` (workspace-internal, not published) implements the
`canonical-json-sha256-v1` minting canonicalisation and certifies against the **model-execution wire
specification**'s corpus, resolved the same way — a directory named `fuaran-model-execution-spec`
next to this checkout. That specification's repository is **private**, so the clone needs access to
`fuaran-ui/fuaran-model-execution-spec`; CI reaches it with a `SPEC_CORPUS_TOKEN` secret.

```sh
git clone https://github.com/fuaran-ui/fuaran-model-execution-spec
```

As above, absence is a **loud failure naming the checkout**, never a skip — a conformance gate that
quietly does nothing leaves the build green, and everybody reads that as agreement.

## Tooling

- **Node**: `>=22` (see `engines` in `package.json`).
- **pnpm**: `>=9` (the lockfile + workspaces protocol assumes this).
- **Prettier**: configured at the repo root via `.prettierrc`; `pnpm format` formats every tracked file; `pnpm format:check` is the CI gate.
- **TypeScript**: strict mode + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes` + `verbatimModuleSyntax` (see `tsconfig.base.json`). Per-package `tsconfig.json` files extend this base.

## Licence

Apache 2.0. See [LICENSE](LICENSE). The Diametrical Ltd copyright header at the top of `LICENSE`
mirrors the attribution recorded in the F# `fuaran` tier.
