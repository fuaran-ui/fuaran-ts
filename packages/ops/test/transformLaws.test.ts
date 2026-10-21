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
//
//  WHAT IS COMPARED: BYTES. The family's contract is that an `ok` vector's
//  result table encodes byte for byte to `expected.table`, so this host's
//  canonical encoding of the evaluated table is compared with the file's
//  string as it stands (Phase 2001). The decoded-and-re-encoded `expected.table`
//  is compared too, so a vector this host's decoder cannot round-trip is named
//  as such rather than reported as an evaluator divergence.
//
//  A REFUSAL IS COMPARED AS A REFUSAL, never as a class. The family carries no
//  error name, so gating on one would be gating on something the corpus does
//  not claim. Both sides must refuse; which refusal is each host's own business.
//
//  WHAT IS NOT RUN, each by name and with its reason, never silently:
//   - every `evalPipeline` vector whose id carries `-unit-` — carried by
//     fuaran#2208: this host does not yet carry field metadata (fuaran#2207) or
//     the unit algebra. The set is derived from the ids and cross-checked
//     against the inputs that state a unit, so a new unit vector, or a renamed
//     one, is noticed rather than absorbed;
//   - the `columnOp` and `delta` case kinds, per kind: this host carries no
//     ColumnOp surface and no table-delta surface. The set of kinds the file
//     carries is asserted exactly, so a new kind fails loudly.
//  Every other `evalPipeline` vector is asserted. The named "not evaluable by
//  this host" skip a pipeline the codec cannot decode used to get is now
//  itself a FAILURE for any non-unit vector: it is not a way to skip one.
//
//  The seed, iteration count, vector count and kit version are read from the
//  family manifest, never restated here.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DataSource, Table, Transform } from '@fuaran-ui/schema';

import { decodeDataSource, decodePipelineCore } from '../src/decode.js';
import { encodeDataSource } from '../src/encode.js';
import { evalPipeline } from '../src/dataframe.js';
import { parse } from '../src/parse.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const lawsRoot = join(wireCorpusRoot(), 'laws');

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

// ─── what this host runs, per case kind ──────────────────────────────────────

/** Every case kind the family carries, and what this host does with it. Exactly these. */
const CASE_KINDS: Readonly<Record<string, { readonly run: true } | { readonly reason: string }>> = {
  evalPipeline: { run: true },
  columnOp: { reason: 'this host carries no ColumnOp surface' },
  delta: { reason: 'this host carries no table-delta surface' },
};

const UNIT_REASON =
  'carried by fuaran#2208 — this host does not yet carry field metadata (fuaran#2207) or the unit algebra';

const isUnitVector = (v: TransformVector): boolean => v.id.includes('-unit-');

/**
 * Does the vector's input state a unit anywhere — a schema entry of its source,
 * or of an operand table its pipeline embeds, carrying a `unit` member? This is
 * the independent half of the unit skip set's cross-check: it reads the DATA,
 * where `isUnitVector` reads the name.
 */
const statesAUnit = (v: TransformVector): boolean => {
  const tables: unknown[] = [];
  const collect = (j: unknown): void => {
    if (Array.isArray(j)) j.forEach(collect);
    else if (j !== null && typeof j === 'object') {
      const o = j as Record<string, unknown>;
      if (Array.isArray(o['schema'])) tables.push(o);
      Object.values(o).forEach(collect);
    }
  };
  for (const text of [v.input.source, v.input.pipeline]) {
    if (text !== undefined) collect(JSON.parse(text));
  }
  return tables.some((t) =>
    ((t as { schema: unknown[] }).schema ?? []).some(
      (e) => e !== null && typeof e === 'object' && 'unit' in (e as object),
    ),
  );
};

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

// ─── the not-run report, at collection ───────────────────────────────────────

