// Companion helpers for `Binding<T>` — the TS twin of the F# reference's
// Binding module (base-package placement, so the decoder and the smart-ctor
// surface share one implementation).

/**
 * Phase 632 — the declarative row-field projection a decoded `Selection`
 * carries when its wire form names a `field`. The grid's default row-click
 * writes the FULL row (a plain `{ [columnName]: value }` object, the
 * Transform-produced shape) to the selection seam; this accessor projects the
 * named field off it so the binding stays scalar after a real click (the
 * identity accessor yields the row itself — a non-scalar mismatch in scalar
 * slots and Transform params). A missing field or a non-row value THROWS with
 * a didactic — surfaced as the resolver's loud `Selection accessor threw`,
 * never a silent wrong value.
 */
export const projectSelectionField =
  <T>(field: string): ((raw: unknown) => T) =>
  (raw: unknown): T => {
    if (raw === null || raw === undefined) {
      throw new Error(`Selection field '${field}': the selected value is null, not a row`);
    }
    if (typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Selection field '${field}': the selected value is not a row object`);
    }
    const row = raw as Readonly<Record<string, unknown>>;
    if (!Object.prototype.hasOwnProperty.call(row, field)) {
      throw new Error(`Selection field '${field}' is not present on the selected row`);
    }
    return row[field] as T;
  };
