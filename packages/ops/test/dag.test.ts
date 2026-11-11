// ============================================================================
//  DAG-record wire-format conformance (Phase 178) — Leg B (TS == corpus).
//
//  Loads the additive workspace `wire-format-fixtures/dag/` corpus and asserts
//  the TS DAG codec reproduces the F# `DagWire.encodeRecord` bytes exactly:
//   - decode(input) succeeds, AND
//   - encode(decode(input)) is byte-identical to the committed payload.
//
//  Together with the F# Leg A (Fuaran.UI.OpStream.Dag.Tests ConformanceTests),
//  this proves F# == TS byte-for-byte for the DAG record wire shape. Since
//  Phase 2645 the records are Core DAG nodes (a merge node's op is its script as
//  a Batch) and a pre-2645 record is refused by name (fuaran#2646).
// ============================================================================

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { decodeDagRecord, encodeDagRecord } from '../src/index.js';

import { wireCorpusRoot } from '../../../dev-scripts/corpus-root.mjs';

const dagRoot = join(wireCorpusRoot(), 'dag');

interface ManifestFixture {
  readonly id: string;
  readonly kind: 'dag-record-round-trip';
  readonly inputFile: string;
  readonly expectedFile: string;
  readonly description: string;
}

interface Manifest {
  readonly version: number;
  readonly description: string;
  readonly fixtures: readonly ManifestFixture[];
}

const read = (rel: string): string => readFileSync(join(dagRoot, rel), 'utf8');
const manifest = JSON.parse(read('manifest.json')) as Manifest;

describe('DAG record wire-format conformance (TS == corpus)', () => {
  for (const fx of manifest.fixtures) {
    it(`${fx.id}: ${fx.description}`, () => {
      const input = read(fx.inputFile).replace(/\n$/, '');
      const expected = read(fx.expectedFile).replace(/\n$/, '');

      const decoded = decodeDagRecord(input);
      expect(decoded.ok, decoded.ok ? '' : `decode failed: ${decoded.error}`).toBe(true);
      if (!decoded.ok) return;

      // encode(decode(input)) is byte-identical to the F# canonical form.
      expect(encodeDagRecord(decoded.value)).toBe(expected);
    });
  }

  // Phase 1144. The pre-1144 envelope is refused BY NAME, not lifted: the actor
  // is inside the content address, so a lifted record would carry a `hash` no
  // host can reproduce — a silent verification failure instead of a clear
  // refusal. This is the go-red proof for that refusal.
  it('refuses a pre-1144 userId envelope by name', () => {
    const legacy =
      '{"hash":"' +
      'a'.repeat(64) +
      '","op":{"$type":"RemoveNode","target":"n1"},"parents":[],' +
      '"resultEnvelope":{"$type":"Success"},"streamId":"s1","timestamp":1700000000,' +
      '"userId":"u1"}';

    const decoded = decodeDagRecord(legacy);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain('userId');
    expect(decoded.error).toContain('do not carry forward');
  });

  it('refuses an actor whose kind is unknown', () => {
    const bad =
      '{"actor":{"kind":"robot","id":"r1"},"hash":"' +
      'a'.repeat(64) +
      '","op":{"$type":"RemoveNode","target":"n1"},"parents":[],' +
      '"resultEnvelope":{"$type":"Success"},"streamId":"s1","timestamp":1700000000}';

    const decoded = decodeDagRecord(bad);
    expect(decoded.ok).toBe(false);
    if (decoded.ok) return;
    expect(decoded.error).toContain('actor');
  });

  // Phase 2645 retired `outcomeHash` and `tombstoned`: a record carrying either
  // is a pre-2645 record whose address does not recompute, refused by name.
  for (const [member, extra] of [
    ['tombstoned', '"tombstoned":false'],
    ['outcomeHash', '"outcomeHash":"o1"'],
  ] as const) {
    it(`refuses a pre-2645 record carrying ${member}`, () => {
      const post =
        '{"actor":{"kind":"human","id":"u1"},"hash":"' +
        'a'.repeat(64) +
        '","op":{"$type":"RemoveNode","target":"n1"},"parents":[],' +
        '"resultEnvelope":{"$type":"Success"},"streamId":"s1","timestamp":1700000000';
      const decoded = decodeDagRecord(`${post},${extra}}`);
      expect(decoded.ok).toBe(false);
      if (decoded.ok) return;
      expect(decoded.error).toContain('pre-2645');
      expect(decoded.error).toContain('do not carry forward');
      expect(decodeDagRecord(`${post}}`).ok).toBe(true);
    });
  }

  it('a merge node carries its script as a Batch', () => {
    for (const [file, ops] of [
      ['dag-merge.json', 0],
      ['dag-merge-script.json', 1],
    ] as const) {
      const decoded = decodeDagRecord(read(file).replace(/\n$/, ''));
      expect(decoded.ok).toBe(true);
      if (!decoded.ok) return;
      expect(decoded.value.parents).toHaveLength(2);
      expect(decoded.value.op.kind).toBe('Batch');
      if (decoded.value.op.kind === 'Batch') expect(decoded.value.op.ops).toHaveLength(ops);
    }
  });
});
