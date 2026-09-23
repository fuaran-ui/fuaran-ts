// ============================================================================
//  The runtime section of the escape-hatch report (Phase 1842) — the producer
//  over its inputs, and the in-page surface that reports it.
//
//  Every branch is reachable from arguments: the producer reads no ambient
//  state, so "undecided" is pinned as carefully as "open" and "closed". That is
//  the point of the three-valued vocabulary — a report that rendered "was not
//  handed the input" as "closed" would be the one failure it exists to prevent.
// ============================================================================

import { afterEach, describe, expect, it } from 'vitest';

import { fuaran } from '@fuaran-ui/ui';

import {
  buildDebugGlobal,
  createCustomRendererRegistry,
  CUSTOM_HASH_FLOOR_PERMISSIVE,
  CUSTOM_RENDERER_REGISTERED,
  DEVELOPMENT_SURFACE_LIVE,
  observeRuntimeHatches,
  registerDebugGlobal,
  customHashFloorOf,
} from '../src/index.js';

const tree = fuaran.stack<unknown>({ id: 'root', children: [] });

const byPredicate = (doc: ReturnType<typeof observeRuntimeHatches>) =>
  Object.fromEntries(doc.findings.map((f) => [f.predicate, f] as const));

describe('observeRuntimeHatches — the document', () => {
  it('is the hatchSection document: kind, version, section, findings — in that order', () => {
    const doc = observeRuntimeHatches({ developmentSurfaceLive: false });
    expect(Object.keys(doc)).toEqual(['kind', 'version', 'section', 'findings']);
    expect(doc.kind).toBe('hatchSection');
    expect(doc.version).toBe(1);
    expect(doc.section).toBe('runtime');
    expect(doc.findings.map((f) => [f.predicate, f.hatch])).toEqual([
      [CUSTOM_RENDERER_REGISTERED, 2],
      [CUSTOM_HASH_FLOOR_PERMISSIVE, 2],
      [DEVELOPMENT_SURFACE_LIVE, 12],
    ]);
    for (const f of doc.findings) {
      expect(Object.keys(f)).toEqual(['predicate', 'hatch', 'state', 'account']);
      // `account` is populated on every state (§7.8 rule 2).
      expect(f.account.length).toBeGreaterThan(0);
    }
  });

  it('reports an input it was not handed as UNDECIDED — never closed, never omitted', () => {
    const doc = byPredicate(observeRuntimeHatches({ developmentSurfaceLive: false }));
    expect(doc[CUSTOM_RENDERER_REGISTERED]!.state).toBe('undecided');
    expect(doc[CUSTOM_HASH_FLOOR_PERMISSIVE]!.state).toBe('undecided');
    expect(doc[CUSTOM_RENDERER_REGISTERED]!.account).toContain(
      'not a claim that none is registered',
    );
  });
});

describe('custom-renderer-registered', () => {
  it('is CLOSED when the host renders with no registry at all — a positive statement', () => {
    const doc = byPredicate(
      observeRuntimeHatches({ customRenderers: null, developmentSurfaceLive: false }),
    );
    expect(doc[CUSTOM_RENDERER_REGISTERED]!.state).toBe('closed');
  });

  it('is CLOSED over an empty registry that was read', () => {
    const doc = byPredicate(
      observeRuntimeHatches({
        customRenderers: createCustomRendererRegistry(),
        developmentSurfaceLive: false,
      }),
    );
    expect(doc[CUSTOM_RENDERER_REGISTERED]!.state).toBe('closed');
  });

  it('is OPEN and NAMES every registration, deterministically ordered', () => {
    const registry = createCustomRendererRegistry()
      .register('maps', 'pin', () => null)
      .register('charts', 'sparkline', () => null, {
        algorithm: 'sha256',
        hash: 'ab',
        strictness: 'Enforced',
      });
    const finding = byPredicate(
      observeRuntimeHatches({ customRenderers: registry, developmentSurfaceLive: false }),
    )[CUSTOM_RENDERER_REGISTERED]!;
    expect(finding.state).toBe('open');
    expect(finding.account).toBe(
      '2 custom renderer(s) registered: charts/sparkline (content hash registered); maps/pin (no content hash)',
    );
  });
});

describe('custom-hash-floor-permissive', () => {
  it('is OPEN only under the permissive floor, and says it was declared BY NAME', () => {
    const finding = byPredicate(
      observeRuntimeHatches({ customHashFloor: 'AdvisoryWarning', developmentSurfaceLive: false }),
    )[CUSTOM_HASH_FLOOR_PERMISSIVE]!;
    expect(finding.state).toBe('open');
    expect(finding.account).toBe(
      "this renderer's content-hash floor is 'advisory-warning' — a host declared the permissive " +
        "posture BY NAME. A guest whose declared hash disagrees with the registered renderer's warns " +
        'and renders anyway, so a declared hash mediates nothing here.',
    );
  });

  it('is CLOSED under the shipped default, and says an unhashed guest still renders', () => {
    // Phase 1856: the default is `Enforced`, so this is what an unconfigured
    // renderer reports. The sentence is the reference host's, with "this
    // renderer's" for "the process" — the one fact that differs here.
    const finding = byPredicate(
      observeRuntimeHatches({
        customHashFloor: customHashFloorOf({}),
        developmentSurfaceLive: false,
      }),
    )[CUSTOM_HASH_FLOOR_PERMISSIVE]!;
    expect(finding.state).toBe('closed');
    expect(finding.account).toBe(
      "this renderer's content-hash floor is 'enforced': a guest whose declared hash disagrees with " +
        "the registered renderer's is REFUSED rather than rendered. A guest declaring no hash at all " +
        'still renders — the common legitimate case.',
    );
  });

  it('is CLOSED under StrictReplay, which refuses an unhashed guest too', () => {
    const finding = byPredicate(
      observeRuntimeHatches({ customHashFloor: 'StrictReplay', developmentSurfaceLive: false }),
    )[CUSTOM_HASH_FLOOR_PERMISSIVE]!;
    expect(finding.state).toBe('closed');
    expect(finding.account).toContain("'strict-replay'");
    expect(finding.account).toContain('a guest declaring no hash at all is refused too.');
  });
});

describe('__fuaran.hatches() — the in-page surface', () => {
  let unregister: (() => void) | undefined;
  afterEach(() => {
    unregister?.();
    unregister = undefined;
  });

  it('reports the development surface OPEN only while it is the surface on the page', () => {
    const surface = buildDebugGlobal(
      tree,
      {},
      { customRenderers: null, customHashFloor: 'Enforced' },
    );
    const live = () => byPredicate(surface.hatches!())[DEVELOPMENT_SURFACE_LIVE]!.state;

    expect(live()).toBe('closed');
    unregister = registerDebugGlobal(surface);
    expect(live()).toBe('open');
    unregister();
    unregister = undefined;
    expect(live()).toBe('closed');
  });

  it('is observed per call: a registration made after the surface was built is reported', () => {
    const registry = createCustomRendererRegistry();
    const surface = buildDebugGlobal(tree, {}, { customRenderers: registry });
    const state = () => byPredicate(surface.hatches!())[CUSTOM_RENDERER_REGISTERED]!.state;
    expect(state()).toBe('closed');
    registry.register('charts', 'sparkline', () => null);
    expect(state()).toBe('open');
  });
});
