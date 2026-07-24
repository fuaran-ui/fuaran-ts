// ============================================================================
//  Locale-aware `Binding.Format` resolution + `formatLocaleValue` (Phase 102).
//  The browser counterpart to the F# `FormatBindingTests`. Asserts the Intl-
//  backed formatter produces locale-correct output for each Format case and
//  that `resolve` projects a Format binding to the formatted string (Ambient
//  deferring to `sources.locale`).
// ============================================================================

import type { Binding } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { emptySources, formatLocaleValue, resolve } from '../src/bindings.js';

describe('formatLocaleValue (Intl-backed)', () => {
  it('formats a grouped fixed-decimal number (en-US)', () => {
    expect(formatLocaleValue('en-US', { kind: 'Number', decimals: 2 }, 1234.5)).toBe('1,234.50');
  });

  it('formats currency with the locale symbol (en-GB)', () => {
    expect(formatLocaleValue('en-GB', { kind: 'Currency', isoCode: 'GBP' }, 1234.5)).toBe(
      '£1,234.50',
    );
  });

  it('formats a ratio as a percent', () => {
    expect(formatLocaleValue('en-US', { kind: 'Percent', decimals: 0 }, 0.42)).toBe('42%');
  });

  it('formats relative time with auto wording', () => {
    expect(formatLocaleValue('en-US', { kind: 'RelativeTime', unit: 'Day' }, -3)).toBe(
      '3 days ago',
    );
  });

  it('formats an absolute date from Unix-epoch seconds', () => {
    const s = formatLocaleValue('en-GB', { kind: 'Date', dateStyle: 'Short' }, 1700000000);
    expect(s).toContain('2023');
  });
});

describe('Binding.Format resolution', () => {
  it('resolves an explicit-locale currency binding to the formatted string', () => {
    const b: Binding<string> = {
      kind: 'Format',
      source: { kind: 'Static', value: 1234.5 },
      format: { kind: 'Currency', isoCode: 'GBP' },
      locale: { kind: 'Explicit', tag: 'en-GB' },
    };
    expect(resolve(emptySources, b)).toEqual({ kind: 'Resolved', value: '£1,234.50' });
  });

  it('Ambient locale defers to sources.locale', () => {
    const b: Binding<string> = {
      kind: 'Format',
      source: { kind: 'Static', value: 1234.5 },
      format: { kind: 'Number', decimals: 1 },
      locale: { kind: 'Ambient' },
    };
    expect(resolve({ ...emptySources, locale: 'en-US' }, b)).toEqual({
      kind: 'Resolved',
      value: '1,234.5',
    });
  });

  it('propagates NotResolved from an unresolved numeric source', () => {
    const b: Binding<string> = {
      kind: 'Format',
      source: { kind: 'Filter', name: 'missing' },
      format: { kind: 'Number' },
      locale: { kind: 'Ambient' },
    };
    expect(resolve(emptySources, b)).toEqual({ kind: 'NotResolved' });
  });
});
