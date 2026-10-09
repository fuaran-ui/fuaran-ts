// @fuaran-ui/charts — the temporal x-axis (Phase 882).
//
// One module of the package split along its section boundaries (Phase 2076); the
// package entry (index.ts) re-exports the public surface unchanged.

import { civilFromDays, daysFromCivil, parseIsoDay } from '@fuaran-ui/core-twins';

// ─── The temporal x-axis (Phase 882) ─────────────────────────────────────────
//
// NORMATIVE CROSS-HOST SPEC (R2), the same standing as the text metrics and the
// number formatter above: every conformant host reproduces this block exactly,
// and `docs/CHARTS-DRAWING-PRIMITIVE-DESIGN.md` §4h carries it as the
// language-neutral statement. The `chart-lowering/*` goldens pin it.
//
// FIVE RULES, and each one exists to remove a way two hosts could disagree.
//
//   1. THE UNIT IS THE DAY, and a date is an INTEGER: days since 1970-01-01 in
//      the PROLEPTIC GREGORIAN calendar. Nothing here reads a host date type, a
//      locale, a time zone, or a clock — no `Date`, no `Intl`, no library. The
//      conversions are fixed integer algorithms (Howard Hinnant's
//      `days_from_civil` / `civil_from_days`, public domain, held in the host's
//      one calendar module and imported here), exact for every
//      date they admit and needing no leap-year table. A timestamp cell's
//      TIME-OF-DAY IS DISCARDED: the value is its UTC date. That is the whole
//      of the axis's time-zone policy, stated rather than inherited, because
//      inheriting it from a host would make the picture depend on where it was
//      drawn.
//
//      Integer division must TRUNCATE TOWARD ZERO, so every `/` in the two
//      conversions is wrapped in `Math.trunc` — `Math.floor` is WRONG for the
//      negative-bias branches, and JavaScript's bare `/` is not integral at
//      all. The algorithms bias their operands into the non-negative range
//      precisely so truncation is the only convention they need.
//
//   2. THE DOMAIN IS THE DATA'S OWN EXTENT, UNEXPANDED — `[min, max]`, so the
//      first and last points sit on the plot's edges. It is NOT snapped outward
//      the way `niceDomain` snaps the value axis, because a calendar boundary
//      is a coarse thing to round to: nicing a 30-day domain to whole months
//      would add a month of empty plot at each end to make room for ticks
//      nobody asked for. The ticks come to the domain instead. A degenerate
//      domain (every row the same date, or no rows) becomes `[lo, lo+1]`, the
//      same guard `niceDomain` applies for the same reason.
//
//   3. THE TICKS ARE CALENDAR-ALIGNED INSTANTS INSIDE THE DOMAIN, at a step
//      drawn from a FIXED LADDER — the `{1,2,5}·10ⁿ` rule's analogue for units
//      that are not decimal:
//
//        1, 2, 5, 10 DAYS · 1, 2, 3, 6 MONTHS · {1,2,5}·10ⁿ YEARS (n ≤ 6)
//
//      The chosen rung is the FIRST whose in-domain tick count fits the
//      ceiling; the coarsest rung is the fallback nothing else fits. Day rungs
//      step from the DOMAIN'S OWN START (a "nice" 2-day or 5-day boundary does
//      not exist — days are uniform, so the honest anchor is the first datum);
//      month rungs land on month starts where `(month-1) mod k === 0`, which
//      makes `k = 3` the calendar quarters and `k = 6` January and July; year
//      rungs land on the January 1 of years where `year mod k === 0`.
//
//      The ceiling is `TARGET_TICK_COUNT + 1` (6 at the shipped default) rather
//      than `TARGET_TICK_COUNT` itself. The value axis's step is CONTINUOUS and
//      can be tuned to hit a target; a calendar rung jumps by 2–3× and cannot,
//      so rounding down a rung loses roughly half the ticks. Admitting the
//      densest rung that still reads keeps the actual count in the 3–6 band.
//      Counts are computed WITHOUT generating the ticks, so the ladder can be
//      walked from its densest rung on a millennium-wide domain without
//      unbounded work.
//
//   4. THE FORMAT FOLLOWS THE STEP'S NOMINAL LENGTH, at the operator's
//      thresholds: `> 365` days ⇒ `yyyy`, `> 27` ⇒ `mmm yy`, else `dd mmm yy`.
//      Nominal, not measured: a month is `365.2425 / 12 = 30.436875` days and a
//      year `365.2425`, so the rung decides the format and the DATA cannot.
//      Measuring the actual tick gaps instead would put the year rung's average
//      at exactly 365.0 across a run of non-leap years (1900–1903, say) and
//      flip a decade chart from `yyyy` to `mmm yy` on a property of the
//      calendar nobody was asking about. The thresholds are calibrated for
//      this: the 1-month rung clears 27 and the 6-month rung does not clear
//      365, so each threshold separates two ADJACENT rungs.
//
//   5. THE MONTH NAMES ARE PART OF THE SPEC. English three-letter
//      abbreviations, invariant, never a locale lookup — an i18n date axis is a
//      different feature with its own vocabulary, and a chart whose golden
//      bytes changed with the host's culture would not be certifiable at all.

