// ============================================================================
//  Phase 1962 — a multi-select `Select` carries `values` and no `value`
//  (WIRE_FORMAT.md, "`Select` multi-select").
//
//  The corpus certifies the three headline cases (the clean multi-select, the
//  placeholder lenient accept, the two refusals); this file pins what a
//  document corpus does not: a malformed `multiple` does not also demand
//  `value`, and inside a §29 defect walk the bound-`value` refusal is reported
//  beside the select's other independent defects.
// ============================================================================

import { describe, expect, it } from 'vitest';

import { decodeNode, decodeNodeWithDefects, encodeNode } from '../src/index.js';

const SRC = '"source":{"$type":"Static","value":[{"label":"Red","value":"red"}]}';
const sel = (rest: string): string =>
  `{"id":"x","kind":{"$type":"Select","label":"Tags",${SRC}${rest}}}`;

describe('Phase 1962 — the Select value rule', () => {
  it('a multi-select without value round-trips without value', () => {
    const wire =
      '{"id":"x","kind":{"$type":"Select","label":"Tags","multiple":true,' +
      `${SRC},"values":{"$type":"State","key":"tags"}}}`;
    const d = decodeNode(wire);
    expect(d.ok).toBe(true);
    if (d.ok) expect(encodeNode(d.value)).toBe(wire);
  });

  it('a multi-select placeholder value (null form) is normalised away', () => {
    const d = decodeNode(
      sel(
        ',"multiple":true,"value":{"$type":"Static","value":null},"values":{"$type":"State","key":"t"}',
      ),
    );
    expect(d.ok).toBe(true);
    if (d.ok) expect(encodeNode(d.value)).not.toContain('"value":{"$type":"Static"');
  });

  it('a non-empty Static value on a multi-select is WRONG_TYPE at value', () => {
    const d = decodeNode(sel(',"multiple":true,"value":{"$type":"Static","value":"red"}'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect([d.error.code, d.error.path]).toEqual(['WRONG_TYPE', '$.kind.value']);
  });

  it('"multiple": false is a single-select and still requires value', () => {
    const d = decodeNode(sel(',"multiple":false'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect([d.error.code, d.error.path]).toEqual(['MISSING_FIELD', '$.kind.value']);
  });

  it('a malformed multiple is its own defect and does not demand value', () => {
    const r = decodeNodeWithDefects(sel(',"multiple":"yes"'));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.map((e) => [e.code, e.path])).toEqual([['WRONG_TYPE', '$.kind.multiple']]);
  });

  it('the bound-value refusal is reported beside the select’s other defects', () => {
    const r = decodeNodeWithDefects(
      sel(',"multiple":true,"value":{"$type":"State","key":"tag"},"values":7'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const pairs = r.error.map((e) => [e.code, e.path]);
      expect(pairs).toContainEqual(['WRONG_TYPE', '$.kind.value']);
      expect(pairs.some(([, p]) => p === '$.kind.values')).toBe(true);
    }
  });
});
