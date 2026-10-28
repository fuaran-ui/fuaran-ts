// ============================================================================
//  Core twin — the typed column (Phase 2205), the twin of `Fuaran.Core.Column`
//  from 1.0.0 (fuaran-core#417 typed vectors, #420 the validity, #422 the
//  temporal storage).
//
//  A `DataColumn` holds one typed vector and a `Validity` instead of a list of
//  boxed cells: `Int32Array` ints and days, `Float64Array` floats and epoch
//  seconds, a `Uint8Array` of bools, and string arrays for text and decimals.
//  This module is the one place that builds and reads that storage: the
//  builders (`columnOfCells`, the typed `*Column` constructors) admit exactly
//  what Core's column admits, and the readers (`cellAt`, `columnCells` — the
//  `toCells` bridge) give back the cells the storage stands for.
//
//  Total: a refusal is a `ColumnResult` error naming the column, never a throw.
// ============================================================================

import type { Cell, ColumnData, ColumnType, DataColumn, Validity } from '@fuaran-ui/schema';

import { civilFromDays, daysFromCivil, parseIsoDay } from './civil.js';
import { timestampDigits } from './columnType.js';

/** A built column, or the refusal naming why its cells cannot be held. */
export type ColumnResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

const ok = <T>(value: T): ColumnResult<T> => ({ ok: true, value });
const fail = (error: string): ColumnResult<never> => ({ ok: false, error });

const NULL: Cell = { kind: 'Null' };
const ALL_VALID: Validity = { kind: 'AllValid' };

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** True where `n` is an integer a 32-bit int column holds. */
export const isInt32 = (n: number): boolean =>
  Number.isInteger(n) && n >= INT32_MIN && n <= INT32_MAX;

// ─── validity ────────────────────────────────────────────────────────────────

/** The validity a presence mask (`1` present, `0` absent) describes: `AllValid` when every row is present. */
export const validityOfMask = (present: Uint8Array): Validity =>
  present.includes(0) ? { kind: 'Mask', present } : ALL_VALID;

/** Is row `i` present? `false` for an index off either end, under either validity. */
const presentIn = (v: Validity, n: number, i: number): boolean =>
  i >= 0 && i < n && (v.kind === 'AllValid' || v.present[i] === 1);

// ─── canonical temporal text ─────────────────────────────────────────────────

const pad = (n: number, width: number): string => String(n).padStart(width, '0');

/** The canonical text (`YYYY-MM-DD`) of a day count since 1970-01-01. */
export const dateText = (days: number): string => {
  const c = civilFromDays(days);
  return pad(c.year, 4) + '-' + pad(c.month, 2) + '-' + pad(c.day, 2);
};

/** Days since 1970-01-01 of a CANONICAL date text — exactly `YYYY-MM-DD`, a day that exists — else `undefined`. */
export const dateDays = (text: string): number | undefined => {
  if (text.length !== 10) return undefined;
  const c = parseIsoDay(text);
  return c === undefined ? undefined : daysFromCivil(c.year, c.month, c.day);
};

const SECONDS_PER_DAY = 86400;

/** The canonical instant text shape: a fraction of one to nine digits, never ending in `0`. */
const INSTANT = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{0,8}[1-9]))?Z$/;

/**
 * An instant's storage: its whole epoch second and its fraction scaled to a unit
 * of `digits` fraction digits (0 for seconds, 3, 6 or 9).
 */
export interface InstantParts {
  readonly second: number;
  readonly fraction: number;
}

/**
 * Read a CANONICAL instant text (WIRE_FORMAT §3.6.25) into its storage at a unit of
 * `digits` fraction digits. `'notCanonical'` for any other text; `'finer'` for a
 * canonical instant whose fraction the unit cannot hold.
 */
export const instantParts = (
  text: string,
  digits: number,
): InstantParts | 'notCanonical' | 'finer' => {
  const m = INSTANT.exec(text);
  if (m === null) return 'notCanonical';
  const days = dateDays(m[1]!);
  const h = Number(m[2]);
  const mi = Number(m[3]);
  const s = Number(m[4]);
  if (days === undefined || h > 23 || mi > 59 || s > 59) return 'notCanonical';
  const f = m[5] ?? '';
  if (f.length > digits) return 'finer';
  return {
    second: days * SECONDS_PER_DAY + h * 3600 + mi * 60 + s,
    fraction: f.length === 0 ? 0 : Number(f) * 10 ** (digits - f.length),
  };
};

