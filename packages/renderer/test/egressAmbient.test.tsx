// ============================================================================
//  Phase 1037 — the destination policy is AMBIENT on the client render context.
//
//  Phase 1032 gave this host the egress SEAM: the policy model, a policy-taking
//  markdown entry point, and the shared corpus's policied fixtures passing
//  through it. What it did NOT do was make the policy reach a NODE RENDERER —
//  `RenderContext` carried no policy, so every emission site still went through
//  the pure permissive path and a decoded tree's `<img src>` reached whatever
//  host it named. This corpus is the difference between the two.
//
//  Three properties, and the FIRST is the acceptance criterion:
//
//   1. THE DEFAULT DENIES WITH NO CALLER OPT-IN. Every assertion below that
//      expects a refusal builds its context by rendering `<FuaranRenderer>` with
//      NO `egressPolicy` prop at all. A test that passed `denyNonLocalEgress`
//      explicitly would prove the seam works and say nothing about whether the
//      default reaches it — which is exactly the gap 1032 left.
//
//   2. EVERY DESTINATION-BEARING CALL SITE consults it, not just markdown: the
//      `Link` node's href, the `Image` node's src, the DataGrid link column's
//      per-row href, and `Action.Navigate`'s route.
//
//   3. THE REFUSAL NEVER CARRIES THE PAYLOAD. The marker names the class and the
//      host; the path and query — where an exfiltrated payload sits — appear
//      nowhere in the emitted document.
//
//  Parity oracle: the F# `Fuaran.UI.Renderer` `RenderContext.EgressPolicy` and
//  its `EgressRenderTests`. The class assignments here are the oracle's,
//  including `hyperlink` for a `download` anchor — the class names the SINK the
//  browser reaches, so flipping a tree boolean must not change which rule
//  applies.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { Column, Node } from '@fuaran-ui/schema';
import { defaults } from '@fuaran-ui/schema';
import { binding, fuaran } from '@fuaran-ui/ui';

import { runAction, treeNavigate, type RenderContext } from '../src/context.js';
import {
  allowOrigin,
  denyNonLocalEgress,
  egressRefusalUrl,
  permissiveEgress,
  sanitizeUrlForEgress,
  type EgressPolicy,
} from '../src/egress.js';
import { FuaranRenderer } from '../src/index.js';

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

