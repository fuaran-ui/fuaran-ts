# fuaran-ts

[![CI](https://github.com/fuaran-ui/fuaran-ts/actions/workflows/ci.yml/badge.svg)](https://github.com/fuaran-ui/fuaran-ts/actions/workflows/ci.yml) [![npm](https://img.shields.io/npm/v/%40fuaran-ui%2Fui.svg)](https://www.npmjs.com/package/@fuaran-ui/ui) [![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)

TypeScript reference implementation of the Fuaran UI language contract — sibling to the F# `fuaran` tier. Both are conformant hosts of the language-neutral wire format; neither is a port of the other.

Ships the `@fuaran-ui/*` npm-scoped package set. The core four:

| Package               | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `@fuaran-ui/schema`   | Typed tree, defaults, bounded primitives                      |
| `@fuaran-ui/ui`       | Smart constructors + pre-emit validation (the author surface) |
| `@fuaran-ui/ops`      | Canonical-JSON encoder + decoder + tree-op apply engine       |
| `@fuaran-ui/renderer` | React renderer + reference CSS + custom-renderer registry     |

and the rest of the published set:

| Package                      | Role                                                                         |
| ---------------------------- | ---------------------------------------------------------------------------- |
| `@fuaran-ui/renderer-server` | Pure-string server-HTML renderer — no React, no DOM, inert interactivity     |
| `@fuaran-ui/op-stream`       | Op-stream persistence + replay                                               |
| `@fuaran-ui/charts`          | Chart → Drawing lowering                                                     |
| `@fuaran-ui/layout-observer` | Browser-default layout-flag observer                                         |
| `@fuaran-ui/style-observer`  | Computed-style observer — resolved colours, contrast and legibility flags    |
| `@fuaran-ui/theme-manifest`  | Machine-readable theme contract, with quantified invariants                  |
| `@fuaran-ui/ai-tools`        | Runtime introspection surface                                                |
| `@fuaran-ui/validator`       | Build-time TS-AST walker over authored trees                                 |
| `@fuaran-ui/telemetry`       | Telemetry record contract — the deny record and its sink interface           |
| `@fuaran-ui/conformance`     | Third-party wire-format certification kit ([CONFORMANCE.md](CONFORMANCE.md)) |
| `@fuaran-ui/client`          | Typed client over a generation endpoint, plus the turn loop                  |
| `@fuaran-ui/react`           | React adapter — `useFuaranGenerate` and `<FuaranGenerated>`                  |
| `@fuaran-ui/mcp`             | MCP server exposing Fuaran to coding agents (`fuaran-mcp`)                   |
| `@fuaran-ui/cli`             | Shell CLI over the same tool core (`fuaran generate / validate / …`)         |
| `@fuaran-ui/mock`            | Offline stand-in for the generation endpoint                                 |
| `@fuaran-ui/fuaran`          | Convenience entry point                                                      |
| `fuaran`                     | Unscoped defensive placeholder — exports nothing                             |

That table is checked rather than remembered: `node dev-scripts/check-readme-packages.mjs` runs as
part of `pnpm test` and fails when a publishable package under `packages/` is missing from it. The
list had drifted to four entries plus a sentence naming four more, against a workspace of twenty-one
publishable packages — a README under-reporting what it ships is a distribution question rather than
a tidiness one, so the guard is what keeps it accurate.

## Safety by construction

A Fuaran tree is a value over a closed vocabulary rather than code or markup, and these packages
decode and validate it before anything renders. The wire format is language-neutral, but its
renderer and decoder obligations are adopted host by host, so what follows is what this host
provides, not what the specification asks of every host.

- **Refusals are typed.** `@fuaran-ui/ops` returns a `DecodeError` carrying a stable code, a
  `$`-rooted path and a message for a wire-shape violation, rather than guessing at the input.
  Undeclared keys are rejected and an unknown case in a closed vocabulary is an error, not a
  fallback (wire format §6, [specification](https://fuaran-ui.io/guide/wire-format)).
- **Every string-to-DOM seam is filtered at one place**,
  [`@fuaran-ui/renderer/sanitize`](packages/renderer/src/sanitize.ts): a default-deny URL-scheme
  allowlist on `href` and `src` that also rejects the protocol-relative spellings including the
  backslash forms (the §19 renderer floor), a key and value gate over extra attributes, and a
  raw-HTML sweep before anything reaches `dangerouslySetInnerHTML`. Markdown is rendered by this
  tier's own GFM renderer, which escapes raw HTML by construction and routes URLs through the same
  floor; the sweep is defence in depth over that. React's escaping covers the typed props, and
  `@fuaran-ui/renderer-server` escapes attribute values and text content at a single seam
  (`html.ts`), since a string renderer has no React to fall back on.
- **A custom renderer registered by the host is a host trust boundary.** Its output is not policed,
  by design: the closure is application code, not an AI emission. Content Security Policy is the
  application's too.

Two things this host does not do, said here rather than left to be discovered:

- The §21 resource limits are not enforced. The parser is mutually recursive with no depth counter,
  so a pathologically nested document raises the engine's `RangeError` instead of returning a
  `LIMIT_EXCEEDED` refusal, and `DecodeErrorCode` does not yet carry that case. §21.5 of the
  specification records where each host stands; the F# reference host is the only one enforcing them
  today.
- `FuaranRuntime.canDispatch` is an optional policy hook, consulted for the gated action set
  (`Call`, `Navigate`, `AiTool`, `ReadFileBody`, `ApplyTreeOp`). A host that supplies no hook has no
  gate, which is not the same thing as failing closed.

Reporting a suspected vulnerability: [`SECURITY.md`](SECURITY.md). The reasoning behind the posture:
[default-deny by shape](https://fuaran-ui.io/discussion/default-deny-by-shape).

## Starter template

[`templates/ts-starter`](templates/ts-starter) is the on-ramp: a Vite + React 19 host wired to the published `@fuaran-ui/*` packages — the renderer mounted, a typed tree authored through the smart-constructor surface, the dispatch loop closed, and a custom-renderer registry stub.

[![Open in StackBlitz](https://developer.stackblitz.com/img/open_in_stackblitz.svg)](https://stackblitz.com/github/fuaran-ui/fuaran-ts/tree/main/templates/ts-starter?file=src%2Ftree.ts)

Opening that link renders a Fuaran tree in the browser with nothing installed and no account. To work locally instead:

```bash
npx degit fuaran-ui/fuaran-ts/templates/ts-starter my-fuaran-app
cd my-fuaran-app
npm install
npm run dev
```

The starter's dependencies are ordinary published versions, so it installs outside this repository as readily as inside it. [`templates/ts-starter/README.md`](templates/ts-starter/README.md) walks through the files and the next steps.

## Demo

[`samples/demo`](samples/demo) is a Vite + React app that consumes the full MVP stack end to end — it authors a representative tree through the smart-constructor surface, renders it with `<FuaranRenderer>`, demonstrates the canonical-JSON wire round-trip (encode → decode → render), a `Custom`-node escape hatch, and typed-theme application.

![Fuaran TypeScript reference demo — a rendered Fuaran tree with a counter, revenue metric, editable grid, and a wire-format round-trip panel](samples/demo/screenshot.png)

### Run it

```bash
git clone https://github.com/fuaran-ui/fuaran-ts
cd fuaran-ts
pnpm install
pnpm build        # build the @fuaran-ui/* packages the demo consumes
pnpm --filter @fuaran-ui/demo dev
```

Then open <http://localhost:24030>.

On Windows, the one-command entry point installs, builds, serves, and opens a browser tab:

```powershell
.\run.ps1
```

## Build & test

```bash
pnpm install
pnpm build        # build every @fuaran-ui/* package
pnpm test         # run the Vitest suites
```

On Windows, `pwsh ./verify.ps1` runs that whole sequence — install with the lockfile,
`format:check`, build, `typecheck`, test — and exits with the first failing stage's code. That is
the invocation an automated gate should use. `./run.ps1` on its own serves the demo's dev server and
never returns; `./run.ps1 -Verify` delegates to `verify.ps1`.

Build runs before test on purpose: the suites import their siblings' built `dist/`, so testing a
half-built workspace fails every fixture at once and points at the wrong package.

**Run a single package's suite through `pnpm --filter`, not through `vitest --root`.**

```bash
pnpm --filter @fuaran-ui/mcp exec vitest run          # correct
npx vitest run --root packages/mcp                    # resolves types from the wrong directory
```

The two are not equivalent, and the difference is silent until it is not. `--root` moves Vitest's
notion of the project root without moving the process's working directory, so TypeScript's `@types`
resolution still walks up from wherever the command was typed — which for a workspace package means
it finds the ROOT `node_modules/@types` and not the package's own. Tests that depend on a
package-local ambient type then fail with type errors that describe nothing real; `packages/mcp`'s
scaffold-parity suite is the one that shows it. `pnpm --filter` sets the working directory to the
package, so both resolutions agree. CI uses `pnpm test`, which is `pnpm -r run test` — the same
per-package working directory.

Some suites resolve a specification corpus as a SIBLING DIRECTORY of this repository —
`../wire-format-fixtures` and `../fuaran-model-execution-spec` — and **fail rather than skip** when
it is absent, deliberately: a conformance check that goes green without its oracle is worse than no
check. A clone or a git worktree placed where those siblings are not is red for a reason that has
nothing to do with the code under test. CI checks both out to those paths.

## License

Apache 2.0. See [LICENSE](LICENSE).

The repository is private during the bootstrap window; the license is recorded from the first commit so the canonical-implementation posture is unambiguous on first publication.
