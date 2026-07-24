// Internal barrel — the slice of the peer packages (@fuaran-ui/schema +
// @fuaran-ui/ops) this package builds on, in one import surface. Keeps the
// peer-dependency seam in a single file so the rest of the package imports
// from './ops.js' regardless of which peer owns a given type.

export type { Node, NodeId, Result } from '@fuaran-ui/schema';
export type { TreeOp, ApplyError, ApplyResult, JsonAst, DecodeError } from '@fuaran-ui/ops';
export { apply, encodeOp } from '@fuaran-ui/ops';
// The canonical-JSON re-renderer + parser + node decoder the teleport codec
// composes over (byte-parity with the F# tier is inherited from these).
export { renderAstCanonical, parse, jsonField, decodeNode } from '@fuaran-ui/ops';
