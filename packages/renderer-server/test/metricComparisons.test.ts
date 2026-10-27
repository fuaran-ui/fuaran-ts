// ============================================================================
//  Phase 2472 — a Metric carries further comparisons, each its own trend line.
//
//  The corpus's two comparison fixtures render on the server with one trend line
//  per comparison: its own glyph and sentiment (under its own polarity), its
//  figure, then its label. The client renderer's agreement is the corpus-wide
//  parity suite's; this file pins what the line SAYS.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';

import { renderToHtml } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const render = (id: string): string => {
  const decoded = decodeNode(readFileSync(join(wireCorpusRoot(), 'nodes', `${id}.json`), 'utf8'));
  if (!decoded.ok) throw new Error(`decode failed for ${id}: ${JSON.stringify(decoded.error)}`);
  return renderToHtml(decoded.value);
};

const count = (needle: string, hay: string): number => hay.split(needle).length - 1;

describe('Phase 2472 — Metric comparisons render as trend lines', () => {
  it('two comparisons are two trend lines, each with its own sentiment and label', () => {
    const html = render('metric-two-comparisons');
    expect(count('fuaran-metric-trend-glyph', html)).toBe(2);
    expect(html).toContain('fuaran-metric-trend fuaran-metric-trend-improving');
    expect(html).toContain('fuaran-metric-trend fuaran-metric-trend-regressing');
    expect(html).toContain('vs same day last week');
    expect(html).toContain('vs same day last year');
    expect(html.indexOf('vs same day last week')).toBeLessThan(
      html.indexOf('vs same day last year'),
    );
  });

  it('a comparison reads under its OWN polarity, after the primary trend', () => {
    const html = render('metric-comparison-inverted');
    // The primary trend (-7.34%, LowerIsBetter) improves; the comparison
    // (+12, LowerIsBetter) regresses — a rise in a wait time is bad news.
    expect(count('fuaran-metric-trend-glyph', html)).toBe(2);
    const improving = html.indexOf('fuaran-metric-trend-improving');
    const regressing = html.indexOf('fuaran-metric-trend-regressing');
    expect(improving).toBeGreaterThan(-1);
    expect(regressing).toBeGreaterThan(improving);
    expect(html).toContain('12 minutes vs last year');
  });
});
