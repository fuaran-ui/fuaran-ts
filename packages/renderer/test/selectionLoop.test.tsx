// ============================================================================
//  @fuaran-ui/renderer — the selection loop (Phase 427).
//
//  Parity-locked behavioural cases shared with the F# renderer: a DECODED
//  field-named grid (Phase 425) with `onRowClick` omitted writes the clicked
//  row to the host selection seam (`runtime.setSelection`) under its own
//  NodeId; a host that re-renders with the updated `sources.selections` sees
//  the loop close — the clicked row gains the selected visual state and a
//  decoded `Binding.Selection` reader (identity accessor) resolves to the
//  stored row. A present `onRowClick` closure wins and never touches the seam.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';
import { tryResolve } from '../src/bindings.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The canonical AI-authored master-detail wire (the decoded path end-to-end):
// a field-named grid over an embedded 2-row Transform table, `onRowClick`
// omitted, `rowKeyField` for stable identity — plus a detail Metric bound to
// the grid's selection.
const masterDetailWire = JSON.stringify({
  id: 'root',
  kind: {
    // Phase 673 unified the four container near-synonyms (Stack / GridLayout /
    // Dashboard / Card) into Box and retired the superseded-kind-name
    // leniency, so `$type: 'Stack'` has not decoded since that commit and
    // every test in this file failed at "unknown NodeKind discriminator".
    // Canonical form per wire-format-fixtures/nodes/stack-1.json.
    $type: 'Box',
    layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
    role: 'Group',
    children: [
      {
        id: 'orders-grid',
        kind: {
          $type: 'DataGrid',
          columns: [
            {
              field: 'dept',
              format: { $type: 'None' },
              kind: { $type: 'Text' },
              label: 'Dept',
              width: { $type: 'Auto' },
            },
            {
              field: 'amount',
              format: { $type: 'None' },
              kind: { $type: 'Text' },
              label: 'Amount',
              width: { $type: 'Auto' },
            },
          ],
          editable: false,
          rowKeyField: 'dept',
          source: {
            $type: 'Transform',
            pipeline: [],
            source: {
              columns: {
                amount: { validity: [true, true], values: [100, 200] },
                dept: { validity: [true, true], values: ['eng', 'ops'] },
              },
              schema: [
                { name: 'dept', type: 'string' },
                { name: 'amount', type: 'int' },
              ],
            },
          },
        },
      },
      {
        id: 'detail',
        kind: {
          $type: 'Metric',
          emphasis: 'Normal',
          format: { $type: 'None' },
          label: { $type: 'Literal', text: 'Selected' },
          value: { $type: 'Selection', nodeId: 'orders-grid' },
          tone: 'Default',
          weight: 'Standard',
        },
      },
    ],
    orientation: 'Vertical',
    wrap: false,
  },
});

const decodedTree = (): Node<unknown> => {
  const decoded = decodeNode(masterDetailWire);
  if (!decoded.ok) throw new Error(`decode failed: ${decoded.error.message}`);
  return decoded.value;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (
  tree: Node<unknown>,
  runtime: FuaranRuntime,
  sources?: BindingSources,
): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={tree} runtime={runtime} sources={sources ?? {}} />);
  });
  return container;
};

const rerender = async (
  tree: Node<unknown>,
  runtime: FuaranRuntime,
  sources: BindingSources,
): Promise<void> => {
  await act(async () => {
    root!.render(<FuaranRenderer tree={tree} runtime={runtime} sources={sources} />);
  });
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

describe('selection loop (Phase 427)', () => {
  it('a decoded handler-free grid row click writes runtime.setSelection under its NodeId', async () => {
    const setSelection = vi.fn();
    const el = await mount(decodedTree(), { setSelection });

    const gridRows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row')];
    expect(gridRows.length).toBe(2);
    await act(async () => gridRows[1]!.click());

    expect(setSelection).toHaveBeenCalledOnce();
    const [nodeId, row] = setSelection.mock.calls[0] as [string, unknown];
    expect(nodeId).toBe('orders-grid');
    expect(row).toMatchObject({ dept: 'ops', amount: 200 });
  });

  it('re-rendering with the written selection marks the row selected and feeds the detail reader', async () => {
    const store: Record<string, unknown> = {};
    const setSelection = vi.fn((nodeId: string, row: unknown) => {
      store[nodeId] = row;
    });
    const runtime: FuaranRuntime = { setSelection };
    const tree = decodedTree();
    const el = await mount(tree, runtime);

    const gridRows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row')];
    await act(async () => gridRows[1]!.click());

    // The host re-renders with the updated selection bag — the loop closes.
    await rerender(tree, runtime, { selections: { ...store } });

    const selected = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row-selected')];
    expect(selected.length).toBe(1);
    expect(selected[0]!.textContent).toContain('ops');

    // The decoded `Binding.Selection` (identity accessor) resolves to the
    // stored row — the 421-class accessor fix, replayed for Selection.
    const detail = tree.kind.kind === 'Layout' ? tree.kind.layout.spec.children[1] : undefined;
    expect(detail).toBeDefined();
    if (detail !== undefined && detail.kind.kind === 'Display') {
      const display = detail.kind.display;
      if (display.kind === 'Metric') {
        const resolved = tryResolve({ selections: { ...store } }, display.spec.value);
        expect(resolved).toMatchObject({ dept: 'ops', amount: 200 });
      } else {
        throw new Error('expected a Metric detail');
      }
    }
  });

  it('a decoded closure-authored onRowClick never touches the selection seam (closure wins, inert)', async () => {
    // Hand-shape the decoded form: `onRowClick` present as the inert
    // placeholder (what a `"onRowClick":"<closure>"` wire decodes to).
    const tree = decodedTree();
    if (tree.kind.kind !== 'Layout') throw new Error('expected layout root');
    const grid = tree.kind.layout.spec.children[0]!;
    if (grid.kind.kind !== 'Visualisation' || grid.kind.visualisation.kind !== 'Grid')
      throw new Error('expected grid');
    const withClosure: Node<unknown> = {
      ...grid,
      kind: {
        kind: 'Visualisation',
        visualisation: {
          kind: 'Grid',
          spec: {
            ...grid.kind.visualisation.spec,
            onRowClick: () => ({ kind: 'Chain', actions: [] }),
          },
        },
      },
    };

    const setSelection = vi.fn();
    const el = await mount(withClosure, { setSelection });

    const gridRows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row')];
    await act(async () => gridRows[0]!.click());

    expect(setSelection).not.toHaveBeenCalled();
  });
});
