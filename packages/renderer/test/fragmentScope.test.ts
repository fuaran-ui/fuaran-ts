// ============================================================================
//  Fragment collection and namespacing descend through the state alternatives
//  (Phase 2046) — both fold over the shared child enumeration at
//  `ChildReach.lookup` in `@fuaran-ui/ops`.
// ============================================================================

import { describe, expect, it } from 'vitest';
import { children, ChildReach } from '@fuaran-ui/ops';
import type { FragmentId, Node, NodeId } from '@fuaran-ui/schema';

import { collectFragments, namespaceNode } from '../src/index.js';

type N = Node<unknown>;

const style = { tone: 'Default', weight: 'Standard', emphasis: 'Normal' } as const;

const md = (id: string): N => ({
  id: id as NodeId,
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: id } } },
  },
  state: {},
  style,
});

const decl = (id: string, name: string, body: N): N => ({
  id: id as NodeId,
  kind: {
    kind: 'FragmentDecl',
    spec: {
      name: name as FragmentId,
      body,
      holes: [],
      effect: { hostEffect: 'Pure', determinism: 'Deterministic' },
    },
  },
  state: {},
  style,
});

const allIds = (n: N): string[] => [
  n.id as string,
  ...children(n, ChildReach.lookup).flatMap((c) => allIds(c)),
];

describe('collectFragments', () => {
  it('registers a FragmentDecl held in state.onLoading', () => {
    const tree: N = { ...md('host'), state: { onLoading: decl('d', 'tpl', md('inner')) } };
    const found = collectFragments(new Map<string, N>(), tree);
    expect([...found.keys()]).toEqual(['tpl']);
  });

  it('registers a FragmentDecl held in state.onEmpty', () => {
    const tree: N = { ...md('host'), state: { onEmpty: decl('d', 'tpl', md('inner')) } };
    expect(collectFragments(new Map<string, N>(), tree).has('tpl')).toBe(true);
  });
});

describe('namespaceNode', () => {
  it('prefixes every id in a body, the state alternatives included', () => {
    const body: N = {
      ...md('grid'),
      state: { onEmpty: md('none-yet'), onLoading: md('wait') },
    };
    const a = namespaceNode('ref1.', body);
    const b = namespaceNode('ref2.', body);
    expect(a.state.onEmpty?.id).toBe('ref1.none-yet');
    expect(a.state.onLoading?.id).toBe('ref1.wait');
    expect(allIds(a)).toEqual(['ref1.grid', 'ref1.wait', 'ref1.none-yet']);
    // Two references to one fragment share no id anywhere in their subtrees.
    const shared = allIds(a).filter((id) => allIds(b).includes(id));
    expect(shared).toEqual([]);
  });

  it('keeps the state behaviour it does not rewrite', () => {
    const onError = () => md('err');
    const body: N = { ...md('grid'), state: { onEmpty: md('none-yet'), onError } };
    expect(namespaceNode('r.', body).state.onError).toBe(onError);
  });
});
