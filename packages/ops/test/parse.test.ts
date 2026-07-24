// Hand-rolled parser unit tests — the number-edge sentinels, key-order
// tolerance, and structural error reporting that motivate the hand-roll over
// JSON.parse (WIRE_FORMAT.md §2 / §7).

import { describe, expect, it } from 'vitest';

import { parse } from '../src/parse.js';

describe('parse — hand-rolled JSON AST', () => {
  it('parses an empty object and array', () => {
    const o = parse('{}');
    expect(o.ok).toBe(true);
    if (o.ok) expect(o.value.kind).toBe('JObject');
    const a = parse('[]');
    if (a.ok) expect(a.value.kind).toBe('JArray');
  });

  it('keeps number-edge sentinels as JString (decoded to specials downstream)', () => {
    const r = parse('"NaN"');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'JString') expect(r.value.value).toBe('NaN');
  });

  it('is key-order tolerant — fields land in a Map keyed by name', () => {
    const r = parse('{"b":1,"a":2}');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'JObject') {
      expect(r.value.fields.get('a')).toEqual({ kind: 'JNumber', value: 2 });
      expect(r.value.fields.get('b')).toEqual({ kind: 'JNumber', value: 1 });
    }
  });

  it('reports empty input as a structural error', () => {
    const r = parse('');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.offset).toBe(0);
  });

  it('reports a truncated object with an offset', () => {
    const r = parse('{"a":');
    expect(r.ok).toBe(false);
  });

  it('decodes the standard escape set', () => {
    const r = parse('"a\\"b\\\\c\\n"');
    expect(r.ok).toBe(true);
    if (r.ok && r.value.kind === 'JString') expect(r.value.value).toBe('a"b\\c\n');
  });
});
