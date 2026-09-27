// Phase 658 — byte-for-byte cover for `mathMl`, the deterministic LaTeX→MathML
// translator for the closed `Math` subset. This is the TypeScript half of the
// shared fixture-table oracle in `fuaran-dotnet/docs/MATH-DEGRADATION.md`; the F# port
// (`fuaran-dotnet/src/Fuaran.UI.Tests/MathMlTests.fs`) pins the SAME strings, so the two
// implementations cannot silently diverge.
import { describe, expect, it } from 'vitest';

import { mathMl } from '../src/mathMl.js';
import { createHtml } from '../src/trustedTypes.js';

const tag = (disp: 'block' | 'inline'): string =>
  `<math xmlns="http://www.w3.org/1998/Math/MathML" display="${disp}">`;

describe('mathMl — in-subset → exact MathML (the design-doc fixture table)', () => {
  it('1. x^2 (inline) → msup', () => {
    expect(mathMl('x^2', 'Inline')).toBe(
      `${tag('inline')}<msup><mi>x</mi><mn>2</mn></msup></math>`,
    );
  });

  it('2. a^2 + b^2 = c^2 (block) → the pythagorean, real superscripts', () => {
    expect(mathMl('a^2 + b^2 = c^2', 'Block')).toBe(
      `${tag('block')}<msup><mi>a</mi><mn>2</mn></msup><mo>+</mo><msup><mi>b</mi><mn>2</mn></msup><mo>=</mo><msup><mi>c</mi><mn>2</mn></msup></math>`,
    );
  });

  it('3. x^2 + y^2 = z^2 (block) — the wire-format corpus node math-1', () => {
    expect(mathMl('x^2 + y^2 = z^2', 'Block')).toBe(
      `${tag('block')}<msup><mi>x</mi><mn>2</mn></msup><mo>+</mo><msup><mi>y</mi><mn>2</mn></msup><mo>=</mo><msup><mi>z</mi><mn>2</mn></msup></math>`,
    );
  });

  it('4. x_i (inline) → msub', () => {
    expect(mathMl('x_i', 'Inline')).toBe(
      `${tag('inline')}<msub><mi>x</mi><mi>i</mi></msub></math>`,
    );
  });

  it('5. x_i^2 (inline) → msubsup', () => {
    expect(mathMl('x_i^2', 'Inline')).toBe(
      `${tag('inline')}<msubsup><mi>x</mi><mi>i</mi><mn>2</mn></msubsup></math>`,
    );
  });

  it('6. \\frac{a}{b} (block) → mfrac', () => {
    expect(mathMl('\\frac{a}{b}', 'Block')).toBe(
      `${tag('block')}<mfrac><mi>a</mi><mi>b</mi></mfrac></math>`,
    );
  });

  it('7. \\alpha + \\beta (inline) → Greek identifiers', () => {
    expect(mathMl('\\alpha + \\beta', 'Inline')).toBe(
      `${tag('inline')}<mi>α</mi><mo>+</mo><mi>β</mi></math>`,
    );
  });

  it('8. (a + b)^2 (block) → mrow group with superscript', () => {
    expect(mathMl('(a + b)^2', 'Block')).toBe(
      `${tag('block')}<msup><mrow><mo>(</mo><mi>a</mi><mo>+</mo><mi>b</mi><mo>)</mo></mrow><mn>2</mn></msup></math>`,
    );
  });

  it('9. 3.14 (inline) → mn with decimal', () => {
    expect(mathMl('3.14', 'Inline')).toBe(`${tag('inline')}<mn>3.14</mn></math>`);
  });

  it('10. E = mc^2 (block) → mixed identifiers + superscript', () => {
    expect(mathMl('E = mc^2', 'Block')).toBe(
      `${tag('block')}<mi>E</mi><mo>=</mo><mi>m</mi><msup><mi>c</mi><mn>2</mn></msup></math>`,
    );
  });

  it('11. a / b (inline) → division operator', () => {
    expect(mathMl('a / b', 'Inline')).toBe(`${tag('inline')}<mi>a</mi><mo>/</mo><mi>b</mi></math>`);
  });

  it('12. 2 * x (inline) → dot-operator multiplication (U+22C5)', () => {
    expect(mathMl('2 * x', 'Inline')).toBe(`${tag('inline')}<mn>2</mn><mo>⋅</mo><mi>x</mi></math>`);
  });

  it('13. n - 1 (inline) → minus-sign subtraction (U+2212)', () => {
    expect(mathMl('n - 1', 'Inline')).toBe(`${tag('inline')}<mi>n</mi><mo>−</mo><mn>1</mn></math>`);
  });
});

