# @fuaran-ui/renderer-server

Server-HTML renderer for the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) typed `Node` tree — the TypeScript twin of the F# `Fuaran.UI.Renderer.Server` tier.

A **pure-string renderer** — no React, no DOM. It walks a typed tree and emits a body-fragment HTML string carrying the reference `fuaran-*` class vocabulary, so a non-React Node/edge server can render Fuaran chrome end-to-end for a fast first paint, a crawlable / no-JavaScript page, and an isomorphic-hydration handoff to `@fuaran-ui/renderer` on the client. The emitted class + node-id vocabulary is **parity-locked** to both the React client renderer and the F# reference renderer (see `test/parity.test.tsx`).

## Install

```sh
npm install @fuaran-ui/renderer-server
```

`@fuaran-ui/schema` and `@fuaran-ui/renderer` are peer dependencies (the latter for its React-free `/sanitize` and `/markdown` subpaths + the packaged reference CSS). `react` / `react-dom` are **not** required at runtime, and this package now has **no runtime dependencies of its own** — markdown renders through the same deterministic renderer the client uses, so the server and the client cannot disagree about a markdown body.

## Server semantics

Mirroring the F# SSR precedent — render the tree inert, never blank:

- **Interactivity renders inert.** A `Button` is a real `<button>`, dead until hydration; no event handlers are emitted.
- **A `Link` is a real, sanitised `<a href>`** — the crawlable, no-JavaScript navigation path.
- **Bindings resolve server-side.** `Static` bindings resolve to their value; `Query` / `Filter` / `Selection` / … resolve from host-supplied `sources` or fall back to the loading slot / em-dash placeholder.
- **Client-library visualisations render a deterministic placeholder** (`Chart` / `Map`), never a blank; `Table` / `Grid` render structural HTML.
- **A `Sparkline` renders REAL GEOMETRY, not a placeholder**, from the same `@fuaran-ui/charts` lowering and `drawingSvg` builder the client renderer calls — so the two tiers emit identical bytes by construction, and the picture is pinned cross-host by the shared `sparkline-lowering/*` goldens. An unresolved or empty series keeps the em-dash element (`fuaran-sparkline-empty`): a readable, deterministic stand-in rather than a blank.
- **`Custom` renders the inert labelled placeholder** the client emits when no renderer is registered.

## Usage

```ts
import { renderToHtml } from '@fuaran-ui/renderer-server';
import { decodeNode } from '@fuaran-ui/ops';

const decoded = decodeNode(wireJson);
if (!decoded.ok) throw new Error('bad tree');

const bodyFragment = renderToHtml(decoded.value, {
  sources: { queryResults: { totalRevenue: 42 } },
});

// The host owns the document shell + the <link> to the packaged reference CSS:
const page = `<!doctype html><html><head>
  <link rel="stylesheet" href="/fuaran.css">
</head><body><div id="app">${bodyFragment}</div></body></html>`;
```

Serve the packaged reference stylesheet from `@fuaran-ui/renderer/css` (the same artefact the client renderer ships), so the server-rendered fragment and the hydrated client render byte-for-byte identical chrome.

## Hydration

Because the emitted class names + `data-fuaran-node-id` attributes match what `@fuaran-ui/renderer` produces, a server-rendered fragment can be handed to the client renderer's `hydrate` / `hydrateEmbedded` entry points (`@fuaran-ui/renderer`) — the React reconciler attaches in place rather than re-rendering.

## Parity

The package carries a render-parity corpus (the rendering analogue of the wire-format corpus). Over the whole node fixture set it asserts the server renderer emits the **same `fuaran-*` class set and `data-fuaran-node-id` set** as the React client renderer, and that every emitted class is in the **F# reference renderer's vocabulary**. A drift in either direction is a build failure. The `StyleObservation` /class shapes are declared stable in [`STABILITY.md`](../../STABILITY.md).

Apache-2.0.
