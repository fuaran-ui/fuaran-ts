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

import { renderBehindToHtml, renderToHtml } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const nodesDir = join(wireCorpusRoot(), 'nodes');

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
    // The deterministic renderer emits block elements — at least one real tag
    // inside the wrapper. Byte-parity with the client is `markdownCorpus`'s job.
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
        display: {
          kind: 'Markdown',
          spec: { citations: [], text: { kind: 'Literal', value: 'hi' } },
        },
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

  it('resolves a FragmentRef whose declaration sits in a state.onLoading alternative (Phase 2046)', () => {
    // The declaration is reachable only through a node's `state.onLoading`.
    // Collection used to stop at the kind, so the ref rendered the unresolved
    // placeholder although the tree declares the fragment.
    const style = { tone: 'Default', weight: 'Standard', emphasis: 'Normal' } as const;
    const md = (id: string, text: string) => ({
      id,
      kind: {
        kind: 'Display',
        display: {
          kind: 'Markdown',
          spec: { citations: [], text: { kind: 'Literal', value: text } },
        },
      },
      state: {},
      style,
    });
    const decl = {
      id: 'decl',
      kind: { kind: 'FragmentDecl', spec: { name: 'tpl', body: md('inner', 'hi') } },
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
              { ...md('host', 'body'), state: { onLoading: decl } },
              { id: 'ref', kind: { kind: 'FragmentRef', spec: { name: 'tpl' } }, state: {}, style },
            ],
          },
        },
      },
      state: {},
      style,
    } as unknown as Parameters<typeof renderToHtml>[0];
    const html = renderToHtml(tree);
    expect(html).not.toContain('fuaran-fragment-unresolved-placeholder');
    expect(html).toContain('data-fuaran-node-id="ref.inner"');
  });
});

describe('BehindView (Phase 1812)', () => {
  it('a Rendered view renders exactly as the node itself does', () => {
    const fb = decodeNode(
      '{"id":"h1-fallback","kind":{"$type":"Markdown","text":"A hologram would appear here."}}',
    );
    if (!fb.ok) throw new Error('the fallback decodes');
    expect(renderBehindToHtml({ kind: 'Rendered', node: fb.value })).toBe(renderToHtml(fb.value));
  });

  it('a Placeholder view is the labelled degrade — kind and the declared profile', () => {
    const html = renderBehindToHtml({
      kind: 'Placeholder',
      unknownKind: 'hologram',
      requiredProfile: 'core@1.4',
    });
    expect(html).toBe(
      '<div class="fuaran-unknown-placeholder" data-fuaran-kind="hologram" data-fuaran-requires="core@1.4">needs core@1.4</div>',
    );
    const bare = renderBehindToHtml({ kind: 'Placeholder', unknownKind: 'hologram' });
    expect(bare).toBe(
      '<div class="fuaran-unknown-placeholder" data-fuaran-kind="hologram">unknown kind hologram</div>',
    );
  });

  it('accessibility.speak changes no visual or ARIA output', () => {
    const named = decodeNode(
      '{"accessibility":{"label":{"$type":"Static","value":"Service status"}},"id":"m","kind":{"$type":"Markdown","text":"body"}}',
    );
    const spoken = decodeNode(
      '{"accessibility":{"label":{"$type":"Static","value":"Service status"},"speak":"Service status: all systems operational."},"id":"m","kind":{"$type":"Markdown","text":"body"}}',
    );
    if (!named.ok || !spoken.ok) throw new Error('both decode');
    expect(renderToHtml(spoken.value)).toBe(renderToHtml(named.value));
    expect(renderToHtml(spoken.value)).not.toContain('all systems operational');
  });
});

// Phase 2591 — a figure cited inside a sentence (WIRE_FORMAT §3.6.32).
describe('Markdown citations', () => {
  it('draws each figure in the line of text, with no tile and no link', () => {
    const html = render('markdown-citation-several.json');
    expect(html).toContain(
      '<span class="fuaran-cited" data-fact="fact:spend-q3">£412k</span> placed by <strong><span class="fuaran-cited" data-fact="fact:brands-q3"><span class="fuaran-cited-label">Brands placing </span>17</span></strong> brands',
    );
    expect(html).not.toContain('fuaran-kind-fact');
    expect(html).not.toContain('<a ');
  });

  it('leaves a sentence citing nothing as a dead link', () => {
    expect(render('markdown-citation-none.json')).toContain('<a href="about:blank">23%</a>');
  });
});

// Phase 2535 — a cited figure (WIRE_FORMAT §3.6.31): `data-fact` on the tile's root.
describe('Fact reference', () => {
  it('stamps data-fact on the tile', () => {
    expect(render('fact-cited.json')).toContain(
      '<div class="fuaran-fact fuaran-fact-default" data-fact="9f04f29b27c86926a1c3e5d7b8f0a2c4e6d8f0a1b3c5d7e9f1a3b5c7d9e1f3a5">',
    );
  });

  it('stamps nothing on an uncited tile', () => {
    expect(render('fact-1.json')).not.toContain('data-fact');
  });
});

// Phase 2571 — option groups (WIRE_FORMAT §3.6.30): one <optgroup> per group in
// list order, a group's options in `source` order, the ungrouped remainder last.
describe('Select option groups', () => {
  it('serves each group as an optgroup and the remainder after the groups', () => {
    const html = render('select-option-groups-remainder.json');
    expect(html).toContain(
      '<select class="fuaran-select-control"><optgroup label="Trend"><option value="revenue-trend">Revenue</option></optgroup><optgroup label="Breakdown"><option value="region-breakdown">By region</option></optgroup><option value="summary">Summary</option><option value="notes">Notes</option></select>',
    );
  });

  it("draws a group's options in source order, not the order its values are written", () => {
    const html = render('select-option-groups.json');
    expect(html).toContain(
      '<optgroup label="Trend"><option value="revenue-trend">Revenue</option><option value="orders-trend">Orders</option></optgroup>',
    );
  });

  it('serves an ungrouped select with no optgroup', () => {
    expect(render('select-1.json')).not.toContain('optgroup');
  });
});
