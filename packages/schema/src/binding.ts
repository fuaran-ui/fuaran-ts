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

/**
 * Phase 1690 — does this `Binding.State` DECLARE a default?
 *
 * One definition of one fact, because three seams turn on it and they must
 * agree: the encoder decides whether to emit the `defaultValue` member (§5's
 * absent-default posture), and both renderers decide whether an unwritten slot
 * resolves to that default or is UNRESOLVED (§24.8). Three copies of a
 * predicate whose whole contract is that they agree is the shape a shipped
 * defect has taken here before, so it is shared the way `truncateToGrain` is
 * shared — one implementation in the base package both tiers already import at
 * runtime.
 *
 * The two members it reads carry two different facts, per Phase 1656.
 * `defaultValue` is what an unwritten key RESOLVES to — at a typed slot the
 * decoder fills it with the slot's placeholder (`0`, `false`, `[]`) whether or
 * not the document said anything — and `defaultDeclared` is whether the
 * DOCUMENT carried the member. So the value alone cannot answer this, which is
 * exactly the collapse 1656 found.
 *
 * `defaultDeclared === undefined` is an AUTHORED binding: the field is decode
 * provenance and no authoring call site sets it, so the value test is the
 * answer there and every existing call site keeps the meaning it has always
 * had. The value test is also a FLOOR under the decoded route — a member with
 * no value is not a member, and a slot whose typed placeholder is itself
 * absent can leave a declared-but-unreadable default holding nothing.
 */
export const stateDefaultDeclared = (b: {
  readonly defaultValue: unknown;
  readonly defaultDeclared?: boolean;
}): boolean =>
  b.defaultValue !== null && b.defaultValue !== undefined && (b.defaultDeclared ?? true);
