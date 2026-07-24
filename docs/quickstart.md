# Quickstart – describe a UI, render it in your app

The shortest path from a prompt to a rendered UI in your own app. You call the Fuaran
generation endpoint with a sentence, get back a canonical UI tree, and mount it. The
next prompt repairs the tree you already have – a cheap diff, not a fresh generation.

Three moving parts, all from one package:

- **`FuaranClient`** – one typed HTTPS call to the endpoint. No hand-rolled `fetch`.
- **`FuaranSession`** – holds the tree between turns so each prompt is a repair.
- **`mountProduced`** – decodes + renders a produced tree with React. No parsing by you.

> **You need an endpoint URL and a paid access token to run this.** They are the
> commercial gate; installing the package does not grant access. See
> [token-setup.md](token-setup.md) for where the access token and BYOK provider key
> live. If you have neither yet, read on – the code is complete and the shape is real.

## Install

```sh
npm install @fuaran-ui/client
# for the render glue (decode + mount into the DOM), also:
npm install @fuaran-ui/renderer @fuaran-ui/ops @fuaran-ui/schema react react-dom
```

## Generate + the turn loop

<!-- drift-check:compile quickstart -->

```ts
import { FuaranClient, FuaranSession, isSurfaceVersionCompatible } from '@fuaran-ui/client';

// Point the client at your generation endpoint. In a browser app this is your own
// same-origin proxy (e.g. `/api/fuaran`) that injects the paid access token + BYOK
// key server-side — see token-setup.md for the two credential patterns.
const client = new FuaranClient({ endpoint: '/api/fuaran' });

// A session holds the produced tree between turns, so every prompt after the first
// is a cheap repair diff rather than a from-scratch regeneration.
const session = new FuaranSession(client);

// First turn — describe the UI you want.
const first = await session.next('a metric card showing monthly revenue');

if (first.kind === 'produced') {
  // first.treeJson is canonical Fuaran wire-format JSON; first.ops are the ops the
  // turn applied; first.version is the surface version the endpoint stamped. Render
  // first.treeJson with mountProduced (below).
  if (!isSurfaceVersionCompatible(first.version)) {
    console.warn(`Fuaran surface ${first.version} is newer than this client understands`);
  }
} else if (first.kind === 'accessDenied') {
  console.error(`access denied: ${first.reason}`); // token missing / expired / invalid
} else {
  console.error(`turn failed at ${first.error.stage}: ${first.error.message}`);
}

// Second turn — repair the tree the session is holding. A cheap diff, not a regen.
// The session advances its held tree only when a turn produces one.
const repair = await session.next('rename the metric to ARR');
if (repair.kind === 'produced') {
  // mount repair.treeJson exactly as the first turn — the session already moved on.
}
```

`session.next(prompt)` remembers the tree the last turn produced and sends it as the
`currentTreeJson` of the next turn. That tree-carrying loop is the token-saving
ergonomic the whole model hinges on: turn one generates, every later turn repairs.

The result is discriminated on `kind` and **never throws for an endpoint outcome** – a
transport failure comes back as `turnFailed` with a `provider`-stage envelope, so you
branch on the three cases instead of wrapping calls in `try`/`catch`.

## Render it

Decode + mount a produced tree in one call. `mountProduced` runs the same canonical
codec the renderer trusts, so you never parse or validate raw model output yourself.
Import the reference stylesheet once.

<!-- drift-check:symbols @fuaran-ui/client/render mountProduced decodeProducedTree -->

```tsx
import { mountProduced } from '@fuaran-ui/client/render';
import '@fuaran-ui/renderer/css';

// `first` is the produced result from above.
if (first.kind === 'produced') {
  const mounted = mountProduced(document.getElementById('app')!, first);
  if (!mounted.ok) {
    console.error('decode failed', mounted.error);
  }
}
```

`mountProduced` returns `{ ok: true, root }` (the React root – hold it to remount the
next turn's tree) or `{ ok: false, error }`. Prefer `decodeProducedTree(produced)` if
you want the typed `Node` tree to render yourself with `<FuaranRenderer tree={…}>`.

## Where to go next

- **[integration.md](integration.md)** – the end-to-end story: access token → BYOK key
  → the cheap-diff editing loop → the two safe key-handling patterns.
- **[token-setup.md](token-setup.md)** – browser-BYOK vs server-proxy, and the corpus
  opt-in/opt-out flags.
- **The richer path:** [`@fuaran-ui/mcp`](../packages/mcp/README.md) exposes the same
  endpoint to a coding agent as MCP tools (generate / validate / recipe / scaffold), so
  "add an AI-driven UI panel" becomes a one-shot agent task with no docs-reading at all.

## Keeping this honest

The `ts` block above is compile-checked against the current `@fuaran-ui/client` types by
[`check-drift.mjs`](check-drift.mjs) (`node docs/check-drift.mjs`): if the SDK surface
changes under it, this quickstart stops compiling and the check fails. The docs cannot
silently rot.
