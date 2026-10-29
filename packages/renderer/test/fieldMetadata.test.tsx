// ============================================================================
//  Phase 2209 — a bound field's unit and label at the read sites
//  (WIRE_FORMAT §3.6.27): the client renderer over the shared `fm-*` fixture
//  set (`fieldMetadataFixtures.json`; the string server renderer's suite and the
//  F# reference's `FieldMetadataRenderTests.fs` read the same documents). The
//  `fm-plain` cases are the byte-identity half: a field stating no metadata
//  renders exactly what the same document renders with no field read at all.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { decodeNode } from '@fuaran-ui/ops';
import type { SchemaEntry } from '@fuaran-ui/schema';

import { FuaranRenderer, fieldColumnTitle, valueUnit } from '../src/index.js';

/**
 * The shared fixture set, read as DATA so both of this repo's tiers (and any
 * further host) read the one file: each case id of §3.6.27's parity table maps
 * to its wire document.
 */
const fixtures = JSON.parse(
  readFileSync(join(__dirname, 'fieldMetadataFixtures.json'), 'utf8'),
) as Record<string, unknown>;

const doc = (id: string): string => {
  const d = fixtures[id];
  if (d === undefined) throw new Error(`no fixture '${id}'`);
  return JSON.stringify(d);
};

const html = (json: string): string => {
  const decoded = decodeNode(json);
  if (!decoded.ok) throw new Error(`decode failed: ${JSON.stringify(decoded.error)}\n${json}`);
  return renderToStaticMarkup(<FuaranRenderer tree={decoded.value} />);
};

const headers = (markup: string): string[] =>
  [...markup.matchAll(/<th[^>]*class="fuaran-grid-header"[^>]*>([^<]*)<\/th>/g)].map((m) => m[1]!);

describe('field metadata at the read sites (Phase 2209, WIRE_FORMAT 3.6.27)', () => {
  it("derives the column title per the spec's table", () => {
    const f = (e: Partial<SchemaEntry>): SchemaEntry => ({ name: 'mass', type: 'float', ...e });
    expect(fieldColumnTitle(f({ label: 'Payload mass', unit: 'kg' }))).toBe('Payload mass (kg)');
    expect(fieldColumnTitle(f({ unit: 'kg' }))).toBe('mass (kg)');
    expect(fieldColumnTitle(f({ label: 'Payload mass' }))).toBe('Payload mass');
    expect(fieldColumnTitle(f({ name: 'speed', label: '', unit: 'm/s' }))).toBe('speed (m/s)');
    expect(fieldColumnTitle(f({ name: 'ratio', unit: '1' }))).toBeUndefined();
    expect(fieldColumnTitle(f({}))).toBeUndefined();
    expect(valueUnit({ kind: 'Percent' }, f({ unit: 'kg' }))).toBeUndefined();
    expect(valueUnit({ kind: 'Number' }, f({ unit: 'kg' }))).toBe('kg');
  });

  describe('DataGrid header (read site 1)', () => {
    it('fm-header-derived — an empty header takes the column title', () => {
      expect(headers(html(doc('fm-header-derived')))).toEqual(['Payload mass (kg)']);
    });
    it("fm-header-explicit — the author's header renders verbatim", () => {
      expect(headers(html(doc('fm-header-explicit')))).toEqual(['Mass (t)']);
    });
    it('fm-header-plain — a field stating nothing leaves the header as it was', () => {
      expect(headers(html(doc('fm-header-plain')))).toEqual(['']);
    });
  });

  describe('Chart axis titles (read site 2)', () => {
    it("fm-axis-derived — both absent titles take their fields' column titles", () => {
      const out = html(doc('fm-axis-derived'));
      expect(out).toContain('>Payload mass (kg)<');
      expect(out).toContain('>speed (m/s)<');
    });
    it('fm-axis-explicit — a declared title wins', () => {
      const out = html(doc('fm-axis-explicit'));
      expect(out).toContain('>Mass<');
      expect(out).not.toContain('Payload mass (kg)');
      expect(out).toContain('>speed (m/s)<');
    });
    it('fm-axis-plain — fields stating nothing keep the capitalised fallback, byte for byte', () => {
      const out = html(doc('fm-axis-plain'));
      expect(out).toContain('>Mass<');
      expect(out).toContain('>Speed<');
      expect(out).toBe(html(doc('fm-axis-plain-static')));
    });
  });

  describe('Metric (read site 3)', () => {
    it('fm-metric-unit — the read value carries the unit', () => {
      const out = html(doc('fm-metric-unit'));
      expect(out).toContain('fuaran-metric-value">12.5 kg<');
      expect(out).toContain('fuaran-metric-label">Payload<');
    });
    it('fm-metric-percent — a format that states its own unit takes no second one', () => {
      expect(html(doc('fm-metric-percent'))).not.toContain('kg');
    });
    it("fm-metric-caption — an empty caption takes the field's display name", () => {
      expect(html(doc('fm-metric-caption'))).toContain('fuaran-metric-label">Payload mass<');
    });
    it('fm-plain — a metric over a field stating nothing renders as before', () => {
      const out = html(doc('fm-plain-metric'));
      expect(out).toContain('fuaran-metric-value">12.5<');
      expect(out).toContain('fuaran-metric-label"><');
    });
    it('an unresolved value takes no unit — no value was read', () => {
      expect(html(doc('fm-metric-unresolved'))).not.toContain('kg');
    });
  });

  describe('accessible name (read site 4)', () => {
    it('fm-a11y-unit — a name read from a Transform says its unit', () => {
      expect(html(doc('fm-a11y-unit'))).toContain('aria-label="12.5 kg"');
    });
    it('fm-plain — a name over a field stating nothing is unchanged', () => {
      expect(html(doc('fm-plain-a11y'))).toContain('aria-label="12.5"');
    });
  });
});
