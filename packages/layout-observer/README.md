# @fuaran-ui/layout-observer

Browser-default layout-flag observer for the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) typed `Node` tree — the TypeScript port of the F# `Fuaran.UI.LayoutObserver.{Abstractions,Default}` tier.

The semantic-state channel (fields / buttons / selections) is blind to **layout** failures — a stack squeezed flat by an oversized sibling, a child clipped by an ancestor's `overflow: hidden`, a flex item collapsed to zero. This observer watches a rendered Fuaran tree via `ResizeObserver` and derives a small fixed vocabulary of layout flags from raw geometry, for a TS host's own dev tooling (truncation / overflow / accessibility hints) — or an orchestrator-feedback loop where one exists. The flag JSON shape is **byte-identical to the F# tier** for the same value.

## Install

```sh
npm install @fuaran-ui/layout-observer
```

`react` is an **optional** peer dependency — needed only for the `useFuaranLayoutObserver` hook; the observer + flag core have no React dependency.

## The flags

| Flag                                      | Fires when                                                                           |
| ----------------------------------------- | ------------------------------------------------------------------------------------ |
| `OverflowHorizontal` / `OverflowVertical` | `scrollWidth/Height > clientWidth/Height` and the element clips.                     |
| `ZeroDimension` (axis)                    | An axis resolved to ≤ 0.5px.                                                         |
| `SqueezedToMin` (axis)                    | An axis is within 0.5px of its computed `min-width/height`.                          |
| `ChildClippedByAncestor`                  | The element's rect extends beyond a clipping ancestor.                               |
| `AspectRatioWildlyOff` (factor)           | The observed `w/h` ratio diverges from the expected by ≥ the threshold (default 3×). |

## Usage

### React — wire into a rendered tree

```tsx
import { useFuaranLayoutObserver } from '@fuaran-ui/layout-observer';
import { FuaranRenderer } from '@fuaran-ui/renderer';

function View({ tree }) {
  const ref = useFuaranLayoutObserver<HTMLDivElement>({
    onFlag: (nodeId, flag) => console.warn(`${nodeId}: ${flag.kind}`),
  });
  return (
    <div ref={ref}>
      <FuaranRenderer tree={tree} />
    </div>
  );
}
```

The hook attaches a `BrowserLayoutObserver` to the subtree under `ref`, self-discovering the rendered nodes via the `data-fuaran-node-id` attribute the renderer emits. (This is the boundary-respecting analogue of an `onLayoutFlag` prop on `<FuaranRenderer>`: the peer-dependency direction is `layout-observer → renderer`, so the wire-in lives here as a hook, mirroring the F# tier's self-discovery design.)

### Without React — drive the observer directly

```ts
import { BrowserLayoutObserver, InMemoryLayoutObserver } from '@fuaran-ui/layout-observer';

// Live DOM:
const observer = new BrowserLayoutObserver();
const unsubscribe = observer.subscribe((nodeId, obs) => console.log(nodeId, obs.flags));

// Headless (tests, non-browser hosts):
const headless = new InMemoryLayoutObserver();
headless.registerFixture('card-1', { width: 0, height: 50, elementRect: [0, 0, 0, 50] });
headless.observe('card-1'); // → flags include { kind: 'ZeroDimension', axis: 'width' }
```

The pure `deriveFlags(options, input)` + per-flag predicates are exported for direct use, and `BrowserLayoutObserver`'s browser-API access is behind an injectable `deps` object (a fake `ResizeObserver` + a stubbed geometry snapshot) for headless testing.

## Stability

The `LayoutFlag` shape + the flag JSON encode are declared stable in [`STABILITY.md`](../../STABILITY.md). The per-flag detection thresholds stay alpha (browsers' interpretation of "overflowing" varies subtly across `ResizeObserver` versions).

Apache-2.0.
