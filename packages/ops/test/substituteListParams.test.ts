// ============================================================================
//  `substituteListParams` — the TS mirror of Core `Transform.substituteListParams`
//  (fuaran-core#91 / Phase 610).
//
//  A LIST param resolves by SUBSTITUTION, not through the evaluation env: a bound
//  `inParam` is rewritten to the literal `in` form before evaluation, an unbound one
//  is left intact so the host's `stepParams` prune still sees it naming its own param,
//  and the rewrite reaches every nested sub-expression.
// ============================================================================

import type { Cell, Transform } from '@fuaran-ui/schema';
import { describe, expect, it } from 'vitest';

import { pipelineParams, substituteListParams } from '../src/dataframe.js';

const S = (s: string): Cell => ({ kind: 'Str', value: s });

const membership = (param: string, col = 'dept'): Transform => ({
  kind: 'filter',
  pred: { kind: 'inParam', expr: { kind: 'col', name: col }, param },
});

describe('substituteListParams', () => {
  it('rewrites a bound inParam to the literal in form', () => {
    const out = substituteListParams({ depts: [S('eng')] }, [membership('depts')]);
    expect(out).toEqual([
      {
        kind: 'filter',
        pred: {
          kind: 'in',
          expr: { kind: 'col', name: 'dept' },
          items: [{ kind: 'lit', cell: S('eng') }],
        },
      },
    ]);
  });

  it('a substituted step names no param, so the prune leaves it alone', () => {
    const out = substituteListParams({ depts: [S('eng')] }, [membership('depts')]);
    expect(pipelineParams(out)).toEqual([]);
  });

  it('leaves an UNBOUND inParam intact, so the prune still catches it', () => {
    const out = substituteListParams({ other: [S('eng')] }, [membership('depts')]);
    expect(out).toEqual([membership('depts')]);
    expect(pipelineParams(out)).toEqual(['depts']);
  });

  it('reaches a nested sub-expression and leaves a scalar param untouched', () => {
    const nested: Transform = {
      kind: 'filter',
      pred: {
        kind: 'binary',
        op: 'and',
        left: {
          kind: 'not',
          expr: { kind: 'inParam', expr: { kind: 'col', name: 'dept' }, param: 'depts' },
        },
        right: {
          kind: 'binary',
          op: 'eq',
          left: { kind: 'col', name: 'region' },
          right: { kind: 'param', name: 'region' },
        },
      },
    };
    const out = substituteListParams({ depts: [S('ops')] }, [nested]);
    // The list param is gone; the SCALAR param survives for the env to bind.
    expect(pipelineParams(out)).toEqual(['region']);
  });

  it('leaves a step carrying no ColExpr unchanged', () => {
    const steps: readonly Transform[] = [{ kind: 'limit', n: 3, offset: 0 }, { kind: 'distinct' }];
    expect(substituteListParams({ depts: [S('eng')] }, steps)).toEqual(steps);
  });
});
