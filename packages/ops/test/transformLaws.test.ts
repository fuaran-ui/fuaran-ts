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
//  A TOLERANCE IS THE VECTOR'S OWN (Phase 2400). A vector carrying
//  `expected.tolerance` names the columns the reference marks host-rounded,
//  each with a bound in ulps. Those columns are compared cell by cell — one
//  type, one length, null in the same rows, two present nonzero finite floats
//  of one sign within the bound (the distance being the difference of their
//  IEEE-754 binary64 bit patterns), every other cell (a zero of either sign, a
//  non-finite float, a non-float) exactly — and the rest of the table byte for
//  byte: this host's answer with every named column replaced by the recorded
//  one must encode to `expected.table` exactly. The worst distance per named
//  column is reported, so a host drifting toward the bound is visible.
//
//  A REFUSAL IS COMPARED AS A REFUSAL, never as a class. The family carries no
//  error name, so gating on one would be gating on something the corpus does
//  not claim. Both sides must refuse; which refusal is each host's own business.
//
//  THE UNIT VECTORS RUN (Phase 2208): the evaluator carries field metadata
//  through every verb and checks units, so the `-unit-` vectors are asserted
//  like every other evalPipeline vector — a refusal among them is the unit
//  check's, and an answer carries its schema's units, labels and descriptions.
//
//  THE `columnOp` VECTORS RUN (Phase 2500 gave this host the surface): the op
//  decodes through `decodeColumnOpJson`, applies through `applyColumnOp` and is
//  compared as an evalPipeline vector is (`expected.table` on `ok`, a refusal on
//  `error`), and its decode re-encodes to `expected.op`.
//
//  WHAT IS NOT RUN, each by name and with its reason, never silently:
//   - the `delta` case kind: a vector carries two tables and asks for their
//     diff, and this host's `deltaOf` derives a row delta from an op over the
//     before table, never from two tables. The set of kinds the file carries is
//     asserted exactly, so a new kind fails loudly.
//  Every other vector is asserted. The named "not evaluable by
//  this host" skip a pipeline the codec cannot decode used to get is now
//  itself a FAILURE: it is not a way to skip one.
//
//  The seed, iteration count, vector count and kit version are read from the
//  family manifest, never restated here.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Cell, DataSource, Table, Transform } from '@fuaran-ui/schema';

