// ============================================================================
//  DAG-record wire-format conformance (Phase 178) — Leg B (TS == corpus).
//
//  Loads the additive workspace `wire-format-fixtures/dag/` corpus and asserts
//  the TS DAG codec reproduces the F# `DagWire.encodeRecord` bytes exactly:
//   - decode(input) succeeds, AND
//   - encode(decode(input)) is byte-identical to the committed payload.
//
//  Together with the F# Leg A (Fuaran.UI.OpStream.Dag.Tests ConformanceTests),
//  this proves F# == TS byte-for-byte for the DAG record wire shape.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { decodeDagRecord, encodeDagRecord } from '../src/index.js';

const here = dirname(fileURLToPath(import.meta.url));
// packages/ops/test → workspace-root/wire-format-fixtures/dag
const dagRoot = join(here, '..', '..', '..', '..', 'wire-format-fixtures', 'dag');

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
});
