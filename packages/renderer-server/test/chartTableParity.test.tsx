// ============================================================================
//  Phase 2804 — a lowered chart offers its data table, byte for byte the
//  reference server renderer's, on both TypeScript tiers.
//
//  The ORACLE is the reference host's server renderer. Every document in
//  `fixtures/chart-table/` has its reference output beside it, produced by
//  `render-oracle.fsx` in that folder (its header carries the command):
//  `<name>.reference.txt` under the default policy, which offers the table, and
//  `<name>.off.txt` with the table turned off. Four claims:
//
//    1. ON BY DEFAULT, the server renderer's output is the reference's bytes.
//    2. OFF IS THE PAST: with `chartTable: 'Off'` it is the reference's off
//       bytes, which are this renderer's own pre-phase output for the same
//       documents (checked before the phase landed: every document rendered
//       equal to them).
//    3. THE CLIENT DRAWS THE SAME MARKUP: the React renderer's chart host
//       element is the server's, byte for byte, and with the policy off it
//       draws the drawing alone.
//    4. THE CONTRACT'S RULES: `a11y-contract.json`'s `chartTable` section is
//       read from the corpus and every rule it names is checked over both
//       tiers' markup for every document; a rule this suite has no check for
//       fails, so the contract and this tier cannot drift apart.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer, type ChartTablePolicy } from '@fuaran-ui/renderer';
import { permissiveEgress } from '@fuaran-ui/renderer/egress';

import { renderToHtml } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const fixtureDir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'chart-table');
const files = readdirSync(fixtureDir);
const documents = files.filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -'.json'.length));
const withOff = files
  .filter((f) => f.endsWith('.off.txt'))
  .map((f) => f.slice(0, -'.off.txt'.length));

