// ============================================================================
//  Hash-chain primitive — SHA-256 over the canonical encoding.
//
//  Port of Fuaran.UI.OpStream.Abstractions.HashChain + Verify. The F# tier
//  scopes its SHA-256 to .NET (System.Security.Cryptography is not transpiled
//  by Fable); the TS tier has no such constraint, so this ships a small,
//  dependency-free FIPS 180-4 SHA-256 that runs identically in Node and the
//  browser. That keeps `computeHash` synchronous (matching the F# signature)
//  and avoids the async Web Crypto API, so the hash chain composes inside the
//  synchronous `replay` / `verifyChain` folds.
//
//  Canonical algorithm (Phase 320 folds the actor in LAST — attribution is
//  tamper-evident as part of the integrity chain):
//      hash[n] = SHA-256( previousHash[n]
//                         ++ encodeOp(op[n])
//                         ++ String(sequence[n])
//                         ++ String(timestampUnixSeconds[n])
//                         ++ encodeActor(actor[n]) )
//      hash[0]'s previousHash is genesisPreviousHash (sixty-four '0' chars).
//
//  Bit-identical to the F# chain because: (a) `encodeOp` is byte-identical to
//  the F# CanonicalJson encoder (verified against the wire-format-fixtures
//  corpus by @fuaran-ui/ops), (b) the payload concatenation + UTF-8 byte
//  encoding are standard, and (c) SHA-256 is a fixed standard (cross-checked
//  against node:crypto in the test suite). See test/hashChain.test.ts.
// ============================================================================

import { encodeOp } from './ops.js';
import type { TreeOp } from './ops.js';
import type { Actor, OpRecord, OpResultEnvelope, VerificationError } from './types.js';

/**
 * The chain FORMAT version, folded FIRST into the hash pre-image (the leading
 * `{"v":<n>,…}` of `encodeStreamEntry`). It makes the chain self-describing and
 * tamper-evident: `formatVersion()` lifts `v` from a record before verifying so
 * an unrecognised format is a clear error, not a cryptic hash break; and because
 * it is inside the pre-image a stream cannot be silently relabelled. Bump in
 * lock-step with F# `StreamEntry.chainFormatVersion`, the Python host, and the
 * `chain-corpus.json` golden whenever the pre-image / envelope / hash changes.
 * (v2 = the Phase-406/411 provenance envelope + int53 SHA-256; a tagless record
 * is treated as the pre-406 v1 format.)
 */
export const CHAIN_FORMAT_VERSION = 2;

/**
 * Canonical JSON string escaping — only `"` / `\` / control chars (control as
 * `\u00xx`), matching F# `CanonicalJson.appendRawString` / `StreamEntry` `jstr`
 * so every hashed pre-image is byte-identical across hosts.
 */
const jsonString = (s: string): string => {
  let out = '"';
  for (let i = 0; i < s.length; i += 1) {
    const c = s[i]!;
    const code = s.charCodeAt(i);
    if (c === '"') {
      out += '\\"';
    } else if (c === '\\') {
      out += '\\\\';
    } else if (code < 0x20) {
      out += '\\u' + code.toString(16).padStart(4, '0');
    } else {
      out += c;
    }
  }
  return out + '"';
};

/**
 * Canonical JSON encoding of the typed actor — folded into the op-record hash
 * (Phase 320). Field order is pinned (kind first, then case fields). MUST stay
 * byte-for-byte aligned with F# / Core `Actor.encode`.
 */
export const encodeActor = (a: Actor): string =>
  a.kind === 'human'
    ? `{"kind":"human","id":${jsonString(a.id)}}`
    : `{"kind":"agent","model":${jsonString(a.model)},"version":${jsonString(a.version)},"id":${jsonString(a.id)}}`;

/**
 * Canonical encoding of the apply outcome (Phase 406). Lowercase tag; a failure
 * carries its code + message. Byte-for-byte with F# `StreamEntry.encodeResult`.
 */
export const encodeResult = (r: OpResultEnvelope): string =>
  r.kind === 'Success'
    ? '{"kind":"success"}'
    : `{"kind":"failure","code":${jsonString(r.code)},"message":${jsonString(r.message)}}`;

/**
 * The Phase-406 provenance envelope — the opaque `op` payload the chain carries.
 * Field order — **v** / op / ts / promptId / result — is pinned; `v`
 * (`CHAIN_FORMAT_VERSION`) sorts first so a reader can lift it with a minimal
 * parse. `ts` is unix SECONDS; `promptId` is `null` when absent. Byte-for-byte
 * with F# `StreamEntry.encode`.
 */
export const encodeStreamEntry = <TMsg>(
  op: TreeOp<TMsg>,
  timestampUnixSeconds: number,
  promptId: string | undefined,
  resultEnvelope: OpResultEnvelope,
): string =>
  `{"v":${String(CHAIN_FORMAT_VERSION)},"op":${encodeOp(op)},"ts":${String(Math.trunc(timestampUnixSeconds))},"promptId":${
    promptId === undefined ? 'null' : jsonString(promptId)
  },"result":${encodeResult(resultEnvelope)}}`;

/**
 * Read the chain format version from a persisted / encoded envelope without
 * verifying it — so a host can reject an unrecognised format with a clear error
 * before hash verification (which would otherwise surface as a cryptic chain
 * break). `undefined` when no leading `v` is present (treated as the pre-406 v1
 * format). A minimal prefix scan, NOT a full JSON parse: the envelope carries
 * `promptId:null` (the wire model has no null) and a future envelope may be a
 * shape this host cannot fully parse. Byte-for-byte with F#
 * `StreamEntry.formatVersion`.
 */
