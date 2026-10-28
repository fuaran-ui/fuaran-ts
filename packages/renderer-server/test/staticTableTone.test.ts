// ============================================================================
//  Phase 2473 — toned cells in static tables (the twin of the F# server suite's
//  StaticTableToneTests). A `DataGrid` already carries `columns` beside
//  `staticRows`; the static leg reads them by position, and a `TonedPill` column
//  draws each cell as the toned pill with the cell's own text.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { fuaran } from '@fuaran-ui/ui';

import { renderToHtml } from '../src/index.js';

const renderJson = (canonical: string): string => {
  const decoded = decodeNode(canonical);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value);
};

// The corpus fixture `table-toned-column`, byte for byte.
const tonedColumn =
  '{"id":"table-toned-column","kind":{"$type":"DataGrid","columns":[{"field":"segment","kind":{"$type":"Text"},"label":"segment"},{"field":"change","kind":{"$type":"TonedPill","field":"change","map":{"+4.1%":"Success","-2.3%":"Critical"}},"label":"change"}],"source":{"$type":"Static","value":[]},"staticRows":{"headers":["Segment","Change"],"rows":[["Retail","+4.1%"],["Wholesale","-2.3%"],["Online","0.0%"]]}}}';

describe('Phase 2473 — toned cells in static tables', () => {
  it('draws a TonedPill column as the pill in its mapped tone, keeping the cell text', () => {
    const html = renderJson(tonedColumn);
    expect(html).toContain(
      '<td class="fuaran-table-cell"><span class="fuaran-grid-cell-pill fuaran-pill-success">+4.1%</span></td>',
    );
    expect(html).toContain(
      '<td class="fuaran-table-cell"><span class="fuaran-grid-cell-pill fuaran-pill-critical">-2.3%</span></td>',
    );
    expect(html).toContain(
      '<td class="fuaran-table-cell"><span class="fuaran-grid-cell-pill fuaran-pill-default">0.0%</span></td>',
    );
    expect(html).toContain('<td class="fuaran-table-cell">Retail</td>');
  });

  it('keys the tone on the row value at the pill field, another column when it names one', () => {
    const html = renderJson(
      '{"id":"t","kind":{"$type":"DataGrid","columns":[{"field":"shipment","kind":{"$type":"TonedPill","field":"status","map":{"Late":"Warning"}},"label":"shipment"},{"field":"status","kind":{"$type":"Text"},"label":"status"}],"source":{"$type":"Static","value":[]},"staticRows":{"headers":["Shipment","Status"],"rows":[["SHP-1","Late"]]}}}',
    );
    expect(html).toContain('<span class="fuaran-grid-cell-pill fuaran-pill-warning">SHP-1</span>');
  });

  it('renders a table with no columns exactly as before, and the facade carries columns', () => {
    const plain = fuaran.table({ id: 't', headers: ['A'], rows: [['x']] });
    expect(renderToHtml(plain)).not.toContain('fuaran-grid-cell-pill');
    const toned = fuaran.table({
      id: 't',
      headers: ['A'],
      rows: [['x']],
      columns: [
        {
          label: 'a',
          field: 'a',
          format: { kind: 'None' },
          kind: { kind: 'TonedPill', field: 'a', map: { x: 'Success' }, defaultTone: 'Default' },
          width: { kind: 'Auto' },
        },
      ],
    });
    expect(renderToHtml(toned)).toContain(
      '<span class="fuaran-grid-cell-pill fuaran-pill-success">x</span>',
    );
  });
});
