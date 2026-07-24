// @fuaran-ui/validator — build-time validator for TypeScript-authored Fuaran
// UI trees. Programmatic surface (the CLI lives in `cli.ts` → `fuaran-validate`).
//
// Canonical import:
//   import { validateProject, validateSources } from '@fuaran-ui/validator';
//
// `validateSources` validates in-memory { fileName, source } pairs (editor
// plugins, build-pipeline integration, tests); `validateProject` reads files
// from disk + discovers the manifest. Both return a `RunResult` carrying the
// findings; the caller decides exit-code / reporting policy.

export type { Severity, Location, Finding, FindingJson } from './findings.js';
export {
  create,
  withRecovery,
  isError,
  renderFindingJson,
  renderFindingPlain,
} from './findings.js';
export type { Manifest } from './manifest.js';
export { emptyManifest, parseManifest, discoverManifest, loadManifest } from './manifest.js';
export type {
  RunResult,
  SourceFile,
  ValidateSourcesOptions,
  ValidateProjectOptions,
} from './api.js';
export { validateSources, validateProject } from './api.js';
export type {
  WalkResult,
  FuaranCtorCall,
  TabsDetail,
  QueryRef,
  DispatchRef,
  ExtraAttrCall,
  CurrencyCall,
} from './walker.js';
export { walkSource, mergeWalks } from './walker.js';
