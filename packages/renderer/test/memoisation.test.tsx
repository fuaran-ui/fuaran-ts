// ============================================================================
//  @fuaran-ui/renderer — the memo boundary (Phase 2074).
//
//  Every node renders through a memoised component that re-renders only when
//  its own node changes, or when a state key its subtree READ changes. The
//  probe counts i18n catalog lookups (one per rendered I18n text), which is
//  exactly the work a skipped node does not do.
//
//  The failure mode memoisation invites is a STALE render, so beside the
//  "skips" probes sit the "does re-render" ones: a memoised node whose own key
//  moved, a node whose own identity moved, and an event handler that reads a
//  key its node never rendered from.
// ============================================================================

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const containers: HTMLDivElement[] = [];

afterEach(() => {
  for (const r of roots.splice(0)) act(() => r.unmount());
  for (const c of containers.splice(0)) c.remove();
});

const decode = (wire: unknown): Node<unknown> => {
  const decoded = decodeNode(JSON.stringify(wire));
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const NODE_COUNT = 500;

/**
 * A 500-node tree: a Box holding 499 static-keyed I18n texts and ONE text
 * whose i18n argument reads `$state.watched`.
 */
const probeWire = (): unknown => ({
  id: 'probe-root',
  kind: {
    $type: 'Box',
    layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
    role: 'Group',
    children: [
      {
        id: 'reader',
        kind: {
          $type: 'Markdown',
          text: {
            $type: 'I18n',
            key: 'reader',
            args: { v: { $type: 'State', key: 'watched' } },
          },
        },
      },
      ...Array.from({ length: NODE_COUNT - 2 }, (_, i) => ({
        id: `n${i}`,
        kind: { $type: 'Markdown', text: { $type: 'I18n', key: `k${i}` } },
      })),
    ],
  },
});

interface Probe {
  readonly container: HTMLDivElement;
  readonly calls: { count: number };
  readonly render: (tree: Node<unknown>, state: Record<string, unknown>) => Promise<void>;
}

const mountProbe = async (
  tree: Node<unknown>,
  state: Record<string, unknown>,
  runtime: FuaranRuntime = {},
): Promise<Probe> => {
  const calls = { count: 0 };
  // Every key resolves to a template carrying `{v}`; each lookup is counted.
  const i18n = new Proxy({} as Record<string, string>, {
    get: (_t, key) => {
      if (typeof key !== 'string') return undefined;
      calls.count += 1;
      return `${key}={v}`;
    },
  });
  const container = document.createElement('div');
  document.body.appendChild(container);
  containers.push(container);
  const root = createRoot(container);
  roots.push(root);
  const render = async (t: Node<unknown>, s: Record<string, unknown>): Promise<void> => {
    const sources: BindingSources = { state: s, i18n };
    await act(async () => {
      root.render(<FuaranRenderer tree={t} sources={sources} runtime={runtime} />);
    });
  };
  await render(tree, state);
  return { container, calls, render };
};

describe(
  'Phase 2074 — the render-count probe (500 nodes, one state change)',
  { timeout: 60_000 },
  () => {
    it('an UNRELATED state change resolves no binding at all', async () => {
      const tree = decode(probeWire());
      const probe = await mountProbe(tree, { watched: 1, other: 1 });
      expect(probe.calls.count).toBe(NODE_COUNT - 1);
      const before = probe.container.innerHTML;

      probe.calls.count = 0;
      const t0 = performance.now();
      await probe.render(tree, { watched: 1, other: 2 });
      const ms = (performance.now() - t0).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(`[2074 probe] unrelated key change: ${probe.calls.count} resolutions, ${ms} ms`);
      expect(probe.calls.count).toBe(0);
      // Rendered output is unchanged by the skip.
      expect(probe.container.innerHTML).toBe(before);
    });

    it('a change to the READ key re-renders exactly its reader', async () => {
      const tree = decode(probeWire());
      const probe = await mountProbe(tree, { watched: 1, other: 1 });

      probe.calls.count = 0;
      const t0 = performance.now();
      await probe.render(tree, { watched: 2, other: 1 });
      const ms = (performance.now() - t0).toFixed(1);
      // eslint-disable-next-line no-console
      console.log(`[2074 probe] read key change: ${probe.calls.count} resolutions, ${ms} ms`);
      expect(probe.calls.count).toBe(1);
      expect(
        probe.container.querySelector('[data-fuaran-node-id="reader"]')?.textContent,
      ).toContain('reader=2');
    });

    it('the memoised output equals a fresh, unmemoised mount of the same state', async () => {
      const tree = decode(probeWire());
      const probe = await mountProbe(tree, { watched: 1, other: 1 });
      await probe.render(tree, { watched: 7, other: 3 });
      const fresh = await mountProbe(tree, { watched: 7, other: 3 });
      expect(probe.container.innerHTML).toBe(fresh.container.innerHTML);
    });
  },
);

describe('Phase 2074 — a memoised subtree is never stale', { timeout: 60_000 }, () => {
  it('re-renders a node whose OWN identity changed, with the state untouched', async () => {
    const tree = decode(probeWire());
    const probe = await mountProbe(tree, { watched: 1 });
    const wire = probeWire() as { kind: { children: { id: string; kind: unknown }[] } };
    wire.kind.children[5] = { id: 'n4', kind: { $type: 'Markdown', text: 'replaced' } };
    probe.calls.count = 0;
    await probe.render(decode(wire), { watched: 1 });
    expect(probe.container.querySelector('[data-fuaran-node-id="n4"]')?.textContent?.trim()).toBe(
      'replaced',
    );
  });

  it('re-renders a DEEP reader when an ancestor read nothing', async () => {
    const wire = {
      id: 'outer',
      kind: {
        $type: 'Box',
        layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
        role: 'Group',
        children: [
          {
            id: 'middle',
            kind: {
              $type: 'Box',
              layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
              role: 'Group',
              children: [
                {
                  id: 'deep',
                  kind: {
                    $type: 'Markdown',
                    text: { $type: 'I18n', key: 'deep', args: { v: { $type: 'State', key: 'x' } } },
                  },
                },
              ],
            },
          },
          { id: 'sibling', kind: { $type: 'Markdown', text: { $type: 'I18n', key: 'sib' } } },
        ],
      },
    };
    const tree = decode(wire);
    const probe = await mountProbe(tree, { x: 'a' });
    probe.calls.count = 0;
    await probe.render(tree, { x: 'b' });
    expect(probe.calls.count).toBe(1);
    expect(probe.container.querySelector('[data-fuaran-node-id="deep"]')?.textContent).toContain(
      'deep=b',
    );
  });

  it('an event handler reads the LATEST state, even off a node that skipped renders', async () => {
    // The button renders nothing from `$state.src`; its click copies it into
    // `dst`. A memoised button that kept the first render's sources would
    // write the stale value.
    const wire = {
      id: 'copy',
      kind: {
        $type: 'Button',
        label: 'Copy',
        onClick: {
          $type: 'SetState',
          key: 'dst',
          valueFrom: { $type: 'State', key: 'src' },
        },
        variant: 'Primary',
      },
    };
    const writes: [string, unknown][] = [];
    const runtime: FuaranRuntime = {
      setState: (key: string, value: unknown) => {
        writes.push([key, value]);
      },
    };
    const tree = decode(wire);
    const probe = await mountProbe(tree, { src: 'first' }, runtime);
    await probe.render(tree, { src: 'second' });
    const button = probe.container.querySelector('button');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.click();
    });
    expect(writes).toEqual([['dst', 'second']]);
  });
});

