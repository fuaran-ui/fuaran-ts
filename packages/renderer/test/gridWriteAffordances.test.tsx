// ============================================================================
//  @fuaran-ui/renderer — the bound grid's two WHOLE-ROWS write affordances:
//  row reorder (Phase 934) and the declared edit destination (Phase 863).
//
//  Both write the same collection, so both resolve their destination through
//  the same precedence — a declared `editStateKey` wins, else the Phase-663
//  floor (the grid's own direct `State` source), else NOTHING and no
//  affordance is drawn at all. A gesture with no destination is the
//  fake-affordance class the grid-behaviour charter refuses, which is why the
//  "no destination" cases below assert the DOM is byte-identical to a plain
//  grid rather than asserting that a click does nothing.
//
//  Every tree here is DECODED from canonical wire JSON rather than authored
//  through the smart constructors, because the declaration these fields exist
//  for is precisely the one a decoded tree could not previously make: the only
//  earlier spelling was a host closure, which crosses the wire as "<closure>"
//  and names no destination.
//
//  Parity-locked with the F# renderer (`BindingResolver.gridWriteDestination` /
//  `editDestination` / `reorderDestination` / `moveRow`, and `renderGrid`'s
//  `editCommit` / `reorderCommit`).
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const decode = (wire: string): Node<unknown> => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const mount = async (
  wire: string,
  runtime: FuaranRuntime,
  sources?: BindingSources,
): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(<FuaranRenderer tree={decode(wire)} runtime={runtime} sources={sources ?? {}} />);
  });
  return container;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const setNativeValue = (el: HTMLInputElement, value: string): void => {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

/** The three sprint rows every reorder case below moves around. */
const sprintRows =
  '[{"rank":1,"task":"Design"},{"rank":2,"task":"Build"},{"rank":3,"task":"Verify"}]';

const columns =
  '[{"field":"task","kind":{"$type":"Text"},"label":"Task"},{"field":"rank","kind":{"$type":"Numeric"},"label":"Rank"}]';

/** A grid over a direct State source, with whatever extra keys a case needs. */
const stateGrid = (extra: string): string =>
  `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},${extra}"rowKeyField":"task","source":{"$type":"State","defaultValue":${sprintRows},"key":"sprint-order"}}}`;

/** The same grid over a Query source — host data, with no writable slot of its own. */
const queryGrid = (extra: string): string =>
  `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},${extra}"rowKeyField":"task","source":{"$type":"Query","name":"sprint"}}}`;

const queryRows: BindingSources = {
  queryResults: {
    sprint: [
      { rank: 1, task: 'Design' },
      { rank: 2, task: 'Build' },
      { rank: 3, task: 'Verify' },
    ],
  },
};

const handles = (el: HTMLDivElement): HTMLButtonElement[] =>
  Array.from(el.querySelectorAll<HTMLButtonElement>('button.fuaran-grid-reorder-handle'));

const taskOrder = (value: unknown): string[] => (value as { task: string }[]).map((r) => r.task);

describe('row reorder (Phase 934)', () => {
  it('a reorderable grid draws one handle per row plus its header cell', async () => {
    const el = await mount(stateGrid('"reorderable":true,'), {});

    expect(handles(el).length).toBe(3);
    expect(el.querySelectorAll('th.fuaran-grid-reorder-header').length).toBe(1);
    // A real <button>, so it is focusable and screen-reader announced with no
    // ARIA re-plumbing; `aria-grabbed` is deprecated and deliberately absent.
    const first = handles(el)[0]!;
    expect(first.tagName).toBe('BUTTON');
    expect(first.getAttribute('aria-label')).toContain('Reorder row 1 of 3');
    expect(first.getAttribute('aria-keyshortcuts')).toBe('ArrowUp ArrowDown');
    expect(first.getAttribute('aria-grabbed')).toBeNull();
  });

  it('a grid that does not declare `reorderable` renders the pre-934 construction', async () => {
    const el = await mount(stateGrid(''), {});

    expect(handles(el).length).toBe(0);
    expect(el.querySelectorAll('.fuaran-grid-reorder-header').length).toBe(0);
    expect(el.querySelectorAll('.fuaran-grid-reorder-cell').length).toBe(0);
  });

  it('ArrowDown on a handle commits the WHOLE moved rows value to the destination', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"reorderable":true,'), { setState });

    await act(async () => {
      handles(el)[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    expect(setState).toHaveBeenCalledTimes(1);
    const [key, value] = setState.mock.calls[0]!;
    expect(key).toBe('sprint-order');
    expect(taskOrder(value)).toEqual(['Build', 'Design', 'Verify']);
  });

  it('ArrowUp on the FIRST row is refused, not clamped — nothing is written', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"reorderable":true,'), { setState });

    await act(async () => {
      handles(el)[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });

    // `moveRow` hands back the same array for an out-of-range move and the
    // commit writes nothing: refusal and no-new-bytes are one behaviour.
    expect(setState).not.toHaveBeenCalled();
  });

  it('dragging a handle onto another row commits that move', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"reorderable":true,'), { setState });
    const rows = el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row');

    await act(async () => {
      handles(el)[0]!.dispatchEvent(new Event('dragstart', { bubbles: true }));
      rows[2]!.dispatchEvent(new Event('dragover', { bubbles: true }));
      rows[2]!.dispatchEvent(new Event('drop', { bubbles: true }));
    });

    expect(setState).toHaveBeenCalledTimes(1);
    expect(taskOrder(setState.mock.calls[0]![1])).toEqual(['Build', 'Verify', 'Design']);
  });

  it('a drop with no drag begun on this grid does nothing', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"reorderable":true,'), { setState });
    const rows = el.querySelectorAll<HTMLTableRowElement>('tr.fuaran-grid-row');

    await act(async () => {
      rows[2]!.dispatchEvent(new Event('drop', { bubbles: true }));
    });

    expect(setState).not.toHaveBeenCalled();
  });

  it('the affordance is SUPPRESSED while a sort descriptor is in effect', async () => {
    // A drag the sort instantly snaps back is an affordance that lies. Clear
    // the sort and the handles return — the second half of this case.
    const sorted = stateGrid('"reorderable":true,"sortStateKey":"sprint-sort",');
    const el = await mount(
      sorted,
      {},
      { state: { 'sprint-sort': { column: 0, direction: 'asc' } } },
    );
    expect(handles(el).length).toBe(0);

    if (root) act(() => root!.unmount());
    container?.remove();
    const cleared = await mount(sorted, {}, { state: {} });
    expect(handles(cleared).length).toBe(3);
  });

  it('a declared `defaultSort` suppresses it too — the sort need not be user-written', async () => {
    const el = await mount(
      stateGrid('"reorderable":true,"defaultSort":{"column":0,"direction":"asc"},'),
      {},
    );
    expect(handles(el).length).toBe(0);
  });

  it('a Query-sourced grid with no declared destination draws NO handle', async () => {
    const el = await mount(queryGrid('"reorderable":true,'), {}, queryRows);

    // Rows render — this is not an empty grid — but host data has no writable
    // slot, so there is nothing to drag them into.
    expect(el.querySelectorAll('tr.fuaran-grid-row').length).toBe(3);
    expect(handles(el).length).toBe(0);
  });

  it('a declared `editStateKey` gives a Query-sourced grid its destination', async () => {
    const setState = vi.fn();
    const el = await mount(
      queryGrid('"reorderable":true,"editStateKey":"sprint-order",'),
      { setState },
      queryRows,
    );

    expect(handles(el).length).toBe(3);
    await act(async () => {
      handles(el)[2]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }),
      );
    });

    expect(setState).toHaveBeenCalledWith('sprint-order', expect.anything());
    expect(taskOrder(setState.mock.calls[0]![1])).toEqual(['Design', 'Verify', 'Build']);
  });

  it('a declared `editStateKey` WINS over the grid’s own State source', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"reorderable":true,"editStateKey":"elsewhere",'), {
      setState,
    });

    await act(async () => {
      handles(el)[0]!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }),
      );
    });

    // One collection, one destination: the declared key, never both.
    expect(setState.mock.calls.map(([k]) => k)).toEqual(['elsewhere']);
  });
});

