// ============================================================================
//  Phase 921 — the drawing root's ANNOUNCED accessible name.
//
//  `role="img"` (Phase 532's R3) presents the drawing as ONE graphic and does
//  not traverse into it, and `<desc>` is not uniformly mapped to the accessible
//  description (Chromium has never exposed it) — so the description the markup
//  has carried since Phase 525 was a value no reader could reach. The root now
//  emits `aria-label` composing the title and the description.
//
//  These pin the TS builder against the F# reference's `DrawingSvgTests` block
//  of the same name, byte-for-byte.
// ============================================================================

import type { DrawingSpec, TextSource } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { emptySources } from '../src/bindings.js';
import { drawingSvg } from '../src/drawingSvg.js';

const literal = (value: string): TextSource => ({ kind: 'Literal', value });

const drawing = (title?: string, description?: string): DrawingSpec => ({
  viewBox: { minX: 0.0, minY: 0.0, width: 200.0, height: 100.0 },
  shapes: [],
  style: {},
  ...(title !== undefined ? { title: literal(title) } : {}),
  ...(description !== undefined ? { description: literal(description) } : {}),
});

const svg = (title?: string, description?: string): string =>
  drawingSvg(emptySources, drawing(title, description));

describe('drawing root a11y wiring (Phase 921)', () => {
  it('composes title + description into aria-label, keeping both children', () => {
    expect(svg('Sales vs target', 'Bar chart. 2 series: sales, target.')).toBe(
      '<svg class="fuaran-drawing" role="img" viewBox="0 0 200 100" ' +
        'aria-label="Sales vs target. Bar chart. 2 series: sales, target.">' +
        '<title>Sales vs target</title>' +
        '<desc>Bar chart. 2 series: sales, target.</desc></svg>',
    );
  });

  it('terminates the title only when it needs to be', () => {
    expect(svg('Ends in a period.', 'D.')).toContain('aria-label="Ends in a period. D."');
    expect(svg('Really?', 'D.')).toContain('aria-label="Really? D."');
    expect(svg('Now!', 'D.')).toContain('aria-label="Now! D."');
    expect(svg('Plain', 'D.')).toContain('aria-label="Plain. D."');
    // An EMPTY title contributes nothing rather than a bare period.
    expect(svg('', 'D.')).toContain('aria-label="D."');
  });

  it('leaves a title-only or bare root byte-identical to pre-921', () => {
    expect(svg('Bars')).toBe(
      '<svg class="fuaran-drawing" role="img" viewBox="0 0 200 100"><title>Bars</title></svg>',
    );
    expect(svg()).toBe('<svg class="fuaran-drawing" role="img" viewBox="0 0 200 100"></svg>');
  });

  it('announces a description-only root on its own', () => {
    expect(svg(undefined, 'One filled circle.')).toBe(
      '<svg class="fuaran-drawing" role="img" viewBox="0 0 200 100" aria-label="One filled circle.">' +
        '<desc>One filled circle.</desc></svg>',
    );
  });

  it('escapes hostile text inside the aria-label ATTRIBUTE', () => {
    // The builder emits raw markup, so its own XML escape is the whole defence
    // — and an attribute value needs the quote entities the element-content path
    // also emits. The chart lowering feeds this seam untrusted series and
    // category strings straight off the data feed.
    const out = svg('a"b', `<script>alert('x') & "y"</script>`);
    expect(out).toContain(
      'aria-label="a&quot;b. &lt;script&gt;alert(&#39;x&#39;) &amp; &quot;y&quot;&lt;/script&gt;"',
    );
    expect(out).not.toContain('<script>');
  });
});
