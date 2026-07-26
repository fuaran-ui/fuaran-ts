# CLAUDE.md — fuaran-ts (TypeScript reference implementation)

This repo is the **TypeScript reference implementation** of the Fuaran UI language contract: the typed-record shape, smart constructors, canonical-JSON codec, React renderer, and follow-up packages (op-stream, layout observer, AI tools, validator). Ships as the `@fuaran-ui/*` npm-scoped package set.

This repo sits in the Fuaran workspace alongside the F# `fuaran` language tier (the two are sibling conformant hosts of the same wire format). Cross-repo development conventions (port allocation, launcher patterns, formatting mandate, language-baseline pinning) live at the maintainers' workspace level and are not shipped here.

## Posture

- **Apache 2.0 from day one.** Distinct from the F# `fuaran` tier's current "private and proprietary, planning Apache 2.0" posture — the TS sibling is OSS-licensed from the first commit to make the canonical-implementation claim unambiguous ahead of paper publication.
- **Apache-2.0 from day one, public by design** (see [`LICENSE`](LICENSE)); the packages publish to npm under the `@fuaran-ui` scope.
- **Wire-format conformance is the stability contract.** The canonical wire format is owned by the F# `fuaran` tier ([`../fuaran/docs/WIRE_FORMAT.md`](../fuaran/docs/) as of Phase 73 (shipped 2026-05-30)); this repo's `@fuaran-ui/schema` + `@fuaran-ui/ops` packages must encode/decode byte-identically against the workspace-level `../wire-format-fixtures/` corpus.

## Shipped packages

