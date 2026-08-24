// ============================================================================
//  Phase 1037 — the destination policy is AMBIENT on the SERVER render context.
//
//  The server twin of `@fuaran-ui/renderer`'s `egressAmbient.test.tsx`, and the
//  tier where the default matters most: a refused `<img src>` in a
//  server-rendered document is fetched by the browser BEFORE any script runs,
//  so there is no client-side gate downstream of this one.
//
//  Same three properties, same discipline. Every assertion that expects a
//  refusal calls `renderToHtml(tree)` with NO options object at all — a test
//  that passed `denyNonLocalEgress` explicitly would prove the seam works and
//  say nothing about whether the default reaches it.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import {
  allowOrigin,
  denyNonLocalEgress,
  egressRefusalUrl,
  permissiveEgress,
  type EgressPolicy,
} from '@fuaran-ui/renderer/egress';
import type { Column, Node } from '@fuaran-ui/schema';
import { defaults } from '@fuaran-ui/schema';
import { binding, fuaran } from '@fuaran-ui/ui';

import { renderToHtml } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
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
  policy?: string;
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { fixtures: Fixture[] };

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

const markdownNode = (source: string): Node<unknown> => {
  const decoded = decodeNode(
    JSON.stringify({ id: 'md', kind: { $type: 'Markdown', text: source } }),
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const exfil = 'https://collector.example/x?s=secret';

// ─── The markdown body, driven through the AMBIENT path ─────────────────────

describe('the server markdown body renders under the ambient policy', () => {
  it('the corpus carries policied fixtures to drive', () => {
    expect(
      corpus.fixtures.filter((f) => f.policy !== undefined && f.policy !== 'permissive').length,
    ).toBeGreaterThan(0);
  });

  it.each(
    corpus.fixtures
      .filter((f) => (f.policy ?? 'permissive') === 'denyNonLocal')
      .map((f) => [f.id, f] as const),
  )('%s — the DEFAULT render (no options) reproduces the corpus html', (_id, f) => {
    expect(renderToHtml(markdownNode(f.source))).toContain(f.html);
  });

  it.each(
    corpus.fixtures
      .filter((f) => f.policy !== undefined && f.policy !== 'denyNonLocal')
      .map((f) => [f.id, f] as const),
  )('%s — the named policy reproduces the corpus html', (_id, f) => {
    expect(
      renderToHtml(markdownNode(f.source), { egressPolicy: policyByName(f.policy) }),
    ).toContain(f.html);
  });
});

// ─── The non-markdown call sites ────────────────────────────────────────────

describe('a decoded tree under the DEFAULT render refuses an undeclared destination', () => {
  it('Link href — refusal url + hyperlink:host marker, and no query anywhere', () => {
    const html = renderToHtml(fuaran.link({ id: 'lk', href: exfil, label: 'go' }));
    expect(html).toContain(`href="${egressRefusalUrl}"`);
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('?s=');
  });

  it('Image src — refusal url + media:host marker, and no query anywhere', () => {
    const html = renderToHtml(fuaran.image({ id: 'im', src: exfil, alt: 'a' }));
    expect(html).toContain(`src="${egressRefusalUrl}"`);
    expect(html).toContain('data-fuaran-egress-refused="media:collector.example"');
    expect(html).not.toContain('secret');
  });

  it('a `download` anchor stays the HYPERLINK class', () => {
    const html = renderToHtml(fuaran.link({ id: 'lk', href: exfil, label: 'go', download: true }));
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    expect(html).not.toContain('download:collector.example');
  });

  it('the DataGrid link column — one refusal per row', () => {
    const linkCol: Column<{ readonly u: string }, unknown> = {
      ...defaults.column<{ readonly u: string }, unknown>(),
      label: 'Link',
      kind: {
        kind: 'Link',
        href: (r) => r.u,
        label: () => ({ kind: 'Literal', value: 'open' }),
      },
    };
    const html = renderToHtml(
      fuaran.grid<{ readonly u: string }, unknown>({
        id: 'g',
        source: binding.static<readonly { readonly u: string }[]>([
          { u: exfil },
          { u: 'https://other.example/y?t=also-secret' },
        ]),
        rowKey: (r) => r.u,
        columns: [linkCol],
      }),
    );
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:other.example"');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('?t=');
  });

  it('a same-origin destination renders UNCHANGED', () => {
    const html = renderToHtml(fuaran.link({ id: 'lk', href: '/reports/42', label: 'go' }));
    expect(html).toContain('href="/reports/42"');
    expect(html).not.toContain('fuaran-egress-refused');
  });

  it('a DECLARED origin renders unchanged, and only for its declared class', () => {
    const declared = allowOrigin(
      { match: 'exact', host: 'cdn.example' },
      ['media'],
      denyNonLocalEgress,
    );
    expect(
      renderToHtml(fuaran.image({ id: 'im', src: 'https://cdn.example/a.png', alt: 'a' }), {
        egressPolicy: declared,
      }),
    ).toContain('src="https://cdn.example/a.png"');
    expect(
      renderToHtml(fuaran.link({ id: 'lk', href: 'https://cdn.example/a.png', label: 'go' }), {
        egressPolicy: declared,
      }),
    ).toContain('data-fuaran-egress-refused="hyperlink:cdn.example"');
  });

  it('an unsafe url renders the REFUSAL shape, not the bare about:blank', () => {
    // Pre-1037 this call site emitted `sanitizeUrlOrBlank`'s bare
    // `about:blank`. "Nothing happened" and "this was refused" are different
    // facts, and only one of them is debuggable.
    const html = renderToHtml(fuaran.link({ id: 'lk', href: 'javascript:alert(1)', label: 'go' }));
    expect(html).toContain(`href="${egressRefusalUrl}"`);
    expect(html).toContain('data-fuaran-egress-refused="unsafe-url"');
  });
});
