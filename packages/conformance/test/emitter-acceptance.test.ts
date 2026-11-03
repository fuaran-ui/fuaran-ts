// ============================================================================
//  The constrained-emitter acceptance leg (Phase 2451, WIRE_FORMAT.md §11.4).
//
//  The manifest declares emitter profiles: per lineage, revisions oldest first,
//  each naming its axes, its declared subset and its vectors, and per codec host
//  the oldest revision that host still accepts (§15.6). This is the TypeScript
//  host's answer: for every lineage it reads every revision from
//  `oldestAccepted['fuaran-ts']` onward and asserts each vector is a row of a
//  family every codec host reads, integer-only when the revision claims it,
//  inside the revision's subset, and ACCEPTED by @fuaran-ui/ops: re-encoded
//  byte-identical (a round-trip row) or normalised to its expected bytes (an
//  alias-shim row, §16). Runs against the bundled snapshot and, when present,
//  the workspace corpus, like the self-certification suite beside it.
// ============================================================================

import { decodeNode, decodeOp, encodeNode, encodeOp, type TreeOp } from '@fuaran-ui/ops';
import { admitting, type Node } from '@fuaran-ui/schema';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { loadCorpus, type Corpus, type CorpusFixture } from '../src/corpus.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

/** This host's token in the WIRE_FORMAT §11.0 roster and in every `oldestAccepted` record. */
const THIS_HOST = 'fuaran-ts';

/** The row kinds an emitter-profile vector may name: the families every codec host reads. */
const VECTOR_KINDS = new Set(['node-round-trip', 'op-round-trip', 'lenient-accept']);

interface Revision {
  readonly id: string;
  readonly wire: string;
  readonly axes: readonly string[];
  readonly subset: {
    readonly kinds: readonly string[];
    readonly formFieldKinds: readonly string[];
    readonly ops: readonly string[];
  };
  readonly vectors: readonly string[];
}

interface Lineage {
  readonly oldestAccepted: Readonly<Record<string, string>>;
  readonly revisions: readonly Revision[];
}

type Json = null | boolean | number | string | readonly Json[] | { readonly [k: string]: Json };

/**
 * `true` when the bytes carry a number token with a fraction or an exponent
 * outside every string: `integer-only` reads the TOKEN, so `2.0` is outside it.
 */
export const carriesNonIntegerNumber = (wire: string): boolean => {
  let inString = false;
  let escaped = false;
  let inNumber = false;
  for (const c of wire) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === '\\') escaped = true;
      else if (c === '"') inString = false;
    } else if (c === '"') {
      inString = true;
      inNumber = false;
    } else if (c === '-' || (c >= '0' && c <= '9')) inNumber = true;
    else if (inNumber && (c === '.' || c === 'e' || c === 'E')) return true;
    else inNumber = false;
  }
  return false;
};

const isObject = (v: Json | undefined): v is { readonly [k: string]: Json } =>
  v !== undefined && v !== null && typeof v === 'object' && !Array.isArray(v);

/** The string a member holds, or undefined. */
const tagOf = (v: Json | undefined): string | undefined => {
  if (!isObject(v)) return undefined;
  const t = v['$type'];
  return typeof t === 'string' ? t : undefined;
};

/** Every `FormFieldKind` at a control position: a `Form`'s `fields[]`, a `Filters`' `items[]`. */
export const controlKindsOf = (root: Json): string[] => {
  const out: string[] = [];
  const walk = (v: Json): void => {
    if (Array.isArray(v)) {
      for (const x of v) walk(x);
      return;
    }
    if (!isObject(v)) return;
    const tag = tagOf(v);
    const carrier = tag === 'Form' ? 'fields' : tag === 'Filters' ? 'items' : undefined;
    const members = carrier === undefined ? undefined : v[carrier];
    if (Array.isArray(members))
      for (const m of members) {
        const control = isObject(m) ? tagOf(m['kind']) : undefined;
        if (control !== undefined) out.push(control);
      }
    for (const x of Object.values(v)) walk(x);
  };
  walk(root);
  return out;
};

/** Every `TreeOp` discriminator an op document carries: its own and every `Batch` member's. */
export const opTagsOf = (op: Json): string[] => {
  const tag = tagOf(op);
  if (tag === undefined || !isObject(op)) return [];
  const members = op['ops'];
  const nested = tag === 'Batch' && Array.isArray(members) ? members.flatMap(opTagsOf) : [];
  return [tag, ...nested];
};

const trimEol = (s: string): string => s.replace(/\n+$/, '');

/** Every reason `bytes` (read by `decoder`) falls outside `r`'s subset, or []. */
const subsetDefects = (r: Revision, decoder: string, bytes: string): string[] => {
  const policy = admitting(r.id, r.subset.kinds);
  const decoded = decoder === 'op' ? decodeOp(bytes, policy) : decodeNode(bytes, policy);
  const kind = decoded.ok
    ? []
    : [`a node kind outside the subset: ${decoded.error.code} at ${decoded.error.path}`];
  const parsed = JSON.parse(bytes) as Json;
  const controls = controlKindsOf(parsed)
    .filter((k) => !r.subset.formFieldKinds.includes(k))
    .map((k) => `a form-field kind outside the subset: ${k}`);
  const ops =
    decoder === 'op'
      ? opTagsOf(parsed)
          .filter((t) => !r.subset.ops.includes(t))
          .map((t) => `an op outside the subset: ${t}`)
      : [];
  return [...kind, ...controls, ...ops];
};

