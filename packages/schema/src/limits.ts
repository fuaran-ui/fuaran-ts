// ============================================================================
//  Decode-side resource limits for untrusted wire input (WIRE_FORMAT.md §21).
//
//  WHY THIS EXISTS. The published safety claim is that decoding is *total* — a
//  malformed or hostile input yields a structured, typed error, never a throw.
//  That claim held on SEMANTICS (every wrong-shaped field is a `DecodeError`)
//  and was false on SHAPE: the hand-rolled parser's `parseValue` /
//  `parseObjectValue` / `parseArrayValue` are mutually recursive with no
//  counter, and neither they nor `decodeNode` bounded the walk. A payload of
//  `[[[[[…` — two bytes per level — drives the engine off the end of its stack
//  and throws a `RangeError`, which is not part of the declared `Result`
//  contract and escapes the decoder as a throw. Any host decoding untrusted
//  input therefore had a one-request remote kill.
//
//  These are this host's expression of the normative limits in §21.1. They are
//  PROTOCOL limits, not implementation details: a conformant host MUST refuse a
//  payload beyond them with a typed `LIMIT_EXCEEDED` error rather than a throw,
//  and MUST accept one within them. Changing a value here is a protocol change
//  — it moves in `WIRE_FORMAT.md` §21 and across every host, never here alone.
//
//  A note on the two depth numbers, because collapsing them is the tempting
//  mistake. They are not derivable from each other in either direction: one
//  tree level costs several JSON levels (a `Box` costs three — the node object,
//  its `children` array, the child object), and a rule-12 structured payload
//  nests freely *within* one node and consumes no node depth at all. A host
//  must never report a node-depth breach as a syntax-depth breach, because that
//  diagnosis sends the author to repair the wrong thing.
//
//  §21.4 records how MAX_NODE_DEPTH was derived on the reference host — by
//  bisecting each walk's true overflow depth, with the binding constraint being
//  the server-side renderer. The figure is not re-derived per host: it is a
//  number in the format. A host that measures a TIGHTER budget on some walk of
//  its own bounds that walk under §21.2 rule 5 rather than proposing a smaller
//  wire limit.
// ============================================================================

/**
 * Maximum NODE nesting depth of a wire tree (the root is depth 1). Bounds the
 * structural decoder, and — per §21.2 rule 5 — every later walk over a decoded
 * tree. The same figure bounds `TreeOp.Batch` nesting in the op decoder: a
 * different axis, counted separately, held to the same ceiling.
 */
export const MAX_NODE_DEPTH = 24;

/**
 * Maximum SYNTACTIC JSON nesting depth accepted by the parser (the outermost
 * value is depth 1). Every `{` and `[` counts, whether it carries a node, a
 * spec, or a rule-12 payload.
 */
export const MAX_JSON_DEPTH = 256;

/** Maximum length in characters of a single decoded JSON string. */
export const MAX_STRING_LENGTH = 1048576;

/**
 * Maximum number of elements in a single decoded JSON array, and of members in
 * a single decoded JSON object.
 */
export const MAX_ARRAY_LENGTH = 100000;

/**
 * Maximum total node count of one document, summed across the whole tree.
 *
 * Needed even once depth is bounded, because depth / string / array limits
 * together still admit a document that is hostile by being WIDE — 24 levels of
 * 100 000 siblings is within every other limit. Its cost is linear in the
 * input, but the constant is not: a decoded tree is far larger in memory than
 * the bytes that produced it.
 */
export const MAX_NODES = 100000;
