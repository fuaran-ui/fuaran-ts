import { describe, it, expect } from 'vitest';
import { enhanceMath, parseMathSegments } from '../src/enhanceMath.js';

describe('parseMathSegments', () => {
  it('returns a single text segment when there is no math', () => {
    expect(parseMathSegments('plain text')).toEqual([{ kind: 'text', value: 'plain text' }]);
  });

  it('splits inline $…$ math', () => {
    expect(parseMathSegments('a $x^2$ b')).toEqual([
      { kind: 'text', value: 'a ' },
      { kind: 'inline', value: 'x^2' },
      { kind: 'text', value: ' b' },
    ]);
  });

  it('splits display $$…$$ math', () => {
    expect(parseMathSegments('$$\\int_0^1 x$$')).toEqual([
      { kind: 'display', value: '\\int_0^1 x' },
    ]);
  });

  it('treats an escaped \\$ as a literal dollar, not a delimiter', () => {
    expect(parseMathSegments('cost is \\$5 today')).toEqual([
      { kind: 'text', value: 'cost is $5 today' },
    ]);
  });

  it('leaves an unterminated $ as literal text', () => {
    expect(parseMathSegments('a $ b with no close')).toEqual([
      { kind: 'text', value: 'a $ b with no close' },
    ]);
  });

  it('does not treat an empty $$ as math', () => {
    expect(parseMathSegments('a $$ b')).toEqual([{ kind: 'text', value: 'a $$ b' }]);
  });
});

describe('enhanceMath — Math nodes (Phase 658: container-targeted, wholesale)', () => {
  it('re-enhances a done-marked container whose KaTeX a React restore wiped (content-aware idempotence)', () => {
    // The rung-1 race (2026-07-24 tidy-up): React restores the deterministic
    // MathML children while the imperatively-set done marker survives on the
    // same element. The marker alone must not be trusted.
    document.body.innerHTML =
      '<div class="fuaran-math fuaran-math-block" data-math-display="block" data-fuaran-math-done="" data-fuaran-math-src="a^2 + b^2">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><msup><mi>a</mi><mn>2</mn></msup></math></div>';
    enhanceMath(document.body);
    expect(document.querySelector('.fuaran-math .katex')).not.toBeNull();
  });

  it('leaves a genuinely-enhanced container untouched (idempotence still holds)', () => {
    document.body.innerHTML =
      '<div class="fuaran-math fuaran-math-inline" data-fuaran-math-src="x^2">x^2</div>';
    enhanceMath(document.body);
    const first = document.querySelector('.fuaran-math')!.innerHTML;
    enhanceMath(document.body);
    expect(document.querySelector('.fuaran-math')!.innerHTML).toBe(first);
  });

  it('re-scans a done-marked markdown block whose inline math a restore reverted to raw $ text', () => {
    document.body.innerHTML =
      '<div class="fuaran-markdown" data-fuaran-math-done="">The area is $x^2$ exactly.</div>';
    enhanceMath(document.body);
    expect(document.querySelector('.fuaran-markdown .katex')).not.toBeNull();
  });

  it('KaTeX-renders a block Math node in place — the MathML variant', () => {
    // in-subset: the container holds native MathML + the source in data-fuaran-math-src
    document.body.innerHTML =
      '<div class="fuaran-math fuaran-math-block" data-math-display="block" data-fuaran-math-src="x^2 + y^2">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><msup><mi>x</mi><mn>2</mn></msup></math></div>';
    enhanceMath(document.body);
    const container = document.querySelector('.fuaran-math')!;
    // the container content is replaced wholesale with KaTeX output (which carries
    // the `.katex` root; the original bare `<msup>` MathML is gone)
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.querySelector('.fuaran-math-source')).toBeNull();
    expect(container.getAttribute('data-fuaran-math-done')).toBe('');
  });

  it('KaTeX-renders a block Math node in place — the source-fallback variant', () => {
    // out-of-subset: the container holds the raw-source span
    document.body.innerHTML =
      '<div class="fuaran-math fuaran-math-block" data-math-display="block" data-fuaran-math-src="\\sqrt{2}">' +
      '<span class="fuaran-math-source">\\sqrt{2}</span></div>';
    enhanceMath(document.body);
    const container = document.querySelector('.fuaran-math')!;
    expect(container.querySelector('.katex')).not.toBeNull();
    expect(container.getAttribute('data-fuaran-math-done')).toBe('');
  });

  it('renders an inline Math node with displayMode off', () => {
    document.body.innerHTML =
      '<span class="fuaran-math fuaran-math-inline" data-math-display="inline" data-fuaran-math-src="\\mu">' +
      '<span class="fuaran-math-source">\\mu</span></span>';
    enhanceMath(document.body);
    expect(document.querySelector('.fuaran-math .katex')).not.toBeNull();
    // inline mode never emits the display wrapper
    expect(document.querySelector('.katex-display')).toBeNull();
  });

  it('is idempotent — a second pass does not re-render', () => {
    document.body.innerHTML =
      '<div class="fuaran-math fuaran-math-block" data-fuaran-math-src="a">' +
      '<math xmlns="http://www.w3.org/1998/Math/MathML" display="block"><mi>a</mi></math></div>';
    enhanceMath(document.body);
    const first = document.querySelector('.fuaran-math')!.innerHTML;
    enhanceMath(document.body);
    expect(document.querySelector('.fuaran-math')!.innerHTML).toBe(first);
  });
});

describe('enhanceMath — inline $…$ in rendered markdown', () => {
  it('KaTeX-renders inline math in a .fuaran-markdown block', () => {
    document.body.innerHTML = '<div class="fuaran-markdown"><p>Let $\\alpha$ be small.</p></div>';
    enhanceMath(document.body);
    const md = document.querySelector('.fuaran-markdown')!;
    expect(md.querySelector('.fuaran-math-inline .katex')).not.toBeNull();
    expect(md.textContent).toContain('Let ');
    expect(md.textContent).toContain(' be small.');
  });

  it('does NOT scan inside <code>/<pre>', () => {
    document.body.innerHTML = '<div class="fuaran-markdown"><p>see <code>a $x$ b</code></p></div>';
    enhanceMath(document.body);
    // the code span keeps its literal $…$ text, no katex inside it
    expect(document.querySelector('code .katex')).toBeNull();
    expect(document.querySelector('code')!.textContent).toBe('a $x$ b');
  });

  it('leaves a markdown block without math untouched (but marks it done)', () => {
    document.body.innerHTML = '<div class="fuaran-markdown"><p>no math here</p></div>';
    enhanceMath(document.body);
    const md = document.querySelector('.fuaran-markdown')!;
    expect(md.querySelector('.katex')).toBeNull();
    expect(md.getAttribute('data-fuaran-math-done')).toBe('');
    expect(md.textContent).toBe('no math here');
  });
});