import { decodeDataSource, decodePipelineCore } from '../src/decode.js';
import { encodeDataSource } from '../src/encode.js';
import { cellAt, columnCells, evalPipeline } from '../src/dataframe.js';
import { applyColumnOp, decodeColumnOpJson, encodeColumnOp } from '../src/gridEdit.js';
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
    readonly op?: string;
  };
  readonly expected: {
    readonly verdict?: string;
    readonly table?: string;
    readonly op?: string;
    readonly tolerance?: Readonly<Record<string, number>>;
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
  columnOp: { run: true },
  delta: {
    reason:
      'this host derives a row delta from an op over the before table (deltaOf); it has no surface that diffs two tables',
  },
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

// ─── a columnOp vector ───────────────────────────────────────────────────────

const runColumnOpVector = (v: TransformVector): void => {
  if (v.input.op === undefined) throw new Error(`vector ${v.id}: no op in input`);
  const ast = parse(v.input.op);
  if (!ast.ok) throw new Error(`vector ${v.id}: input.op is not well-formed JSON`);
  const op = decodeColumnOpJson(ast.value);
  if (!op.ok) throw new Error(`vector ${v.id}: this host refused input.op — ${op.error}`);
  expect(encodeColumnOp(op.value), `vector ${v.id}: the op does not re-encode`).toBe(v.expected.op);

  const result = applyColumnOp(op.value, decodeSource(v.id, v.input.source));
  if (v.expected.verdict === 'error') {
    // The refusal is compared as a refusal, never as a class — see the header.
    expect(result.ok, `the reference refused this op; this host applied it`).toBe(false);
    return;
  }
  if (v.expected.verdict !== 'ok')
    throw new Error(`vector ${v.id}: unrecognised verdict: ${String(v.expected.verdict)}`);
  if (!result.ok)
    throw new Error(
      `vector ${v.id}: the reference applied this op; this host refused it — ${result.detail}`,
    );
  expect(canonical(result.value), `vector ${v.id}: the applied table diverges`).toBe(
    v.expected.table,
  );
};

// ─── the tolerance rule (Phase 2400) ─────────────────────────────────────────

/** The distance between two doubles of one sign: their binary64 bit patterns' difference. */
const ulpDistance = (a: number, b: number): bigint => {
  const bits = (x: number): bigint => {
    const view = new DataView(new ArrayBuffer(8));
    view.setFloat64(0, x);
    return view.getBigInt64(0);
  };
  const d = bits(a) - bits(b);
  return d < 0n ? -d : d;
};

const sameBits = (a: number, b: number): boolean =>
  (Number.isNaN(a) && Number.isNaN(b)) || Object.is(a, b);

/**
 * Compares the tolerance-named columns of `answer` with `expected` and returns `answer` with each
 * named column replaced by the recorded one (so the caller's byte comparison covers everything
 * else), and the worst distance seen per named column.
 */
const withinTolerance = (
  id: string,
  tolerance: Readonly<Record<string, number>>,
  answer: Table,
  expected: Table,
): { readonly replaced: Table; readonly worst: Readonly<Record<string, number>> } => {
  const worst: Record<string, number> = {};
  const columns = [...answer.columns];
  for (const [name, bound] of Object.entries(tolerance).sort(([a], [b]) => (a < b ? -1 : 1))) {
    const w = expected.columns.find((c) => c.name === name);
    const at = columns.findIndex((c) => c.name === name);
    if (w === undefined || at < 0)
      throw new Error(`vector ${id}: tolerance column ${name} is absent`);
    const g = columns[at]!;
    const wCells = columnCells(w);
    const gCells = columnCells(g);
    if (w.type !== g.type || wCells.length !== gCells.length)
      throw new Error(`vector ${id}: tolerance column ${name} differs in type or length`);
    let columnWorst = 0n;
    wCells.forEach((wc, r) => {
      const gc = gCells[r]!;
      if ((wc.kind === 'Null') !== (gc.kind === 'Null'))
        throw new Error(`vector ${id}: ${name} row ${r} is null in one table only`);
      if (wc.kind === 'Float' && gc.kind === 'Float') {
        const [a, b] = [wc.value, gc.value];
        if (
          a !== 0 &&
          b !== 0 &&
          Number.isFinite(a) &&
          Number.isFinite(b) &&
          Math.sign(a) === Math.sign(b)
        ) {
          const d = ulpDistance(a, b);
          if (d > columnWorst) columnWorst = d;
          if (d > BigInt(bound))
            throw new Error(
              `vector ${id}: ${name} row ${r}: ${b} is ${d} ulp from the recorded ${a}; the bound is ${bound}`,
            );
          return;
        }
        if (!sameBits(a, b))
          throw new Error(
            `vector ${id}: ${name} row ${r}: ${b} differs from ${a} (compared exactly)`,
          );
        return;
      }
      if (JSON.stringify(wc) !== JSON.stringify(gc))
        throw new Error(`vector ${id}: ${name} row ${r} differs from the recorded cell`);
    });
    worst[name] = Number(columnWorst);
    columns[at] = w;
  }
  return { replaced: { ...answer, columns }, worst };
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
      `transformLaws: ${unevaluable.length} evalPipeline vector(s) do not decode — ` +
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

  it('the family carries the unit vectors, and this host runs them', () => {
    const unitIds = vectors.filter((v) => v.id.includes('-unit-')).map((v) => v.id);
    expect(unitIds.length, 'the family carries no -unit- vector').toBeGreaterThan(0);
    expect(notRun.filter((u) => unitIds.includes(u.id))).toEqual([]);
  });

  it('this host runs every vector but the delta kind', () => {
    const ids = (kind: string): readonly string[] =>
      vectors.filter((v) => v.case === kind).map((v) => v.id);
    expect(notRun.map((u) => u.id)).toEqual(ids('delta'));
    expect(ids('columnOp').length, 'the family carries no columnOp vector').toBeGreaterThan(0);
    expect(vectors.length - notRun.length).toBe(
      ids('evalPipeline').length + ids('columnOp').length,
    );
  });

  it('no evalPipeline vector is unevaluable by this host', () => {
    expect(unevaluable).toEqual([]);
  });

  for (const v of vectors) {
    const handling = CASE_KINDS[v.case];
    if (handling !== undefined && 'reason' in handling) {
      it.skip(`${v.id} — not run: ${handling.reason}`, () => {});
      continue;
    }

    it(v.id, () => {
      if (v.case === 'columnOp') {
        runColumnOpVector(v);
        return;
      }
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
      const tolerance = v.expected.tolerance ?? {};
      const answer =
        Object.keys(tolerance).length === 0
          ? result.value
          : (() => {
              const { replaced, worst } = withinTolerance(
                v.id,
                tolerance,
                result.value,
                expectedTable.table,
              );
              console.warn(
                `transformLaws tolerance: ${v.id} worst ulp per column ${JSON.stringify(worst)}`,
              );
              return replaced;
            })();
      expect(canonical(answer), `vector ${v.id}: evaluated table diverges`).toBe(v.expected.table);
    });
  }
});

