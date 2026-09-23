// ============================================================================
//  style-observer corpus family — certified host-side (Phase 1840).
//
//  The shared wire-format corpus carries a `style-observer` family (Phase 1752):
//  resolved-style FACTS in, encoded StyleFlag / StyleObservation bytes out. No
//  decode / re-encode / schema leg in `@fuaran-ui/conformance` can run it — the
//  derivation lives in THIS package — so, like the teleport family in
//  `@fuaran-ui/op-stream`, it is certified here, against the same files every
//  other host certifies against. Every vector runs; a tier outside this host's
//  vocabulary FAILS naming the vector id, never skips.
//
//  The two `budget-same-valued-tokens-*` vectors pin the Phase 1727 palette
//  attribution ruling: the expected budget flags are the attribution the
//  reference host recorded when it emitted the vector, and this suite asserts
//  against those bytes — never against a hand re-derivation.
//
//  The corpus is resolved at `../wire-format-fixtures` beside the repo root (the
//  CI lane checks it out there and asserts it is present); a standalone clone
//  without it skips, exactly as the teleport family does.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeManifest, type ThemeManifest } from '@fuaran-ui/theme-manifest';
import { describe, expect, it } from 'vitest';

import {
  encodeStyleFlag,
  encodeStyleObservation,
  perNodeFlags,
  toStyleObservation,
  verifyUsageBudgets,
  type FontRole,
  type Rgba,
  type StyleInput,
  type StyleObservation,
  type StyleObserverOptions,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/style-observer/test → the directory holding the fuaran-ts checkout.
const corpusRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const manifestPath = join(corpusRoot, 'manifest.json');
const corpusPresent = existsSync(manifestPath);

interface ManifestRow {
  readonly id: string;
  readonly kind: string;
  readonly tier?: string;
  readonly inputFile: string;
}

interface WireObservation {
  readonly nodeId: string;
  readonly foreground: Rgba;
  readonly effectiveBackground: Rgba;
  readonly fontRole: FontRole;
  readonly emittedTone: string | null;
  readonly contrastRatio: number;
}

interface Vector {
  readonly id: string;
  readonly tier: string;
  // observation
  readonly options?: {
    readonly contrastAaThreshold: number;
    readonly invisibleTextThreshold: number;
    readonly accentIndistinctThreshold: number;
  };
  readonly nodeId?: string;
  readonly input?: {
    readonly foreground: Rgba;
    readonly backgroundLayers: readonly Rgba[];
    readonly fontFamily: string | null;
    readonly emittedTone: string | null;
  };
  readonly expectedFlags?: readonly string[];
  readonly expectedObservation?: string;
  // per-node-manifest + usage-budget
  readonly manifest?: string;
  readonly observation?: WireObservation;
  readonly expectedManifestFlags?: readonly string[];
  readonly nodeAreas?: ReadonlyArray<{
    readonly observation: WireObservation;
    readonly area: number;
  }>;
  readonly expectedBudgetFlags?: readonly string[];
}

const rows = (): ManifestRow[] => {
  if (!corpusPresent) return [];
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { fixtures: ManifestRow[] };
  return manifest.fixtures.filter((f) => f.kind === 'style-observer');
};

const readVector = (row: ManifestRow): Vector =>
  JSON.parse(readFileSync(join(corpusRoot, row.inputFile), 'utf8')) as Vector;

const observationOf = (w: WireObservation): StyleObservation => ({
  nodeId: w.nodeId,
  foreground: w.foreground,
  effectiveBackground: w.effectiveBackground,
  fontRole: w.fontRole,
  emittedTone: w.emittedTone ?? undefined,
  contrastRatio: w.contrastRatio,
  flags: [],
});

// The manifest is a JSON STRING, fed to this host's own theme-manifest decoder
// verbatim so nothing re-serialises it (and document order survives decode —
// which is what makes the tie vectors discriminating here).
const manifestOf = (v: Vector): ThemeManifest => {
  const decoded = decodeManifest(v.manifest ?? '');
  if (!decoded.ok) throw new Error(`${v.id}: manifest did not decode: ${decoded.error}`);
  return decoded.value;
};

const TIERS = ['observation', 'per-node-manifest', 'usage-budget'] as const;

const all = rows();
const tieIds = [
  'style-observer-budget-same-valued-tokens-attribute-path-first',
  'style-observer-budget-same-valued-tokens-order-is-segment-wise',
];

describe.skipIf(!corpusPresent)('style-observer corpus family', () => {
  it('the corpus carries the family, including both palette-attribution tie vectors', () => {
    expect(all.length).toBeGreaterThan(0);
    for (const id of tieIds) expect(all.map((r) => r.id)).toContain(id);
  });

  it('every vector names a tier this host implements', () => {
    const outside = all
      .map((r) => ({ id: r.id, tier: readVector(r).tier }))
      .filter((v) => !(TIERS as readonly string[]).includes(v.tier))
      .map((v) => `${v.id} (tier ${v.tier})`);
    expect(outside).toEqual([]);
  });
});

describe.skipIf(!corpusPresent)('style-observer corpus vectors', () => {
  for (const row of all) {
    it(`${row.id}`, () => {
      const v = readVector(row);
      switch (v.tier) {
        case 'observation': {
          const o = v.options!;
          const options: StyleObserverOptions = {
            debounceMs: 0,
            contrastAAThreshold: o.contrastAaThreshold,
            invisibleTextThreshold: o.invisibleTextThreshold,
            accentIndistinctThreshold: o.accentIndistinctThreshold,
            emitOnFlagChangeOnly: true,
          };
          const i = v.input!;
          const input: StyleInput = {
            foreground: i.foreground,
            backgroundLayers: i.backgroundLayers,
            fontFamily: i.fontFamily ?? undefined,
            emittedTone: i.emittedTone ?? undefined,
          };
          const obs = toStyleObservation(options, v.nodeId!, input);
          expect(obs.flags.map(encodeStyleFlag)).toEqual(v.expectedFlags);
          expect(encodeStyleObservation(obs)).toBe(v.expectedObservation);
          break;
        }
        case 'per-node-manifest': {
          const flags = perNodeFlags(manifestOf(v), observationOf(v.observation!));
          expect(flags.map(encodeStyleFlag)).toEqual(v.expectedManifestFlags);
          break;
        }
        case 'usage-budget': {
          const nodes = v.nodeAreas!.map((n) => [observationOf(n.observation), n.area] as const);
          const flags = verifyUsageBudgets(manifestOf(v), nodes);
          expect(flags.map(encodeStyleFlag)).toEqual(v.expectedBudgetFlags);
          break;
        }
        default:
          throw new Error(`${row.id}: tier '${v.tier}' is outside this host's vocabulary`);
      }
    });
  }
});