describe('mathMl — out-of-subset → null (the renderer falls back to the source span)', () => {
  it.each([
    ['\\sqrt{2}', 'unknown command'],
    ['x < y', '< not in the alphabet'],
    ['\\int_0^1 x \\, dx', '\\int / \\, not in the command set'],
    ['', 'empty source'],
    ['   ', 'whitespace-only source'],
    ['f(x) = \\sin(x)', 'unknown command'],
    ['a^', 'dangling superscript'],
    ['{a + b', 'unbalanced brace'],
    // extra hostile inputs — must be null, never throw
    ['^', 'bare caret'],
    ['_', 'bare underscore'],
    [')', 'bare closer'],
    ['}', 'bare brace closer'],
    ['\\', 'bare backslash'],
    ['\\frac{a}', 'incomplete fraction'],
    ['(((', 'unbalanced parens'],
    ['a__b', 'double subscript'],
    ['1.2.3', 'malformed number'],
    ['\\frac', 'fraction with no arguments'],
  ])('%s → null (%s)', (src) => {
    expect(mathMl(src, 'Inline')).toBeNull();
  });
});

// Phase 1853 — the subset grows logic, relations and named terms. Rows 21–49 of the
// design-doc fixture table, pinned against the SAME strings as the F# MathMlTests.
const inSubset1853: ReadonlyArray<readonly [number, string, 'Block' | 'Inline', string]> = [
  [
    21,
    '\\forall x.\\ x \\in S \\Rightarrow f(x) \\le c',
    'Block',
    '<mo>∀</mo><mi>x</mi><mo>.</mo><mspace width="0.3333em"></mspace><mi>x</mi><mo>∈</mo><mi>S</mi><mo>⇒</mo><mi>f</mi><mrow><mo>(</mo><mi>x</mi><mo>)</mo></mrow><mo>≤</mo><mi>c</mi>',
  ],
  [
    22,
    '\\exists n, n \\ge 0',
    'Inline',
    '<mo>∃</mo><mi>n</mi><mo separator="true">,</mo><mi>n</mi><mo>≥</mo><mn>0</mn>',
  ],
  [
    23,
    'p \\land q \\lor \\neg r \\iff \\top',
    'Inline',
    '<mi>p</mi><mo>∧</mo><mi>q</mi><mo>∨</mo><mo>¬</mo><mi>r</mi><mo>⇔</mo><mi>⊤</mi>',
  ],
  [
    24,
    '\\Gamma \\vdash e \\mapsto v',
    'Inline',
    '<mi>Γ</mi><mo>⊢</mo><mi>e</mi><mo>↦</mo><mi>v</mi>',
  ],
  [
    25,
    'A \\subseteq B \\cup C \\cap D',
    'Inline',
    '<mi>A</mi><mo>⊆</mo><mi>B</mi><mo>∪</mo><mi>C</mi><mo>∩</mo><mi>D</mi>',
  ],
  [
    26,
    'x \\notin \\emptyset, a \\ne b, a \\equiv b',
    'Inline',
    '<mi>x</mi><mo>∉</mo><mi>∅</mi><mo separator="true">,</mo><mi>a</mi><mo>≠</mo><mi>b</mi><mo separator="true">,</mo><mi>a</mi><mo>≡</mo><mi>b</mi>',
  ],
  [27, 'a \\lt b \\gt c', 'Inline', '<mi>a</mi><mo>&lt;</mo><mi>b</mi><mo>&gt;</mo><mi>c</mi>'],
  [28, '2 \\times 3 \\cdot 4', 'Inline', '<mn>2</mn><mo>×</mo><mn>3</mn><mo>⋅</mo><mn>4</mn>'],
  [
    29,
    '\\mathit{unregistered\\_refused}(k) \\to \\bot',
    'Inline',
    '<mi mathvariant="italic">unregistered_refused</mi><mrow><mo>(</mo><mi>k</mi><mo>)</mo></mrow><mo>→</mo><mi>⊥</mi>',
  ],
  [
    30,
    '\\mathrm{Dom}(f) \\subset \\text{Keys}',
    'Inline',
    '<mi mathvariant="normal">Dom</mi><mrow><mo>(</mo><mi>f</mi><mo>)</mo></mrow><mo>⊂</mo><mtext>Keys</mtext>',
  ],
  [
    31,
    'a\\,b\\:c\\;d\\quad e',
    'Inline',
    '<mi>a</mi><mspace width="0.1667em"></mspace><mi>b</mi><mspace width="0.2222em"></mspace><mi>c</mi><mspace width="0.2778em"></mspace><mi>d</mi><mspace width="1em"></mspace><mi>e</mi>',
  ],
  [
    32,
    '[a, b]^2',
    'Inline',
    '<msup><mrow><mo>[</mo><mi>a</mi><mo separator="true">,</mo><mi>b</mi><mo>]</mo></mrow><mn>2</mn></msup>',
  ],
  [
    33,
    '\\{a, b\\}',
    'Inline',
    '<mrow><mo>{</mo><mi>a</mi><mo separator="true">,</mo><mi>b</mi><mo>}</mo></mrow>',
  ],
  [34, '|x| \\le 1', 'Inline', '<mo>|</mo><mi>x</mi><mo>|</mo><mo>≤</mo><mn>1</mn>'],
  [35, 'x^{n+1}', 'Inline', '<msup><mi>x</mi><mrow><mi>n</mi><mo>+</mo><mn>1</mn></mrow></msup>'],
  [
    36,
    '\\frac{a+b}{2}',
    'Block',
    '<mfrac><mrow><mi>a</mi><mo>+</mo><mi>b</mi></mrow><mn>2</mn></mfrac>',
  ],
];