const notRun: { id: string; reason: string }[] = [];
const unevaluable: { id: string; reason: string }[] = [];
if (lawFile) {
  for (const v of lawFile.vectors) {
    const handling = CASE_KINDS[v.case];
    if (handling !== undefined && 'reason' in handling) {
      notRun.push({ id: v.id, reason: handling.reason });
      continue;
    }
    if (v.case !== 'evalPipeline') continue;
    if (isUnitVector(v)) {
      notRun.push({ id: v.id, reason: UNIT_REASON });
      continue;
    }
    const d = decodePipelineOrReason(v.input.pipeline);
    if ('reason' in d) unevaluable.push({ id: v.id, reason: d.reason });
  }
  // Warned at collection so every reason reaches the run output, counted, even under a reporter
  // that prints skipped test names tersely.
  console.warn(
    `transformLaws: ${notRun.length} of ${lawFile.vectors.length} vector(s) are NOT run by this ` +
      `host, by name:\n` +
      notRun.map((u) => `  - ${u.id}: ${u.reason}`).join('\n'),
  );
  if (unevaluable.length > 0) {
    console.warn(
      `transformLaws: ${unevaluable.length} non-unit evalPipeline vector(s) do not decode — ` +
        `a FAILURE, not a skip:\n` +
        unevaluable.map((u) => `  - ${u.id}: ${u.reason}`).join('\n'),
    );
  }
}

// ─── the leg ─────────────────────────────────────────────────────────────────

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
    expect(lawFile.kitVersion).toBe(family.kitVersion);
    expect(seed).toBe(family.seed);
    expect(iterations).toBe(family.iterations);
    expect(vectors.length).toBe(family.vectors);
    // `iterations` counts the evalPipeline vectors only.
    expect(vectors.filter((v) => v.case === 'evalPipeline').length).toBe(family.iterations);
  });

  it('the case kinds the family carries are exactly the ones this host handles', () => {
    const carried = [...new Set(vectors.map((v) => v.case))].sort();
    // Both directions: an unhandled kind would mean a silently uncertified
    // member, and a claimed kind the family does not carry would mean this
    // harness describes coverage it has not got.
    expect(carried).toEqual(Object.keys(CASE_KINDS).sort());
  });

  it('the unit skip set is exactly the -unit- ids, and they are exactly the inputs stating a unit', () => {
    const pipelineVectors = vectors.filter((v) => v.case === 'evalPipeline');
    const byName = pipelineVectors.filter(isUnitVector).map((v) => v.id);
    const byData = pipelineVectors.filter(statesAUnit).map((v) => v.id);
    const skipped = notRun.filter((u) => u.reason === UNIT_REASON).map((u) => u.id);
    expect(
      byName.length,
      'the family carries no -unit- vector — revisit this skip',
    ).toBeGreaterThan(0);
    expect(skipped).toEqual(byName);
    // A unit vector renamed without `-unit-`, or a `-unit-` id over unit-free data, breaks this.
    expect(byData).toEqual(byName);
  });

  it('no non-unit evalPipeline vector is unevaluable by this host', () => {
    expect(unevaluable).toEqual([]);
  });

  for (const v of vectors) {
    const handling = CASE_KINDS[v.case];
    if (handling !== undefined && 'reason' in handling) {
      it.skip(`${v.id} — not run: ${handling.reason}`, () => {});
      continue;
    }
    if (v.case === 'evalPipeline' && isUnitVector(v)) {
      it.skip(`${v.id} — not run: ${UNIT_REASON}`, () => {});
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

      const decoded = decodePipelineOrReason(v.input.pipeline);
      if ('reason' in decoded)
        throw new Error(`vector ${v.id}: this host cannot decode the pipeline — ${decoded.reason}`);

      const table = decodeSource(v.id, v.input.source);
      const result = evalPipeline(decoded.pipeline, table);

      if (v.expected.verdict === 'error') {
        // The refusal is compared as a refusal, never as a class — see the header.
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

      expect(
        canonical(expectedTable.table),
        `vector ${v.id}: this host's codec does not round-trip expected.table`,
      ).toBe(v.expected.table);
      expect(canonical(result.value), `vector ${v.id}: evaluated table diverges`).toBe(
        v.expected.table,
      );
    });
  }
});
