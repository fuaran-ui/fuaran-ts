// Phase 1854 — byte-for-byte cover for `codeHighlight`, the deterministic CodeBlock
// highlighting tier. This is the TypeScript half of the shared fixture-table oracle
// in `fuaran-dotnet/docs/CODE-HIGHLIGHT.md` §5; the F# reference
// (`fuaran-dotnet/src/Fuaran.UI.Tests/CodeHighlightTests.fs`) pins the SAME strings,
// row for row, so the two implementations cannot silently diverge.
import { createHash } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import {
  codeGrammarFor,
  codeHighlight,
  codeHighlightWith,
  FSHARP,
  FSTAR,
} from '../src/codeHighlight.js';

// [row, language, source, exact inner bytes | null (no grammar)]
const FIXTURES: ReadonlyArray<readonly [number, string, string, string | null]> = [
  [
    1,
    'fstar',
    'val f : x:nat -> Tot nat',
    '<span class="tok-kw">val</span> f <span class="tok-op">:</span> x<span class="tok-op">:</span><span class="tok-ty">nat</span> <span class="tok-op">-&gt;</span> <span class="tok-ty">Tot</span> <span class="tok-ty">nat</span>',
  ],
  [
    2,
    'fstar',
    'assume val lemma_pos : n:nat -> Lemma (requires n > 0) (ensures n >= 1)',
    '<span class="tok-kw">assume</span> <span class="tok-kw">val</span> lemma_pos <span class="tok-op">:</span> n<span class="tok-op">:</span><span class="tok-ty">nat</span> <span class="tok-op">-&gt;</span> <span class="tok-ty">Lemma</span> (<span class="tok-kw">requires</span> n <span class="tok-op">&gt;</span> <span class="tok-num">0</span>) (<span class="tok-kw">ensures</span> n <span class="tok-op">&gt;=</span> <span class="tok-num">1</span>)',
  ],
  [
    3,
    'fstar',
    'p ==> q <==> r /\\ s \\/ t =!= u',
    'p <span class="tok-op">==&gt;</span> q <span class="tok-op">&lt;==&gt;</span> r <span class="tok-op">/\\</span> s <span class="tok-op">\\/</span> t <span class="tok-op">=!=</span> u',
  ],
  [
    4,
    'fstar',
    '(* outer (* inner *) still outer *) let',
    '<span class="tok-com">(* outer (* inner *) still outer *)</span> <span class="tok-kw">let</span>',
  ],
  [
    5,
    'fstar',
    '(* one\n   two *)\nval x : int',
    '<span class="tok-com">(* one</span>\n<span class="tok-com">   two *)</span>\n<span class="tok-kw">val</span> x <span class="tok-op">:</span> <span class="tok-ty">int</span>',
  ],
  [
    6,
    'fsharp',
    'let s = "open\nlet t = 1',
    '<span class="tok-kw">let</span> s <span class="tok-op">=</span> <span class="tok-str">"open</span>\n<span class="tok-str">let t = 1</span>',
  ],
  [7, 'python', 'if a < b: pass', null],
  [
    8,
    'fsharp',
    '/// doc\nlet x = 0x1Fu + 1.5e-3 // tail',
    '<span class="tok-com">/// doc</span>\n<span class="tok-kw">let</span> x <span class="tok-op">=</span> <span class="tok-num">0x1Fu</span> <span class="tok-op">+</span> <span class="tok-num">1.5e-3</span> <span class="tok-com">// tail</span>',
  ],
  [
    9,
    'fsharp',
    '@"C:\\dir" + """say "hi" """ + "a\\"b"',
    '<span class="tok-str">@"C:\\dir"</span> <span class="tok-op">+</span> <span class="tok-str">"""say "hi" """</span> <span class="tok-op">+</span> <span class="tok-str">"a\\"b"</span>',
  ],
  [
    10,
    'fsharp',
    "let c = 'x' in List.fold (*) 1 [ 'a'; '\\n' ]",
    '<span class="tok-kw">let</span> c <span class="tok-op">=</span> <span class="tok-str">\'x\'</span> <span class="tok-kw">in</span> List.fold <span class="tok-op">(*)</span> <span class="tok-num">1</span> [ <span class="tok-str">\'a\'</span>; <span class="tok-str">\'\\n\'</span> ]',
  ],
  [
    11,
    'fsharp',
    'let id<\'a> (x: \'a) = x <> "<b>" && true',
    '<span class="tok-kw">let</span> id<span class="tok-op">&lt;</span>\'a<span class="tok-op">&gt;</span> (x<span class="tok-op">:</span> \'a) <span class="tok-op">=</span> x <span class="tok-op">&lt;&gt;</span> <span class="tok-str">"&lt;b&gt;"</span> <span class="tok-op">&amp;&amp;</span> <span class="tok-kw">true</span>',
  ],
  [12, 'fstar', '', ''],
  [13, 'FST', 'open FStar.Mul', '<span class="tok-kw">open</span> FStar.Mul'],
  [14, 'F#', 'module M', '<span class="tok-kw">module</span> M'],
  [
    15,
    'fstar',
    '(* a (* b *)\nlet',
    '<span class="tok-com">(* a (* b *)</span>\n<span class="tok-com">let</span>',
  ],
  [16, 'fsharp', 'x+// c', 'x<span class="tok-op">+</span><span class="tok-com">// c</span>'],
  [17, 'fsharp', '[1..10]', '[<span class="tok-num">1</span>..<span class="tok-num">10</span>]'],
  [
    18,
    'fsharp',
    'let π = "∀"',
    '<span class="tok-kw">let</span> π <span class="tok-op">=</span> <span class="tok-str">"∀"</span>',
  ],
];

