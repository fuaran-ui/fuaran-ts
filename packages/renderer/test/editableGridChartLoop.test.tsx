// ============================================================================
//  @fuaran-ui/renderer — the editable grid drives a chart on the SAME state key
//  (Phase 663's pattern, proven on this host by Phase 666).
//
//  This is the whole point of the write-back floor, and it is the one claim the
//  parity harness cannot make. Cross-host parity says the two hosts agree; the
//  validator says an editable grid HAS a destination; neither says the loop
//  closes. What closes it is that a `Chart` whose `source` names the same
//  `{"$type":"State","key":…}` binding as the grid re-reads that key, so
//  "editable table drives live chart" is a pure-wire pattern with no new
//  vocabulary and no host code at all.
//
//  The two halves are the SHIPPED CORPUS FIXTURES, read rather than retyped:
//  `nodes/grid-editable-state.json` and `nodes/chart-state-rows.json` were
//  landed together on the same key precisely so this pairing could be asserted.
//  Reading them means the premise ("these two name one key") is checked rather
//  than assumed, and a corpus edit that broke the pairing would fail here
//  instead of quietly turning this into a test of two unrelated trees.
//
//  The loop is driven the way every other write-back case in this package
//  drives it (`writeBack.test.tsx`, `selectionLoop.test.tsx`): the seam call is
//  captured, and the host re-renders with the updated sources. That IS the
//  contract — the renderer writes through `runtime.setState` and reads from
//  `sources.state`; it owns no store of its own, deliberately.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import type { BindingSources } from '../src/index.js';
import { FuaranRenderer, type FuaranRuntime } from '../src/index.js';

// React 19 wants this flag set before act(...) drives a real root in jsdom.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer/test → workspace-root/wire-format-fixtures
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

interface StateSource {
  readonly $type: string;
  readonly key: string;
  readonly defaultValue: readonly Record<string, unknown>[];
}
interface FixtureNode {
  readonly id: string;
  readonly kind: Record<string, unknown>;
}

const fixture = (name: string): FixtureNode =>
  JSON.parse(readFileSync(join(nodesDir, `${name}.json`), 'utf8')) as FixtureNode;

const gridFixture = fixture('grid-editable-state');
const chartFixture = fixture('chart-state-rows');

const gridSource = gridFixture.kind['source'] as StateSource;
const chartSource = chartFixture.kind['source'] as StateSource;

/**
 * The shared key, taken from the fixtures rather than written down — and the
 * pairing asserted, because everything below is a claim about ONE key.
 */
const sharedKey = gridSource.key;

/**
 * Grid + chart under one Box, both untouched except for the chart's
 * `dataLabels`. That one addition is what makes the assertion legible: a Bar
 * chart with resolved rows lowers to real inline SVG, and `Ends` puts each
 * value in a `<text>` element, so "the chart re-rendered with the edit" is
 * readable in the DOM instead of inferred from bar geometry.
 */
const composed = JSON.stringify({
  id: 'plan',
  kind: {
    $type: 'Box',
    layout: { $type: 'Flex', direction: 'Vertical', wrap: false },
    role: 'Group',
    children: [
      gridFixture,
      { ...chartFixture, kind: { ...chartFixture.kind, dataLabels: 'Ends' } },
    ],
  },
});

let root: Root | undefined;
let container: HTMLDivElement | undefined;

const decode = (wire: string): Node<unknown> => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const render = async (runtime: FuaranRuntime, sources: BindingSources): Promise<void> => {
  await act(async () => {
    root!.render(<FuaranRenderer tree={decode(composed)} runtime={runtime} sources={sources} />);
  });
};

const mount = async (runtime: FuaranRuntime, sources: BindingSources): Promise<HTMLDivElement> => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  await render(runtime, sources);
  return container;
};

afterEach(() => {
  if (root) act(() => root!.unmount());
  container?.remove();
  root = undefined;
  container = undefined;
  vi.restoreAllMocks();
});

/** React owns the input's `value`; the native setter is how a real edit lands. */
const setNativeValue = (el: HTMLInputElement, value: string): void => {
  const proto = Object.getPrototypeOf(el) as object;
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  desc?.set?.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
};

const numericCells = (el: HTMLDivElement): HTMLInputElement[] =>
  Array.from(
    el.querySelectorAll<HTMLInputElement>('input.fuaran-grid-cell-editable[type="number"]'),
  );

/**
 * The chart's lowered SVG — absent means it fell back to the placeholder.
 *
 * Digit-group separators are stripped so a value can be matched as the number
 * the fixture carries. The lowering formats axis ticks, data labels and mark
 * titles for a reader (`1,200`), which is correct and is not what this test is
 * about; matching the raw digits keeps the assertions expressed in the
 * fixture's own values instead of pinning a presentation this file has no
 * opinion on.
 */
const chartSvg = (el: HTMLDivElement): string => {
  const svg = el.querySelector('svg');
  return svg === null ? '' : svg.outerHTML.replace(/(\d),(?=\d{3}(?!\d))/g, '$1');
};

describe('an editable grid drives a chart bound to the same $state key', () => {
  it('the two shipped fixtures name one key over the same default rows', () => {
    // The premise. Both halves matter: a shared key with different defaults
    // would render two different pictures before any edit, and the test below
    // would be measuring the seeding rather than the write-back.
    expect(gridSource.$type).toBe('State');
    expect(chartSource.$type).toBe('State');
    expect(chartSource.key).toBe(sharedKey);
    expect(chartSource.defaultValue).toEqual(gridSource.defaultValue);
    expect(gridFixture.kind['editable']).toBe(true);
  });

  it('an edit commits the whole updated rows value to the shared key', async () => {
    const setState = vi.fn();
    const el = await mount({ setState }, { state: {} });

    // Two rows × one Numeric column: the revenue cell of each row.
    const cells = numericCells(el);
    expect(cells.length).toBe(gridSource.defaultValue.length);
    expect(cells[0]!.value).toBe(String(gridSource.defaultValue[0]!['revenue']));

    await act(async () => setNativeValue(cells[0]!, '1200'));

    expect(setState).toHaveBeenCalledTimes(1);
    const [key, value] = setState.mock.calls[0]!;
    expect(key).toBe(sharedKey);
    // The WHOLE collection, with one field replaced — not a per-cell patch.
    // That is what makes a second reader of the key correct by construction.
    expect(value).toEqual([
      { ...gridSource.defaultValue[0], revenue: 1200 },
      gridSource.defaultValue[1],
    ]);
  });

  it('re-rendering on the committed value moves the chart, not just the grid', async () => {
    const setState = vi.fn();
    const el = await mount({ setState }, { state: {} });

    // Before: both readers are on the fixtures' shared default.
    expect(chartSvg(el)).toContain('980');
    expect(chartSvg(el)).not.toContain('1200');

    await act(async () => setNativeValue(numericCells(el)[0]!, '1200'));
    const committed = setState.mock.calls[0]![1];

    await render({ setState }, { state: { [sharedKey]: committed } });

    // After: the chart — which shares nothing with the grid but the key — is
    // drawn from the edited rows. The grid's own cell moved too, but that
    // alone would be satisfiable by a purely local input state.
    const after = chartSvg(el);
    expect(after).toContain('1200');
    expect(after).not.toContain('980');
    // The untouched row is untouched: a whole-collection commit that dropped
    // or reset its siblings would pass every assertion above.
    expect(after).toContain(String(gridSource.defaultValue[1]!['revenue']));
    expect(numericCells(el)[0]!.value).toBe('1200');
  });
});
