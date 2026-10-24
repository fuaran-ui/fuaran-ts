# Migration — charts is an optional peer, and a host that charts registers it (Phase 2434)

`@fuaran-ui/renderer` 0.27.x / 0.28.x → 0.29.0 and `@fuaran-ui/renderer-server` 0.25.x → 0.26.0. Neither renderer
imports `@fuaran-ui/charts` any more, so a host that never charts no longer needs it installed. A host that does
chart now hands the charts module to the renderer once.

## Symptom

You upgraded and **your charts and sparklines stopped drawing**. Where a chart used to appear you now get the
chart placeholder (`fuaran-chart` holding `fuaran-chart-placeholder`), and where a sparkline used to appear you get
the em-dash element (`fuaran-sparkline fuaran-sparkline-empty`). Nothing throws and nothing is logged: this is the
documented fallback for a host that registered no chart lowering, and it is the same on the client and the server,
so a server-rendered page still hydrates.

If you never render a `Chart` or a `Sparkline`, nothing changes for you, and you can drop `@fuaran-ui/charts` from
your dependencies.

## The fix

Install `@fuaran-ui/charts` (it was already a peer) and register it once, before the first render:

```ts
import * as charts from '@fuaran-ui/charts';
import { registerCharts } from '@fuaran-ui/renderer';

registerCharts(charts);
```

Put it wherever your app does its other one-time setup: the client entry point, and, for server rendering, the
server's start-up. One registration serves both renderers, because `@fuaran-ui/renderer-server` reads it through
`@fuaran-ui/renderer`. It is one value per JavaScript realm, so a process that renders on the server registers once
for every request.

`registeredCharts()` reads the registration back, and `registerCharts(null)` clears it. The `ChartLowering` type
names the three functions the renderers call (`isLowered`, `lower`, `tryLowerSparkline`); the charts module
satisfies it.

**The standalone browser bundle needs nothing.** It inlines charts and registers it inside its own `mount`, so a
page that loads the bundle with a script tag is unchanged.

## Rollback

Pin `@fuaran-ui/renderer@0.28.0` and `@fuaran-ui/renderer-server@0.25.1`. Nothing here changes the wire format: a
tree decodes identically on either version, and no corpus fixture moved.

## Verification

1. Build. Nothing fails to compile: the change is behavioural, not a signature change, so a missed registration
   will not show up here.
2. Render a tree with a `Chart` and a `Sparkline`. Both must draw. A placeholder or an em-dash means the
   registration did not run before that render.
3. If you removed `@fuaran-ui/charts` because you never chart, install with your package manager's strict-peer
   mode and confirm no unmet peer is reported for either renderer.
