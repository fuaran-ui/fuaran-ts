// ============================================================================
//  Style normalisation on apply — the shared `apply/style-normalise-apply.json`
//  family (Phase 2313).
//
//  The absent `style` slot and the all-default SemanticStyle record are one
//  value. This host holds that by construction: a node's `style` is always the
//  record, the decoder restores the default record when the slot is absent,
//  and the encoder omits the slot when the record is the default. So an
//  UpdateStyle (or a PatchStyle) whose result is the default record encodes
//  with no `style` member, exactly as the other hosts store the absent slot.
//  These vectors pin the RESULT bytes: each vector's tree and op are decoded by
//  this host's own decoder, applied, and the applied tree must re-encode to
//  `expected.tree` byte for byte.
//
//  The family is self-enumerated under `apply/` (the root manifest does not
//  index it), so it is read from the corpus checkout beside this repo, or from
//  `FUARAN_WIRE_FIXTURES`, exactly as the other apply-family legs here.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { apply, decodeNode, decodeOp, encodeNode } from '../src/index.js';

import { resolveCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const { root: corpusRoot, source } = resolveCorpusRoot();
const declaredRoot = source === 'env';
const applyRoot = join(corpusRoot, 'apply');
const manifestPath = join(applyRoot, 'manifest.json');

interface ApplyFamily {
  readonly id: string;
  readonly file: string;
  readonly vectors: number;
}

interface StyleVector {
  readonly id: string;
  readonly case: string;
  readonly input: { readonly tree: string; readonly op: string };
  readonly expected: { readonly verdict: string; readonly tree: string };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('styleNormaliseApply vectors (shared corpus apply/ family)', () => {
  if (!existsSync(manifestPath)) {
    // A DECLARED root that holds no apply manifest is a misconfiguration and
    // fails; an undeclared, absent sibling is a standalone clone and skips, as
    // every other corpus leg in this repo does.
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
  const family = manifest.families.find((f) => f.id === 'styleNormaliseApply');

  it('the corpus declares the styleNormaliseApply family and holds the declared vector count', () => {
    expect(family, 'apply/manifest.json declares no styleNormaliseApply family').toBeDefined();
    const file = readJson<{ readonly vectors: readonly StyleVector[] }>(
      join(applyRoot, family!.file),
    );
    expect(file.vectors.length).toBe(family!.vectors);
  });

  if (family === undefined) return;
  const file = readJson<{ readonly vectors: readonly StyleVector[] }>(join(applyRoot, family.file));

  for (const v of file.vectors) {
    it(`${v.id} (${v.case}) -> the applied tree's canonical bytes`, () => {
      expect(v.expected.verdict).toBe('accept');
      const tree = decodeNode(v.input.tree);
      expect(tree.ok, 'the tree did not decode').toBe(true);
      const op = decodeOp(v.input.op);
      expect(op.ok, 'the op did not decode').toBe(true);
      if (!tree.ok || !op.ok) return;

      const r = apply(tree.value, op.value);
      expect(r.ok, r.ok ? '' : `expected accept, refused: ${r.error.message}`).toBe(true);
      if (!r.ok) return;
      expect(encodeNode(r.value.newTree)).toBe(v.expected.tree);
    });
  }
});
