// ============================================================================
//  This host runs the reference's transform-parity answers.
//
//  The shared corpus's `laws/transformLaws` family is a PARITY family: for each
//  drawn `(source, pipeline)` it carries the table the reference evaluator
//  produced, or the bare verdict that the reference refused the pipeline. Run
//  over the reference itself the law certifies only the reference's own
//  self-consistency; its ANSWERS are exactly what another host cannot obtain
//  without it, which is why they are exported at all.
//
//  Before this leg, `@fuaran-ui/ops`'s dataframe evaluator agreed with the
//  reference only by having been written from the same description — the same
//  unfalsifiable claim the capability-law leg beside this one closed. Running
//  the reference's own sample makes it falsifiable: a divergence names the
//  vector id, the pipeline shape it exercises, and both tables.
//
//  NO NEW CODEC. `input.source` is a canonical `DataSource` (an Embedded table)
//  and `input.pipeline` a canonical Transform pipeline — the §11.1 parity
//  encoding this package's `decodeDataSource` / `decodePipeline` already read.
//  The only change the family required was making those two reachable from the
//  package's public surface; nothing about the wire was added for it.
//
//  WHAT IS COMPARED, and why it is not the file's bytes. The corpus README is
//  explicit that these are behaviour vectors, not byte-parity fixtures: a host
//  asserts the verdicts and the derived values, never the framing of the file.
//  So both sides go through THIS host's canonical encoder — the evaluated table
//  directly, and `expected.table` after decoding it — and the canonical forms
//  are compared. A vector whose file bytes were re-spaced or re-ordered would
//  still pass; a vector whose CELL changed would not, which is the distinction
//  that matters.
//
//  A REFUSAL IS COMPARED AS A REFUSAL, never as a class. The family says so
//  deliberately: it carries no error name, so gating on one would be gating on
//  something the corpus does not claim. Both sides must refuse; which refusal
//  is each host's own business.
//
//  AN UNEVALUABLE VECTOR IS SKIPPED BY NAME, never silently. This host's
//  dataframe codec is the gate on what its evaluator can express, so a pipeline
//  it cannot decode is a verb it does not carry. That is a real, reportable
//  partial — it is registered as a named skip carrying the decoder's own
//  message, and warned at collection time so it appears in the run output. A
//  green run that quietly evaluated eleven of sixteen vectors would be the one
//  outcome this leg must not be able to produce. (Today the list is empty: all
//  sixteen decode and all sixteen are asserted.)
//
//  The seed, iteration count and vector count are read from the family
//  manifest, never restated here — a count in prose drifts the first time the
//  sample is regenerated.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import type { DataSource, Table, Transform } from '@fuaran-ui/schema';

import { decodeDataSource, decodePipelineCore } from '../src/decode.js';
import { encodeDataSource } from '../src/encode.js';
import { evalPipeline } from '../src/dataframe.js';
import { parse } from '../src/parse.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures/laws
const lawsRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'laws');

// ─── the family manifest ─────────────────────────────────────────────────────

interface LawFamily {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly kitVersion: string;
  readonly seed: number;
  readonly iterations: number;
  readonly vectors: number;
}

interface LawManifest {
  readonly version: number;
  readonly families: readonly LawFamily[];
}

interface TransformVector {
  readonly id: string;
  readonly case: string;
  readonly input: {
    readonly source?: string;
    readonly pipeline?: string;
  };
  readonly expected: {
    readonly verdict?: string;
    readonly table?: string;
  };
}

