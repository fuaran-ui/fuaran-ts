// ============================================================================
//  Phase 2209 — a bound field's unit and label at the read sites
//  (WIRE_FORMAT §3.6.27): the string server renderer over the SAME `fm-*`
//  fixture set the client suite reads (`renderer/test/fieldMetadataFixtures.json`),
//  and byte parity with the client on every case — the two tiers are one rule.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import { FuaranRenderer } from '@fuaran-ui/renderer';

import { renderToHtml } from '../src/index.js';

/**
 * The shared fixture set, read as DATA so both of this repo's tiers (and any
 * further host) read the one file: each case id of §3.6.27's parity table maps
 * to its wire document.
 */
const fixtures = JSON.parse(
  readFileSync(
    join(__dirname, '..', '..', 'renderer', 'test', 'fieldMetadataFixtures.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const doc = (id: string): string => {
  const d = fixtures[id];
  if (d === undefined) throw new Error(`no fixture '${id}'`);
  return JSON.stringify(d);
};

const decode = (json: string) => {
  const decoded = decodeNode(json);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}\n${json}`);
  return decoded.value;
};

const html = (json: string): string => renderToHtml(decode(json));

const headers = (markup: string): string[] =>
  [...markup.matchAll(/<th[^>]*class="fuaran-grid-header"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!);

describe('field metadata at the read sites — server tier (Phase 2209, WIRE_FORMAT 3.6.27)', () => {
  it('fm-header-derived / -explicit / -plain', () => {
    expect(headers(html(doc('fm-header-derived')))).toEqual(['Payload mass (kg)']);
    expect(headers(html(doc('fm-header-explicit')))).toEqual(['Mass (t)']);
    expect(headers(html(doc('fm-header-plain')))).toEqual(['']);
  });

  it('fm-axis-derived / -explicit / -plain', () => {
    const derived = html(doc('fm-axis-derived'));
    expect(derived).toContain('>Payload mass (kg)<');
    expect(derived).toContain('>speed (m/s)<');
    const explicit = html(doc('fm-axis-explicit'));
    expect(explicit).toContain('>Mass<');
    expect(explicit).not.toContain('Payload mass (kg)');
    expect(html(doc('fm-axis-plain'))).toBe(html(doc('fm-axis-plain-static')));
  });

  it('fm-metric-unit / -percent / -caption / fm-plain, and no unit on an unread value', () => {
    expect(html(doc('fm-metric-unit'))).toContain('fuaran-metric-value">12.5 kg<');
    expect(html(doc('fm-metric-percent'))).not.toContain('kg');
    expect(html(doc('fm-metric-caption'))).toContain('fuaran-metric-label">Payload mass<');
    expect(html(doc('fm-plain-metric'))).toContain('fuaran-metric-value">12.5<');
    expect(html(doc('fm-metric-unresolved'))).not.toContain('kg');
  });

  it('fm-a11y-unit / fm-plain', () => {
    expect(html(doc('fm-a11y-unit'))).toContain('aria-label="12.5 kg"');
    expect(html(doc('fm-plain-a11y'))).toContain('aria-label="12.5"');
  });

  it('the derived texts are the same on both tiers', () => {
    const client = (json: string) =>
      renderToStaticMarkup(createElement(FuaranRenderer, { tree: decode(json) }));
    for (const json of [
      doc('fm-header-derived'),
      doc('fm-axis-derived'),
      doc('fm-metric-unit'),
      doc('fm-metric-caption'),
      doc('fm-a11y-unit'),
    ]) {
      for (const text of ['Payload mass (kg)', 'speed (m/s)', '12.5 kg', '>Payload mass<']) {
        expect(html(json).includes(text), `${text} in ${json}`).toBe(client(json).includes(text));
      }
    }
  });
});
