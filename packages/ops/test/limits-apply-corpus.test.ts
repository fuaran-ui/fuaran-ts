// ============================================================================
//  Apply-time tree limits — the shared `apply/limits-apply.json` family.
//
//  Certifies this host's apply engine against the corpus vectors the other
//  op-applying hosts certify: an op that can grow the tree is checked on its
//  RESULT, and one that takes the tree past `MAX_NODE_DEPTH` / `MAX_NODES` is
//  refused with `LimitExceeded`; the same op landing exactly at the limit
//  applies. Each vector's tree and op are decoded by this host's own decoder.
//
//  The family is self-enumerated under `apply/` (the root manifest does not
//  index it), so it is read from the corpus checkout beside this repo, or from
//  `FUARAN_WIRE_FIXTURES`, exactly as the other non-bundled corpus legs here.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MAX_NODES, MAX_NODE_DEPTH } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { apply, decodeNode, decodeOp } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures, unless
// FUARAN_WIRE_FIXTURES names the corpus.
const declaredRoot = process.env['FUARAN_WIRE_FIXTURES'];
const corpusRoot = declaredRoot || join(here, '..', '..', '..', '..', 'wire-format-fixtures');
const applyRoot = join(corpusRoot, 'apply');
const manifestPath = join(applyRoot, 'manifest.json');

interface ApplyFamily {
  readonly id: string;
  readonly file: string;
  readonly vectors: number;
}

interface LimitsVector {
  readonly id: string;
  readonly case: string;
  readonly input: { readonly tree: string; readonly op: string };
  readonly expected: { readonly verdict: string; readonly code?: string };
}

interface LimitsFile {
  readonly family: string;
  readonly limits: { readonly maxDepth: number; readonly maxNodes: number };
  readonly vectors: readonly LimitsVector[];
}

const readJson = <T>(path: string): T => JSON.parse(readFileSync(path, 'utf8')) as T;

const corpusPresent = existsSync(manifestPath);

describe('limitsApply vectors (shared corpus apply/ family)', () => {
  if (!corpusPresent) {
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
  const family = manifest.families.find((f) => f.id === 'limitsApply');

  it('the corpus declares the limitsApply family and holds the declared vector count', () => {
    expect(family, 'apply/manifest.json declares no limitsApply family').toBeDefined();
    const file = readJson<LimitsFile>(join(applyRoot, family!.file));
    expect(file.vectors.length).toBe(family!.vectors);
  });

  if (family === undefined) return;
  const file = readJson<LimitsFile>(join(applyRoot, family.file));

  it('the limits the family states are the limits this host enforces', () => {
    expect(file.limits.maxDepth).toBe(MAX_NODE_DEPTH);
    expect(file.limits.maxNodes).toBe(MAX_NODES);
  });

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
