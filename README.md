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
