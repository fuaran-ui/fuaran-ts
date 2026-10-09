// @fuaran-ui/charts — the canonical invariant number formatter and display units
// (Phase 876).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import type { Format } from '@fuaran-ui/schema';

import { formatNum } from './layout.js';

// ─── The canonical invariant number formatter (Phase 876) ────
//
// A byte-for-byte port of the F# reference spec. The chart lowering does NOT
// inherit the locale-aware rendering other surfaces give `Format` (that is
// `Binding.Format`'s job, via `Intl`): a chart's ticks are part of a drawing
// whose bytes must be identical on every host, so the rendering here is
// locale-INVARIANT by definition — period decimal separator, comma thousands.
//
//   1. Decimals come from the TICK STEP, never the data (`dpsOfStep`).
//   2. The base render is round-half-up on the magnitude at that precision,
//      grouped in threes, zero-padded to exactly d places, a leading `-` only
//      when the rounded magnitude is non-zero.
//   3. The `Format` arms layer meaning over that base; `Date` / `RelativeTime`
//      / `Duration` are not value-axis formats and fall through to the base.
//   4. Display-unit scaling divides BOTH the value and the step by 10ⁿ.
//   5. THE INTEGER PART IS RENDERED IN POSITIONAL NOTATION AT EVERY MAGNITUDE,
//      by an expansion this module owns — never by inheriting a host's default
//      number→string switch. Grouping walks decimal digits, so handing it an
//      exponent form corrupts it silently, and the hosts do not agree on WHEN
//      that form appears: the .NET `"R"` layout (which the Python and Rust
//      hosts mirror, and which the wire format pins) goes scientific once the
//      leading-digit exponent passes 16, i.e. at 1e17, while JavaScript's
//      `Number.prototype.toString` stays positional until 1e21. So between
//      1e17 and 1e21 those hosts drew `2.5E,+17` where this one drew the
//      correct digits, and past 1e21 this one drew `1e,+21` — the same chart,
//      different bytes, and no host right. `expandToFixed` therefore re-lays
//      any `d[.ddd]E±NN` mantissa/exponent pair (this host's lower-case
//      `e+NN` included) as its digits zero-padded to `exp + 1` places, and
//      leaves an already-positional form untouched, so nothing below 1e21
//      moves on this host and nothing below 1e17 moves on any host.
//      NOTE the threshold is 1e17, not the 1e15 in `formatNum` — that constant
//      bounds the exact integer fast path, not the notation switch.
//      The expansion is over the SHORTEST-ROUND-TRIP digits, the canonical
//      decimal identity of the double, not its exact binary value: 1e21 reads
//      `1,000,000,000,000,000,000,000`, not `999,999,999,999,999,916,000`.
//      Only the INTEGER part needs this — the fraction is bounded by 10^6.

/** Decimal places implied by a tick step: the smallest `d <= 6` for which
 * `step * 10^d` is (within relative float tolerance) an integer. */
const dpsOfStep = (step: number): number => {
  const s = Math.abs(step);
  if (!(s > 0.0) || !Number.isFinite(s)) return 0;
  let scaled = s;
  for (let d = 0; d < 6; d++) {
    if (Math.abs(scaled - Math.floor(scaled + 0.5)) <= 1e-9 * Math.max(1.0, scaled)) return d;
    scaled *= 10.0;
  }
  return 6;
};

/** Group an integral digit string in threes from the right with `,`. */
const groupThousands = (digits: string): string => {
  const n = digits.length;
  if (n <= 3) return digits;
  const head = n % 3;
  const parts: string[] = [];
  if (head > 0) parts.push(digits.slice(0, head));
  for (let i = head; i <= n - 3; i += 3) parts.push(digits.slice(i, i + 3));
  return parts.join(',');
};

/** Expand a canonical round-trip number form into POSITIONAL notation (rule 5).
 * `s` is whatever the host's shortest-round-trip formatter produced for a
 * non-negative INTEGER-valued double: positional at small magnitudes, and
 * `d[.ddd]E±NN` — or this host's lower-case `e+NN` — above whichever magnitude
 * that host switches at. Total by construction: a form carrying no exponent is
 * returned unchanged, as is the negative-exponent form an integer part cannot
 * produce. */
