// ============================================================================
//  The corpus's `grid-edit/` family (WIRE_FORMAT.md §3.2, "Edits as column
//  ops — GridEdit"; enumerated by Phase 2500): this host decodes every vector's
//  GridEdit with its own codec, applies it, derives the row delta, inverts it
//  and restores the table, and runs the three scripted histories through its
//  own edit history. Every answer is compared after decoding, through this
//  host's canonical encoders — the family pins behaviour, not file framing.
// ============================================================================

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { Table } from '@fuaran-ui/schema';

import { decodeDataSource } from '../src/decode.js';
import { encodeDataSource, renderAstCanonical } from '../src/encode.js';
import {
  applyColumnOp,
  decodeColumnOpJson,
  decodeGridEdit,
  decodeGridEditJson,
  deltaOf,
  encodeColumnOp,
  encodeGridEdit,
  encodeTableDelta,
  GridEditHistory,
  invertColumnOp,
  type GridEdit,
  type HistoryResult,
} from '../src/gridEdit.js';
import { parse, type JsonAst } from '../src/parse.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const familyRoot = join(wireCorpusRoot(), 'grid-edit');
const present = existsSync(join(familyRoot, 'manifest.json'));

const ast = (value: unknown): JsonAst => {
  const r = parse(JSON.stringify(value));
  if (!r.ok) throw new Error('not json');
  return r.value;
};

const tableOf = (value: unknown): Table => {
  const r = decodeDataSource(ast(value));
  if (!r.ok || r.value.kind !== 'Embedded')
    throw new Error(`not an embedded table: ${JSON.stringify(value)}`);
  return r.value.table;
};

const tableText = (t: Table): string => encodeDataSource({ kind: 'Embedded', table: t });

const editOf = (value: unknown): GridEdit => {
  const r = decodeGridEditJson(ast(value));
  if (!r.ok) throw new Error(r.error);
  return r.value;
};

const opText = (value: unknown): string => {
  const r = decodeColumnOpJson(ast(value));
  if (!r.ok) throw new Error(r.error);
  return encodeColumnOp(r.value);
};

/** A delta is compared in its canonical form (rows in key order, sorted members). */
const deltaText = (value: unknown): string => renderAstCanonical(ast(value));

/** What this host answers for one vector, in the vector's own shape. */
const answer = (table: Table, edit: GridEdit): Record<string, string | boolean> => {
  const applied = applyColumnOp(edit.op, table);
  if (!applied.ok) return { refused: applied.refusal };
  const out: Record<string, string | boolean> = { after: tableText(applied.value) };
  if (edit.rowKeyField === undefined) {
    out['delta'] = encodeTableDelta({ kind: 'fullRefresh' });
    out['referencePath'] = 'noRowIdentityDeclared';
  } else {
    out['delta'] = encodeTableDelta(deltaOf(edit.rowKeyField, table, edit.op));
  }
  const inverse = invertColumnOp(edit.op, table);
  if (inverse.ok) {
    const undone = applyColumnOp(inverse.value, applied.value);
    if (!undone.ok) throw new Error(`the inverse refused: ${undone.refusal}`);
    out['inverse'] = encodeColumnOp(inverse.value);
    out['undone'] = tableText(undone.value);
  } else {
    out['notInvertible'] = true;
  }
  return out;
};

/** The vector's expected answer, normalised through this host's decoders and encoders. */
const expectedOf = (e: Record<string, unknown>): Record<string, string | boolean> => {
  const out: Record<string, string | boolean> = {};
  for (const [k, v] of Object.entries(e)) {
    if (k === 'after' || k === 'undone') out[k] = tableText(tableOf(v));
    else if (k === 'inverse') out[k] = opText(v);
    else if (k === 'delta') out[k] = deltaText(v);
    else out[k] = v as string | boolean;
  }
  return out;
};

interface Vector {
  readonly id: string;
  readonly input: { readonly edit: unknown; readonly table: unknown };
  readonly expected: Record<string, unknown>;
}

