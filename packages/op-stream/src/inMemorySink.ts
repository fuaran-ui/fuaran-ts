// ============================================================================
//  InMemorySink — per-process Map-backed IOpStreamCheckpointSink<TMsg>.
//
//  Port of Fuaran.UI.OpStream.InMemory.InMemorySink. Useful for tests, the
//  client-side authoring loop, and ephemeral preview environments. Records are
//  stored as typed OpRecord<TMsg> values — no JSON round-trip, no host codec
//  needed (the F# Sqlite sink that needs a codec is deliberately out of scope
//  for this package; an IndexedDB-backed sink is a candidate follow-up).
//
//  The F# sink guards its dictionaries with a per-instance lock for concurrent
//  appends; JS is single-threaded and these methods never `await` between read
//  and write, so the `(streamId, sequence)` uniqueness invariant holds without
//  a lock.
// ============================================================================

import type { Checkpoint, IOpStreamCheckpointSink, OpRecord } from './types.js';

export class InMemorySink<TMsg> implements IOpStreamCheckpointSink<TMsg> {
  readonly #streams = new Map<string, OpRecord<TMsg>[]>();
  readonly #checkpoints = new Map<string, Checkpoint<TMsg>[]>();

  #streamBucket(streamId: string): OpRecord<TMsg>[] {
    let bucket = this.#streams.get(streamId);
    if (bucket === undefined) {
      bucket = [];
      this.#streams.set(streamId, bucket);
    }
    return bucket;
  }

  #checkpointBucket(streamId: string): Checkpoint<TMsg>[] {
    let bucket = this.#checkpoints.get(streamId);
    if (bucket === undefined) {
      bucket = [];
      this.#checkpoints.set(streamId, bucket);
    }
    return bucket;
  }

  append(record: OpRecord<TMsg>): Promise<void> {
    const bucket = this.#streamBucket(record.streamId);
    if (bucket.some((r) => r.sequence === record.sequence)) {
      // Duplicate (streamId, sequence) is a structural defect — the host should
      // have queried latestSequence + 1 before assigning.
      return Promise.reject(
        new Error(
          `InMemorySink: duplicate (streamId=${record.streamId}, sequence=${record.sequence}) — sinks reject overwrites.`,
        ),
      );
    }
    bucket.push(record);
    return Promise.resolve();
  }

  replay(streamId: string, fromSequence: number, toSequence: number): Promise<OpRecord<TMsg>[]> {
    const bucket = this.#streams.get(streamId);
    if (bucket === undefined) return Promise.resolve([]);
    const result = bucket
      .filter((r) => r.sequence >= fromSequence && r.sequence <= toSequence)
      .sort((a, b) => a.sequence - b.sequence);
    return Promise.resolve(result);
  }

  latestSequence(streamId: string): Promise<number> {
    const bucket = this.#streams.get(streamId);
    if (bucket === undefined || bucket.length === 0) return Promise.resolve(0);
    return Promise.resolve(bucket.reduce((max, r) => (r.sequence > max ? r.sequence : max), 0));
  }

  streams(): Promise<string[]> {
    return Promise.resolve([...this.#streams.keys()]);
  }

  appendCheckpoint(checkpoint: Checkpoint<TMsg>): Promise<void> {
    const bucket = this.#checkpointBucket(checkpoint.streamId);
    if (bucket.some((c) => c.sequence === checkpoint.sequence)) {
      return Promise.reject(
        new Error(
          `InMemorySink: duplicate checkpoint (streamId=${checkpoint.streamId}, sequence=${checkpoint.sequence}) — sinks reject overwrites.`,
        ),
      );
    }
    bucket.push(checkpoint);
    return Promise.resolve();
  }

  latestCheckpointAtOrBefore(
    streamId: string,
    upToSequence: number,
  ): Promise<Checkpoint<TMsg> | undefined> {
    const bucket = this.#checkpoints.get(streamId);
    if (bucket === undefined || bucket.length === 0) return Promise.resolve(undefined);
    const candidates = bucket
      .filter((c) => c.sequence <= upToSequence)
      .sort((a, b) => b.sequence - a.sequence);
    return Promise.resolve(candidates[0]);
  }

  listCheckpoints(streamId: string): Promise<Checkpoint<TMsg>[]> {
    const bucket = this.#checkpoints.get(streamId);
    if (bucket === undefined) return Promise.resolve([]);
    return Promise.resolve([...bucket].sort((a, b) => a.sequence - b.sequence));
  }

  truncateOpsThrough(streamId: string, throughSequence: number): Promise<number> {
    const bucket = this.#streams.get(streamId);
    if (bucket === undefined) return Promise.resolve(0);
    const kept = bucket.filter((r) => r.sequence > throughSequence);
    const removed = bucket.length - kept.length;
    this.#streams.set(streamId, kept);
    return Promise.resolve(removed);
  }

  truncateCheckpointsBefore(streamId: string, beforeSequence: number): Promise<number> {
    const bucket = this.#checkpoints.get(streamId);
    if (bucket === undefined) return Promise.resolve(0);
    const kept = bucket.filter((c) => c.sequence >= beforeSequence);
    const removed = bucket.length - kept.length;
    this.#checkpoints.set(streamId, kept);
    return Promise.resolve(removed);
  }
}

/** Fresh in-memory sink as the base `IOpStreamSink` interface. */
export const createInMemorySink = <TMsg>(): InMemorySink<TMsg> => new InMemorySink<TMsg>();
