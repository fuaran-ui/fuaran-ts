// ============================================================================
//  Phase 1962 — a multi-select `Select` carries `values` and no `value`
//  (WIRE_FORMAT.md, "`Select` multi-select").
//
//  The corpus certifies the headline cases (the clean multi-select, the
//  dropped-`value` lenient accept, the single-select refusal); this file pins
//  what a document corpus does not: a malformed `multiple` does not also
//  demand `value`, and a MALFORMED `value` on a multi-select still refuses
//  like any malformed binding before the drop.
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

  it('a well-formed bound value on a multi-select is decoded, then dropped', () => {
    for (const v of [
      '{"$type":"Static","value":"red"}',
      '{"$type":"State","defaultValue":"red","key":"tag"}',
    ]) {
      const d = decodeNode(
        sel(`,"multiple":true,"value":${v},"values":{"$type":"State","key":"t"}`),
      );
      expect(d.ok).toBe(true);
      if (d.ok) expect(encodeNode(d.value)).not.toContain('"value":{');
    }
  });

  it('a malformed value on a multi-select still refuses', () => {
    const d = decodeNode(sel(',"multiple":true,"value":{"$type":"Nope"}'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.error.path.startsWith('$.kind.value')).toBe(true);
  });

  it('"multiple": false is a single-select and still requires value', () => {
    const d = decodeNode(sel(',"multiple":false'));
    expect(d.ok).toBe(false);
    if (!d.ok) expect([d.error.code, d.error.path]).toEqual(['MISSING_FIELD', '$.kind.value']);
  });

  // Phase 1962 amendment — `multiple` is emitted AS AUTHORED, never
  // omit-at-default: absent stays absent, an explicit false and true are kept.
  it('multiple round-trips as authored: absent vs false vs true', () => {
    // Keys in canonical (sorted) order, so the re-encode is byte-comparable.
    const canon = (multiple: string, tail: string): string =>
      `{"id":"x","kind":{"$type":"Select","label":"Tags",${multiple}${SRC},${tail}}}`;
    const value = '"value":{"$type":"Static","value":"red"}';
    const values = '"values":{"$type":"State","key":"tags"}';
    for (const [wire, expected] of [
      [canon('', value), undefined],
      [canon('"multiple":false,', value), false],
      [canon('"multiple":true,', values), true],
    ] as const) {
      const d = decodeNode(wire);
      expect(d.ok).toBe(true);
      if (!d.ok) continue;
      const kind = d.value.kind as { kind: string; input?: { spec?: { multiple?: boolean } } };
      expect(kind.input?.spec?.multiple).toBe(expected);
      expect(encodeNode(d.value)).toBe(wire);
    }
  });

  it('a malformed multiple is its own defect and does not demand value', () => {
    const r = decodeNodeWithDefects(sel(',"multiple":"yes"'));
    expect(r.ok).toBe(false);
    if (!r.ok)
      expect(r.error.map((e) => [e.code, e.path])).toEqual([['WRONG_TYPE', '$.kind.multiple']]);
  });

  it('a dropped multi-select value raises no defect beside the select’s real ones', () => {
    const r = decodeNodeWithDefects(
      sel(',"multiple":true,"value":{"$type":"State","key":"tag"},"values":7'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const paths = r.error.map((e) => e.path);
      expect(paths).not.toContain('$.kind.value');
      expect(paths.some((p) => p.startsWith('$.kind.values'))).toBe(true);
    }
  });
});