/** The canonical text of an instant stored as `second` plus `fraction` at a unit of `digits` digits. */
export const instantText = (second: number, fraction: number, digits: number): string => {
  const days = Math.floor(second / SECONDS_PER_DAY);
  const sod = second - days * SECONDS_PER_DAY;
  const h = Math.floor(sod / 3600);
  const mi = Math.floor((sod % 3600) / 60);
  const s = sod % 60;
  const whole = dateText(days) + 'T' + pad(h, 2) + ':' + pad(mi, 2) + ':' + pad(s, 2);
  if (fraction === 0 || digits === 0) return whole + 'Z';
  return whole + '.' + pad(fraction, digits).replace(/0+$/, '') + 'Z';
};

// ─── readers ─────────────────────────────────────────────────────────────────

/** How many rows a column's storage holds. */
export const dataLength = (d: ColumnData): number =>
  d.kind === 'Timestamps' ? d.seconds.length : d.values.length;

/** How many rows a column holds. */
export const columnLength = (c: DataColumn): number => dataLength(c.data);

/** Is row `i` of the storage present? */
export const isPresentAt = (d: ColumnData, i: number): boolean =>
  presentIn(d.validity, dataLength(d), i);

/** Row `i` of a column as its cell — `Null` where the row is absent or `i` is off either end. */
export const cellAt = (c: DataColumn, i: number): Cell => dataCellAt(c.type, c.data, i);

/** Row `i` of typed storage, read at the column type `type` (a timestamp's unit). */
export const dataCellAt = (type: ColumnType, d: ColumnData, i: number): Cell => {
  if (!isPresentAt(d, i)) return NULL;
  switch (d.kind) {
    case 'Ints':
      return { kind: 'Int', value: d.values[i]! };
    case 'Floats':
      return { kind: 'Float', value: d.values[i]! };
    case 'Bools':
      return { kind: 'Bool', value: d.values[i] === 1 };
    case 'Strs':
      return { kind: 'Str', value: d.values[i]! };
    case 'Dates':
      return { kind: 'Date', value: dateText(d.values[i]!) };
    case 'Timestamps':
      return {
        kind: 'Timestamp',
        value: instantText(d.seconds[i]!, d.fraction?.[i] ?? 0, timestampDigits(type) ?? 0),
      };
    case 'Decimals':
      return { kind: 'Decimal', value: d.values[i]! };
  }
};

/** The `toCells` bridge: every row of a column as its cell, in row order. */
export const columnCells = (c: DataColumn): Cell[] => {
  const n = columnLength(c);
  const out = new Array<Cell>(n);
  for (let i = 0; i < n; i += 1) out[i] = cellAt(c, i);
  return out;
};

// ─── builders ────────────────────────────────────────────────────────────────

/** The storage kind a column type is held as. */
const storageKind = (type: ColumnType): ColumnData['kind'] => {
  switch (type) {
    case 'int':
      return 'Ints';
    case 'float':
      return 'Floats';
    case 'bool':
      return 'Bools';
    case 'string':
      return 'Strs';
    case 'date':
      return 'Dates';
    case 'decimal':
      return 'Decimals';
    default:
      return 'Timestamps';
  }
};

/** A column of `n` absent rows at `type`. */
export const nullColumn = (name: string, type: ColumnType, n: number): DataColumn => {
  const validity: Validity = n === 0 ? ALL_VALID : { kind: 'Mask', present: new Uint8Array(n) };
  return { name, type, data: emptyData(type, n, validity) };
};

