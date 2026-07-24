// ============================================================================
//  @fuaran-ui/op-stream — the durable op-trace type contract.
//
//  Shape-for-shape port of Fuaran.UI.OpStream.Abstractions
//  (OpRecord / Checkpoint / IOpStreamSink / error DUs). One stream's worth of
//  applied TreeOps is an append-only, hash-chained sequence of OpRecords; the
//  hash chain (hashChain.ts) makes "what did the agent do?" and "was the stream
//  tampered with?" both answerable from the record sequence alone (FGP 5 — the
//  op stream is the source of truth).
//
//  PORTING CONVENTIONS (see Phase 75 of the workspace roadmap):
//   - F# discriminated unions become TS tagged unions discriminated by a
//     `kind: '<CaseName>'` literal (the F# case name verbatim).
//   - F# records become readonly object types.
//   - F# `option` becomes an optional property; an ABSENT key is `None`
//     (`undefined`, never `null`), matching the schema-tier convention.
//   - F# `Async<'T>` becomes `Promise<T>` — the sink contract is async so a
//     future genuinely-async sink (IndexedDB, fetch-backed) implements the same
//     interface; the in-memory sink resolves synchronously-computed values.
// ============================================================================

import type { ApplyError, Node, TreeOp } from './ops.js';

/**
 * Outcome envelope captured at `sink.append` time. v1 only records successful
 * applies — the apply-engine integration appends AFTER the `Ok` branch.
 * `Failure` is reserved for the future apply-failure-also-recorded variant so
 * callers don't grow it in a later breaking change. Port of F#
 * `OpResultEnvelope`.
 */
export type OpResultEnvelope =
  | { readonly kind: 'Success' }
  | { readonly kind: 'Failure'; readonly code: string; readonly message: string };

/**
 * Who authored an op (Phase 320 — typed attested provenance). The Human/Agent
 * distinction is the load-bearing AI-accountability fact; `model`/`version`
 * doubles as corpus-quality metadata. Port of F# `Fuaran.UI.OpStream.Abstractions.Actor`
 * (and the `Fuaran.Core.OpStream.Actor` contract) — the canonical encoding
 * (`encodeActor`, hashChain.ts) is folded into the op-record hash, so the
 * cross-host hashed pre-image is byte-identical.
 */
export type Actor =
  | { readonly kind: 'human'; readonly id: string }
  | {
      readonly kind: 'agent';
      readonly model: string;
      readonly version: string;
      readonly id: string;
    };

/** The stable attribution id — the user id (human) or the agent id (agent). */
export const actorId = (a: Actor): string => a.id;

/** Lift a pre-320 bare-string actor to the typed `human` case. */
export const humanActor = (id: string): Actor => ({ kind: 'human', id });

/**
 * One stream-position's worth of apply trace. Append-only — sinks reject
 * duplicate `(streamId, sequence)` pairs as structural defects. Sequences begin
 * at 1; `previousHash` of the `sequence === 1` record is
 * `genesisPreviousHash`. Port of F# `OpRecord<'Msg>`.
 */
export interface OpRecord<TMsg> {
  readonly streamId: string;
  readonly sequence: number;
  readonly previousHash: string;
  readonly hash: string;
  readonly op: TreeOp<TMsg>;
  /** Conversation/prompt correlation, when the host threads one. */
  readonly promptId?: string;
  /** Phase 320 — replaces the pre-320 bare `userId`; folded into the hash. */
  readonly actor: Actor;
  /** Unix-epoch *seconds* (the value the hash chain consumes), UTC. */
  readonly timestampUnixSeconds: number;
  readonly resultEnvelope: OpResultEnvelope;
}

/**
 * A materialised snapshot at one op-index — replay can resume from the nearest
 * checkpoint ≤ target rather than from genesis. `previousChainHead` is the
 * chain head AT this op-index (equal to `OpRecord(sequence).hash`, or
 * `genesisPreviousHash` for a sequence-0 checkpoint over an initial tree);
 * `snapshotHash` is `sha256Hex(encodeNode(snapshot))`. Port of F#
 * `Checkpoint<'Msg>`.
 */
