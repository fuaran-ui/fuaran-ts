// ============================================================================
//  Introspection tests — kindName, the per-kind binding-slot table, the
//  wire-form binding expressions, getNodeState / findNodes / inspectTree.
//  Asserts the shapes match the F# AiTools tier for the same fixture tree.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { decodeNode } from '@fuaran-ui/ops';
import type { Binding, Node, NodeId, SemanticStyle, StateBehaviour } from '@fuaran-ui/schema';

import {
  bindingExpression,
  extractBindingSlots,
  findNodes,
  getNodeState,
  inspectTree,
  kindName,
  walkNodes,
} from '../src/index.js';

const nid = (s: string): NodeId => s as NodeId;
const emptyState: StateBehaviour<unknown> = {};
const defaultStyle: SemanticStyle = { tone: 'Default', weight: 'Standard', emphasis: 'Normal' };
const stateBinding = (key: string): Binding<number> => ({ kind: 'State', key, defaultValue: 0 });

const metric = (id: string, source: Binding<number>): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: {
      kind: 'Metric',
      spec: {
        label: { kind: 'Literal', value: 'L' },
        value: source,
        format: { kind: 'None' },
        tone: 'Default',
        weight: 'Standard',
        emphasis: 'Normal',
      },
    },
  },
  state: emptyState,
  style: defaultStyle,
});

const button = (id: string, disabled?: Binding<boolean>): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Input',
    input: {
      kind: 'Button',
      spec: {
        label: { kind: 'Literal', value: 'Go' },
        onClick: { kind: 'Dispatch', msg: undefined },
        variant: 'Primary',
        ...(disabled !== undefined ? { disabled } : {}),
      },
    },
  },
  state: emptyState,
  style: defaultStyle,
});

// Phase 390 — the unified container; a dashboard is a Box with Auto/Dashboard.
const dashboard = (id: string, children: readonly Node<unknown>[]): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Layout',
    layout: { kind: 'Box', spec: { layout: { kind: 'Auto' }, role: 'Dashboard', children } },
  },
  state: emptyState,
  style: defaultStyle,
});

describe('kindName — matches F# Introspect.kindName', () => {
  it('returns the in-memory case name for most kinds', () => {
    expect(kindName(metric('m', stateBinding('x')).kind)).toBe('Metric');
    expect(kindName(button('b').kind)).toBe('Button');
    // Phase 390 — every layout container tags as 'Box' (mirrors F# Kind.name).
    expect(kindName(dashboard('d', []).kind)).toBe('Box');
  });
  it('returns Box for the layout container and Grid for the visualisation grid', () => {
    const layoutGrid: Node<unknown> = {
      id: nid('g'),
      kind: {
        kind: 'Layout',
        layout: {
          kind: 'Box',
          spec: { layout: { kind: 'Grid', cols: 2 }, role: 'Group', children: [] },
        },
      },
      state: emptyState,
      style: defaultStyle,
    };
    const visGrid: Node<unknown> = {
      id: nid('vg'),
      kind: {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Grid',
          spec: {
            source: { kind: 'Static', value: [] },
            rowKey: () => '',
            columns: [],
            editable: false,
            reorderable: false,
          },
        },
      },
      state: emptyState,
      style: defaultStyle,
    };
    expect(kindName(layoutGrid.kind)).toBe('Box');
    expect(kindName(visGrid.kind)).toBe('Grid');
  });
});

describe('bindingExpression — wire-form per Binding case', () => {
  it('maps every case to the canonical expression', () => {
    expect(bindingExpression({ kind: 'Static', value: 1 })).toEqual({
      source: 'Static',
      expression: '$static',
    });
    expect(bindingExpression({ kind: 'Query', name: 'orders', accessor: (x) => x })).toEqual({
      source: 'Query',
      expression: '$queries.orders',
    });
    expect(bindingExpression({ kind: 'Filter', name: 'region' })).toEqual({
      source: 'Filter',
      expression: '$filters.region',
    });
    expect(
      bindingExpression({ kind: 'Selection', nodeId: nid('grid'), accessor: (x) => x }),
    ).toEqual({
      source: 'Selection',
      expression: '$selection.grid',
    });
    expect(bindingExpression({ kind: 'State', key: 'count', defaultValue: 0 })).toEqual({
      source: 'State',
      expression: '$state.count',
    });
    expect(bindingExpression({ kind: 'Computed', compute: () => 1 })).toEqual({
      source: 'Computed',
      expression: '$computed',
    });
    expect(bindingExpression({ kind: 'I18n', key: 'greeting' })).toEqual({
      source: 'I18n',
      expression: '$i18n.greeting',
    });
  });
});

describe('extractBindingSlots — the per-kind table', () => {
  it('reports Metric.Value and adds Trend only when present', () => {
    expect(extractBindingSlots(metric('m', stateBinding('rev')).kind).map((s) => s.slot)).toEqual([
      'Value',
    ]);
    const withTrend: Node<unknown> = {
      ...metric('m', stateBinding('rev')),
      kind: {
        kind: 'Display',
        display: {
          kind: 'Metric',
          spec: {
            label: { kind: 'Literal', value: 'L' },
            value: stateBinding('rev'),
            format: { kind: 'None' },
            tone: 'Default',
            weight: 'Standard',
            emphasis: 'Normal',
            trend: stateBinding('delta'),
          },
        },
      },
    };
    expect(extractBindingSlots(withTrend.kind).map((s) => s.slot)).toEqual(['Value', 'Trend']);
  });
  it('reports Button.Disabled only when bound', () => {
    expect(extractBindingSlots(button('b').kind)).toEqual([]);
    expect(
      extractBindingSlots(button('b', { kind: 'State', key: 'busy', defaultValue: false }).kind),
    ).toEqual([{ slot: 'Disabled', expression: '$state.busy', source: 'State' }]);
  });
});

describe('getNodeState / findNodes / inspectTree', () => {
  const tree = dashboard('root', [
    metric('rev', stateBinding('revenue')),
    button('go', { kind: 'State', key: 'busy', defaultValue: false }),
  ]);

  it('getNodeState returns the kind, bindings, and childIds', () => {
    expect(getNodeState(tree, 'rev')).toEqual({
      id: 'rev',
      kind: 'Metric',
      bindings: [{ slot: 'Value', expression: '$state.revenue', source: 'State' }],
      childIds: [],
    });
    expect(getNodeState(tree, 'root')?.childIds).toEqual(['rev', 'go']);
    expect(getNodeState(tree, 'absent')).toBeUndefined();
  });

  it('findNodes returns every node matching a predicate', () => {
    expect(findNodes(tree, (n) => n.kind.kind === 'Input').map((n) => n.id)).toEqual(['go']);
    expect(walkNodes(tree).map((n) => n.id as string)).toEqual(['root', 'rev', 'go']);
  });

  it('inspectTree produces a recursive structural snapshot', () => {
    const snapshot = inspectTree(tree);
    expect(snapshot.id).toBe('root');
    expect(snapshot.children.map((c) => c.id)).toEqual(['rev', 'go']);
    expect(snapshot.children[1]!.bindings[0]).toEqual({
      slot: 'Disabled',
      expression: '$state.busy',
      source: 'State',
    });
  });
});

describe('introspection over a decoded corpus fixture', () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

  it('introspects a real decoded Button node', () => {
    const decoded = decodeNode(readFileSync(join(nodesDir, 'btn-1.json'), 'utf8'));
    if (!decoded.ok) throw new Error('btn-1 failed to decode');
    const state = getNodeState(decoded.value, decoded.value.id as string);
    expect(state?.kind).toBe('Button');
  });
});