const expandToFixed = (s: string): string => {
  let eIdx = s.indexOf('E');
  if (eIdx < 0) eIdx = s.indexOf('e');
  if (eIdx < 0) return s;
  const mant = s.slice(0, eIdx);
  const exp = Number(s.slice(eIdx + 1));
  if (!Number.isFinite(exp) || exp < 0) return s;
  const dot = mant.indexOf('.');
  const digits = dot < 0 ? mant : mant.slice(0, dot) + mant.slice(dot + 1);
  // An integer-valued double's shortest round-trip always has at least as many
  // places as digits; the guard keeps the function total rather than describing
  // a reachable case.
  return digits.length >= exp + 1 ? digits : digits + '0'.repeat(exp + 1 - digits.length);
};

/** Render `v` with EXACTLY `dps` decimals — round-half-up on the magnitude,
 * comma thousands separators, period decimal point, locale-invariant. */
const renderFixed = (dps: number, v: number): string => {
  if (Number.isNaN(v) || !Number.isFinite(v)) return '0';
  const d = dps < 0 ? 0 : dps > 6 ? 6 : dps;
  const scale = 10.0 ** d;
  const units = Math.floor(Math.abs(v) * scale + 0.5);
  const intPart = Math.floor(units / scale);
  const fracPart = units - intPart * scale;
  // Rule 5 — expand before grouping. `formatNum` alone would hand the grouper
  // an exponent form above the host's own switch magnitude.
  const intStr = groupThousands(expandToFixed(formatNum(intPart)));
  let body = intStr;
  if (d > 0) {
    const raw = formatNum(fracPart);
    body = `${intStr}.${'0'.repeat(Math.max(0, d - raw.length))}${raw}`;
  }
  return v < 0.0 && units > 0.0 ? `-${body}` : body;
};

/** ISO-4217 code -> symbol, the invariant table. An unlisted code renders as
 * the code itself — deterministic, and never a wrong symbol. */
const CURRENCY_SYMBOLS: Readonly<Record<string, string>> = {
  EUR: '€',
  USD: '$',
  GBP: '£',
  JPY: '¥',
  CNY: '¥',
  CHF: 'CHF',
  AUD: '$',
  CAD: '$',
  NZD: '$',
  HKD: '$',
  SGD: '$',
  INR: '₹',
  KRW: '₩',
  BRL: 'R$',
  RUB: '₽',
  ZAR: 'R',
  SEK: 'kr',
  NOK: 'kr',
  DKK: 'kr',
  PLN: 'zł',
  CZK: 'Kč',
  HUF: 'Ft',
  TRY: '₺',
  MXN: '$',
  THB: '฿',
  ILS: '₪',
};

const currencySymbol = (iso: string): string => CURRENCY_SYMBOLS[iso] ?? iso;

/** The unit symbol a `Format` contributes to an axis-unit label. */
const formatUnitSymbol = (fmt: Format | undefined): string =>
  fmt !== undefined && fmt.kind === 'Currency' ? currencySymbol(fmt.isoCode) : '';

/** The x100 a `Format.Percent` applies to BOTH the value and the step. */
export const formatValueScale = (fmt: Format | undefined): number =>
  fmt !== undefined && fmt.kind === 'Percent' ? 100.0 : 1.0;

/** Render one value-axis number. `divisor` is the display unit (1 when no
 * scaling applies); `dropSymbol` suppresses a currency symbol on the ticks
 * because the axis-unit label already states it once. */
export const formatValue = (
  fmt: Format | undefined,
  divisor: number,
  dropSymbol: boolean,
  step: number,
  v: number,
): string => {
  const pct = formatValueScale(fmt);
  const dv = (v * pct) / divisor;
  const ds = (step * pct) / divisor;
  const pinned =
    fmt !== undefined && (fmt.kind === 'Number' || fmt.kind === 'Percent')
      ? fmt.decimals
      : undefined;
  const dps = pinned !== undefined ? pinned : dpsOfStep(ds);
  const body = renderFixed(dps, dv);
  if (fmt !== undefined && fmt.kind === 'Percent') return `${body}%`;
  if (fmt !== undefined && fmt.kind === 'Currency' && !dropSymbol) {
    const sym = currencySymbol(fmt.isoCode);
    return body.startsWith('-') ? `-${sym}${body.slice(1)}` : `${sym}${body}`;
  }
  return body;
};

