# CLAUDE.md — fuaran-ts (TypeScript reference implementation)

This repo is the **TypeScript reference implementation** of the Fuaran UI language contract: the typed-record shape, smart constructors, canonical-JSON codec, React renderer, and follow-up packages (op-stream, layout observer, AI tools, validator). Ships as the `@fuaran-ui/*` npm-scoped package set.

This repo sits in the Fuaran workspace alongside the F# `fuaran` language tier (the two are sibling conformant hosts of the same wire format). Cross-repo development conventions (port allocation, launcher patterns, formatting mandate, language-baseline pinning) live at the maintainers' workspace level and are not shipped here.

## Posture

- **Apache 2.0 from day one.** Distinct from the F# `fuaran` tier's current "private and proprietary, planning Apache 2.0" posture — the TS sibling is OSS-licensed from the first commit to make the canonical-implementation claim unambiguous ahead of paper publication.
- **Apache-2.0 from day one, public by design** (see [`LICENSE`](LICENSE)); the packages publish to npm under the `@fuaran-ui` scope.
- **Wire-format conformance is the stability contract.** The canonical wire format is owned by the F# `fuaran` tier ([`../fuaran-dotnet/docs/WIRE_FORMAT.md`](../fuaran-dotnet/docs/) as of Phase 73 (shipped 2026-05-30)); this repo's `@fuaran-ui/schema` + `@fuaran-ui/ops` packages must encode/decode byte-identically against the workspace-level `../wire-format-fixtures/` corpus.

## Shipped packages

