// ============================================================================
//  Deterministic GFM markdown renderer — cross-host conformance gate (Phase 292).
//
//  Loads the workspace-root corpus wire-format-fixtures/markdown/corpus.json and
//  asserts the TS renderer (`toHtml`) reproduces every `source → html` pair
//  byte-for-byte. The F# reference renderer emits the corpus; this is Leg B of
//  the §11.1-style cross-host gate (`TS == corpus`), which together with the F#
//  and Python legs proves `F# == TS == Py`. Replaces the old npm `marked` path.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import {
  allowOrigin,
  denyNonLocalEgress,
  permissiveEgress,
  type EgressPolicy,
} from '../src/egress.js';
import { toHtml, toHtmlWithEgress } from '../src/markdown.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/renderer/test → workspace-root/wire-format-fixtures/markdown/corpus.json
const corpusPath = join(
  here,
  '..',
  '..',
  '..',
  '..',
  'wire-format-fixtures',
  'markdown',
  'corpus.json',
);

interface Fixture {
  id: string;
  description: string;
  source: string;
  html: string;
  /** WIRE_FORMAT §14.1 — the destination policy the render is performed under. */
  policy?: string;
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { fixtures: Fixture[] };

/**
 * The named policies of WIRE_FORMAT §14.1, CONSTRUCTED here. The corpus never
 * carries a policy as data, because a policy that can arrive as data is one a
 * hostile emission can widen.
 *
 * An UNKNOWN name throws rather than falling back: a silent fallback to the
 * permissive policy would turn a fixture this host cannot evaluate into one it
 * appears to pass.
 */
const policyByName = (name: string | undefined): EgressPolicy => {
  switch (name ?? 'permissive') {
    case 'permissive':
      return permissiveEgress;
    case 'denyNonLocal':
      return denyNonLocalEgress;
    case 'declaredExample':
      return allowOrigin(
        { match: 'suffix', host: 'docs.example' },
        ['hyperlink'],
        allowOrigin({ match: 'exact', host: 'cdn.example' }, ['media'], denyNonLocalEgress),
      );
    default:
      throw new Error(`markdown corpus names a policy this host does not construct: '${name}'`);
  }
};

describe('deterministic GFM markdown renderer — corpus parity', () => {
  it('corpus is non-empty', () => {
    expect(corpus.fixtures.length).toBeGreaterThan(0);
  });

  it('the corpus exercises the destination policy', () => {
    // A guard on the CORPUS rather than the renderer: without a policied fixture
    // every assertion below runs on the permissive path, and this gate would be
    // green on a host that never implemented §14.1 at all.
    expect(
      corpus.fixtures.filter((f) => f.policy !== undefined && f.policy !== 'permissive').length,
    ).toBeGreaterThan(0);
  });

  it.each(corpus.fixtures.map((f) => [f.id, f] as const))(
    '%s — TS render is byte-identical to the corpus',
    (_id, f) => {
      expect(toHtmlWithEgress(policyByName(f.policy), f.source)).toBe(f.html);
    },
  );

  it.each(
    corpus.fixtures
      .filter((f) => (f.policy ?? 'permissive') === 'permissive')
      .map((f) => [f.id, f] as const),
  )('%s — the pure toHtml IS the permissive case', (_id, f) => {
    expect(toHtml(f.source)).toBe(f.html);
  });
});