// The special-value rows over a NaN or an infinity, which the wire carries neither of (so the law
// file cannot), the pinned product tree past the cube, and the int32 band an int power stays inside
// (Phase 2400). Run through the evaluator: a table may hold a NaN or an infinity in memory.
describe('the power functions off the wire', () => {
  const one = (fn: 'pow' | 'exp' | 'ln' | 'log10', args: readonly Cell[]) => {
    const table: Table = {
      schema: [{ name: 'k', type: 'int' }],
      columns: [
        {
          name: 'k',
          type: 'int',
          data: { kind: 'Ints', values: Int32Array.of(0), validity: { kind: 'AllValid' } },
        },
      ],
    };
    const r = evalPipeline(
      [
        {
          kind: 'derive',
          name: 'out',
          expr: { kind: 'apply', fn, args: args.map((cell) => ({ kind: 'lit', cell })) },
        },
      ],
      table,
    );
    if (!r.ok) return r;
    return { ok: true as const, cell: cellAt(r.value.columns.find((c) => c.name === 'out')!, 0) };
  };
  const f = (value: number): Cell => ({ kind: 'Float', value });
  const i = (value: number): Cell => ({ kind: 'Int', value });
  const valueOf = (r: ReturnType<typeof one>): number | string =>
    r.ok
      ? r.cell.kind === 'Float' || r.cell.kind === 'Int'
        ? r.cell.value
        : r.cell.kind
      : 'refused';

  it('answers the table rows a host library disagrees on', () => {
    expect(valueOf(one('pow', [f(1), f(NaN)]))).toBeNaN();
    expect(valueOf(one('pow', [f(NaN), f(0)]))).toBeNaN();
    expect(valueOf(one('pow', [f(-1), f(Infinity)]))).toBe(1);
    expect(valueOf(one('pow', [f(-1), f(-Infinity)]))).toBe(1);
    expect(valueOf(one('exp', [f(NaN)]))).toBeNaN();
    expect(valueOf(one('exp', [f(709.8)]))).toBe(Infinity);
    expect(valueOf(one('ln', [f(Infinity)]))).toBe(Infinity);
    expect(valueOf(one('log10', [f(NaN)]))).toBeNaN();
    expect(valueOf(one('pow', [f(NaN), i(0)]))).toBeNaN();
    expect(valueOf(one('pow', [f(1e-300), i(-2)]))).toBe('Null');
  });

  it('runs the squaring tree past the cube and keeps an int power inside the int32 band', () => {
    const x = 1.1;
    expect(valueOf(one('pow', [f(x), i(4)]))).toBe(x * x * (x * x));
    expect(valueOf(one('pow', [f(x), i(5)]))).toBe(x * (x * x * (x * x)));
    expect(valueOf(one('pow', [i(46341), i(2)]))).toBe('refused');
    expect(valueOf(one('pow', [i(-2), i(31)]))).toBe(-2147483648);
  });
});