/** The English three-letter month abbreviations, in calendar order. INVARIANT —
 * part of the wire-visible spec (rule 5), never a locale lookup. */
const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** The calendar unit a tick step counts in. */
type TemporalUnit = 'Days' | 'Months' | 'Years';

/** One rung of the ladder: `count` of `unit`. */
export interface TemporalStep {
  readonly unit: TemporalUnit;
  readonly count: number;
}

/** Integer division TRUNCATED TOWARD ZERO (rule 1) — the convention the
 * calendar conversions use, and the one the tick arithmetic below shares. */
const idiv = (a: number, b: number): number => Math.trunc(a / b);

/**
 * Parse a canonical ISO-8601 date to days since epoch — `YYYY-MM-DD`,
 * optionally followed by `T…`, whose time-of-day is DISCARDED (rule 1). STRICT
 * by shape and by calendar: four digits, two, two, both hyphens, a month in
 * 1–12 and a day the month actually has. `undefined` for everything else,
 * including a locale spelling (`15/01/2026`) and a bare year — admitting either
 * would be the string-sniffing this axis exists to avoid. The gate and the
 * conversions are the host's one calendar module (`parseIsoDay`,
 * `daysFromCivil`, `civilFromDays`), which the annotation decoder shares.
 */
export const tryParseDay = (text: string): number | undefined => {
  const parts = parseIsoDay(text);
  return parts === undefined ? undefined : daysFromCivil(parts.year, parts.month, parts.day);
};

/** The day number a row's x cell carries, with an UNPARSEABLE cell reading as
 * the epoch. That mirrors `numericOf`'s posture for a non-numeric value-axis
 * cell — the lowering stays total and the grounding rule (FUARAN097) is what
 * makes a non-date column loud, upstream, before any picture is drawn. Silence
 * here is not the design; refusing here would be. */
export const temporalDayOf = (text: string): number => tryParseDay(text) ?? 0;

/** The step's NOMINAL length in days (rule 4) — a mean Gregorian month and
 * year, so the FORMAT is a property of the rung rather than of the data. */
export const nominalDays = (step: TemporalStep): number => {
  switch (step.unit) {
    case 'Days':
      return step.count;
    case 'Months':
      return step.count * 30.436875; // 365.2425 / 12
    default:
      return step.count * 365.2425;
  }
};

/** The ladder, ascending (rule 3). Written out rather than generated: it is a
 * pinned vocabulary five hosts mirror, and an explicit list cannot drift on a
 * difference of opinion about exponentiation. */