const emptyData = (type: ColumnType, n: number, validity: Validity): ColumnData => {
  switch (storageKind(type)) {
    case 'Ints':
      return { kind: 'Ints', values: new Int32Array(n), validity };
    case 'Floats':
      return { kind: 'Floats', values: new Float64Array(n), validity };
    case 'Bools':
      return { kind: 'Bools', values: new Uint8Array(n), validity };
    case 'Strs':
      return { kind: 'Strs', values: new Array<string>(n).fill(''), validity };
    case 'Dates':
      return { kind: 'Dates', values: new Int32Array(n), validity };
    case 'Decimals':
      return { kind: 'Decimals', values: new Array<string>(n).fill('0'), validity };
    case 'Timestamps':
      return { kind: 'Timestamps', seconds: new Float64Array(n), fraction: undefined, validity };
  }
};

const cellTag = (c: Cell): string => {
  switch (c.kind) {
    case 'Int':
      return 'int';
    case 'Float':
      return 'float';
    case 'Bool':
      return 'bool';
    case 'Str':
      return 'string';
    case 'Date':
      return 'date';
    case 'Timestamp':
      return 'timestamp';
    case 'Decimal':
      return 'decimal';
    case 'Null':
      return 'null';
  }
};

const outside = (name: string, type: ColumnType, c: Cell): string =>
  `column '${name}': expected ${type} value, got ${cellTag(c)}`;

/**
 * Build a column of `type` from its cells (Core's `Column.ofCells`). A `Null` is
 * an absent row. A present cell is admitted where the column type holds it: an
 * int into a float or a decimal column (the lossless widening), a timestamp of a
 * coarser unit into a finer one. Refused by name: a cell of another type, an int
 * outside 32 bits, and a date or instant whose text is not canonical.
 */
export const columnOfCells = (
  name: string,
  type: ColumnType,
  cells: readonly Cell[],
): ColumnResult<DataColumn> => {
  const n = cells.length;
  const present = new Uint8Array(n);
  const kind = storageKind(type);
  const nums = kind === 'Ints' || kind === 'Dates' ? new Int32Array(n) : undefined;
  const floats = kind === 'Floats' ? new Float64Array(n) : undefined;
  const bools = kind === 'Bools' ? new Uint8Array(n) : undefined;
  const texts = kind === 'Strs' || kind === 'Decimals' ? new Array<string>(n) : undefined;
  const seconds = kind === 'Timestamps' ? new Float64Array(n) : undefined;
  const fraction = kind === 'Timestamps' ? new Int32Array(n) : undefined;
  const digits = timestampDigits(type) ?? 0;
  let anyFraction = false;
  for (let i = 0; i < n; i += 1) {
    const c = cells[i]!;
    if (c.kind === 'Null') {
      if (texts !== undefined) texts[i] = kind === 'Decimals' ? '0' : '';
      continue;
    }
    present[i] = 1;
    switch (kind) {
      case 'Ints':
        if (c.kind !== 'Int') return fail(outside(name, type, c));
        if (!isInt32(c.value))
          return fail(
            `column '${name}': an int column holds 32-bit integers, and ${String(c.value)} is outside them`,
          );
        nums![i] = c.value;
        break;
      case 'Floats':
        if (c.kind !== 'Float' && c.kind !== 'Int') return fail(outside(name, type, c));
        floats![i] = c.value;
        break;
      case 'Bools':
        if (c.kind !== 'Bool') return fail(outside(name, type, c));
        bools![i] = c.value ? 1 : 0;
        break;
      case 'Strs':
        if (c.kind !== 'Str') return fail(outside(name, type, c));
        texts![i] = c.value;
        break;
      case 'Decimals':
        if (c.kind === 'Decimal') texts![i] = c.value;
        else if (c.kind === 'Int') texts![i] = String(Math.trunc(c.value));
        else return fail(outside(name, type, c));
        break;
      case 'Dates': {
        if (c.kind !== 'Date') return fail(outside(name, type, c));
        const d = dateDays(c.value);
        if (d === undefined)
          return fail(
            `column '${name}': a date cell must carry a canonical ISO-8601 date, YYYY-MM-DD, naming a day that exists`,
          );
        nums![i] = d;
        break;
      }
      case 'Timestamps': {
        if (c.kind !== 'Timestamp') return fail(outside(name, type, c));
        const p = instantParts(c.value, digits);
        if (p === 'notCanonical')
          return fail(
            `column '${name}': a timestamp cell must carry a canonical ISO-8601 UTC timestamp, YYYY-MM-DDThh:mm:ssZ or YYYY-MM-DDThh:mm:ss.FZ with one to nine fraction digits and no trailing zero, naming an instant that exists`,
          );
        if (p === 'finer')
          return fail(`column '${name}': a ${type} column cannot hold the instant ${c.value}`);
        seconds![i] = p.second;
        fraction![i] = p.fraction;
        if (p.fraction !== 0) anyFraction = true;
        break;
      }
    }
  }
  const validity = validityOfMask(present);
  switch (kind) {
    case 'Ints':
      return ok({ name, type, data: { kind, values: nums!, validity } });
    case 'Dates':
      return ok({ name, type, data: { kind, values: nums!, validity } });
    case 'Floats':
      return ok({ name, type, data: { kind, values: floats!, validity } });
    case 'Bools':
      return ok({ name, type, data: { kind, values: bools!, validity } });
    case 'Strs':
      return ok({ name, type, data: { kind, values: texts!, validity } });
    case 'Decimals':
      return ok({ name, type, data: { kind, values: texts!, validity } });
    case 'Timestamps':
      return ok({
        name,
        type,
        data: { kind, seconds: seconds!, fraction: anyFraction ? fraction : undefined, validity },
      });
  }
};

