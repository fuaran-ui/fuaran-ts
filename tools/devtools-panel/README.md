# Fuaran DevTools panel

A Manifest V3 browser extension that debugs a running Fuaran app at the **typed-tree** level —
the visual counterpart to the `window.__fuaran` console REPL. Where the browser's Elements panel
shows the post-projection DOM, this panel shows the typed `Node` tree the app actually reasons
about: kinds, ids, binding slots, geometry, and the op-stream history that produced it.

- **Typed-tree view** — the live tree via the `@fuaran-ui/ai-tools` introspection surface (never
  the DOM tree), refreshable, collapsible.
- **Hover-highlight** — hovering a row overlays the node's rendered region on the page, located
  from its live geometry: the "inspect element" affordance keyed off the typed node.
- **Node detail** — the selected node's kind, binding slots (with on-demand resolution of each
  slot's current value against the live binding sources), live geometry, and visibility/overflow
  flags.
- **Op-stream timeline** — a scrubable list of the persisted `@fuaran-ui/op-stream` records.
  Scrubbing replays the stream **read-only** up to that sequence (a fold over a copy — the live
  app is never mutated) and shows the historical tree in the tree view.
- **Guest selector** — a host that mounts isolated guest regions journals each guest under the
  `guest-<scopeId>` stream key. The timeline's selector scopes to the host, to one guest (that
  region's records only), or to the opt-in all-at-once rollup. The guest list is derived from the
  stream keys themselves — the op stream is the source of truth.
- **Read-only by default; gated mutation opt-in** — the only mutation affordance (an "apply a
  TreeOp" box) is hidden behind an explicit toggle and routes through the page's policy-gated
  `__fuaran.apply(opJson)`. The page's default-deny gate decides; a denied op returns its
  structured envelope and the tree is unchanged. The panel never applies an op itself.

Consumes only public `@fuaran-ui/*` packages. Apache-2.0, workspace-internal — loaded unpacked,
not published to npm or an extension store.

## Build + load unpacked

```sh
pnpm install          # once, from the repo root
pnpm --filter @fuaran-ui/devtools-panel build
```

Then in Chrome / Edge:

1. Open `chrome://extensions` (or `edge://extensions`).
2. Enable **Developer mode**.
3. **Load unpacked** → select `tools/devtools-panel/dist/`.
4. Open a page running a Fuaran app in debug mode, open DevTools, and pick the **Fuaran** panel.
5. After (re)loading the extension, reload the inspected page once so the content scripts attach.

The content scripts match `<all_urls>` (the panel must be able to detect a Fuaran app on any dev
origin), so the browser shows a broad-host-access warning on install — expected for a
developer-mode tool.

## What the inspected page must expose

**Required — the debug global.** Render with the debug flag so the renderer registers
`window.__fuaran` (DEV builds only; the global is compiled out of production bundles):

```tsx
<FuaranRenderer tree={tree} sources={sources} debug={import.meta.env.DEV} />
```

Without it the panel shows its "no Fuaran app detected" state.

**Optional — the op-stream handle (lights up the timeline).** The sink lives in host code, so the
host opts it in explicitly (DEBUG-only, same posture as the debug global):

```ts
// initialTrees: per stream id, the tree the stream's records fold from —
// what scrub-replay starts at. Streams without one still list their records;
// only scrubbing is unavailable for them.
window.__fuaranOpStream = { sink, initialTrees: { [streamId]: initialTree } };
```

**Optional — gated mutation.** For the apply box to do anything, the page must have wired an
`applyHandler` (and a `canDispatch` policy gate) into its debug global — see the renderer's
debug-global documentation. An unwired host returns the `unwired` envelope; a denied op returns
the `denied` envelope. Both are surfaced verbatim in the panel.

## Architecture

```
panel.html/panel.js ── port ──► background.js ── tabs.sendMessage ──► content.js ── postMessage ──► hook.js (MAIN world)
      ▲                                                                                                │
      └────────────────────────────── JSON-safe payloads only ◄────────────────────────────────────────┘
```

Everything that touches live page objects — introspection, geometry reads, replay — happens in
the MAIN-world hook, in the page; only JSON-safe projections cross the messaging boundaries. The
panel's models (`treeModel`, `guestStreams`, `timelineModel`) are pure and unit-tested
(`pnpm --filter @fuaran-ui/devtools-panel test`).