| Package                      | Role                                                                                                                                                                                                                                                                                                                                                                                         | Phase |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| `@fuaran-ui/ui`              | Placeholder (`0.0.0-bootstrap.1`) claiming the npm scope, at `packages/ui/`                                                                                                                                                                                                                                                                                                                  | 74    |
| `@fuaran-ui/fuaran`          | Convenience entry-point shell (`0.0.0-placeholder.1`) at `packages/fuaran/`; exports `VERSION` + default object                                                                                                                                                                                                                                                                              | 74    |
| `fuaran`                     | Unscoped defensive placeholder (`0.0.0-placeholder.2`) at `packages/placeholder/` — blocks bare-name squatting; exports nothing; directs installers to `@fuaran-ui/ui`                                                                                                                                                                                                                       | 74    |
| `@fuaran-ui/schema`          | Typed tree, defaults, bounded primitives                                                                                                                                                                                                                                                                                                                                                     | 75    |
| `@fuaran-ui/ui`              | Smart constructors, pre-emit validation (replaces the placeholder)                                                                                                                                                                                                                                                                                                                           | 75    |
| `@fuaran-ui/ops`             | Canonical JSON encoder + decoder + apply engine                                                                                                                                                                                                                                                                                                                                              | 76    |
| `@fuaran-ui/renderer`        | React renderer + reference CSS + custom-renderer registry                                                                                                                                                                                                                                                                                                                                    | 77    |
| `@fuaran-ui/renderer-server` | Pure-string server-HTML renderer (TS twin of F# `Fuaran.UI.Renderer.Server`: no React/DOM, parity-locked class vocabulary, inert interactivity, crawlable links)                                                                                                                                                                                                                             | —     |
| `@fuaran-ui/op-stream`       | Op-stream persistence + replay                                                                                                                                                                                                                                                                                                                                                               | 79    |
| `@fuaran-ui/layout-observer` | Browser-default layout-flag observer                                                                                                                                                                                                                                                                                                                                                         | 80    |
| `@fuaran-ui/style-observer`  | Browser-default computed-style observer (TS twin of F# `Fuaran.UI.StyleObserver`: resolved-colour read-back + contrast/legibility flags + manifest-aware tier)                                                                                                                                                                                                                               | —     |
| `@fuaran-ui/theme-manifest`  | Machine-readable theme contract (TS twin of F# `Fuaran.UI.ThemeManifest`: DTCG tokens + role bindings + quantified invariants; what the style observer verifies against)                                                                                                                                                                                                                     | —     |
| `@fuaran-ui/ai-tools`        | Runtime introspection surface                                                                                                                                                                                                                                                                                                                                                                | 81    |
| `@fuaran-ui/validator`       | Build-time TS-AST walker                                                                                                                                                                                                                                                                                                                                                                     | 82    |
| `@fuaran-ui/conformance`     | Third-party wire-format certification kit (adapter-driven corpus runner + report; see `CONFORMANCE.md`)                                                                                                                                                                                                                                                                                      | 168   |
| `@fuaran-ui/client`          | Typed client over the Fuaran generation endpoint — `FuaranClient.generate` + `FuaranSession` turn-loop (holds the tree → repair diffs) + `./render` decode+mount glue; OSS-safe HTTPS + types layer (the endpoint URL + paid access token are the commercial gate)                                                                                                                           | 215   |
| `@fuaran-ui/mcp`             | MCP server exposing Fuaran to coding agents — `fuaran_generate` (endpoint turn) / `fuaran_validate` (canonical-codec diagnostics) / `fuaran_recipe` (bundled recipe bank; regenerated by a workspace-internal extraction step, never hand-edited) / `fuaran_scaffold` (ts-react + fsharp-fable boilerplate); `fuaran-mcp` stdio bin; credentials env-only + redaction-scrubbed               | 216   |
| `@fuaran-ui/mock`            | Local, offline stand-in for the generation endpoint — same TurnRequest/TurnResult contract, canonical corpus trees by prompt match; deterministic, zero-secret, CI/sandbox-safe (`npx @fuaran-ui/mock`)                                                                                                                                                                                      | 221   |
| `@fuaran-ui/cli`             | Shell CLI over the public surfaces — `fuaran generate / validate / recipe / scaffold`, zero MCP config; reuses the MCP tool core so CLI and MCP behave identically (sibling to the `Fuaran.UI.Cli` dotnet tool)                                                                                                                                                                              | 224   |
| `@fuaran-ui/react`           | React adapter — the `useFuaranGenerate` hook owns the current tree as state so the turn-loop (generate, then cheap repair diffs) is automatic, plus the closed hint-threading `repair` loop and `<FuaranGenerated>` rendering through `@fuaran-ui/renderer`                                                                                                                                  | 226   |
| `@fuaran-ui/spec-hash`       | **Workspace-internal, `private`, not published.** Reference implementation of the `canonical-json-sha256-v1` minting canonicalisation (recursive ordinal member ordering, ECMAScript number serialisation, `sha256:{hex}` content address), gated against the model-execution wire specification's own corpus AND against an independent implementation of the same rule in another language | —     |
| `@fuaran-ui/telemetry`       | Telemetry record contract — the deny record + fire-and-forget sink interface (TS mirror of F# `Fuaran.UI.Telemetry.Abstractions`); what the renderer's debug global records a refused in-page `apply` to                                                                                                                                                                                     | 193   |

## Layout

```
fuaran-ts/
├── packages/           # @fuaran-ui/* package shells (+ unscoped `fuaran` defensive placeholder)
│   ├── ui/             # Phase 74 placeholder for @fuaran-ui/ui; Phase 75 ships the smart-ctor surface
│   ├── fuaran/                # Phase 74 placeholder for @fuaran-ui/fuaran; convenience entry-point shell
│   └── placeholder/    # Phase 74 unscoped-name defensive placeholder (the bare `fuaran` npm name); never gains substance
├── samples/            # Workspace-internal samples (not published to npm)
│   └── demo/           # Phase 78 — Vite + React canonical sample
├── tools/              # Workspace-internal developer tools (not published to npm)
│   └── devtools-panel/ # Phase 92 — MV3 browser-extension DevTools panel (typed-tree view,
│                       #   hover-highlight, node detail, scrubable op-stream timeline with a
│                       #   guest-stream selector; load-unpacked from tools/devtools-panel/dist/)
├── dev-scripts/        # PowerShell helpers for launchers
├── .github/workflows/  # ci.yml + publish.yml
├── package.json        # pnpm workspaces root
├── pnpm-workspace.yaml
├── tsconfig.base.json
├── .prettierrc
├── .editorconfig
├── .npmrc
├── LICENSE             # Apache 2.0 + Diametrical Ltd copyright header
├── CONTRIBUTING.md
├── CLAUDE.md           # this file
└── run.ps1             # Stage-0 entry point — pnpm install / build / test
```

## Build pipeline

Now that `samples/demo` ships (Phase 78), the root `run.ps1` is a thin pass-through to `dev-scripts/launch-demo.ps1 -WithUi` — it installs, builds the `@fuaran-ui/*` packages, then serves the demo's Vite dev server on port 24030 and opens a browser tab (the standard Stage-1 launch-shaped entry point):

```powershell
.\run.ps1                          # install + build packages + serve the demo + open a browser
.\run.ps1 -SkipInstall -SkipBuild  # serve immediately against an already-built workspace
.\run.ps1 -NoBrowser               # serve without opening a browser tab
```

For the install / build / test pipeline without launching a UI, drive pnpm directly:

```powershell
pnpm install
pnpm build
pnpm test
```

Behind the scenes, the launcher uses `Invoke-Pnpm` (a named-helper wrapper around `pnpm.cmd`) per the workspace's "Sibling launcher conventions" — the Node `npm.ps1` shim has a substring-slice bug that corrupts arguments when invoked from inside another `.ps1`. The pnpm equivalent inherits the same hazard; the wrapper avoids it.

## Formatting mandate

Per the workspace mandate, every commit is preceded by a Prettier pass over changed files. Prettier is installed as a workspace dev-dependency; the canonical invocation is `pnpm format` (writes) or `pnpm format:check` (CI gate).

Prettier replaces Fantomas in the workspace formatting hierarchy: F#-side commits run Fantomas; TS-side commits run Prettier. Both are non-negotiable.

Separately from formatting, `@fuaran-ui/validator`'s `pnpm fuaran-validate <glob>` is the TS-tier analogue of the F# tier's `dotnet run --project Build.fsproj -- Validate` — a build-time check over hand-authored `@fuaran-ui/ui` trees surfacing the shared `FUARAN###` defect codes. It is **advisory**, not a commit gate (unlike Prettier): wire it into CI as a `lint` step where useful, but a missing-validator run is not a discipline defect the way a missing Prettier pass is.

## Cross-repo dependencies

This repo has **no upstream dependencies on the other Fuaran siblings** as published artefacts — it consumes them only as workspace-relative path references at test time:

- `../fuaran-dotnet/docs/WIRE_FORMAT.md` — the canonical wire-format spec (shipped in Phase 73).
- `../wire-format-fixtures/` — the workspace-level fixture corpus the codec parity tests consume (relocated from `fuaran-dotnet/` in Phase 73).
- `../fuaran-model-execution-spec/wire-fixtures/` — the **model-execution wire specification**'s corpus, which `@fuaran-ui/spec-hash` certifies against. A second, independent specification with its own corpus; its repository is private, so CI checks it out with a `SPEC_CORPUS_TOKEN` secret and **fails loudly when it is absent** rather than skipping.
- `../fuaran-dotnet/src/Fuaran.UI.Renderer/css/` — the reference CSS bundle Phase 77 sync-packages.

This repo produces npm packages, not NuGet packs — the workspace [`../pack-all.ps1`](../pack-all.ps1) treats this sibling as a no-op by default. The `-PublishFuaranTsCanary` flag is the opt-in for inner-loop testing of the npm publish workflow without cutting a real release tag.

## Render-time sanitization contract

`@fuaran-ui/renderer` (Phase 77) inherits the string→DOM seam discipline from the F# tier's [`SANITIZATION.md`](../fuaran-dotnet/SANITIZATION.md) (Phase 56). Every code path that touches `href` / `src` / `dangerouslySetInnerHTML` / custom attributes routes through `@fuaran-ui/renderer/sanitize`. Custom renderers registered via the `<FuaranRenderer runtime={...}>` registry are a host trust boundary — same posture as the F# `IFuaranRuntime.RegisterCustomRenderer` seam.

**The `Custom` / `Mount` hardening posture is the same document's contract, and this tier binds it (Phase 1021, porting Phase 783).** Those two surfaces sit _outside_ the dispatch gate structurally, so `runtime.canDispatch` does not reach them, and cross-host posture divergence is itself an exploit class — a tree vetted on one host is not thereby safe on another. `SANITIZATION.md`'s "What the registry scoping and `ContentHash` do and do NOT protect" + "The `Mount` boundary" sections are the **named contract a further host ports from**; a new render surface should not re-derive it by reading either implementation. This tier's bindings: `customHash.ts` (the host hash floor a tree may only tighten, surfaced as `<FuaranRenderer customHashFloor>`; absent means `'AdvisoryWarning'`, the pre-1021 behaviour) and `guestPrivilege.ts` (no seam ⇒ deny-all guest runtime, `OutOnly` clamped before any read, `TwoWay` an explicit host grant with a warned downgrade). One mechanical divergence, deliberate: both policies are **ambient on the `RenderContext`** rather than process-global mutables, because this tier's registries are per-instance by construction and a policy held process-wide in a browser bundle is shared by every unrelated surface on the page. Same join, same outcomes, same defaults — a different carrier. The `Mount` arm owns the only call to `runtime.loadGuest`, so a future guest loader inherits the contract rather than bypassing it; the parity oracle is `packages/renderer/test/customHashFloor.test.tsx`, whose first block is a translation of the F# tier's own classifier tests.

## Decoder robustness fuzz (`packages/ops/test/decoder-fuzz.test.ts`)

The refusal contract — decoding is TOTAL, so a malformed or hostile input yields a structured typed error, never an exception and never a hang — is asserted here against **generated** hostile input rather than against the curated reject corpus alone. A curated corpus is evidence about the author's imagination; the generator produces inputs nobody chose.

- **The bounded run IS the PR gate.** It landed in the suite `pnpm test` already runs, so no workflow change was needed and none can silently switch it off.
- **The long run is on demand**, and its result is machine-readable: `FUARAN_FUZZ_LONG=1 FUARAN_FUZZ_ITERATIONS=250000 FUARAN_FUZZ_EVIDENCE=<file> pnpm exec vitest run test/decoder-fuzz.test.ts --root packages/ops`. `FUARAN_FUZZ_SEED` replays a stream.
- **The go-red self-test is permanent, and so is its inverse.** Five mutants, one per invariant, plus a pin that each mutant is PARTIAL — a mutant that broke every input would make the harness look sensitive while testing nothing.
- **One invariant is a substitute, and the substitution is named.** The reference host measures allocated bytes per input character from a per-thread counter this runtime does not expose. This host bounds the CANONICAL OUTPUT an input buys, plus a time budget. The pair catches amplification and non-termination; it would not catch a decoder that allocates heavily and discards. The comment on `Budgets.maxAmplification` says so — do not quietly reword it into equivalence.
- **`test/fuzz/generator.ts` is a SIBLING of the reference generator, not a transpile.** Same five input families; a different byte stream, necessarily — this host's hostile alphabet carries lone UTF-16 surrogates that three of the conformant hosts cannot hold in a string at all.
- **The `duplicate-key` mutator and the `NaN` / `Infinity` / `1e999` / `+1` tokens are generated deliberately, and nothing here asserts which answer is right.** Those questions are §20 "Decode determinism", landed PROPOSED and not yet ratified; crash-freedom on them is in scope, agreement is not.

## Public vocabulary discipline

When the repo flips public, anything shipped here will be visible to OSS consumers. **Do not reference private, unpublished projects by name in shipped artefacts** — no mentions of private repositories, private package families, or internal planning references in code comments, READMEs, or sample files that ship to npm or get rendered into public docs. Cross-references stay one-way: private consumers may reference this repo; this repo never references them.

This matches the same public vocabulary discipline the F# `fuaran` tier carries ([`../fuaran-dotnet/CLAUDE.md`](../fuaran-dotnet/CLAUDE.md) "Public vocabulary discipline" section).
