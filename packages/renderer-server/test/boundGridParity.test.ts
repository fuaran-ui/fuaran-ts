// ============================================================================
//  Phase 2803 — a resolved bound grid is a table on the server, byte for byte
//  the reference server renderer's.
//
//  A `DataGrid` whose rows come from a binding that resolves where the page is
//  rendered (a pipeline over an embedded table, a State source with a default)
//  is drawn as the table the first-party client draws before any interaction:
//  the declared columns in order, each cell through its declared format, the
//  effective sort, the requested page with the renderer-owned pager, and past
//  the row limit the first 1000 rows with the total stated. A source that does
//  not resolve keeps the placeholder, which names why.
//
//  The ORACLE is the reference host's server renderer. Every document in
//  `fixtures/bound-grid/` has its reference output beside it as
//  `<name>.reference.txt`, produced by `render-oracle.fsx` in that folder (its
//  header carries the command). This file asserts the bytes are equal, and then
//  states the claims the bytes carry, so that a regenerated reference which
//  moved one of them fails here by name rather than passing as a new golden.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml } from '../src/index.js';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'bound-grid');
const files = readdirSync(fixtureDir);
const documents = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));

const render = (name: string): string => {
  const decoded = decodeNode(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${name}: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value);
};

const reference = (name: string): string =>
  readFileSync(join(fixtureDir, `${name}.reference.txt`), 'utf8');

const count = (needle: string, haystack: string): number => haystack.split(needle).length - 1;

const cells = (html: string): string[] =>
  [...html.matchAll(/<td class="fuaran-grid-cell"><span>([^<]*)<\/span><\/td>/g)].map((m) => m[1]!);

describe('Phase 2803 — the bound grid is the reference server renderer’s table', () => {
  it('every document has its reference output, and every reference its document', () => {
    const references = files
      .filter((f) => f.endsWith('.reference.txt'))
      .map((f) => f.slice(0, -'.reference.txt'.length));
    expect(references.sort()).toEqual([...documents].sort());
    // A folder that lost its documents would make the sweep below vacuous.
    expect(documents.length).toBeGreaterThanOrEqual(17);
  });

  it.each(documents)('%s renders byte-identically to the reference server renderer', (name) => {
    expect(render(name)).toBe(reference(name));
  });
});

describe('the claims the reference bytes carry', () => {
  it('a pipeline over an embedded table draws the evaluated rows, each through its format', () => {
    const html = render('pipeline-formatted');
    expect(html).not.toContain('fuaran-grid-ssr-placeholder');
    expect(html).not.toContain('hydrates client-side');
    // The groupBy's sums, in its output order, through the GBP format.
    expect(cells(html)).toEqual(['eng', '£220', 'sales', '£95', 'ops', '£40']);
  });

  it('the declared default sort is applied, and a sortable grid states it', () => {
    expect(cells(render('pipeline-default-sort'))).toEqual([
      'ops',
      '£40',
      'sales',
      '£95',
      'eng',
      '£220',
    ]);
    const sortable = render('pipeline-sortable');
    expect(sortable).toContain(
      '<th class="fuaran-grid-header" data-sortable="" tabindex="0" aria-sort="descending">Spend</th>',
    );
    expect(cells(sortable)[1]).toBe('£220');
  });

  it('a declared page draws the first page and a pager disabled only where it cannot move', () => {
    const html = render('paged-first-page');
    expect(cells(html)).toEqual(['1', '2']);
    expect(html).toContain(
      '<button class="fuaran-grid-pager-step" type="button" disabled="true">Previous</button>' +
        '<span class="fuaran-grid-pager-status" aria-live="polite">Page 1 of 3</span>' +
        '<button class="fuaran-grid-pager-step" type="button">Next</button>',
    );
  });

  it('past the 1000-row limit the first 1000 rows are drawn and the total stated', () => {
    const unpaged = render('limit-unpaged');
    expect(count('<tr class="fuaran-grid-row"', unpaged)).toBe(1000);
    expect(unpaged).toContain('<table class="fuaran-grid" aria-rowcount="1004">');
    expect(unpaged).toContain('Rows 1–1000 of 1003');
    expect(unpaged).not.toContain('<span>1001</span>');

    const exact = render('limit-exact');
    expect(count('<tr class="fuaran-grid-row"', exact)).toBe(1000);
    expect(exact).not.toContain('fuaran-grid-pager');
    expect(exact).not.toContain('aria-rowcount');

    const paged = render('limit-paged');
    expect(count('<tr class="fuaran-grid-row"', paged)).toBe(1000);
    expect(paged).toContain('aria-rowcount="1201"');
    expect(paged).toContain('Page 1 of 2');
  });

  it('an unresolved source keeps the placeholder, naming its reason', () => {
    expect(render('unresolved-query')).toContain(
      '[Grid: the host supplied no rows for query &quot;spend &quot;by&quot; &lt;dept&gt; &amp; ' +
        '&apos;team&apos;&quot; — hydrates client-side]',
    );
    expect(render('unresolved-state')).toContain(
      '[Grid: state &quot;spend-rows&quot; has no value — hydrates client-side]',
    );
    expect(render('unresolved-errored')).toContain(
      '[Grid: the source failed to resolve — hydrates client-side]',
    );
    // The print declarations ride the placeholder too.
    expect(render('unresolved-query')).toContain(
      'class="fuaran-grid fuaran-grid-ssr-placeholder fuaran-grid-rows-together"',
    );
  });

  it('the affordances that need script are left to hydration', () => {
    const editable = render('state-editable');
    expect(editable).not.toContain('<input');
    expect(cells(editable)).toEqual(['Jan', '980', 'Feb', '1105']);
    expect(render('state-reorderable')).not.toContain('fuaran-grid-reorder');
  });

  it('a resolved source with no rows is the empty table, or the empty slot where declared', () => {
    expect(render('pipeline-no-rows')).toContain('<tbody></tbody>');
    const slot = render('pipeline-on-empty');
    expect(slot).toContain('Nothing spent');
    expect(slot).not.toContain('<table');
  });
});