type Gesture = { readonly edit: unknown } | { readonly undo: true } | { readonly redo: true };

interface History {
  readonly id: string;
  readonly input: { readonly gestures: readonly Gesture[]; readonly table: unknown };
  readonly expected: { readonly steps: readonly Record<string, unknown>[] };
}

interface Family {
  readonly vectors: readonly Vector[];
  readonly histories: readonly History[];
}

const family: Family | undefined = present
  ? (JSON.parse(readFileSync(join(familyRoot, 'grid-edit-vectors.json'), 'utf8')) as Family)
  : undefined;

describe.skipIf(!present)('grid-edit vectors (the corpus family)', () => {
  it('the manifest names the vectors file', () => {
    const manifest = JSON.parse(readFileSync(join(familyRoot, 'manifest.json'), 'utf8')) as {
      files: string[];
    };
    expect(manifest.files).toEqual(['grid-edit-vectors.json']);
    expect(family!.vectors.length).toBeGreaterThanOrEqual(15);
    expect(family!.histories.length).toBeGreaterThanOrEqual(3);
  });

  for (const v of family?.vectors ?? []) {
    it(`vector ${v.id}`, () => {
      const edit = editOf(v.input.edit);
      // The codec: what this host decodes, it re-encodes to the bytes the corpus carries.
      expect(encodeGridEdit(edit)).toBe(renderAstCanonical(ast(v.input.edit)));
      expect(answer(tableOf(v.input.table), edit)).toEqual(expectedOf(v.expected));
    });
  }

  for (const h of family?.histories ?? []) {
    it(`history ${h.id}`, () => {
      let history = GridEditHistory.create(tableOf(h.input.table));
      const steps = h.input.gestures.map((g) => {
        const r: HistoryResult =
          'edit' in g
            ? history.apply(editOf(g.edit).op)
            : 'undo' in g
              ? history.undo()
              : history.redo();
        if (!r.ok) return { refused: r.refusal };
        history = r.history;
        return {
          canRedo: history.canRedo,
          canUndo: history.canUndo,
          table: tableText(history.table),
        };
      });
      const expected = h.expected.steps.map((s) =>
        'refused' in s ? s : { ...s, table: tableText(tableOf(s['table'])) },
      );
      expect(steps).toEqual(expected);
    });
  }
});

describe('the GridEdit codec refuses what it could not apply faithfully', () => {
  const refused: readonly (readonly [string, string])[] = [
    [
      '{"$type":"GridEdit","key":"k","op":{"$type":"removeColumn","name":"x"},"extra":1}',
      'unknown member',
    ],
    ['{"$type":"GridEdit","key":"","op":{"$type":"removeColumn","name":"x"}}', 'empty key'],
    [
      '{"$type":"GridEdit","key":"k","op":{"$type":"removeColumn","name":"x"},"rowKeyField":""}',
      'empty field',
    ],
    [
      '{"$type":"GridEdit","key":"k","op":{"$type":"removeColumn","name":"x"},"rowKeyField":3}',
      'non-string field',
    ],
    ['{"$type":"GridEdit","key":"k"}', 'missing op'],
    ['{"$type":"GridEdit","key":"k","op":{"$type":"dropTable"}}', 'unknown op'],
    ['{"$type":"Edit","key":"k","op":{"$type":"removeColumn","name":"x"}}', 'wrong tag'],
    ['[1]', 'not an object'],
    ['{', 'not json'],
  ];
  for (const [text, why] of refused) {
    it(why, () => {
      expect(decodeGridEdit(text).ok).toBe(false);
    });
  }

  it('absence is how "no identity declared" is spelled — the member is omitted', () => {
    const edit = decodeGridEdit(
      '{"$type":"GridEdit","key":"orders","op":{"$type":"removeColumn","name":"note"}}',
    );
    expect(edit.ok && encodeGridEdit(edit.value)).toBe(
      '{"$type":"GridEdit","key":"orders","op":{"$type":"removeColumn","name":"note"}}',
    );
  });
});
