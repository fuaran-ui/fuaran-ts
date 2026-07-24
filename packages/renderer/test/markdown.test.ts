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

import { toHtml } from '../src/markdown.js';

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
}

const corpus = JSON.parse(readFileSync(corpusPath, 'utf8')) as { fixtures: Fixture[] };

describe('deterministic GFM markdown renderer — corpus parity', () => {
  it('corpus is non-empty', () => {
    expect(corpus.fixtures.length).toBeGreaterThan(0);
  });

  it.each(corpus.fixtures.map((f) => [f.id, f] as const))(
    '%s — TS render is byte-identical to the corpus',
    (_id, f) => {
      expect(toHtml(f.source)).toBe(f.html);
    },
  );
});