/**
 * The rows `rows` of a column, in that order, under a new name — the gather the
 * row-set verbs share. A row index of `-1` (or any index off the column) is an
 * absent row, so an outer join's padding is one gather. No cell is boxed.
 */
export const takeRows = (c: DataColumn, rows: ArrayLike<number>, name = c.name): DataColumn => {
  const d = c.data;
  const n = rows.length;
  const len = dataLength(d);
  const present = new Uint8Array(n);
  for (let k = 0; k < n; k += 1) present[k] = presentIn(d.validity, len, rows[k]!) ? 1 : 0;
  const validity = validityOfMask(present);
  const at = (k: number): number => {
    const r = rows[k]!;
    return r >= 0 && r < len ? r : -1;
  };
  switch (d.kind) {
    case 'Ints':
    case 'Dates': {
      const out = new Int32Array(n);
      for (let k = 0; k < n; k += 1) {
        const r = at(k);
        if (r >= 0) out[k] = d.values[r]!;
      }
      return { name, type: c.type, data: { kind: d.kind, values: out, validity } };
    }
    case 'Floats': {
      const out = new Float64Array(n);
      for (let k = 0; k < n; k += 1) {
        const r = at(k);
        if (r >= 0) out[k] = d.values[r]!;
      }
      return { name, type: c.type, data: { kind: 'Floats', values: out, validity } };
    }
    case 'Bools': {
      const out = new Uint8Array(n);
      for (let k = 0; k < n; k += 1) {
        const r = at(k);
        if (r >= 0) out[k] = d.values[r]!;
      }
      return { name, type: c.type, data: { kind: 'Bools', values: out, validity } };
    }
    case 'Strs':
    case 'Decimals': {
      const blank = d.kind === 'Decimals' ? '0' : '';
      const out = new Array<string>(n);
      for (let k = 0; k < n; k += 1) {
        const r = at(k);
        out[k] = r >= 0 ? d.values[r]! : blank;
      }
      return { name, type: c.type, data: { kind: d.kind, values: out, validity } };
    }
    case 'Timestamps': {
      const seconds = new Float64Array(n);
      const fraction = d.fraction === undefined ? undefined : new Int32Array(n);
      let anyFraction = false;
      for (let k = 0; k < n; k += 1) {
        const r = at(k);
        if (r < 0) continue;
        seconds[k] = d.seconds[r]!;
        if (fraction !== undefined) {
          fraction[k] = d.fraction![r]!;
          if (fraction[k] !== 0) anyFraction = true;
        }
      }
      return {
        name,
        type: c.type,
        data: {
          kind: 'Timestamps',
          seconds,
          fraction: anyFraction ? fraction : undefined,
          validity,
        },
      };
    }
  }
};
