// ============================================================================
//  @fuaran-ui/layout-observer — the LayoutFlag DU + shared flag-derivation core.
//
//  Port of Fuaran.UI.LayoutObserver.Abstractions (LayoutFlag / LayoutObservation
//  / LayoutObserverOptions) + Fuaran.UI.LayoutObserver.Flags (the pure
//  derivation surface). Both the browser observer and the in-memory observer
//  feed captured metrics through `deriveFlags`, so identical inputs produce
//  identical flags (FGP 4 — diagnostics under both pipelines).
//
//  The semantic-state channel (fields / buttons / selections) is blind to
//  layout failures — a stack squeezed flat, a child clipped by an ancestor's
//  overflow:hidden, a flex item collapsed to zero. This small fixed flag
//  vocabulary is what the observer derives from raw geometry and surfaces to a
//  TS host's dev tooling (or, where one exists, an orchestrator-feedback loop).
//
//  The `encodeFlag` / `encodeObservation` JSON forms are byte-identical to the
//  F# `LayoutFlag.encode` / `LayoutObservation.encode` output for the same
//  value, so a flag observed in either tier carries the same wire shape.
// ============================================================================

/**
 * The fixed set of layout-interpretation flags the observer derives from raw
 * geometry. **Additive-only post-ship** — adding a case is fine; redefining one
 * breaks every prompt cache that pattern-matched it. Port of F# `LayoutFlag`.
 */
export type LayoutFlag =
  | { readonly kind: 'OverflowHorizontal' }
  | { readonly kind: 'OverflowVertical' }
  | { readonly kind: 'ZeroDimension'; readonly axis: 'width' | 'height' }
  | { readonly kind: 'SqueezedToMin'; readonly axis: 'width' | 'height' }
  | { readonly kind: 'ChildClippedByAncestor' }
  | { readonly kind: 'AspectRatioWildlyOff'; readonly factor: number };

/** Stable string discriminator — the `kind` literal is the discriminator. */
export const flagKind = (flag: LayoutFlag): string => flag.kind;

/** Two-decimal invariant float (the F# `ToString("F2")` wire form). */
const f2 = (n: number): string => n.toFixed(2);

/** Escape `"` and `\` per the F# encoder. */
const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/**
 * Encode a single flag as the AI-friendly tagged-object JSON — `{"kind":"X"}`
 * for nullary cases, `{"kind":"X","axis":"width"}` for axis-tagged cases,
 * `{"kind":"AspectRatioWildlyOff","factor":3.20}` for the aspect case.
 * Byte-identical to F# `LayoutFlag.encode`.
 */
export const encodeFlag = (flag: LayoutFlag): string => {
  switch (flag.kind) {
    case 'OverflowHorizontal':
    case 'OverflowVertical':
    case 'ChildClippedByAncestor':
      return `{"kind":"${flag.kind}"}`;
    case 'ZeroDimension':
    case 'SqueezedToMin':
      return `{"kind":"${flag.kind}","axis":"${escape(flag.axis)}"}`;
    case 'AspectRatioWildlyOff':
      return `{"kind":"AspectRatioWildlyOff","factor":${f2(flag.factor)}}`;
  }
};

/**
 * One geometric snapshot for a single addressable node — the per-node payload
 * surfaced by `ILayoutObserver`, keyed by node id. The flag list is the
 * AI-facing interpretation; the raw metrics are the supporting evidence. Port
 * of F# `LayoutObservation`.
 */
export interface LayoutObservation {
  readonly nodeId: string;
  readonly width: number;
  readonly height: number;
  readonly viewportX: number;
  readonly viewportY: number;
  readonly flags: readonly LayoutFlag[];
}

/** Encode an observation as JSON, byte-identical to F# `LayoutObservation.encode`. */
export const encodeObservation = (obs: LayoutObservation): string => {
  const flagsJson = obs.flags.map(encodeFlag).join(',');
  return `{"nodeId":"${escape(obs.nodeId)}","width":${f2(obs.width)},"height":${f2(
    obs.height,
  )},"viewportX":${f2(obs.viewportX)},"viewportY":${f2(obs.viewportY)},"flags":[${flagsJson}]}`;
};

/**
 * Host-tunable policy — port of F# `LayoutObserverOptions`.
 *  - `debounceMs`: minimum interval between emissions (wall-clock floor on top
 *    of rAF coalescing). A 1000-event resize burst over 1s yields ≤ 10
 *    emissions at the default 100ms floor.
 *  - `aspectRatioWildlyOffFactor`: magnitude threshold for the aspect flag.
 *  - `emitOnFlagChangeOnly`: when true (the default), a debounced tick that
 *    produces the same flags as the previous emission is suppressed.
 */
export interface LayoutObserverOptions {
  readonly debounceMs: number;
  readonly aspectRatioWildlyOffFactor: number;
  readonly emitOnFlagChangeOnly: boolean;
}

/** v1 defaults — 100ms debounce, 3× aspect threshold, change-only emission. */
export const defaultLayoutObserverOptions: LayoutObserverOptions = {
  debounceMs: 100,
  aspectRatioWildlyOffFactor: 3.0,
  emitOnFlagChangeOnly: true,
};

/**
 * The abstract metric envelope the derivation logic operates on — pre-populated
 * by either the browser observer (live geometry) or a hand-authored fixture.
 * Optional fields stay `undefined` when the source can't provide them;
 * derivation degrades gracefully (the dependent flag simply doesn't fire). Port
 * of F# `Flags.LayoutInput`.
 */
