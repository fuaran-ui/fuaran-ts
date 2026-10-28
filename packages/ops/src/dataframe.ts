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
  // Phase 2006 — the exact decimal's order, for the renderers' grid sort.
  decimalCompare,
  // Phase 2205 — a column holds typed vectors: its builder and its readers (the `toCells` bridge).
  cellAt,
  columnCells,
  columnLength,
  columnOfCells,
  isPresentAt,
  type ColumnResult,
  // Phase 2207 — a schema entry's unit (the unit algebra's canonical text) and the schema
  // operations over field metadata: fingerprint, diff, patch and the compatibility verdict.
  canonicalUnit,
  unitRefusalText,
  type UnitRefusal,
  classifySchemaDelta,
  diffSchema,
  patchSchema,
  schemaFingerprint,
  type FieldChange,
  type SchemaCompat,
  type SchemaDelta,
  type SchemaError,
} from '@fuaran-ui/core-twins';