describe('Phase 2074 — drag state is per renderer instance', () => {
  const gridWire = (id: string) => ({
    id,
    kind: {
      $type: 'DataGrid',
      columns: [{ field: 'name', kind: { $type: 'Text' }, label: 'Name' }],
      reorderable: true,
      rowKeyField: 'name',
      source: { $type: 'State', key: 'rows' },
    },
  });

  it('a drag begun in one renderer is not consumed by a same-id grid in another', async () => {
    const rows = [{ name: 'a' }, { name: 'b' }, { name: 'c' }];
    const writesA: unknown[] = [];
    const writesB: unknown[] = [];
    const runtimeA: FuaranRuntime = { setState: (_k: string, v: unknown) => void writesA.push(v) };
    const runtimeB: FuaranRuntime = { setState: (_k: string, v: unknown) => void writesB.push(v) };
    const a = await mountProbe(decode(gridWire('grid')), { rows }, runtimeA);
    const b = await mountProbe(decode(gridWire('grid')), { rows }, runtimeB);

    const handleA = a.container.querySelector('[data-reorder-handle="0"]');
    const rowsB = b.container.querySelectorAll('tr.fuaran-grid-row');
    expect(handleA).not.toBeNull();
    expect(rowsB.length).toBe(3);

    await act(async () => {
      handleA!.dispatchEvent(new Event('dragstart', { bubbles: true }));
    });
    await act(async () => {
      rowsB[2]!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    expect(writesB).toEqual([]);

    // …and the same drag IS consumed within its own renderer.
    const rowsA = a.container.querySelectorAll('tr.fuaran-grid-row');
    await act(async () => {
      rowsA[2]!.dispatchEvent(new Event('drop', { bubbles: true, cancelable: true }));
    });
    expect(writesA.length).toBe(1);
  });
});
