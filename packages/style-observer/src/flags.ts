// ============================================================================
//  @fuaran-ui/style-observer — the resolved-colour primitives, the StyleFlag DU,
//  and the shared flag-derivation core.
//
//  Port of Fuaran.UI.StyleObserver.Abstractions (Rgba / FontRole / StyleFlag /
//  StyleObservation / StyleObserverOptions) + Fuaran.UI.StyleObserver.Flags (the
//  pure derivation surface). Both the browser observer and the in-memory observer
//  feed captured colours through `deriveStyleFlags`, so identical inputs produce
//  identical flags (FGP 4 — diagnostics under both pipelines).
//
//  The semantic-state channel is blind to *resolved style* failures: the AI
//  emits `Tone.Brand`, the host CSS resolves it through the
//  `--fuaran-tone-{tone}-{bg,fg,border}` contract, and nothing reports back
//  whether the rendered result is legible, distinguishable, or even non-null.
//  This small fixed flag vocabulary is what the observer derives from resolved
//  colours + WCAG contrast and surfaces to a TS host's dev tooling (or, where one
//  exists, an orchestrator-feedback loop).
//
//  The `encodeStyleFlag` / `encodeStyleObservation` JSON forms are byte-identical
//  to the F# `StyleFlag.encode` / `StyleObservation.encode` output for the same
//  value, so a flag observed in either tier carries the same wire shape.
//
//  TWO TIERS. The first three flags are MANIFEST-FREE: derived from resolved
//  colours + WCAG contrast alone, no theme contract needed — this is what the
//  derivation here produces. The last four are MANIFEST-AWARE: derived against a
//  declared theme manifest. They are kept in the union + encoder for byte-shape
//  parity with the F# wire surface (and so the manifest-aware tier can be wired
//  later without a breaking change), but the TypeScript tier does not yet ship a
//  theme-manifest contract, so they are never derived here.
// ============================================================================

// ─── Rgba — the resolved colour primitive ────────────────────────────────────

/**
 * A resolved colour. Channels `r`/`g`/`b` are 0–255; `a` (alpha) is 0–1 —
 * matching the browser's `getComputedStyle` reporting convention (`rgb(r, g, b)`
 * / `rgba(r, g, b, a)`). Compositing produces fractional channel values, so the
 * fields are floats. Port of F# `Rgba`.
 */
export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

/** Opaque black — the conventional text default. */
export const black: Rgba = { r: 0, g: 0, b: 0, a: 1 };
/** Opaque white — the browser's default canvas colour / implicit opaque base. */
export const white: Rgba = { r: 255, g: 255, b: 255, a: 1 };
/** Fully-transparent — `background-color: transparent` / `rgba(_, _, _, 0)`. */
export const transparent: Rgba = { r: 0, g: 0, b: 0, a: 0 };

/** Construct an opaque colour from 0–255 channels. */
export const rgb = (r: number, g: number, b: number): Rgba => ({ r, g, b, a: 1 });
/** Construct a colour with explicit alpha (0–1). */
export const rgba = (r: number, g: number, b: number, a: number): Rgba => ({ r, g, b, a });

/** `true` when the colour is fully opaque (alpha ≥ 1) — the composite walk stops here. */
export const isOpaque = (c: Rgba): boolean => c.a >= 1;

const roundCh = (v: number): number => Math.round(v);

/**
 * RGB-equal after rounding channels to the nearest integer — the comparison used
 * to match a resolved colour against a manifest palette hex. Alpha is ignored
 * (palette colours + composited effective backgrounds are opaque). Port of F#
 * `Rgba.sameRgb`.
 */
export const sameRgb = (a: Rgba, b: Rgba): boolean =>
  roundCh(a.r) === roundCh(b.r) && roundCh(a.g) === roundCh(b.g) && roundCh(a.b) === roundCh(b.b);

/**
 * Parse a CSS hex colour (`#rgb`, `#rrggbb`, `#rrggbbaa`) to an `Rgba`, or
 * `undefined` for anything malformed. Used to compare a manifest palette's
 * declared hex tokens against resolved fills. Port of F# `Rgba.tryParseHex`.
 */
