// ============================================================================
//  @fuaran-ui/style-observer/manifestFlags — manifest-aware flag derivation.
//
//  Port of Fuaran.UI.StyleObserver.ManifestFlags (Phase 146). The render-time
//  enforcement of a declared aesthetic-semantic budget, composing the resolved
//  fills (the manifest-free observation) + a `ThemeManifest`. Deterministic — no
//  vision model in the verify path, so it is CI-gateable.
//
//  Two surfaces:
//    - perNodeFlags — per-NodeId fidelity checks (token resolution, palette
//      membership, declared contrast floor). Appended to each observation by an
//      observer that has a manifest wired.
//    - verifyUsageBudgets — the tree-level area-weighted colour-budget check (the
//      60-30-10 enforcement). Needs both observers: the caller joins each
//      StyleObservation with its LayoutObservation area per NodeId.
//
//  Custom-subtree policy: EXEMPT. Every per-node manifest check fires only for
//  TONED nodes (those carrying an emittedTone). Custom / domain-SVG content never
//  carries a data-fuaran-tone, so it is exempt by construction.
// ============================================================================

import {
  resolveNamedRole,
  resolveRole,
  toneOfString,
  type ManifestToken,
  type ThemeManifest,
} from '@fuaran-ui/theme-manifest';

import { sameRgb, tryParseHex, type Rgba, type StyleFlag, type StyleObservation } from './flags.js';

const ri = (v: number): number => Math.round(v);
const rgbString = (c: Rgba): string => `rgb(${ri(c.r)}, ${ri(c.g)}, ${ri(c.b)})`;

/**
 * Lexicographic comparison of two sequences under an element comparator: the
 * first differing element decides, and a sequence that is a prefix of the other
 * sorts first.
 */
const compareSeq = <T>(a: readonly T[], b: readonly T[], cmp: (x: T, y: T) => number): number => {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const c = cmp(a[i]!, b[i]!);
    if (c !== 0) return c;
  }
  return a.length - b.length;
};

/**
 * A string's Unicode code points. `Array.from` iterates by code point, so a
 * surrogate pair is ONE element; a lone surrogate is its own element.
 */
const codePoints = (s: string): number[] => Array.from(s, (ch) => ch.codePointAt(0)!);

const compareNumber = (x: number, y: number): number => x - y;

/**
 * Canonical token-path order: the order palette ATTRIBUTION iterates in (Phase
 * 1727; the rule is stated once, in the theme-manifest contract text under
 * "Palette attribution order", and pinned by the corpus's
 * `style-observer/budget-same-valued-tokens-*` vectors). Paths compare segment by
 * segment, a shorter prefix first, each segment by Unicode code point (UTF-8 byte
 * order). It is deliberately segment-wise rather than a sort of the dotted
 * string: `color.brand.base` precedes `color.brand-alt` although `-` sorts before
 * `.` as a character. And it is by code point, not by JavaScript's default
 * UTF-16 code-unit comparison, which orders a supplementary-plane character
 * (a surrogate pair, 0xD800-0xDFFF) before U+E000-U+FFFF, where every other host
 * orders it after.
 *
 * This host's decoder preserves DOCUMENT order, and a projection consumer may
 * rely on that, so the ordering lives here, at the one site where order is a
 * contract — not in `@fuaran-ui/theme-manifest`'s decoder.
 */
export const compareTokenPaths = (a: string, b: string): number =>
  compareSeq(a.split('.'), b.split('.'), (x, y) =>
    compareSeq(codePoints(x), codePoints(y), compareNumber),
  );

/**
 * The manifest's colour palette parsed to Rgba + the declaring token name, in
 * canonical token-path order. The first entry whose colour matches a rendered
 * fill is the token the fill is ATTRIBUTED to, so two same-valued tokens
 * attribute to the path-first one on every host. The sort is stable, so two
 * tokens declaring the same path keep their document order.
 */