| Package                      | Role                                                                                                                                                                                                                                                                                                                                                                           | Phase |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----- |
| `@fuaran-ui/ui`              | Placeholder (`0.0.0-bootstrap.1`) claiming the npm scope, at `packages/ui/`                                                                                                                                                                                                                                                                                                    | 74    |
| `@fuaran-ui/fuaran`          | Convenience entry-point shell (`0.0.0-placeholder.1`) at `packages/fuaran/`; exports `VERSION` + default object                                                                                                                                                                                                                                                                | 74    |
| `fuaran`                     | Unscoped defensive placeholder (`0.0.0-placeholder.2`) at `packages/placeholder/` — blocks bare-name squatting; exports nothing; directs installers to `@fuaran-ui/ui`                                                                                                                                                                                                         | 74    |
| `@fuaran-ui/schema`          | Typed tree, defaults, bounded primitives                                                                                                                                                                                                                                                                                                                                       | 75    |
| `@fuaran-ui/ui`              | Smart constructors, pre-emit validation (replaces the placeholder)                                                                                                                                                                                                                                                                                                             | 75    |
| `@fuaran-ui/ops`             | Canonical JSON encoder + decoder + apply engine                                                                                                                                                                                                                                                                                                                                | 76    |
| `@fuaran-ui/renderer`        | React renderer + reference CSS + custom-renderer registry                                                                                                                                                                                                                                                                                                                      | 77    |
| `@fuaran-ui/renderer-server` | Pure-string server-HTML renderer (TS twin of F# `Fuaran.UI.Renderer.Server`: no React/DOM, parity-locked class vocabulary, inert interactivity, crawlable links)                                                                                                                                                                                                               | —     |
| `@fuaran-ui/op-stream`       | Op-stream persistence + replay                                                                                                                                                                                                                                                                                                                                                 | 79    |
| `@fuaran-ui/layout-observer` | Browser-default layout-flag observer                                                                                                                                                                                                                                                                                                                                           | 80    |
| `@fuaran-ui/style-observer`  | Browser-default computed-style observer (TS twin of F# `Fuaran.UI.StyleObserver`: resolved-colour read-back + contrast/legibility flags + manifest-aware tier)                                                                                                                                                                                                                 | —     |
| `@fuaran-ui/theme-manifest`  | Machine-readable theme contract (TS twin of F# `Fuaran.UI.ThemeManifest`: DTCG tokens + role bindings + quantified invariants; what the style observer verifies against)                                                                                                                                                                                                       | —     |
| `@fuaran-ui/ai-tools`        | Runtime introspection surface                                                                                                                                                                                                                                                                                                                                                  | 81    |
| `@fuaran-ui/validator`       | Build-time TS-AST walker                                                                                                                                                                                                                                                                                                                                                       | 82    |
| `@fuaran-ui/conformance`     | Third-party wire-format certification kit (adapter-driven corpus runner + report; see `CONFORMANCE.md`)                                                                                                                                                                                                                                                                        | 168   |
| `@fuaran-ui/client`          | Typed client over the Fuaran generation endpoint — `FuaranClient.generate` + `FuaranSession` turn-loop (holds the tree → repair diffs) + `./render` decode+mount glue; OSS-safe HTTPS + types layer (the endpoint URL + paid access token are the commercial gate)                                                                                                             | 215   |
| `@fuaran-ui/mcp`             | MCP server exposing Fuaran to coding agents — `fuaran_generate` (endpoint turn) / `fuaran_validate` (canonical-codec diagnostics) / `fuaran_recipe` (bundled recipe bank; regenerated by a workspace-internal extraction step, never hand-edited) / `fuaran_scaffold` (ts-react + fsharp-fable boilerplate); `fuaran-mcp` stdio bin; credentials env-only + redaction-scrubbed | 216   |
| `@fuaran-ui/mock`            | Local, offline stand-in for the generation endpoint — same TurnRequest/TurnResult contract, canonical corpus trees by prompt match; deterministic, zero-secret, CI/sandbox-safe (`npx @fuaran-ui/mock`)                                                                                                                                                                        | 221   |
| `@fuaran-ui/cli`             | Shell CLI over the public surfaces — `fuaran generate / validate / recipe / scaffold`, zero MCP config; reuses the MCP tool core so CLI and MCP behave identically (sibling to the `Fuaran.UI.Cli` dotnet tool)                                                                                                                                                                | 224   |
| `@fuaran-ui/react`           | React adapter — the `useFuaranGenerate` hook owns the current tree as state so the turn-loop (generate, then cheap repair diffs) is automatic, plus the closed hint-threading `repair` loop and `<FuaranGenerated>` rendering through `@fuaran-ui/renderer`                                                                                                                    | 226   |
| `@fuaran-ui/telemetry`       | Telemetry record contract — the deny record + fire-and-forget sink interface (TS mirror of F# `Fuaran.UI.Telemetry.Abstractions`); what the renderer's debug global records a refused in-page `apply` to                                                                                                                                                                       | 193   |

## Layout

```
fuaran-ts/
├── packages/           # @fuaran-ui/* package shells (+ unscoped `fuaran` defensive placeholder)
│   ├── ui/             # Phase 74 placeholder for @fuaran-ui/ui; Phase 75 ships the smart-ctor surface
│   ├── fuaran/         # Phase 74 placeholder for @fuaran-ui/fuaran; convenience entry-point shell
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

- `../fuaran/docs/WIRE_FORMAT.md` — the canonical wire-format spec (shipped in Phase 73).
- `../wire-format-fixtures/` — the workspace-level fixture corpus the codec parity tests consume (relocated from `fuaran/` in Phase 73).
- `../fuaran/src/Fuaran.UI.Renderer/css/` — the reference CSS bundle Phase 77 sync-packages.

This repo produces npm packages, not NuGet packs — the workspace [`../pack-all.ps1`](../pack-all.ps1) treats this sibling as a no-op by default. The `-PublishFuaranTsCanary` flag is the opt-in for inner-loop testing of the npm publish workflow without cutting a real release tag.

## Render-time sanitization contract

`@fuaran-ui/renderer` (Phase 77) inherits the string→DOM seam discipline from the F# tier's [`SANITIZATION.md`](../fuaran/SANITIZATION.md) (Phase 56). Every code path that touches `href` / `src` / `dangerouslySetInnerHTML` / custom attributes routes through `@fuaran-ui/renderer/sanitize`. Custom renderers registered via the `<FuaranRenderer runtime={...}>` registry are a host trust boundary — same posture as the F# `IFuaranRuntime.RegisterCustomRenderer` seam.

## Public vocabulary discipline

When the repo flips public, anything shipped here will be visible to OSS consumers. **Do not reference private, unpublished projects by name in shipped artefacts** — no mentions of private repositories, private package families, or internal planning references in code comments, READMEs, or sample files that ship to npm or get rendered into public docs. Cross-references stay one-way: private consumers may reference this repo; this repo never references them.

This matches the same public vocabulary discipline the F# `fuaran` tier carries ([`../fuaran/CLAUDE.md`](../fuaran/CLAUDE.md) "Public vocabulary discipline" section).
