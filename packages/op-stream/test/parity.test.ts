// ============================================================================
//  Cross-implementation hash-chain parity.
//
//  Acceptance criterion (Phase 79): a TS-authored op sequence produces a hash
//  chain bit-identical to the F# canonical encoder's output on the same
//  sequence, verified against a fixture-corpus subset.
//
//  The parity argument has three legs, each checked here:
//   1. encodeOp is byte-identical to the F# CanonicalJson encoder. Asserted by
//      @fuaran-ui/ops's own corpus suite; re-asserted here for the op fixtures
//      this chain consumes (encode(decode(fixture)) === fixture bytes).
//   2. The hash pre-image is exactly Core's canonical `{seq,actor,op}` payload
//      with `op` = the Phase-406 StreamEntry envelope (op + ts + promptId +
//      result), hashed as `sha256(prev | payload)` — the formula shared verbatim
//      by both tiers (F# `StreamEntry.chainHash`).
//   3. SHA-256 over the UTF-8 payload is the FIPS 180-4 standard, identical in
//      node:crypto (the independent reference) and .NET
//      System.Security.Cryptography (the F# tier).
//
//  Together: computeHash over a corpus op === the F# HashChain.computeHash over
//  the same op. Two anchors: (a) an independent node:crypto recomputation of the
//  F# pre-image formula, and (b) the committed shared chain corpus
//  (wire-format-fixtures/chain/chain-corpus.json) that the F# host asserts too.
// ============================================================================

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { decodeOp, encodeOp } from '@fuaran-ui/ops';
import type { TreeOp } from '@fuaran-ui/ops';

import { computeHash, encodeActor, genesisPreviousHash } from '../src/index.js';
import type { Actor, OpRecord, OpResultEnvelope } from '../src/index.js';

// The actor folded into every fixture hash (Phase 320). The JSON literal is an
// INDEPENDENT reference (not produced by `encodeActor`) so the parity argument
// stays non-circular — the test below also asserts `encodeActor` reproduces it.
const testActor: Actor = { kind: 'human', id: 'u' };
const testActorJson = '{"kind":"human","id":"u"}';

const here = dirname(fileURLToPath(import.meta.url));
// packages/op-stream/test → workspace-root/wire-format-fixtures
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const readFixture = (relPath: string): string => readFileSync(join(corpusRoot, relPath), 'utf8');

interface ManifestFixture {
  readonly id: string;
  readonly kind: string;
  readonly decoder: 'node' | 'op';
  readonly inputFile: string;
  readonly expectedFile?: string;
}
interface Manifest {
  readonly fixtures: readonly ManifestFixture[];
}

const manifest = JSON.parse(readFixture('manifest.json')) as Manifest;
const opFixtures = manifest.fixtures.filter((f) => f.kind === 'op-round-trip');

const decodeFixtureOp = (f: ManifestFixture): TreeOp<unknown> => {
  const decoded = decodeOp(readFixture(f.inputFile));
  if (!decoded.ok) {
    throw new Error(
      `fixture ${f.id} failed to decode: ${decoded.error.code} @ ${decoded.error.path}`,
    );
  }
  return decoded.value;
};

// The independent reference (Phase 406/411 + chainVersion): re-derive the F#
// HashChain.computeHash pre-image — Core's canonical `{seq,actor,op}` payload
// (seq = Core's 0-based record index, i.e. the public 1-based sequence minus one)
// with `op` = the StreamEntry envelope (v=2 + op + ts + promptId=null +
// result=success) — and hash `prev | payload` with node:crypto (≡ .NET SHA-256).
// Built from literal JSON (not our encodeStreamEntry) so the parity argument stays
// non-circular; the leading `"v":2` mirrors F# StreamEntry.encode's format tag.
const referenceHash = (
  previousHash: string,
  op: TreeOp<unknown>,
  sequence: number,
  ts: number,
): string => {
  const entry = `{"v":2,"op":${encodeOp(op)},"ts":${String(ts)},"promptId":null,"result":{"kind":"success"}}`;
  const payload = `{"seq":${String(sequence - 1)},"actor":${testActorJson},"op":${entry}}`;
  return createHash('sha256')
    .update(previousHash + '|' + payload, 'utf8')
    .digest('hex');
};

