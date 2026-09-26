// ============================================================================
//  @fuaran-ui/ops — the native-JS columnar dataframe evaluator.
//
//  The evaluator (with list-parameter substitution) is a Core twin — a port of
//  the `Fuaran.Core.DataFrame` reference evaluator — so since Phase 1861 its
//  implementation lives behind the workspace-internal core-twins boundary.
//  This module re-exports it name for name, so the published surface of
//  @fuaran-ui/ops is unchanged; the build bundles the implementation into this
//  package's dist.
// ============================================================================

export {
  cellString,
  evalErrorString,
  evalPipeline,
  evalPipelineInEnv,
  evalPipelineWith,
  evalPipelineWithInEnv,
  evalSource,
  noResolve,
  pipelineParams,
  stepParams,
  substituteListParams,
  type EvalEnv,
  type SourceResolver,
} from '@fuaran-ui/core-twins';
