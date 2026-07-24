// @fuaran-ui/client — the typed contract for the Fuaran generation endpoint.
//
// These types mirror the generation endpoint's surface contract field-for-field:
// the turn request, the three-way turn result (produced / access-denied /
// turn-failed), the applied-op record, and the surface-version echo. They are
// the lockstep counterpart of the endpoint's published surface contract — a
// field added there is added here in the same change, and `wire.ts` pins how
// each maps onto the HTTP envelope.
//
// The endpoint itself is the Fuaran generation endpoint: a paid, stateless,
// bring-your-own-key (BYOK) HTTPS surface that takes a prompt (+ an optional
// current tree) and returns a new canonical wire-format tree. The endpoint URL
// and the paid access token are the commercial gate; this client is a thin,
// OSS-safe HTTPS + types layer over it.

/**
 * The generation-surface contract version this client is built against, kept in
 * lockstep with the endpoint's surface-version stamp.
 *
 * The client-facing request/response *shape* below is the additive corpus-flag
 * contract — `disableCorpusRead` / `contributeCorpus` plus the surface-version
 * echo on a produced result. Later minor surface bumps have only added
 * server-side usage fields that never cross the client boundary, so this shape
 * is stable across them; {@link FuaranClient.generate} echoes back whichever
 * version the live surface stamps (see {@link Produced.version}).
 */
export const SURFACE_VERSION = '1.2.0';

/** True when an echoed surface version shares this client's major version, i.e.
 *  the request/response shape is one this client understands. A differing major
 *  signals a breaking surface revision the client predates. */
export function isSurfaceVersionCompatible(echoed: string): boolean {
  const major = (v: string): string => (v.split('.')[0] ?? '').trim();
  return major(echoed) === major(SURFACE_VERSION) && major(echoed) !== '';
}

/** One op the turn applied to reach the produced tree. Mirrors the surface's
 *  applied-op record: a dedup `opId` and the canonical wire JSON of the op.
 *  Decode `opJson` with `@fuaran-ui/ops` `decodeOp` for a typed `TreeOp`. */
export interface AppliedOp {
  readonly opId: string;
  readonly opJson: string;
}

/** The loop stage at which a turn failed — distinguishes a rejected access
 *  token (no provider call made) from a provider/transport failure from an
 *  emission the endpoint refused to apply (the default-deny-by-shape gate). */
export type TurnStage = 'access-token' | 'provider' | 'parse' | 'apply';

/** A recoverable failure surfaced by a turn. `code` is a stable discriminant;
 *  `message` is model-facing — for the `apply` stage it carries the apply-error
 *  envelope so the caller's next prompt can re-emit against the hint. Never
 *  carries the BYOK key. Mirrors the surface's recoverable-error envelope. */
export interface RecoverableError {
  readonly stage: TurnStage;
  readonly code: string;
  readonly message: string;
}

/** The turn produced a new tree (HTTP 200). Carries the canonical wire JSON of
 *  the new tree, the ops applied this turn, and the echoed surface version. */
export interface Produced {
  readonly kind: 'produced';
  readonly treeJson: string;
  readonly ops: readonly AppliedOp[];
  readonly version: string;
}

/** The access token was missing / expired / invalid — rejected at the edge
 *  before any provider call, so the BYOK key was never used (HTTP 401). */
export interface AccessDenied {
  readonly kind: 'accessDenied';
  readonly reason: string;
}

/** The provider / parse / apply stage failed; carries the recoverable envelope
 *  (HTTP 422, or a synthesised envelope for an unexpected transport status). */
export interface TurnFailed {
  readonly kind: 'turnFailed';
  readonly error: RecoverableError;
}

/** The endpoint's reply, discriminated on `kind`. Mirrors the surface's
 *  three-case turn result; the HTTP status selects the case (see `wire.ts`). */
export type TurnResult = Produced | AccessDenied | TurnFailed;

/** Arguments to one {@link FuaranClient.generate} call. `prompt` is required;
 *  everything else is optional and falls back to the client's configuration.
 *
 *  Pass `currentTreeJson` (the canonical wire JSON of the tree the model is
 *  editing) to make the turn a *repair* — the token-saving ergonomic the whole
 *  model hinges on. Omit it for a fresh generation. The turn-loop helper
 *  ({@link FuaranSession}) carries it forward for you. */
export interface GenerateArgs {
  /** The authoring prompt. */
  readonly prompt: string;
  /** Canonical wire JSON of the tree to edit; omit for a fresh generation. */
  readonly currentTreeJson?: string;
  /** BYOK provider key for this call (overrides the client config). Memory-only
   *  — never bundle a key into shipped code; see the README. */
  readonly providerKey?: string;
  /** Paid access token for this call (overrides the client config). */
  readonly accessToken?: string;
  /** Opt OUT of corpus reads for this turn ("use without the learning
   *  corpus"). Absent / false keeps reads on. Privacy-preserving by default. */
  readonly disableCorpusRead?: boolean;
  /** Opt IN to contributing this turn (prompt + emitted tree) as a candidate
   *  for the next corpus version. Absent / false contributes nothing. */
  readonly contributeCorpus?: boolean;
}
