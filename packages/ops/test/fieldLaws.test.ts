// ============================================================================
//  This host runs the shared corpus's schema-field law family (Phase 2207).
//
//  `laws/fieldLaws` carries AUTHORED vectors over the metadata a schema entry
//  states (WIRE_FORMAT §3.6.26): an optional unit in the unit algebra's
//  canonical text, a label, a description and the extension members. Each
//  `expected` was computed by the reference kit; this leg recomputes every one
//  with THIS host's own codec, unit algebra and schema operations, and compares:
//
//    - fieldEncode  — an entry's canonical bytes from its members;
//    - codecDecode  — a zero-row source decoded and re-encoded (or refused);
//    - fingerprint  — the schema fingerprint;
//    - delta        — the delta's canonical bytes AND the schema replaying it
//                     over `old` yields (which is `target`);
//    - classify     — the compatibility verdict for the depended-on columns.
//
//  The schemas the last three read are decoded through this host's own schema
//  decoder, so the wire reading is under test there too.
//
//  EVERY vector of EVERY case is run. A `reject` vector requires a refusal; the
//  class it names is compared where this host spells it: the reference's
//  `MalformedShape` is this host's `malformed:` refusal.
//
//  The case set is asserted exactly against what this leg runs, and the vector
//  count against the family manifest, so a new case kind fails loudly.
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  canonicalUnit,
  classifySchemaDelta,
  diffSchema,
  patchSchema,
  schemaFingerprint,
} from '@fuaran-ui/core-twins';
import { COLUMN_TYPES, type ColumnType, type SchemaEntry } from '@fuaran-ui/schema';

import { decodeColSchema, decodeDataSource } from '../src/decode.js';
import { encodeDataSource, encodeSchemaDelta, encodeSchemaEntry } from '../src/encode.js';
import { parse } from '../src/parse.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const lawsRoot = join(wireCorpusRoot(), 'laws');

interface LawFamily {
  readonly id: string;
  readonly kind: string;
  readonly file: string;
  readonly kitVersion: string;
  readonly vectors: number;
}

interface FieldVector {
  readonly id: string;
  readonly case: string;
  readonly input: {
    // fieldEncode
    readonly name?: string;
    readonly type?: string;
    readonly unit?: string;
    readonly label?: string;
    readonly description?: string;
    readonly ext?: Readonly<Record<string, string>>;
    // codecDecode
    readonly document?: string;
    // fingerprint
    readonly schema?: unknown;
    // delta, classify
    readonly old?: unknown;
    readonly target?: unknown;
    readonly dependsOn?: readonly string[];
  };
  readonly expected: {
    readonly verdict: 'accept' | 'reject';
    readonly error?: string;
    readonly canonical?: string;
    readonly fingerprint?: string;
    readonly patched?: unknown;
    readonly compat?: string;
  };
}

interface FieldLawFile {
  readonly family: string;
  readonly kitVersion: string;
  readonly vectors: readonly FieldVector[];
}

const readJson = <T>(path: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return undefined;
  }
};

const manifest = readJson<{ readonly families: readonly LawFamily[] }>(
  join(lawsRoot, 'manifest.json'),
);
const family = manifest?.families.find((f) => f.id === 'fieldLaws');
const lawFile = family ? readJson<FieldLawFile>(join(lawsRoot, family.file)) : undefined;

// ─── this host's answer to one vector ───────────────────────────────────────

/** A host answer: the accepted value(s) compared with `expected`, or a refusal. */
type Answer = { readonly accept: Readonly<Record<string, unknown>> } | { readonly reject: string };

/** A schema array in wire form, through this host's own schema decoder. */
const schemaOf = (value: unknown): SchemaEntry[] => {
  const ast = parse(JSON.stringify(value));
  if (!ast.ok) throw new Error('the vector schema is not well-formed JSON');
  const s = decodeColSchema(ast.value);
  if (!s.ok) throw new Error(`this host refused the vector's schema: ${s.error}`);
  return s.value;
};

const encodeSchema = (s: readonly SchemaEntry[]): string =>
  '[' + s.map(encodeSchemaEntry).join(',') + ']';

