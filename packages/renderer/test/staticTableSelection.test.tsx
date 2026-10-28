// ============================================================================
//  @fuaran-ui/renderer — selectable static-table rows (Phase 2474).
//
//  Parity-locked with the F# renderer: a static table whose `rowKeyField`
//  names a declared column publishes a clicked row's record (each declared
//  column's `field` to its cell's text) under its own id through
//  `runtime.setSelection`; the designed selection — a `Selection` projecting
//  the key with a `defaultValue` — marks its row from the first frame; and a
//  table that is not selectable stays inert.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// The corpus fixture `table-selectable-detail`, byte for byte.
const drill =
  '{"id":"table-selectable-detail","kind":{"$type":"SplitPanel","children":[{"id":"countries","kind":{"$type":"DataGrid","columns":[{"field":"country","kind":{"$type":"Text"},"label":"country"},{"field":"gdp","kind":{"$type":"Text"},"label":"gdp"},{"field":"growth","kind":{"$type":"Text"},"label":"growth"}],"rowKeyField":"country","source":{"$type":"Static","value":[]},"staticRows":{"headers":["Country","GDP","Growth"],"rows":[["Germany","4.5T","+0.2%"],["France","3.1T","+1.1%"],["Italy","2.3T","+0.7%"]]}}},{"id":"country-detail","kind":{"$type":"Box","children":[{"id":"detail-country","kind":{"$type":"Fact","label":"Country","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"France","field":"country","nodeId":"countries"}}}},{"id":"detail-gdp","kind":{"$type":"Fact","label":"GDP","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"3.1T","field":"gdp","nodeId":"countries"}}}},{"id":"detail-growth","kind":{"$type":"Fact","label":"Growth","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"+1.1%","field":"growth","nodeId":"countries"}}}}],"heading":"Country detail","layout":{"$type":"Flex","direction":"Vertical"},"role":"Card"}}],"weight":0.6}}';

const decoded = (wire: string): Node<unknown> => {
  const result = decodeNode(wire);
  if (!result.ok) throw new Error(`decode failed: ${result.error.message}`);
  return result.value;
};

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const mount = async (tree: Node<unknown>, runtime: FuaranRuntime): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={tree} runtime={runtime} sources={{}} />);
  });
  return container;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
}, 0);

describe('selectable static-table rows (Phase 2474)', { timeout: 0 }, () => {
  it('marks the designed row from the first frame', async () => {
    const el = await mount(decoded(drill), {});
    const selected = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row-selected')];
    expect(selected.length).toBe(1);
    expect(selected[0]!.getAttribute('aria-selected')).toBe('true');
    expect(selected[0]!.textContent).toContain('France');
  });

  it('a row click publishes the row record under the table id', async () => {
    const setSelection = vi.fn();
    const el = await mount(decoded(drill), { setSelection });
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-table-row')];
    expect(rows.length).toBe(3);
    await act(async () => rows[2]!.click());
    expect(setSelection).toHaveBeenCalledOnce();
    const [nodeId, row] = setSelection.mock.calls[0] as [string, unknown];
    expect(nodeId).toBe('countries');
    expect({ ...(row as object) }).toEqual({ country: 'Italy', gdp: '2.3T', growth: '+0.7%' });
  });

  it('a table whose rowKeyField names no declared column stays inert', async () => {
    const setSelection = vi.fn();
    const el = await mount(
      decoded(drill.replace('"rowKeyField":"country"', '"rowKeyField":"iso"')),
      {
        setSelection,
      },
    );
    const rows = [...el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-table-row')];
    await act(async () => rows[0]!.click());
    expect(setSelection).not.toHaveBeenCalled();
    expect(el.querySelector('[aria-selected]')).toBeNull();
  });
});
