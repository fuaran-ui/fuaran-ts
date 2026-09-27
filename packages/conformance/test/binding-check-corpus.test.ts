// ============================================================================
//  Phase 1889 — charts and grids checked against their data, over the corpus.
//
//  `nodes/binding-check-*.json` are six legal documents that round-trip
//  byte-identically, so the node-round-trip family certifies the codec and
//  says nothing about any of this. What they pin is what a host's pre-emit
//  validator DOES with them — here, `preEmitValidate` and its located report
//  `bindingChecks`. The reference host asserts the same expectations over the
//  same files (its `BindingCheckCorpusTests`), with the same paths.
//
//  Probed in both directions: the last case repairs a broken reference and
//  asserts the finding clears while the reader is still judged, so none of
//  this can pass on a report that finds everything or judges nothing.
// ============================================================================

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { decodeNode, encodeNode } from '@fuaran-ui/ops';
import { bindingChecks, preEmitValidate, type PreEmitDefect } from '@fuaran-ui/ui';
import { describe, expect, it } from 'vitest';

import type { Node } from '@fuaran-ui/schema';

const here = dirname(fileURLToPath(import.meta.url));

/** The bundled snapshot — always present, so these assertions never skip. */
const nodesDir = join(here, '..', 'corpus', 'nodes');

const decodeText = (name: string, text: string): Node<unknown> => {
  const decoded = decodeNode(text);
  if (!decoded.ok) throw new Error(`${name} failed to decode: ${JSON.stringify(decoded.error)}`);
  return decoded.value;
};

const fixture = (stem: string): Node<unknown> =>
  decodeText(stem, readFileSync(join(nodesDir, `${stem}.json`), 'utf8'));

const defectsOf = (tree: Node<unknown>): readonly PreEmitDefect[] => {
  const r = preEmitValidate(tree);
  return r.ok ? [] : r.error;
};

const report = (tree: Node<unknown>) => bindingChecks(tree, JSON.parse(encodeNode(tree)));

const located = (tree: Node<unknown>): [string, string][] =>
  report(tree).flatMap((c) => c.diagnostics.map((d): [string, string] => [d.code, d.path]));

const producedByGroupBy = [
  { name: 'dept', type: 'string' },
  { name: 'total', type: 'int' },
];

describe('Phase 1889 — charts and grids checked against their data (corpus)', () => {
  it('the control is clean outright and both readers grade Checked, with the produced schema', () => {
    const tree = fixture('binding-check-control');
    expect(defectsOf(tree)).toEqual([]);
    const checks = report(tree);
    expect(checks.map((c) => [c.nodeId, c.reader, c.path, c.grade])).toEqual([
      ['spend-chart', 'Chart', '$.kind.children[0].kind.source', { kind: 'Checked' }],
      ['spend-grid', 'DataGrid', '$.kind.children[1].kind.source', { kind: 'Checked' }],
    ]);
    for (const c of checks) {
      expect(c.produced).toEqual(producedByGroupBy);
      expect(c.diagnostics).toEqual([]);
    }
  });

  it('FUARAN086 — a yFields entry the pipeline renamed away, at its slot', () => {
    const tree = fixture('binding-check-chart-ungrounded');
    expect(defectsOf(tree)).toEqual([
      {
        code: 'CHART_FIELD_UNGROUNDED',
        nodeId: 'binding-check-chart-ungrounded',
        field: 'amount',
        schemaColumns: ['dept', 'total'],
      },
    ]);
    expect(located(tree)).toEqual([['FUARAN086', '$.kind.yFields[0]']]);
  });

  it('FUARAN087 — a string column plotted as a value series, at its slot', () => {
    const tree = fixture('binding-check-chart-not-numeric');
    expect(defectsOf(tree)).toEqual([
      {
        code: 'CHART_FIELD_TYPE_MISMATCH',
        nodeId: 'binding-check-chart-not-numeric',
        field: 'dept',
        columnType: 'string',
      },
    ]);
    expect(located(tree)).toEqual([['FUARAN087', '$.kind.yFields[0]']]);
  });

  it('FUARAN097 — a temporal x-axis over a non-date column, at the xField', () => {
    const tree = fixture('binding-check-chart-temporal-not-date');
    expect(defectsOf(tree).map((d) => d.code)).toEqual(['CHART_TEMPORAL_X_NOT_DATE']);
    expect(located(tree)).toEqual([['FUARAN097', '$.kind.xField']]);
  });

  it('FUARAN114 — both arms, located through a container', () => {
    const tree = fixture('binding-check-grid-ungrounded');
    expect(defectsOf(tree).map((d) => d.code)).toEqual([
      'GRID_FIELD_UNGROUNDED',
      'GRID_FIELD_UNGROUNDED',
    ]);
    expect(located(tree)).toEqual([
      ['FUARAN114', '$.kind.children[0].kind.columns[1].field'],
      ['FUARAN114', '$.kind.children[0].kind.rowKeyField'],
    ]);
  });

  it('the unchecked document is refused nothing, and each grade says why', () => {
    const tree = fixture('binding-check-unchecked');
    expect(defectsOf(tree)).toEqual([]);
    const [chart, grid, ...rest] = report(tree);
    expect(rest).toEqual([]);
    expect(chart?.nodeId).toBe('spend-chart');
    expect(chart?.grade).toEqual({
      kind: 'Unchecked',
      reason: { kind: 'OpenSchema', why: "source 'spend' is a Ref with no declared schema" },
    });
    expect(grid?.grade).toEqual({
      kind: 'Unchecked',
      reason: { kind: 'NoStaticSchema', sourceKind: 'Query' },
    });
    expect(grid?.produced).toEqual([]);
  });

  it('the probe runs the other way: renaming the broken reference clears the finding', () => {
    const text = readFileSync(
      join(nodesDir, 'binding-check-chart-ungrounded.json'),
      'utf8',
    ).replace('"yFields":["amount"]', '"yFields":["total"]');
    const tree = decodeText('repaired', text);
    expect(defectsOf(tree)).toEqual([]);
    expect(report(tree).map((c) => c.grade)).toEqual([{ kind: 'Checked' }]);
  });
});
