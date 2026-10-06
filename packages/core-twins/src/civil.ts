// ============================================================================
//  Core twin — proleptic-Gregorian calendar arithmetic, the one copy in this
//  host (Phase 2075).
//
//  Howard Hinnant's `days_from_civil` / `civil_from_days` (public domain):
//  days since 1970-01-01 as pure integer math, exact for every date, no leap
//  table, no host date type, no locale, no clock. The DataFrame twin's
//  `dateDiffDays`, the chart temporal axis (§4h), the annotation decoder and the
//  lenient epoch-instant decoder all read the calendar through this file, so a
//  host cannot disagree with itself about what day a string names.
//
//  INTEGER DIVISION TRUNCATES TOWARD ZERO — every `/` is wrapped in
//  `Math.trunc`, which is the reference's int division; `Math.floor` is wrong
//  for the negative-bias branches. The algorithms bias their operands into the
//  non-negative range precisely so truncation is the only convention needed.
//
//  `@fuaran-ui/schema`'s `epochSecondsOfInstant` keeps its own transcription of
//  `daysFromCivil`: this package already depends on schema's types, so schema
//  cannot import it back. `test/civil.test.ts` pins that copy against this one.
// ============================================================================

/** Integer division truncated toward zero — the reference's `/` on integers. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/** Gregorian leap year (proleptic — the rule applies to every year, with no
 * historical exception). */
export const isLeapYear = (y: number): boolean => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

/** Days in month `m` (1–12) of year `y` — the one place the calendar's
 * irregularity is written down; the conversions below need no table. */
export const daysInMonth = (y: number, m: number): number =>
  m === 2 ? (isLeapYear(y) ? 29 : 28) : m === 4 || m === 6 || m === 9 || m === 11 ? 30 : 31;

/**
 * `(year, month, day)` → days since 1970-01-01 — Hinnant's `days_from_civil`.
 *
 * The March-based month is `(month + 9) % 12`, exactly the reference
 * evaluator's spelling: it agrees with `month > 2 ? month - 3 : month + 9` on
 * every real month, and keeps `dateDiffDays` byte-identical to the reference on
 * the out-of-range months it does not validate.
 */
export const daysFromCivil = (year: number, month: number, day: number): number => {
  const y = month <= 2 ? year - 1 : year;
  const era = idiv(y >= 0 ? y : y - 399, 400);
  const yoe = y - era * 400; // [0, 399]
  const mp = (month + 9) % 12; // March-based month
  const doy = idiv(153 * mp + 2, 5) + day - 1; // [0, 365]
  const doe = yoe * 365 + idiv(yoe, 4) - idiv(yoe, 100) + doy; // [0, 146096]
  return era * 146097 + doe - 719468;
};

/** A civil date: proleptic-Gregorian year, month 1–12, day 1–31. */
export interface CivilDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

/** Days since 1970-01-01 → civil date — Hinnant's `civil_from_days`, the exact
 * inverse of {@link daysFromCivil}. */
export const civilFromDays = (days: number): CivilDate => {
  const z = days + 719468;
  const era = idiv(z >= 0 ? z : z - 146096, 146097);
  const doe = z - era * 146097; // [0, 146096]
  const yoe = idiv(doe - idiv(doe, 1460) + idiv(doe, 36524) - idiv(doe, 146096), 365); // [0, 399]
  const y = yoe + era * 400;
  const doy = doe - (365 * yoe + idiv(yoe, 4) - idiv(yoe, 100)); // [0, 365]
  const mp = idiv(5 * doy + 2, 153); // [0, 11], March-based
  const d = doy - idiv(153 * mp + 2, 5) + 1; // [1, 31]
  const m = mp < 10 ? mp + 3 : mp - 9; // [1, 12]
  return { year: m <= 2 ? y + 1 : y, month: m, day: d };
};

/**
 * Parse a canonical ISO-8601 day — `YYYY-MM-DD`, optionally followed by `T…`
 * whose time-of-day is DISCARDED. STRICT by shape and by calendar: four digits,
 * two, two, both hyphens, a month in 1–12 and a day the month actually has.
 * `undefined` for everything else, including a locale spelling (`15/01/2026`)
 * and a bare year. The chart temporal axis and the annotation decoder both read
 * a date cell through this one gate.
 */
export const parseIsoDay = (text: string): CivilDate | undefined => {
  if (text.length < 10) return undefined;
  if (text[4] !== '-' || text[7] !== '-') return undefined;
  if (text.length > 10 && text[10] !== 'T') return undefined;
  const digits = (start: number, len: number): number | undefined => {
    let acc = 0;
    for (let k = start; k < start + len; k += 1) {
      const c = text.charCodeAt(k);
      if (c < 48 || c > 57) return undefined;
      acc = acc * 10 + (c - 48);
    }
    return acc;
  };
  const year = digits(0, 4);
  const month = digits(5, 2);
  const day = digits(8, 2);
  if (year === undefined || month === undefined || day === undefined) return undefined;
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth(year, month)) return undefined;
  return { year, month, day };
};
