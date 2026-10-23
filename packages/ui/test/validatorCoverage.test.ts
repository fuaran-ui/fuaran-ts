// ============================================================================
//  @fuaran-ui/ui — the coverage declaration against what the validator raises
//  (Phase 2418).
//
//  The specification's coverage gate compares each host's
//  `validator-coverage.json` to the canonical defect vocabulary; it reads JSON,
//  not code, so it cannot tell whether a host raises what it declares. This
//  suite closes that for this host, which is what `machineChecked: true`
//  asserts. It is possible because the FUARAN code is a value
//  (`PRE_EMIT_FUARAN_CODES`, typed over every `PreEmitDefect` discriminant), so
//  the set of codes the validator can raise is read off the table rather than
//  off message prose or comments.
// ============================================================================

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { fuaranCodeOf, PRE_EMIT_FUARAN_CODES } from '../src/index.js';

interface CoverageDeclaration {
  readonly implemented: readonly string[];
  readonly abstained?: Readonly<Record<string, string>>;
  readonly machineChecked: boolean;
}

const declaration = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../../../validator-coverage.json', import.meta.url)),
    'utf-8',
  ),
) as CoverageDeclaration;

const raised = new Set<string>(Object.values(PRE_EMIT_FUARAN_CODES));
const declared = new Set(declaration.implemented);

describe('validator-coverage.json is checked against the raised codes (Phase 2418)', () => {
  // If this drops to false, the checks below are no longer load-bearing.
  it('the declaration claims machineChecked', () => {
    expect(declaration.machineChecked).toBe(true);
  });

  it('every code the validator can raise is declared implemented', () => {
    expect([...raised].filter((c) => !declared.has(c)).sort()).toEqual([]);
  });

  it('every code declared implemented is one the validator can raise', () => {
    expect([...declared].filter((c) => !raised.has(c)).sort()).toEqual([]);
  });

  it('no code is both implemented and abstained', () => {
    const abstained = Object.keys(declaration.abstained ?? {});
    expect(abstained.filter((c) => declared.has(c)).sort()).toEqual([]);
  });

  it('a finding reads its code as a value', () => {
    expect(fuaranCodeOf({ code: 'EMPTY_NODE_ID' })).toBe('FUARAN-EMPTY-ID');
    expect(
      fuaranCodeOf({
        code: 'GRID_PILL_FIELD_UNGROUNDED',
        nodeId: 'g',
        columnLabel: 'c',
        field: 'f',
        schemaColumns: [],
      }),
    ).toBe('FUARAN114');
  });
});
