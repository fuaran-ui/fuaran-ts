// ============================================================================
//  @fuaran-ui/renderer — the interactive-row class (Phase 1701, WIRE_FORMAT.md
//  §3.6.24).
//
//  `.fuaran-grid-row:hover` used to claim `cursor: pointer`, which told every
//  reader that every row was clickable when only a row whose grid declares
//  `onRowClick` is. The pointer now keys on a renderer-EMITTED marker, so the
//  affordance means what it says — and that marker is what this suite pins, in
//  both directions. An emission test alone cannot tell a renderer that honours
//  the declaration from one that marks every row.
//
//  The server tier's half of the same claim is asserted in
//  `@fuaran-ui/renderer-server`'s render-obligation suite, from the same
//  manifest. Both tiers are here rather than one because the two must agree:
//  the served DOM and the hydrated one carry the same classes, so marking on one
//  side alone would be a hydration mismatch.
//
//  Built from RAW canonical JSON rather than through the authoring surface:
//  `onRowClick` is a closure-bearing slot whose whole wire content is its
//  PRESENCE, and authoring it through a typed facade would put the facade under
//  test rather than the renderer.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { FuaranRenderer } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const MARKER = 'fuaran-grid-row-interactive';

/** A data-bound grid over two static rows, with the row action declared or omitted. */
const boundGridWire = (rowAction: boolean): string =>
  JSON.stringify({
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
      ],
      ...(rowAction ? { onRowClick: '<closure>' } : {}),
      rowKeyField: 'dept',
      source: { $type: 'Static', value: [{ dept: 'ops' }, { dept: 'fin' }] },
    },
  });

/** The same grid in `staticRows` mode, which honours no row action in any tier. */
const staticRowsWire = (rowAction: boolean): string =>
  JSON.stringify({
    id: 'terms',
    kind: {
      $type: 'DataGrid',
      columns: [],
      ...(rowAction ? { onRowClick: '<closure>' } : {}),
      source: { $type: 'Static', value: [] },
      staticRows: { headers: ['Term'], rows: [['MVU']] },
    },
  });

const decoded = (wire: string): Node<unknown> => {
  const result = decodeNode(wire);
  if (!result.ok) throw new Error(`decode failed: ${result.error.message}`);
  return result.value;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (wire: string): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={decoded(wire)} runtime={{}} sources={{}} />);
  });
  return container;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
});

describe('the interactive-row class (Phase 1701)', () => {
  it('a grid declaring a row action marks every rendered row', async () => {
    const el = await mount(boundGridWire(true));
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row')];
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.classList.contains(MARKER)).toBe(true);
  });

  it('a grid declaring none marks no row, and still renders the rows', async () => {
    const el = await mount(boundGridWire(false));
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row')];
    // The rows are there, so the assertion below is about the DECLARATION
    // rather than about an empty render.
    expect(rows.length).toBe(2);
    for (const row of rows) expect(row.classList.contains(MARKER)).toBe(false);
    // ...and stated as the affordance rather than as a class name: nothing in
    // this render may key the pointer.
    expect(el.innerHTML).not.toContain(MARKER);
  });

  it('a `staticRows` grid marks no row even when it declares an action', async () => {
    // Rule 2: the static mode honours no row action in any tier — its rows are
    // `TextSource` cells, not the row values a declared action is applied to —
    // so a marked row there would promise a click nothing can deliver.
    const el = await mount(staticRowsWire(true));
    expect(el.querySelectorAll('tr.fuaran-table-row').length).toBe(1);
    expect(el.innerHTML).not.toContain(MARKER);
  });
});
