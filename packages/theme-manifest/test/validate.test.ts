// ============================================================================
//  Phase 2133 — theme-manifest invariants are validated, not decoded strictly.
//
//  The decoder stays tolerant (the byte law omits a member at its default); the
//  validation pass asks what the decoded values mean, with the shared code table
//  of the corpus's WIRE_FORMAT §13. The corpus's `manifest-validation` vectors
//  are certified with the rest of the style-observer family
//  (`packages/style-observer/test/corpusConformance.test.ts`); these are this
//  host's go-red partners, one per rule.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  type ThemeManifest,
  decodeManifest,
  encodeManifest,
  encodeManifestDefect,
  merge,
  validateManifest,
} from '../src/index.js';

const decodeOk = (json: string): ThemeManifest => {
  const r = decodeManifest(json);
  if (!r.ok) throw new Error(`decode failed: ${JSON.stringify(r)}`);
  return r.value;
};

const invariants = (json: string): ThemeManifest =>
  decodeOk(`{"tokens":{},"invariants":[${json}]}`);

const defects = (m: ThemeManifest): string[] => validateManifest(m).map(encodeManifestDefect);

describe('unknown invariant kinds are kept (Phase 2133)', () => {
  it('round-trips an unknown kind with its members and weight', () => {
    const m = decodeOk(
      '{"invariants":[{"kind":"FocusRing","minWidthPx":2,"nested":{"b":1,"a":[true,"s",null]},"weight":3}],"tokens":{}}',
    );
    expect(m.invariants).toEqual([
      {
        kind: {
          kind: 'Unknown',
          name: 'FocusRing',
          members: { minWidthPx: 2, nested: { b: 1, a: [true, 's', null] } },
        },
        weight: 3,
      },
    ]);
    expect(encodeManifest(m)).toBe(
      '{"invariants":[{"kind":"FocusRing","minWidthPx":2,"nested":{"a":[true,"s",null],"b":1},"weight":3}],"tokens":{}}',
    );
  });

  it('still drops an object with no non-empty string kind', () => {
    expect(invariants('{"role":"x","minRatio":7}').invariants).toEqual([]);
    expect(invariants('{"kind":"","role":"x"}').invariants).toEqual([]);
  });

  it('merge keeps unknown invariants and de-duplicates identical ones', () => {
    const a = invariants('{"kind":"FocusRing","minWidthPx":2}');
    const b = invariants('{"kind":"FocusRing","minWidthPx":2},{"kind":"FocusRing","minWidthPx":3}');
    expect(merge(a, b).invariants).toHaveLength(2);
  });
});

describe('validateManifest (Phase 2133)', () => {
  it('flags the omitted-default floor as out of range, and its unbound role', () => {
    expect(defects(invariants('{"kind":"ContrastFloor","role":"x"}'))).toEqual([
      '{"code":"CONTRAST_FLOOR_OUT_OF_RANGE","index":0,"subject":"x"}',
      '{"code":"CONTRAST_FLOOR_ROLE_UNBOUND","index":0,"subject":"x"}',
    ]);
  });

  it('holds the floor to [1, 21], inclusive', () => {
    const floor = (ratio: string): string[] => {
      const m = invariants(`{"kind":"ContrastFloor","role":"Brand","minRatio":${ratio}}`);
      return defects({ ...m, roles: [{ role: { kind: 'Tone', tone: 'Brand' }, tokenName: 't' }] });
    };
    const out = ['{"code":"CONTRAST_FLOOR_OUT_OF_RANGE","index":0,"subject":"Brand"}'];
    expect(floor('0.5')).toEqual(out);
    expect(floor('21.5')).toEqual(out);
    expect(floor('1')).toEqual([]);
    expect(floor('21')).toEqual([]);
  });

  it('reports an empty role as empty and an unbound one as unbound', () => {
    expect(defects(invariants('{"kind":"ContrastFloor","minRatio":7}'))).toEqual([
      '{"code":"CONTRAST_FLOOR_ROLE_EMPTY","index":0,"subject":""}',
    ]);
    const m = invariants('{"kind":"ContrastFloor","minRatio":7,"role":"body-text"}');
    expect(defects(m)).toEqual([
      '{"code":"CONTRAST_FLOOR_ROLE_UNBOUND","index":0,"subject":"body-text"}',
    ]);
    expect(
      defects({ ...m, roles: [{ role: { kind: 'Named', name: 'body-text' }, tokenName: 't' }] }),
    ).toEqual([]);
  });

  it('reports a budget on an undeclared token, and an unknown kind by index', () => {
    expect(
      defects(invariants('{"kind":"UsageBudget","targetPct":10,"token":"color.ghost"}')),
    ).toEqual(['{"code":"USAGE_BUDGET_TOKEN_UNDECLARED","index":0,"subject":"color.ghost"}']);
    expect(
      defects(invariants('{"kind":"MotionVoice"},{"kind":"FocusRing","minWidthPx":2}')),
    ).toEqual(['{"code":"INVARIANT_KIND_UNKNOWN","index":1,"subject":"FocusRing"}']);
  });
});
