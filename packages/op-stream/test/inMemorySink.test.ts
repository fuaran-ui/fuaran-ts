// ============================================================================
//  InMemorySink tests — append / replay / latestSequence / streams, duplicate
//  rejection, and the checkpoint + truncation surface. Mirrors the interface-
//  targeted Expecto acceptance set in Fuaran.UI.OpStream.Tests.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Node, NodeId } from '@fuaran-ui/schema';
import type { TreeOp } from '@fuaran-ui/ops';

import { InMemorySink, createInMemorySink, genesisPreviousHash } from '../src/index.js';
import type { Checkpoint, OpRecord } from '../src/index.js';

const nid = (s: string): NodeId => s as NodeId;

const recordAt = (streamId: string, sequence: number): OpRecord<unknown> => ({
  streamId,
  sequence,
  previousHash: genesisPreviousHash,
  hash: `hash-${sequence}`,
  op: { kind: 'RemoveNode', target: nid('x') } satisfies TreeOp<unknown>,
  actor: { kind: 'human', id: 'u' },
  timestampUnixSeconds: 1700000000 + sequence,
  resultEnvelope: { kind: 'Success' },
});

const leaf = (id: string): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: id } } },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const checkpointAt = (streamId: string, sequence: number): Checkpoint<unknown> => ({
  streamId,
  sequence,
  previousChainHead: `hash-${sequence}`,
  snapshotHash: `snap-${sequence}`,
  snapshot: leaf('root'),
  timestampUnixSeconds: 1700000000 + sequence,
});

describe('InMemorySink — base IOpStreamSink contract', () => {
  it('appends and replays in ascending sequence order', async () => {
    const sink = createInMemorySink<unknown>();
    await sink.append(recordAt('s', 1));
    await sink.append(recordAt('s', 3));
    await sink.append(recordAt('s', 2));
    const replayed = await sink.replay('s', 1, 3);
    expect(replayed.map((r) => r.sequence)).toEqual([1, 2, 3]);
  });

  it('replays only the requested inclusive range', async () => {
    const sink = createInMemorySink<unknown>();
    for (const seq of [1, 2, 3, 4, 5]) await sink.append(recordAt('s', seq));
    const replayed = await sink.replay('s', 2, 4);
    expect(replayed.map((r) => r.sequence)).toEqual([2, 3, 4]);
  });

  it('returns 0 latestSequence for an empty stream and the max otherwise', async () => {
    const sink = createInMemorySink<unknown>();
    expect(await sink.latestSequence('missing')).toBe(0);
    await sink.append(recordAt('s', 1));
    await sink.append(recordAt('s', 7));
    expect(await sink.latestSequence('s')).toBe(7);
  });

  it('lists distinct stream ids', async () => {
    const sink = createInMemorySink<unknown>();
    await sink.append(recordAt('a', 1));
    await sink.append(recordAt('b', 1));
    expect((await sink.streams()).sort()).toEqual(['a', 'b']);
  });

  it('rejects a duplicate (streamId, sequence)', async () => {
    const sink = createInMemorySink<unknown>();
    await sink.append(recordAt('s', 1));
    await expect(sink.append(recordAt('s', 1))).rejects.toThrow(/duplicate/);
  });

  it('returns an empty array replaying an unknown stream', async () => {
    const sink = createInMemorySink<unknown>();
    expect(await sink.replay('nope', 1, 10)).toEqual([]);
  });
});

describe('InMemorySink — checkpoint + truncation surface', () => {
  it('appends, lists, and queries the latest checkpoint at-or-before', async () => {
    const sink = new InMemorySink<unknown>();
    await sink.appendCheckpoint(checkpointAt('s', 2));
    await sink.appendCheckpoint(checkpointAt('s', 5));
    expect((await sink.listCheckpoints('s')).map((c) => c.sequence)).toEqual([2, 5]);
    expect((await sink.latestCheckpointAtOrBefore('s', 4))?.sequence).toBe(2);
    expect((await sink.latestCheckpointAtOrBefore('s', 5))?.sequence).toBe(5);
    expect(await sink.latestCheckpointAtOrBefore('s', 1)).toBeUndefined();
  });

  it('rejects a duplicate checkpoint sequence', async () => {
    const sink = new InMemorySink<unknown>();
    await sink.appendCheckpoint(checkpointAt('s', 1));
    await expect(sink.appendCheckpoint(checkpointAt('s', 1))).rejects.toThrow(/duplicate/);
  });

  it('truncates ops through a sequence and reports the count removed', async () => {
    const sink = new InMemorySink<unknown>();
    for (const seq of [1, 2, 3, 4]) await sink.append(recordAt('s', seq));
    expect(await sink.truncateOpsThrough('s', 2)).toBe(2);
    expect((await sink.replay('s', 1, 10)).map((r) => r.sequence)).toEqual([3, 4]);
  });

  it('truncates checkpoints before a sequence, keeping the retained tail', async () => {
    const sink = new InMemorySink<unknown>();
    for (const seq of [1, 2, 3]) await sink.appendCheckpoint(checkpointAt('s', seq));
    expect(await sink.truncateCheckpointsBefore('s', 3)).toBe(2);
    expect((await sink.listCheckpoints('s')).map((c) => c.sequence)).toEqual([3]);
  });
});