export interface Checkpoint<TMsg> {
  readonly streamId: string;
  readonly sequence: number;
  readonly previousChainHead: string;
  readonly snapshotHash: string;
  readonly snapshot: Node<TMsg>;
  readonly timestampUnixSeconds: number;
}

/**
 * The durable sink contract — port of F# `IOpStreamSink<'Msg>`. All methods are
 * `Promise`-returning; the in-memory sink resolves synchronously-computed
 * values, a future I/O-backed sink (IndexedDB, fetch) implements them
 * genuinely asynchronously. Sinks reject duplicate `(streamId, sequence)` pairs
 * as structural defects — query `latestSequence` before assigning a sequence.
 */
export interface IOpStreamSink<TMsg> {
  /** Append `record`; rejects on duplicate `(streamId, sequence)`. */
  append(record: OpRecord<TMsg>): Promise<void>;
  /**
   * Records for `streamId` with `sequence` in `[fromSequence, toSequence]`
   * (inclusive), in ascending sequence order. Empty array if none in range.
   */
  replay(streamId: string, fromSequence: number, toSequence: number): Promise<OpRecord<TMsg>[]>;
  /** Highest sequence observed in `streamId`; `0` if the stream is empty. */
  latestSequence(streamId: string): Promise<number>;
  /** Distinct stream ids the sink holds records for. Order unspecified. */
  streams(): Promise<string[]>;
}

/**
 * Checkpoint-aware extension of `IOpStreamSink` — port of F#
 * `IOpStreamCheckpointSink<'Msg>`. The in-memory sink implements this in
 * addition to the base; existing `IOpStreamSink` consumers are unaffected.
 */
export interface IOpStreamCheckpointSink<TMsg> extends IOpStreamSink<TMsg> {
  /** Persist a checkpoint; rejects on duplicate `(streamId, sequence)`. */
  appendCheckpoint(checkpoint: Checkpoint<TMsg>): Promise<void>;
  /** Most recent checkpoint with `sequence ≤ upToSequence`, or `undefined`. */
  latestCheckpointAtOrBefore(
    streamId: string,
    upToSequence: number,
  ): Promise<Checkpoint<TMsg> | undefined>;
  /** All checkpoints for `streamId`, ascending by `sequence`. */
  listCheckpoints(streamId: string): Promise<Checkpoint<TMsg>[]>;
  /** Drop ops with `sequence ≤ throughSequence`; returns the count removed. */
  truncateOpsThrough(streamId: string, throughSequence: number): Promise<number>;
  /** Drop checkpoints with `sequence < beforeSequence`; returns count removed. */
  truncateCheckpointsBefore(streamId: string, beforeSequence: number): Promise<number>;
}

/**
 * A hash-chain integrity violation — port of F# `VerificationError`. Surfaced
 * by `verifyChain`.
 */
export type VerificationError =
  | {
      readonly kind: 'PreviousHashMismatch';
      readonly sequence: number;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'HashMismatch';
      readonly sequence: number;
      readonly expected: string;
      readonly actual: string;
    }
  | {
      readonly kind: 'OutOfOrder';
      readonly expectedSequence: number;
      readonly actualSequence: number;
    };

/**
 * A replay failure — port of F# `ReplayError`. `ApplyFailed` carries the
 * sequence whose op did not apply and the underlying `@fuaran-ui/ops`
 * `ApplyError`.
 */
export type ReplayError = {
  readonly kind: 'ApplyFailed';
  readonly sequence: number;
  readonly applyError: ApplyError;
};

// Re-export the ApplyError shape the ReplayError references, so consumers can
// pattern-match a replay failure without a second import.
export type { ApplyError };
