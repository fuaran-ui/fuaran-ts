// ============================================================================
//  The chart-lowering seam (Phase 2434)
//
//  `@fuaran-ui/charts` is an OPTIONAL peer of this package and of
//  `@fuaran-ui/renderer-server`. Neither entry point imports it: the host hands
//  the charts module to `registerCharts` once, before the first render, and
//  both renderers' `Chart` and `Sparkline` arms read it from here.
//
//  Why registration and not a dynamic `import()`: `renderToHtml` is
//  synchronous, so an awaited import would change its signature; and a bundler
//  resolves an `import('@fuaran-ui/charts')` literal at build time, so a
//  browser consumer without charts installed would fail to build. A guarded
//  `require` has the same bundler problem and does not exist in an ES module.
//  Registration is the one shape that keeps the render API unchanged and
//  leaves no charts reference in the built output.
//
//  With nothing registered, a lowerable `Chart` renders the same placeholder an
//  unlowered chart kind always has, and a `Sparkline` renders the em-dash
//  element, on both tiers, so server output and client hydration agree.
//
//  The imports below are type-only and are erased from the built JavaScript.
// ============================================================================

import type { isLowered, lower, tryLowerSparkline } from '@fuaran-ui/charts';

/** The three lowering functions the renderers call. The charts module satisfies it. */
export interface ChartLowering {
  readonly isLowered: typeof isLowered;
  readonly lower: typeof lower;
  readonly tryLowerSparkline: typeof tryLowerSparkline;
}

let registered: ChartLowering | null = null;

/**
 * Register the chart lowering both renderers use, before the first render:
 *
 * ```ts
 * import * as charts from '@fuaran-ui/charts';
 * import { registerCharts } from '@fuaran-ui/renderer';
 * registerCharts(charts);
 * ```
 *
 * `null` clears the registration. A tree rendered with nothing registered shows
 * the chart placeholder and the sparkline em-dash instead of a picture.
 */
export const registerCharts = (charts: ChartLowering | null): void => {
  registered = charts;
};

/** The registered chart lowering, or `null` when the host registered none. */
export const registeredCharts = (): ChartLowering | null => registered;
