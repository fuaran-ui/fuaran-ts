// ============================================================================
//  The host instant — grain truncation, epoch conversion, and the `Format.Since`
//  reduction (Phase 1533).
//
//  NO CLOCK IS READ IN THIS FILE. Every function here is a pure projection of a
//  string the HOST furnished, which is what keeps a tree a pure value: a
//  replayed op-stream re-supplies the instant it recorded and reproduces its
//  original render instead of drifting to replay-time "now".
//
//  It lives in `@fuaran-ui/schema` rather than in a renderer because BOTH
//  renderers need it and there must be exactly one copy: an instant a server
//  renders with and the instant its client hydrates with have to project to the
//  same string by the same route, or SSR and hydration disagree about what "now"
//  was. For the same reason none of this consults `Date.parse` — two runtimes'
//  parsers are two oracles for one question — and both halves are arithmetic
//  over the canonical form's own digits, matching the reference host exactly.
// ============================================================================

import type { RelativeTimeUnit, TimeGrain } from './types.js';

/**
 * Truncate the canonical host instant (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) to `grain`
 * by PREFIX, zero-filling the finer components so the result stays a well-formed
 * instant — except `Day`, which yields the bare `YYYY-MM-DD` that the core
 * `dateDiffDays` reads.
 *
 * `Second` is the identity, deliberately: it is the default grain, so a document
 * that declares none resolves through exactly the bytes Phase 765 shipped,
 * including any sub-second precision a host chooses to furnish.
 *
 * An instant too short to slice is returned VERBATIM rather than padded or
 * refused: this is a host-furnished value, not wire data, and a renderer is the
 * wrong place to adjudicate a host's clock format. The corpus pins the canonical
 * form; a host that furnishes something else gets no truncation and a visibly
 * odd date rather than a silently plausible wrong one.
 */
export const truncateToGrain = (grain: TimeGrain, instant: string): string => {
  const sliceOr = (n: number, suffix: string): string =>
    instant.length >= n ? instant.slice(0, n) + suffix : instant;
  switch (grain) {
    case 'Second':
      return instant;
    case 'Minute':
      return sliceOr(16, ':00Z');
    case 'Hour':
      return sliceOr(13, ':00:00Z');
    case 'Day':
      return sliceOr(10, '');
  }
};

/**
 * Days since 1970-01-01 for a proleptic-Gregorian civil date — Howard Hinnant's
 * `days_from_civil`, transcribed with explicit integer truncation so it matches
 * the reference host's integer arithmetic exactly.
 */
const daysFromCivil = (year: number, m: number, d: number): number => {
  const y = m <= 2 ? year - 1 : year;
  const era = Math.trunc((y >= 0 ? y : y - 399) / 400);
  const yoe = y - era * 400;
  const doy = Math.trunc((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  const doe = yoe * 365 + Math.trunc(yoe / 4) - Math.trunc(yoe / 100) + doy;
  return era * 146097 + doe - 719468;
};

/**
 * Parse a canonical instant (`YYYY-MM-DD`, optionally `THH:MM:SS…`) to whole
 * Unix-epoch seconds — the representation `Format.Date` and `Format.Since` read
 * their numeric source in. `undefined` when the leading date is not readable,
 * which the caller surfaces as unresolved rather than as an invented instant.
 *
 * Deliberately tolerant of what follows the seconds (a fractional part, a `Z`,
 * an offset suffix) and deliberately INTOLERANT of a missing or non-numeric
 * date: truncating to a grain leaves `YYYY-MM-DDTHH:MM:00Z` and `YYYY-MM-DD`,
 * both of which must parse, and anything shorter is not an instant at all.
 */
export const epochSecondsOfInstant = (instant: string): number | undefined => {
  const digits = (from: number, len: number): number | undefined => {
    if (instant.length < from + len) return undefined;
    let acc = 0;
    for (let i = from; i < from + len; i += 1) {
      const c = instant.charCodeAt(i);
      if (c < 48 || c > 57) return undefined;
      acc = acc * 10 + (c - 48);
    }
    return acc;
  };
  const y = digits(0, 4);
  const mo = digits(5, 2);
  const d = digits(8, 2);
  if (y === undefined || mo === undefined || d === undefined) return undefined;
  if (y < 1 || mo < 1 || mo > 12 || d < 1 || d > 31) return undefined;
  const hh = digits(11, 2) ?? 0;
  const mi = digits(14, 2) ?? 0;
  const ss = digits(17, 2) ?? 0;
  return daysFromCivil(y, mo, d) * 86400 + hh * 3600 + mi * 60 + ss;
};

/**
 * Seconds in one `RelativeTimeUnit`. `Month` and `Year` are the mean Gregorian
 * lengths (365.2425 days / 12 and 365.2425 days) — FIXED constants rather than
 * calendar arithmetic, because "2 months ago" is a rounded human phrase and a
 * calendar-exact answer would make one delta read differently depending on which
 * months it spanned, on hosts that must agree to the byte.
 */
const relativeUnitSeconds = (u: RelativeTimeUnit): number => {
  switch (u) {
    case 'Second':
      return 1;
    case 'Minute':
      return 60;
    case 'Hour':
      return 3600;
    case 'Day':
      return 86400;
    case 'Week':
      return 604800;
    case 'Month':
      return 2629746;
    case 'Year':
      return 31556952;
  }
};

/**
 * The `Format.Since` reduction: a signed delta in seconds becomes a
 * `[unit, count]` pair the relative-time renderers already know how to say.
 *
 * `declared === undefined` is the AUTO-SELECTION request (not a default): the
 * unit is the largest whose length does not exceed the magnitude, from the fixed
 * threshold ladder in WIRE_FORMAT.md §4b. The count TRUNCATES toward zero rather
 * than rounding, so 3599 seconds is "59 minutes" and never "1 hour" — the ladder
 * and the count then agree at every boundary, which rounding would break exactly
 * at the point a reader is most likely to check.
 */
export const sinceUnitAndCount = (
  declared: RelativeTimeUnit | undefined,
  deltaSeconds: number,
): readonly [RelativeTimeUnit, number] => {
  let unit: RelativeTimeUnit;
  if (declared !== undefined) {
    unit = declared;
  } else {
    const m = Math.abs(deltaSeconds);
    if (m < 60) unit = 'Second';
    else if (m < 3600) unit = 'Minute';
    else if (m < 86400) unit = 'Hour';
    else if (m < 604800) unit = 'Day';
    else if (m < 2629746) unit = 'Week';
    else if (m < 31556952) unit = 'Month';
    else unit = 'Year';
  }
  // The zero normalisation is NOT redundant: IEEE truncation of a small negative quotient
  // yields NEGATIVE zero, and `-0` is a different value from `0` under
  // `Object.is` and under a structural comparison, so a host that returned it
  // would disagree with the reference host on a pair the specification says is
  // one value. It renders identically either way, which is precisely why it
  // would go unnoticed without this.
  const count = Math.trunc(deltaSeconds / relativeUnitSeconds(unit));
  return [unit, count === 0 ? 0 : count];
};
