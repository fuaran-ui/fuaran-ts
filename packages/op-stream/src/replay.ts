// ============================================================================
//  Replay + applyAndPersist.
//
//  Ports Fuaran.UI.OpStream.Replay.Replay (fold an OpRecord sequence through
//  the apply engine) and Fuaran.UI.OpStream.Replay.ApplyPersist.applyAndPersist
//  (apply once, then persist a hash-chained record on success).
//
//  Replay does NOT verify the hash chain — use `verifyChain` for that. The two
//  concerns are orthogonal: replay drives the apply engine; chain verification
//  proves the stream itself was not tampered with.
// ============================================================================

import { apply } from './ops.js';
import type { Node } from './ops.js';
import type { Result } from '@fuaran-ui/schema';
import { computeHash, genesisPreviousHash } from './hashChain.js';
import type { Actor, IOpStreamSink, OpRecord, OpResultEnvelope, ReplayError } from './types.js';
import type { TreeOp, ApplyError } from './ops.js';

/**
 * Apply every record in `records` to `initialTree` in order, returning the
 * final tree on success or the first apply failure (`ReplayError.ApplyFailed`
 * with the offending record's sequence). Synchronous — port of F#
 * `Replay.applyTo`.
 */
export const applyTo = <TMsg>(
  initialTree: Node<TMsg>,
  records: readonly OpRecord<TMsg>[],
): Result<Node<TMsg>, ReplayError> => {
  let tree = initialTree;
  for (const record of records) {
    const result = apply(tree, record.op);
    if (result.ok) {
      tree = result.value.newTree;
    } else {
      return {
        ok: false,
        error: { kind: 'ApplyFailed', sequence: record.sequence, applyError: result.error },
      };
    }
  }
  return { ok: true, value: tree };
};

/**
 * Read records for `streamId` in `[fromSequence, toSequence]` from `sink` and
 * fold them through the apply engine starting at `initialTree`. The high-level
 * replay entry point: resume from a checkpoint by passing the checkpoint's
 * snapshot as `initialTree` and `checkpoint.sequence + 1` as `fromSequence`.
 * `toSequence` defaults to the sink's `latestSequence`.
 */
export const replayStream = async <TMsg>(
  sink: IOpStreamSink<TMsg>,
  streamId: string,
  initialTree: Node<TMsg>,
  fromSequence = 1,
  toSequence?: number,
): Promise<Result<Node<TMsg>, ReplayError>> => {
  const upTo = toSequence ?? (await sink.latestSequence(streamId));
  const records = await sink.replay(streamId, fromSequence, upTo);
  return applyTo(initialTree, records);
};

/**
 * Per-op correlation + sink-error context threaded into the persisted
 * `OpRecord` — port of F# `PersistContext`. The wrapper queries the sink for
 * the next sequence + the previous hash; the caller supplies stream identity,
 * user id, and (optionally) the conversation's current prompt id.
 */
export interface PersistContext {
  readonly streamId: string;
  readonly userId: string;
  /** Conversation correlation, when the host threads one. */
  readonly promptId?: string;
  /**
   * Invoked when `sink.append` rejects. The apply path is never broken by a
   * misbehaving sink — durability is best-effort. Default: no logging.
   */
  readonly onSinkError?: (error: unknown) => void;
  /**
   * Clock returning Unix-epoch *seconds* (UTC). Injected so tests pin a
   * deterministic timestamp into the hash chain; defaults to the wall clock.
   */
  readonly now?: () => number;
}

const defaultNow = (): number => Math.trunc(Date.now() / 1000);

const previousHashFor = async <TMsg>(
  sink: IOpStreamSink<TMsg>,
  streamId: string,
  sequence: number,
): Promise<string> => {
  if (sequence === 1) return genesisPreviousHash;
  const prev = await sink.replay(streamId, sequence - 1, sequence - 1);
  const prior = prev[0];
  // latestSequence reported >0 but the prior record is missing — sink invariant
  // violation. Best-effort: use the genesis hash; a later verifyChain surfaces
  // the gap as OutOfOrder / PreviousHashMismatch.
  return prior === undefined ? genesisPreviousHash : prior.hash;
};

const appendRecordAt = async <TMsg>(
  sink: IOpStreamSink<TMsg>,
  ctx: PersistContext,
  sequence: number,
  op: TreeOp<TMsg>,
): Promise<void> => {
  const previousHash = await previousHashFor(sink, ctx.streamId, sequence);
  const timestampUnixSeconds = (ctx.now ?? defaultNow)();
  // PersistContext keeps its bare-string userId (host API unchanged); lift it to
  // a typed human actor at the op-record boundary (Phase 320).
  const actor: Actor = { kind: 'human', id: ctx.userId };
  // Phase 406: promptId + resultEnvelope are folded into the chain hash.
  const resultEnvelope: OpResultEnvelope = { kind: 'Success' };
  const hash = computeHash(
    previousHash,
    op,
    sequence,
    timestampUnixSeconds,
    actor,
    ctx.promptId,
    resultEnvelope,
  );

  const record: OpRecord<TMsg> = {
    streamId: ctx.streamId,
    sequence,
    previousHash,
    hash,
    op,
    ...(ctx.promptId !== undefined ? { promptId: ctx.promptId } : {}),
    actor,
    timestampUnixSeconds,
    resultEnvelope,
  };

  try {
    await sink.append(record);
  } catch (error) {
    if (ctx.onSinkError !== undefined) {
      try {
        ctx.onSinkError(error);
      } catch {
        // A misbehaving error hook must never poison the apply path.
      }
    }
  }
};

/**
 * Apply `op` against `tree`. On success, persist a hash-chained `OpRecord` to
 * `sink` and return the updated tree; on failure, return the apply error
 * unchanged (the sink is not touched). `sink.append` failures are surfaced via
 * `ctx.onSinkError` but do NOT propagate — durability is best-effort. Port of
 * F# `ApplyPersist.applyAndPersist`.
 */
export const applyAndPersist = async <TMsg>(
  sink: IOpStreamSink<TMsg>,
  ctx: PersistContext,
  op: TreeOp<TMsg>,
  tree: Node<TMsg>,
): Promise<Result<Node<TMsg>, ApplyError>> => {
  const result = apply(tree, op);
  if (!result.ok) return { ok: false, error: result.error };
  const latest = await sink.latestSequence(ctx.streamId);
  await appendRecordAt(sink, ctx, latest + 1, op);
  return { ok: true, value: result.value.newTree };
};
