// ============================================================================
//  The column-type lattice — twin of the reference's `ColumnType.widens` and
//  `TemporalText.unitOf` (fuaran-core Phases 33, 277 and 422).
//
//  Phase 2206 gave the timestamp a unit: `timestamp` (whole seconds),
//  `timestamp_ms`, `timestamp_us` and `timestamp_ns`. A cell stays one
//  canonical instant text whatever the unit, so a cell's TYPE is the unit its
//  text's fraction spells, and a coarser unit widens into a finer one. The
//  evaluator's derived-column rule and the UI tier's static schema walk both
//  read the lattice from here, so the two cannot disagree.
// ============================================================================

import type { ColumnType } from '@fuaran-ui/schema';

/** The fraction digits a timestamp tag holds, or `undefined` for a non-timestamp tag. */
export const timestampDigits = (t: ColumnType): number | undefined => {
  switch (t) {
    case 'timestamp':
      return 0;
    case 'timestamp_ms':
      return 3;
    case 'timestamp_us':
      return 6;
    case 'timestamp_ns':
      return 9;
    default:
      return undefined;
  }
};

/** The canonical instant shape: a fraction of one to nine digits, never ending in `0`. */
const CANONICAL_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.(\d{0,8}[1-9]))?Z$/;

/**
 * The timestamp tag an instant text's fraction spells — the reference's `TemporalText.unitOf`:
 * whole seconds for a text with no fraction, and for a text that is not canonical.
 */
export const timestampTypeOfText = (s: string): ColumnType => {
  const n = CANONICAL_INSTANT.exec(s)?.[1]?.length ?? 0;
  return n === 0 ? 'timestamp' : n <= 3 ? 'timestamp_ms' : n <= 6 ? 'timestamp_us' : 'timestamp_ns';
};

/**
 * The widening lattice: a type widens into itself, an int into a float or a decimal
 * (losslessly), and a coarser timestamp unit into a finer one. A float and a decimal never
 * widen into each other, and a finer unit never widens into a coarser one.
 */
export const columnTypeWidens = (from: ColumnType, to: ColumnType): boolean => {
  if (from === to) return true;
  if (from === 'int') return to === 'float' || to === 'decimal';
  const a = timestampDigits(from);
  const b = timestampDigits(to);
  return a !== undefined && b !== undefined && a <= b;
};

/**
 * Total order of two instant texts by the instant they name. The text is not ordered by its
 * bytes once a fraction may be present: `…:00Z` sorts after `…:00.5Z` as text, and `…:00.5Z`
 * after `…:00.55Z`. The whole second (the first 19 characters, `YYYY-MM-DDThh:mm:ss`, which
 * order as text) is compared first, then the fraction as nine digits. A text not of the
 * canonical shape keeps the byte order it had.
 */
export const compareInstantText = (a: string, b: string): number => {
  const fa = CANONICAL_INSTANT.exec(a);
  const fb = CANONICAL_INSTANT.exec(b);
  if (fa === null || fb === null) return a < b ? -1 : a > b ? 1 : 0;
  const sa = a.slice(0, 19);
  const sb = b.slice(0, 19);
  if (sa !== sb) return sa < sb ? -1 : 1;
  const xa = (fa[1] ?? '').padEnd(9, '0');
  const xb = (fb[1] ?? '').padEnd(9, '0');
  return xa < xb ? -1 : xa > xb ? 1 : 0;
};
