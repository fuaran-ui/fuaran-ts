// @fuaran-ui/conformance — third-party certification kit for the Fuaran UI
// wire format.
//
// Canonical import:
//   import { runConformance, formatReport } from '@fuaran-ui/conformance';
//   import type { ConformanceAdapter, ConformanceReport } from '@fuaran-ui/conformance';
//
// Plug a candidate implementation's codec into the `ConformanceAdapter` seam,
// run it over the bundled canonical corpus (fuaran-dotnet/docs/WIRE_FORMAT.md), and
// get a per-leg pass/fail report naming the corpus version it certified
// against. See CONFORMANCE.md (repo root) for the certification procedure.

export type {
  AdapterDecodeError,
  AdapterDecodeResult,
  ConformanceAdapter,
  ImplementationInfo,
} from './adapter.js';
export { loadCorpus, type Corpus, type CorpusFixture, type FixtureKind } from './corpus.js';
export {
  computeVerdict,
  formatReport,
  type ConformanceReport,
  type FixtureFailure,
  type LegId,
  type LegResult,
  type LegStatus,
  type Verdict,
} from './report.js';
export { runConformance, KIT_NAME, KIT_VERSION, type RunOptions } from './run.js';
