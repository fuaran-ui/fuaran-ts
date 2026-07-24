// ============================================================================
//  @fuaran-ui/ops — wire versioning + the forward/backward-compatibility
//  contract (WIRE_FORMAT.md §15).
//
//  A conformant TS port of `Fuaran.Core.Wire.Versioning` (the F# reference,
//  Fuaran-Core/src/Fuaran.Core.Wire/Wire.fs). A versioned wire lets an *older*
//  consumer meet a *newer* artifact and **detect → preserve → degrade** instead
//  of hard-crashing with UNKNOWN_DU_CASE / WRONG_NODE_KIND — while the
//  authoring/generation surface stays closed and exhaustive (no host can *emit*
//  an unknown kind). The split is load-bearing:
//    • the producer authors against a closed surface and stamps the artifact
//      with its profile (the `$profile` / `$payload` envelope);
//    • tolerance lives ONLY on the decode boundary of a consumer that is
//      `Behind` — the transport-only `Unknown` is reachable on decode and
//      un-constructible on encode (there is no authoring constructor for it).
//
//  Certified byte-for-byte against the workspace ../wire-format-fixtures/
//  corpus (the `envelope-round-trip` / `envelope-reject` fixture families) so
//  the envelope + tolerance rules are cross-host, not host-private.
// ============================================================================

import type { Node, Result } from '@fuaran-ui/schema';

import { decodeNode, type DecodeError, type DecodeErrorCode } from './decode.js';
import { encodeNode, renderAstCanonical } from './encode.js';
import { type JsonAst, parse } from './parse.js';

// ─── Profile id ──────────────────────────────────────────────────────────────

/**
 * A wire profile id — `<name>@<major>.<minor>` (e.g. `core@1.0`). `name` is the
 * capability namespace; `major` is the `/vN/` incompatibility boundary (a
 * removal/rename mints a new major — old consumers cannot interpret it); `minor`
 * is the additive capability counter (a new kind/case/field bumps the minor — an
 * older consumer tolerates it via must-ignore-but-preserve).
 */
export interface Profile {
  readonly name: string;
  readonly major: number;
  readonly minor: number;
}

/** The canonical string form: `<name>@<major>.<minor>`. */
export const renderProfile = (p: Profile): string => `${p.name}@${p.major}.${p.minor}`;

/** The base `core` profile — `core@1.0` (the current wire). */
export const coreV1: Profile = { name: 'core', major: 1, minor: 0 };

/**
 * Parse `<name>@<major>.<minor>`. Names a typed error on any malformed shape —
 * the same envelope discipline as the decoder (no exceptions escape). Mirrors
 * F# `Profile.tryParse`: split on the LAST `@`, require a `<major>.<minor>` of
 * two non-negative integers.
 */
export const tryParseProfile = (s: string): Result<Profile, string> => {
  const at = s.lastIndexOf('@');
  if (at <= 0 || at === s.length - 1) {
    return { ok: false, error: `malformed profile (expected '<name>@<major>.<minor>'): ${s}` };
  }
  const name = s.slice(0, at);
  const ver = s.slice(at + 1);
  const parts = ver.split('.');
  if (parts.length !== 2) {
    return { ok: false, error: `malformed profile version (expected '<major>.<minor>'): ${ver}` };
  }
  const parseNonNeg = (t: string): number | undefined => {
    // Match F# Int32.TryParse + `v >= 0`: a plain non-negative decimal integer.
    if (!/^\d+$/.test(t)) return undefined;
    const v = Number(t);
    return Number.isInteger(v) && v >= 0 ? v : undefined;
  };
  const major = parseNonNeg(parts[0]!);
  const minor = parseNonNeg(parts[1]!);
  if (major === undefined || minor === undefined) {
    return {
      ok: false,
      error: `malformed profile version (expected non-negative '<major>.<minor>'): ${ver}`,
    };
  }
  return { ok: true, value: { name, major, minor } };
};

// ─── Capability negotiation ──────────────────────────────────────────────────

/** The capability-negotiation outcome of a consumer reading an artifact's profile. */
export type Compatibility =
  /** Authored at-or-below the consumer's profile (same name + major) — decode fully. */
  | { readonly kind: 'Current' }
  /**
   * Authored *ahead* of the consumer (same name + major, higher minor) — the
   * consumer may meet kinds it does not understand; it must tolerate (preserve +
   * degrade), never crash.
   */
  | { readonly kind: 'Behind'; readonly authored: Profile }
  /**
   * A different namespace or a different major — an incompatible `/vN/` boundary
   * the consumer cannot interpret at all (hard-refuse, never silently mis-decode).
   */
  | { readonly kind: 'Foreign'; readonly authored: Profile };

