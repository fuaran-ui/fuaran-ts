// ============================================================================
//  Phase 951 — WHERE the a11y projection lands, server tier.
//
//  The twin of @fuaran-ui/renderer's a11yPlacement suite, and of the F# SSR
//  parity corpus's placement tests. A node's Accessibility projection (and the
//  aria-* half of extraAttributes) is emitted on the node's semantic element —
//  Link (<a>), Button (<button>), Image (<img>) — while the data-* half stays
//  on the wrapper beside data-fuaran-node-id. Every other kind keeps the whole
//  projection on the wrapper.
//
//  The render-parity corpus next door compares the CLASS and node-id SETS, not
//  attribute placement, so a tier that emitted the projection on the wrapper
//  while its twin emitted it on the anchor would pass it. Hence this file.
// ============================================================================

import { describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';
import { fuaran, node } from '@fuaran-ui/ui';

import { renderToHtml } from '../src/index.js';

/** A node carrying every projection slot the placement rule routes. */
const withA11y = (n: Node<unknown>): Node<unknown> =>
  node.withExtraAttribute(
    'data-test-hook',
    'nav',
    node.withExtraAttribute(
      'aria-current',
      'page',
      node.withAccessibility({ role: 'link', label: { kind: 'Static', value: 'Home' } }, n),
    ),
  );

/** The wrapper's own open tag — everything up to its first `>`. */
const wrapperTag = (markup: string): string => markup.slice(0, markup.indexOf('>') + 1);

const openTag = (markup: string, tag: string): string => {
  const from = markup.slice(markup.indexOf(`<${tag}`));
  return from.slice(0, from.indexOf('>') + 1);
};

describe('Phase 951 — the a11y projection targets the semantic element (server tier)', () => {
  it('Link — role / aria-* land on the <a>; data-* stays on the wrapper', () => {
    const markup = renderToHtml(withA11y(fuaran.link({ id: 'lk', href: '/home', label: 'Home' })));
    const wrapper = wrapperTag(markup);

    expect(wrapper).not.toContain('role=');
    expect(wrapper).not.toContain('aria-label');
    expect(wrapper).not.toContain('aria-current');
    expect(wrapper).toContain('data-fuaran-node-id="lk"');
    expect(wrapper).toContain('data-test-hook="nav"');

    const anchor = openTag(markup, 'a');
    expect(anchor).toContain('role="link"');
    expect(anchor).toContain('aria-label="Home"');
    expect(anchor).toContain('aria-current="page"');
    expect(anchor).not.toContain('data-test-hook');
  });

  it('Button — the projection lands on the <button>', () => {
    const markup = renderToHtml(withA11y(fuaran.button({ id: 'btn', label: 'Go' })));

    expect(wrapperTag(markup)).not.toContain('aria-label');
    expect(openTag(markup, 'button')).toContain('aria-label="Home"');
  });

  it('Image — the projection lands on the <img>', () => {
    const markup = renderToHtml(withA11y(fuaran.image({ id: 'img', src: '/a.png', alt: 'Alt' })));

    expect(wrapperTag(markup)).not.toContain('aria-label');
    expect(openTag(markup, 'img')).toContain('aria-label="Home"');
  });

  it('a non-forwarding kind keeps the whole projection on the wrapper', () => {
    const wrapper = wrapperTag(renderToHtml(withA11y(fuaran.markdown('md', 'x'))));

    expect(wrapper).toContain('role="link"');
    expect(wrapper).toContain('aria-label="Home"');
    expect(wrapper).toContain('aria-current="page"');
    expect(wrapper).toContain('data-test-hook="nav"');
  });

  // The protected-email Link builds its anchor as an entity-encoded opaque
  // string, so the projection lands on the wrap <span> — the only element that
  // arm owns in every tier. A stated limit, pinned so it stays deliberate.
  it('protected-email Link — the projection lands on the wrap span', () => {
    const markup = renderToHtml(
      withA11y(
        fuaran.link({ id: 'plk', href: 'mailto:u@e.com', label: 'u@e.com', protection: 'email' }),
      ),
    );

    expect(wrapperTag(markup)).not.toContain('aria-label');
    expect(openTag(markup, 'span')).toContain('aria-label="Home"');
  });
});
