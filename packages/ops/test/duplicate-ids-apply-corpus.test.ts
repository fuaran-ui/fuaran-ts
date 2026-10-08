// ============================================================================
//  Apply-time node-id uniqueness — the shared `apply/duplicate-ids-apply.json`
//  family (Phase 2172).
//
//  Certifies this host's apply engine against the vectors every op-applying
//  host certifies: an op that leaves an id it installed held by more than one
//  node is refused with `DuplicateNodeId`; restating an id the op removes in the
//  same act, and a duplicate the op did not install, apply. Each vector's tree
//  and op are decoded by this host's own decoder.
//
//  Read from the corpus checkout beside this repo, or from
//  `FUARAN_WIRE_FIXTURES`, exactly as `limits-apply-corpus.test.ts`.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { apply, decodeNode, decodeOp } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const declaredRoot = process.env['FUARAN_WIRE_FIXTURES'];
const corpusRoot = declaredRoot || join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const applyRoot = join(corpusRoot, 'apply');
const manifestPath = join(applyRoot, 'manifest.json');

interface ApplyFamily {
  readonly id: string;
  readonly file: string;
  readonly vectors: number;
}

interface DuplicateIdsVector {
  readonly id: string;
  readonly case: string;
  readonly input: { readonly tree: string; readonly op: string };
  readonly expected: { readonly verdict: string; readonly code?: string };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('duplicateIdsApply vectors (shared corpus apply/ family)', () => {
  if (!existsSync(manifestPath)) {
    // A DECLARED root that holds no apply manifest is a misconfiguration and
    // fails; an undeclared, absent sibling is a standalone clone and skips.
    if (declaredRoot) {
      it('FUARAN_WIRE_FIXTURES names a corpus carrying apply/manifest.json', () => {
        expect(existsSync(manifestPath), `${manifestPath} is missing`).toBe(true);
      });
    } else {
      it.skip('apply family not present: no wire-format-fixtures checkout beside this repo', () => {});
    }
    return;
  }

  const manifest = readJson<{ readonly families: readonly ApplyFamily[] }>(manifestPath);
  const family = manifest.families.find((f) => f.id === 'duplicateIdsApply');

  it('the corpus declares the duplicateIdsApply family and holds the declared vector count', () => {
    expect(family, 'apply/manifest.json declares no duplicateIdsApply family').toBeDefined();
    const file = readJson<{ readonly vectors: readonly DuplicateIdsVector[] }>(
      join(applyRoot, family!.file),
    );
    expect(file.vectors.length).toBe(family!.vectors);
  });

  if (family === undefined) return;
  const vectors = readJson<{ readonly vectors: readonly DuplicateIdsVector[] }>(
    join(applyRoot, family.file),
  ).vectors;

  for (const v of vectors) {
    it(`${v.id} (${v.case}) -> ${v.expected.verdict}`, () => {
      const tree = decodeNode(v.input.tree);
      expect(tree.ok, 'the tree did not decode').toBe(true);
      const op = decodeOp(v.input.op);
      expect(op.ok, 'the op did not decode').toBe(true);
      if (!tree.ok || !op.ok) return;

      const r = apply(tree.value, op.value);
      switch (v.expected.verdict) {
        case 'accept':
          expect(r.ok, r.ok ? '' : `expected accept, refused: ${r.error.message}`).toBe(true);
          break;
        case 'reject':
          expect(r.ok, `expected a ${v.expected.code} refusal, the op applied`).toBe(false);
          if (!r.ok) expect(r.error.code).toBe(v.expected.code);
          break;
        default:
          throw new Error(`unknown verdict '${v.expected.verdict}' on vector ${v.id}`);
      }
    });
  }
});
