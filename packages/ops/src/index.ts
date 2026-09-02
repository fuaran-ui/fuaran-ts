// @fuaran-ui/ops — canonical-JSON codec + tree-op apply engine for the Fuaran
// UI wire format.
//
// Canonical import:
//   import { encodeNode, decodeNode, encodeOp, decodeOp, apply } from '@fuaran-ui/ops';
//   import type { TreeOp, DecodeError } from '@fuaran-ui/ops';
//
// A conformant TypeScript host of the language-neutral wire-format contract in
// fuaran-dotnet/docs/WIRE_FORMAT.md, verified byte-for-byte against the workspace
// ../wire-format-fixtures/ corpus. Operates on the typed shapes from
// @fuaran-ui/schema (a peer dependency).

export { encodeNode, encodeOp } from './encode.js';
export { encodeDataSource, encodeCell, encodeColExpr, encodePipeline } from './encode.js';
export {
  evalPipeline,
  evalPipelineWith,
  evalPipelineInEnv,
  evalPipelineWithInEnv,
  evalSource,
  noResolve,
  cellString,
  evalErrorString,
  stepParams,
  pipelineParams,
  substituteListParams,
  type SourceResolver,
  type EvalEnv,
} from './dataframe.js';
export {
  decodeNode,
  decodeOp,
  coerce,
  liveValueToTable,
  type DecodeError,
  type DecodeErrorCode,
} from './decode.js';
export {
  apply,
  type ApplyError,
  type ApplyErrorCode,
  type ApplyResult,
  type OpApplyTelemetryRecord,
} from './apply.js';
export type { TreeOp } from './treeOp.js';
export {
  // Placement helpers — placed insert / move / nudge + the clone verbs.
  // Every helper emits ops built from the existing TreeOp vocabulary
  // (InsertChild / MoveNode / ReorderChildren / Batch): no new op case, no
  // wire-format change.
  canPlace,
  placeOp,
  moveOp,
  nudgeOp,
  duplicateOp,
  duplicateOpWith,
  pasteOp,
  pasteOpWith,
  derivedFreshIds,
  sequentialFreshIds,
  type Placement,
  type PlaceTarget,
  type PlaceError,
  type FreshIds,
} from './placement.js';
export { parse, field as jsonField, type JsonAst, type ParseError } from './parse.js';
export {
  encodeDagRecord,
  decodeDagRecord,
  type DagOpRecord,
  type DagResultEnvelope,
} from './dag.js';
export { merge3Way, type MergeResult, type MergeConflict } from './merge.js';
export { renderAstCanonical } from './encode.js';
export {
  // Wire versioning + forward-compat (WIRE_FORMAT.md §15).
  renderProfile,
  tryParseProfile,
  coreV1,
  negotiate,
  PAYLOAD_KEY,
  PROFILE_KEY,
  REQUIRED_PROFILE_KEY,
  encodeEnvelope,
  decodeEnvelope,
  decodeEnvelopeAst,
  decodeTolerant,
  reencodeNode,
  decodeNodeTolerant,
  negotiateEnvelope,
  type Profile,
  type Compatibility,
  type Envelope,
  type UnknownKind,
  type Decoded,
  type EnvelopeError,
  type EnvelopeErrorCode,
} from './versioning.js';
export {
  // Elicitation envelope — question-as-UI with a typed answer contract
  // (WIRE_FORMAT.md §18).
  ELICITATION_KEY,
  ELICITATION_VERSION,
  encodeElicitation,
  decodeElicitation,
  encodeElicitationOutcome,
  decodeElicitationOutcome,
  validateAnswer,
  validateAnswerAt,
  validateAnswerDocument,
  type AnswerSpace,
  type AnswerField,
  type AnswerContract,
  type AnswerValue,
  type Answer,
  type ElicitationEnvelope,
  type ElicitationOutcome,
  type ElicitationOutcomeEnvelope,
  type ElicitationError,
  type ElicitationErrorCode,
} from './elicitation.js';

// Phase 1075 — the `Binding.State` seeding pass (the shared-data-source
// charter's O1). Both renderers lay a tree's declared defaults under the
// host's own sources through `withStateSeeds`.
export { collectStateSeeds, withStateSeeds, HOST_RESERVED_PREFIX } from './seeds.js';
