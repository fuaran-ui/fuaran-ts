// ============================================================================
//  Phase 1909 — grid column rules follow the cell kind, over the corpus.
//
//  An ACTION column (cell kind `Button` / `ButtonGroup`) draws its own label
//  and never displays a field, so it carries none: a declared one earns the
//  FUARAN163 "drop it" warning (`ACTION_COLUMN_FIELD`) and never FUARAN114. A
//  `TonedPill` cell's own `field` IS a column reference, grounded as FUARAN114's
//  sub-case (`GRID_PILL_FIELD_UNGROUNDED`). The reference host asserts the same
//  expectations over the same three files (its `GridColumnKindTests`), with the
//  same paths.
//
//  Probed in both directions: the last case repairs each negative and asserts
//  the finding clears.
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

const text = (stem: string): string => readFileSync(join(nodesDir, `${stem}.json`), 'utf8');

const fixture = (stem: string): Node<unknown> => decodeText(stem, text(stem));

const defectsOf = (tree: Node<unknown>): readonly PreEmitDefect[] => {
  const r = preEmitValidate(tree);
  return r.ok ? [] : r.error;
};

const report = (tree: Node<unknown>) => bindingChecks(tree, JSON.parse(encodeNode(tree)));

describe('Phase 1909 — grid column rules follow the cell kind (corpus)', () => {
  it('grid-action-column-clean: field-less action columns and a grounded pill, clean and Checked', () => {
    const tree = fixture('grid-action-column-clean');
    expect(defectsOf(tree)).toEqual([]);
    const checks = report(tree);
    expect(checks.map((c) => c.grade)).toEqual([{ kind: 'Checked' }]);
    expect(checks.flatMap((c) => c.diagnostics)).toEqual([]);
  });

  it('grid-action-column-field: ACTION_COLUMN_FIELD (FUARAN163) is the only finding, and no FUARAN114', () => {
    const tree = fixture('grid-action-column-field');
    expect(defectsOf(tree)).toEqual([
      {
        code: 'ACTION_COLUMN_FIELD',
        nodeId: 'grid-action-column-field',
        columnLabel: 'Actions',
        field: 'action',
      },
    ]);
    expect(report(tree).flatMap((c) => c.diagnostics)).toEqual([]);
  });

  it("grid-toned-pill-ungrounded: FUARAN114's pill sub-case, located at the cell's own field", () => {
    const tree = fixture('grid-toned-pill-ungrounded');
    expect(defectsOf(tree)).toEqual([
      {
        code: 'GRID_PILL_FIELD_UNGROUNDED',
        nodeId: 'grid-toned-pill-ungrounded',
        columnLabel: 'Status',
        field: 'status',
        schemaColumns: ['dept', 'total'],
      },
    ]);
    expect(
      report(tree).flatMap((c) => c.diagnostics.map((d): [string, string] => [d.code, d.path])),
    ).toEqual([['FUARAN114', '$.kind.columns[1].kind.field']]);
  });

  it('the probe runs the other way: repairing either negative clears it', () => {
    const dropped = decodeText(
      'dropped',
      text('grid-action-column-field').replace('"field":"action",', ''),
    );
    expect(defectsOf(dropped)).toEqual([]);
    const renamed = decodeText(
      'renamed',
      text('grid-toned-pill-ungrounded').replace('"field":"status"', '"field":"dept"'),
    );
    expect(defectsOf(renamed)).toEqual([]);
  });
});
