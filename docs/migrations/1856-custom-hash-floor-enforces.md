# Migration — the `Custom` content-hash floor enforces by default (Phase 1856)

`@fuaran-ui/renderer` 0.25.0 → 0.26.0. This is the TypeScript host reaching the posture the
reference host took at its Phase 1550: the two hosts now ship the same default and decide the same
document the same way.

## Symptom

You upgraded `@fuaran-ui/renderer` and **some `Custom` nodes stopped rendering**. Where the
component used to appear you now get the labelled placeholder — or the node's `onError` route, if
it declares one — and your `runtime.warn` channel carries:

```
{ "kind": "FuaranCustomHashMismatch", "moduleId": "analytics", "componentId": "trend-card", "expected": "sha256:9a3f…", "actual": "sha256:11c0…" }
```

That is the change working. The renderer's content-hash floor used to default to `'AdvisoryWarning'`,
so a tree whose declared `contentHash` disagreed with the registered renderer's warned and rendered
anyway; with no `customHashFloor` declared it now defaults to `'Enforced'` and refuses. The same holds
for a tree that declares a hash for a renderer registered **without** one: a claim nothing can check
is refused under an enforcing floor.

**A `Custom` node that declares no hash at all is unaffected and still renders.** If yours stopped,
it declared a hash that does not match what the registry recorded.

The same default reaches every entry point: `<FuaranRenderer>`, a hand-built `RenderContext`, and the
standalone bundle's `mount` options. A `Mount` guest inherits its host's floor.

## The fix — pick one

### 1. Fix the hash (preferred)

A mismatch means the tree and the registered renderer disagree about the component. Either the
renderer moved and the tree is stale — re-emit the tree, or re-derive its `contentHash` — or the tree
addresses a different component than you think; check the `moduleId` / `componentId` pair against
what you registered.

### 2. Name the permissive posture (the ramp, not the destination)

```tsx
<FuaranRenderer tree={tree} runtime={{ registry }} customHashFloor="AdvisoryWarning" />
```

or `customHashFloor: 'AdvisoryWarning'` on the context or the standalone `mount` options. That is the
pre-0.26.0 behaviour exactly: a mismatch warns and renders, with the warning intact. Nothing else
changes. A search for `customHashFloor="AdvisoryWarning"` / `customHashFloor: 'AdvisoryWarning'` now
enumerates every surface where the permissive posture is in force — which an unchanged default could
never have answered.

### 3. If you were already enforcing, re-read which floor you want

| You declared     | What changed                                                                            |
| ---------------- | --------------------------------------------------------------------------------------- |
| `'StrictReplay'` | Nothing. Every case behaves exactly as before.                                          |
| `'Enforced'`     | A mismatch is still refused. A node declaring **no** hash now renders (it was refused). |

`'Enforced'` governs the declared hash; `'StrictReplay'` additionally refuses a node whose tree
declared none. If you declared `'Enforced'` to close the declare-nothing route, **declare
`'StrictReplay'`** — the floor whose name was always the stronger claim. This is the one case where
the change relaxes rather than tightens, and it is the reference host's semantics: before it, the
same hash-less document rendered on one host and was refused on the other.

## Rollback

Pin `@fuaran-ui/renderer@0.25.0`. Nothing here changes the wire format: a tree decodes identically on
either version, and no corpus fixture moved.

## Verification

1. Build. Nothing fails to compile — the break is behavioural, not a signature change.
2. Run the app and read the `warn` channel. Every `FuaranCustomHashMismatch` line names a component
   whose registered renderer and declared hash disagree — real drift, whatever you decide about it.
3. Confirm the enforcement is real rather than assumed: point a tree at a deliberately wrong hash
   and check the node is refused. With `debug` on, `window.__fuaran.hatches()` reports the
   `custom-hash-floor-permissive` finding `closed` under the default and `open` only where a host
   named `'AdvisoryWarning'`.
