// ============================================================================
//  Teleport bundle decoder — a whole running app as one string.
//
//  A teleport bundle is a running Fuaran app — its tree, its `Binding.State`
//  values, an optional bounded op-history window, and the op-chain head hash —
//  serialised into one canonically-encoded, deflate-compressed, base64url
//  string small enough to ride a URL fragment or a QR code, and resume exactly
//  where it was on any device. This is the TypeScript decoder for the format
//  the F# tier (`Fuaran.UI.OpStream.Abstractions.Teleport`) produces:
//
//    "FT1." + base64url(rawDeflate(utf8(canonical JSON envelope)))
//
//    { "bundle":   "teleport@1",
//      "chainHead": "<64-hex op-chain head>",     // optional
//      "digest":    "<64-hex integrity digest>",  // required
//      "history":  [ <TreeOp>, … ],               // optional bounded window
//      "state":    { "<key>": <JVal>, … },        // optional
//      "tree":     <Node> }
//
//  The bundle is a genuine cross-host artefact: because this decoder recomputes
//  the integrity digest with the SAME canonical renderer (`renderAstCanonical`,
//  byte-verified against the shared wire-format corpus) and the SAME SHA-256
//  (`sha256Hex`) the chain uses, a bundle produced by one conformant host
//  verifies bit-for-bit on another. `digest` is SHA-256 over the canonical
//  envelope WITHOUT the digest field, so any tamper — a rewritten `chainHead`
//  included — fails verification as a typed error rather than resuming
//  something subtly wrong.
//
//  Closures cannot ride the wire by design: closure-bearing action slots encode
//  as the `"<closure>"` sentinel and decode to inert placeholders; only
//  wire-survivable actions are live after a resume, and a host still runs every
//  dispatch through its own gate exactly as for any decoded tree.
// ============================================================================

import { sha256Hex } from './hashChain.js';
import {
  renderAstCanonical,
  parse,
  jsonField,
  decodeNode,
  type JsonAst,
  type DecodeError,
  type Node,
  type Result,
} from './ops.js';

/** The self-identifying string-format tag: Fuaran Teleport, format 1
 *  (raw-deflate + base64url). A future compression/framing change mints `FT2.`;
 *  the envelope's own `bundle` field versions the JSON shape. */
export const TELEPORT_FORMAT_PREFIX = 'FT1.';

/** The envelope version this decoder accepts. */
export const TELEPORT_VERSION = 'teleport@1';

const DIGEST_PREIMAGE_TAG = 'fuaran-teleport:v1|';

/** Decode-side resource limits for untrusted input. Defaults sized generously
 *  above every legitimate budget: 64 K encoded chars, 1 MB decoded envelope. */
export interface TeleportLimits {
  /** Reject the encoded string before any decompression work. */
  readonly maxEncodedChars: number;
  /** Cap the inflated envelope size (the deflate-bomb guard). */
  readonly maxDecodedBytes: number;
}

export const defaultTeleportLimits: TeleportLimits = {
  maxEncodedChars: 65536,
  maxDecodedBytes: 1048576,
};

/** A typed teleport decode failure — the recoverable-envelope discipline the
 *  wire codec uses throughout; never a throw. Discriminate on `code`. */
export type TeleportError =
  | { readonly code: 'Oversize'; readonly limit: number; readonly message: string }
  | { readonly code: 'InvalidFormat'; readonly message: string }
  | { readonly code: 'InvalidJson'; readonly message: string }
  | { readonly code: 'InvalidEnvelope'; readonly path: string; readonly message: string }
  | { readonly code: 'UnsupportedVersion'; readonly found: string }
  | { readonly code: 'DigestMismatch'; readonly recomputed: string; readonly carried: string }
  | { readonly code: 'TreeDecode'; readonly error: DecodeError };

