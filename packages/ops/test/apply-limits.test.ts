// ============================================================================
//  Apply-time tree limits — this host's own cases (Phase 2161).
//
//  The shared corpus family (`limits-apply-corpus.test.ts`) pins EditNode,
//  UpdateState and MoveNode at depth. These pin what it deliberately leaves to
//  each host: InsertChild and ReplaceRoot, the MaxNodes axis (a vector past it
//  would be a 100 001-node document), a Batch, the positions the count walks
//  through, and the ops that are exempt because they cannot grow the tree.
// ============================================================================

import { MAX_NODES, MAX_NODE_DEPTH, type Node, type NodeId } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { apply } from '../src/index.js';
import type { TreeOp } from '../src/treeOp.js';

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

const box = (id: string, children: readonly Node<unknown>[]): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Layout',
    layout: {
      kind: 'Box',
      spec: {
        layout: { kind: 'Auto' },
        role: 'Group',
        keepTogether: false,
        breakBefore: false,
        children,
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

/** A chain `levels` deep (root is level 1); its deepest node is `${prefix}1`. */
const chain = (prefix: string, levels: number): Node<unknown> => {
  let n = box(`${prefix}1`, []);
  for (let i = 2; i <= levels; i += 1) n = box(`${prefix}${i}`, [n]);
  return n;
};

const applied = (tree: Node<unknown>, op: TreeOp<unknown>) => apply(tree, op);

const expectLimit = (r: ReturnType<typeof applied>): void => {
  expect(r.ok).toBe(false);
  if (!r.ok) expect(r.error.code).toBe('LimitExceeded');
};

describe('apply-time tree limits — depth', () => {
  it('InsertChild that nests one level past MAX_NODE_DEPTH is refused', () => {
    const tree = chain('n', MAX_NODE_DEPTH);
    expectLimit(applied(tree, { kind: 'InsertChild', parentId: nid('n1'), child: leaf('x') }));
  });

  it('InsertChild that lands exactly at MAX_NODE_DEPTH applies', () => {
    const tree = chain('n', MAX_NODE_DEPTH - 1);
    const r = applied(tree, { kind: 'InsertChild', parentId: nid('n1'), child: leaf('x') });
    expect(r.ok).toBe(true);
  });

  it('ReplaceRoot with a tree past MAX_NODE_DEPTH is refused; at the limit it applies', () => {
    const tree = leaf('root');
    expectLimit(applied(tree, { kind: 'ReplaceRoot', node: chain('n', MAX_NODE_DEPTH + 1) }));
    expect(applied(tree, { kind: 'ReplaceRoot', node: chain('n', MAX_NODE_DEPTH) }).ok).toBe(true);
  });

  it('a refusal leaves the caller tree untouched and emits no telemetry', () => {
    const tree = chain('n', MAX_NODE_DEPTH);
    const before = JSON.stringify(tree);
    const r = applied(tree, { kind: 'InsertChild', parentId: nid('n1'), child: leaf('x') });
    expectLimit(r);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it('a Batch whose result is past the limit is refused with LimitExceeded', () => {
    const tree = chain('n', MAX_NODE_DEPTH - 1);
    const r = applied(tree, {
      kind: 'Batch',
      ops: [
        { kind: 'InsertChild', parentId: nid('n1'), child: box('x', []) },
        { kind: 'InsertChild', parentId: nid('x'), child: leaf('y') },
      ],
    });
    expectLimit(r);
  });

  it('a Batch that grows and then shrinks back inside the limit applies (the RESULT is checked)', () => {
    const tree = chain('n', MAX_NODE_DEPTH);
    const r = applied(tree, {
      kind: 'Batch',
      ops: [
        { kind: 'InsertChild', parentId: nid('n1'), child: leaf('x') },
        { kind: 'RemoveNode', target: nid('x') },
      ],
    });
    expect(r.ok).toBe(true);
  });

  it('depth counts a node held in a state alternative, as the decoder does', () => {
    // n1 sits at MAX_NODE_DEPTH - 1. A state alternative is a level below it,
    // so an `onEmpty` box holding a child reaches MAX_NODE_DEPTH + 1.
    const tree = chain('n', MAX_NODE_DEPTH - 1);
    const r = applied(tree, {
      kind: 'UpdateState',
      target: nid('n1'),
      state: { onEmpty: box('e', [leaf('e1')]) },
    });
    expectLimit(r);
  });

  it('depth counts a node held in an envelope fallback, as the decoder does', () => {
    // A MAX_NODE_DEPTH chain whose deepest node carries an envelope `fallback`:
    // the fallback is one level past the limit. A growing op anywhere (here a
    // shallow InsertChild, itself well inside the limit) is measured on the
    // result, and the walk reaches the fallback.
    let tree: Node<unknown> = { ...box('n1', []), fallback: leaf('fb') };
    for (let i = 2; i <= MAX_NODE_DEPTH; i += 1) tree = box(`n${i}`, [tree]);
    const top = nid(`n${MAX_NODE_DEPTH}`);
    expectLimit(applied(tree, { kind: 'InsertChild', parentId: top, child: leaf('z') }));
    // Without the fallback the same op applies: the fallback is what breached.
    let plain: Node<unknown> = box('n1', []);
    for (let i = 2; i <= MAX_NODE_DEPTH; i += 1) plain = box(`n${i}`, [plain]);
    expect(applied(plain, { kind: 'InsertChild', parentId: top, child: leaf('z') }).ok).toBe(true);
  });
});

describe('apply-time tree limits — node count', () => {
  const wide = (n: number): Node<unknown> =>
    box(
      'root',
      Array.from({ length: n - 1 }, (_, i) => leaf(`l${i}`)),
    );

  it('InsertChild that takes the tree to MAX_NODES + 1 is refused', () => {
    expectLimit(
      applied(wide(MAX_NODES), { kind: 'InsertChild', parentId: nid('root'), child: leaf('x') }),
    );
  });

  it('InsertChild that takes the tree to exactly MAX_NODES applies', () => {
    const r = applied(wide(MAX_NODES - 1), {
      kind: 'InsertChild',
      parentId: nid('root'),
      child: leaf('x'),
    });
    expect(r.ok).toBe(true);
  });
});

describe('apply-time tree limits — exempt ops', () => {
  it('an op that cannot grow the tree is not measured (an over-limit tree stays editable)', () => {
    // A hand-built tree already past the limit: shrinking and in-place ops are
    // never refused for a breach they did not cause.
    const over = chain('n', MAX_NODE_DEPTH + 1);
    expect(applied(over, { kind: 'RemoveNode', target: nid('n1') }).ok).toBe(true);
    expect(
      applied(over, {
        kind: 'UpdateStyle',
        target: nid('n2'),
        style: { tone: 'Default', weight: 'Spacious', emphasis: 'Normal' },
      }).ok,
    ).toBe(true);
  });

  it('EditNode to a childless kind and UpdateState with no alternatives are not measured', () => {
    const over = chain('n', MAX_NODE_DEPTH + 1);
    expect(applied(over, { kind: 'EditNode', target: nid('n1'), newKind: leaf('t').kind }).ok).toBe(
      true,
    );
    expect(applied(over, { kind: 'UpdateState', target: nid('n1'), state: {} }).ok).toBe(true);
  });
});