/**
 * Negotiate a consumer's supported profile against an artifact's authored
 * profile. Minor-ahead is `Behind` (tolerable); a different name or major is
 * `Foreign` (refuse). Mirrors F# `Versioning.negotiate`.
 */
export const negotiate = (consumer: Profile, authored: Profile): Compatibility => {
  if (authored.name !== consumer.name || authored.major !== consumer.major) {
    return { kind: 'Foreign', authored };
  }
  if (authored.minor > consumer.minor) return { kind: 'Behind', authored };
  return { kind: 'Current' };
};

// ─── Envelope keys ───────────────────────────────────────────────────────────

/** The versioned-envelope payload key. `$`-prefixed so it sorts before data keys. */
export const PAYLOAD_KEY = '$payload';
/** The versioned-envelope profile key. */
export const PROFILE_KEY = '$profile';
/** The optional artifact-declares-its-required-profile key. */
export const REQUIRED_PROFILE_KEY = 'requiredProfile';

// ─── Versioning error surface ────────────────────────────────────────────────

/**
 * A versioning-layer failure. Extends the six canonical `DecodeErrorCode`s with
 * two envelope-specific codes, kept OUT of the core `DecodeErrorCode` set (the
 * six-code AI-recovery surface stays unpolluted — WIRE_FORMAT.md §6):
 *   - `FOREIGN_PROFILE` — negotiate returned `Foreign`; the artifact is refused.
 *   - `MALFORMED_PROFILE` — the `$profile` value is not a `<name>@<major>.<minor>`.
 */
export type EnvelopeErrorCode = DecodeErrorCode | 'FOREIGN_PROFILE' | 'MALFORMED_PROFILE';

export interface EnvelopeError {
  readonly code: EnvelopeErrorCode;
  readonly path: string;
  readonly message: string;
}

const envErr = (code: EnvelopeErrorCode, path: string, message: string): EnvelopeError => ({
  code,
  path,
  message,
});

// ─── Versioned envelope ──────────────────────────────────────────────────────

/**
 * A versioned wire envelope: the producer's authored `profile` + the artifact
 * `payload` (a `Node` / `TreeOp` as the verbatim parsed AST). `$profile` /
 * `$payload` sort before any lower-case data key under the canonical key order,
 * so an enveloped fixture is byte-stable. Mirrors F# `Versioning.Envelope`.
 */
export interface Envelope {
  readonly profile: Profile;
  readonly payload: JsonAst;
}

/** Render an envelope to canonical wire bytes. */
export const encodeEnvelope = (env: Envelope): string =>
  renderAstCanonical({
    kind: 'JObject',
    fields: new Map<string, JsonAst>([
      [PAYLOAD_KEY, env.payload],
      [PROFILE_KEY, { kind: 'JString', value: renderProfile(env.profile) }],
    ]),
  });

/**
 * Decode an envelope from an already-parsed AST — reads `$profile` (parsed) +
 * the verbatim `$payload`. A missing / non-string / malformed `$profile`, or a
 * missing `$payload`, is a structured `EnvelopeError`.
 */
export const decodeEnvelopeAst = (ast: JsonAst): Result<Envelope, EnvelopeError> => {
  if (ast.kind !== 'JObject') {
    return { ok: false, error: envErr('WRONG_TYPE', '$', 'envelope must be a JSON object') };
  }
  const profileJ = ast.fields.get(PROFILE_KEY);
  if (profileJ === undefined) {
    return {
      ok: false,
      error: envErr('MISSING_FIELD', `$.${PROFILE_KEY}`, `missing required field '${PROFILE_KEY}'`),
    };
  }
  if (profileJ.kind !== 'JString') {
    return {
      ok: false,
      error: envErr('WRONG_TYPE', `$.${PROFILE_KEY}`, `'${PROFILE_KEY}' must be a profile string`),
    };
  }
  const profile = tryParseProfile(profileJ.value);
  if (!profile.ok) {
    return { ok: false, error: envErr('MALFORMED_PROFILE', `$.${PROFILE_KEY}`, profile.error) };
  }
  const payload = ast.fields.get(PAYLOAD_KEY);
  if (payload === undefined) {
    return {
      ok: false,
      error: envErr('MISSING_FIELD', `$.${PAYLOAD_KEY}`, `missing required field '${PAYLOAD_KEY}'`),
    };
  }
  return { ok: true, value: { profile: profile.value, payload } };
};