const RUNNERS: Readonly<Record<string, (v: FieldVector) => Answer>> = {
  fieldEncode: (v) => {
    const i = v.input;
    if (!COLUMN_TYPES.includes(i.type as ColumnType)) return { reject: `type ${String(i.type)}` };
    let unit: string | undefined;
    if (i.unit !== undefined) {
      // The reference builds the field from a parsed unit, so the entry holds its canonical text.
      const u = canonicalUnit(i.unit);
      if (!u.ok) return { reject: `unit ${i.unit}` };
      unit = u.value;
    }
    const entry: SchemaEntry = {
      name: i.name ?? '',
      type: i.type as ColumnType,
      ...(unit === undefined ? {} : { unit }),
      ...(i.label === undefined ? {} : { label: i.label }),
      ...(i.description === undefined ? {} : { description: i.description }),
      ...(i.ext === undefined ? {} : { ext: new Map(Object.entries(i.ext)) }),
    };
    return { accept: { canonical: encodeSchemaEntry(entry) } };
  },
  codecDecode: (v) => {
    const ast = parse(v.input.document ?? '');
    if (!ast.ok) return { reject: 'not well-formed JSON' };
    const src = decodeDataSource(ast.value);
    return src.ok ? { accept: { canonical: encodeDataSource(src.value) } } : { reject: src.error };
  },
  fingerprint: (v) => ({ accept: { fingerprint: schemaFingerprint(schemaOf(v.input.schema)) } }),
  delta: (v) => {
    const old = schemaOf(v.input.old);
    const target = schemaOf(v.input.target);
    const d = diffSchema(old, target);
    const patched = patchSchema(old, d);
    if (!patched.ok) return { reject: JSON.stringify(patched.error) };
    // `patched` is compared by its canonical bytes, the expected array read by this host's decoder.
    return {
      accept: {
        canonical: encodeSchemaDelta(d),
        patched: encodeSchema(patched.value),
      },
    };
  },
  classify: (v) => {
    const d = diffSchema(schemaOf(v.input.old), schemaOf(v.input.target));
    return { accept: { compat: classifySchemaDelta(v.input.dependsOn ?? [], d).kind } };
  },
};

/** The expected values an accepted answer is compared with, per case. */
const expectedOf = (v: FieldVector): Readonly<Record<string, unknown>> => {
  switch (v.case) {
    case 'fieldEncode':
    case 'codecDecode':
      return { canonical: v.expected.canonical };
    case 'fingerprint':
      return { fingerprint: v.expected.fingerprint };
    case 'delta':
      return {
        canonical: v.expected.canonical,
        patched: encodeSchema(schemaOf(v.expected.patched)),
      };
    case 'classify':
      return { compat: v.expected.compat };
    default:
      throw new Error(`vector case ${v.case} has no expected field in this harness — port it`);
  }
};

/** The reference's refusal classes this host spells, and how its refusal text names them. */
const REFUSAL_PREFIX: Readonly<Record<string, string>> = { MalformedShape: 'malformed: ' };

// ─── the leg ─────────────────────────────────────────────────────────────────

describe('schema-field law vectors (shared corpus laws/ family)', () => {
  if (!family || !lawFile) {
    it.skip('law-vector family not present in this corpus checkout', () => {});
    return;
  }

  it('the vector file agrees with the family manifest', () => {
    expect(lawFile.family).toBe(family.id);
    expect(family.kind).toBe('law-vectors');
    expect(lawFile.kitVersion).toBe(family.kitVersion);
    expect(lawFile.vectors.length).toBe(family.vectors);
  });

  it('every case the family carries is one this host runs, and no other', () => {
    const carried = [...new Set(lawFile.vectors.map((v) => v.case))].sort();
    expect(carried).toEqual(Object.keys(RUNNERS).sort());
  });

  for (const v of lawFile.vectors) {
    it(v.id, () => {
      const run = RUNNERS[v.case];
      if (run === undefined)
        throw new Error(`vector case ${v.case} is not run by this host's harness — port it`);
      const answer = run(v);
      if (v.expected.verdict === 'reject') {
        if (!('reject' in answer))
          throw new Error(
            `the reference refused this vector (${String(v.expected.error)}); this host accepted ` +
              JSON.stringify(answer.accept),
          );
        const prefix = REFUSAL_PREFIX[v.expected.error ?? ''];
        if (prefix !== undefined)
          expect(answer.reject.startsWith(prefix), answer.reject).toBe(true);
        return;
      }
      expect(v.expected.verdict).toBe('accept');
      if ('reject' in answer)
        throw new Error(
          `the reference accepted this vector; this host refused it — ${answer.reject}`,
        );
      expect(answer.accept).toEqual(expectedOf(v));
    });
  }
});