interface TransformLawFile {
  readonly family: string;
  readonly kitVersion: string;
  readonly seed: number;
  readonly iterations: number;
  readonly vectors: readonly TransformVector[];
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const manifest = readJson<LawManifest>(join(lawsRoot, 'manifest.json'));
const family = manifest?.families.find((f) => f.id === 'transformLaws');
const lawFile = family ? readJson<TransformLawFile>(join(lawsRoot, family.file)) : undefined;

// ─── decoding a vector through the shipped codec ─────────────────────────────

/** The canonical form of a table, through this host's own encoder. */
const canonical = (table: Table): string => encodeDataSource({ kind: 'Embedded', table });

const decodeSource = (id: string, source: string | undefined): Table => {
  if (source === undefined) throw new Error(`vector ${id}: no source in input`);
  const ast = parse(source);
  if (!ast.ok) throw new Error(`vector ${id}: input.source is not well-formed JSON`);
  const src = decodeDataSource(ast.value);
  // A source failing to decode is never a partial: it is a plain embedded
  // columnar table in the encoding this host's codec is certified against, so
  // a refusal here is a decoder divergence and must fail rather than skip.
  if (!src.ok) throw new Error(`vector ${id}: this host refused input.source — ${src.error}`);
  if (src.value.kind !== 'Embedded')
    throw new Error(`vector ${id}: input.source is a 'ref' source, which carries no rows`);
  return src.value.table;
};

/** `undefined` pipeline ⇒ this host cannot express the vector; the string is why. */
const decodePipelineOrReason = (
  pipeline: string | undefined,
): { readonly pipeline: readonly Transform[] } | { readonly reason: string } => {
  if (pipeline === undefined) return { reason: 'no pipeline in input' };
  const ast = parse(pipeline);
  if (!ast.ok) return { reason: 'input.pipeline is not well-formed JSON' };
  const decoded = decodePipelineCore(ast.value);
  return decoded.ok ? { pipeline: decoded.value } : { reason: decoded.error };
};

const unevaluable: { id: string; reason: string }[] = [];
if (lawFile) {
  for (const v of lawFile.vectors) {
    const d = decodePipelineOrReason(v.input.pipeline);
    if ('reason' in d) unevaluable.push({ id: v.id, reason: d.reason });
  }
  if (unevaluable.length > 0) {
    // Warned at collection so the reason reaches the run output even under a
    // reporter that prints skipped test names tersely.
    console.warn(
      `transformLaws: ${unevaluable.length} of ${lawFile.vectors.length} vector(s) are NOT ` +
        `asserted — this host's dataframe codec cannot decode their pipeline:\n` +
        unevaluable.map((u) => `  - ${u.id}: ${u.reason}`).join('\n'),
    );
  }
}

// ─── the leg ─────────────────────────────────────────────────────────────────

const RUN_CASES = ['evalPipeline'];

describe('transformLaws vectors (shared corpus laws/ family)', () => {
  // The corpus is a sibling checkout, absent in a standalone clone. Every other
  // corpus leg in this repo tolerates that the same way.
  if (!family || !lawFile) {
    it.skip('law-vector family not present in this corpus checkout', () => {});
    return;
  }

  const { seed, iterations, vectors } = lawFile;

  it('the vector file agrees with the family manifest', () => {
    expect(lawFile.family).toBe(family.id);
    expect(family.kind).toBe('law-vectors');
    expect(seed).toBe(family.seed);
    expect(iterations).toBe(family.iterations);
    expect(vectors.length).toBe(family.vectors);
  });

  it('every case the family carries is one this host runs', () => {
    const carried = [...new Set(vectors.map((v) => v.case))].sort();
    // Both directions: an unrun case would mean a silently uncertified member,
    // and a claimed case the family does not carry would mean this harness
    // describes coverage it has not got.
    expect(carried).toEqual([...RUN_CASES].sort());
  });

  for (const v of vectors) {
    const decoded = decodePipelineOrReason(v.input.pipeline);
    if ('reason' in decoded) {
      it.skip(`${v.id} — not evaluable by this host: ${decoded.reason}`, () => {});
      continue;
    }

    it(v.id, () => {
      if (v.case !== 'evalPipeline')
        // Never a skip. A case this harness does not know is a case this host
        // is not certifying, and a green run must not be able to mean that.
        throw new Error(
          `vector case ${v.case} is not run by this host's harness — the corpus family has grown ` +
            `a case; port it here rather than widening this branch to ignore it`,
        );

      const table = decodeSource(v.id, v.input.source);
      const result = evalPipeline(decoded.pipeline, table);

      if (v.expected.verdict === 'error') {
        // The refusal is compared as a refusal, never as a class — see the
        // header. Naming this host's error in the message keeps a genuine
        // divergence diagnosable without asserting anything about it.
        expect(result.ok, `the reference refused this pipeline; this host accepted it`).toBe(false);
        return;
      }

      if (v.expected.verdict !== 'ok')
        throw new Error(`vector ${v.id}: unrecognised verdict: ${String(v.expected.verdict)}`);

      expect(
        result.ok,
        `the reference evaluated this pipeline; this host refused it` +
          (result.ok ? '' : ` — ${JSON.stringify(result.error)}`),
      ).toBe(true);
      if (!result.ok) return;

      if (v.expected.table === undefined)
        throw new Error(`vector ${v.id}: an 'ok' vector carries no expected.table`);
      const expectedAst = parse(v.expected.table);
      if (!expectedAst.ok)
        throw new Error(`vector ${v.id}: expected.table is not well-formed JSON`);
      const expectedSrc = decodeDataSource(expectedAst.value);
      if (!expectedSrc.ok)
        throw new Error(`vector ${v.id}: this host refused expected.table — ${expectedSrc.error}`);
      const expectedTable: DataSource = expectedSrc.value;
      if (expectedTable.kind !== 'Embedded')
        throw new Error(`vector ${v.id}: expected.table is a 'ref' source, which carries no rows`);

      expect(canonical(result.value), `vector ${v.id}: evaluated table diverges`).toBe(
        canonical(expectedTable.table),
      );
    });
  }
});
