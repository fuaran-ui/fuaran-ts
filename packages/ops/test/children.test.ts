// ============================================================================
//  The one child enumeration (Phase 2046) — what a node's children are, per
//  reach, and the walkers that fold over it.
// ============================================================================

import { describe, expect, it } from 'vitest';
import type { FragmentId, Node, NodeId } from '@fuaran-ui/schema';

import { allNodeIds } from '../src/apply.js';
import { children, findNode, mapChildren, Reach } from '../src/children.js';
import { ChildReach, duplicateOp, findNode as exportedFindNode, pasteOp } from '../src/index.js';
import { collectStateSeeds } from '../src/seeds.js';

type N = Node<unknown>;

const nid = (s: string): NodeId => s as NodeId;
const style = { tone: 'Default', weight: 'Standard', emphasis: 'Normal' } as const;

const leaf = (id: string): N => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: 'body' } } },
  },
  state: {},
  style,
});

const box = (id: string, cs: readonly N[]): N => ({
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
        children: cs,
      },
    },
  },
  state: {},
  style,
});

const switchNode = (id: string): N => ({
  id: nid(id),
  kind: {
    kind: 'Switch',
    spec: {
      on: { kind: 'State', key: 'tab', defaultValue: '' },
      cases: [
        { match: 'a', child: leaf('case-a') },
        { when: { kind: 'Static', value: true }, child: leaf('case-b') },
      ],
      default: leaf('dflt'),
    },
  },
  state: {},
  style,
});

const fragmentRef = (id: string): N => ({
  id: nid(id),
  kind: {
    kind: 'FragmentRef',
    spec: {
      name: 'card' as FragmentId,
      args: {
        title: { kind: 'value', value: { kind: 'str', value: 'T' } },
        body: { kind: 'slot', tree: leaf('slot-body') },
      },
    },
  },
  state: {},
  style,
});

/** Every position class at once: ordered, state arms, the envelope fallback. */
const everything = (): N => ({
  ...box('root', [switchNode('sw'), fragmentRef('ref')]),
  state: { onLoading: leaf('loading'), onEmpty: leaf('empty') },
  fallback: leaf('fb'),
});

const ids = (ns: readonly N[]): string[] => ns.map((n) => n.id as string);

describe('children — one slot list, explicit reach', () => {
  it('structural reaches the ordered list alone', () => {
    expect(ids(children(everything(), Reach.structural))).toEqual(['sw', 'ref']);
  });

  it('kindHeld adds the arms, not the state alternatives', () => {
    expect(ids(children(switchNode('sw'), Reach.kindHeld))).toEqual(['case-a', 'case-b', 'dflt']);
    expect(ids(children(everything(), Reach.kindHeld))).toEqual(['sw', 'ref']);
  });

  it('lookup adds state.onLoading / state.onEmpty, in that order', () => {
    expect(ids(children(everything(), Reach.lookup))).toEqual(['sw', 'ref', 'loading', 'empty']);
  });

  it('all adds the envelope fallback and slot arguments', () => {
    expect(ids(children(everything(), Reach.all))).toEqual(['sw', 'ref', 'loading', 'empty', 'fb']);
    expect(ids(children(fragmentRef('ref'), Reach.all))).toEqual(['slot-body']);
    expect(ids(children(fragmentRef('ref'), Reach.lookup))).toEqual([]);
  });

  it('is exported from the package index under its public names', () => {
    expect(ChildReach.lookup).toBe(Reach.lookup);
    expect(exportedFindNode).toBe(findNode);
  });
});

