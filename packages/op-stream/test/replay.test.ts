// ============================================================================
//  Replay + applyAndPersist tests.
//
//   - applyTo reconstructs the same final tree as folding apply() directly
//     (the acceptance criterion: replay against a sink reconstructs the same
//     state as direct apply).
//   - applyAndPersist builds a verifiable hash chain as a side effect of
//     applying, and short-circuits without touching the sink on apply failure.
//   - replayStream resumes from a checkpoint snapshot + a from-sequence.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { Node, NodeId } from '@fuaran-ui/schema';
import type { TreeOp } from '@fuaran-ui/ops';
import { apply, encodeNode } from '@fuaran-ui/ops';

import {
  applyAndPersist,
  applyTo,
  createInMemorySink,
  replayStream,
  verifyChain,
} from '../src/index.js';
import type { PersistContext } from '../src/index.js';

const nid = (s: string): NodeId => s as NodeId;

const leaf = (id: string): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: id } } },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const dashboard = (id: string, children: readonly Node<unknown>[]): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Layout',
    layout: { kind: 'Box', spec: { layout: { kind: 'Auto' }, role: 'Dashboard', children } },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const ops: TreeOp<unknown>[] = [
  { kind: 'InsertChild', parentId: nid('root'), child: leaf('c') },
  { kind: 'RemoveNode', target: nid('a') },
  {
    kind: 'UpdateStyle',
    target: nid('b'),
    style: { tone: 'Brand', weight: 'Standard', emphasis: 'Normal' },
  },
];

// Fold apply() directly to obtain the reference final tree.
const directApply = (initial: Node<unknown>, list: readonly TreeOp<unknown>[]): Node<unknown> => {
  let tree = initial;
  for (const op of list) {
    const r = apply(tree, op);
    if (!r.ok) throw new Error(`reference apply failed: ${r.error.code}`);
    tree = r.value.newTree;
  }
  return tree;
};

const fixedClock = (): (() => number) => {
  let t = 1700000000;
  return () => t++;
};

describe('applyTo', () => {
  it('reconstructs the same final tree as direct apply', () => {
    const initial = dashboard('root', [leaf('a'), leaf('b')]);
    const records = ops.map((op, i) => ({
      streamId: 's',
      sequence: i + 1,
      previousHash: '0'.repeat(64),
      hash: `h${i}`,
      op,
      actor: { kind: 'human' as const, id: 'u' },
      timestampUnixSeconds: 1700000000 + i,
      resultEnvelope: { kind: 'Success' as const },
    }));
    const replayed = applyTo(initial, records);
    expect(replayed.ok).toBe(true);
    if (replayed.ok) {
      expect(encodeNode(replayed.value)).toBe(encodeNode(directApply(initial, ops)));
    }
  });

  it('surfaces the first apply failure with its sequence', () => {
    const initial = dashboard('root', [leaf('a')]);
    const records = [
      {
        streamId: 's',
        sequence: 1,
        previousHash: '0'.repeat(64),
        hash: 'h1',
        op: { kind: 'RemoveNode', target: nid('does-not-exist') } satisfies TreeOp<unknown>,
        actor: { kind: 'human' as const, id: 'u' },
        timestampUnixSeconds: 1700000000,
        resultEnvelope: { kind: 'Success' as const },
      },
    ];
    const replayed = applyTo(initial, records);
    expect(replayed.ok).toBe(false);
    if (!replayed.ok) {
      expect(replayed.error.kind).toBe('ApplyFailed');
      expect(replayed.error.sequence).toBe(1);
    }
  });
});

describe('applyAndPersist', () => {
  it('persists a verifiable hash chain while returning the applied tree', async () => {
    const sink = createInMemorySink<unknown>();
    const ctx: PersistContext = { streamId: 's', userId: 'u', now: fixedClock() };
    let tree = dashboard('root', [leaf('a'), leaf('b')]);

    for (const op of ops) {
      const r = await applyAndPersist(sink, ctx, op, tree);
      expect(r.ok).toBe(true);
      if (r.ok) tree = r.value;
    }

    expect(await sink.latestSequence('s')).toBe(3);
    const persisted = await sink.replay('s', 1, 3);
    expect(persisted.map((r) => r.sequence)).toEqual([1, 2, 3]);
    expect(persisted[0]!.previousHash).toBe('0'.repeat(64));
    // The persisted stream is a clean hash chain...
    expect(verifyChain(persisted)).toBeUndefined();
    // ...and replaying it reconstructs the same tree the loop produced.
    const reconstructed = applyTo(dashboard('root', [leaf('a'), leaf('b')]), persisted);
    expect(reconstructed.ok).toBe(true);
    if (reconstructed.ok) expect(encodeNode(reconstructed.value)).toBe(encodeNode(tree));
  });

  it('short-circuits on apply failure without touching the sink', async () => {
    const sink = createInMemorySink<unknown>();
    const ctx: PersistContext = { streamId: 's', userId: 'u', now: fixedClock() };
    const tree = dashboard('root', [leaf('a')]);
    const r = await applyAndPersist(sink, ctx, { kind: 'RemoveNode', target: nid('ghost') }, tree);
    expect(r.ok).toBe(false);
    expect(await sink.latestSequence('s')).toBe(0);
  });

  it('records the promptId only when supplied', async () => {
    const sink = createInMemorySink<unknown>();
    const ctx: PersistContext = { streamId: 's', userId: 'u', promptId: 'p-42', now: fixedClock() };
    await applyAndPersist(sink, ctx, ops[1]!, dashboard('root', [leaf('a'), leaf('b')]));
    const [record] = await sink.replay('s', 1, 1);
    expect(record!.promptId).toBe('p-42');
  });
});

describe('replayStream', () => {
  it('resumes from a checkpoint snapshot + from-sequence', async () => {
    const sink = createInMemorySink<unknown>();
    const ctx: PersistContext = { streamId: 's', userId: 'u', now: fixedClock() };
    let tree = dashboard('root', [leaf('a'), leaf('b')]);
    for (const op of ops) {
      const r = await applyAndPersist(sink, ctx, op, tree);
      if (r.ok) tree = r.value;
    }

    // Snapshot the tree after op 1, then replay only ops 2..3 on top of it.
    const afterOp1 = directApply(dashboard('root', [leaf('a'), leaf('b')]), ops.slice(0, 1));
    const resumed = await replayStream(sink, 's', afterOp1, 2);
    expect(resumed.ok).toBe(true);
    if (resumed.ok) expect(encodeNode(resumed.value)).toBe(encodeNode(tree));
  });

  it('defaults toSequence to the sink latest', async () => {
    const sink = createInMemorySink<unknown>();
    const ctx: PersistContext = { streamId: 's', userId: 'u', now: fixedClock() };
    let tree = dashboard('root', [leaf('a'), leaf('b')]);
    for (const op of ops) {
      const r = await applyAndPersist(sink, ctx, op, tree);
      if (r.ok) tree = r.value;
    }
    const full = await replayStream(sink, 's', dashboard('root', [leaf('a'), leaf('b')]));
    expect(full.ok).toBe(true);
    if (full.ok) expect(encodeNode(full.value)).toBe(encodeNode(tree));
  });
});
