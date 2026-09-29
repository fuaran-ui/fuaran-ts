// ============================================================================
//  @fuaran-ui/renderer — Phase 1909: an ACTION column offers no sort.
//
//  A `Button` / `ButtonGroup` cell draws its own label and hands the whole row
//  to its handler, so it never displays its column's `field`, and an action
//  column carries none. A pre-existing tree that still declares one keeps
//  rendering exactly as before; sort ignores the field: no sort affordance on
//  the header, and a sort descriptor naming the column leaves the authored
//  order standing. This host draws no export control, so sort is the only
//  reader to pin. Parity-locked with the F# renderer (`GridColumn.dataField`,
//  `sortableHeader`, `BindingResolver.sortRowsByDescriptor`).
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { ColumnErased, Node } from '@fuaran-ui/schema';

import { FuaranRenderer } from '../src/index.js';
import { dataFieldOf, sortRowsByDescriptor } from '../src/render/Visualisation.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const decode = (wire: string): Node<unknown> => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const mount = async (wire: string): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={decode(wire)} runtime={{}} sources={{}} />);
  });
  return container;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

/** A sortable grid: a Text column, then a Button and a ButtonGroup column that BOTH still declare a field. */
const grid = `{"id":"g","kind":{"$type":"DataGrid","columns":[{"field":"task","kind":{"$type":"Text"},"label":"Task"},{"field":"task","kind":{"$type":"Button","label":"Open"},"label":"Actions"},{"field":"task","kind":{"$type":"ButtonGroup","buttons":[{"label":"Approve"}]},"label":"Review"}],"rowKeyField":"task","sortStateKey":"s","source":{"$type":"State","defaultValue":[{"task":"Verify"},{"task":"Design"}],"key":"rows"}}}`;

const columnsOf = (tree: Node<unknown>): readonly ColumnErased<unknown>[] => {
  const k = tree.kind as {
    kind: string;
    visualisation?: { kind: string; spec: { columns: ColumnErased<unknown>[] } };
  };
  if (k.visualisation?.kind !== 'Grid') throw new Error('expected a grid');
  return k.visualisation.spec.columns;
};

describe('Phase 1909 — an action column offers no sort', () => {
  it('only the data column carries the sort affordance, and the action cells still render', async () => {
    const el = await mount(grid);
    const headers = Array.from(el.querySelectorAll('th.fuaran-grid-header'));
    expect(headers.map((h) => [h.textContent, h.hasAttribute('data-sortable')])).toEqual([
      ['Task', true],
      ['Actions', false],
      ['Review', false],
    ]);
    // The pre-existing field changes nothing about what the action cells draw.
    expect(el.querySelectorAll('button').length).toBeGreaterThan(0);
  });

  it('dataFieldOf is undefined on both action kinds and the field elsewhere', () => {
    const [text, button, group] = columnsOf(decode(grid));
    expect(dataFieldOf(text!)).toBe('task');
    expect(dataFieldOf(button!)).toBeUndefined();
    expect(dataFieldOf(group!)).toBeUndefined();
  });

  it('a descriptor naming an action column leaves the authored order; the data column sorts', () => {
    const columns = columnsOf(decode(grid));
    const rows = [{ task: 'Verify' }, { task: 'Design' }];
    expect(sortRowsByDescriptor(columns, [1, 'asc'], rows)).toEqual(rows);
    expect(sortRowsByDescriptor(columns, [2, 'asc'], rows)).toEqual(rows);
    expect(sortRowsByDescriptor(columns, [0, 'asc'], rows)).toEqual([...rows].reverse());
  });
});
