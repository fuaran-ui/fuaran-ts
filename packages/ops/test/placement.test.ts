// ============================================================================
//  Placement algebra acceptance + property set.
//
//  Mirror of the F# reference suite (Fuaran.UI.Ops.Tests/PlacementTests.fs).
//  Two obligations, stated as properties over generated trees and checked
//  against the REAL apply engine (never a re-derivation of its logic):
//
//   (1) No false permit — every op a helper emits is accepted by the apply
//       engine, and the applied tree exhibits the placement's declared order
//       (the moved/inserted node sits exactly where the `Placement` said,
//       with the other siblings' order preserved).
//
//   (2) No false refuse — every helper rejection corresponds to an apply-side
//       rejection of the op the helper would otherwise have emitted (or, for
//       `UnknownAnchor`, to the `OrderingMismatch` refusal of the only op that
//       could have honoured the anchor).
//
//  The clone verbs add the tree-wide id obligations: a duplicate never
//  collides with any id in the target tree (including ids held in
//  non-structural positions), the clone is structurally equal to its source
//  modulo ids, and a paste preserves non-colliding ids while remapping
//  colliding ones.
// ============================================================================

import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import type { Node, NodeId, Result } from '@fuaran-ui/schema';

import {
  allNodeIds,
  childSlots,
  findLayoutParent,
  findNode,
  layoutChildren,
} from '../src/apply.js';
import {
  apply,
  canPlace,
  duplicateOp,
  duplicateOpWith,
  moveOp,
  nudgeOp,
  pasteOp,
  placeOp,
  sequentialFreshIds,
} from '../src/index.js';
import type { PlaceError, PlaceTarget, Placement } from '../src/index.js';
import type { TreeOp } from '../src/treeOp.js';

type N = Node<unknown>;

const nid = (s: string): NodeId => s as NodeId;

// ─── Fixtures ────────────────────────────────────────────────────────────────

const leaf = (id: string): N => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: 'body' } } },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

const container = (id: string, children: readonly N[]): N => ({
  id: nid(id),
  kind: {
    kind: 'Layout',
    layout: {
      kind: 'Box',
      spec: {
        layout: { kind: 'Auto' },
        role: 'Dashboard',
        keepTogether: false,
        breakBefore: false,
        children,
      },
    },
  },
  state: {},
  style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
});

/** A main node carrying a loading placeholder in a non-structural State slot. */
const withOnLoading = (placeholder: N, main: N): N => ({
  ...main,
  state: { ...main.state, onLoading: placeholder },
});

/** root ── left [a; b; c] · solo (childless leaf) · right [d] · empty [] */
const fixture = (): N =>
  container('root', [
    container('left', [leaf('a'), leaf('b'), leaf('c')]),
    leaf('solo'),
    container('right', [leaf('d')]),
    container('empty', []),
  ]);

const childIdsIn = (root: N, parentId: string): string[] => {
  const p = findNode(parentId, root);
  if (p === undefined) throw new Error(`parent '${parentId}' not found in tree`);
  return (layoutChildren(p) ?? []).map((c) => c.id as string);
};

const applied = (op: TreeOp<unknown>, root: N): N => {
  const r = apply(root, op);
  if (!r.ok) throw new Error(`apply refused an op the helper emitted: ${r.error.code}`);
  return r.value.newTree;
};

const refusedAs = (op: TreeOp<unknown>, root: N): string => {
  const r = apply(root, op);
  if (r.ok) throw new Error('apply accepted an op the helper refused');
  return r.error.code;
};

const expectRefusal = <T>(result: Result<T, PlaceError>, expected: PlaceError): void => {
  expect(result.ok).toBe(false);
  if (!result.ok) expect(result.error).toEqual(expected);
};

const rawIds = (root: N): string[] => allNodeIds(root);

const allDistinct = (root: N): boolean => {
  const ids = rawIds(root);
  return ids.length === new Set(ids).size;
};

/**
 * Preorder kind tags over the whole traversal surface — structural equality
 * modulo ids.
 */
const kindShape = (n: N): string[] => [
  n.kind.kind,
  ...childSlots(n).flatMap((s) => kindShape(s.child)),
];

