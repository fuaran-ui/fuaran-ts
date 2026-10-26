// ============================================================================
//  The `CellFormat` projection of an exact decimal (Phase 2006).
//
//  A `CellValue.Decimal` formats from its DIGITS. Every arm is the decimal twin
//  of the renderers' `formatNumber` arm of the same name, spelled so that a
//  decimal and a JS number holding the same value render the same bytes
//  wherever the number is exact, and so that no arm rounds through a number:
//  `12345678901234567.895` to two places is `12345678901234567.90`, where a
//  double would have said `...68.00`. Parity-locked with the reference host's
//  `Formatting.formatDecimal`; both hosts pin the same fixture bytes.
// ============================================================================

import type { CellFormat } from '@fuaran-ui/schema';
import { decimalCanonical } from '@fuaran-ui/core-twins';

/** A decimal as `±digits × 10^-scale`. */
interface Scaled {
  readonly negative: boolean;
  readonly digits: string;
  readonly scale: number;
}

/** Read through the canonical form, so the grammar is the core twin's and only its. */
const scaledOf = (text: string): Scaled | undefined => {
  const canonical = decimalCanonical(text);
  if (canonical === undefined) return undefined;
  const negative = canonical.startsWith('-');
  const body = negative ? canonical.slice(1) : canonical;
  const dot = body.indexOf('.');
  return dot < 0
    ? { negative, digits: body, scale: 0 }
    : { negative, digits: body.slice(0, dot) + body.slice(dot + 1), scale: body.length - dot - 1 };
};

/** Add one to a non-empty run of ASCII digits (`"0999"` → `"1000"`, `"99"` → `"100"`). */
const incrementDigits = (digits: string): string => {
  const chars = digits.split('');
  let i = chars.length - 1;
  while (i >= 0) {
    if (chars[i] === '9') {
      chars[i] = '0';
      i -= 1;
    } else {
      chars[i] = String.fromCharCode(chars[i]!.charCodeAt(0) + 1);
      return chars.join('');
    }
  }
  return '1' + chars.join('');
};

/** Drop the last `cut` digits, rounding half up on the magnitude (`toFixed`'s rule). */
const roundOff = (digits: string, cut: number): string => {
  if (cut <= 0) return digits;
  const padded = digits.padStart(cut + 1, '0');
  const keep = padded.slice(0, padded.length - cut);
  return padded[padded.length - cut]! >= '5' ? incrementDigits(keep) : keep;
};

/** `toFixed(places)`, sign included whatever it rounds to (`(-0.001).toFixed(2)` is `-0.00`). */
const toFixed = (places: number, s: Scaled): string => {
  const kept =
    s.scale <= places
      ? s.digits + '0'.repeat(places - s.scale)
      : roundOff(s.digits, s.scale - places);
  const padded = kept.padStart(places + 1, '0');
  const whole = padded.slice(0, padded.length - places).replace(/^0+/, '') || '0';
  const body = places === 0 ? whole : `${whole}.${padded.slice(padded.length - places)}`;
  return s.negative ? `-${body}` : body;
};

/** Back to canonical text, from a scale that may be negative. */
const canonicalOf = (s: Scaled): string => {
  const digits = s.scale < 0 ? s.digits + '0'.repeat(-s.scale) : s.digits;
  const scale = Math.max(0, s.scale);
  const padded = digits.padStart(scale + 1, '0');
  const text =
    (s.negative ? '-' : '') +
    (scale === 0
      ? padded
      : `${padded.slice(0, padded.length - scale)}.${padded.slice(padded.length - scale)}`);
  return decimalCanonical(text) ?? text;
};

/** `toPrecision(precision)` rendered plainly: half up at that many significant digits, never an exponent. */
const significant = (precision: number, s: Scaled): string => {
  const sig = s.digits.replace(/^0+/, '');
  if (sig === '') return '0';
  const cut = sig.length - precision;
  if (cut <= 0) return canonicalOf(s);
  return canonicalOf({ negative: s.negative, digits: roundOff(sig, cut), scale: s.scale - cut });
};

const percent = (s: Scaled): Scaled => ({ ...s, scale: s.scale - 2 });

// The digit counts a declaration may name, clamped as the reference host clamps them
// (`toFixed` and `toPrecision` throw outside these ranges).
const fixedDigits = (d: number): number => Math.max(0, Math.min(100, Math.trunc(d)));
const precisionDigits = (d: number): number => Math.max(1, Math.min(100, Math.trunc(d)));

/**
 * Format an exact decimal's canonical text per a `CellFormat` (Phase 2006) — the
 * renderers' `formatNumber` twin, from the digits and never through a number.
 * `Number`, `Currency`, `Percent` and `SignificantDigits` round half up at the
 * declared digit; `None`, `Number` without `decimals` and `DateTime` are the
 * canonical text itself. `Duration` and `RelativeTime` render the canonical
 * text too: each reads its value as a count of time units through number
 * arithmetic, and a decimal does not become a number here. A text outside the
 * decimal grammar renders as itself.
 */
export const formatDecimal = (format: CellFormat, text: string): string => {
  const s = scaledOf(text);
  if (s === undefined) return text;
  switch (format.kind) {
    case 'Number':
      return format.decimals !== undefined
        ? toFixed(fixedDigits(format.decimals), s)
        : canonicalOf(s);
    case 'Currency':
      return `${format.code} ${toFixed(2, s)}`;
    case 'Percent':
      return `${toFixed(fixedDigits(format.decimals ?? 1), percent(s))}%`;
    case 'SignificantDigits':
      return significant(precisionDigits(format.digits), s);
    case 'Custom':
      return format.format({ kind: 'Decimal', value: text });
    case 'None':
    case 'DateTime':
    case 'Duration':
    case 'RelativeTime':
      return canonicalOf(s);
  }
};