const TEMPORAL_LADDER: readonly TemporalStep[] = [
  { unit: 'Days', count: 1 },
  { unit: 'Days', count: 2 },
  { unit: 'Days', count: 5 },
  { unit: 'Days', count: 10 },
  { unit: 'Months', count: 1 },
  { unit: 'Months', count: 2 },
  { unit: 'Months', count: 3 },
  { unit: 'Months', count: 6 },
  { unit: 'Years', count: 1 },
  { unit: 'Years', count: 2 },
  { unit: 'Years', count: 5 },
  { unit: 'Years', count: 10 },
  { unit: 'Years', count: 20 },
  { unit: 'Years', count: 50 },
  { unit: 'Years', count: 100 },
  { unit: 'Years', count: 200 },
  { unit: 'Years', count: 500 },
  { unit: 'Years', count: 1000 },
  { unit: 'Years', count: 2000 },
  { unit: 'Years', count: 5000 },
  { unit: 'Years', count: 10000 },
  { unit: 'Years', count: 20000 },
  { unit: 'Years', count: 50000 },
  { unit: 'Years', count: 100000 },
  { unit: 'Years', count: 200000 },
  { unit: 'Years', count: 500000 },
  { unit: 'Years', count: 1000000 },
  { unit: 'Years', count: 2000000 },
  { unit: 'Years', count: 5000000 },
];

/** Round an index UP to the next multiple of `k` (both non-negative). */
const ceilTo = (k: number, i: number): number => idiv(i + k - 1, k) * k;

/** The aligned window a month rung covers: `[first aligned month index, count]`
 * over `[lo, hi]`, in month-index space (`year·12 + month - 1`). Closed-form,
 * so a count never generates a tick. */
const monthWindow = (k: number, lo: number, hi: number): readonly [number, number] => {
  const start = civilFromDays(lo);
  // A `lo` past the 1st means `lo`'s own month start is outside the domain.
  const firstIdx = start.year * 12 + start.month - 1 + (start.day > 1 ? 1 : 0);
  const first = ceilTo(k, firstIdx);
  const end = civilFromDays(hi);
  // `hi`'s own month start is always inside the domain (its day ≥ 1).
  const last = idiv(end.year * 12 + end.month - 1, k) * k;
  return last < first ? [first, 0] : [first, idiv(last - first, k) + 1];
};

/** The year rung's twin of {@link monthWindow}, in year space. */
const yearWindow = (k: number, lo: number, hi: number): readonly [number, number] => {
  const start = civilFromDays(lo);
  const firstYear = start.year + (start.month === 1 && start.day === 1 ? 0 : 1);
  const first = ceilTo(k, firstYear);
  const last = idiv(civilFromDays(hi).year, k) * k;
  return last < first ? [first, 0] : [first, idiv(last - first, k) + 1];
};

/** How many `step`-aligned ticks fall in `[lo, hi]` — closed-form, never by
 * generation (rule 3), so walking the ladder is O(rungs) whatever the span. */
const temporalTickCount = (step: TemporalStep, lo: number, hi: number): number => {
  if (hi < lo) return 0;
  switch (step.unit) {
    case 'Days':
      return idiv(hi - lo, step.count) + 1;
    case 'Months':
      return monthWindow(step.count, lo, hi)[1];
    default:
      return yearWindow(step.count, lo, hi)[1];
  }
};

/** The `step`-aligned ticks in `[lo, hi]`, ascending. */
export const temporalTicks = (step: TemporalStep, lo: number, hi: number): number[] => {
  if (hi < lo) return [];
  const out: number[] = [];
  if (step.unit === 'Days') {
    for (let i = 0; i <= idiv(hi - lo, step.count); i++) out.push(lo + i * step.count);
    return out;
  }
  if (step.unit === 'Months') {
    const [first, count] = monthWindow(step.count, lo, hi);
    for (let i = 0; i < count; i++) {
      const idx = first + i * step.count;
      out.push(daysFromCivil(idiv(idx, 12), (idx % 12) + 1, 1));
    }
    return out;
  }
  const [first, count] = yearWindow(step.count, lo, hi);
  for (let i = 0; i < count; i++) out.push(daysFromCivil(first + i * step.count, 1, 1));
  return out;
};

