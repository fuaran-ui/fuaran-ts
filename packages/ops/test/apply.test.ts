// ============================================================================
//  Apply-engine semantic tests.
//
//  Covers every TreeOp variant against a small in-memory tree, asserting the
//  same final-tree state the F# Fuaran.UI.Ops.Apply engine produces (the F#
//  acceptance tests in Fuaran.UI.Ops.Tests are the reference). Decode-driven:
//  ops + nodes are built from the corpus wire forms via the codec, so this
//  exercises decode → apply → encode end to end.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { apply, encodeNode } from '../src/index.js';
import type { Node, NodeId } from '@fuaran-ui/schema';
import type { TreeOp } from '../src/treeOp.js';

const nid = (s: string): NodeId => s as NodeId;

const leaf = (id: string, text: string): Node<unknown> => ({
  id: nid(id),
  kind: {
    kind: 'Display',
    display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: text } } },
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

const tree = (): Node<unknown> => dashboard('root', [leaf('a', 'A'), leaf('b', 'B')]);

const childIds = (n: Node<unknown>): string[] =>
  n.kind.kind === 'Layout' ? n.kind.layout.spec.children.map((c) => c.id as string) : [];

describe('apply engine — structural ops', () => {
  it('InsertChild inserts at position', () => {
    const r = apply(tree(), {
      kind: 'InsertChild',
      parentId: nid('root'),
      position: 1,
      child: leaf('c', 'C'),
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIds(r.value.newTree)).toEqual(['a', 'c', 'b']);
  });

  it('InsertChild rejects an out-of-range position', () => {
    const r = apply(tree(), {
      kind: 'InsertChild',
      parentId: nid('root'),
      position: 9,
      child: leaf('c', 'C'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PositionOutOfRange');
  });

  it('InsertChild rejects a duplicate NodeId', () => {
    const r = apply(tree(), {
      kind: 'InsertChild',
      parentId: nid('root'),
      position: 0,
      child: leaf('a', 'dup'),
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('DuplicateNodeId');
  });

  it('RemoveNode removes a child', () => {
    const r = apply(tree(), { kind: 'RemoveNode', target: nid('a') });
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIds(r.value.newTree)).toEqual(['b']);
  });

  it('RemoveNode cannot remove the root', () => {
    const r = apply(tree(), { kind: 'RemoveNode', target: nid('root') });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('KindMismatch');
  });

  it('ReorderChildren permutes the children', () => {
    const r = apply(tree(), {
      kind: 'ReorderChildren',
      parentId: nid('root'),
      newOrder: [nid('b'), nid('a')],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIds(r.value.newTree)).toEqual(['b', 'a']);
  });

  it('ReorderChildren rejects a non-permutation', () => {
    const r = apply(tree(), {
      kind: 'ReorderChildren',
      parentId: nid('root'),
      newOrder: [nid('a')],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('OrderingMismatch');
  });

  it('MoveNode relocates into a nested layout', () => {
    const nested = dashboard('root', [leaf('a', 'A'), dashboard('box', [])]);
    const r = apply(nested, {
      kind: 'MoveNode',
      target: nid('a'),
      newParentId: nid('box'),
      newPosition: 0,
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(childIds(r.value.newTree)).toEqual(['box']);
      const box = (r.value.newTree.kind.kind === 'Layout' &&
        r.value.newTree.kind.layout.spec.children[0]) as Node<unknown>;
      expect(childIds(box)).toEqual(['a']);
    }
  });

  it('MoveNode refuses to create a cycle', () => {
    const nested = dashboard('root', [dashboard('box', [leaf('a', 'A')])]);
    const r = apply(nested, {
      kind: 'MoveNode',
      target: nid('box'),
      newParentId: nid('a'),
      newPosition: 0,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('KindMismatch');
  });
});

describe('apply engine — field / binding / style / state ops', () => {
  it('EditNode swaps a node kind wholesale', () => {
    const op: TreeOp<unknown> = {
      kind: 'EditNode',
      target: nid('a'),
      newKind: {
        kind: 'Display',
        display: {
          kind: 'Heading',
          spec: { level: 1, text: { kind: 'Literal', value: 'H' }, variant: 'Standard' },
        },
      },
    };
    const r = apply(tree(), op);
    expect(r.ok).toBe(true);
  });

  it('UpdateProp updates a top-level field', () => {
    const kpi: Node<unknown> = {
      id: nid('k'),
      kind: {
        kind: 'Display',
        display: {
          kind: 'Heading',
          spec: { level: 2, text: { kind: 'Literal', value: 'x' }, variant: 'Standard' },
        },
      },
      state: {},
      style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
    };
    const r = apply(dashboard('root', [kpi]), {
      kind: 'UpdateProp',
      target: nid('k'),
      path: 'Level',
      value: 4,
    });
    expect(r.ok).toBe(true);
  });

  it('UpdateProp rejects a nested path on a kind without a nested surface', () => {
    const r = apply(tree(), {
      kind: 'UpdateProp',
      target: nid('a'),
      path: 'Text.value',
      value: 'z',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PathNotSupportedYet');
  });

  it('UpdateStyle replaces the node style', () => {
    const r = apply(tree(), {
      kind: 'UpdateStyle',
      target: nid('a'),
      style: { tone: 'Brand', weight: 'Spacious', emphasis: 'Loud' },
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const a =
        r.value.newTree.kind.kind === 'Layout'
          ? r.value.newTree.kind.layout.spec.children[0]
          : undefined;
      expect(a?.style.tone).toBe('Brand');
    }
  });

  it('UpdateState replaces the node state', () => {
    const r = apply(tree(), { kind: 'UpdateState', target: nid('a'), state: {} });
    expect(r.ok).toBe(true);
  });

  it('ReplaceBinding swaps a typed binding slot', () => {
    const kpi: Node<unknown> = {
      id: nid('k'),
      kind: {
        kind: 'Display',
        display: {
          kind: 'Metric',
          spec: {
            label: { kind: 'Literal', value: 'L' },
            value: { kind: 'Static', value: 1 },
            format: { kind: 'None' },
            tone: 'Default',
            weight: 'Standard',
            emphasis: 'Normal',
          },
        },
      },
      state: {},
      style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
    };
    const r = apply(dashboard('root', [kpi]), {
      kind: 'ReplaceBinding',
      target: nid('k'),
      slot: 'Value',
      binding: { kind: 'Static', value: 99 },
    });
    expect(r.ok).toBe(true);
  });

  it('ReplaceBinding rejects an unknown slot', () => {
    const r = apply(tree(), {
      kind: 'ReplaceBinding',
      target: nid('a'),
      slot: 'Nope',
      binding: { kind: 'Static', value: 1 },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('SlotNotFound');
  });

  it('targets that do not exist surface NodeNotFound', () => {
    const r = apply(tree(), {
      kind: 'UpdateStyle',
      target: nid('ghost'),
      style: { tone: 'Brand', weight: 'Standard', emphasis: 'Normal' },
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('NodeNotFound');
  });
});

describe('apply engine — Batch atomicity', () => {
  it('applies all ops in order on success', () => {
    const op: TreeOp<unknown> = {
      kind: 'Batch',
      ops: [
        { kind: 'InsertChild', parentId: nid('root'), position: 2, child: leaf('c', 'C') },
        { kind: 'RemoveNode', target: nid('a') },
      ],
    };
    const r = apply(tree(), op);
    expect(r.ok).toBe(true);
    if (r.ok) expect(childIds(r.value.newTree)).toEqual(['b', 'c']);
  });

  it('aborts the whole batch on any inner failure (all-or-nothing)', () => {
    const op: TreeOp<unknown> = {
      kind: 'Batch',
      ops: [
        { kind: 'RemoveNode', target: nid('a') },
        { kind: 'RemoveNode', target: nid('ghost') },
      ],
    };
    const r = apply(tree(), op);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('BatchAborted');
      expect(r.error.batchIndex).toBe(1);
    }
  });
});

describe('apply engine — nested paths (Phase 364)', () => {
  const grid = (): Node<unknown> => ({
    id: nid('channel-grid'),
    kind: {
      kind: 'Visualisation',
      visualisation: {
        kind: 'Grid',
        spec: {
          source: { kind: 'Static', value: [] },
          rowKey: () => '',
          columns: [
            {
              label: 'Channel',
              value: () => ({ kind: 'Text', value: '' }),
              format: { kind: 'None' },
              kind: { kind: 'Text' },
              width: { kind: 'Auto' },
            },
            {
              label: 'Spend',
              value: () => ({ kind: 'Text', value: '' }),
              format: { kind: 'None' },
              kind: { kind: 'Text' },
              width: { kind: 'Auto' },
            },
          ],
          editable: false,
        },
      },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
  });

  const chart = (): Node<unknown> => ({
    id: nid('mix-chart'),
    kind: {
      kind: 'Visualisation',
      visualisation: {
        kind: 'Chart',
        spec: {
          source: { kind: 'Static', value: [] },
          kind: 'Line',
          xField: 'month',
          yFields: ['revenue', 'cost'],
          stacked: false,
        },
      },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
  });

  const tabs = (): Node<unknown> => ({
    id: nid('analysis-tabs'),
    kind: {
      kind: 'Layout',
      layout: {
        kind: 'Tabs',
        spec: {
          orientation: 'Horizontal',
          children: [leaf('tab-a', 'A'), leaf('tab-b', 'B')],
          activeIndex: { kind: 'Static', value: 0 },
          onSelect: () => ({ kind: 'Chain', actions: [] }),
          tabHeaders: [
            { label: { kind: 'Literal', value: 'Overview' } },
            { label: { kind: 'Literal', value: 'Detail' } },
          ],
        },
      },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
  });

  const form = (): Node<unknown> => ({
    id: nid('signup-form'),
    kind: {
      kind: 'Input',
      input: {
        kind: 'Form',
        spec: {
          fields: [
            {
              id: 'name',
              label: { kind: 'Literal', value: 'Name' },
              kind: {
                kind: 'Text',
                value: { kind: 'Static', value: '' },
                onChange: () => ({ kind: 'Chain', actions: [] }),
              },
              required: false,
            },
          ],
          onSubmit: { kind: 'Chain', actions: [] },
          submitLabel: { kind: 'Literal', value: 'Submit' },
        },
      },
    },
    state: {},
    style: { tone: 'Default', weight: 'Standard', emphasis: 'Normal' },
  });

  const gridColumns = (n: Node<unknown>) =>
    n.kind.kind === 'Visualisation' && n.kind.visualisation.kind === 'Grid'
      ? n.kind.visualisation.spec.columns
      : [];

  it("UpdateProp 'Columns[0].Label' renames a grid column", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[0].Label',
      value: 'Sales channel',
    });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(gridColumns(r.value.newTree)[0]?.label).toBe('Sales channel');
      expect(gridColumns(r.value.newTree)[1]?.label).toBe('Spend');
    }
  });

  it("UpdateProp 'Columns[0].Width' writes a typed ColumnWidth from the wire shape", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[0].Width',
      value: { $type: 'Fixed', pixels: 120 },
    });
    expect(r.ok).toBe(true);
    if (r.ok)
      expect(gridColumns(r.value.newTree)[0]?.width).toEqual({ kind: 'Fixed', pixels: 120 });
  });

  it("UpdateProp 'Columns[9].Label' rejects with PositionOutOfRange", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[9].Label',
      value: 'X',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PositionOutOfRange');
  });

  it("UpdateProp 'Columns[0].Nope' rejects with FieldNotFound naming the sub-paths", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[0].Nope',
      value: 'X',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe('FieldNotFound');
      expect(r.error.message).toContain('Label, Format, Width');
    }
  });

  it("UpdateProp 'Columns[x].Label' (bad index literal) rejects with PathInvalid", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[x].Label',
      value: 'X',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PathInvalid');
  });

  it("UpdateProp 'Columns.Label' (list segment without index) rejects with PathInvalid", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns.Label',
      value: 'X',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PathInvalid');
  });

  it("UpdateProp 'Columns[0].Kind' (closure-bearing leaf) rejects with PathNotSupportedYet", () => {
    const r = apply(grid(), {
      kind: 'UpdateProp',
      target: nid('channel-grid'),
      path: 'Columns[0].Kind',
      value: 'Text',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PathNotSupportedYet');
  });

  it("UpdateProp 'YFields[1]' rewrites an indexed scalar leaf", () => {
    const r = apply(chart(), {
      kind: 'UpdateProp',
      target: nid('mix-chart'),
      path: 'YFields[1]',
      value: 'profit',
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.newTree.kind.kind === 'Visualisation') {
      const v = r.value.newTree.kind.visualisation;
      if (v.kind === 'Chart') expect(v.spec.yFields).toEqual(['revenue', 'profit']);
    }
  });

  it("UpdateProp 'TabHeaders[1].Label' renames the second tab header", () => {
    const r = apply(tabs(), {
      kind: 'UpdateProp',
      target: nid('analysis-tabs'),
      path: 'TabHeaders[1].Label',
      value: { $type: 'Literal', text: 'Breakdown' },
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.newTree.kind.kind === 'Layout') {
      const l = r.value.newTree.kind.layout;
      if (l.kind === 'Tabs')
        expect(l.spec.tabHeaders?.[1]?.label).toEqual({ kind: 'Literal', value: 'Breakdown' });
    }
  });

  it("UpdateProp 'Fields[0].Required' flips a form field's required flag", () => {
    const r = apply(form(), {
      kind: 'UpdateProp',
      target: nid('signup-form'),
      path: 'Fields[0].Required',
      value: true,
    });
    expect(r.ok).toBe(true);
    if (r.ok && r.value.newTree.kind.kind === 'Input') {
      const i = r.value.newTree.kind.input;
      if (i.kind === 'Form') expect(i.spec.fields[0]?.required).toBe(true);
    }
  });
});

describe('apply engine — telemetry', () => {
  it('emits one telemetry record per applied leaf op', () => {
    const r = apply(tree(), { kind: 'RemoveNode', target: nid('a') });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.emittedTelemetry).toHaveLength(1);
      expect(r.value.emittedTelemetry[0]).toMatchObject({ op: 'RemoveNode', targetId: 'a' });
    }
  });
});

describe('apply engine — does not mutate the input tree', () => {
  it('leaves the original tree untouched after a successful op', () => {
    const original = tree();
    const before = encodeNode(original);
    apply(original, { kind: 'RemoveNode', target: nid('a') });
    expect(encodeNode(original)).toBe(before);
  });
});
