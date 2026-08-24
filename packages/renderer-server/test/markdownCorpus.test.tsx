// ============================================================================
//  Deterministic markdown on the SERVER — the corpus leg + the client-parity
//  lock (Phase 1041).
//
//  This package used to render markdown through npm `marked`, which made the
//  server a second markdown implementation inside a renderer whose whole
//  contract is being a fidelity twin of the client. The two disagreed on 27 of
//  the corpus's 57 fixtures, and the disagreement stopped being cosmetic once
//  markdown started carrying POLICY semantics: `marked` has no notion of a
//  destination policy, so a refusal the corpus pins as
//  `about:blank#fuaran-egress-refused` rendered as the live destination.
//
//  Two legs, and they answer different questions:
//
//   Leg 1 (CORPUS) — this package's exported markdown surface reproduces every
//     `source → html` pair in the shared corpus byte-for-byte, under the policy
//     each fixture names. That is the cross-host contract the F#, Python and TS
//     client hosts each assert against, so passing it is what puts the server
//     renderer in the same equivalence class rather than merely near it.
//
//   Leg 2 (CLIENT PARITY, end to end) — for every corpus source, a decoded
//     `Markdown` node rendered by `renderToHtml` is byte-identical to the same
//     node rendered by `<FuaranRenderer>` through `renderToStaticMarkup`. Leg 1
//     alone would pass on a server that routed its Markdown display somewhere
//     else entirely; this leg is the one that pins the PATH, not just the
//     function.
//
//     Phase 1037 — it now runs under the policy each fixture NAMES, on both
//     sides, because the policy became ambient on both render contexts. Before
//     1037 it ran permissively for a stated reason: neither call site passed a
//     policy, so asserting a policied parity would have asserted a property the
//     shipped renderers did not have. That is no longer true, and the parity is
//     stronger for it — two tiers agreeing on the permissive path say nothing
//     about whether they agree on a refusal.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';
import {
  allowOrigin,
  denyNonLocalEgress,
  permissiveEgress,
  type EgressPolicy,
} from '@fuaran-ui/renderer';

import { renderToHtml, toHtml, toHtmlWithEgress } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer-server/test → Fuaran-UI/wire-format-fixtures/markdown/corpus.json
const corpusPath = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'wire-format-fixtures',
  'markdown',
  'corpus.json',
);

interface Fixture {
  id: string;
  description: string;
  source: string;
  html: string;
  /** WIRE_FORMAT §14.1 — the destination policy the render is performed under. */
  policy?: string;
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { fixtures: Fixture[] };

/**
 * The named policies of WIRE_FORMAT §14.1, CONSTRUCTED here — the corpus names
 * a policy, it never carries one as data. An unknown name throws rather than
 * falling back to the permissive one: a silent fallback would turn a fixture
 * this host cannot evaluate into one it appears to pass.
 */
const policyByName = (name: string | undefined): EgressPolicy => {
  switch (name ?? 'permissive') {
    case 'permissive':
      return permissiveEgress;
    case 'denyNonLocal':
      return denyNonLocalEgress;
    case 'declaredExample':
      return allowOrigin(
        { match: 'suffix', host: 'docs.example' },
        ['hyperlink'],
        allowOrigin({ match: 'exact', host: 'cdn.example' }, ['media'], denyNonLocalEgress),
      );
    default:
      throw new Error(`markdown corpus names a policy this host does not construct: '${name}'`);
  }
};

const markdownNode = (source: string) => {
  const decoded = decodeNode(
    JSON.stringify({ id: 'md', kind: { $type: 'Markdown', text: source } }),
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

describe('Leg 1 — the server markdown surface IS the deterministic corpus renderer', () => {
  it('the corpus is non-empty and exercises the destination policy', () => {
    // A guard on the CORPUS rather than on this renderer: with no policied
    // fixture every assertion below would run on the permissive path, and this
    // gate would be green on a host that never implemented §14.1 at all.
    expect(corpus.fixtures.length).toBeGreaterThan(0);
    expect(
      corpus.fixtures.filter((f) => f.policy !== undefined && f.policy !== 'permissive').length,
    ).toBeGreaterThan(0);
  });

  it.each(corpus.fixtures.map((f) => [f.id, f] as const))(
    '%s — server render is byte-identical to the corpus',
    (_id, f) => {
      expect(toHtmlWithEgress(policyByName(f.policy), f.source)).toBe(f.html);
    },
  );

  it.each(
    corpus.fixtures
      .filter((f) => (f.policy ?? 'permissive') === 'permissive')
      .map((f) => [f.id, f] as const),
  )('%s — the pure toHtml IS the permissive case', (_id, f) => {
    expect(toHtml(f.source)).toBe(f.html);
  });
});

describe('Leg 2 — a rendered Markdown node is byte-identical to the client renderer', () => {
  it.each(corpus.fixtures.map((f) => [f.id, f] as const))(
    '%s — renderToHtml equals <FuaranRenderer> through renderToStaticMarkup',
    (_id, f) => {
      const tree = markdownNode(f.source);
      const policy = policyByName(f.policy);
      expect(renderToHtml(tree, { egressPolicy: policy })).toBe(
        renderToStaticMarkup(<FuaranRenderer tree={tree} egressPolicy={policy} />),
      );
    },
  );

  it('the two tiers agree on the DEFAULT policy too, with neither told what it is', () => {
    // The pair above names a policy on both sides, so it would still pass if
    // the two tiers had picked different DEFAULTS. This one does not name one.
    const tree = markdownNode('[r](https://collector.example/x?s=secret)');
    expect(renderToHtml(tree)).toBe(renderToStaticMarkup(<FuaranRenderer tree={tree} />));
    expect(renderToHtml(tree)).toContain(
      'data-fuaran-egress-refused="hyperlink:collector.example"',
    );
  });
});

describe('the retired `marked` path stays retired', () => {
  it('renders raw inline HTML escaped, not passed through', () => {
    // `marked` emitted `<div>x</div>` verbatim; the deterministic renderer puts
    // raw HTML in the OUT bucket and escapes it. This is the single largest
    // behavioural difference for a document that contained HTML.
    expect(toHtml('<div>x</div>')).toBe('<p>&lt;div&gt;x&lt;/div&gt;</p>\n');
  });

  it('emits the fuaran-* table vocabulary a GFM table lowers to', () => {
    const html = toHtml('| H |\n| - |\n| a |\n');
    expect(html).toContain('class="fuaran-table"');
    expect(html).toContain('class="fuaran-table-header"');
    expect(html).toContain('class="fuaran-table-cell"');
  });

  it('refuses an undeclared destination under a deny policy', () => {
    const html = toHtmlWithEgress(denyNonLocalEgress, '[r](https://collector.example/x?s=secret)');
    expect(html).toContain('about:blank#fuaran-egress-refused');
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    // The query string of a refused exfiltration attempt is the payload itself.
    expect(html).not.toContain('secret');
  });
});