const insertedChild = (op: TreeOp<unknown>): N => {
  if (op.kind === 'InsertChild') return op.child;
  if (op.kind === 'Batch' && op.ops[0]?.kind === 'InsertChild') return op.ops[0].child;
  throw new Error(`expected a placed insert, got ${op.kind}`);
};

const at = (parentId: string, placement: Placement): PlaceTarget => ({
  parentId: nid(parentId),
  placement,
});

const last: Placement = { kind: 'Last' };
const first: Placement = { kind: 'First' };
const before = (anchor: string): Placement => ({ kind: 'Before', anchor: nid(anchor) });
const after = (anchor: string): Placement => ({ kind: 'After', anchor: nid(anchor) });

// ─── Unit tests: placeOp ─────────────────────────────────────────────────────

describe('Placement.placeOp', () => {
  it('Last emits a bare InsertChild and appends', () => {
    const t = fixture();
    const r = placeOp(t, leaf('x'), at('left', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('InsertChild');
      expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['a', 'b', 'c', 'x']);
    }
  });

  it('First emits Batch [insert; reorder] and lands first', () => {
    const t = fixture();
    const r = placeOp(t, leaf('x'), at('left', first));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('Batch');
      if (r.value.kind === 'Batch') {
        expect(r.value.ops.map((o) => o.kind)).toEqual(['InsertChild', 'ReorderChildren']);
      }
      expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['x', 'a', 'b', 'c']);
    }
  });

  it('First into an empty container stays a bare InsertChild', () => {
    const t = fixture();
    const r = placeOp(t, leaf('x'), at('empty', first));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('InsertChild');
      expect(childIdsIn(applied(r.value, t), 'empty')).toEqual(['x']);
    }
  });

  it('Before an interior sibling lands immediately before it', () => {
    const t = fixture();
    const r = placeOp(t, leaf('x'), at('left', before('b')));
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['a', 'x', 'b', 'c']);
  });

  it('After the last sibling stays a bare InsertChild', () => {
    const t = fixture();
    const r = placeOp(t, leaf('x'), at('left', after('c')));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('InsertChild');
      expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['a', 'b', 'c', 'x']);
    }
  });

  it('absent parent is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(placeOp(t, leaf('x'), at('ghost', last)), {
      kind: 'ParentNotFound',
      parentId: nid('ghost'),
    });
    expect(refusedAs({ kind: 'InsertChild', parentId: nid('ghost'), child: leaf('x') }, t)).toBe(
      'ParentNotFound',
    );
  });

  it('childless parent is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(placeOp(t, leaf('x'), at('solo', last)), {
      kind: 'ChildlessKind',
      parentId: nid('solo'),
    });
    expect(refusedAs({ kind: 'InsertChild', parentId: nid('solo'), child: leaf('x') }, t)).toBe(
      'ChildlessKind',
    );
  });

  it('duplicate id is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(placeOp(t, leaf('a'), at('right', last)), {
      kind: 'DuplicateId',
      nodeId: nid('a'),
    });
    expect(refusedAs({ kind: 'InsertChild', parentId: nid('right'), child: leaf('a') }, t)).toBe(
      'DuplicateNodeId',
    );
  });

  it("an anchor that is not a destination child is refused, matching the reorder's OrderingMismatch", () => {
    const t = fixture();
    // "d" exists in the tree but is not a child of "left".
    expectRefusal(placeOp(t, leaf('x'), at('left', before('d'))), {
      kind: 'UnknownAnchor',
      anchor: nid('d'),
    });
    // The only op that could honour the anchor names it in a reorder, which
    // the apply engine refuses.
    expect(
      refusedAs(
        {
          kind: 'ReorderChildren',
          parentId: nid('left'),
          newOrder: [nid('d'), nid('a'), nid('b'), nid('c')],
        },
        t,
      ),
    ).toBe('OrderingMismatch');
  });
});

// ─── Unit tests: moveOp / canPlace ───────────────────────────────────────────

