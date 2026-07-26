// Phase 658 — byte-for-byte cover for `mathMl`, the deterministic LaTeX→MathML
// translator for the closed `Math` subset. This is the TypeScript half of the
// shared fixture-table oracle in `fuaran-dotnet/docs/MATH-DEGRADATION.md`; the F# port
// (`fuaran-dotnet/src/Fuaran.UI.Tests/MathMlTests.fs`) pins the SAME strings, so the two
// implementations cannot silently diverge.
import { describe, expect, it } from 'vitest';

import { mathMl } from '../src/mathMl.js';

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