export const tryParseHex = (raw: string): Rgba | undefined => {
  const s = raw.trim().replace(/^#/, '');
  const hex2 = (i: number): number | undefined => {
    const v = Number.parseInt(s.slice(i, i + 2), 16);
    return Number.isNaN(v) ? undefined : v;
  };
  const hex1 = (i: number): number | undefined => {
    const v = Number.parseInt(s[i] ?? '', 16);
    return Number.isNaN(v) ? undefined : v * 16 + v;
  };
  if (s.length === 3) {
    const r = hex1(0);
    const g = hex1(1);
    const b = hex1(2);
    return r !== undefined && g !== undefined && b !== undefined ? rgb(r, g, b) : undefined;
  }
  if (s.length === 6) {
    const r = hex2(0);
    const g = hex2(2);
    const b = hex2(4);
    return r !== undefined && g !== undefined && b !== undefined ? rgb(r, g, b) : undefined;
  }
  if (s.length === 8) {
    const r = hex2(0);
    const g = hex2(2);
    const b = hex2(4);
    const a = hex2(6);
    return r !== undefined && g !== undefined && b !== undefined && a !== undefined
      ? rgba(r, g, b, a / 255)
      : undefined;
  }
  return undefined;
};

/** Two-decimal invariant float (the F# `ToString("F2")` wire form). */
const f2 = (n: number): string => n.toFixed(2);

/** Escape `"` and `\` per the F# encoder. */
const escape = (s: string): string => s.replace(/\\/g, '\\\\').replace(/"/g, '\\"');

/** Encode as compact JSON — `{"r":R,"g":G,"b":B,"a":A}` (2-decimal). Byte-identical to F# `Rgba.encode`. */
export const encodeRgba = (c: Rgba): string =>
  `{"r":${f2(c.r)},"g":${f2(c.g)},"b":${f2(c.b)},"a":${f2(c.a)}}`;

// ─── FontRole — coarse font-family classification ────────────────────────────

/**
 * Coarse font-family classification. The AI consumer reasons about the role, not
 * the exact family name — "is this monospaced" matters for interpreting a data
 * table or code block; the precise family does not. `Unknown` covers an absent
 * or unclassifiable font-family. The string literal IS the wire token (the F#
 * `FontRole.kind` discriminator). Port of F# `FontRole`.
 */
export type FontRole = 'SansSerif' | 'Serif' | 'Monospace' | 'Unknown';

// ─── StyleFlag — the AI-facing legibility interpretations ─────────────────────

/**
 * The fixed set of resolved-style interpretation flags the observer derives.
 * **Additive-only post-ship** — adding a case is fine; redefining one breaks
 * every prompt cache that pattern-matched it. Cases 1–3 are manifest-free (and
 * are what `deriveStyleFlags` produces); cases 4–7 are manifest-aware and kept
 * here for wire-shape parity with the F# `StyleFlag` union (not derived in the
 * TypeScript tier, which has no theme-manifest contract yet). Port of F#
 * `StyleFlag`.
 */
export type StyleFlag =
  // ─── Manifest-free ──────────────────────────────────────────────
  /** Composited foreground/background WCAG contrast below the AA normal-text floor but still faintly visible. */
  | { readonly kind: 'ContrastBelowAA'; readonly ratio: number }
  /** Contrast at/near 1.0 — text ≈ surface behind it, i.e. effectively invisible. The severe subset. */
  | { readonly kind: 'InvisibleText'; readonly ratio: number }
  /** A toned element's accent surface contrasts with its container below the UI-component floor — the tone conveys no visible signal. */
  | { readonly kind: 'AccentIndistinct'; readonly ratio: number }
  // ─── Manifest-aware (parity-only; not derived in TS) ────────────
  /** A tone/role (`slot`) the declared manifest has no token for — the emission fell through the host CSS. */
  | { readonly kind: 'TokenResolutionFailed'; readonly slot: string }
  /** A toned element's resolved fill (`value`) is not present in the manifest palette. */
  | { readonly kind: 'OffPaletteColour'; readonly value: string }
  /** A token's share of total visible surface area breached its declared usage budget (60-30-10). */
  | {
      readonly kind: 'UsageBudgetExceeded';
      readonly token: string;
      readonly declaredPct: number;
      readonly observedPct: number;
    }
  /** A role's resolved contrast is below the manifest's declared per-role floor (stricter than the AA default). */
  | {
      readonly kind: 'ContrastBelowDeclaredFloor';
      readonly role: string;
      readonly ratio: number;
      readonly floor: number;
    };

/** Stable string discriminator — the `kind` literal is the discriminator. */
export const flagKind = (flag: StyleFlag): string => flag.kind;

/**
 * Encode a single flag as the AI-friendly tagged-object JSON. Byte-identical to
 * F# `StyleFlag.encode` — 2-decimal invariant floats, escaped string fields.
 */
export const encodeStyleFlag = (flag: StyleFlag): string => {
  switch (flag.kind) {
    case 'ContrastBelowAA':
    case 'InvisibleText':
    case 'AccentIndistinct':
      return `{"kind":"${flag.kind}","ratio":${f2(flag.ratio)}}`;
    case 'TokenResolutionFailed':
      return `{"kind":"TokenResolutionFailed","slot":"${escape(flag.slot)}"}`;
    case 'OffPaletteColour':
      return `{"kind":"OffPaletteColour","value":"${escape(flag.value)}"}`;
    case 'UsageBudgetExceeded':
      return `{"kind":"UsageBudgetExceeded","token":"${escape(flag.token)}","declaredPct":${f2(
        flag.declaredPct,
      )},"observedPct":${f2(flag.observedPct)}}`;
    case 'ContrastBelowDeclaredFloor':
      return `{"kind":"ContrastBelowDeclaredFloor","role":"${escape(flag.role)}","ratio":${f2(
        flag.ratio,
      )},"floor":${f2(flag.floor)}}`;
  }
};

// ─── StyleObservation — one resolved-style snapshot per node ──────────────────

/**
 * One resolved-style snapshot for a single addressable node — the per-node
 * payload surfaced by `IStyleObserver`, keyed by node id. `foreground` is the
 * composited colour the text actually paints with; `effectiveBackground` is the
 * opaque colour behind it after the ancestor-compositing walk; `emittedTone` is
 * the `--fuaran-tone-*` token the element declared (`undefined` for none);
 * `contrastRatio` is the WCAG ratio the flags keyed off. The flag list is the
 * AI-facing interpretation; the colour/font/tone fields are the evidence. Port
 * of F# `StyleObservation`.
 */
export interface StyleObservation {
  readonly nodeId: string;
  readonly foreground: Rgba;
  readonly effectiveBackground: Rgba;
  readonly fontRole: FontRole;
  readonly emittedTone: string | undefined;
  readonly contrastRatio: number;
  readonly flags: readonly StyleFlag[];
}

/**
 * Encode an observation as JSON, byte-identical to F# `StyleObservation.encode`.
 * `emittedTone` is `null` when `undefined`; floats are 2-decimal invariant.
 */
export const encodeStyleObservation = (obs: StyleObservation): string => {
  const tone = obs.emittedTone === undefined ? 'null' : `"${escape(obs.emittedTone)}"`;
  const flagsJson = obs.flags.map(encodeStyleFlag).join(',');
  return `{"nodeId":"${escape(obs.nodeId)}","foreground":${encodeRgba(
    obs.foreground,
  )},"effectiveBackground":${encodeRgba(obs.effectiveBackground)},"fontRole":"${
    obs.fontRole
  }","emittedTone":${tone},"contrastRatio":${f2(obs.contrastRatio)},"flags":[${flagsJson}]}`;
};

// ─── StyleObserverOptions — host-tunable defaults ─────────────────────────────

/**
 * Host-tunable policy — port of F# `StyleObserverOptions`.
 *  - `debounceMs`: minimum interval between emissions (wall-clock floor on top of
 *    rAF coalescing).
 *  - `contrastAAThreshold`: the WCAG AA normal-text contrast floor (4.5).
 *    `ContrastBelowAA` fires below this (and at/above the invisible threshold).
 *  - `invisibleTextThreshold`: the contrast at/below which text is treated as
 *    effectively invisible (1.1). `InvisibleText` fires below it.
 *  - `accentIndistinctThreshold`: the WCAG UI-component contrast floor (3.0).
 *  - `emitOnFlagChangeOnly`: when true (the default), a debounced tick that
 *    produces the same flags as the previous emission is suppressed.
 */
export interface StyleObserverOptions {
  readonly debounceMs: number;
  readonly contrastAAThreshold: number;
  readonly invisibleTextThreshold: number;
  readonly accentIndistinctThreshold: number;
  readonly emitOnFlagChangeOnly: boolean;
}

/** v1 defaults — 100ms debounce, WCAG AA (4.5) / UI-component (3.0) floors, 1.1 invisible threshold, change-only. */
export const defaultStyleObserverOptions: StyleObserverOptions = {
  debounceMs: 100,
  contrastAAThreshold: 4.5,
  invisibleTextThreshold: 1.1,
  accentIndistinctThreshold: 3.0,
  emitOnFlagChangeOnly: true,
};

// ─── StyleInput — the abstract evidence envelope ──────────────────────────────

/**
 * The abstract evidence envelope the derivation logic operates on — pre-populated
 * by either the browser observer (live computed style) or a hand-authored
 * fixture. Keeping derivation ignorant of the source means the same tests drive
 * both observers. Port of F# `Flags.StyleInput`.
 */
export interface StyleInput {
  /** The element's declared `color` (foreground). May be translucent; composited over the effective background before measuring. */
  readonly foreground: Rgba;
  /** The element's own `background-color` followed by each ancestor's, element-first (top-to-bottom paint order). Each may be translucent. */
  readonly backgroundLayers: readonly Rgba[];
  /** The computed `font-family` string, classified to a `FontRole`. `undefined` skips classification (`Unknown`). */
  readonly fontFamily: string | undefined;
  /** The `--fuaran-tone-*` token the element declared (`data-fuaran-tone`). `undefined` for an untoned element — `AccentIndistinct` only fires for toned elements. */
  readonly emittedTone: string | undefined;
}

/** Baseline input — opaque-black text on the implicit white canvas, no font, no tone. Port of F# `StyleInput.baseline`. */
export const baselineStyleInput = (): StyleInput => ({
  foreground: black,
  backgroundLayers: [],
  fontFamily: undefined,
  emittedTone: undefined,
});

// ─── Compositing + WCAG contrast ──────────────────────────────────────────────

/**
 * Source-over composite of `top` (with its alpha) over `bottom`. Standard
 * premultiplied-then-normalised alpha blend. Port of F# `Flags.composite`.
 */
export const composite = (top: Rgba, bottom: Rgba): Rgba => {
  const a = top.a + bottom.a * (1 - top.a);
  if (a <= 0) return transparent;
  const blend = (tc: number, bc: number): number => (tc * top.a + bc * bottom.a * (1 - top.a)) / a;
  return { r: blend(top.r, bottom.r), g: blend(top.g, bottom.g), b: blend(top.b, bottom.b), a };
};

/**
 * Composite a background layer stack (element-first) down to the first opaque
 * layer, returning the opaque colour the text sits on. Layers below the first
 * opaque one are discarded; when none is opaque, an opaque-white base (the
 * browser's default canvas) is appended. Port of F# `Flags.effectiveBackground`.
 */
export const effectiveBackground = (layers: readonly Rgba[]): Rgba => {
  // Truncate at (and including) the first opaque layer.
  const truncated: Rgba[] = [];
  let foundOpaque = false;
  for (const layer of layers) {
    truncated.push(layer);
    if (isOpaque(layer)) {
      foundOpaque = true;
      break;
    }
  }
  const stack = foundOpaque ? truncated : [...truncated, white];
  // Composite from the opaque base upward to the element layer.
  const baseFirst = [...stack].reverse();
  if (baseFirst.length === 0) return white;
  let acc = baseFirst[0]!;
  for (let i = 1; i < baseFirst.length; i += 1) acc = composite(baseFirst[i]!, acc);
  return acc;
};

/**
 * WCAG relative luminance of an (assumed opaque) colour — channels linearised
 * per the sRGB transfer function then weighted. Port of F# `Flags.relativeLuminance`.
 */
export const relativeLuminance = (c: Rgba): number => {
  const channel = (v: number): number => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
};

/**
 * WCAG contrast ratio between two opaque colours — `(L_lighter + 0.05) /
 * (L_darker + 0.05)`, in the range 1.0 (identical) … 21.0 (black-on-white). Port
 * of F# `Flags.contrastRatio`.
 */
export const contrastRatio = (a: Rgba, b: Rgba): number => {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
};

// ─── Derived evidence (shared by both observers) ──────────────────────────────

/** The opaque background the text sits on, after the composite walk. */
export const resolvedBackground = (input: StyleInput): Rgba =>
  effectiveBackground(input.backgroundLayers);

/** The colour the text actually paints with — declared foreground composited over the effective background. */
export const resolvedForeground = (input: StyleInput): Rgba =>
  composite(input.foreground, resolvedBackground(input));

/** The WCAG contrast ratio between the resolved foreground and the effective background. */
export const contrast = (input: StyleInput): number =>
  contrastRatio(resolvedForeground(input), resolvedBackground(input));

/**
 * Classify the computed font-family string into a `FontRole`. Substring match,
 * case-insensitive, locale-independent: "mono" → Monospace, "sans" → SansSerif,
 * "serif" → Serif; absent / unclassifiable → Unknown. Port of F# `Flags.fontRole`.
 */
export const fontRole = (input: StyleInput): FontRole => {
  if (input.fontFamily === undefined) return 'Unknown';
  const f = input.fontFamily.toLowerCase();
  if (f.includes('mono')) return 'Monospace';
  if (f.includes('sans')) return 'SansSerif';
  if (f.includes('serif')) return 'Serif';
  return 'Unknown';
};

// ─── Per-flag predicates (pure; exposed for direct testing) ───────────────────
//
// `invisibleText` and `contrastBelowAA` partition the contrast axis: invisible
// fires strictly below the invisible threshold; below-AA fires in the band
// `[invisibleThreshold, aaThreshold)`. By construction they never both fire.

/** `InvisibleText` — contrast at/below the invisible threshold (text ≈ background). The severe subset. */
export const invisibleText = (
  invisibleThreshold: number,
  input: StyleInput,
): StyleFlag | undefined => {
  const c = contrast(input);
  return c < invisibleThreshold ? { kind: 'InvisibleText', ratio: c } : undefined;
};

/** `ContrastBelowAA` — contrast in `[invisibleThreshold, aaThreshold)`: below the AA floor but still faintly visible. */
export const contrastBelowAA = (
  invisibleThreshold: number,
  aaThreshold: number,
  input: StyleInput,
): StyleFlag | undefined => {
  const c = contrast(input);
  return c >= invisibleThreshold && c < aaThreshold
    ? { kind: 'ContrastBelowAA', ratio: c }
    : undefined;
};

/**
 * `AccentIndistinct` — fires when the element declared a tone AND has a distinct
 * (non-transparent) own background tint, but that tint's contrast against the
 * surface behind it is below the UI-component floor. Port of F# `Flags.accentIndistinct`.
 */
export const accentIndistinct = (
  accentThreshold: number,
  input: StyleInput,
): StyleFlag | undefined => {
  if (input.emittedTone === undefined) return undefined;
  const [ownLayer, ...ancestorLayers] = input.backgroundLayers;
  if (ownLayer === undefined) return undefined;
  if (ownLayer.a <= 0) return undefined;
  // The accent surface = the full composite (element tint over ancestors); the
  // surface behind it = the ancestor composite.
  const accentSurface = resolvedBackground(input);
  const ancestorSurface = effectiveBackground(ancestorLayers);
  const c = contrastRatio(accentSurface, ancestorSurface);
  return c < accentThreshold ? { kind: 'AccentIndistinct', ratio: c } : undefined;
};

// ─── Combined derivation ───────────────────────────────────────────────────────

/**
 * Derive the full (manifest-free) flag list for one `StyleInput`. The entry point
 * both observers call — same input produces same deterministically-ordered
 * output. Port of F# `Flags.derive`.
 */
export const deriveStyleFlags = (options: StyleObserverOptions, input: StyleInput): StyleFlag[] => {
  const flags: StyleFlag[] = [];
  const inv = invisibleText(options.invisibleTextThreshold, input);
  if (inv) flags.push(inv);
  const aa = contrastBelowAA(options.invisibleTextThreshold, options.contrastAAThreshold, input);
  if (aa) flags.push(aa);
  const accent = accentIndistinct(options.accentIndistinctThreshold, input);
  if (accent) flags.push(accent);
  return flags;
};

/**
 * Build a fully-populated `StyleObservation` from a `StyleInput` — the shared
 * shape both observers use so the browser + in-memory payloads are byte-identical
 * for identical evidence. Port of F# `Flags.toObservation`.
 */
export const toStyleObservation = (
  options: StyleObserverOptions,
  nodeId: string,
  input: StyleInput,
): StyleObservation => ({
  nodeId,
  foreground: resolvedForeground(input),
  effectiveBackground: resolvedBackground(input),
  fontRole: fontRole(input),
  emittedTone: input.emittedTone,
  contrastRatio: contrast(input),
  flags: deriveStyleFlags(options, input),
});

/** True when two flag lists are equal (order-sensitive, the derive order). */
export const flagsEqual = (a: readonly StyleFlag[], b: readonly StyleFlag[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((flag, i) => encodeStyleFlag(flag) === encodeStyleFlag(b[i]!));
};
