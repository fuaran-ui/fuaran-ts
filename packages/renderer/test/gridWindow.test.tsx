// ============================================================================
//  @fuaran-ui/renderer — the DataGrid row window (Phase 1892,
//  `windowStateKey` / `rowTotal`).
//
//  Two halves. The corpus's `grid-window/` behaviour vectors run through this
//  host's own pieces — its grid sort, its page slice, its descriptor reader and
//  its window function — exactly as the family's description says. Then the
//  client renderer's interactive half: a grid declaring `windowStateKey`
//  renders in a scroll viewport that WRITES the window descriptor on mount and
//  as the viewport moves, never re-writing an unchanged one.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { ColumnErased, Node, SortDirection } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import {
  FuaranRenderer,
  presentWindow,
  rowTotalOfValue,
  windowOfValue,
  type FuaranRuntime,
} from '../src/index.js';
import {
  sliceRowsToPage,
  sortRowsByDescriptor,
  stepWindowWriter,
  type RowWindow,
} from '../src/render/Visualisation.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

// ─── The corpus's behaviour vectors ─────────────────────────────────────────

const here = dirname(fileURLToPath(import.meta.url));
const corpusRoot =
  process.env['FUARAN_WIRE_FIXTURES'] || join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const corpusPresent = existsSync(join(corpusRoot, 'manifest.json'));
const vectorsFile = join(corpusRoot, 'grid-window', 'grid-window-vectors.json');

interface WindowVector {
  readonly id: string;
  readonly input: {
    readonly slicing: 'client' | 'hostPages' | 'hostWindows';
    readonly columns: readonly string[];
    readonly rows: readonly Record<string, unknown>[];
    readonly sort?: { readonly column: number; readonly direction: SortDirection };
    readonly page?: { readonly size: number; readonly page: number };
    readonly window?: unknown;
    readonly rowTotal?: unknown;
  };
  readonly expected: {
    readonly windowed: boolean;
    readonly offset: number;
    readonly rowIds: readonly string[];
    readonly total: number | null;
  };
}

describe.skipIf(!corpusPresent)('grid-window vectors (the corpus family)', () => {
  it('the vector file is present in the corpus', () => {
    // Fails rather than skips: a corpus that exists but lacks the family is a
    // stale corpus, and a silent skip would read as a pass.
    expect(existsSync(vectorsFile), vectorsFile).toBe(true);
  });

  const vectors: readonly WindowVector[] = existsSync(vectorsFile)
    ? (JSON.parse(readFileSync(vectorsFile, 'utf8')) as { vectors: WindowVector[] }).vectors
    : [];

  it('carries vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    it(v.id, () => {
      const { input } = v;
      const columns = input.columns.map(
        (field) =>
          ({ field, label: field, kind: { kind: 'Text' } }) as unknown as ColumnErased<unknown>,
      );
      const sorted =
        input.sort !== undefined
          ? sortRowsByDescriptor(columns, [input.sort.column, input.sort.direction], input.rows)
          : input.rows;
      const paged =
        input.slicing === 'client' && input.page !== undefined
          ? sliceRowsToPage(input.page.size, input.page.page, sorted)
          : sorted;
      const hostWindows = input.slicing === 'hostWindows';
      const window = 'window' in input ? windowOfValue(input.window) : undefined;
      const declared =
        hostWindows && 'rowTotal' in input ? rowTotalOfValue(input.rowTotal) : undefined;
      const presented = presentWindow(hostWindows, declared, window, paged);

      expect(presented.windowed).toBe(v.expected.windowed);
      expect(presented.offset).toBe(v.expected.offset);
      expect(presented.rows.map((r) => (r as { id: string }).id)).toEqual(v.expected.rowIds);
      expect(presented.total ?? null).toBe(v.expected.total);
    });
  }
});

// ─── The corpus's writer vectors (Phase 1922) ──────────────────────────────
//
// The `grid-window-writer/` family: a scripted sequence of viewport
// measurements, run through this renderer's own pure writer (the one
// `GridWindowViewport` calls) and its own descriptor reader, with each write
// reflected into the held window as SetState does. The F# client runs the same
// file through `BindingResolver.stepWindowWriter`.

const writerVectorsFile = join(corpusRoot, 'grid-window-writer', 'grid-window-writer-vectors.json');

interface WriterVector {
  readonly id: string;
  readonly input: {
    readonly windowStateKey?: string;
    readonly held?: unknown;
    readonly steps: readonly {
      readonly held?: unknown;
      readonly measure: {
        readonly scrollTop: number;
        readonly headerHeight: number;
        readonly rowHeight?: number;
        readonly viewportHeight?: number;
      };
    }[];
  };
  readonly expected: { readonly writes: readonly (RowWindow | null)[] };
}

