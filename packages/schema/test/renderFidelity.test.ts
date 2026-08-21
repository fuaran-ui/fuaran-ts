// ============================================================================
//  The TypeScript host reads the GENERATED render-fidelity manifest
//  (WIRE_FORMAT.md §13) — it never carries a copy of it.
//
//  That is what these tests are for. It would be trivial to hard-code the tier
//  postures here and assert against them, and the suite would be green forever
//  while drifting from the F# declaration the artefact is generated from. So
//  every assertion below reads the corpus artefact, and the vocabulary leg
//  measures this host's own `NODE_KIND_NAMES` against it in BOTH directions —
//  the same shape as the Phase 548 kind-set attestation.
//
//  Skipped when the corpus checkout is absent (a standalone fuaran-ts clone),
//  mirroring the other corpus-dependent suites.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  NODE_KIND_NAMES,
  deliveredTier,
  fidelityBadge,
  fidelityOf,
  parseRenderFidelityManifest,
  type RenderFidelityManifest,
} from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/schema/test → workspace-root/wire-format-fixtures/render-fidelity.json
const ARTIFACT = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'render-fidelity.json');

const present = existsSync(ARTIFACT);
const load = (): RenderFidelityManifest =>
  parseRenderFidelityManifest(JSON.parse(readFileSync(ARTIFACT, 'utf8')));

describe.skipIf(!present)('render-fidelity manifest (generated artefact)', () => {
  it('parses, and pins the v1 wire-format identity', () => {
    const manifest = load();
    expect(manifest.version).toBe(1);
    expect(manifest.$id).toBe('https://fuaran.dev/wire-format/v1/render-fidelity.json');
    expect(manifest.tiers.map((t) => t.tier)).toEqual(['source', 'fallback', 'rich']);
    expect(manifest.kinds.length).toBeGreaterThan(0);
  });

  it('declares a posture for every kind this host emits, and no kind it does not', () => {
    const manifest = load();
    const declared = new Set(manifest.kinds.map((r) => r.kind));
    const host = new Set(NODE_KIND_NAMES);

    const missing = [...host].filter((k) => !declared.has(k)).sort();
    const extra = [...declared].filter((k) => !host.has(k)).sort();

    expect(missing, 'kinds this host emits with no render-fidelity row').toEqual([]);
    expect(extra, 'fidelity rows for kinds this host does not emit').toEqual([]);
  });

  it('derives a three-segment badge for every kind, hard-coding nothing', () => {
    const manifest = load();
    for (const row of manifest.kinds) {
      const badge = fidelityBadge(row);
      expect(badge.map((s) => s.tier)).toEqual(['source', 'fallback', 'rich']);
      for (const segment of badge) expect(segment.detail.length).toBeGreaterThan(0);
      expect(badge[2]!.present).toBe(row.rich.class !== 'none');
    }
  });

  it('carries the four shipped fidelity contracts', () => {
    const manifest = load();
    for (const kind of ['Modal', 'Toast', 'ScrollArea', 'CodeBlock', 'Markdown', 'Math']) {
      const row = fidelityOf(manifest, kind);
      expect(row, `${kind} has no fidelity row`).toBeDefined();
      expect(row!.sensitive, `${kind} carries a shipped fidelity contract`).toBe(true);
      expect(row!.fixtures.length, `${kind} names no pinning fixture`).toBeGreaterThan(0);
    }

    // The rich tiers that change DOM after hydration.
    for (const kind of ['CodeBlock', 'Markdown', 'Math'])
      expect(fidelityOf(manifest, kind)!.rich.class).toBe('clientOnly');

    // The overlay contract's enhancement is behaviour, never DOM — a portal
    // would be a DOM change and is refused by the contract.
    expect(fidelityOf(manifest, 'Modal')!.rich.class).toBe('behavioural');

    // These two declare no client-only tier at all.
    for (const kind of ['ScrollArea', 'Toast'])
      expect(fidelityOf(manifest, kind)!.rich.class).toBe('none');
  });

  it('every named fixture resolves in the corpus', () => {
    const manifest = load();
    const corpusRoot = dirname(ARTIFACT);
    const dangling = manifest.kinds.flatMap((r) =>
      r.fixtures.filter((f) => !existsSync(join(corpusRoot, f))).map((f) => `${r.kind}: ${f}`),
    );
    expect(dangling).toEqual([]);
  });

  it('a scripts-disabled target always delivers the fallback tier', () => {
    const manifest = load();
    for (const row of manifest.kinds) {
      expect(deliveredTier(row, 'noScript')).toBe('fallback');
      expect(deliveredTier(row, 'hydrated')).toBe(
        row.rich.class === 'clientOnly' ? 'rich' : 'fallback',
      );
    }
  });

  it('an unknown kind is reported as unknown, never as single-tier', () => {
    // The §15.3 tolerance path preserves kinds this host does not model. A
    // badge surface must say so rather than assuming the fallback is the whole
    // render — assuming would print a confident, wrong badge.
    expect(fidelityOf(load(), 'KindFromANewerProfile')).toBeUndefined();
  });
});