/** Parse + decode an envelope from wire bytes. */
export const decodeEnvelope = (json: string): Result<Envelope, EnvelopeError> => {
  const parsed = parse(json);
  if (!parsed.ok) {
    return { ok: false, error: envErr('INVALID_JSON', '$', parsed.error.message) };
  }
  return decodeEnvelopeAst(parsed.value);
};

// ─── Transport-only Unknown + must-ignore-but-preserve ───────────────────────

/**
 * A kind the consumer does not understand, captured on the decode boundary.
 * **Transport-only**: reachable here and nowhere on the authoring/encode path —
 * no host can construct one to emit. `payload` is the *verbatim parsed AST*, so
 * re-rendering it reproduces the producer's bytes (must-ignore-but-preserve);
 * `requiredProfile` is the profile the artifact declared it needs (when a
 * well-formed one was present), so the consumer can name what it is missing in a
 * degraded placeholder. Mirrors F# `Versioning.UnknownKind`.
 */
export interface UnknownKind {
  readonly kind: string;
  readonly payload: JsonAst;
  readonly requiredProfile?: Profile;
}

/** The result of a tolerant decode: a fully-understood `T`, or a preserved `Unknown`. */
export type Decoded<T> =
  | { readonly known: true; readonly value: T }
  | { readonly known: false; readonly unknown: UnknownKind };

/**
 * Read an optional `requiredProfile` declaration off an artifact object (the
 * "artifact declares the profile it requires" shape). Malformed / absent /
 * non-string ⇒ `undefined` (the degrade placeholder simply carries no label —
 * mirrors F# `readRequiredProfile`).
 */
const readRequiredProfile = (ast: JsonAst): Profile | undefined => {
  if (ast.kind !== 'JObject') return undefined;
  const j = ast.fields.get(REQUIRED_PROFILE_KEY);
  if (j === undefined || j.kind !== 'JString') return undefined;
  const p = tryParseProfile(j.value);
  return p.ok ? p.value : undefined;
};

/**
 * Tolerantly decode one artifact AST. `tagOf` reads its discriminator; `isKnown`
 * reports whether this consumer understands that tag; `decodeKnown` decodes a
 * known one. An *unrecognised* tag is NOT an error — it becomes a transport-only
 * `Unknown` carrying the verbatim parsed `payload` and any declared
 * `requiredProfile`. A genuinely malformed object (no discriminator at all)
 * still fails via `tagOf`. Mirrors F# `Versioning.decodeTolerant`.
 */
export const decodeTolerant = <T>(
  tagOf: (ast: JsonAst) => Result<string, EnvelopeError>,
  isKnown: (tag: string) => boolean,
  decodeKnown: (ast: JsonAst) => Result<T, EnvelopeError>,
  ast: JsonAst,
): Result<Decoded<T>, EnvelopeError> => {
  const tag = tagOf(ast);
  if (!tag.ok) return tag;
  if (isKnown(tag.value)) {
    const d = decodeKnown(ast);
    return d.ok ? { ok: true, value: { known: true, value: d.value } } : d;
  }
  const unknown: UnknownKind = { kind: tag.value, payload: ast };
  const rp = readRequiredProfile(ast);
  return {
    ok: true,
    value: {
      known: false,
      unknown: rp === undefined ? unknown : { ...unknown, requiredProfile: rp },
    },
  };
};

/**
 * Re-encode a tolerant decode back to canonical wire bytes. The `Unknown` branch
 * re-renders its preserved `payload` **verbatim** (must-ignore-but-preserve);
 * the `Known` branch re-encodes through the real node encoder. Composed with the
 * canonical renderer's deterministic key order, an unknown artifact round-trips
 * byte-for-byte. Mirrors F# `Versioning.reencode` (specialised to `Node`).
 */
export const reencodeNode = (d: Decoded<Node<unknown>>): string =>
  d.known ? encodeNode(d.value) : renderAstCanonical(d.unknown.payload);

// ─── Node binding of the tolerant decoder ────────────────────────────────────

/** Read a node AST's `kind.$type` discriminator tag. */
const nodeTagOf = (ast: JsonAst): Result<string, EnvelopeError> => {
  if (ast.kind !== 'JObject') {
    return { ok: false, error: envErr('WRONG_TYPE', '$', 'node must be a JSON object') };
  }
  const kind = ast.fields.get('kind');
  if (kind === undefined) {
    return { ok: false, error: envErr('MISSING_FIELD', '$.kind', "missing required field 'kind'") };
  }
  if (kind.kind !== 'JObject') {
    return { ok: false, error: envErr('WRONG_TYPE', '$.kind', 'kind must be a JSON object') };
  }
  const disc = kind.fields.get('$type');
  if (disc === undefined) {
    return {
      ok: false,
      error: envErr('MISSING_FIELD', '$.kind.$type', "kind must carry a '$type' discriminator"),
    };
  }
  if (disc.kind !== 'JString') {
    return { ok: false, error: envErr('WRONG_TYPE', '$.kind.$type', '$type must be a string') };
  }
  return { ok: true, value: disc.value };
};

