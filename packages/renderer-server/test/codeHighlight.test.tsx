// ============================================================================
//  Phase 1854 — the deterministic CodeBlock highlighting tier on BOTH
//  TypeScript render paths.
//
//  The tokeniser is one shared builder (`codeHighlight` in @fuaran-ui/renderer),
//  and its byte table is pinned by the renderer's own `codeHighlight.test.ts`
//  against the SAME strings the F# tests pin (fuaran-dotnet/docs/CODE-HIGHLIGHT.md
//  §5). This file locks the other half: that the string server renderer and the
//  React client renderer emit the IDENTICAL `<code>` element — class, the
//  `data-highlighted` marker and the exact token bytes — for a highlighted block,
//  and the plain escaped `<code>` with no marker for a language with no grammar.
// ============================================================================

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';

const node = (id: string, language: string, code: string) => {
  const decoded = decodeNode(
    JSON.stringify({
      id,
      kind: {
        $type: 'CodeBlock',
        code,
        copyable: false,
        highlightLines: [],
        language,
        lineNumbers: false,
      },
    }),
  );
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const codeElement = (html: string): string => {
  const m = /<code[^>]*>[\s\S]*?<\/code>/.exec(html);
  if (m === null) throw new Error(`no <code> in ${html}`);
  return m[0];
};

const cases: ReadonlyArray<readonly [string, string, string, string]> = [
  [
    'F# — keyword, operator, number',
    'fsharp',
    'let x = 1',
    '<code class="fuaran-codeblock-code language-fsharp" data-highlighted="deterministic"><span class="tok-kw">let</span> x <span class="tok-op">=</span> <span class="tok-num">1</span></code>',
  ],
  [
    'F* — a multi-line comment is closed and reopened per line',
    'fstar',
    '(* a\n b *)\nval f : nat',
    '<code class="fuaran-codeblock-code language-fstar" data-highlighted="deterministic"><span class="tok-com">(* a</span>\n<span class="tok-com"> b *)</span>\n<span class="tok-kw">val</span> f <span class="tok-op">:</span> <span class="tok-ty">nat</span></code>',
  ],
  [
    'F* — escaping inside tokens',
    'fst',
    'let p = a <==> "<b>"',
    '<code class="fuaran-codeblock-code language-fst" data-highlighted="deterministic"><span class="tok-kw">let</span> p <span class="tok-op">=</span> a <span class="tok-op">&lt;==&gt;</span> <span class="tok-str">"&lt;b&gt;"</span></code>',
  ],
  [
    'no grammar — the plain escaped <code>, no marker',
    'python',
    'if a < b: pass',
    '<code class="fuaran-codeblock-code language-python">if a &lt; b: pass</code>',
  ],
];

describe('Phase 1854 — the CodeBlock highlighting tier, server and client byte-identical', () => {
  for (const [name, language, code, expected] of cases) {
    it(`${name}: the server renderer`, () => {
      expect(codeElement(renderToHtml(node('cb', language, code)))).toBe(expected);
    });

    it(`${name}: the client renderer emits the same element`, () => {
      const client = renderToStaticMarkup(<FuaranRenderer tree={node('cb', language, code)} />);
      expect(codeElement(client)).toBe(expected);
    });
  }
});
