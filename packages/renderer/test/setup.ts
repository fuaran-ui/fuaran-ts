// Phase 2434 — `@fuaran-ui/charts` is an optional peer that a charting host
// registers once, before the first render. The suites here chart, so they do
// what such a host does. `chartsAbsent.test` clears it to prove the fallback.
import * as charts from '@fuaran-ui/charts';
import { registerCharts } from '../src/chartLowering.js';

registerCharts(charts);
