// ============================================================================
//  @fuaran-ui/conformance — the implementation-adapter seam.
//
//  A candidate host of the Fuaran UI wire format (fuaran-dotnet/docs/WIRE_FORMAT.md)
//  plugs its codec into the runner through this interface. Every hook is
//  optional: the runner derives which conformance legs are exercisable from
//  which hooks are present, and the report marks the rest `skipped` — so a
//  partial host (decode-only, node-only, …) gets an honest partial
//  certification rather than a blanket fail.
//
//  Values cross the seam as `unknown` on purpose. The runner never inspects a
//  decoded value — it only passes it back into the host's own encoder — so a
//  host in any language can certify through a thin JS bridge without taking a
//  dependency on any @fuaran-ui package.
// ============================================================================

/** The structured decode error a conformant decoder surfaces (WIRE_FORMAT.md §6). */
export interface AdapterDecodeError {
  /** One of the six canonical codes — e.g. `MISSING_FIELD`, `UNKNOWN_DU_CASE`. */
  readonly code: string;
  /** `$`-rooted dotted path to the offending position — e.g. `$.kind.source.$type`. */
  readonly path: string;
  /** Free-form diagnostic; not asserted by the runner. */
  readonly message?: string;
}

export type AdapterDecodeResult =
  | { readonly ok: true; readonly value: unknown }
  | { readonly ok: false; readonly error: AdapterDecodeError };

/**
 * The hooks a candidate implementation provides. Each takes / returns the
 * canonical-JSON wire text; decoded values are opaque to the runner.
 */
export interface ConformanceAdapter {
  /** Decode a `Node` wire form. Exercises the node-decode + node-reject legs. */
  readonly decodeNode?: (json: string) => AdapterDecodeResult;
  /** Encode a value previously returned by `decodeNode` to canonical JSON. */
  readonly encodeNode?: (value: unknown) => string;
  /** Decode a `TreeOp` wire form. Exercises the op-decode + op-reject legs. */
  readonly decodeOp?: (json: string) => AdapterDecodeResult;
  /** Encode a value previously returned by `decodeOp` to canonical JSON. */
  readonly encodeOp?: (value: unknown) => string;
  /**
   * Read a versioned `$profile` / `$payload` envelope (WIRE_FORMAT.md §15),
   * negotiate the authored profile against the host's OWN current profile
   * (`core@1.0`), and either:
   *   - refuse a `Foreign` profile — `{ ok: false, error: { code:
   *     'FOREIGN_PROFILE', path: '$.$profile', … } }`; or
   *   - tolerantly decode the payload (an unknown top-level kind is preserved
   *     verbatim, never crashed on) and return the whole envelope RE-ENCODED to
   *     canonical bytes as `value` (a string).
   * Exercises the envelope-round-trip + envelope-reject legs. A host that has
   * not implemented §15 omits this hook and those legs report `skipped`.
   */
  readonly negotiateEnvelope?: (json: string) => AdapterDecodeResult;
  /**
   * Decode an elicitation artefact (WIRE_FORMAT.md §18) with the named entry
   * point (`elicitation` ⇒ the envelope codec, `elicitation-outcome` ⇒ the
   * outcome codec) and return it RE-ENCODED to canonical bytes as `value` (a
   * string), or the structured §18.5 refusal. Exercises the
   * elicitation-round-trip + elicitation-reject legs. A host that has not
   * implemented §18 omits this hook and those legs report `skipped`.
   */
  readonly roundTripElicitation?: (
    decoder: 'elicitation' | 'elicitation-outcome',
    json: string,
  ) => AdapterDecodeResult;
  /**
   * Validate a `{"answer": …, "contract": …}` conformance document
   * (WIRE_FORMAT.md §18.4): `{ ok: true }` for a conforming answer, or the
   * structured refusal (`ANSWER_*` codes). Exercises the elicitation-answer
   * leg.
   */
  readonly validateAnswerDocument?: (json: string) => AdapterDecodeResult;
  /**
   * Decode a contract-card artefact (WIRE_FORMAT.md §25) with the named entry
   * point (`contract-card` ⇒ the single-card codec, `contract-card-bundle` ⇒ the
   * bundle codec) and return it RE-ENCODED to canonical bytes as `value` (a
   * string), or the structured §25.3 refusal.
   *
   * Exercises the contract-card legs, and those legs are **not mandatory** —
   * unlike every other family here. §25 adoption is a SEPARATE bar from wire
   * conformance (WIRE_FORMAT §11.0 records it in its own table): a host can be
   * byte-perfect on the whole node and op vocabulary and hold no card reader at
   * all, and reporting it non-conformant for that would be measuring the wrong
   * thing. A host that has not adopted omits this hook and the legs report
   * `skipped`.
   */
  readonly roundTripContractCard?: (
    decoder: 'contract-card' | 'contract-card-bundle',
    json: string,
  ) => AdapterDecodeResult;
  /**
   * Reserved. Apply a decoded `TreeOp` to a decoded `Node` tree. Corpus v1
   * ships no apply fixtures, so this hook is never invoked today; it is
   * declared so the adapter seam is already stable when apply fixtures land
   * in a future corpus version (forward-coupling rule, WIRE_FORMAT.md §11).
   */
  readonly applyOp?: (tree: unknown, op: unknown) => unknown;
}

/** Identifies the candidate implementation in the report. */
export interface ImplementationInfo {
  readonly name: string;
  readonly version?: string;
}