/** The decoded, integrity-verified bundle. `tree` is the storage-erased wire
 *  shape (closures inert by design); `state` is the resumed `Binding.State`
 *  values as plain JSON; `history` is the raw op AST window (decode per-op with
 *  `@fuaran-ui/ops` `decodeOp` if needed). */
export interface DecodedTeleport {
  readonly tree: Node<unknown>;
  readonly state: Readonly<Record<string, unknown>>;
  readonly history: readonly JsonAst[];
  readonly chainHead: string | undefined;
  readonly digest: string;
}

const fail = (error: TeleportError): Result<never, TeleportError> => ({ ok: false, error });

// ─── base64url → bytes (RFC 4648 §5, no padding) ─────────────────────────────

const B64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
const B64URL_LOOKUP: ReadonlyMap<string, number> = new Map(
  [...B64URL_ALPHABET].map((c, i) => [c, i] as const),
);

/** Decode a base64url string to bytes, or `null` on any non-alphabet input.
 *  Dependency-free (no `atob`/`Buffer`) so it runs identically in Node + the
 *  browser and never depends on the ambient base64 *standard* alphabet. */
const base64UrlToBytes = (input: string): Uint8Array | null => {
  const out: number[] = [];
  let bits = 0;
  let acc = 0;

  for (const ch of input) {
    const v = B64URL_LOOKUP.get(ch);
    if (v === undefined) return null;
    acc = (acc << 6) | v;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out.push((acc >> bits) & 0xff);
    }
  }

  return Uint8Array.from(out);
};

// ─── raw DEFLATE inflate (RFC 1951, no zlib/gzip wrapper) ─────────────────────

/** Inflate a raw-DEFLATE byte stream using the platform's own decompressor —
 *  a genuinely independent implementation of the same standard the F# host's
 *  deflate wrote. `DecompressionStream` is standard in modern browsers and
 *  Node >= 18; `'deflate-raw'` matches the wrapper-free stream the codec emits. */
const rawInflate = async (bytes: Uint8Array): Promise<Uint8Array | null> => {
  try {
    const ds = new DecompressionStream('deflate-raw');
    // `bytes` is a plain ArrayBuffer-backed view; the cast placates the
    // stricter TS 5.6 `Uint8Array<ArrayBufferLike>` ≠ `BlobPart` typing without
    // a runtime copy.
    const stream = new Blob([bytes as unknown as BlobPart]).stream().pipeThrough(ds);
    const buf = await new Response(stream).arrayBuffer();
    return new Uint8Array(buf);
  } catch {
    return null;
  }
};

// ─── AST helpers ─────────────────────────────────────────────────────────────

const astToJs = (a: JsonAst): unknown => {
  switch (a.kind) {
    case 'JNull':
      return null;
    case 'JBool':
      return a.value;
    case 'JNumber':
      return a.value;
    case 'JString':
      return a.value;
    case 'JArray':
      return a.items.map(astToJs);
    case 'JObject': {
      const o: Record<string, unknown> = {};
      for (const [k, v] of a.fields) o[k] = astToJs(v);
      return o;
    }
  }
};

// ─── Decode ──────────────────────────────────────────────────────────────────

/** Decode, integrity-verify, and structurally decode a teleport string.
 *
 *  Pipeline: size gate → base64url → bounded raw-inflate → UTF-8 → canonical
 *  JSON parse → envelope shape + version → digest verification (any tamper,
 *  the chain head included, is `DigestMismatch`) → wire decode of the `tree`.
 *  Returns a typed `Result`; never throws on malformed input. */
