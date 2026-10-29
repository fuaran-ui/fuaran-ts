// ============================================================================
//  Phase 2499 — a currency figure can set its fraction digits.
//
//  Every figure case carries `decimals`. Absent, a currency keeps two places on
//  the locale-free projection and its own digits through `Intl`; present, it is
//  the fixed digit count of the first and both fraction-digit bounds of the
//  second. The reference host pins the same text (`FigureLocaleTests.fs`), and
//  the corpus fixture `figure-decimals-en-gb` carries every shape on the wire.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import type { Node } from '@fuaran-ui/schema';

import { formatLocaleValue, formatNumber, renderCellValue } from '../src/bindings.js';
import { renderToHtml } from '../src/index.js';

const enGb = { kind: 'Explicit', tag: 'en-GB' } as const;

const decodeOne = (json: string): Node<unknown> => {
  const r = decodeNode(json);
  if (!r.ok) throw new Error(JSON.stringify(r));
  return r.value;
};

describe('Phase 2499 — a currency figure can set its fraction digits', () => {
  it('a GBP figure at 0 decimals in en-GB renders whole pounds', () => {
    expect(formatNumber({ kind: 'Currency', code: 'GBP', decimals: 0, locale: enGb }, 412380)).toBe(
      '£412,380',
    );
  });

  it('without decimals a located currency keeps its own digits, and without either it is unchanged', () => {
    expect(formatNumber({ kind: 'Currency', code: 'GBP', locale: enGb }, 412380)).toBe(
      '£412,380.00',
    );
    expect(formatNumber({ kind: 'Currency', code: 'GBP' }, 412380)).toBe('GBP 412380.00');
  });

  it('a present decimals sets the locale-free currency digits, exact decimals included', () => {
    expect(formatNumber({ kind: 'Currency', code: 'GBP', decimals: 0 }, 412380.5)).toBe(
      'GBP 412381',
    );
    expect(formatNumber({ kind: 'Currency', code: 'USD', decimals: 3 }, 1.5)).toBe('USD 1.500');
    expect(
      renderCellValue(
        { kind: 'Currency', code: 'GBP', decimals: 0 },
        { kind: 'Decimal', value: '412380.5' },
      ),
    ).toBe('GBP 412381');
  });

  it('a located Percent and Number render at their decimals', () => {
    expect(formatNumber({ kind: 'Percent', decimals: 1, locale: enGb }, 0.0425)).toBe('4.3%');
    expect(formatNumber({ kind: 'Number', decimals: 0, locale: enGb }, 1234567.6)).toBe(
      '1,234,568',
    );
  });

  it('Binding.Format’s Currency takes the same digits', () => {
    expect(
      formatLocaleValue('en-GB', { kind: 'Currency', isoCode: 'GBP', decimals: 0 }, 412380),
    ).toBe('£412,380');
  });

  it('the decimals member round-trips on both vocabularies', () => {
    const json =
      '{"id":"f","kind":{"$type":"Fact","label":"Revenue","value":{"$type":"Bound","binding":{"$type":"Format","format":{"$type":"Currency","decimals":0,"isoCode":"GBP"},"locale":{"$type":"Explicit","tag":"en-GB"},"source":{"$type":"Static","value":412380}}}}}';
    expect(encodeNode(decodeOne(json))).toBe(json);
    const cell =
      '{"id":"m","kind":{"$type":"Metric","format":{"$type":"Currency","code":"GBP","decimals":0,"locale":{"$type":"Explicit","tag":"en-GB"}},"label":"Revenue","value":{"$type":"Static","value":412380}}}';
    expect(encodeNode(decodeOne(cell))).toBe(cell);
    expect(renderToHtml(decodeOne(cell))).toContain('£412,380<');
  });
});