const paletteRgba = (manifest: ThemeManifest): Array<readonly [Rgba, string]> => {
  const out: Array<readonly [Rgba, string]> = [];
  for (const t of manifest.tokens) {
    if (t.type !== 'color') continue;
    const c = tryParseHex(t.value);
    if (c !== undefined) out.push([c, t.name] as const);
  }
  return out.sort(([, a], [, b]) => compareTokenPaths(a, b));
};

/** Resolve an emitted slot (a tone name or a named role) to its declared token. */
const resolveSlot = (manifest: ThemeManifest, slot: string): ManifestToken | undefined => {
  const tone = toneOfString(slot);
  return tone !== undefined ? resolveRole(tone, manifest) : resolveNamedRole(slot, manifest);
};

/**
 * Per-node manifest-aware flags for one observation. Empty for untoned nodes (the
 * Custom/SVG exemption). Order is deterministic: resolution, palette, contrast.
 */
export const perNodeFlags = (manifest: ThemeManifest, obs: StyleObservation): StyleFlag[] => {
  if (obs.emittedTone === undefined) return [];
  const slot = obs.emittedTone;
  const resolved = resolveSlot(manifest, slot);
  const out: StyleFlag[] = [];

  if (resolved === undefined) {
    // TokenResolutionFailed — the emitted slot binds to no token.
    out.push({ kind: 'TokenResolutionFailed', slot });
  } else {
    // OffPaletteColour — the token resolved, but the rendered surface isn't in
    // the palette. Suppressed when resolution already failed.
    const onPalette = paletteRgba(manifest).some(([c]) => sameRgb(c, obs.effectiveBackground));
    if (!onPalette)
      out.push({ kind: 'OffPaletteColour', value: rgbString(obs.effectiveBackground) });
  }

  // ContrastBelowDeclaredFloor — a per-role floor (matched to the emitted slot
  // name) stricter than the manifest-free AA default the node already passed.
  for (const inv of manifest.invariants) {
    if (
      inv.kind.kind === 'ContrastFloor' &&
      inv.kind.role === slot &&
      obs.contrastRatio < inv.kind.minRatio
    ) {
      out.push({
        kind: 'ContrastBelowDeclaredFloor',
        role: inv.kind.role,
        ratio: obs.contrastRatio,
        floor: inv.kind.minRatio,
      });
    }
  }

  return out;
};

/**
 * Tree-level area-weighted usage-budget verification. `nodes` pairs each
 * observation with its rendered area (px²) — the caller joins StyleObservation
 * with the layout observer's width × height per NodeId. Each node's area is
 * attributed to the ONE manifest token its effectiveBackground matches — the
 * first in canonical token-path order (`compareTokenPaths`), so a fill matching
 * two same-valued tokens is attributed to the path-first one, never to whichever
 * the manifest declared first; per-token area share is compared to the
 * UsageBudget target ± tolerance. Empty when no area is available (graceful
 * degradation). Deterministic.
 */
export const verifyUsageBudgets = (
  manifest: ThemeManifest,
  nodes: ReadonlyArray<readonly [StyleObservation, number]>,
): StyleFlag[] => {
  const totalArea = nodes.reduce((sum, [, area]) => sum + area, 0);
  if (totalArea <= 0) return [];

  const palette = paletteRgba(manifest);
  const areaByToken = new Map<string, number>();
  for (const [obs, area] of nodes) {
    const hit = palette.find(([c]) => sameRgb(c, obs.effectiveBackground));
    if (hit !== undefined) areaByToken.set(hit[1], (areaByToken.get(hit[1]) ?? 0) + area);
  }

  const out: StyleFlag[] = [];
  for (const inv of manifest.invariants) {
    if (inv.kind.kind !== 'UsageBudget') continue;
    const { token, targetPct, tolerancePct } = inv.kind;
    const tokenArea = areaByToken.get(token) ?? 0;
    const observedPct = (100 * tokenArea) / totalArea;
    if (Math.abs(observedPct - targetPct) > tolerancePct) {
      out.push({ kind: 'UsageBudgetExceeded', token, declaredPct: targetPct, observedPct });
    }
  }
  return out;
};
