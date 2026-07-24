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

/** The manifest's colour palette parsed to Rgba + the declaring token name. */
const paletteRgba = (manifest: ThemeManifest): Array<readonly [Rgba, string]> => {
  const out: Array<readonly [Rgba, string]> = [];
  for (const t of manifest.tokens) {
    if (t.type !== 'color') continue;
    const c = tryParseHex(t.value);
    if (c !== undefined) out.push([c, t.name] as const);
  }
  return out;
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
 * attributed to the manifest token its effectiveBackground matches; per-token
 * area share is compared to the UsageBudget target ± tolerance. Empty when no
 * area is available (graceful degradation). Deterministic.
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
