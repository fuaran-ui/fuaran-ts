// @fuaran-ui/schema — the TypeScript shape of the Fuaran §4b record contract.
//
// Canonical import:
//   import { type Node, type NodeKind, defaults, boundedInt } from '@fuaran-ui/schema';
//
// One conformant host of the canonical wire format (fuaran-dotnet/docs/WIRE_FORMAT.md);
// Phase 76 (@fuaran-ui/ops) verifies the codec built on these types against the
// workspace ../wire-format-fixtures/ corpus.

export * from './types.js';
export * from './compute.js';
export * from './result.js';
export * from './bounded.js';
export * from './defaults.js';
export * from './binding.js';
