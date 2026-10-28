// ============================================================================
//  Phase 2474 — selectable static-table rows (the twin of the F# server suite's
//  StaticTableSelectionTests). A static table whose `rowKeyField` names a
//  declared column is selectable; a `Selection` projecting the key with a
//  `defaultValue` is its designed selection, laid under `selections` before the
//  first render, so the server marks the row and every reader reads its cells.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml, type RenderToHtmlOptions } from '../src/index.js';

const renderJson = (canonical: string, options: RenderToHtmlOptions = {}): string => {
  const decoded = decodeNode(canonical);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value, options);
};

// The corpus fixture `table-selectable-detail`, byte for byte.
const drill =
  '{"id":"table-selectable-detail","kind":{"$type":"SplitPanel","children":[{"id":"countries","kind":{"$type":"DataGrid","columns":[{"field":"country","kind":{"$type":"Text"},"label":"country"},{"field":"gdp","kind":{"$type":"Text"},"label":"gdp"},{"field":"growth","kind":{"$type":"Text"},"label":"growth"}],"rowKeyField":"country","source":{"$type":"Static","value":[]},"staticRows":{"headers":["Country","GDP","Growth"],"rows":[["Germany","4.5T","+0.2%"],["France","3.1T","+1.1%"],["Italy","2.3T","+0.7%"]]}}},{"id":"country-detail","kind":{"$type":"Box","children":[{"id":"detail-country","kind":{"$type":"Fact","label":"Country","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"France","field":"country","nodeId":"countries"}}}},{"id":"detail-gdp","kind":{"$type":"Fact","label":"GDP","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"3.1T","field":"gdp","nodeId":"countries"}}}},{"id":"detail-growth","kind":{"$type":"Fact","label":"Growth","value":{"$type":"Bound","binding":{"$type":"Selection","defaultValue":"+1.1%","field":"growth","nodeId":"countries"}}}}],"heading":"Country detail","layout":{"$type":"Flex","direction":"Vertical"},"role":"Card"}}],"weight":0.6}}';

const selectedFrance =
  '<tr class="fuaran-table-row fuaran-grid-row-selected" aria-selected="true"><td class="fuaran-table-cell">France</td>';

describe('Phase 2474 — selectable static-table rows', () => {
  it('marks the designed row on the server render, and only that row', () => {
    const html = renderJson(drill);
    expect(html).toContain(selectedFrance);
    expect(html).toContain(
      '<tr class="fuaran-table-row"><td class="fuaran-table-cell">Germany</td>',
    );
    expect(html.split('aria-selected').length - 1).toBe(1);
  });

  it('a reader with no default of its own reads the designed row (the seed is a selection of it)', () => {
    const html = renderJson(drill.replace('"defaultValue":"3.1T",', ''));
    expect(html).toContain('3.1T</');
    expect(html).toContain(selectedFrance);
  });

  it('a key naming no row seeds nothing, and readers keep their defaults', () => {
    const html = renderJson(drill.replace('"defaultValue":"France"', '"defaultValue":"Spain"'));
    expect(html).not.toContain('aria-selected');
  });

  it('a furnished selection wins over the designed one', () => {
    const html = renderJson(drill, {
      sources: { selections: { countries: { country: 'Italy', gdp: '2.3T', growth: '+0.7%' } } },
    });
    expect(html).toContain(
      '<tr class="fuaran-table-row fuaran-grid-row-selected" aria-selected="true"><td class="fuaran-table-cell">Italy</td>',
    );
    expect(html).not.toContain(selectedFrance);
  });

  it('a table whose rowKeyField names no declared column is not selectable', () => {
    const html = renderJson(drill.replace('"rowKeyField":"country"', '"rowKeyField":"iso"'));
    expect(html).not.toContain('aria-selected');
  });
});