describe('mapChildren', () => {
  const rename = (n: N): N => ({ ...n, id: nid(`x-${n.id}`) });

  it('returns the input node when nothing changed', () => {
    const t = everything();
    expect(mapChildren(t, Reach.all, (c) => c)).toBe(t);
  });

  it('rewrites exactly the positions in reach, preserving the rest', () => {
    const t = mapChildren(everything(), Reach.lookup, rename);
    expect(ids(children(t, Reach.all))).toEqual(['x-sw', 'x-ref', 'x-loading', 'x-empty', 'fb']);
  });

  it('keeps a Switch case match / when through a rebuild', () => {
    const t = mapChildren(switchNode('sw'), Reach.kindHeld, rename);
    if (t.kind.kind !== 'Switch') throw new Error('kind changed');
    expect(t.kind.spec.cases[0]!.match).toBe('a');
    expect(t.kind.spec.cases[1]!.when).toEqual({ kind: 'Static', value: true });
    expect(t.kind.spec.on).toEqual({ kind: 'State', key: 'tab', defaultValue: '' });
    expect(ids(children(t, Reach.kindHeld))).toEqual(['x-case-a', 'x-case-b', 'x-dflt']);
  });

  it('keeps value arguments and rewrites slot arguments', () => {
    const t = mapChildren(fragmentRef('ref'), Reach.all, rename);
    if (t.kind.kind !== 'FragmentRef') throw new Error('kind changed');
    expect(t.kind.spec.args['title']).toEqual({
      kind: 'value',
      value: { kind: 'str', value: 'T' },
    });
    expect(ids(children(t, Reach.all))).toEqual(['x-slot-body']);
  });

  it('enumerates the positions once per call, however wide the node', () => {
    // The clone remap used to re-enumerate a node's slots once per index, each
    // pass allocating a rebuild per child: quadratic in the width. Count reads
    // of the children list through a getter.
    let reads = 0;
    const kids = Array.from({ length: 200 }, (_, i) => leaf(`k${i}`));
    const base = box('wide', kids);
    if (base.kind.kind !== 'Layout') throw new Error('unreachable');
    const spec = { ...base.kind.layout.spec };
    Object.defineProperty(spec, 'children', {
      enumerable: true,
      get: () => {
        reads += 1;
        return kids;
      },
    });
    const wide: N = {
      ...base,
      kind: { kind: 'Layout', layout: { ...base.kind.layout, spec } as typeof base.kind.layout },
    };
    // Paste it into a tree that already holds the id `wide` (and none of its
    // children's ids), so the remap rewrites the root and leaves every child
    // unchanged — the case where the old walk re-enumerated per index.
    const target = box('root', [leaf('wide')]);
    const r = pasteOp(target, wide, { parentId: nid('root'), placement: { kind: 'Last' } });
    expect(r.ok).toBe(true);
    expect(reads).toBeLessThan(20);
  });
});

describe('the walks fold over the enumeration', () => {
  it('findNode finds a node held under state.onEmpty (tree first)', () => {
    const t = box('root', [{ ...leaf('grid'), state: { onEmpty: leaf('none-yet') } }]);
    expect(findNode(t, 'none-yet')?.id).toBe('none-yet');
    expect(allNodeIds(t)).toEqual(['root', 'grid', 'none-yet']);
  });

  it('the clone remap rewrites an id inside a state alternative', () => {
    const t = box('root', [{ ...leaf('grid'), state: { onEmpty: leaf('none-yet') } }]);
    const r = duplicateOp(t, nid('grid'), { parentId: nid('root'), placement: { kind: 'Last' } });
    if (!r.ok) throw new Error(`refused: ${JSON.stringify(r.error)}`);
    const op = r.value;
    if (op.kind !== 'InsertChild') throw new Error(`unexpected op ${op.kind}`);
    const cloneIds = allNodeIds(op.child as N);
    expect(cloneIds).toHaveLength(2);
    expect(cloneIds.some((i) => i === 'grid' || i === 'none-yet')).toBe(false);
  });

  it('the seeding pass still reaches a declaration in a slot argument and a fallback', () => {
    const declaring = (id: string, key: string): N =>
      ({
        id: nid(id),
        kind: {
          kind: 'Display',
          display: {
            kind: 'Markdown',
            spec: { text: { kind: 'Bound', binding: { kind: 'State', key, defaultValue: 'v' } } },
          },
        },
        state: {},
        style,
      }) as unknown as N;
    const ref: N = {
      ...fragmentRef('ref'),
      kind: {
        kind: 'FragmentRef',
        spec: {
          name: 'card' as FragmentId,
          args: { body: { kind: 'slot', tree: declaring('in-slot', 'slotKey') } },
        },
      },
    };
    const t: N = { ...box('root', [ref]), fallback: declaring('fb', 'fallbackKey') };
    const seeds = collectStateSeeds(t);
    expect(seeds['slotKey']).toBe('v');
    expect(seeds['fallbackKey']).toBe('v');
  });
});
