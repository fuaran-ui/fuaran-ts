import { describe, expect, it } from 'vitest';

import type { TreeIntrospection } from '@fuaran-ui/ai-tools';

import { findIntrospection, flattenTree } from '../src/panel/treeModel.js';

// Phase 1547 — `text` is the per-node text-slot array; these fixtures carry no
// text slots, so the honest value is an empty list rather than an omission.
const leaf = (id: string, kind: string): TreeIntrospection => ({
  id,
  kind,
  bindings: [],
  text: [],
  childIds: [],
  children: [],
});

const tree: TreeIntrospection = {
  id: 'dash',
  kind: 'Dashboard',
  bindings: [
    {
      slot: 'Source',
      expression: '$queries.sales',
      source: 'Query',
      dependsOn: ['query:sales'],
    },
  ],
  text: [],
  childIds: ['left', 'right'],
  children: [
    {
      id: 'left',
      kind: 'Card',
      bindings: [],
      text: [],
      childIds: ['left-text'],
      children: [leaf('left-text', 'Markdown')],
    },
    leaf('right', 'Markdown'),
  ],
};

describe('flattenTree', () => {
  it('flattens depth-first with depths, kinds, and binding counts', () => {
    const rows = flattenTree(tree, new Set());
    expect(rows.map((r) => `${r.depth}:${r.id}`)).toEqual([
      '0:dash',
      '1:left',
      '2:left-text',
      '1:right',
    ]);
    expect(rows[0]?.bindingCount).toBe(1);
    expect(rows[0]?.hasChildren).toBe(true);
    expect(rows[3]?.hasChildren).toBe(false);
  });

  it('a collapsed node keeps its row but hides its descendants', () => {
    const rows = flattenTree(tree, new Set(['left']));
    expect(rows.map((r) => r.id)).toEqual(['dash', 'left', 'right']);
    expect(rows[1]?.collapsed).toBe(true);
  });
});

describe('findIntrospection', () => {
  it('finds nested nodes and misses absent ids', () => {
    expect(findIntrospection(tree, 'left-text')?.kind).toBe('Markdown');
    expect(findIntrospection(tree, 'nope')).toBeUndefined();
  });
});