describe('op fixtures re-encode byte-identically (leg 1 of the parity argument)', () => {
  it.each(opFixtures.map((f) => [f.id, f] as const))('%s', (_id, f) => {
    const expected = readFixture(f.expectedFile ?? f.inputFile);
    expect(encodeOp(decodeFixtureOp(f))).toBe(expected);
  });
});

describe('hash chain over the corpus op fixtures is bit-identical to the F# tier', () => {
  it('every record hash matches an independent reference recomputation', () => {
    // The encoder reproduces the independent actor-JSON literal (Phase 320).
    expect(encodeActor(testActor)).toBe(testActorJson);

    const decodedOps = opFixtures.map(decodeFixtureOp);
    const records: OpRecord<unknown>[] = [];
    let previousHash = genesisPreviousHash;

    decodedOps.forEach((op, i) => {
      const sequence = i + 1;
      const timestampUnixSeconds = 1700000000 + i;
      const hash = computeHash(
        previousHash,
        op,
        sequence,
        timestampUnixSeconds,
        testActor,
        undefined,
        {
          kind: 'Success',
        },
      );

      // The crux: our chain hash equals the F# payload formula (now with the
      // actor folded in) hashed by the independent node:crypto reference.
      expect(hash).toBe(referenceHash(previousHash, op, sequence, timestampUnixSeconds));

      records.push({
        streamId: 'corpus',
        sequence,
        previousHash,
        hash,
        op,
        actor: testActor,
        timestampUnixSeconds,
        resultEnvelope: { kind: 'Success' },
      });
      previousHash = hash;
    });

    expect(records.length).toBeGreaterThan(0);
    // Sanity: the first record links to genesis; each subsequent record links
    // to its predecessor's hash.
    expect(records[0]!.previousHash).toBe(genesisPreviousHash);
    for (let i = 1; i < records.length; i += 1) {
      expect(records[i]!.previousHash).toBe(records[i - 1]!.hash);
    }
  });
});

// ─── Phase 407 — the shared cross-host chain corpus ──────────────────────────
// wire-format-fixtures/chain/chain-corpus.json holds a chain generated by the
// CANONICAL F# HashChain.computeHash (envelope + Core payload + SHA-256), with
// mixed actor kinds + a promptId. The TS host must reproduce every hash byte-for-
// byte — the direct F#↔TS anchor (the F# side asserts the same file).

interface CorpusRecord {
  readonly opFixture: string;
  readonly sequence: number;
  readonly actor: Actor;
  readonly promptId: string | null;
  readonly result:
    | { readonly kind: 'success' }
    | { readonly kind: 'failure'; readonly code: string; readonly message: string };
  readonly timestampUnixSeconds: number;
  readonly previousHash: string;
  readonly hash: string;
}
interface ChainCorpus {
  readonly genesisPreviousHash: string;
  readonly records: readonly CorpusRecord[];
}

const toEnvelope = (r: CorpusRecord['result']): OpResultEnvelope =>
  r.kind === 'success'
    ? { kind: 'Success' }
    : { kind: 'Failure', code: r.code, message: r.message };

describe('shared chain corpus (Phase 407) — TS reproduces the canonical F# chain byte-for-byte', () => {
  const corpus = JSON.parse(readFixture('chain/chain-corpus.json')) as ChainCorpus;

  it('every record hash + previousHash matches the committed golden', () => {
    expect(corpus.records.length).toBeGreaterThan(0);
    let previousHash = corpus.genesisPreviousHash;

    for (const rec of corpus.records) {
      expect(rec.previousHash).toBe(previousHash);
      const decoded = decodeOp(readFixture(rec.opFixture));
      if (!decoded.ok) throw new Error(`corpus op ${rec.opFixture} failed to decode`);

      const hash = computeHash(
        previousHash,
        decoded.value,
        rec.sequence,
        rec.timestampUnixSeconds,
        rec.actor,
        rec.promptId ?? undefined,
        toEnvelope(rec.result),
      );
      expect(hash).toBe(rec.hash);
      previousHash = hash;
    }
  });
});
