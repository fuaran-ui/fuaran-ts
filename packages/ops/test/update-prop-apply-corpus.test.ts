// ============================================================================
//  UpdateProp through the decoder's field rules — the shared
//  `apply/update-prop-apply.json` family (Phase 1925).
//
//  An UpdateProp value is read by the field's own decode rule: a typed integer
//  through the slot rule (WIRE_FORMAT 7.1), a Skeleton row count through the
//  21.9 bound as well, and a field set to its declared default is omitted from
//  the applied tree (3.6). Each vector's tree and op are decoded by this host's
//  own decoder and applied; a `reject` vector requires the named refusal code,
//  an `accept` vector requires the applied tree to re-encode to `expected.tree`
//  byte for byte.
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

interface UpdatePropVector {
  readonly id: string;
  readonly case: string;
  readonly input: { readonly tree: string; readonly op: string };
  readonly expected: { readonly verdict: string; readonly code?: string; readonly tree?: string };
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

describe('updatePropApply vectors (shared corpus apply/ family)', () => {
  if (!existsSync(manifestPath)) {
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
  const family = manifest.families.find((f) => f.id === 'updatePropApply');

  it('the corpus declares the updatePropApply family and holds the declared vector count', () => {
    expect(family, 'apply/manifest.json declares no updatePropApply family').toBeDefined();
    const file = readJson<{ readonly vectors: readonly UpdatePropVector[] }>(
      join(applyRoot, family!.file),
    );
    expect(file.vectors.length).toBe(family!.vectors);
  });

  if (family === undefined) return;
  const file = readJson<{ readonly vectors: readonly UpdatePropVector[] }>(
    join(applyRoot, family.file),
  );

  for (const v of file.vectors) {
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
          if (r.ok) expect(encodeNode(r.value.newTree)).toBe(v.expected.tree);
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