/**
 * Whether the real decoder knows how to route a node kind — probed against
 * `decodeNode` itself, so it is **zero-drift** with the decoder's kind set: an
 * unknown top-level kind fails with `WRONG_NODE_KIND` at `$.kind.$type`; a known
 * kind (even one missing required fields) fails with some *other* code, or
 * succeeds. This is the TS analogue of F# `isKnown` over `knownTags`, without a
 * parallel kind list to maintain.
 */
const isKnownNodeKind = (tag: string): boolean => {
  const probe = decodeNode(`{"id":"_probe_kind","kind":{"$type":${JSON.stringify(tag)}}}`);
  return probe.ok || probe.error.code !== 'WRONG_NODE_KIND';
};

/** Adapt the six-code `DecodeError` into the versioning error surface. */
const liftDecodeError = (e: DecodeError): EnvelopeError => ({
  code: e.code,
  path: e.path,
  message: e.message,
});

const decodeKnownNode = (ast: JsonAst): Result<Node<unknown>, EnvelopeError> => {
  const r = decodeNode(renderAstCanonical(ast));
  return r.ok ? r : { ok: false, error: liftDecodeError(r.error) };
};

/**
 * Tolerantly decode a bare (un-enveloped) `Node` wire form. A known kind decodes
 * normally; an unknown top-level kind becomes a transport-only `Unknown` whose
 * bytes round-trip verbatim through `reencodeNode` — a minor-ahead artifact no
 * longer throws `WRONG_NODE_KIND` / `UNKNOWN_DU_CASE`. A genuinely malformed
 * object (no `kind.$type`) still fails.
 */
export const decodeNodeTolerant = (json: string): Result<Decoded<Node<unknown>>, EnvelopeError> => {
  const parsed = parse(json);
  if (!parsed.ok) {
    return { ok: false, error: envErr('INVALID_JSON', '$', parsed.error.message) };
  }
  return decodeTolerant<Node<unknown>>(nodeTagOf, isKnownNodeKind, decodeKnownNode, parsed.value);
};

// ─── Whole-envelope negotiate → tolerate/refuse → re-encode ──────────────────

/**
 * The consumer entry point for reading a possibly-versioned `Node` artifact
 * safely. Decodes the `$profile` / `$payload` envelope, negotiates the authored
 * profile against `consumer`, and:
 *   - **Foreign** → refuses with `FOREIGN_PROFILE` (never silently mis-decodes);
 *   - **Current / Behind** → tolerantly decodes the payload (unknown kinds
 *     preserved) and returns the whole envelope re-encoded to canonical bytes.
 *
 * The re-encode is byte-identical to a canonical input (must-ignore-but-preserve
 * keeps an unknown-kind payload verbatim), which is exactly what the
 * `envelope-round-trip` corpus family asserts and the `envelope-reject` family
 * asserts the `FOREIGN_PROFILE` refusal for.
 */
export const negotiateEnvelope = (
  json: string,
  consumer: Profile = coreV1,
): Result<string, EnvelopeError> => {
  const env = decodeEnvelope(json);
  if (!env.ok) return env;

  const compat = negotiate(consumer, env.value.profile);
  if (compat.kind === 'Foreign') {
    return {
      ok: false,
      error: envErr(
        'FOREIGN_PROFILE',
        `$.${PROFILE_KEY}`,
        `authored profile ${renderProfile(env.value.profile)} is Foreign to consumer ${renderProfile(
          consumer,
        )} — refused (incompatible /vN/ boundary)`,
      ),
    };
  }

  const decoded = decodeTolerant<Node<unknown>>(
    nodeTagOf,
    isKnownNodeKind,
    decodeKnownNode,
    env.value.payload,
  );
  if (!decoded.ok) return decoded;

  const payloadBytes = reencodeNode(decoded.value);
  const payloadAst = parse(payloadBytes);
  // payloadBytes is canonical (produced by the encoder / verbatim preserve), so
  // it always re-parses; the guard keeps the types total.
  if (!payloadAst.ok) {
    return {
      ok: false,
      error: envErr('INVALID_JSON', `$.${PAYLOAD_KEY}`, payloadAst.error.message),
    };
  }
  return {
    ok: true,
    value: encodeEnvelope({ profile: env.value.profile, payload: payloadAst.value }),
  };
};
