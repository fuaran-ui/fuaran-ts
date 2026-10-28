// Phase 2207 — a schema entry's field metadata in this host's codec, past what the shared corpus's
// fieldLaws vectors pin: an extension key the object model would swallow, and the guarded encode's
// refusal of a unit that is not spelled canonically.
import { describe, expect, it } from 'vitest';

import type { DataSource } from '@fuaran-ui/schema';

import { decodeDataSource } from '../src/decode.js';
import { encodeDataSource, tryEncodeDataSource } from '../src/encode.js';
import { parse } from '../src/parse.js';

const roundTrip = (doc: string): string => {
  const ast = parse(doc);
  if (!ast.ok) throw new Error('not JSON');
  const src = decodeDataSource(ast.value);
  if (!src.ok) throw new Error(src.error);
  return encodeDataSource(src.value);
};

const source = (unit: string): DataSource => ({
  kind: 'Embedded',
  table: { schema: [{ name: 'c', type: 'float', unit }], columns: [] },
});

describe('Phase 2207 — field metadata in the columnar codec', () => {
  it('preserves every extension member verbatim, a prototype-named key included', () => {
    const doc =
      '{"schema":[{"name":"c","type":"float","ext":{"__proto__":"p","constructor":"k","a.b":"1"}}],' +
      '"columns":{"c":{"values":[],"validity":[]}}}';
    expect(roundTrip(doc)).toBe(
      '{"columns":{"c":{"validity":[],"values":[]}},"schema":[{"ext":{"__proto__":"p","a.b":"1","constructor":"k"},"name":"c","type":"float"}]}',
    );
  });

  it('names the column and the reason when it refuses a unit', () => {
    const ast = parse(
      '{"schema":[{"name":"mass","type":"float","unit":"kmin"}],"columns":{"mass":[]}}',
    );
    if (!ast.ok) throw new Error('not JSON');
    const src = decodeDataSource(ast.value);
    expect(src.ok).toBe(false);
    if (!src.ok)
      expect(src.error).toBe(
        "malformed: mass: unit 'kmin' is not a unit the kit parses: prefix not allowed on 'kmin' at position 0",
      );
  });

  it('the guarded encode refuses a unit not spelled canonically, and passes one that is', () => {
    expect(tryEncodeDataSource(source('m/s')).ok).toBe(true);
    expect(tryEncodeDataSource(source('s-1.m')).ok).toBe(false);
    expect(tryEncodeDataSource(source('furlong')).ok).toBe(false);
  });
});
