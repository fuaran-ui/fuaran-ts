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

/**
 * Maximum length of a single decoded JSON string, in **Unicode code points**
 * (WIRE_FORMAT §21.6). A surrogate pair counts as ONE.
 *
 * The unit is the whole of this constant's content: the row said "characters",
 * which is not a unit, and measured across the hosts it was three — UTF-16 code
 * units here and on the F# host, code points on Python, UTF-8 bytes on Go. A
 * 600 000-character CJK string was therefore inside the limit on three hosts and
 * outside it on one, with every host believing it enforced the same number.
 * Code points are the only reading that is a property of the TEXT rather than of
 * a host's string representation or of the alphabet the author writes in, so
 * this host counts them — `s.length` is UTF-16 units and is NOT this bound.
 */
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

/**
 * Maximum size of a whole input document, in **UTF-8 bytes**
 * (WIRE_FORMAT §21.7).
 *
 * The five structural limits compose MULTIPLICATIVELY: 100 000 array elements
 * each carrying a maximal string satisfies every one of them and is a hundred
 * gigabytes. Each individual check refuses nothing, because each individual
 * check is satisfied, so nothing bounded the total until this bound.
 *
 * UTF-8 bytes rather than code points or `String.length`, and it is the one
 * limit whose unit differs from `MAX_STRING_LENGTH`'s: this bounds the CARRIAGE
 * — what an attacker sends and what the host allocates — and carriage is bytes.
 * Measuring it in UTF-16 units would under-count a CJK document threefold,
 * which is the direction that ADMITS rather than refuses.
 *
 * The figure is constrained from below by `MAX_NODES`: a document at exactly
 * 100 000 nodes is about 8 MB of small nodes, so an 8 MiB ceiling would refuse a
 * document §21.2 rule 1 requires every host to accept — silently lowering
 * `MAX_NODES` while leaving its stated value in the table.
 */
export const MAX_DOCUMENT_BYTES = 33554432;

/**
 * Maximum number of `ColExpr` nodes in ONE `Binding.Expr` expression
 * (WIRE_FORMAT §21.8, Phase 1534). Counted per expression, not per document: a
 * tree may carry many `Expr` bindings, each bounded here, with the whole still
 * bounded by `MAX_DOCUMENT_BYTES`. A breach is `LIMIT_EXCEEDED` at the path of
 * the `expr` member.
 *
 * ONE count and not a count plus a depth: depth <= node count for every
 * expression, so an expression 600 deep is already 600 nodes and already
 * refused; a second number would be one more figure to keep in step across the
 * hosts and would refuse nothing this one does not.
 *
 * Its SCOPE is `Binding.Expr` and nothing else. A `ColExpr` inside a
 * `Binding.Transform` pipeline is NOT bounded by it, and was not bounded before
 * it either — stated rather than left to be inferred, because a limit whose
 * scope is guessed at is worse than no limit.
 */
export const MAX_EXPR_NODES = 512;

/**
 * Maximum value of ONE `Skeleton` node's `rows` slot (WIRE_FORMAT §21.9,
 * Phase 1666). Counted per node, not per document: a tree may carry many
 * `Skeleton` nodes, each bounded here, with the whole still bounded by
 * `MAX_NODES` and `MAX_DOCUMENT_BYTES`. A breach is `LIMIT_EXCEEDED` at the
 * path of the `rows` member.
 *
 * It is the first bound in this file that a document breaches with four digits
 * rather than with bulk, and §21.8's argument applies here more sharply because
 * it is not even an evaluation — the rows are simply not present in the input.
 * A server-side renderer emits one row of markup per count, so
 * `{"$type":"Skeleton","rows":100000000}` is a document well inside every other
 * limit (a handful of bytes, one node, three JSON levels) that names a hundred
 * million rendered rows. Every structural limit is satisfied, and each is
 * satisfied because none of them is looking at the value.
 *
 * §7.1 decides FIRST, and the ORDER is what keeps the two rules apart. §7.1
 * governs what a typed integer slot can HOLD, and `2147483647` is finite,
 * fraction-free and inside signed 32-bit, so §7.1 admits it; this bound then
 * refuses it for the work it names. So a non-integer stays `WRONG_TYPE` and a
 * 32-bit-valid value past the bound is `LIMIT_EXCEEDED` — never the reverse.
 * Collapsing the two into a narrower integer read would also refuse the
 * at-the-bound document §21.2 rule 1 obliges every host to accept.
 *
 * An UPPER bound only. A negative `rows` is not a resource breach — nothing
 * expands — and reporting one as `LIMIT_EXCEEDED` would be the actively-wrong
 * diagnosis rule 2 forbids. It is an authoring defect and belongs to the
 * pre-emit validator family (`FUARAN152`), which this package does not
 * implement.
 */
export const MAX_SKELETON_ROWS = 10000;