export const decodeTeleport = async (
  encoded: string,
  limits: TeleportLimits = defaultTeleportLimits,
): Promise<Result<DecodedTeleport, TeleportError>> => {
  if (encoded.length > limits.maxEncodedChars) {
    return fail({
      code: 'Oversize',
      limit: limits.maxEncodedChars,
      message: `encoded input is ${encoded.length} chars (limit ${limits.maxEncodedChars})`,
    });
  }

  if (!encoded.startsWith(TELEPORT_FORMAT_PREFIX)) {
    return fail({
      code: 'InvalidFormat',
      message: "not a Fuaran teleport bundle (missing 'FT1.' prefix)",
    });
  }

  const compressed = base64UrlToBytes(encoded.slice(TELEPORT_FORMAT_PREFIX.length));
  if (compressed === null) {
    return fail({ code: 'InvalidFormat', message: 'payload is not valid base64url' });
  }

  const inflated = await rawInflate(compressed);
  if (inflated === null) {
    return fail({ code: 'InvalidFormat', message: 'malformed deflate stream' });
  }
  if (inflated.length > limits.maxDecodedBytes) {
    return fail({
      code: 'Oversize',
      limit: limits.maxDecodedBytes,
      message: `decoded envelope exceeds ${limits.maxDecodedBytes} bytes`,
    });
  }

  const envelopeText = new TextDecoder('utf-8', { fatal: false }).decode(inflated);

  const parsed = parse(envelopeText);
  if (!parsed.ok) {
    return fail({ code: 'InvalidJson', message: parsed.error.message });
  }
  if (parsed.value.kind !== 'JObject') {
    return fail({ code: 'InvalidEnvelope', path: '$', message: 'expected a JSON object envelope' });
  }
  const fields = parsed.value.fields;

  // bundle version
  const bundleAst = jsonField(fields, 'bundle');
  if (bundleAst === undefined || bundleAst.kind !== 'JString') {
    return fail({
      code: 'InvalidEnvelope',
      path: '$.bundle',
      message: 'missing required string field',
    });
  }
  if (bundleAst.value !== TELEPORT_VERSION) {
    return fail({ code: 'UnsupportedVersion', found: bundleAst.value });
  }

  // carried digest
  const digestAst = jsonField(fields, 'digest');
  if (digestAst === undefined || digestAst.kind !== 'JString') {
    return fail({
      code: 'InvalidEnvelope',
      path: '$.digest',
      message: 'missing required string field',
    });
  }
  const carried = digestAst.value;

  // Recompute the digest over the canonical envelope WITHOUT the digest field.
  // renderAstCanonical re-sorts keys ordinally, so the field order here is
  // irrelevant — the bytes match the F# `Canon.render(coreFields)` preimage.
  const coreFields = new Map<string, JsonAst>();
  for (const [k, v] of fields) {
    if (k !== 'digest') coreFields.set(k, v);
  }
  const preimage =
    DIGEST_PREIMAGE_TAG + renderAstCanonical({ kind: 'JObject', fields: coreFields });
  const recomputed = sha256Hex(preimage);
  if (recomputed !== carried) {
    return fail({ code: 'DigestMismatch', recomputed, carried });
  }

  // tree (required)
  const treeAst = jsonField(fields, 'tree');
  if (treeAst === undefined) {
    return fail({ code: 'InvalidEnvelope', path: '$.tree', message: 'missing required field' });
  }
  const treeResult = decodeNode(renderAstCanonical(treeAst));
  if (!treeResult.ok) {
    return fail({ code: 'TreeDecode', error: treeResult.error });
  }

  // optional state / history / chainHead
  const stateAst = jsonField(fields, 'state');
  const state =
    stateAst !== undefined && stateAst.kind === 'JObject'
      ? (astToJs(stateAst) as Record<string, unknown>)
      : {};

  const historyAst = jsonField(fields, 'history');
  const history = historyAst !== undefined && historyAst.kind === 'JArray' ? historyAst.items : [];

  const chainHeadAst = jsonField(fields, 'chainHead');
  const chainHead =
    chainHeadAst !== undefined && chainHeadAst.kind === 'JString' ? chainHeadAst.value : undefined;

  return {
    ok: true,
    value: { tree: treeResult.value, state, history, chainHead, digest: carried },
  };
};