describe('the declared edit destination (Phase 863)', () => {
  const editableCols =
    '[{"field":"task","kind":{"$type":"Text"},"label":"Task"},{"editable":false,"field":"rank","kind":{"$type":"Numeric"},"label":"Rank"}]';

  const inputs = (el: HTMLDivElement): HTMLInputElement[] =>
    Array.from(el.querySelectorAll<HTMLInputElement>('input.fuaran-grid-cell-editable'));

  it('an editable grid over its own State source renders inputs and commits (the 663 floor)', async () => {
    const setState = vi.fn();
    const el = await mount(stateGrid('"editable":true,'), { setState });

    // Both columns are field-projected Text/Numeric, so both are editable.
    expect(inputs(el).length).toBe(6);
    await act(async () => setNativeValue(inputs(el)[0]!, 'Redesign'));

    expect(setState).toHaveBeenCalledTimes(1);
    const [key, value] = setState.mock.calls[0]!;
    expect(key).toBe('sprint-order');
    expect(taskOrder(value)).toEqual(['Redesign', 'Build', 'Verify']);
  });

  it('a Query-sourced grid with a declared destination is EDITABLE — 863’s whole point', async () => {
    // Before the declared destination reached the renderer this grid decoded,
    // passed pre-emit validation (FUARAN090 was widened precisely because a
    // declared destination is a real one) and then rendered plain spans: a
    // declaration that read as live everywhere except where it acts.
    const setState = vi.fn();
    const el = await mount(
      queryGrid('"editable":true,"editStateKey":"stock-adjustments",'),
      { setState },
      queryRows,
    );

    expect(inputs(el).length).toBe(6);
    await act(async () => setNativeValue(inputs(el)[0]!, 'Redesign'));

    expect(setState).toHaveBeenCalledTimes(1);
    const [key, value] = setState.mock.calls[0]!;
    expect(key).toBe('stock-adjustments');
    expect(taskOrder(value)).toEqual(['Redesign', 'Build', 'Verify']);
  });

  it('a Query-sourced grid with NO declared destination stays display-only', async () => {
    const el = await mount(queryGrid('"editable":true,'), {}, queryRows);

    expect(el.querySelectorAll('tr.fuaran-grid-row').length).toBe(3);
    expect(inputs(el).length).toBe(0);
  });

  it('a column-level `editable: false` narrows the grid-level flag', async () => {
    const wire = `{"id":"g","kind":{"$type":"DataGrid","columns":${editableCols},"editable":true,"rowKeyField":"task","source":{"$type":"State","defaultValue":${sprintRows},"key":"sprint-order"}}}`;
    const el = await mount(wire, {});

    // Only the first column's three cells are inputs; the read-only column is
    // the declaration read-only-by-omission could not make.
    expect(inputs(el).length).toBe(3);
  });

  it('a grid that does not declare `editable` renders spans, unchanged', async () => {
    const el = await mount(stateGrid(''), {});
    expect(inputs(el).length).toBe(0);
  });

  it('the edit commit indexes the FULL set, not the visible page', async () => {
    // Page 2 of a 3-row grid at one row per page is `Verify`; committing it
    // must not overwrite `Design`.
    const setState = vi.fn();
    const wire = stateGrid('"editable":true,"pageSize":1,"pageStateKey":"sprint-page",');
    const el = await mount(wire, { setState }, { state: { 'sprint-page': { page: 3 } } });

    await act(async () => setNativeValue(inputs(el)[0]!, 'Verified'));

    expect(taskOrder(setState.mock.calls[0]![1])).toEqual(['Design', 'Build', 'Verified']);
  });
});