describe.skipIf(!corpusPresent)('grid-window-writer vectors (the corpus family)', () => {
  it('the vector file is present in the corpus', () => {
    // Fails rather than skips: a corpus that exists but lacks the family is a
    // stale corpus, and a silent skip would read as a pass.
    expect(existsSync(writerVectorsFile), writerVectorsFile).toBe(true);
  });

  const vectors: readonly WriterVector[] = existsSync(writerVectorsFile)
    ? (JSON.parse(readFileSync(writerVectorsFile, 'utf8')) as { vectors: WriterVector[] }).vectors
    : [];

  it('carries vectors', () => {
    expect(vectors.length).toBeGreaterThan(0);
  });

  for (const v of vectors) {
    it(v.id, () => {
      const { input } = v;
      let held = 'held' in input ? windowOfValue(input.held) : undefined;
      let lastWritten: RowWindow | undefined;
      const writes: (RowWindow | null)[] = [];
      for (const step of input.steps) {
        if ('held' in step) held = windowOfValue(step.held);
        const result = stepWindowWriter(input.windowStateKey, held, lastWritten, {
          scrollTop: step.measure.scrollTop,
          headerHeight: step.measure.headerHeight,
          rowHeight: step.measure.rowHeight ?? 0,
          viewportHeight: step.measure.viewportHeight ?? 0,
        });
        lastWritten = result.written;
        if (result.write === undefined) {
          writes.push(null);
        } else {
          // Reflect the write into State through the same reader the renderer uses.
          held = windowOfValue({ offset: result.write.offset, count: result.write.count });
          writes.push({ offset: result.write.offset, count: result.write.count });
        }
      }
      expect(writes).toEqual(v.expected.writes);
    });
  }
});

// ─── The client renderer ────────────────────────────────────────────────────

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const decode = (wire: string): Node<unknown> => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const tree = (wire: string, runtime: FuaranRuntime, sources: BindingSources) => (
  <FuaranRenderer tree={decode(wire)} runtime={runtime} sources={sources} />
);

const mount = async (
  wire: string,
  runtime: FuaranRuntime,
  sources: BindingSources = {},
): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(tree(wire, runtime, sources));
  });
  return container;
};

const rerender = async (
  wire: string,
  runtime: FuaranRuntime,
  sources: BindingSources,
): Promise<void> => {
  await act(async () => {
    root!.render(tree(wire, runtime, sources));
  });
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

const hundredRows = JSON.stringify(
  Array.from({ length: 100 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, n: i })),
);
const columns =
  '[{"field":"id","kind":{"$type":"Text"},"label":"Id"},{"field":"n","kind":{"$type":"Numeric"},"label":"N"}]';
const grid = (extra: string): string =>
  `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},${extra}"rowKeyField":"id","source":{"$type":"State","defaultValue":${hundredRows},"key":"rows"}}}`;
const windowed = grid('"windowStateKey":"w",');

/** The rows of the table body that are data rows (not the viewport's spacers). */
const dataRows = (el: HTMLElement): HTMLTableRowElement[] =>
  Array.from(el.querySelectorAll<HTMLTableRowElement>('tbody > tr.fuaran-grid-row'));

const viewportOf = (el: HTMLElement): HTMLDivElement =>
  el.querySelector('table.fuaran-grid')!.parentElement as HTMLDivElement;

