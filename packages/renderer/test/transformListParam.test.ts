// ============================================================================
//  @fuaran-ui/renderer — LIST-valued `Transform` params (Phase 610).
//
//  The multi-select chip end of the wiring, parity-locked with the F# renderer's
//  `TransformListParamTests`: a `filter` step holding an `in`/`param` membership
//  test over a param whose source resolves to a LIST scopes its rows by that
//  selection; the binding resolves by SUBSTITUTION (`substituteListParams`),
//  never through the scalar env; an EMPTY selection is UNBOUND and so PRUNES the
//  step ("nothing selected ⇒ no constraint", the multi-select twin of Phase 424's
//  unset-chip rule); and a kind mismatch in either direction reaches the
//  evaluator's strict `UnboundParam` rather than silently mis-scoping the rows.
// ============================================================================

import type { Binding, DataSource, Transform } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import type { BindingSources } from '../src/index.js';
import { resolve } from '../src/bindings.js';

const source: DataSource = {
  kind: 'Embedded',
  table: {
    schema: [
      { name: 'dept', type: 'string' },
      { name: 'amount', type: 'int' },
    ],
    columns: [
      {
        name: 'dept',
        type: 'string',
        cells: [
          { kind: 'Str', value: 'eng' },
          { kind: 'Str', value: 'eng' },
          { kind: 'Str', value: 'sales' },
        ],
      },
      {
        name: 'amount',
        type: 'int',
        cells: [
          { kind: 'Int', value: 100 },
          { kind: 'Int', value: 120 },
          { kind: 'Int', value: 90 },
        ],
      },
    ],
  },
};

/** `dept IN $depts` — the multi-select chip's membership test. */
const pipeline: readonly Transform[] = [
  {
    kind: 'filter',
    pred: { kind: 'inParam', expr: { kind: 'col', name: 'dept' }, param: 'depts' },
  },
];

const bindingFrom = (
  from: Binding<unknown>,
  steps: readonly Transform[] = pipeline,
): Binding<unknown> =>
  ({
    kind: 'Transform',
    source: { kind: 'Data', source },
    pipeline: steps,
    params: [{ name: 'depts', from }],
  }) as unknown as Binding<unknown>;

/**
 * The declarative chip wiring: the multi-select's `values` binding IS
 * `$filters.depts`, so its write-back stores the selection there and the param
 * reads the same name. No host code between them, and no handler on either side.
 */
const chipSourced = bindingFrom({ kind: 'Filter', name: 'depts' } as Binding<unknown>);

const rowsOf = (binding: Binding<unknown>, sources: BindingSources) => resolve(sources, binding);

const rowCount = (binding: Binding<unknown>, sources: BindingSources): number => {
  const r = rowsOf(binding, sources);
  if (r.kind !== 'Resolved') throw new Error(`expected Resolved, got ${JSON.stringify(r)}`);
  return (r.value as unknown[]).length;
};

describe('Phase 610 — list-valued Transform params', () => {
  it('a selection scopes the rows (dept IN $filters.depts)', () => {
    expect(rowCount(chipSourced, { filters: { depts: ['eng'] } })).toBe(2);
  });

  it('a wider selection widens the scope', () => {
    expect(rowCount(chipSourced, { filters: { depts: ['eng', 'sales'] } })).toBe(3);
  });

  it('an EMPTY selection prunes the step (nothing selected ⇒ no constraint)', () => {
    // The acceptance criterion: deselecting everything shows the UNFILTERED table,
    // not the empty one an `in []` membership test would produce.
    expect(rowCount(chipSourced, { filters: { depts: [] } })).toBe(3);
  });

  it('an unset chip prunes the step, exactly as an unset scalar chip does', () => {
    expect(rowCount(chipSourced, {})).toBe(3);
  });

  it('a selection of numbers scopes a numeric column', () => {
    const numeric: readonly Transform[] = [
      {
        kind: 'filter',
        pred: { kind: 'inParam', expr: { kind: 'col', name: 'amount' }, param: 'depts' },
      },
    ];
    expect(
      rowCount(bindingFrom({ kind: 'Filter', name: 'depts' } as Binding<unknown>, numeric), {
        filters: { depts: [100, 90] },
      }),
    ).toBe(2);
  });

  it('a LIST bound to a name the pipeline reads as a SCALAR param is loud, not silent', () => {
    // Substitution binds `in`/`param` occurrences only, so the scalar `param` reaches
    // the evaluator unbound. The evaluator stays strict; the host does not guess.
    const scalarPipeline: readonly Transform[] = [
      {
        kind: 'filter',
        pred: {
          kind: 'binary',
          op: 'eq',
          left: { kind: 'col', name: 'dept' },
          right: { kind: 'param', name: 'depts' },
        },
      },
    ];
    const r = rowsOf(
      bindingFrom({ kind: 'Filter', name: 'depts' } as Binding<unknown>, scalarPipeline),
      { filters: { depts: ['eng'] } },
    );
    expect(r.kind).toBe('Errored');
  });

  it('a param source resolving to a nested array is still the loud non-scalar error', () => {
    const r = rowsOf(chipSourced, { filters: { depts: [['eng']] } });
    expect(r.kind).toBe('Errored');
    if (r.kind === 'Errored') expect(r.message).toContain('non-scalar');
  });
});