/** Every reason vector `id` fails revision `r`'s bar on this host, or []. */
const vectorDefects = (
  corpus: Corpus,
  byId: Map<string, CorpusFixture>,
  r: Revision,
  id: string,
): string[] => {
  const row = byId.get(id);
  if (row === undefined) return ['names no row of the manifest'];
  if (!VECTOR_KINDS.has(row.kind))
    return [`is a ${row.kind} row, not a family every codec host reads`];
  if (row.expectedFile === undefined) return ['carries no expected file'];
  const input = trimEol(corpus.read(row.inputFile));
  const expected = trimEol(corpus.read(row.expectedFile));
  const integer =
    r.axes.includes('integer-only') && carriesNonIntegerNumber(input)
      ? ['carries a number token with a fraction or an exponent under integer-only']
      : [];
  let accepted: string[];
  if (row.decoder === 'op') {
    const d = decodeOp(input);
    accepted = !d.ok
      ? [`is NOT accepted: ${d.error.code} at ${d.error.path}`]
      : encodeOp(d.value as TreeOp<unknown>) === expected
        ? []
        : ['re-encodes to bytes other than its expected file'];
  } else {
    const d = decodeNode(input);
    accepted = !d.ok
      ? [`is NOT accepted: ${d.error.code} at ${d.error.path}`]
      : encodeNode(d.value as Node<unknown>) === expected
        ? []
        : ['re-encodes to bytes other than its expected file'];
  }
  return [...integer, ...subsetDefects(r, row.decoder, input), ...accepted];
};

const lineagesOf = (corpus: Corpus): [string, Lineage][] => {
  const manifest = JSON.parse(corpus.read('manifest.json')) as {
    readonly emitterProfiles?: Readonly<Record<string, Lineage>>;
  };
  return Object.entries(manifest.emitterProfiles ?? {});
};

const certify = (label: string, corpus: Corpus): void => {
  describe(`constrained-emitter acceptance — ${label} corpus (WIRE_FORMAT 11.4)`, () => {
    const lineages = lineagesOf(corpus);
    const byId = new Map(corpus.fixtures.map((f) => [f.id, f]));

    it('declares at least one emitter-profile lineage', () => {
      expect(lineages.length).toBeGreaterThan(0);
    });

    for (const [name, lineage] of lineages) {
      const from = lineage.oldestAccepted[THIS_HOST];
      it(`${name}: records the oldest revision ${THIS_HOST} accepts`, () => {
        expect(from, `lineage ${name} records no oldestAccepted for ${THIS_HOST}`).toBeDefined();
        expect(lineage.revisions.map((r) => r.id)).toContain(from);
      });
      const index = lineage.revisions.findIndex((r) => r.id === from);
      for (const r of lineage.revisions.slice(Math.max(index, 0))) {
        it(`${r.id}: every vector is accepted under its declaration`, () => {
          expect(r.vectors.length).toBeGreaterThan(0);
          const failures = r.vectors.flatMap((v) =>
            vectorDefects(corpus, byId, r, v).map((d) => `${v} ${d}`),
          );
          expect(failures).toEqual([]);
        });
      }

      // Go-red: the subset check refuses each frame once its own op, a control
      // or a kind it carries is taken out of the subset.
      it(`${name}: the subset check refuses a frame carrying a tag outside it`, () => {
        const newest = lineage.revisions[lineage.revisions.length - 1]!;
        const frames = newest.vectors
          .map((v) => byId.get(v))
          .filter((f): f is CorpusFixture => f !== undefined && f.kind === 'op-round-trip');
        expect(frames.length).toBeGreaterThan(0);
        for (const f of frames) {
          const bytes = trimEol(corpus.read(f.inputFile));
          expect(subsetDefects(newest, 'op', bytes)).toEqual([]);
          const own = opTagsOf(JSON.parse(bytes) as Json)[0]!;
          const withoutOp = {
            ...newest,
            subset: { ...newest.subset, ops: newest.subset.ops.filter((t) => t !== own) },
          };
          expect(subsetDefects(withoutOp, 'op', bytes).length).toBeGreaterThan(0);
          for (const k of controlKindsOf(JSON.parse(bytes) as Json)) {
            const without = {
              ...newest,
              subset: {
                ...newest.subset,
                formFieldKinds: newest.subset.formFieldKinds.filter((t) => t !== k),
              },
            };
            expect(subsetDefects(without, 'op', bytes).length).toBeGreaterThan(0);
          }
          for (const k of newest.subset.kinds.filter((t) => bytes.includes(`"$type":"${t}"`))) {
            const without = {
              ...newest,
              subset: { ...newest.subset, kinds: newest.subset.kinds.filter((t) => t !== k) },
            };
            expect(subsetDefects(without, 'op', bytes).length).toBeGreaterThan(0);
          }
        }
      });
    }
  });
};

describe('the integer-only scanner (go-red)', () => {
  it('refuses a fraction and an exponent, and ignores strings', () => {
    expect(carriesNonIntegerNumber('{"v":2.0}')).toBe(true);
    expect(carriesNonIntegerNumber('{"v":[1E+21]}')).toBe(true);
    expect(carriesNonIntegerNumber('{"v":"1.5e3","w":-7}')).toBe(false);
  });
});

certify('bundled', loadCorpus());

const workspace = wireCorpusRoot();
if (existsSync(join(workspace, 'manifest.json')))
  certify('workspace', loadCorpus({ corpusRoot: workspace }));
