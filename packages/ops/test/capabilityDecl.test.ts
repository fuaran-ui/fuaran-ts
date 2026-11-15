// ============================================================================
//  The capability declaration reader at the Core version the twin mirrors
//  (Phase 2001): it reads a determinism set in its canonical label and only
//  that, requires `"$type":"capability"`, reads an entry as its hole kind, and
//  refuses what the registry's admission gate refuses. Since Phase 2741 (Core
//  0.43.0) it requires the declared result and names each result refusal's
//  decode code and path.
// ============================================================================

import { describe, expect, it } from 'vitest';

import {
  decodeCapabilityDeclaration,
  decodeCapabilityPipeline,
  encodeCapabilityDeclaration,
} from '../src/capabilityDecl.js';

const DOC =
  '{"$type":"capability","determinism":"clock+random","id":"c","placement":{"$type":"server"},' +
  '"result":{"$type":"intRange","max":99,"min":0},' +
  '"signature":{"effect":{"determinism":"clock+random","host":"pure"},"holes":[' +
  '{"addr":"a","kind":"value","name":"a","required":true,"space":{"$type":"intRange","max":9,"min":0}}],"name":"c"}}';

describe('capability declaration reader', () => {
  it('reads a composed determinism set and writes it back byte-identically', () => {
    const r = decodeCapabilityDeclaration(DOC);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect([...r.value.determinism].sort()).toEqual(['ClockFactor', 'RandomFactor']);
      expect(encodeCapabilityDeclaration(r.value)).toBe(DOC);
    }
  });

  const refused: readonly (readonly [string, string, RegExp])[] = [
    ['no $type', DOC.replace('"$type":"capability",', ''), /missing field: \$type/],
    [
      'another $type',
      DOC.replace('"$type":"capability"', '"$type":"query"'),
      /not a capability declaration/,
    ],
    [
      'a non-canonical label',
      DOC.replaceAll('clock+random', 'random+clock'),
      /unknown determinism: random\+clock/,
    ],
    ['an empty space', DOC.replace('"max":9,"min":0', '"max":0,"min":9'), /EmptySpace\(a\)/],
    [
      'a value hole with no space',
      DOC.replace(',"space":{"$type":"intRange","max":9,"min":0}', ''),
      /missing field: space/,
    ],
    [
      'an unbounded repeat',
      DOC.replace('"kind":"value"', '"kind":"repeat"').replace(
        '{"$type":"intRange","max":9,"min":0}',
        '{"$type":"anyString"}',
      ),
      /NonTotalCapability/,
    ],
  ];

  for (const [name, doc, why] of refused) {
    it(`refuses ${name}`, () => {
      const r = decodeCapabilityDeclaration(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    });
  }
});

describe('the declared result (Core 0.43.0)', () => {
  const RESULT = '"result":{"$type":"intRange","max":99,"min":0},';
  const withResult = (doc: string) => DOC.replace(RESULT, doc);

  it('writes and reads "returns nothing" as the one nothing document', () => {
    const doc = withResult('"result":{"$type":"nothing"},');
    const r = decodeCapabilityDeclaration(doc);
    expect(r.ok && r.value.result).toEqual({ kind: 'Nothing' });
    if (r.ok) expect(encodeCapabilityDeclaration(r.value)).toBe(doc);
  });

  const refused: readonly (readonly [string, string, string, readonly string[]])[] = [
    ['no result', withResult(''), 'MissingField', ['result']],
    ['a null result', withResult('"result":null,'), 'WrongKind', ['result']],
    ['a result with no $type', withResult('"result":{},'), 'MissingField', ['result', '$type']],
    [
      'an unknown result tag',
      withResult('"result":{"$type":"void"},'),
      'UnknownTag',
      ['result', '$type'],
    ],
    [
      'an empty result space',
      withResult('"result":{"$type":"enum","values":[]},'),
      'OutOfRange',
      ['result'],
    ],
    [
      'an inverted result range',
      withResult('"result":{"$type":"intRange","max":0,"min":9},'),
      'OutOfRange',
      ['result'],
    ],
  ];
  for (const [name, doc, code, path] of refused) {
    it(`refuses ${name} as ${code} at ${path.join('.')}`, () => {
      const r = decodeCapabilityDeclaration(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        expect(r.code).toBe(code);
        expect(r.path).toEqual(path);
      }
    });
  }

  it('answers a signature fault before a missing result', () => {
    const r = decodeCapabilityDeclaration(
      withResult('').replace('"max":9,"min":0', '"max":0,"min":9'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toMatch(/EmptySpace\(a\)/);
      expect(r.code).toBeUndefined();
    }
  });
});

describe('the capability pipeline reader', () => {
  const PIPELINE =
    '{"nodes":[{"$type":"source","dataRef":"d","id":"s","outputType":{"$type":"intRange","max":9,"min":0}},' +
    '{"$type":"invoke","args":[{"addr":"a","source":{"$type":"fromNode","node":"s"}},' +
    '{"addr":"b","source":{"$type":"literal","value":"1"}}],"capabilityId":"c","id":"call",' +
    '"outputType":{"$type":"anyString"}}]}';

  it('reads both node kinds and both argument sources', () => {
    const r = decodeCapabilityPipeline(PIPELINE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.nodes.map((n) => n.kind)).toEqual(['Source', 'Invoke']);
      const call = r.value.nodes[1];
      expect(call?.kind === 'Invoke' && call.args.map((a) => a.source.kind)).toEqual([
        'FromNode',
        'Literal',
      ]);
    }
  });

  const refused: readonly (readonly [string, string, RegExp])[] = [
    [
      'an empty output type',
      PIPELINE.replace('"max":9,"min":0', '"max":0,"min":9'),
      /empty value-space/,
    ],
    [
      'an unknown node',
      PIPELINE.replace('"$type":"source"', '"$type":"sink"'),
      /unknown pipeline node/,
    ],
    [
      'an unknown argument source',
      PIPELINE.replace('"$type":"literal"', '"$type":"const"'),
      /unknown argument source/,
    ],
    ['no nodes', '{}', /missing or non-array field: nodes/],
    ['not JSON', '{', /not well-formed JSON/],
  ];
  for (const [name, doc, why] of refused) {
    it(`refuses ${name}`, () => {
      const r = decodeCapabilityPipeline(doc);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toMatch(why);
    });
  }
});
