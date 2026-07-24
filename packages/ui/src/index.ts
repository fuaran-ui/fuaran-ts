// @fuaran-ui/ui — smart constructors + pre-emit validation for the Fuaran UI
// language contract.
//
// Canonical import:
//   import { fuaran, binding, action, node, preEmitValidate } from '@fuaran-ui/ui';
//
// Re-exports the full @fuaran-ui/schema surface so a consumer can pull the
// types (`type Node`, `type NodeId`, …) and the smart-ctor surface from one
// entry point.

export * from '@fuaran-ui/schema';
export * from './smartCtors.js';
export * from './preEmitValidate.js';
export * from './compute.js';
export * from './capability.js';
export * from './function.js';