describe('Placement.moveOp / canPlace', () => {
  it('cross-parent Last emits a bare MoveNode', () => {
    const t = fixture();
    const r = moveOp(t, nid('a'), at('right', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('MoveNode');
      const updated = applied(r.value, t);
      expect(childIdsIn(updated, 'right')).toEqual(['d', 'a']);
      expect(childIdsIn(updated, 'left')).toEqual(['b', 'c']);
    }
  });

  it('same-parent re-placement emits Batch [move; reorder]', () => {
    const t = fixture();
    const r = moveOp(t, nid('c'), at('left', before('a')));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('Batch');
      if (r.value.kind === 'Batch') {
        expect(r.value.ops.map((o) => o.kind)).toEqual(['MoveNode', 'ReorderChildren']);
      }
      expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['c', 'a', 'b']);
    }
  });

  it('move into itself is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(moveOp(t, nid('left'), at('left', last)), {
      kind: 'MoveIntoSelf',
      nodeId: nid('left'),
    });
    expect(refusedAs({ kind: 'MoveNode', target: nid('left'), newParentId: nid('left') }, t)).toBe(
      'KindMismatch',
    );
  });

  it('move into a descendant is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(moveOp(t, nid('root'), at('left', last)), {
      kind: 'MoveIntoDescendant',
      nodeId: nid('root'),
      parentId: nid('left'),
    });
    expect(refusedAs({ kind: 'MoveNode', target: nid('root'), newParentId: nid('left') }, t)).toBe(
      'KindMismatch',
    );
  });

  it('absent node is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(moveOp(t, nid('ghost'), at('left', last)), {
      kind: 'NodeNotFound',
      nodeId: nid('ghost'),
    });
    expect(refusedAs({ kind: 'MoveNode', target: nid('ghost'), newParentId: nid('left') }, t)).toBe(
      'NodeNotFound',
    );
  });

  it('childless destination is refused as the apply engine would refuse it', () => {
    const t = fixture();
    expectRefusal(moveOp(t, nid('a'), at('solo', last)), {
      kind: 'ChildlessKind',
      parentId: nid('solo'),
    });
    expect(refusedAs({ kind: 'MoveNode', target: nid('a'), newParentId: nid('solo') }, t)).toBe(
      'ChildlessKind',
    );
  });

  it('anchoring a move on the moved node itself is an unknown anchor', () => {
    const t = fixture();
    expectRefusal(moveOp(t, nid('a'), at('right', after('a'))), {
      kind: 'UnknownAnchor',
      anchor: nid('a'),
    });
  });

  it('a node held in a non-structural position is not movable — refused as the engine refuses it', () => {
    const t = container('root', [withOnLoading(leaf('ph'), leaf('m')), container('box', [])]);
    expectRefusal(moveOp(t, nid('ph'), at('box', last)), {
      kind: 'NodeNotFound',
      nodeId: nid('ph'),
    });
    expect(refusedAs({ kind: 'MoveNode', target: nid('ph'), newParentId: nid('box') }, t)).toBe(
      'NodeNotFound',
    );
  });

  it('canPlace agrees with moveOp on the legal drop', () => {
    const t = fixture();
    expect(canPlace(t, nid('a'), at('right', before('d'))).ok).toBe(true);
  });
});

// ─── Unit tests: nudgeOp ─────────────────────────────────────────────────────

describe('Placement.nudgeOp', () => {
  it('-1 swaps the node with its previous sibling via the full permutation', () => {
    const t = fixture();
    const r = nudgeOp(t, nid('b'), -1);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.kind).toBe('ReorderChildren');
      expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['b', 'a', 'c']);
    }
  });

  it('+2 swaps across the list', () => {
    const t = fixture();
    const r = nudgeOp(t, nid('a'), 2);
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIdsIn(applied(r.value, t), 'left')).toEqual(['c', 'b', 'a']);
  });

  it('the first sibling cannot move up', () => {
    const t = fixture();
    expectRefusal(nudgeOp(t, nid('a'), -1), {
      kind: 'NudgeOutOfRange',
      nodeId: nid('a'),
      delta: -1,
    });
  });

  it('the last sibling cannot move down', () => {
    const t = fixture();
    expectRefusal(nudgeOp(t, nid('c'), 1), { kind: 'NudgeOutOfRange', nodeId: nid('c'), delta: 1 });
  });

  it('the root has no siblings to nudge among', () => {
    const t = fixture();
    expectRefusal(nudgeOp(t, nid('root'), 1), { kind: 'CannotNudgeRoot', nodeId: nid('root') });
  });

  it('an absent node is refused', () => {
    const t = fixture();
    expectRefusal(nudgeOp(t, nid('ghost'), 1), { kind: 'NodeNotFound', nodeId: nid('ghost') });
  });
});