export interface LayoutInput {
  readonly width: number;
  readonly height: number;
  readonly scrollWidth?: number;
  readonly scrollHeight?: number;
  readonly clientWidth?: number;
  readonly clientHeight?: number;
  /** Computed `overflow-x` ("visible" / "hidden" / "scroll" / "auto" / "clip"). */
  readonly overflowX?: string;
  readonly overflowY?: string;
  readonly minWidth?: number;
  readonly minHeight?: number;
  /** Nearest clipping ancestor's rect `[left, top, right, bottom]`, if any. */
  readonly clippingAncestorRect?: readonly [number, number, number, number];
  /** The element's viewport rect `[left, top, right, bottom]`. */
  readonly elementRect: readonly [number, number, number, number];
  /** Author-intended `width / height` ratio, if declared. */
  readonly expectedAspectRatio?: number;
}

/** Empty input baseline — useful for fixtures asserting one specific flag. */
export const emptyLayoutInput = (width: number, height: number): LayoutInput => ({
  width,
  height,
  elementRect: [0, 0, width, height],
});

// ─── Per-flag predicates (pure; exposed for direct testing) ──────────────────

/** `OverflowHorizontal` — content exceeds paint region AND overflow-x clips. */
export const overflowHorizontal = (input: LayoutInput): LayoutFlag | undefined =>
  input.scrollWidth !== undefined &&
  input.clientWidth !== undefined &&
  input.overflowX !== undefined &&
  input.scrollWidth > input.clientWidth &&
  input.overflowX !== 'visible'
    ? { kind: 'OverflowHorizontal' }
    : undefined;

/** `OverflowVertical` — vertical counterpart of `overflowHorizontal`. */
export const overflowVertical = (input: LayoutInput): LayoutFlag | undefined =>
  input.scrollHeight !== undefined &&
  input.clientHeight !== undefined &&
  input.overflowY !== undefined &&
  input.scrollHeight > input.clientHeight &&
  input.overflowY !== 'visible'
    ? { kind: 'OverflowVertical' }
    : undefined;

/** `ZeroDimension` — fires per axis whose rendered dimension resolved to ≤ 0.5px. */
export const zeroDimension = (input: LayoutInput): LayoutFlag[] => {
  const flags: LayoutFlag[] = [];
  if (input.width <= 0.5) flags.push({ kind: 'ZeroDimension', axis: 'width' });
  if (input.height <= 0.5) flags.push({ kind: 'ZeroDimension', axis: 'height' });
  return flags;
};

/** `SqueezedToMin` — fires per axis within 0.5px of the computed min-dimension. */
export const squeezedToMin = (input: LayoutInput): LayoutFlag[] => {
  const flags: LayoutFlag[] = [];
  if (
    input.minWidth !== undefined &&
    input.minWidth > 0 &&
    Math.abs(input.width - input.minWidth) <= 0.5
  ) {
    flags.push({ kind: 'SqueezedToMin', axis: 'width' });
  }
  if (
    input.minHeight !== undefined &&
    input.minHeight > 0 &&
    Math.abs(input.height - input.minHeight) <= 0.5
  ) {
    flags.push({ kind: 'SqueezedToMin', axis: 'height' });
  }
  return flags;
};

/** `ChildClippedByAncestor` — element rect extends beyond a clipping ancestor. */
export const childClippedByAncestor = (input: LayoutInput): LayoutFlag | undefined => {
  if (input.clippingAncestorRect === undefined) return undefined;
  const [ancL, ancT, ancR, ancB] = input.clippingAncestorRect;
  const [elL, elT, elR, elB] = input.elementRect;
  // 0.5px tolerance to absorb sub-pixel rounding noise.
  return elL < ancL - 0.5 || elT < ancT - 0.5 || elR > ancR + 0.5 || elB > ancB + 0.5
    ? { kind: 'ChildClippedByAncestor' }
    : undefined;
};

/** `AspectRatioWildlyOff` — observed ratio diverges from expected by ≥ threshold. */
export const aspectRatioWildlyOff = (
  factorThreshold: number,
  input: LayoutInput,
): LayoutFlag | undefined => {
  if (input.expectedAspectRatio === undefined || input.expectedAspectRatio <= 0) return undefined;
  if (input.height <= 0 || input.width <= 0) return undefined;
  const observed = input.width / input.height;
  const ratio = observed / input.expectedAspectRatio;
  // Direction-agnostic magnitude — 0.3× off is as "wildly off" as 3.0× off.
  const magnitude = ratio >= 1 ? ratio : 1 / ratio;
  return magnitude >= factorThreshold
    ? { kind: 'AspectRatioWildlyOff', factor: magnitude }
    : undefined;
};

/**
 * Derive the full flag list for one `LayoutInput`. The entry point both
 * observers call — same input produces same deterministically-ordered output.
 * Port of F# `Flags.derive`.
 */
export const deriveFlags = (options: LayoutObserverOptions, input: LayoutInput): LayoutFlag[] => {
  const flags: LayoutFlag[] = [];
  const oh = overflowHorizontal(input);
  if (oh) flags.push(oh);
  const ov = overflowVertical(input);
  if (ov) flags.push(ov);
  flags.push(...zeroDimension(input));
  flags.push(...squeezedToMin(input));
  const cc = childClippedByAncestor(input);
  if (cc) flags.push(cc);
  const ar = aspectRatioWildlyOff(options.aspectRatioWildlyOffFactor, input);
  if (ar) flags.push(ar);
  return flags;
};

/** True when two flag lists are equal (order-sensitive, the derive order). */
export const flagsEqual = (a: readonly LayoutFlag[], b: readonly LayoutFlag[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((flag, i) => encodeFlag(flag) === encodeFlag(b[i]!));
};
