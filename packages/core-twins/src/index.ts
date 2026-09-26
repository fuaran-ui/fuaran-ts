// ============================================================================
//  @fuaran-ui/core-twins — this host's twins of the Fuaran.Core reference
//  subsystems, behind one internal boundary (Phase 1861).
//
//  PRIVATE and unpublished. The published packages re-export these names from
//  the modules they always exported them from (@fuaran-ui/ops, @fuaran-ui/ui,
//  @fuaran-ui/op-stream) and bundle the implementation into their own dist, so
//  no public import path names this package.
//
//  THE BOUNDARY (held by test/boundary.test.ts, not by convention): nothing in
//  src/ imports from the host's domain packages. The one admitted edge is
//  `import type` of a pinned allowlist of @fuaran-ui/schema types — the type
//  declarations the twins range over — which is erased at build time. No
//  runtime value crosses the boundary inward.
//
//  It mirrors Fuaran.Core, the reference these twins certify against, so a
//  future per-language Core package is a copy of this directory (plus the
//  allowlisted type declarations), not an untangling.
// ============================================================================

export { formatFiniteDouble, num } from './canonFloat.js';

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
} from './dataframe.js';

export {
  capabilityDeterminismTag,
  createCapability,
  describeInvokeError,
  determinismTag,
  emptyRegistry,
  enumerate,
  fnv1a,
  invocationKey,
  register,
  registryOf,
  spaceValidate,
  toJsonSchema,
  tryFind,
  validateArgs,
  type CapabilityRegistry,
  type InvokeError,
} from './capability.js';

export {
  compose,
  emptyFunctionRegistry,
  findBySignature,
  functionRegistryOf,
  registerFunction,
  registrySignatureShape,
  spaceSubsumes,
  type ComposeResult,
  type ComposeStep,
  type FunctionEntry,
  type FunctionRegistry,
  type MatchMode,
  type RegisterError,
  type RegistryHoleKind,
  type RegistrySigEntry,
  type SignatureQuery,
} from './function.js';

export { actorId, encodeActor, humanActor, jsonString, type Actor } from './actor.js';
