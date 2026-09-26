// ============================================================================
//  @fuaran-ui/ui/function — the signature-searchable function registry.
//
//  The registry is a Core twin (a port of `Fuaran.Core.FunctionRegistry`), so
//  since Phase 1861 its implementation lives behind the workspace-internal
//  core-twins boundary. This module re-exports it name for name, so the
//  published surface of @fuaran-ui/ui is unchanged; the build bundles the
//  implementation into this package's dist.
// ============================================================================

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
} from '@fuaran-ui/core-twins';
