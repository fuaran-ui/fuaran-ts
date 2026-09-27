// ============================================================================
//  The DataGrid row window in the static tier (Phase 1892, `windowStateKey` /
//  `rowTotal`). The window is a data operation the seeded State determines, so
//  this host performs the slice and emits the ARIA slice annotations; writing
//  the descriptor is the interactive half, and a static host writes nothing.
//  The slice itself is the client renderer's own function, so the two surfaces
//  present the same rows.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { renderToHtml } from '../src/index.js';

const decode = (wire: string): Node<unknown> => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const rows = JSON.stringify(
  Array.from({ length: 50 }, (_, i) => ({ id: `r${String(i).padStart(2, '0')}`, n: i })),
);
const columns =
  '[{"field":"id","kind":{"$type":"Text"},"label":"Id"},{"field":"n","kind":{"$type":"Numeric"},"label":"N"}]';
const grid = (extra: string): string =>
  `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},${extra}"rowKeyField":"id","source":{"$type":"State","defaultValue":${rows},"key":"rows"}}}`;

const rowTags = (html: string): string[] => html.match(/<tr class="fuaran-grid-row[^>]*>/g) ?? [];

describe('the row window in the static tier (Phase 1892)', () => {
  it('slices the seeded window and annotates it as a slice', () => {
    const html = renderToHtml(decode(grid('"windowStateKey":"w",')), {
      sources: { state: { w: { offset: 45, count: 10 } } },
    });

    expect(html).toContain('aria-rowcount="51"');
    const tags = rowTags(html);
    // A window overlapping the end presents the last full window.
    expect(tags.length).toBe(10);
    expect(tags[0]).toContain('aria-rowindex="42"');
    expect(html).toContain('r40');
    expect(html).not.toContain('>r39<');
  });

  it('with no usable descriptor presents every row, unannotated', () => {
    const html = renderToHtml(decode(grid('"windowStateKey":"w",')), {
      sources: { state: { w: { offset: 2.5, count: 10 } } },
    });

    expect(html).not.toContain('aria-rowcount');
    expect(html).not.toContain('aria-rowindex');
    expect(rowTags(html).length).toBe(50);
  });

  it('a grid declaring no window key is unchanged', () => {
    const html = renderToHtml(decode(grid('')));

    expect(html).not.toContain('aria-rowcount');
    expect(rowTags(html).length).toBe(50);
  });

  it('a host-paged grid with a declared total states the page count and clamps', () => {
    const wire =
      `{"id":"g","kind":{"$type":"DataGrid","columns":${columns},"pageSize":10,"pageStateKey":"p",` +
      `"rowKeyField":"id","rowTotal":{"$type":"State","key":"t"},` +
      `"source":{"$type":"Query","dependsOn":["p"],"name":"q"}}}`;
    const html = renderToHtml(decode(wire), {
      sources: { queryResults: { q: [] }, state: { p: { page: 9 }, t: 45 } },
    });

    expect(html).toContain('Page 5 of 5');
  });
});