describe('mathMl — Phase 1853 in-subset → exact MathML (rows 21–36)', () => {
  it.each(inSubset1853)('%i. %s → exact MathML', (_n, src, disp, body) => {
    expect(mathMl(src, disp)).toBe(`${tag(disp === 'Block' ? 'block' : 'inline')}${body}</math>`);
  });

  it.each([
    ['\\neg', '\\lnot'],
    ['\\land', '\\wedge'],
    ['\\lor', '\\vee'],
    ['\\Rightarrow', '\\implies'],
    ['\\Leftrightarrow', '\\iff'],
    ['\\to', '\\rightarrow'],
    ['\\le', '\\leq'],
    ['\\ge', '\\geq'],
    ['\\ne', '\\neq'],
  ])('the operator alias %s translates identically to %s', (a, b) => {
    const ta = mathMl(`x ${a} y`, 'Inline');
    expect(ta).not.toBeNull();
    expect(mathMl(`x ${b} y`, 'Inline')).toBe(ta);
  });

  it('the only character references emitted are &lt; and &gt;', () => {
    for (const [, src, disp] of inSubset1853) {
      const markup = mathMl(src, disp);
      expect(markup).not.toBeNull();
      expect((markup as string).replaceAll('&lt;', '').replaceAll('&gt;', '')).not.toContain('&');
    }
  });

  it('every widened payload is invariant under the sanitising floor', () => {
    for (const [, src, disp] of inSubset1853) {
      const markup = mathMl(src, disp) as string;
      expect(createHtml(markup)).toBe(markup);
    }
  });
});

describe('mathMl — Phase 1853 out-of-subset neighbours → null (rows 37–49)', () => {
  it.each([
    ['x > y', 'bare > is not in the alphabet'],
    ['a & b', 'bare & is not in the alphabet'],
    ['\\mathit{a b}', 'a named-term argument containing a space'],
    ['\\mathit{}', 'an empty named-term argument'],
    ['\\text{a-b}', 'a named-term argument outside [A-Za-z0-9] and \\_'],
    ['\\forallx', 'unknown command (a command name is the whole letter run)'],
    ['.5', 'a dot directly followed by a digit outside a number'],
    ['[a, b)', 'mismatched fences'],
    ['\\{a}', 'an unclosed set brace'],
    ['x^{}', 'an empty brace group'],
    ['|x|^2', 'a script on the bare | operator'],
    ['\\qquad', '\\qquad is not in the spacing table'],
    ['\\mathit{a_b}', 'a bare _ in a named-term argument (a subscript in LaTeX; write \\_)'],
  ])('%s → null (%s)', (src) => {
    expect(mathMl(src, 'Inline')).toBeNull();
  });

  // A table lookup must see only the table's OWN entries: an inherited member name
  // is an unknown command, exactly as the F# `match` treats it.
  it.each(['\\constructor', '\\toString', '\\valueOf', '\\hasOwnProperty', 'x \\constructor y'])(
    '%s → null (an inherited Object member is not a table entry)',
    (src) => {
      expect(mathMl(src, 'Inline')).toBeNull();
    },
  );

  it.each([
    '\\',
    '\\ ',
    '\\{',
    '\\}',
    '\\mathit',
    '\\mathit{',
    '\\mathit{a',
    '\\text{}',
    '[',
    ']',
    '[a',
    'a]',
    '\\{a\\}\\}',
    '.',
    ',',
    '|',
    '\\lt',
    '\\forall',
  ])('%s never throws', (src) => {
    expect(() => mathMl(src, 'Inline')).not.toThrow();
  });
});