const decode = (name: string) => {
  const decoded = decodeNode(readFileSync(join(fixtureDir, `${name}.json`), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${name}: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const server = (name: string, chartTable?: ChartTablePolicy): string =>
  renderToHtml(decode(name), chartTable !== undefined ? { chartTable } : {});

const client = (name: string, chartTable?: ChartTablePolicy): string =>
  renderToStaticMarkup(
    <FuaranRenderer
      tree={decode(name)}
      egressPolicy={permissiveEgress}
      {...(chartTable !== undefined ? { chartTable } : {})}
    />,
  );

const fixture = (file: string): string => readFileSync(join(fixtureDir, file), 'utf8');

/** The chart's host element: from the drawing's container to its close. */
const chartHost = (html: string): string | undefined => {
  const start = html.indexOf('<div class="fuaran-chart-table-host">');
  if (start < 0) return undefined;
  const stop = html.indexOf('</details></div>', start);
  return html.slice(start, stop + '</details></div>'.length);
};

describe('Phase 2804 — the chart table is the reference server renderer’s markup', () => {
  it('every document has its reference output, and every reference its document', () => {
    const references = files
      .filter((f) => f.endsWith('.reference.txt'))
      .map((f) => f.slice(0, -'.reference.txt'.length));
    expect(references.sort()).toEqual([...documents].sort());
    // A folder that lost its documents would make the sweeps below vacuous.
    expect(documents.length).toBeGreaterThanOrEqual(8);
    expect(withOff.length).toBeGreaterThanOrEqual(7);
  });

  it.each(documents)('%s renders byte-identically to the reference, table offered', (name) => {
    expect(server(name)).toBe(fixture(`${name}.reference.txt`));
  });

  it.each(withOff)('%s renders the pre-phase bytes with the table turned off', (name) => {
    expect(server(name, 'Off')).toBe(fixture(`${name}.off.txt`));
  });

  it.each(documents)('%s: the client draws the server’s chart host, byte for byte', (name) => {
    const host = chartHost(server(name));
    expect(host).toBeDefined();
    expect(chartHost(client(name))).toBe(host);
  });

  it.each(withOff)('%s: the client with the table turned off draws the drawing alone', (name) => {
    const html = client(name, 'Off');
    expect(html).not.toContain('fuaran-chart-table');
    expect(html).not.toContain('aria-details');
    const off = fixture(`${name}.off.txt`);
    const svg = off.slice(
      off.indexOf('<div><svg'),
      off.indexOf('</svg></div>') + '</svg></div>'.length,
    );
    expect(html).toContain(svg);
  });
});

describe('the claims the reference bytes carry', () => {
  it('the drawing names the disclosure, whose id occurs once, and there is no script', () => {
    for (const name of documents) {
      const html = server(name);
      const id = `chart-${name}-data-table`;
      expect(html).toContain(`<svg class="fuaran-drawing" role="img" aria-details="${id}"`);
      expect(html.split(`id="${id}"`).length - 1).toBe(1);
      expect(html).not.toContain('<script');
    }
  });

  it('each cell is the exact readout: a currency kept, a withheld value, a missing one empty', () => {
    const stacked = server('bar-stacked-currency');
    expect(stacked).toContain('<td>£3,400.25</td>');
    expect(stacked).toContain(
      '<th scope="row">South &lt;&amp;&gt; &quot;quoted&quot; &apos;x&apos;</th>',
    );
    expect(stacked).toContain('<caption>Stacked bar chart data</caption>');
    expect(server('bar-withheld-sorted')).toContain(
      '<tr><th scope="row">B</th><td>withheld</td></tr></tbody>',
    );
    expect(server('line-temporal')).toContain('<th scope="row">2026-01-03</th><td></td>');
  });

  it('past the row limit the table holds the first 1000 rows and states the count', () => {
    const html = server('line-limit');
    expect(html.split('<th scope="row">').length - 1).toBe(1000);
    expect(html).toContain('<p class="fuaran-chart-table-limit">Rows 1–1000 of 1003</p>');
  });

  it('a chart with no rows offers no table, on either tier', () => {
    const decoded = decodeNode(
      '{"id":"empty","kind":{"$type":"Chart","kind":"Bar","source":{"$type":"Static","value":[]},"xField":"q","yFields":["v"]}}',
    );
    if (!decoded.ok) throw new Error('decode failed');
    expect(renderToHtml(decoded.value)).not.toContain('fuaran-chart-table');
    expect(
      renderToStaticMarkup(<FuaranRenderer tree={decoded.value} egressPolicy={permissiveEgress} />),
    ).not.toContain('fuaran-chart-table');
  });
});

// ─── The accessibility contract's chartTable rules ───────────────────────────

interface ContractRule {
  readonly id: string;
}
const contract = JSON.parse(readFileSync(join(wireCorpusRoot(), 'a11y-contract.json'), 'utf8')) as {
  chartTable: { scope: string; rules: readonly ContractRule[] };
};

const childrenNamed = (e: Element, tag: string): Element[] =>
  [...e.children].filter((c) => c.localName === tag);

/** One check per rule id the contract names; each returns the failures it found. */
const checks: Record<string, (doc: Document, d: Element) => string[]> = {
  'disclosure-summary': (_, d) => {
    const first = d.firstElementChild;
    return first?.localName === 'summary' && (first.textContent ?? '') !== ''
      ? []
      : ['the first child is not a summary with text'];
  },
  'referenced-from-chart': (doc, d) => {
    if (d.id === '') return ['the disclosure carries no id'];
    const out: string[] = [];
    if (doc.querySelectorAll(`[id="${d.id}"]`).length !== 1)
      out.push(`the id ${d.id} is not unique`);
    const drawing = doc.querySelector('svg[role="img"]');
    if (drawing?.getAttribute('aria-details') !== d.id) out.push('the drawing does not name it');
    return out;
  },
  'one-table': (_, d) => (childrenNamed(d, 'table').length === 1 ? [] : ['not exactly one table']),
  caption: (_, d) => {
    const first = childrenNamed(d, 'table')[0]?.firstElementChild;
    return first?.localName === 'caption' && (first.textContent ?? '') !== ''
      ? []
      : ['the table does not open with a caption with text'];
  },
  'column-headers': (_, d) => {
    const row = d.querySelector('table > thead > tr');
    const cells = row === null ? [] : [...row.children];
    return cells.length > 0 &&
      cells.every(
        (c) => c.localName === 'th' && c.getAttribute('scope') === 'col' && c.textContent !== '',
      )
      ? []
      : ['the header row is not all th scope=col with text'];
  },
  'row-headers': (_, d) =>
    [...d.querySelectorAll('table > tbody > tr')].every((r) => {
      const [first, ...rest] = [...r.children];
      return (
        first?.localName === 'th' &&
        first.getAttribute('scope') === 'row' &&
        rest.every((c) => c.localName === 'td')
      );
    })
      ? []
      : ['a body row does not lead with th scope=row then td cells'],
  rectangular: (_, d) => {
    const width = d.querySelector('table > thead > tr')?.children.length ?? -1;
    return [...d.querySelectorAll('table > tbody > tr')].every((r) => r.children.length === width)
      ? []
      : ['a body row is not as wide as the header'];
  },
  'no-empty-body': (_, d) =>
    d.querySelectorAll('table > tbody > tr').length > 0 ? [] : ['the body holds no row'],
};

describe('a11y-contract.json — the chartTable rules hold on both tiers', () => {
  it('every rule the contract names has a check here', () => {
    expect(contract.chartTable.rules.length).toBeGreaterThanOrEqual(8);
    for (const rule of contract.chartTable.rules) expect(Object.keys(checks)).toContain(rule.id);
  });

  const tiers: readonly (readonly [string, (name: string) => string])[] = [
    ['server', (n) => server(n)],
    ['client', (n) => client(n)],
  ];
  for (const [tier, render] of tiers) {
    it.each(documents)(`%s (${tier}): every rule passes over the disclosure`, (name) => {
      const doc = new DOMParser().parseFromString(render(name), 'text/html');
      const disclosures = [...doc.querySelectorAll(contract.chartTable.scope)];
      // Not vacuous: every document here offers a table.
      expect(disclosures).toHaveLength(1);
      const failures = contract.chartTable.rules.flatMap((rule) =>
        checks[rule.id]!(doc, disclosures[0]!).map((f) => `${rule.id}: ${f}`),
      );
      expect(failures).toEqual([]);
    });
  }
});