export const formatVersion = (encodedEnvelope: string): number | undefined => {
  const prefix = '{"v":';
  if (!encodedEnvelope.startsWith(prefix)) return undefined;
  let digits = '';
  for (let i = prefix.length; i < encodedEnvelope.length; i += 1) {
    const c = encodedEnvelope[i]!;
    if (c >= '0' && c <= '9') digits += c;
    else break;
  }
  return digits.length > 0 ? Number.parseInt(digits, 10) : undefined;
};

/**
 * Sixty-four '0' characters — the `previousHash` of every stream's
 * `sequence === 1` record. Port of F# `HashChain.genesisPreviousHash`.
 */
export const genesisPreviousHash: string = '0'.repeat(64);

// ─── SHA-256 (FIPS 180-4), dependency-free + synchronous ─────────────────────

// First 32 bits of the fractional parts of the cube roots of the first 64
// primes (2..311).
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => ((x >>> n) | (x << (32 - n))) >>> 0;

/** SHA-256 of UTF-8(`payload`) → 64 lower-case hex characters. */
export const sha256Hex = (payload: string): string => {
  const message = new TextEncoder().encode(payload);
  const bitLength = message.length * 8;

  // Pad: append 0x80, then zeros, then the 64-bit big-endian bit length, so the
  // total is a multiple of 64 bytes.
  const withPadLength = message.length + 1;
  const blockCount = Math.ceil((withPadLength + 8) / 64);
  const padded = new Uint8Array(blockCount * 64);
  padded.set(message);
  padded[message.length] = 0x80;
  // 64-bit length: high 32 bits effectively zero for any realistic payload;
  // write the low 32 bits big-endian into the last 4 bytes.
  const dv = new DataView(padded.buffer);
  dv.setUint32(padded.length - 4, bitLength >>> 0, false);
  dv.setUint32(padded.length - 8, Math.floor(bitLength / 0x100000000) >>> 0, false);

  // Initial hash values: fractional parts of the square roots of the first 8
  // primes.
  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);

  for (let block = 0; block < blockCount; block += 1) {
    const base = block * 64;
    for (let t = 0; t < 16; t += 1) {
      w[t] = dv.getUint32(base + t * 4, false);
    }
    for (let t = 16; t < 64; t += 1) {
      const w15 = w[t - 15]!;
      const w2 = w[t - 2]!;
      const s0 = rotr(w15, 7) ^ rotr(w15, 18) ^ (w15 >>> 3);
      const s1 = rotr(w2, 17) ^ rotr(w2, 19) ^ (w2 >>> 10);
      w[t] = (w[t - 16]! + s0 + w[t - 7]! + s1) >>> 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t += 1) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[t]! + w[t]!) >>> 0;
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) >>> 0;

      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }

    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
    h5 = (h5 + f) >>> 0;
    h6 = (h6 + g) >>> 0;
    h7 = (h7 + h) >>> 0;
  }

  const hex = (n: number): string => (n >>> 0).toString(16).padStart(8, '0');
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
};

// ─── Hash-chain construction + verification ──────────────────────────────────

/**
 * Compute the hash for an op-record (Phase 406, seq basis aligned Phase 411).
 * The pre-image is Core's canonical delimited `{"seq":…,"actor":…,"op":…}`
 * payload with `op = encodeStreamEntry(...)` (op + ts + promptId + result),
 * hashed as `sha256(prev | payload)`. `sequence` is the record's public
 * **1-based** value; the payload folds **Core's 0-based record index**
 * (`sequence - 1`), so a mapped record chain verifies under Core's own
 * verifier with no translation beyond `seq = sequence - 1` (F14 resolved).
 * Identical algorithm on every host — verification re-derives this and
 * compares. Port of F# `HashChain.computeHash` / `StreamEntry.chainHash`.
 */
export const computeHash = <TMsg>(
  previousHash: string,
  op: TreeOp<TMsg>,
  sequence: number,
  timestampUnixSeconds: number,
  actor: Actor,
  promptId: string | undefined,
  resultEnvelope: OpResultEnvelope,
): string => {
  const payload = `{"seq":${String(sequence - 1)},"actor":${encodeActor(actor)},"op":${encodeStreamEntry(
    op,
    timestampUnixSeconds,
    promptId,
    resultEnvelope,
  )}}`;
  return sha256Hex(previousHash + '|' + payload);
};

/**
 * Walk `records` in order, asserting (a) the `previousHash` chain links and
 * (b) each `hash` recomputes to the stored value. Returns the first violation,
 * or `undefined` on a clean chain. Port of F# `Verify.chain`.
 */
export const verifyChain = <TMsg>(
  records: readonly OpRecord<TMsg>[],
): VerificationError | undefined => {
  let previousHash = genesisPreviousHash;
  let expectedSequence = 1;

  for (const record of records) {
    if (record.sequence !== expectedSequence) {
      return { kind: 'OutOfOrder', expectedSequence, actualSequence: record.sequence };
    }
    if (record.previousHash !== previousHash) {
      return {
        kind: 'PreviousHashMismatch',
        sequence: record.sequence,
        expected: previousHash,
        actual: record.previousHash,
      };
    }
    const recomputed = computeHash(
      record.previousHash,
      record.op,
      record.sequence,
      record.timestampUnixSeconds,
      record.actor,
      record.promptId,
      record.resultEnvelope,
    );
    if (recomputed !== record.hash) {
      return {
        kind: 'HashMismatch',
        sequence: record.sequence,
        expected: recomputed,
        actual: record.hash,
      };
    }
    previousHash = record.hash;
    expectedSequence += 1;
  }

  return undefined;
};
