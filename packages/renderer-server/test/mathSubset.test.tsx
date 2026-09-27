// ============================================================================
//  Phase 1853 — the widened no-JS MathML subset on BOTH TypeScript render paths.
//
//  The translator is one shared builder (`mathMl` in @fuaran-ui/renderer), and its
//  byte table is pinned by the renderer's own `mathMl.test.ts` against the SAME
//  strings the F# tests pin (`fuaran-dotnet/docs/MATH-DEGRADATION.md`, rows
//  21–49). This file locks the other half: that the string server renderer and
//  the React client renderer each put exactly those bytes inside the Math
//  container — including the pre-escaped `&lt;` — so neither path re-escapes,
//  drops or rewrites the widened MathML on its way into the page.
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';

const MATH_TAG = (disp: 'block' | 'inline'): string =>
  `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${disp}">`;

const node = (id: string, source: string, display: 'Block' | 'Inline') => {
  const decoded = decodeNode(JSON.stringify({ id, kind: { $type: 'Math', display, source } }));
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const cases: ReadonlyArray<readonly [string, string, 'Block' | 'Inline', string]> = [
  [
    'row 21 — the quantified statement',
    '\\forall x.\\ x \\in S \\Rightarrow f(x) \\le c',
    'Block',
    '<mo>∀</mo><mi>x</mi><mo>.</mo><mspace width="0.3333em"></mspace><mi>x</mi><mo>∈</mo><mi>S</mi><mo>⇒</mo><mi>f</mi><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow><mo>≤</mo><mi>c</mi>',
  ],
  [
    'rows 27/29/30 — pre-escaped \\lt beside the named terms',
    '\\mathit{unregistered\\_refused}(k) \\lt \\mathrm{Dom} \\subset \\text{Keys}',
    'Inline',
    '<mi mathvariant="italic">unregistered_refused</mi><mrow><mo>(</mo><mi>k</mi><mo>)</mo></mrow><mo>&lt;</mo><mi mathvariant="normal">Dom</mi><mo>⊂</mo><mtext>Keys</mtext>',
  ],
];

describe('Math — the Phase 1853 widened subset, server and client', () => {
  it.each(cases)('%s: both render paths carry the exact MathML', (_name, source, display, body) => {
    const expected = `${MATH_TAG(display === 'Block' ? 'block' : 'inline')}${body}</math>`;
    const tree = node('m', source, display);
    const server = renderToHtml(tree);
    const client = renderToStaticMarkup(<FuaranRenderer tree={tree} />);
    expect(server).toContain(expected);
    expect(client).toContain(expected);
    // the deterministic tier is the MathML, not the source fallback
    expect(server).not.toContain('fuaran-math-source');
    expect(client).not.toContain('fuaran-math-source');
  });

  it('an out-of-subset neighbour (bare <) still falls back to the source span on both paths', () => {
    const tree = node('m', 'x < y', 'Inline');
    for (const html of [renderToHtml(tree), renderToStaticMarkup(<FuaranRenderer tree={tree} />)]) {
      expect(html).toContain('fuaran-math-source');
      expect(html).not.toContain('<math');
    }
  });
});
