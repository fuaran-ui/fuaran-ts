# `@fuaran-ui/hydration-sample`

A live-browser worked example of the **in-browser-decode hydration path**: the path
the F# Fable client structurally can't take, because `@fuaran-ui/ops` is
browser-native where the F# `Ops` decoder isn't.

## What it shows

1. **`ssr.mjs`** (the "server", Node) builds the canonical Fuaran tree with
   `@fuaran-ui/ui`, server-renders it to static HTML with `@fuaran-ui/renderer`
   (`react-dom/server`), encodes the tree to the canonical wire format with
   `@fuaran-ui/ops`, and writes `index.html` — the server HTML inside `#host` plus
   the wire JSON embedded in `<script type="application/json" id="fuaran-hydrate-hydration-root">`.
2. **`src/main.tsx`** (the browser) calls `hydrateEmbedded({ containerId: 'host', rootId: 'hydration-root' })`,
   which reads that `<script>`, **decodes it via `@fuaran-ui/ops`**, and attaches
   React with `hydrateRoot` (not `createRoot`). A green banner confirms success.

One canonical tree, two pipelines (Node server render + browser hydrate), zero
hand-written HTML, zero hydration mismatch.

## Run it

```bash
pnpm install          # from the fuaran-ts workspace root (links @fuaran-ui/* + builds them)
pnpm --filter @fuaran-ui/hydration-sample dev    # runs ssr.mjs then serves on http://localhost:24035
```

`pnpm dev` runs `node ssr.mjs` (writes `index.html`) then `vite`. Open
<http://localhost:24035>: the page is fully visible before JS runs (server HTML),
then React hydrates in place — check the green status banner and the console
(`[fuaran:hydration] decoded embed + hydrated #host`, no mismatch warning).

## Interactivity over the decoded tree (Phase 159)

The bottom card carries two buttons whose `onClick` actions the browser **decoded
from the embed** — and they work, entirely client-side, with no server round-trip:

- **Notify** fires through the wired `runtime` (the page logs it). `Notify`,
  `SetState`, `Navigate`, `AiTool`, `Chain`, `CommitLocal`, and `WriteToClipboard`
  are all **wire-survivable** — they carry only data, so they round-trip through
  `encode`→`decode` intact and dispatch through a supplied `runtime`.
- **Navigate** is **blocked by the `runtime.canDispatch` gate** (the default-deny
  seam, the TS mirror of the F# Phase 119 `CanDispatch`): a server-emitted, decoded
  tree cannot redirect the page — or fire `Call` / `AiTool` / `ReadFileBody` —
  unless the host's gate approves it. The denied attempt surfaces a diagnostic.

### What does _not_ survive the wire

Three `Action` cases carry a **closure** and decode to a `<closure>` sentinel
(dead after decode): `Dispatch` (an app message), `Call`'s `onResult`, and
`ReadFileBody`'s `onRead`. You can't ship a function over JSON — so the rule is
**"ship a verb, not a function"**: prefer the named, data-carrying actions. For
full closure-backed interactivity you reconstruct the tree in code (the F#-tier
`samples/hydration` "model-b" path) or keep the model server-side (the F#
server-driven tier, Phase 152).