describe('the window viewport writes the descriptor (Phase 1892)', () => {
  it('mount writes the initial descriptor through SetState', async () => {
    const setState = vi.fn();
    await mount(windowed, { setState });

    expect(setState).toHaveBeenCalledTimes(1);
    const [key, value] = setState.mock.calls[0]!;
    expect(key).toBe('w');
    // jsdom measures nothing: the default row height over the viewport bound.
    expect(value).toEqual({ offset: 0, count: 15 });
  });

  it('a scroll event writes the moved descriptor', async () => {
    const setState = vi.fn();
    const el = await mount(windowed, { setState }, { state: { w: { offset: 0, count: 15 } } });
    // The held descriptor already matches the viewport, so mount wrote nothing.
    expect(setState).not.toHaveBeenCalled();

    const viewport = viewportOf(el);
    Object.defineProperty(viewport, 'scrollTop', { configurable: true, value: 20 * 32 });
    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(setState).toHaveBeenCalledTimes(1);
    expect(setState.mock.calls[0]).toEqual(['w', { offset: 20, count: 15 }]);
  });

  it('an unchanged viewport writes nothing new', async () => {
    const setState = vi.fn();
    const el = await mount(windowed, { setState });
    expect(setState).toHaveBeenCalledTimes(1);

    // The host applies the write and re-renders: nothing moved, so no write.
    await rerender(windowed, { setState }, { state: { w: { offset: 0, count: 15 } } });
    const viewport = viewportOf(el);
    await act(async () => {
      viewport.dispatchEvent(new Event('scroll'));
    });

    expect(setState).toHaveBeenCalledTimes(1);
  });

  it('a held descriptor presents the window, with the ARIA slice annotations and spacers', async () => {
    const el = await mount(windowed, {}, { state: { w: { offset: 20, count: 15 } } });

    const table = el.querySelector('table.fuaran-grid')!;
    expect(table.getAttribute('aria-rowcount')).toBe('101');
    const rows = dataRows(el);
    expect(rows.length).toBe(15);
    expect(rows[0]!.textContent).toContain('r20');
    expect(rows[0]!.getAttribute('aria-rowindex')).toBe('22');
    expect(rows[14]!.getAttribute('aria-rowindex')).toBe('36');
    // The rows before and after the window stand in as space.
    const spacers = Array.from(el.querySelectorAll<HTMLTableRowElement>('tbody > tr')).filter(
      (tr) => tr.getAttribute('aria-hidden') === 'true',
    );
    expect(spacers.map((s) => s.style.height)).toEqual([`${20 * 32}px`, `${65 * 32}px`]);
  });

  it('a host-windowed grid slices nothing and reads the declared total', async () => {
    const wire =
      `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},"rowKeyField":"id",` +
      `"rowTotal":{"$type":"Query","name":"t"},` +
      `"source":{"$type":"Query","dependsOn":["w"],"name":"q"},"windowStateKey":"w"}}`;
    const hostRows = Array.from({ length: 10 }, (_, i) => ({ id: `r${100 + i}`, n: 100 + i }));
    const el = await mount(
      wire,
      {},
      { queryResults: { q: hostRows, t: 5000 }, state: { w: { offset: 100, count: 10 } } },
    );

    expect(el.querySelector('table.fuaran-grid')!.getAttribute('aria-rowcount')).toBe('5001');
    const rows = dataRows(el);
    expect(rows.length).toBe(10);
    expect(rows[0]!.getAttribute('aria-rowindex')).toBe('102');
  });

  it('an edit in a scrolled client window commits to the row the reader saw', async () => {
    const setState = vi.fn();
    const el = await mount(
      grid('"editable":true,"windowStateKey":"w",'),
      { setState },
      { state: { w: { offset: 30, count: 15 } } },
    );
    setState.mockClear();

    const input = dataRows(el)[0]!.querySelector('input')!;
    const proto = Object.getPrototypeOf(input) as object;
    await act(async () => {
      Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(input, 'edited');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    const commit = setState.mock.calls.find(([key]) => key === 'rows');
    expect(commit).toBeDefined();
    const written = commit![1] as { id: string }[];
    expect(written[30]!.id).toBe('edited');
    expect(written[0]!.id).toBe('r00');
  });

  it('a static render writes nothing', () => {
    const setState = vi.fn();
    const html = renderToStaticMarkup(tree(windowed, { setState }, {}));

    expect(setState).not.toHaveBeenCalled();
    expect(html).toContain('fuaran-grid');
  });

  it('a grid without windowStateKey renders exactly as before', async () => {
    const setState = vi.fn();
    const el = await mount(grid(''), { setState });

    expect(setState).not.toHaveBeenCalled();
    const table = el.querySelector('table.fuaran-grid')!;
    // No viewport container: the table is the node's own output.
    expect(table.parentElement!.style.overflowY).toBe('');
    expect(table.hasAttribute('aria-rowcount')).toBe(false);
    expect(dataRows(el).length).toBe(100);
    expect(dataRows(el).some((r) => r.hasAttribute('aria-rowindex'))).toBe(false);
    expect(el.querySelectorAll('tbody > tr[aria-hidden]').length).toBe(0);
  });

  it('a host-paged grid with a declared total states "Page X of N" and clamps', async () => {
    const wire =
      `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},"pageSize":10,"pageStateKey":"p",` +
      `"rowKeyField":"id","rowTotal":{"$type":"Query","name":"t"},` +
      `"source":{"$type":"Query","dependsOn":["p"],"name":"q"}}}`;
    const hostRows = Array.from({ length: 10 }, (_, i) => ({ id: `r${i}`, n: i }));
    const el = await mount(
      wire,
      {},
      { queryResults: { q: hostRows, t: 45 }, state: { p: { page: 9 } } },
    );

    expect(el.querySelector('.fuaran-grid-pager-status')!.textContent).toBe('Page 5 of 5');
  });

  it('a host-paged grid without a declared total keeps to previous/next', async () => {
    const wire =
      `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},"pageSize":10,"pageStateKey":"p",` +
      `"rowKeyField":"id","source":{"$type":"Query","dependsOn":["p"],"name":"q"}}}`;
    const el = await mount(wire, {}, { queryResults: { q: [] }, state: { p: { page: 9 } } });

    expect(el.querySelector('.fuaran-grid-pager-status')!.textContent).toBe('Page 9');
  });
});
