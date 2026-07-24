// ============================================================================
//  Manifest-aware flag derivation (Phase 146) — mirrors the F#
//  Fuaran.UI.StyleObserver.Tests.ManifestFlagTests:
//   - UsageBudgetExceeded (tree-level area weighting) + within-tolerance + empty
//   - ContrastBelowDeclaredFloor against a per-role floor AA would pass
//   - TokenResolutionFailed for an unbound tone
//   - OffPaletteColour + the Custom-subtree (untoned) exemption
//   - graceful degradation: no manifest ⇒ only the manifest-free flags
//   - the manifest wired into the in-memory observer flows flags through observe
// ============================================================================

import { describe, expect, it } from 'vitest';

import { invariant, type ThemeManifest } from '@fuaran-ui/theme-manifest';

import {
  InMemoryStyleObserver,
  black,
  perNodeFlags,
  rgb,
  verifyUsageBudgets,
  white,
  type StyleObservation,
} from '../src/index.js';

const brand = rgb(59, 91, 219); // #3b5bdb

const manifest: ThemeManifest = {
  meta: { name: '', version: '' },
  tokens: [
    { name: 'color.brand.base', type: 'color', value: '#3b5bdb' },
    { name: 'color.surface', type: 'color', value: '#ffffff' },
  ],
  roles: [
    { role: { kind: 'Tone', tone: 'Brand' }, tokenName: 'color.brand.base' },
    { role: { kind: 'Tone', tone: 'Default' }, tokenName: 'color.surface' },
  ],
  invariants: [
    invariant({ kind: 'UsageBudget', token: 'color.brand.base', targetPct: 9, tolerancePct: 3 }),
    invariant({ kind: 'UsageBudget', token: 'color.surface', targetPct: 60, tolerancePct: 10 }),
    invariant({ kind: 'ContrastFloor', role: 'Brand', minRatio: 7 }),
  ],
};

const tonedObs = (
  nodeId: string,
  tone: string | undefined,
  bg: ReturnType<typeof rgb>,
  contrastRatio: number,
): StyleObservation => ({
  nodeId,
  foreground: black,
  effectiveBackground: bg,
  fontRole: 'SansSerif',
  emittedTone: tone,
  contrastRatio,
  flags: [],
});

describe('verifyUsageBudgets (tree-level area weighting)', () => {
  it('fires when brand occupies 28% against a 9% ± 3% budget', () => {
    const nodes: Array<readonly [StyleObservation, number]> = [
      [tonedObs('b1', 'Brand', brand, 21), 180],
      [tonedObs('b2', 'Brand', brand, 21), 100],
      [tonedObs('s1', 'Default', white, 21), 720],
    ];
    const flags = verifyUsageBudgets(manifest, nodes);
    expect(flags).toContainEqual({
      kind: 'UsageBudgetExceeded',
      token: 'color.brand.base',
      declaredPct: 9,
      observedPct: 28,
    });
    expect(flags).toContainEqual({
      kind: 'UsageBudgetExceeded',
      token: 'color.surface',
      declaredPct: 60,
      observedPct: 72,
    });
  });

  it('fires nothing within tolerance', () => {
    const nodes: Array<readonly [StyleObservation, number]> = [
      [tonedObs('b1', 'Brand', brand, 21), 90],
      [tonedObs('s1', 'Default', white, 21), 610],
      [tonedObs('x', undefined, rgb(1, 2, 3), 21), 300],
    ];
    const budgetFlags = verifyUsageBudgets(manifest, nodes).filter(
      (f) => f.kind === 'UsageBudgetExceeded',
    );
    expect(budgetFlags).toEqual([]);
  });

  it('is deterministic and degrades gracefully with no area', () => {
    const nodes: Array<readonly [StyleObservation, number]> = [
      [tonedObs('b1', 'Brand', brand, 21), 280],
      [tonedObs('s1', 'Default', white, 21), 720],
    ];
    expect(verifyUsageBudgets(manifest, nodes)).toEqual(verifyUsageBudgets(manifest, nodes));
    expect(verifyUsageBudgets(manifest, [])).toEqual([]);
  });
});

describe('perNodeFlags', () => {
  it('fires ContrastBelowDeclaredFloor against a per-role floor AA would pass', () => {
    const flags = perNodeFlags(manifest, tonedObs('b1', 'Brand', brand, 5));
    expect(flags).toContainEqual({
      kind: 'ContrastBelowDeclaredFloor',
      role: 'Brand',
      ratio: 5,
      floor: 7,
    });
  });

  it('does not fire ContrastBelowDeclaredFloor when the floor is met', () => {
    const flags = perNodeFlags(manifest, tonedObs('b1', 'Brand', brand, 8));
    expect(flags.some((f) => f.kind === 'ContrastBelowDeclaredFloor')).toBe(false);
  });

  it('fires TokenResolutionFailed for an unbound tone', () => {
    const flags = perNodeFlags(manifest, tonedObs('c1', 'Critical', rgb(200, 0, 0), 21));
    expect(flags).toContainEqual({ kind: 'TokenResolutionFailed', slot: 'Critical' });
  });

  it('fires OffPaletteColour for a resolved toned fill that is off-palette', () => {
    const flags = perNodeFlags(manifest, tonedObs('b1', 'Brand', rgb(12, 200, 180), 21));
    expect(flags).toContainEqual({ kind: 'OffPaletteColour', value: 'rgb(12, 200, 180)' });
  });

  it('does not fire OffPaletteColour for an on-palette fill', () => {
    const flags = perNodeFlags(manifest, tonedObs('b1', 'Brand', brand, 21));
    expect(flags.some((f) => f.kind === 'OffPaletteColour')).toBe(false);
  });

  it('exempts an untoned node (Custom / domain-SVG) from every manifest check', () => {
    const flags = perNodeFlags(manifest, tonedObs('chart-series', undefined, rgb(255, 0, 128), 21));
    expect(flags).toEqual([]);
  });
});

describe('observer wiring', () => {
  it('no manifest ⇒ only the manifest-free flags fire (graceful degradation)', () => {
    const obs = new InMemoryStyleObserver();
    obs.registerFixture('b1', {
      foreground: black,
      backgroundLayers: [rgb(12, 200, 180)],
      fontFamily: undefined,
      emittedTone: 'Critical',
    });
    const flags = obs.observe('b1')?.flags ?? [];
    expect(
      flags.some((f) =>
        [
          'TokenResolutionFailed',
          'OffPaletteColour',
          'UsageBudgetExceeded',
          'ContrastBelowDeclaredFloor',
        ].includes(f.kind),
      ),
    ).toBe(false);
  });

  it('manifest wired ⇒ per-node manifest flags flow through observe', () => {
    const obs = new InMemoryStyleObserver(undefined, manifest);
    obs.registerFixture('c1', {
      foreground: black,
      backgroundLayers: [rgb(200, 0, 0)],
      fontFamily: undefined,
      emittedTone: 'Critical',
    });
    const flags = obs.observe('c1')?.flags ?? [];
    expect(flags).toContainEqual({ kind: 'TokenResolutionFailed', slot: 'Critical' });
  });
});
