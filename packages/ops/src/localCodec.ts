// ============================================================================
//  The `Binding.Local` edit-buffer codec (WIRE_FORMAT.md Section 3.3.3).
//
//  A controlled input's buffer has to move a value between its typed slot and
//  the text a reader edits. Three of `Binding.Local`'s slots are functions, so
//  none of them crosses the wire; this module is what a DECODED buffer uses
//  instead — the identity by default, or the declared `codec` when the document
//  names one.
//
//  It is NOT a display formatter, and the difference is the whole design.
//  `Binding.Format` carries a `LocaleSource` because it renders for READING —
//  a grouping separator, a locale decimal mark, a currency symbol. A `Local`
//  codec carries none, because whatever it renders it must also PARSE BACK from
//  what the reader typed: a buffer that writes `1,234.5` where the reader types
//  `1.234,5` is exactly the round-trip hole the case was widened to close.
// ============================================================================

import { formatFiniteDouble } from './encode.js';

/**
 * The identity text rendition of a buffered value.
 *
 * `String(v)` is deliberately not used for numbers: it spells `1e21` as `1e+21`
 * here and `1E+21` on .NET, and the hosts have to agree. `formatFiniteDouble` is
 * the layout the corpus bytes already go through, so a number reads here exactly
 * as it reads on the wire.
 */
export const identityFormat = (v: unknown): string => {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') {
    // Section 7's three quoted sentinels have no number spelling; the buffer
    // shows the sentinel rather than a host-chosen word.
    if (Number.isNaN(v)) return 'NaN';
    if (v === Infinity) return 'Infinity';
    if (v === -Infinity) return '-Infinity';
    return formatFiniteDouble(v);
  }
  return String(v);
};

/**
 * The JSON number grammar, and nothing wider. Surrounding ASCII whitespace is
 * trimmed first — a reader's trailing space is not a type error — but a leading
 * `+`, a bare `.5`, a hex literal and a thousands separator are all refused,
 * because a grammar each host guesses at is a grammar each host guesses at
 * differently.
 *
 * `Number(text)` is emphatically NOT the implementation: it accepts `0x10`,
 * `Infinity`, `1_0` and the empty string, all of which this must refuse.
 */
export const tryNumberText = (text: string): number | undefined => {
  const s = text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '');
  if (!/^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(s)) return undefined;
  const v = Number(s);
  return Number.isFinite(v) ? v : undefined;
};

/**
 * The scalar a piece of buffer text denotes, when it denotes one. `true` /
 * `false` and the JSON number grammar only — an empty string is NOT null here,
 * because a cleared text field is an empty string and reading it as "no value"
 * would make the buffer lie about what the reader did.
 */
export const scalarOfText = (text: string): string | number | boolean | undefined => {
  if (text === 'true') return true;
  if (text === 'false') return false;
  return tryNumberText(text);
};

/**
 * Fixed-point text: sign, integer part, and EXACTLY `decimals` fraction digits,
 * `.` as the point, no grouping. Rounding is half-away-from-zero, spelled as
 * `floor(x + 0.5)` on the absolute value rather than as `toFixed` — `toFixed`
 * rounds half-to-even on some values through the double's binary expansion, and
 * a rounding mode each host picks a default for is a divergence waiting to be
 * found by a fixture.
 */
export const fixedText = (decimals: number, v: number): string => {
  if (!Number.isFinite(v)) return identityFormat(v);
  const d = decimals < 0 ? 0 : Math.trunc(decimals);
  const neg = v < 0;
  const scaled = Math.floor(Math.abs(v) * Math.pow(10, d) + 0.5);
  const whole = formatFiniteDouble(scaled);
  const body =
    d === 0
      ? whole
      : (() => {
          const padded = whole.length <= d ? '0'.repeat(d + 1 - whole.length) + whole : whole;
          return padded.slice(0, padded.length - d) + '.' + padded.slice(padded.length - d);
        })();
  // `-0` is not a number a reader typed; a negative that rounds to zero shows
  // as zero.
  return neg && scaled !== 0 ? '-' + body : body;
};

/**
 * The `Format.Number` codec's rendition: fixed-point at the declared decimals,
 * or the identity when the codec declares none.
 *
 * A NON-numeric buffered value falls back to the identity text rather than
 * failing. The codec is a declaration about presentation, and a value of the
 * wrong shape underneath it is the slot's problem, reported by the slot — a
 * format function that threw here would take out the render of a tree whose only
 * defect is a mistyped binding.
 */
export const numberText = (decimals: number | undefined, v: unknown): string =>
  decimals !== undefined && typeof v === 'number' ? fixedText(decimals, v) : identityFormat(v);

/**
 * The wire-survivability failure a DECODED host-only projection throws when a
 * reader tries to run it.
 *
 * It exists because the alternative — returning a default — is
 * indistinguishable from a real answer at the slot: a decoded `Binding.Computed`
 * used to hand back `undefined` and render it as though the computation had run.
 *
 * The `name` is set explicitly and consumers match on IT rather than on
 * `instanceof`: the renderer lives in another package with its own bundle, so an
 * identity check across the boundary is a check on which copy of the class was
 * loaded, which is not the question being asked.
 */
export class WireSurvivabilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WireSurvivabilityError';
  }
}

/**
 * The one message a decoded `Binding.Computed` carries. A constant rather than a
 * template at each site so the resolver can recognise it, the corpus can pin it,
 * and every host can render the same sentence.
 */
export const DECODED_COMPUTED_MESSAGE =
  "Binding.Computed has no wire projection (decoded from a '<closure>' sentinel) — use Binding.Expr / Transform / State";