// Strip the spans and undo the `& < >` escape: what is left must be the source.
const textOf = (markup: string): string =>
  markup
    .replace(/<\/?span[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');

const ALPHABET = '(*)/\\"\'@\n 0123456789abcdefxXeE_.+-=<>&|!:;[]{}#λ∀\uD800\r\tletvalopenmodule';

// The same deterministic generator as the F# test (an LCG over uint32).
const generated = (count: number): string[] => {
  let seed = 1854;
  const next = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed >>> 8;
  };
  const out: string[] = [];
  for (let c = 0; c < count; c++) {
    const len = next() % 40;
    let s = '';
    for (let k = 0; k < len; k++) s += ALPHABET[next() % ALPHABET.length];
    out.push(s);
  }
  return out;
};

describe('codeHighlight — the CODE-HIGHLIGHT.md §5 fixture table', () => {
  for (const [row, language, source, expected] of FIXTURES) {
    it(`fixture ${row} (${language})`, () => {
      expect(codeHighlight(language, source)).toBe(expected);
    });
  }
});

describe('codeHighlight — language resolution', () => {
  it('resolves by alias, ASCII case-insensitively', () => {
    for (const tag of ['fstar', 'fst', 'FStar', 'FST'])
      expect(codeGrammarFor(tag)?.name).toBe('fstar');
    for (const tag of ['fsharp', 'fs', 'f#', 'FSharp', 'F#'])
      expect(codeGrammarFor(tag)?.name).toBe('fsharp');
    for (const tag of ['', 'python', 'fsx', 'fsi', 'fstar ', 'text', 'constructor', 'toString'])
      expect(codeGrammarFor(tag)).toBeNull();
  });

  it("table lookups see only a table's own entries", () => {
    expect(codeHighlightWith(FSHARP, 'constructor toString')).toBe('constructor toString');
  });
});

describe('codeHighlight — totality and the per-line rule', () => {
  const inputs = generated(3000);

  it("never throws, and the markup's text IS the source", () => {
    for (const g of [FSTAR, FSHARP])
      for (const src of inputs) expect(textOf(codeHighlightWith(g, src))).toBe(src);
  });

  it('no span ever contains a line break, and no span is empty', () => {
    for (const g of [FSTAR, FSHARP])
      for (const src of inputs)
        for (const m of codeHighlightWith(g, src).matchAll(
          /<span class="tok-[a-z]+">([^<]*)<\/span>/g,
        )) {
          expect(m[1]).not.toContain('\n');
          expect(m[1]).not.toBe('');
        }
  });
});

// The cross-implementation differential lock: SHA-256 over the UTF-16LE code units
// of every output for the generated corpus (both grammars, each output followed
// by U+0001). The F# test pins the SAME digest over the SAME corpus, so any
// divergence between the two ports on ANY of those 6000 inputs fails both suites.
const CORPUS_DIGEST = '6373b20a96f9a089d2e8c3bac8476ca013412668fd05a1bae7530849c3f713aa';

describe('codeHighlight — byte-identical to the F# reference over the generated corpus', () => {
  it('pins the shared corpus digest', () => {
    const h = createHash('sha256');
    for (const g of [FSTAR, FSHARP])
      for (const src of generated(3000)) {
        const out = codeHighlightWith(g, src) + '\u0001';
        const buf = Buffer.alloc(out.length * 2);
        for (let k = 0; k < out.length; k++) buf.writeUInt16LE(out.charCodeAt(k), k * 2);
        h.update(buf);
      }
    expect(h.digest('hex')).toBe(CORPUS_DIGEST);
  });
});
