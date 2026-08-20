// ============================================================================
//  Phase 951 — WHERE the a11y projection lands.
//
//  A node's Accessibility projection (and the aria-* half of extraAttributes)
//  belongs on the node's SEMANTIC ELEMENT — the single element the kind body
//  renders, when that element rather than the wrapper carries the node's
//  semantics: Link (<a>), Button (<button>), Image (<img>). Every other kind
//  keeps the projection on the wrapper <div>, where the data-* half always
//  stays (it is addressing, beside data-fuaran-node-id).
//
//  Two things this file pins that nothing else can:
//
//   1. PLACEMENT, not presence. The fixture-corpus snapshots and the F# SSR
//      parity corpus assert that an attribute appears SOMEWHERE in the emitted
//      HTML, so neither can tell a role="link" on the wrapper from one on the
//      anchor — which is the whole of the defect.
//
//   2. WHY the axe gate never caught it. Measured here rather than assumed:
//      the pre-fix Button shape (role="button" on a <div> wrapping a <button>)
//      IS a serious `nested-interactive` violation, so the gate would have
//      fired had any corpus fixture carried a11y on a Button — none does. The
//      pre-fix Link shape (role="link" on a <div> wrapping an <a href>) is NOT
//      a violation at any severity: axe cannot see "the right attribute on the
//      wrong element" when the resulting shape is still legal HTML. So an
//      all-green axe run is not evidence of correct placement, and these
//      assertions are what stands in for it.
// ============================================================================

import axe from 'axe-core';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { fuaran, node } from '@fuaran-ui/ui';

import { FuaranRenderer } from '../src/index.js';

/** A node carrying every projection slot the placement rule routes. */
const withA11y = <T,>(n: T): T =>
  node.withExtraAttribute(
    'data-test-hook',
    'nav',
    node.withExtraAttribute(
      'aria-current',
      'page',
      node.withAccessibility(
        { role: 'link', label: { kind: 'Static', value: 'Home' } },
        n as never,
      ),
    ),
  ) as T;

const html = (n: Parameters<typeof FuaranRenderer>[0]['tree']): string =>
  renderToStaticMarkup(<FuaranRenderer tree={n} />);

/** The wrapper's own open tag — everything up to its first `>`. */
const wrapperTag = (markup: string): string => markup.slice(0, markup.indexOf('>') + 1);

/** The open tag of the first `<tag …>` in the markup. */
const openTag = (markup: string, tag: string): string => {
  const from = markup.slice(markup.indexOf(`<${tag}`));
  return from.slice(0, from.indexOf('>') + 1);
};

describe('Phase 951 — the a11y projection targets the semantic element', () => {
  it('Link — role / aria-* land on the <a>; data-* stays on the wrapper', () => {
    const markup = html(withA11y(fuaran.link({ id: 'lk', href: '/home', label: 'Home' })));
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
    const markup = html(withA11y(fuaran.button({ id: 'btn', label: 'Go' })));

    expect(wrapperTag(markup)).not.toContain('aria-label');
    const button = openTag(markup, 'button');
    expect(button).toContain('aria-label="Home"');
    expect(button).toContain('aria-current="page"');
  });

  it('Image — the projection lands on the <img>', () => {
    const markup = html(withA11y(fuaran.image({ id: 'img', src: '/a.png', alt: 'Alt' })));

    expect(wrapperTag(markup)).not.toContain('aria-label');
    expect(openTag(markup, 'img')).toContain('aria-label="Home"');
  });

  it('a non-forwarding kind keeps the whole projection on the wrapper', () => {
    const markup = html(withA11y(fuaran.markdown('md', 'x')));
    const wrapper = wrapperTag(markup);

    expect(wrapper).toContain('role="link"');
    expect(wrapper).toContain('aria-label="Home"');
    expect(wrapper).toContain('aria-current="page"');
    expect(wrapper).toContain('data-test-hook="nav"');
  });

  // The go-red witness for the rule: the shape we moved AWAY from is a real
  // axe violation, and the shape we moved TO is not. Without this pair the
  // suite could pass on a renderer that had silently reverted.
  it('the pre-fix wrapper placement is a serious nested-interactive violation; the new one is clean', async () => {
    const violationIds = async (markup: string): Promise<string[]> => {
      document.body.innerHTML = `<main>${markup}</main>`;
      const results = await axe.run(document.body, {
        rules: { 'color-contrast': { enabled: false } },
      });
      return results.violations
        .filter((v) => v.impact === 'serious' || v.impact === 'critical')
        .map((v) => v.id);
    };

    const preFix =
      '<div id="btn" data-fuaran-node-id="btn" class="fuaran-kind-button" role="button" aria-label="Home">' +
      '<button class="fuaran-button fuaran-button-secondary">Go</button></div>';

    expect(await violationIds(preFix)).toContain('nested-interactive');
    expect(await violationIds(html(withA11y(fuaran.button({ id: 'btn', label: 'Go' }))))).toEqual(
      [],
    );
  });
});
