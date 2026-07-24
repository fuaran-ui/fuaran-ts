# @fuaran-ui/style-observer

Browser-default computed-style observer for the [Fuaran UI](https://github.com/fuaran-ui/fuaran-ts) typed `Node` tree — the TypeScript port of the F# `Fuaran.UI.StyleObserver.{Abstractions,Default}` tier.

The semantic-state channel (fields / buttons / selections) is blind to **resolved-style** failures — body text that resolved below a legible contrast, text the same colour as the surface behind it, a toned accent indistinguishable from its container. This observer reads back a rendered Fuaran tree's _resolved computed styles_ via `getComputedStyle` + an effective-background composite walk, and derives a small fixed vocabulary of style flags as **small typed facts rather than a screenshot** — for a TS host's own dev tooling, or an orchestrator-feedback loop where one exists. The verdict is deterministic and reproducible (no vision model in the path), so it can gate a CI pipeline. The flag + observation JSON shape is **byte-identical to the F# tier** for the same value.

## Install

```sh
npm install @fuaran-ui/style-observer
```

`react` is an **optional** peer dependency — needed only for the `useFuaranStyleObserver` hook; the observer + flag core have no React dependency.

## The flags

The observer derives the **manifest-free** tier — the legibility flags that need only resolved colours and WCAG contrast:

| Flag                       | Fires when                                                                                                              |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `ContrastBelowAA` (ratio)  | Composited foreground/background contrast is below the WCAG AA floor (default 4.5) but still faintly visible.           |
| `InvisibleText` (ratio)    | Contrast at/near 1.0 — text ≈ the surface behind it. The severe subset; fires _instead of_ `ContrastBelowAA`.           |
| `AccentIndistinct` (ratio) | A toned element's accent surface contrasts its container below the UI-component floor (default 3.0) — the tone is mute. |

The `StyleFlag` union also carries the four **manifest-aware** cases (`TokenResolutionFailed`, `OffPaletteColour`, `UsageBudgetExceeded`, `ContrastBelowDeclaredFloor`) for byte-shape parity with the F# wire surface. These require a declared theme-manifest contract and are **not derived** in the TypeScript tier yet; they round-trip through `encodeStyleFlag` but the observer never emits them.

## Usage

### React — wire into a rendered tree

```tsx
import { useFuaranStyleObserver } from '@fuaran-ui/style-observer';
import { FuaranRenderer } from '@fuaran-ui/renderer';

function View({ tree }) {
  const ref = useFuaranStyleObserver<HTMLDivElement>({
    onFlag: (nodeId, flag) => console.warn(`${nodeId}: ${flag.kind}`),
  });
  return (
    <div ref={ref}>
      <FuaranRenderer tree={tree} />
    </div>
  );
}
```

The hook attaches a `BrowserStyleObserver` to the subtree under `ref`, self-discovering the rendered nodes via the `data-fuaran-node-id` attribute the renderer emits, and re-deriving a node's flags when its `class` / inline `style` / `data-fuaran-tone` mutate (e.g. a theme toggle). (This is the boundary-respecting analogue of an `onStyleFlag` prop on `<FuaranRenderer>`: the peer-dependency direction is `style-observer → renderer`, so the wire-in lives here as a hook, mirroring the F# tier's self-discovery design.)

### Without React — drive the observer directly

```ts
import { BrowserStyleObserver, InMemoryStyleObserver, white } from '@fuaran-ui/style-observer';

// Live DOM:
const observer = new BrowserStyleObserver();
const unsubscribe = observer.subscribe((nodeId, obs) => console.log(nodeId, obs.flags));

// Headless (tests, non-browser hosts):
const headless = new InMemoryStyleObserver();
headless.registerFixture('card-1', {
  foreground: white,
  backgroundLayers: [white],
  fontFamily: undefined,
  emittedTone: undefined,
});
headless.observe('card-1'); // → flags include { kind: 'InvisibleText', ratio: 1 }
```

The pure `deriveStyleFlags(options, input)` + per-flag predicates + the compositing / WCAG helpers (`composite`, `effectiveBackground`, `contrastRatio`) are exported for direct use, and `BrowserStyleObserver`'s browser-API access is behind an injectable `deps` object (a stubbed computed-style snapshot + a fake `MutationObserver`) for headless testing.

## Stability

The `StyleFlag` / `StyleObservation` / `Rgba` shapes + the JSON encode are declared stable in [`STABILITY.md`](../../STABILITY.md). The per-flag detection thresholds stay alpha (the WCAG floors are tunable via `StyleObserverOptions`, and the manifest-aware tier is not yet wired).

Apache-2.0.