// ─── Display units (Phase 876) ───────────────────
//
// The operator's prefix table: thresholds sit at 1 + 3k and the selected
// threshold `t` for a magnitude of exponent `e` satisfies `e - 1 <= t < e + 2`,
// giving the unit exponent `n = t - 1`. Each unit therefore covers three
// exponents — Thousands for e in {3,4,5}, Millions for {6,7,8} — which is why a
// 12-million axis and a 900-million axis both read in millions.

/** How a value axis states its display unit once scaling applies. */
export type ChartAxisUnitMode =
  | 'Words'
  | 'WordsWithSymbol'
  | 'SIAbbreviation'
  | 'CompactPerTick'
  | 'Off';

/** The smallest unit exponent that triggers scaling at the shipped default —
 * the operator's `unit > 3` gate, so scaling begins at MILLIONS and a
 * thousands-range axis still reads `12,500` in full. */
export const DISPLAY_UNIT_MIN_EXPONENT = 6;

const unitExponentOf = (maxAbs: number): number => {
  if (!(maxAbs > 0.0) || !Number.isFinite(maxAbs)) return 0;
  const e = Math.floor(Math.log10(maxAbs) + 0.5);
  const n = 3 * Math.ceil((e - 2) / 3);
  return n < -15 ? -15 : n > 15 ? 15 : n;
};

const UNIT_WORDS: Readonly<Record<number, string>> = {
  3: 'Thousands',
  6: 'Millions',
  9: 'Billions',
  12: 'Trillions',
  15: 'Quadrillions',
};
const UNIT_SI: Readonly<Record<number, string>> = { 3: 'k', 6: 'M', 9: 'G', 12: 'T', 15: 'P' };
const UNIT_COMPACT: Readonly<Record<number, string>> = { 3: 'K', 6: 'M', 9: 'B', 12: 'T', 15: 'Q' };

interface DisplayUnit {
  readonly divisor: number;
  readonly tickSuffix: string;
  readonly dropSymbol: boolean;
  readonly label: string;
}

const NO_DISPLAY_UNIT: DisplayUnit = { divisor: 1.0, tickSuffix: '', dropSymbol: false, label: '' };

/** Resolve the display unit for a value axis whose PRINTED magnitudes peak at
 * `maxAbs` (already through any `Format.Percent` x100). */
export const resolveDisplayUnit = (
  mode: ChartAxisUnitMode,
  minExponent: number,
  fmt: Format | undefined,
  maxAbs: number,
): DisplayUnit => {
  const n = unitExponentOf(maxAbs);
  const threshold = mode === 'CompactPerTick' ? 3 : minExponent;
  const words = UNIT_WORDS[n] ?? '';
  if (mode === 'Off' || n < 3 || n < threshold || words === '') return NO_DISPLAY_UNIT;
  const symbol = formatUnitSymbol(fmt);
  const divisor = 10.0 ** n;
  switch (mode) {
    case 'Words':
      return { divisor, tickSuffix: '', dropSymbol: false, label: words };
    case 'WordsWithSymbol':
      return {
        divisor,
        tickSuffix: '',
        dropSymbol: symbol !== '',
        label: symbol === '' ? words : `${words} of ${symbol}`,
      };
    case 'SIAbbreviation':
      return {
        divisor,
        tickSuffix: '',
        dropSymbol: symbol !== '',
        label: `${UNIT_SI[n] ?? ''}${symbol}`,
      };
    case 'CompactPerTick':
      return { divisor, tickSuffix: UNIT_COMPACT[n] ?? '', dropSymbol: false, label: '' };
    default:
      return NO_DISPLAY_UNIT;
  }
};
