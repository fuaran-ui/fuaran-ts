// Phase 2205 — the column wire decodes straight into typed vectors, and encodes
// byte-identically from them. Two values the typed storage cannot hold are refused
// at decode, as the reference codec refuses them: an int outside 32 bits and a
// date that is not canonical text.
import { describe, expect, it } from 'vitest';

import type { DataSource } from '@fuaran-ui/schema';

import { decodeDataSource } from '../src/decode.js';
import { encodeDataSource } from '../src/encode.js';
import { parse } from '../src/parse.js';

const decode = (text: string) => {
  const ast = parse(text);
  if (!ast.ok) throw new Error('not JSON');
  return decodeDataSource(ast.value);
};

const embedded = (text: string) => {
  const r = decode(text);
  if (!r.ok) throw new Error(r.error);
  if (r.value.kind !== 'Embedded') throw new Error('not embedded');
  return r.value.table;
};

const WIRE =
  '{"columns":{' +
  '"b":{"validity":[true,false],"values":[true,false]},' +
  '"d":{"validity":[true,true],"values":["1969-12-31","2026-10-28"]},' +
  '"m":{"validity":[true,false],"values":["12.50","0"]},' +
  '"n":{"validity":[true,false],"values":[2147483647,0]},' +
  '"s":{"validity":[true,true],"values":["x",""]},' +
  '"t":{"validity":[false,true],"values":["","1969-12-31T23:59:59.999Z"]},' +
  '"v":{"validity":[true,true],"values":[1.5,-0.25]}},' +
  '"schema":[{"name":"n","type":"int"},{"name":"v","type":"float"},{"name":"b","type":"bool"},' +
  '{"name":"s","type":"string"},{"name":"d","type":"date"},{"name":"t","type":"timestamp_ms"},' +
  '{"name":"m","type":"decimal"}]}';

describe('decode builds the typed storage directly', () => {
  it('each column type lands in its vector', () => {
    const t = embedded(WIRE);
    const kinds = Object.fromEntries(t.columns.map((c) => [c.name, c.data.kind]));
    expect(kinds).toEqual({
      n: 'Ints',
      v: 'Floats',
      b: 'Bools',
      s: 'Strs',
      d: 'Dates',
      t: 'Timestamps',
      m: 'Decimals',
    });
    const n = t.columns.find((c) => c.name === 'n')!.data;
    expect(n.kind === 'Ints' && n.values).toBeInstanceOf(Int32Array);
    const d = t.columns.find((c) => c.name === 'd')!.data;
    expect(d.kind === 'Dates' && Array.from(d.values)).toEqual([-1, 20754]);
    const ts = t.columns.find((c) => c.name === 't')!.data;
    expect(ts.kind === 'Timestamps' && Array.from(ts.seconds)).toEqual([0, -1]);
    expect(ts.kind === 'Timestamps' && ts.fraction && Array.from(ts.fraction)).toEqual([0, 999]);
  });

  it('encode is byte-identical to the canonical wire (the decimal canonicalised on read)', () => {
    const src: DataSource = { kind: 'Embedded', table: embedded(WIRE) };
    expect(encodeDataSource(src)).toBe(WIRE.replace('"12.50"', '"12.5"'));
  });

  it('an epoch number in a sub-second column decodes to the same storage as its text', () => {
    const text = embedded(
      '{"columns":{"t":["1969-12-31T23:59:59.999Z"]},"schema":[{"name":"t","type":"timestamp_ms"}]}',
    );
    const epoch = embedded('{"columns":{"t":[-1]},"schema":[{"name":"t","type":"timestamp_ms"}]}');
    expect(epoch.columns[0]!.data).toEqual(text.columns[0]!.data);
  });
});

describe('decode refuses what a typed column cannot hold', () => {
  it('an int outside 32 bits', () => {
    const r = decode('{"columns":{"n":[2147483648]},"schema":[{"name":"n","type":"int"}]}');
    expect(r.ok).toBe(false);
    expect(!r.ok && r.error).toContain('32-bit');
  });

  it.each(['2026-1-05', '2026-02-30', '2026-01-01T00:00:00Z', 'soon'])(
    'a date that is not canonical: %s',
    (text) => {
      const r = decode(
        `{"columns":{"d":[${JSON.stringify(text)}]},"schema":[{"name":"d","type":"date"}]}`,
      );
      expect(r.ok).toBe(false);
      expect(!r.ok && r.error).toContain('YYYY-MM-DD');
    },
  );

  it('an absent row is never read, so its placeholder may be anything of the right kind', () => {
    const t = embedded(
      '{"columns":{"d":{"validity":[false],"values":[""]}},"schema":[{"name":"d","type":"date"}]}',
    );
    expect(t.columns[0]!.data.validity.kind).toBe('Mask');
  });
});