/**
 * The `[min, max]` extent of a NON-EMPTY numeric array, as a `<` / `>`
 * COMPARISON FOLD seeded on the first element — never `Math.min(...xs)`.
 *
 * Phase 1670, generalising Phase 1099's sparkline rule to the three chart
 * lowering sites that still spread. There are TWO defects in the spread form and
 * only one of them is about NaN:
 *
 * 1. THE ARGUMENT-COUNT CEILING, and it is the one that is reachable here. A
 *    spread passes one argument per element, and every JS engine has a call-frame
 *    limit: on the Node this was written against, `Math.min(...xs)` throws
 *    `RangeError: Maximum call stack size exceeded` somewhere between 100k and
 *    125k elements. A sparkline's series never approaches that; a chart's does —
 *    `allValuesRaw` is rows × series, and a 20k-row seven-series chart is 140k
 *    values. The failure is a THROWN EXCEPTION out of a pure lowering, not a
 *    wrong picture, so it takes the whole render with it. The sparkline fix kept
 *    a fold rather than a spread for exactly this reason.
 *
 * 2. NaN PROPAGATION, which matches the reference's `Array.min` / `List.min`:
 *    those replace the accumulator only on a true comparison, and an IEEE
 *    comparison against NaN is always false, so a NaN never BECOMES the extent —
 *    it flows on as one poisoned datum while its neighbours keep their true
 *    positions. `Math.min` propagates it into the extent and through the extent
 *    into every coordinate on the chart.
 *
 *    At these three call sites that difference is currently UNOBSERVABLE, and
 *    saying so is more useful than implying otherwise: every contributor to them
 *    is already guarded — series cells by `numericOf`'s Phase-640 non-finite
 *    clamp, reference lines by Phase 1490's `Number.isFinite` filter, value bands
 *    by Phase 1492's, and a temporal `days` entry is an integer day number that
 *    cannot be NaN at all. So this half of the fix is not a live bug fix; it is
 *    what makes the three sites structurally identical to the reference, so that
 *    removing or widening any of those guards later cannot silently reintroduce
 *    a divergence the corpus has already been shown not to catch.
 *
 * Total on a non-empty array. Callers guard emptiness themselves, because what
 * an empty extent MEANS differs per site (a day window, a zero-anchored value
 * domain, a unit x axis) and inventing one answer here would be wrong at two of
 * the three.
 */
export const extentOf = (xs: readonly number[]): readonly [number, number] => {
  let lo = xs[0]!;
  let hi = xs[0]!;
  for (let i = 1; i < xs.length; i++) {
    const v = xs[i]!;
    if (v < lo) lo = v;
    if (v > hi) hi = v;
  }
  return [lo, hi];
};

/** The chosen rung: the FIRST whose in-domain tick count fits `maxTicks`, else
 * the coarsest (rule 3). Total — the ladder is never empty. */
export const chooseTemporalStep = (maxTicks: number, lo: number, hi: number): TemporalStep =>
  TEMPORAL_LADDER.find((s) => temporalTickCount(s, lo, hi) <= maxTicks) ??
  TEMPORAL_LADDER[TEMPORAL_LADDER.length - 1]!;

/** The domain: the data's own extent, unexpanded, with the degenerate guard
 * (rule 2). No rows ⇒ `[0, 1]` — the epoch day and the one after it, which
 * draws an axis rather than dividing by zero. */
export const temporalDomain = (days: readonly number[]): readonly [number, number] => {
  if (days.length === 0) return [0, 1];
  const [lo, hi] = extentOf(days);
  return hi === lo ? [lo, lo + 1] : [lo, hi];
};

const padTo = (width: number, v: number): string => {
  const s = String(v);
  return s.length >= width ? s : '0'.repeat(width - s.length) + s;
};

/** The tick label for `day` under `step` — the granularity-adaptive format
 * (rule 4). `yyyy` past a year, `mmm yy` past 27 days, else `dd mmm yy`. */
export const temporalLabel = (step: TemporalStep, day: number): string => {
  const { year, month, day: d } = civilFromDays(day);
  const nominal = nominalDays(step);
  const yy = padTo(2, year % 100);
  const mmm = MONTH_NAMES[month - 1]!;
  if (nominal > 365.0) return padTo(4, year);
  if (nominal > 27.0) return mmm + ' ' + yy;
  return padTo(2, d) + ' ' + mmm + ' ' + yy;
};