// ─── Unit tests: duplicateOp / pasteOp ───────────────────────────────────────

describe('Placement.duplicateOp / pasteOp', () => {
  it('duplicate places a fresh-id clone beside its source', () => {
    const t = fixture();
    const r = duplicateOp(t, nid('left'), at('root', after('left')));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = applied(r.value, t);
      expect(childIdsIn(updated, 'root')).toEqual(['left', 'left-copy', 'solo', 'right', 'empty']);
      expect(childIdsIn(updated, 'left-copy')).toEqual(['a-copy', 'b-copy', 'c-copy']);
      expect(allDistinct(updated)).toBe(true);
    }
  });

  it('duplicate is structurally equal to its source modulo ids', () => {
    const t = fixture();
    const r = duplicateOp(t, nid('left'), at('right', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const source = findNode('left', t);
      expect(source).toBeDefined();
      expect(kindShape(insertedChild(r.value))).toEqual(kindShape(source!));
    }
  });

  it('the injectable strategy mints deterministic sequential ids', () => {
    const t = fixture();
    const r = duplicateOpWith(sequentialFreshIds('dup'), t, nid('left'), at('root', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = applied(r.value, t);
      expect(childIdsIn(updated, 'root').at(-1)).toBe('dup-1');
      expect(childIdsIn(updated, 'dup-1')).toEqual(['dup-2', 'dup-3', 'dup-4']);
    }
  });

  it('duplicate remaps ids held in non-structural positions too', () => {
    // `ph` lives in a State slot — invisible to the structural child lists,
    // but inside the tree-wide id-uniqueness contract.
    const t = container('root', [withOnLoading(leaf('ph'), leaf('m'))]);
    const r = duplicateOp(t, nid('m'), at('root', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = applied(r.value, t);
      expect(allDistinct(updated)).toBe(true);
      expect(rawIds(updated)).toContain('ph-copy');
    }
  });

  it('duplicate of an absent source is refused', () => {
    const t = fixture();
    expectRefusal(duplicateOp(t, nid('ghost'), at('root', last)), {
      kind: 'NodeNotFound',
      nodeId: nid('ghost'),
    });
  });

  it('paste remaps colliding ids and preserves the rest', () => {
    const t = fixture();
    // Lifted from a different tree: "left" and "a" collide with the target;
    // "z" does not.
    const foreign = container('left', [leaf('a'), leaf('z')]);
    const r = pasteOp(t, foreign, at('right', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = applied(r.value, t);
      expect(childIdsIn(updated, 'right')).toEqual(['d', 'left-copy']);
      expect(childIdsIn(updated, 'left-copy')).toEqual(['a-copy', 'z']);
      expect(allDistinct(updated)).toBe(true);
    }
  });

  it('paste with no collisions preserves every id', () => {
    const t = fixture();
    const foreign = container('p', [leaf('q')]);
    const r = pasteOp(t, foreign, at('empty', last));
    expect(r.ok).toBe(true);
    if (r.ok) {
      const updated = applied(r.value, t);
      expect(childIdsIn(updated, 'empty')).toEqual(['p']);
      expect(childIdsIn(updated, 'p')).toEqual(['q']);
    }
  });
});

// ─── Property tests ──────────────────────────────────────────────────────────
//
// Generated trees are Box containers over Markdown leaves with sequential
// preorder ids (`n1`, `n2`, …) under a fixed `root` container; parents,
// anchors, and moved nodes are drawn from the tree's OWN ids plus a `ghost`,
// so both the legal and every illegal class is generated. Mirrors the F#
// FsCheck set (400 runs per property, as there).

type Shape = { readonly leaf: true } | { readonly leaf: false; readonly children: Shape[] };

const shapeArb = (depth: number): fc.Arbitrary<Shape> =>
  depth <= 0
    ? fc.constant({ leaf: true } as Shape)
    : fc.oneof(
        { weight: 2, arbitrary: fc.constant({ leaf: true } as Shape) },
        {
          weight: 3,
          arbitrary: fc
            .array(shapeArb(depth - 1), { maxLength: 3 })
            .map((children) => ({ leaf: false, children }) as Shape),
        },
      );

const build = (shape: Shape): N => {
  let counter = 0;
  const go = (s: Shape): N => {
    counter += 1;
    const id = `n${counter}`;
    return s.leaf ? leaf(id) : container(id, s.children.map(go));
  };
  return container('root', [go(shape)]);
};

const treeArb: fc.Arbitrary<N> = shapeArb(3).map(build);

const pickArb = (t: N): fc.Arbitrary<NodeId> =>
  fc.constantFrom(...(['ghost', ...allNodeIds(t)] as NodeId[]));

const targetArb = (t: N): fc.Arbitrary<PlaceTarget> =>
  fc
    .tuple(
      pickArb(t),
      fc.oneof(
        fc.constant(last),
        fc.constant(first),
        pickArb(t).map((anchor): Placement => ({ kind: 'Before', anchor })),
        pickArb(t).map((anchor): Placement => ({ kind: 'After', anchor })),
      ),
    )
    .map(([parentId, placement]) => ({ parentId, placement }));

const childNodeIds = (root: N, parentId: NodeId): NodeId[] => {
  const p = findNode(parentId as string, root);
  return p === undefined ? [] : (layoutChildren(p) ?? []).map((c) => c.id);
};

/**
 * The moved/inserted node sits exactly where the placement declared, and the
 * other siblings keep their relative order.
 */
const declaredOrderHolds = (beforeT: N, afterT: N, moved: NodeId, target: PlaceTarget): boolean => {
  const ids = childNodeIds(afterT, target.parentId);
  const idx = ids.findIndex((id) => id === moved);
  if (idx < 0) return false;
  const othersAfter = ids.filter((id) => id !== moved);
  const othersBefore = childNodeIds(beforeT, target.parentId).filter((id) => id !== moved);
  if (othersAfter.length !== othersBefore.length) return false;
  if (!othersAfter.every((id, i) => id === othersBefore[i])) return false;
  switch (target.placement.kind) {
    case 'Last':
      return idx === ids.length - 1;
    case 'First':
      return idx === 0;
    case 'Before':
      return idx + 1 < ids.length && ids[idx + 1] === target.placement.anchor;
    case 'After':
      return idx > 0 && ids[idx - 1] === target.placement.anchor;
  }
};

/**
 * The anchor is genuinely not among the destination's post-op children
 * (excluding the moved node itself, which is never its own anchor).
 */
const anchorNotASibling = (t: N, parentId: NodeId, moved: NodeId, anchor: NodeId): boolean =>
  !childNodeIds(t, parentId)
    .filter((id) => id !== moved)
    .includes(anchor);

const anchorOf = (p: Placement): NodeId | undefined =>
  p.kind === 'Before' || p.kind === 'After' ? p.anchor : undefined;

const placeCorresponds = (t: N, target: PlaceTarget): boolean => {
  const fresh = leaf('fresh-child');
  const r = placeOp(t, fresh, target);
  if (r.ok) {
    const appliedR = apply(t, r.value);
    return appliedR.ok && declaredOrderHolds(t, appliedR.value.newTree, nid('fresh-child'), target);
  }
  const naive: TreeOp<unknown> = { kind: 'InsertChild', parentId: target.parentId, child: fresh };
  switch (r.error.kind) {
    case 'ParentNotFound':
      return r.error.parentId === target.parentId && refusedAs(naive, t) === 'ParentNotFound';
    case 'ChildlessKind':
      return r.error.parentId === target.parentId && refusedAs(naive, t) === 'ChildlessKind';
    case 'UnknownAnchor':
      return (
        anchorOf(target.placement) === r.error.anchor &&
        anchorNotASibling(t, target.parentId, nid('fresh-child'), r.error.anchor)
      );
    default:
      return false;
  }
};

const moveCorresponds = (t: N, moved: NodeId, target: PlaceTarget): boolean => {
  const naive: TreeOp<unknown> = { kind: 'MoveNode', target: moved, newParentId: target.parentId };
  const r = moveOp(t, moved, target);
  if (r.ok) {
    const appliedR = apply(t, r.value);
    if (!appliedR.ok) return false;
    if (!declaredOrderHolds(t, appliedR.value.newTree, moved, target)) return false;
    const parent = findLayoutParent(moved as string, appliedR.value.newTree);
    return parent !== undefined && parent.id === target.parentId;
  }
  switch (r.error.kind) {
    case 'NodeNotFound':
    case 'MoveIntoSelf':
    case 'MoveIntoDescendant':
    case 'ParentNotFound':
    case 'ChildlessKind':
      // Every one of these classes is a refusal of the bare MoveNode itself.
      return !apply(t, naive).ok;
    case 'UnknownAnchor':
      return (
        anchorOf(target.placement) === r.error.anchor &&
        anchorNotASibling(t, target.parentId, moved, r.error.anchor)
      );
    default:
      return false;
  }
};

const canPlaceAgreesWithMoveOp = (t: N, moved: NodeId, target: PlaceTarget): boolean => {
  const c = canPlace(t, moved, target);
  const m = moveOp(t, moved, target);
  if (c.ok && m.ok) return true;
  if (!c.ok && !m.ok) return JSON.stringify(c.error) === JSON.stringify(m.error);
  return false;
};

const nudgeCorresponds = (t: N, node: NodeId, delta: number): boolean => {
  const r = nudgeOp(t, node, delta);
  const parent = findLayoutParent(node as string, t);
  if (r.ok) {
    if (parent === undefined) return false;
    const beforeIds = childNodeIds(t, parent.id);
    const idx = beforeIds.findIndex((id) => id === node);
    const appliedR = apply(t, r.value);
    if (!appliedR.ok) return false;
    const afterIds = childNodeIds(appliedR.value.newTree, parent.id);
    const expected = beforeIds.map((id, i) =>
      i === idx ? beforeIds[idx + delta]! : i === idx + delta ? beforeIds[idx]! : id,
    );
    return afterIds.length === expected.length && afterIds.every((id, i) => id === expected[i]);
  }
  switch (r.error.kind) {
    case 'CannotNudgeRoot':
      return r.error.nodeId === node && t.id === node;
    case 'NodeNotFound':
      return t.id !== node && parent === undefined;
    case 'NudgeOutOfRange': {
      if (parent === undefined) return false;
      const ids = childNodeIds(t, parent.id);
      const idx = ids.findIndex((id) => id === node);
      return idx + delta < 0 || idx + delta >= ids.length;
    }
    default:
      return false;
  }
};

const duplicateCorresponds = (t: N, source: NodeId, target: PlaceTarget): boolean => {
  const r = duplicateOp(t, source, target);
  if (r.ok) {
    const appliedR = apply(t, r.value);
    if (!appliedR.ok) return false;
    const sourceNode = findNode(source as string, t);
    if (sourceNode === undefined) return false;
    const ids = rawIds(appliedR.value.newTree);
    if (ids.length !== new Set(ids).size) return false;
    if (ids.length !== rawIds(t).length + allNodeIds(sourceNode).length) return false;
    const clone =
      r.value.kind === 'InsertChild'
        ? r.value.child
        : r.value.kind === 'Batch' && r.value.ops[0]?.kind === 'InsertChild'
          ? r.value.ops[0].child
          : undefined;
    return (
      clone !== undefined &&
      JSON.stringify(kindShape(clone)) === JSON.stringify(kindShape(sourceNode))
    );
  }
  switch (r.error.kind) {
    case 'NodeNotFound':
      return r.error.nodeId === source && findNode(source as string, t) === undefined;
    case 'ParentNotFound':
      return (
        r.error.parentId === target.parentId && findNode(target.parentId as string, t) === undefined
      );
    case 'ChildlessKind': {
      const p = findNode(r.error.parentId as string, t);
      return p !== undefined && layoutChildren(p) === undefined;
    }
    case 'UnknownAnchor':
      // The clone's fresh root id is never its own anchor, so exclusion is moot.
      return (
        anchorOf(target.placement) === r.error.anchor &&
        anchorNotASibling(t, target.parentId, nid('«none»'), r.error.anchor)
      );
    default:
      return false;
  }
};

const pasteCorresponds = (tA: N, tB: N, source: NodeId, target: PlaceTarget): boolean => {
  const lifted = findNode(source as string, tA);
  // Only tree ids are generated; a ghost source is not the paste contract
  // under test.
  if (lifted === undefined) return true;
  const r = pasteOp(tB, lifted, target);
  if (r.ok) {
    const appliedR = apply(tB, r.value);
    if (!appliedR.ok) return false;
    const ids = rawIds(appliedR.value.newTree);
    if (ids.length !== new Set(ids).size) return false;
    const beforeSet = new Set(rawIds(tB));
    const preserved = rawIds(lifted).filter((id) => !beforeSet.has(id));
    return preserved.every((id) => ids.includes(id));
  }
  switch (r.error.kind) {
    case 'ParentNotFound':
      return findNode(r.error.parentId as string, tB) === undefined;
    case 'ChildlessKind': {
      const p = findNode(r.error.parentId as string, tB);
      return p !== undefined && layoutChildren(p) === undefined;
    }
    case 'UnknownAnchor':
      return anchorOf(target.placement) === r.error.anchor;
    default:
      return false;
  }
};

const runs = { numRuns: 400 };

describe('Placement properties', () => {
  it('placeOp: emitted ops apply to the declared order; refusals mirror the apply engine', () => {
    fc.assert(
      fc.property(
        treeArb.chain((t) => targetArb(t).map((target) => ({ t, target }))),
        ({ t, target }) => placeCorresponds(t, target),
      ),
      runs,
    );
  });

  it('moveOp: emitted ops apply to the declared order; refusals mirror the apply engine', () => {
    fc.assert(
      fc.property(
        treeArb.chain((t) =>
          fc.tuple(pickArb(t), targetArb(t)).map(([moved, target]) => ({ t, moved, target })),
        ),
        ({ t, moved, target }) => moveCorresponds(t, moved, target),
      ),
      runs,
    );
  });

  it('canPlace agrees with moveOp verdict-for-verdict', () => {
    fc.assert(
      fc.property(
        treeArb.chain((t) =>
          fc.tuple(pickArb(t), targetArb(t)).map(([moved, target]) => ({ t, moved, target })),
        ),
        ({ t, moved, target }) => canPlaceAgreesWithMoveOp(t, moved, target),
      ),
      runs,
    );
  });

  it('nudgeOp: the swap lands where declared; refusals are honest', () => {
    fc.assert(
      fc.property(
        treeArb.chain((t) =>
          fc
            .tuple(pickArb(t), fc.integer({ min: -2, max: 2 }))
            .map(([node, delta]) => ({ t, node, delta })),
        ),
        ({ t, node, delta }) => nudgeCorresponds(t, node, delta),
      ),
      runs,
    );
  });

  it('duplicateOp: never collides, grows by exactly the subtree, clones the shape', () => {
    fc.assert(
      fc.property(
        treeArb.chain((t) =>
          fc.tuple(pickArb(t), targetArb(t)).map(([source, target]) => ({ t, source, target })),
        ),
        ({ t, source, target }) => duplicateCorresponds(t, source, target),
      ),
      runs,
    );
  });

  it('pasteOp: colliding ids remap, non-colliding ids survive, no duplicates', () => {
    fc.assert(
      fc.property(
        fc
          .tuple(treeArb, treeArb)
          .chain(([tA, tB]) =>
            fc
              .tuple(pickArb(tA), targetArb(tB))
              .map(([source, target]) => ({ tA, tB, source, target })),
          ),
        ({ tA, tB, source, target }) => pasteCorresponds(tA, tB, source, target),
      ),
      runs,
    );
  });
});
