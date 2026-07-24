// ============================================================================
//  Server-renderer unit tests — decode every node fixture and assert the
//  body-fragment HTML carries the wrapper markers + class vocabulary, and that
//  the server semantics hold: interactivity is inert (no event handlers), a Link
//  is a real crawlable <a href>, Markdown becomes real HTML, a Custom node is an
//  inert labelled placeholder, and Tabs carry their ARIA roles.
// ============================================================================

import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer-server/test → Fuaran-UI/wire-format-fixtures/nodes
const nodesDir = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'nodes');

const fixtureFiles = readdirSync(nodesDir)
  .filter((f) => f.endsWith('.json'))
  .sort();

const render = (file: string): string => {
  const decoded = decodeNode(readFileSync(join(nodesDir, file), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${file}: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value);
};

describe('renderToHtml — body fragment over the fixture corpus', () => {
  it('has fixtures to render', () => {
    expect(fixtureFiles.length).toBeGreaterThan(20);
  });

  it.each(fixtureFiles)('%s renders to a non-empty body fragment with wrapper markers', (file) => {
    const html = render(file);
    expect(html.length).toBeGreaterThan(0);
    expect(html).toContain('data-fuaran-node-id');
    expect(html).toMatch(/class="fuaran-/);
    // No React server-rendering artefacts — this is a pure string renderer.
    expect(html).not.toContain('data-reactroot');
  });
});

describe('server semantics', () => {
  it('renders a button inert — a real <button>, no event handlers', () => {
    const html = render('btn-1.json');
    expect(html).toContain('<button');
    expect(html).toMatch(/class="fuaran-button/);
    expect(html.toLowerCase()).not.toContain('onclick');
  });

  it('renders a Link as a real crawlable <a href> (the no-JavaScript navigation path)', () => {
    const html = render('link-1.json');
    expect(html).toMatch(/<a [^>]*href="/);
    expect(html).toContain('fuaran-link');
  });

  it('renders Markdown to real HTML, not a degraded fallback', () => {
    const html = render('markdown-1.json');
    expect(html).toContain('fuaran-markdown');
    // marked emits block elements — at least one real tag inside the wrapper.
    expect(html).toMatch(/fuaran-markdown">[\s\S]*<(p|h[1-6]|ul|ol|pre|blockquote)/);
  });

  it('renders a Custom node as an inert labelled placeholder', () => {
    const html = render('custom-1.json');
    expect(html).toContain('fuaran-custom-placeholder');
    expect(html).toContain('fuaran-custom-label');
    expect(html).toContain('fuaran-custom-props');
  });

  it('renders Tabs with the ARIA tablist / tab / tabpanel roles', () => {
    const html = render('tabs-1.json');
    expect(html).toContain('role="tablist"');
    expect(html).toContain('role="tab"');
    expect(html).toContain('role="tabpanel"');
  });

  it('renders a Metric label + value', () => {
    const html = render('metric-1.json');
    expect(html).toContain('fuaran-metric-label');
    expect(html).toContain('fuaran-metric-value');
  });

  it('renders an unresolved FragmentRef as a labelled placeholder (no declaration in tree)', () => {
    // frag-ref-1 references a fragment declared elsewhere — server matches the
    // client by rendering the unresolved placeholder rather than throwing.
    const html = render('frag-ref-1.json');
    expect(html).toContain('fuaran-fragment-unresolved-placeholder');
  });

  it('expands a self-contained FragmentRef with namespaced interior node-ids', () => {
    // A Dashboard holding a FragmentDecl + a FragmentRef to it: the ref expands
    // the decl body with every interior node-id prefixed by `${refNodeId}.`.
    const style = { tone: 'Default', weight: 'Standard', emphasis: 'Normal' } as const;
    const body = {
      id: 'inner',
      kind: {
        kind: 'Display',
        display: { kind: 'Markdown', spec: { text: { kind: 'Literal', value: 'hi' } } },
      },
      state: {},
      style,
    };
    const tree = {
      id: 'root',
      kind: {
        kind: 'Layout',
        layout: {
          kind: 'Box',
          spec: {
            layout: { kind: 'Auto' },
            role: 'Dashboard',
            children: [
              {
                id: 'decl',
                kind: { kind: 'FragmentDecl', spec: { name: 'tpl', body } },
                state: {},
                style,
              },
              { id: 'ref', kind: { kind: 'FragmentRef', spec: { name: 'tpl' } }, state: {}, style },
            ],
          },
        },
      },
      state: {},
      style,
    } as unknown as Parameters<typeof renderToHtml>[0];
    const html = renderToHtml(tree);
    expect(html).toContain('data-fuaran-node-id="ref.inner"');
  });
});