const markdownNode = (source: string): Node<unknown> => {
  const decoded = decodeNode(
    JSON.stringify({ id: 'md', kind: { $type: 'Markdown', text: source } }),
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

/** Render with NO policy named — the shape the acceptance criterion is about. */
const renderDefault = (tree: Node<unknown>): string =>
  renderToStaticMarkup(<FuaranRenderer tree={tree} />);

const renderUnder = (tree: Node<unknown>, policy: EgressPolicy): string =>
  renderToStaticMarkup(<FuaranRenderer tree={tree} egressPolicy={policy} />);

// ─── The seam itself ────────────────────────────────────────────────────────

describe('sanitizeUrlForEgress — the one-call render seam', () => {
  it('returns the sanitised url and NO attributes on an allow', () => {
    expect(sanitizeUrlForEgress(permissiveEgress, 'hyperlink', 'https://ok.example/x')).toEqual([
      'https://ok.example/x',
      [],
    ]);
  });

  it('returns the refusal url + the class:host marker on an undeclared origin', () => {
    expect(
      sanitizeUrlForEgress(denyNonLocalEgress, 'media', 'https://collector.example/x?s=secret'),
    ).toEqual([egressRefusalUrl, [['data-fuaran-egress-refused', 'media:collector.example']]]);
  });

  it('marks a same-origin refusal `:local` and a non-network one by scheme', () => {
    const noLocal: EgressPolicy = { ...denyNonLocalEgress, allowLocal: false };
    expect(sanitizeUrlForEgress(noLocal, 'route', '/admin')).toEqual([
      egressRefusalUrl,
      [['data-fuaran-egress-refused', 'route:local']],
    ]);
    expect(sanitizeUrlForEgress(denyNonLocalEgress, 'hyperlink', 'mailto:a@b.example')).toEqual([
      egressRefusalUrl,
      [['data-fuaran-egress-refused', 'hyperlink:mailto']],
    ]);
  });

  it('renders the REFUSAL shape for an unsafe url, not the bare about:blank', () => {
    // The pre-1037 call sites emitted `sanitizeUrlOrBlank`'s bare `about:blank`
    // here. A silent neuter is indistinguishable from an authoring mistake;
    // the marker value is the bare `unsafe-url` because the floor rejected the
    // URL before there was any destination to name a class or host for.
    expect(sanitizeUrlForEgress(permissiveEgress, 'hyperlink', 'javascript:alert(1)')).toEqual([
      egressRefusalUrl,
      [['data-fuaran-egress-refused', 'unsafe-url']],
    ]);
  });
});

// ─── The markdown body, driven through the AMBIENT path ─────────────────────

const policiedFixtures = corpus.fixtures.filter(
  (f) => f.policy !== undefined && f.policy !== 'permissive',
);

describe('the markdown body renders under the ambient policy', () => {
  it('the corpus carries policied fixtures to drive', () => {
    // Without one, every assertion below runs on the permissive path and this
    // corpus would be green on a host that never made the policy ambient.
    expect(policiedFixtures.length).toBeGreaterThan(0);
  });

  it.each(
    corpus.fixtures
      .filter((f) => (f.policy ?? 'permissive') === 'denyNonLocal')
      .map((f) => [f.id, f] as const),
  )('%s — the DEFAULT context (no policy named) reproduces the corpus html', (_id, f) => {
    // The acceptance criterion, fixture by fixture: no caller opt-in anywhere.
    expect(renderDefault(markdownNode(f.source))).toContain(f.html);
  });

  it.each(
    corpus.fixtures
      .filter((f) => f.policy !== undefined && f.policy !== 'denyNonLocal')
      .map((f) => [f.id, f] as const),
  )('%s — the named policy reproduces the corpus html', (_id, f) => {
    expect(renderUnder(markdownNode(f.source), policyByName(f.policy))).toContain(f.html);
  });

  it('wraps the corpus html in the fuaran-markdown div, unchanged', () => {
    const html = renderDefault(markdownNode('# h'));
    expect(html).toContain('<div class="fuaran-markdown"><h1');
  });
});

// ─── The non-markdown call sites ────────────────────────────────────────────

const exfil = 'https://collector.example/x?s=secret';

describe('a decoded tree under the DEFAULT context refuses an undeclared destination', () => {
  it('Link href — refusal url + hyperlink:host marker, and no query anywhere', () => {
    const html = renderDefault(fuaran.link({ id: 'lk', href: exfil, label: 'go' }));
    expect(html).toContain(`href="${egressRefusalUrl}"`);
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('?s=');
    expect(html).not.toContain('/x');
  });

  it('Image src — refusal url + media:host marker, and no query anywhere', () => {
    const html = renderDefault(fuaran.image({ id: 'im', src: exfil, alt: 'a' }));
    expect(html).toContain(`src="${egressRefusalUrl}"`);
    expect(html).toContain('data-fuaran-egress-refused="media:collector.example"');
    expect(html).not.toContain('secret');
    expect(html).not.toContain('?s=');
  });

  it('a `download` anchor stays the HYPERLINK class — the sink, not the tree boolean', () => {
    const html = renderDefault(fuaran.link({ id: 'lk', href: exfil, label: 'go', download: true }));
    expect(html).toContain('data-fuaran-egress-refused="hyperlink:collector.example"');
    expect(html).not.toContain('download:collector.example');
  });

  it('the DataGrid link column — one refusal per row, from the row accessor', () => {
    const linkCol: Column<{ readonly u: string }, unknown> = {
      ...defaults.column<{ readonly u: string }, unknown>(),
      label: 'Link',
      kind: {
        kind: 'Link',
        href: (r) => r.u,
        label: () => ({ kind: 'Literal', value: 'open' }),
      },
    };
    const html = renderDefault(
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
    expect(html).not.toContain('?s=');
    expect(html).not.toContain('?t=');
  });

  it('a same-origin destination renders UNCHANGED — the default denies leaving, not linking', () => {
    const html = renderDefault(fuaran.link({ id: 'lk', href: '/reports/42', label: 'go' }));
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
      renderUnder(fuaran.image({ id: 'im', src: 'https://cdn.example/a.png', alt: 'a' }), declared),
    ).toContain('src="https://cdn.example/a.png"');
    // Same host, undeclared class — refused, which is the whole point of
    // scoping a rule to classes rather than to hosts alone.
    expect(
      renderUnder(
        fuaran.link({ id: 'lk', href: 'https://cdn.example/a.png', label: 'go' }),
        declared,
      ),
    ).toContain('data-fuaran-egress-refused="hyperlink:cdn.example"');
  });
});

// ─── Action.Navigate — a refusal navigates NOWHERE ──────────────────────────

const mkCtx = (
  policy: EgressPolicy,
  navigate: (route: string) => void,
  warn: (m: string) => void,
): RenderContext<string> => ({
  sources: {},
  runtime: { navigate, warn },
  dispatch: () => {},
  fragments: new Map(),
  expandingFragments: new Set(),
  inErrorBoundary: false,
  egressPolicy: policy,
});

describe('Action.Navigate consults the ambient policy before navigating', () => {
  it('a refused route performs NO navigation at all and warns', () => {
    // Unlike an href, where the anchor must stay structurally valid, a
    // navigation the author never asked for is not an improvement on a refused
    // one — so this emits nothing rather than navigating to about:blank.
    const navigate = vi.fn();
    const warn = vi.fn();
    runAction(mkCtx(denyNonLocalEgress, navigate, warn), { kind: 'Navigate', route: exfil });
    expect(navigate).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toContain(
      "origin 'collector.example' is not declared for 'route'",
    );
  });

  it('the warn diagnostic names the class and host; the RETURNED reason carries no payload', () => {
    const warn = vi.fn();
    const reason = treeNavigate(
      mkCtx(denyNonLocalEgress, () => {}, warn),
      exfil,
      () => {},
    );
    expect(reason).toBeDefined();
    expect(reason).not.toContain('secret');
    expect(reason).not.toContain('?s=');
  });

  it('a same-origin route navigates with the SANITISED route', () => {
    const navigate = vi.fn();
    runAction(
      mkCtx(denyNonLocalEgress, navigate, () => {}),
      { kind: 'Navigate', route: '/admin' },
    );
    expect(navigate).toHaveBeenCalledWith('/admin');
  });

  it('a declared origin navigates under a route rule', () => {
    const navigate = vi.fn();
    const policy = allowOrigin(
      { match: 'exact', host: 'app.example' },
      ['route'],
      denyNonLocalEgress,
    );
    runAction(
      mkCtx(policy, navigate, () => {}),
      {
        kind: 'Navigate',
        route: 'https://app.example/dash',
      },
    );
    expect(navigate).toHaveBeenCalledWith('https://app.example/dash');
  });
});
