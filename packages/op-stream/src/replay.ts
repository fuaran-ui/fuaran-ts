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
  // latestSequence reported >0 but the prior record is missing — a sink
  // invariant violation. It is an ERROR, not a reason to chain to the genesis
  // hash: a record linked to genesis mid-stream is a forged-looking chain, not
  // a durable one.
  if (prior === undefined) {
    throw new Error(
      `op-stream: stream '${streamId}' reports sequence ${sequence - 1} but the sink returned no record for it; refusing to chain sequence ${sequence} to the genesis hash.`,
    );
  }
  return prior.hash;
};

// Sequence allocation is read-then-write (`latestSequence`, then `append` at
// latest + 1) with awaits between, so two concurrent persists on one stream
// would read the same latest and the sink would reject the second as a
// duplicate. Allocation is therefore serialised per (sink, stream): each
// persist runs after the previous one on that stream has settled. Keyed weakly
// on the sink so a discarded sink takes its queue with it.
const streamTails = new WeakMap<object, Map<string, Promise<void>>>();

const serialisedPerStream = <T>(
  sink: object,
  streamId: string,
  work: () => Promise<T>,
): Promise<T> => {
  let tails = streamTails.get(sink);
  if (tails === undefined) {
    tails = new Map<string, Promise<void>>();
    streamTails.set(sink, tails);
  }
  const queue = tails;
  const run = (queue.get(streamId) ?? Promise.resolve()).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  queue.set(streamId, tail);
  void tail.then(() => {
    if (queue.get(streamId) === tail) queue.delete(streamId);
  });
  return run;
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

  await sink.append(record);
};

/**
 * Persist `op` at the stream's next sequence. A missing previous record or an
 * `append` rejection goes to `ctx.onSinkError`; nothing is appended with a
 * guessed chain link.
 */
const persist = async <TMsg>(
  sink: IOpStreamSink<TMsg>,
  ctx: PersistContext,
  op: TreeOp<TMsg>,
): Promise<void> => {
  const latest = await sink.latestSequence(ctx.streamId);
  try {
    await appendRecordAt(sink, ctx, latest + 1, op);
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
 * unchanged (the sink is not touched). `sink.append` failures — and a stream
 * whose previous record is missing — are surfaced via `ctx.onSinkError` but do
 * NOT propagate — durability is best-effort. Concurrent calls on one
 * (sink, stream) are serialised, so each is allocated its own sequence. Port of
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
  await serialisedPerStream(sink, ctx.streamId, () => persist(sink, ctx, op));
  return { ok: true, value: result.value.newTree };
};
