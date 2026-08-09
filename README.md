# fuaran-ts

TypeScript reference implementation of the Fuaran UI language contract — sibling to the F# `fuaran` tier. Both are conformant hosts of the language-neutral wire format; neither is a port of the other.

Ships the `@fuaran-ui/*` npm-scoped package set:

| Package               | Role                                                          |
| --------------------- | ------------------------------------------------------------- |
| `@fuaran-ui/schema`   | Typed tree, defaults, bounded primitives                      |
| `@fuaran-ui/ui`       | Smart constructors + pre-emit validation (the author surface) |
| `@fuaran-ui/ops`      | Canonical-JSON encoder + decoder + tree-op apply engine       |
| `@fuaran-ui/renderer` | React renderer + reference CSS + custom-renderer registry     |

with `@fuaran-ui/op-stream`, `@fuaran-ui/layout-observer`, `@fuaran-ui/ai-tools`, and `@fuaran-ui/validator` following.

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

## License

Apache 2.0. See [LICENSE](LICENSE).

The repository is private during the bootstrap window; the license is recorded from the first commit so the canonical-implementation posture is unambiguous on first publication.
